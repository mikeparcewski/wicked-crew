/**
 * The `/api/v1/governance/steering/*` surface (STEERING program) — the management wire behind
 * the studio's top-level Steering nav: batch IMPORT of steering docs/rules, and "add with chat"
 * AUTHORING as a governed run. Per-rule CRUD deliberately lives elsewhere — this module adds no
 * second door: `GET/POST /governance/rules` (now steering-aware: `?type=` facet,
 * `?include_retired=`, steering-field writes) and `DELETE /governance/rules/:id` in
 * `api/routes.ts` ARE the steering-rule CRUD, because a steering rule IS a conformance rule
 * (the wiki/rules model and the old policy model merged into one).
 *
 * Thin by design, like `campaigns/routes.ts`: validation is zod (strict, unknown keys named —
 * the FINDING-031 doctrine); import normalization/validation is the ENGINE's ingest path on the
 * single-writer actor (fail-closed per entry — the daemon never opens the store for writes);
 * authoring is the EXISTING run machinery (`launchRun` + the `steering-author` drop-in workflow
 * + the standard `POST /runs/:id/gate` HITL flow) — no new chat stack. Error posture mirrors the
 * campaign surface: a build whose engine addon predates the steering model answers 501
 * (`SteeringUnsupportedError` — "upgrade the engine"), never 400 ("fix your request").
 *
 * estate's MCP surface stays READ-ONLY on rules; every steering WRITE flows through here (the
 * governed operator path) — the AW-11 "no rules.write on estate" invariant is a design input of
 * this module, not a coincidence.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { SteeringUnsupportedError, type CoreAdapter } from '../core/adapter.js';
import type { Actor, SteeringImportEntry, SteeringImportResult } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { API_PREFIX } from './api-prefix.js';

const V = API_PREFIX;

/**
 * The steering-type vocabulary (`wicked-crew-api-types::SteeringType`) — enum-as-string, the
 * engine's serde default is `architecture`. ONE spelling, exported: `api/routes.ts` reads it for
 * the `?type=` browse facet so the two surfaces can never disagree about what a type is.
 */
export const STEERING_TYPE_VALUES = [
  'architecture',
  'development',
  'security',
  'testing',
  'operations',
  'compliance',
  'design-ux',
] as const;

export const STEERING_TYPES: ReadonlySet<string> = new Set(STEERING_TYPE_VALUES);

/** The engine's serde default for a rule row that predates (or omits) `steering_type`. */
export const DEFAULT_STEERING_TYPE = 'architecture';

/** Per-entry ceiling on an import doc / rule payload (UTF-8 bytes) — mirrors the run-files cap. */
export const STEERING_ENTRY_MAX_BYTES = 512 * 1024;
/** Batch ceiling — an import is a page action, not a bulk-migration channel. */
export const STEERING_IMPORT_MAX_ENTRIES = 200;
/** Authoring intent is operator prose, not a document store (the guidance-cap doctrine). */
export const STEERING_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same unknown-key-naming 400 body builder as api/routes.ts (restated because that module does
 *  not export it and importing routes.ts here would be a cycle through registerRoutes). */
function invalidBody(err: z.ZodError, what: string): { error: string; details: z.ZodIssue[] } {
  const unknown = err.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
  const error =
    unknown.length > 0
      ? `${what}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown
          .map((k) => `\`${k}\``)
          .join(', ')} — this endpoint does not accept ${
          unknown.length > 1 ? 'them' : 'it'
        }, and ignoring ${unknown.length > 1 ? 'them' : 'it'} would run a different request than you sent`
      : what;
  return { error, details: err.issues };
}

// A doc entry: frontmattered markdown, the SAME format `rules ingest --dir` consumes. The rule
// entry's payload is validated shape-wise by the ENGINE's normalize/validate path (fail-closed
// per entry) — the route checks only "is an object", so engine-side validation stays the ONE
// spelling of what a rule is.
const ImportDocSchema = z
  .object({
    kind: z.literal('doc'),
    name: z.string().min(1).max(256).optional(),
    content: z.string().min(1),
  })
  .strict();
const ImportRuleSchema = z
  .object({
    kind: z.literal('rule'),
    rule: z.custom<import('../core/types.js').ConformanceRule>(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
      { message: '`rule` must be a rule object' },
    ),
  })
  .strict();

export const SteeringImportSchema = z
  .object({
    type: z.enum(STEERING_TYPE_VALUES).optional(),
    entries: z
      .array(z.discriminatedUnion('kind', [ImportDocSchema, ImportRuleSchema]))
      .min(1)
      .max(STEERING_IMPORT_MAX_ENTRIES),
  })
  .strict();

export const SteeringAuthorSchema = z
  .object({
    instructions: z.string().min(1),
    type: z.enum(STEERING_TYPE_VALUES).optional(),
    paths: z.array(z.string().min(1)).max(32).optional(),
    documents: z
      .array(z.object({ name: z.string().min(1).max(128), content: z.string().min(1) }).strict())
      .max(32)
      .optional(),
    repoRef: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Where the author route lands inline documents so the run can read them: a per-run inbox on the
 * daemon host — the existing run file mechanism (runs read the daemon's filesystem; the paths
 * ride the problem statement, never the prompt-fattening content itself).
 */
export function steeringInboxDir(runId: string): string {
  // Env override first (the workflowOverlayDir pattern) — what keeps tests out of the
  // operator's real ~/.wicked.
  if (process.env.WICKED_STEERING_INBOX_DIR) {
    return join(process.env.WICKED_STEERING_INBOX_DIR, runId);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', 'steering-inbox', runId);
}

/**
 * The propose phase's machine-readable artifact (crew#388): the file — inside
 * {@link steeringInboxDir} — the workflow tells the worker to write the proposed-rules JSON
 * array to, and the FIRST place the post-approval landing (`api/steering-landing.ts`) reads.
 * One spelling, exported: the author route composes it into the problem statement, the landing
 * derives the same path from the run id.
 */
export const STEERING_PROPOSAL_FILENAME = 'proposed-rules.json';

export interface SteeringRoutesDeps {
  audit: AuditLog;
  actorOf: (req: FastifyRequest & { actor?: Actor }) => Actor;
  /** The default council roster for the authoring run (already parsed). */
  roster: () => unknown[];
}

export function registerGovernanceSteeringRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: SteeringRoutesDeps,
): void {
  const { audit, actorOf } = deps;

  // ── Batch import (the Steering page's Import action) ─────────────────────────
  // JSON body only, deliberately: this daemon speaks no multipart (no parser registered, and the
  // studio client speaks JSON everywhere else), so doc bytes ride `content` inline. `type` is the
  // page's inferred steering type, applied engine-side as the default for entries that omit one.
  // 200 even when entries rejected — fail-closed PER ENTRY, and the per-entry results ARE the
  // answer; only a malformed batch (400), a pre-steering engine (501), or an engine failure (500)
  // refuse the request as a whole.
  app.post(
    `${V}/governance/steering/import`,
    {
      config: {
        manifest: {
          requestType: 'SteeringImportBody',
          responseType: 'SteeringImportResponse',
          // 501: the installed engine addon predates the steering model (wicked-core-ts < 0.7.5)
          // — upgrade the engine, the request was already correct.
          statusCodes: [200, 400, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = SteeringImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid steering import body'));
      }
      // Byte caps checked in the route, not zod's char-counting `max`, so the 400 names the
      // actual limit (the guidance-cap doctrine).
      for (const [i, entry] of parsed.data.entries.entries()) {
        const payload = entry.kind === 'doc' ? entry.content : JSON.stringify(entry.rule);
        const bytes = Buffer.byteLength(payload, 'utf8');
        if (bytes > STEERING_ENTRY_MAX_BYTES) {
          return reply.code(400).send({
            error: `entries[${i}] is ${bytes} bytes, over the ${STEERING_ENTRY_MAX_BYTES}-byte per-entry cap`,
          });
        }
      }
      try {
        const results: SteeringImportResult[] = await adapter.importSteeringRules(
          parsed.data.entries as SteeringImportEntry[],
          parsed.data.type,
        );
        const imported = results.filter((r) => r.status === 'imported').length;
        const rejected = results.length - imported;
        audit.record('governance.steering.imported', actorOf(req), {
          detail: {
            entries: results.length,
            imported,
            rejected,
            ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
          },
        });
        return { results, imported, rejected };
      } catch (err) {
        if (err instanceof SteeringUnsupportedError) {
          return reply.code(501).send({ error: message(err) });
        }
        // An engine/store failure is OURS, not the caller's — the batch already parsed, so
        // nothing here maps to 400 (per-ENTRY validation failures come back in `results`).
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // ── "Add with chat" (the Steering page's conversational authoring action) ────
  // REUSES crew's run machinery end to end: launches the `steering-author` drop-in workflow
  // (BUILTIN_WORKFLOWS — analyze → propose, with an unconditional human gate on the terminal
  // propose phase: TH-12 propose-as-gate), inline documents land in the per-run steering inbox
  // (the run reads the daemon host's filesystem — the existing run file mechanism), and the
  // operator answers the proposal through the standard POST /runs/:id/gate. Approved rules land
  // CREW-SIDE on that approve — the gate handler performs the store write with
  // `provenance.source: "chat"` (see `api/steering-landing.ts`, crew#388); the run itself
  // writes nothing to any store, only its proposal artifact in the inbox.
  //
  // Gated on the steering engine too, on purpose: the run only PROPOSES, but proposing rules
  // whose steering fields the CRUD would then refuse (501) is a trap, not a feature.
  app.post(
    `${V}/governance/steering/author`,
    {
      config: {
        manifest: {
          requestType: 'SteeringAuthorBody',
          responseType: '{ runId: string }',
          // 409: engine busy / sessionId already exists; 501: pre-steering engine.
          statusCodes: [201, 400, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = SteeringAuthorSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid steering author body'));
      }
      const b = parsed.data;
      const intentBytes = Buffer.byteLength(b.instructions, 'utf8');
      if (intentBytes > STEERING_INSTRUCTIONS_MAX_BYTES) {
        return reply.code(400).send({
          error: `instructions is ${intentBytes} bytes, over the ${STEERING_INSTRUCTIONS_MAX_BYTES}-byte cap — put long material in \`documents\` or \`paths\`, not the intent`,
        });
      }
      for (const [i, doc] of (b.documents ?? []).entries()) {
        const bytes = Buffer.byteLength(doc.content, 'utf8');
        if (bytes > STEERING_ENTRY_MAX_BYTES) {
          return reply.code(400).send({
            error: `documents[${i}] is ${bytes} bytes, over the ${STEERING_ENTRY_MAX_BYTES}-byte per-document cap`,
          });
        }
      }
      // The run id NAMES the per-run inbox directory below, and `join` honors `../` — a
      // free-form id could land inline documents outside the inbox (or alias another run's).
      // Same doctrine as the document `name` scrub: caller text is never a path — but the id
      // must round-trip exactly (it is the run's identity), so refuse loudly instead of
      // scrubbing silently.
      if (b.sessionId !== undefined && !/^(?!\.+$)[A-Za-z0-9._-]{1,128}$/.test(b.sessionId)) {
        return reply.code(400).send({
          error:
            'sessionId must be 1-128 characters of [A-Za-z0-9._-] (and not dots only) — it names ' +
            "the run's steering-inbox directory on the daemon host",
        });
      }
      if (!adapter.steeringSupported()) {
        return reply
          .code(501)
          .send({ error: new SteeringUnsupportedError('Authoring steering rules').message });
      }
      // Paths are read on the DAEMON host — validate loudly here rather than letting the run
      // burn a phase discovering a browser-local path. Absolute only (the extraWriteRoots
      // doctrine), and existing (a named 400 beats a worker's "no such file" mid-run).
      for (const p of b.paths ?? []) {
        if (!isAbsolute(p)) {
          return reply
            .code(400)
            .send({ error: `paths: \`${p}\` must be absolute on the daemon host` });
        }
        if (!existsSync(p)) {
          return reply.code(400).send({
            error: `paths: \`${p}\` does not exist on the daemon host — the authoring run reads the daemon's filesystem, not the browser's`,
          });
        }
      }
      const runId = b.sessionId ?? randomUUID();
      // The inbox exists for EVERY authoring run (not only ones with inline documents): it is
      // also where the propose phase writes its machine-readable proposal (crew#388 — the file
      // the post-approval landing reads), and it rides the launch as the run's extra write root.
      const dir = steeringInboxDir(runId);
      await fsp.mkdir(dir, { recursive: true });
      // Inline documents → per-run inbox files; only their PATHS ride the problem statement
      // (content in the prompt would fatten it past what prompt transports tolerate).
      const docPaths: string[] = [];
      for (const [i, doc] of (b.documents ?? []).entries()) {
        // basename + charset scrub: the caller's `name` is display text, never a path. The
        // index prefix keeps scrubbed names collision-free and the filename non-empty.
        const safe = `${i}-${basename(doc.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const target = join(dir, safe);
        await fsp.writeFile(target, doc.content, 'utf8');
        docPaths.push(target);
      }
      const type = b.type ?? DEFAULT_STEERING_TYPE;
      const sources = [...(b.paths ?? []), ...docPaths];
      // The per-run proposal artifact (crew#388): the propose phase writes the proposed-rules
      // JSON here (its instructions name "the absolute proposal file path in the problem
      // statement"), and the gate handler's landing reads THIS file first — machine-readable by
      // design, with transcript parsing only as the fallback. The path is per-run and inside
      // the inbox the launch declares as an extra write root, so the write is governed and the
      // run still writes NOTHING to any store (evaluator≠creator).
      const proposalPath = join(dir, STEERING_PROPOSAL_FILENAME);
      const problem = [
        `Author steering rules for the '${type}' steering type (use it as the default steering_type for every proposed rule without a better fit).`,
        '',
        'Operator intent:',
        b.instructions,
        ...(sources.length > 0
          ? ['', 'Analyze these files/directories on this machine:', ...sources.map((s) => `- ${s}`)]
          : []),
        '',
        `Proposal file (for the propose phase): write the proposed rules JSON array to exactly this absolute path: ${proposalPath}`,
      ].join('\n');
      try {
        await adapter.launchRun({
          problem,
          sessionId: runId,
          clisJson: JSON.stringify(deps.roster()),
          workflow: 'steering-author',
          // The proposal artifact lands in the per-run inbox, which sits OUTSIDE any unit
          // sandbox/worktree — without this declaration the engine's boundary denies the one
          // file the landing is designed to read (the crew#263 shape).
          extraWriteRoots: [dir],
          ...(b.repoRef !== undefined ? { repoRef: b.repoRef } : {}),
        });
        // The same trail entry POST /runs writes — this IS a run launch, findable by the same
        // `?action=run.launched` query — plus the steering detail the Steering header renders.
        audit.record('run.launched', actorOf(req), {
          runId,
          detail: {
            workflow: 'steering-author',
            steeringType: type,
            sources: sources.length,
            ...(b.repoRef !== undefined ? { repoRef: b.repoRef } : {}),
          },
        });
        return reply.code(201).send({ runId });
      } catch (err) {
        const msg = message(err);
        const busy = /busy|in flight|already/i.test(msg);
        return reply.code(busy ? 409 : 400).send({ error: msg });
      }
    },
  );
}
