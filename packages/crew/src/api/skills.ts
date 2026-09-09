/**
 * The `/api/v1/skills*` surface (skills keystone, design v3 §API) — a FILE MANAGER over the
 * daemon-owned garden plugin root, with guards on every write/enable and CAS everywhere.
 *
 *   GET  /skills                       manifest + revision + the current snapshot
 *   GET  /skills/:name/files           the skill's OWN files (nested skills are their own)
 *   GET  /skills/:name/files/*path     typed capped read (`?side=baseline` for the shipped copy)
 *   PUT  /skills/:name/files/*path     write one file (guards; CAS)
 *   GET  /skills/support/*path         root support files: scripts/, schemas/, .claude-plugin/, …
 *   PUT  /skills/support/*path
 *   POST /skills                       add a user skill
 *   POST /skills/:name/{enable,disable,reset,replace}
 *   POST /skills/refresh-baseline      three-way per FILE against the live plugin
 *   POST /skills/publish               validate → immutable snapshot → flip `current`
 *   POST /skills/analyze               dry-run of the publish validation
 *
 * Guard results ALWAYS return 2xx `{verdict, findings[], revision}` — studio's `apiFetch` throws
 * on non-2xx, so a `blocked` verdict is a normal 200 with nothing written; that includes a
 * containment refusal on a WRITE (the store answers `path-invalid`), a publish refused because one
 * is already in flight (`publish-in-flight`), and a publish aborted because the skills root changed
 * under it (`root-changed`) — none of those wrote anything, so each is a normal `blocked` envelope
 * (codex round 3). 409 (`{error, revision}`) is reserved for EXACTLY ONE thing: a stale
 * `expectedRevision` (a CAS conflict — the revision the client holds no longer matches). 404 an
 * unknown skill or file; 400 a body the schemas refuse or a READ path containment refuses (a read
 * has no verdict envelope); 503 an unseeded root or a `current` link that fails verification; 502
 * no plugin source to refresh from. Thin by design: validation is zod (strict, unknown keys named);
 * everything else is the store's. Nothing here (or anywhere in the store) writes outside the
 * skills root — the user's own CLI directories are never touched (design v3.2 §1).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Actor, SkillReadResult } from '../core/types.js';
import { SkillPathError } from '../skills/contain.js';
import { finding } from '../skills/guards.js';
import type { SkillsRuntime } from '../skills/runtime.js';
import {
  RevisionMismatchError,
  SkillsCurrentInvalidError,
  SkillsManifestCorruptError,
  SkillsPublishError,
  SkillsPublishInFlightError,
  SkillsRootChangedError,
  SkillsSourceUnavailableError,
  SkillsUnseededError,
  UnknownSkillError,
  type ReadSide,
} from '../skills/store.js';
import { API_PREFIX } from './api-prefix.js';
import type { AuditLog } from './audit.js';
import { FILE_CONTENT_CAP_BYTES, NotARegularFileError } from './run-files.js';

const V = API_PREFIX;

/** A files map is a skill, not a document store. */
export const SKILL_FILES_MAX_ENTRIES = 256;

const revision = z.number().int().nonnegative();
const filesMap = z
  .record(z.string().min(1), z.string())
  .refine((files) => Object.keys(files).length <= SKILL_FILES_MAX_ENTRIES, {
    message: `files must carry at most ${SKILL_FILES_MAX_ENTRIES} entries`,
  })
  .refine((files) => Object.values(files).every((text) => Buffer.byteLength(text, 'utf8') <= FILE_CONTENT_CAP_BYTES), {
    message: `every file must be at most ${FILE_CONTENT_CAP_BYTES} bytes of UTF-8`,
  });

// Exported so tests/wire-contract.test.ts can pin the published bodies against them.
export const SkillRevisionSchema = z.object({ expectedRevision: revision }).strict();
export const PutSkillFileSchema = z
  .object({
    content: z.string().refine((text) => Buffer.byteLength(text, 'utf8') <= FILE_CONTENT_CAP_BYTES, {
      message: `content must be at most ${FILE_CONTENT_CAP_BYTES} bytes of UTF-8`,
    }),
    expectedRevision: revision,
  })
  .strict();
export const AddSkillSchema = z.object({ name: z.string().min(1), files: filesMap, expectedRevision: revision }).strict();
export const ReplaceSkillSchema = z.object({ files: filesMap, expectedRevision: revision }).strict();
const SideSchema = z.object({ side: z.enum(['effective', 'baseline']).optional() }).strict();

export interface SkillsRouteDeps {
  /** Absent = the daemon booted without a skills seam (tests, the manifest collector) → 503. */
  runtime?: SkillsRuntime;
  audit: AuditLog;
  actorOf: (req: FastifyRequest) => Actor;
}

/** The zod failure → 400 shape every route here shares (unknown keys are named by zod itself). */
function invalidBody(reply: FastifyReply, err: z.ZodError): FastifyReply {
  return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/**
 * A publish refused without writing anything — one already in flight, or the skills root changed
 * under it — is a normal 2xx `blocked` envelope, NOT a 409 (409 is reserved for a stale
 * `expectedRevision`; codex round 3). Shaped as a publish result (`snapshot: null`) so it satisfies
 * both the mutation and the publish response contracts.
 */
function blockedEnvelope(
  kind: 'publish-in-flight' | 'root-changed',
  explanation: string,
  evidence: string,
  revision: number,
): { verdict: 'blocked'; findings: ReturnType<typeof finding>[]; revision: number; snapshot: null } {
  return { verdict: 'blocked', findings: [finding(kind, 'blocking', explanation, evidence)], revision, snapshot: null };
}

/** Map the store's named errors onto the route's status codes; anything else is a 500. */
function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SkillsUnseededError) return reply.code(503).send({ error: err.message });
  if (err instanceof SkillsCurrentInvalidError) return reply.code(503).send({ error: err.message });
  if (err instanceof SkillsManifestCorruptError) return reply.code(503).send({ error: err.message });
  if (err instanceof SkillsPublishError) return reply.code(503).send({ error: err.message });
  if (err instanceof SkillsSourceUnavailableError) return reply.code(502).send({ error: err.message });
  if (err instanceof UnknownSkillError) return reply.code(404).send({ error: err.message });
  if (err instanceof SkillPathError) return reply.code(400).send({ error: err.message });
  if (err instanceof NotARegularFileError) return reply.code(400).send({ error: err.message });
  // 409 is EXCLUSIVELY a CAS conflict (a stale expectedRevision). A publish already in flight or a
  // root that changed under a running publish wrote nothing → a 2xx `blocked` findings envelope.
  if (err instanceof RevisionMismatchError) return reply.code(409).send({ error: err.message, revision: err.actual });
  if (err instanceof SkillsPublishInFlightError) {
    return reply.code(200).send(
      blockedEnvelope('publish-in-flight', 'a publish is already running (one at a time); nothing was written — re-read GET /skills and retry', err.message, err.revision),
    );
  }
  if (err instanceof SkillsRootChangedError) {
    return reply.code(200).send(
      blockedEnvelope('root-changed', 'the skills root changed under the running publish; nothing was written to either root — re-read GET /skills and retry', err.message, err.revision),
    );
  }
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'no such file' });
  throw err;
}

const UNCONFIGURED = 'the daemon booted without a skills store (no state home seam) — /skills is unavailable';

export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  const { audit, actorOf } = deps;
  const runtimeOf = (): SkillsRuntime => {
    if (deps.runtime === undefined) throw new SkillsUnconfiguredError();
    return deps.runtime;
  };
  const store = (): SkillsRuntime['store'] => runtimeOf().store;
  const guarded = async (reply: FastifyReply, fn: () => unknown | Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SkillsUnconfiguredError) return reply.code(503).send({ error: UNCONFIGURED });
      return fail(reply, err);
    }
  };
  const rawPath = (req: FastifyRequest): string => (req.params as { '*': string })['*'];
  const sideOf = (req: FastifyRequest, reply: FastifyReply): ReadSide | FastifyReply => {
    const parsed = SideSchema.safeParse(req.query ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    return parsed.data.side ?? 'effective';
  };
  const recordMutation = (req: FastifyRequest, action: string, detail: Record<string, unknown>): void => {
    audit.record(action, actorOf(req), { detail });
  };

  app.get(
    `${V}/skills`,
    { config: { manifest: { responseType: 'SkillsManifestResponse', statusCodes: [200, 503] } } },
    async (_req, reply) =>
      guarded(reply, () => {
        const s = store();
        const manifest = s.manifest();
        return { manifest, revision: manifest.revision, root: s.root, current: s.currentSnapshot() };
      }),
  );

  app.get(
    `${V}/skills/:name/files`,
    { config: { manifest: { responseType: 'SkillFileTree', statusCodes: [200, 404, 503] } } },
    async (req, reply) => guarded(reply, () => store().listFiles((req.params as { name: string }).name)),
  );

  app.get(
    `${V}/skills/:name/files/*`,
    { config: { manifest: { responseType: 'SkillReadResult', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) =>
      guarded(reply, async () => {
        const side = sideOf(req, reply);
        if (typeof side !== 'string') return side;
        const result: SkillReadResult = await store().readFile((req.params as { name: string }).name, rawPath(req), side);
        return result;
      }),
  );

  app.put(
    `${V}/skills/:name/files/*`,
    { config: { manifest: { requestType: 'PutSkillFileBody', responseType: 'SkillMutationResult', statusCodes: [200, 400, 404, 409, 503] } } },
    async (req, reply) => {
      const parsed = PutSkillFileSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const { name } = req.params as { name: string };
      return guarded(reply, () => {
        const result = store().writeFile(name, rawPath(req), parsed.data.content, parsed.data.expectedRevision);
        recordMutation(req, 'skills.updated', { op: 'put-file', name, path: rawPath(req), verdict: result.verdict, revision: result.revision });
        return result;
      });
    },
  );

  app.get(
    `${V}/skills/support/*`,
    { config: { manifest: { responseType: 'SkillReadResult', statusCodes: [200, 400, 404, 503] } } },
    async (req, reply) =>
      guarded(reply, async () => {
        const side = sideOf(req, reply);
        if (typeof side !== 'string') return side;
        const result: SkillReadResult = await store().readSupport(rawPath(req), side);
        return result;
      }),
  );

  app.put(
    `${V}/skills/support/*`,
    { config: { manifest: { requestType: 'PutSkillFileBody', responseType: 'SkillMutationResult', statusCodes: [200, 400, 409, 503] } } },
    async (req, reply) => {
      const parsed = PutSkillFileSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      return guarded(reply, () => {
        const result = store().writeSupport(rawPath(req), parsed.data.content, parsed.data.expectedRevision);
        recordMutation(req, 'skills.updated', { op: 'put-support', path: rawPath(req), verdict: result.verdict, revision: result.revision });
        return result;
      });
    },
  );

  app.post(
    `${V}/skills`,
    { config: { manifest: { requestType: 'AddSkillBody', responseType: 'SkillMutationResult', statusCodes: [200, 400, 409, 503] } } },
    async (req, reply) => {
      const parsed = AddSkillSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      return guarded(reply, () => {
        const result = store().add(parsed.data.name, parsed.data.files, parsed.data.expectedRevision);
        recordMutation(req, 'skills.updated', { op: 'add', name: parsed.data.name, verdict: result.verdict, revision: result.revision });
        return result;
      });
    },
  );

  for (const op of ['enable', 'disable', 'reset'] as const) {
    app.post(
      `${V}/skills/:name/${op}`,
      { config: { manifest: { requestType: 'SkillRevisionBody', responseType: 'SkillMutationResult', statusCodes: [200, 400, 404, 409, 503] } } },
      async (req, reply) => {
        const parsed = SkillRevisionSchema.safeParse(req.body);
        if (!parsed.success) return invalidBody(reply, parsed.error);
        const { name } = req.params as { name: string };
        return guarded(reply, () => {
          const result = store()[op](name, parsed.data.expectedRevision);
          recordMutation(req, 'skills.updated', { op, name, verdict: result.verdict, revision: result.revision });
          return result;
        });
      },
    );
  }

  app.post(
    `${V}/skills/:name/replace`,
    { config: { manifest: { requestType: 'ReplaceSkillBody', responseType: 'SkillMutationResult', statusCodes: [200, 400, 404, 409, 503] } } },
    async (req, reply) => {
      const parsed = ReplaceSkillSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const { name } = req.params as { name: string };
      return guarded(reply, () => {
        const result = store().replace(name, parsed.data.files, parsed.data.expectedRevision);
        recordMutation(req, 'skills.updated', { op: 'replace', name, verdict: result.verdict, revision: result.revision });
        return result;
      });
    },
  );

  app.post(
    `${V}/skills/refresh-baseline`,
    { config: { manifest: { requestType: 'SkillRevisionBody', responseType: 'SkillRefreshResult', statusCodes: [200, 400, 409, 502, 503] } } },
    async (req, reply) => {
      const parsed = SkillRevisionSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      return guarded(reply, () => {
        const result = store().refreshBaseline(parsed.data.expectedRevision);
        recordMutation(req, 'skills.refreshed', {
          baseline: result.baseline,
          plugin_version: result.plugin_version,
          taken: result.taken.length,
          kept: result.kept.length,
          added: result.added.length,
          removed: result.removed.length,
          conflicts: result.conflicts,
          revision: result.revision,
        });
        return result;
      });
    },
  );

  app.post(
    `${V}/skills/publish`,
    { config: { manifest: { requestType: 'SkillRevisionBody', responseType: 'SkillPublishResult', statusCodes: [200, 400, 409, 503] } } },
    async (req, reply) => {
      const parsed = SkillRevisionSchema.safeParse(req.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      return guarded(reply, async () => {
        const runtime = runtimeOf();
        const result = await runtime.store.publish(parsed.data.expectedRevision);
        // The published snapshot is what the engine consumes — export its real path now.
        if (result.snapshot !== null) runtime.afterPublish();
        recordMutation(req, 'skills.published', {
          verdict: result.verdict,
          gen: result.snapshot?.gen ?? null,
          contentHash: result.snapshot?.contentHash ?? null,
          blocking: result.findings.filter((f) => f.severity === 'blocking').map((f) => `${f.kind}: ${f.evidence}`),
          revision: result.revision,
        });
        return result;
      });
    },
  );

  app.post(
    `${V}/skills/analyze`,
    { config: { manifest: { responseType: 'SkillAnalyzeResult', statusCodes: [200, 503] } } },
    async (_req, reply) => guarded(reply, () => store().analyze()),
  );
}

/** Thrown inside `guarded` when the daemon has no skills runtime — mapped to 503, never escapes. */
class SkillsUnconfiguredError extends Error {
  constructor() {
    super(UNCONFIGURED);
    this.name = 'SkillsUnconfiguredError';
  }
}
