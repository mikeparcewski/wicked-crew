/**
 * The `/api/v1/testing/*` surface (crew-testing) — the wire behind the studio's Testing page:
 * RUN the governance evals (does the steering corpus actually catch the behaviors it claims
 * to?), IMPORT a named eval corpus for later runs, and TRIGGER a campaign recon
 * (`POST /testing/recon` — governed runs over the operator's brief, fanned per repo by the
 * multiscope wire; the evals routes stay STORE-scoped and take no repo/project fields).
 *
 * Thin by design, like `governance-steering.ts`: validation is zod (strict, unknown keys named —
 * the FINDING-031 doctrine); the evals themselves are the ENGINE's (`governanceEvals` pushes
 * every sample through the same decide path enforcement runs, over a read-only connection to
 * the steering store — the daemon computes no verdict of its own), and the report is the
 * engine's serde output passed through VERBATIM (snake_case field names — the pinned crew/studio
 * wire contract; the steering wave shipped a drift because each side guessed, so neither side
 * reshapes it). Corpus import writes through the engine's knowledge seam under the
 * `evals:<name>` scope — the daemon never opens a store itself.
 *
 * Error posture mirrors the steering surface: a build whose engine addon predates the evals
 * bindings answers 501 (`GovernanceEvalsUnsupportedError` — "upgrade the engine"; wicked-core-ts
 * 0.7.5 carries them, 0.7.4 does not), never 400 ("fix your request") — and never a crash: this
 * daemon must serve both routes honestly against the released 0.7.4 addon.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  GovernanceEvalsUnsupportedError,
  ProjectsUnsupportedError,
  type CoreAdapter,
} from '../core/adapter.js';
import type { Actor, GovernanceEvalSample, LaunchRunInput } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { API_PREFIX } from './api-prefix.js';
import { STEERING_TYPE_VALUES } from './governance-steering.js';
import { resolveScopeRepos } from './multiscope.js';
import { resolveProjectGraphBinding } from '../projects/graph.js';
import { MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import type { ProjectBus } from '../projects/events.js';
import type { MembershipIndex } from '../projects/membership-index.js';

const V = API_PREFIX;

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

// The sample shape is the PINNED wire contract (snake_case, the engine's serde spelling) —
// `steering_type` stays an open string on purpose: the engine validates it against ITS
// vocabulary, so engine-side validation stays the one spelling of what a type is (the steering
// import doctrine). The run body's `type` IS closed here, because it selects from the same
// 7-value facet the steering routes already export — one spelling, shared.
const EvalSignalsSchema = z
  .object({
    phase: z.string().optional(),
    tool: z.string().optional(),
    files: z.array(z.string()).optional(),
    content: z.string().optional(),
  })
  .strict();

const EvalSampleSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(['good', 'bad']),
    steering_type: z.string().min(1),
    signals: EvalSignalsSchema,
  })
  .strict();

export const RunGovernanceEvalsSchema = z
  .object({
    type: z.enum(STEERING_TYPE_VALUES).optional(),
    corpus: z.string().min(1).optional(),
  })
  .strict();

export const ImportEvalCorpusSchema = z
  .object({
    name: z.string().min(1),
    samples: z.array(EvalSampleSchema).min(1),
  })
  .strict();

// The recon trigger's body (the pinned multiscope wire — see api/multiscope.ts): the operator's
// brief verbatim (`problem` — studio composes its own recon framing, this route never rewrites
// caller text) plus the two optional scope fields. Strict: a misspelled scope field must 400 by
// name, never launch an unscoped recon the caller believed was scoped (FINDING-031).
export const TestingReconSchema = z
  .object({
    problem: z.string().min(1),
    projectId: z.string().min(1).optional(),
    repoRefs: z
      .array(z.string().min(1))
      .min(1, 'repoRefs must name at least one registered repo — omit the field to scope by project alone')
      .optional(),
  })
  .strict();

export interface TestingRoutesDeps {
  audit: AuditLog;
  actorOf: (req: FastifyRequest & { actor?: Actor }) => Actor;
  /** The default council roster for the recon runs (already parsed) — the steering-author idiom. */
  roster: () => unknown[];
  /** The membership plumbing POST /runs uses for projectId filing (index tag + post-commit event).
   *  Optional so route-level unit tests can omit it; `registerRoutes` always supplies it. */
  projects?: { bus: ProjectBus | null; index: MembershipIndex };
}

export function registerTestingRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: TestingRoutesDeps,
): void {
  const { audit, actorOf } = deps;

  // ── Run the governance evals (the Testing page's Run action) ─────────────────
  // Both fields optional — `{}` (or no body at all) means "the built-in default corpus, every
  // steering type". The 200 body is the engine's serde report passed through verbatim
  // (snake_case; `degraded` is `null`, kept in-band, when the run was full-fidelity).
  app.post(
    `${V}/testing/evals/run`,
    {
      config: {
        manifest: {
          requestType: 'RunGovernanceEvalsBody',
          responseType: 'GovernanceEvalReport',
          // 501: the installed engine addon predates the evals bindings (wicked-core-ts < 0.7.5)
          // — upgrade the engine, the request was already correct.
          statusCodes: [200, 400, 500, 501],
        },
      },
    },
    async (req, reply) => {
      // `?? {}`: a bodyless POST is a legal spelling of the all-defaults run.
      const parsed = RunGovernanceEvalsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid evals run body'));
      }
      try {
        // Passed through verbatim — no reshaping on our side of the seam: the report IS the
        // pinned contract, snake_case and all (`summary.false_positives`, `nearest_rules`).
        // (Spread-rebuilt args: exactOptionalPropertyTypes — an absent key, never `undefined`.)
        return await adapter.runGovernanceEvals({
          ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
          ...(parsed.data.corpus !== undefined ? { corpus: parsed.data.corpus } : {}),
        });
      } catch (err) {
        if (err instanceof GovernanceEvalsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        // An engine/store failure is OURS, not the caller's — the body already parsed, so
        // nothing here maps to 400.
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // ── Import a named eval corpus (the Testing page's Import action) ────────────
  // Samples land in the knowledge store under the `evals:<name>` scope — the string a later
  // evals run names as `corpus`. Audited (a write), unlike the run above (compute over the
  // existing stores — the wiki-scoreboard read posture).
  app.post(
    `${V}/testing/corpora/import`,
    {
      config: {
        manifest: {
          requestType: 'ImportEvalCorpusBody',
          responseType: 'ImportEvalCorpusResponse',
          // 501: same presence gate as the run route — the two bindings ship together, and
          // importing a corpus no engine on this host can run would be a trap, not a feature.
          statusCodes: [200, 400, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = ImportEvalCorpusSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid corpus import body'));
      }
      try {
        const result = await adapter.importGovernanceCorpus(
          parsed.data.name,
          parsed.data.samples as GovernanceEvalSample[],
        );
        audit.record('testing.corpus.imported', actorOf(req), {
          detail: {
            name: parsed.data.name,
            samples: parsed.data.samples.length,
            scope: result.scope,
            embedded: result.embedded,
          },
        });
        return result;
      } catch (err) {
        if (err instanceof GovernanceEvalsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // ── The recon trigger (the Testing page's "run a campaign recon" action) ─────
  // REUSES crew's run machinery end to end (the steering-author precedent): each launch is a
  // plain governed run over the caller's problem statement — free-text planning, standard gates,
  // standard /ws frames. What THIS route adds is the pinned multiscope wire: `repoRefs` and/or
  // `projectId` resolve (fail-closed, api/multiscope.ts) to registered repos, and because one
  // engine run carries ONE repo (`LaunchOptions.repoRef` — wicked-core#179), a multi-repo recon
  // FANS one run per repo under one shared campaign label. Neither field ⇒ one unscoped run —
  // exactly the launch the studio ReconPanel sends today, kept backward compatible.
  app.post(
    `${V}/testing/recon`,
    {
      config: {
        manifest: {
          requestType: 'TestingReconBody',
          responseType: 'TestingReconResponse',
          // 404: unknown projectId; 409: archived project / engine busy; 500: a launch failed
          // AFTER earlier fanned runs started (the body names them — nothing is hidden);
          // 501: projectId on an addon without the project bindings.
          statusCodes: [201, 400, 404, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = TestingReconSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid recon body'));
      }
      const b = parsed.data;
      let scope;
      try {
        scope = await resolveScopeRepos(adapter, {
          projectId: b.projectId,
          repoRefs: b.repoRefs,
        });
      } catch (err) {
        if (err instanceof ProjectsUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        return reply.code(500).send({ error: message(err) });
      }
      if (!scope.ok) {
        return reply.code(scope.status).send({ error: scope.error });
      }
      // The shared campaign label every fanned run files under (audit detail + response) — the
      // grouping handle the scoreboard and the run list can fold siblings by.
      const campaign = `recon-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      // No scope fields ⇒ one unscoped run (today's recon), spelled as a single null target.
      const targets = scope.repos.length > 0 ? scope.repos : [null];
      const runIds: string[] = [];
      for (const target of targets) {
        const runId = randomUUID();
        const input: LaunchRunInput = {
          problem: b.problem,
          sessionId: runId,
          clisJson: JSON.stringify(deps.roster()),
        };
        if (target !== null) input.repoRef = target.id;
        if (b.projectId !== undefined) {
          // Same filing semantics as POST /runs (DES-PROJECT-001 §2.2): the engine attaches the
          // crew.run membership atomically with the launch; the project graph binding is resolved
          // — never refreshed — per run, and the decision is logged either way.
          input.projectId = b.projectId;
          const decision = await resolveProjectGraphBinding(adapter, b.projectId, target?.id);
          if (decision.binding !== null) input.projectGraph = decision.binding;
          req.log.info(
            { runId, projectId: b.projectId, repoRef: target?.id ?? null },
            `run ${runId}: ${decision.reason}`,
          );
        }
        try {
          await adapter.launchRun(input);
        } catch (err) {
          const msg = message(err);
          if (runIds.length > 0) {
            // Mid-fan failure: earlier runs are LIVE — answering 4xx would tell the caller
            // nothing happened. Name what launched, what failed, and on which repo.
            return reply.code(500).send({
              error:
                `recon fan-out failed on repo '${target?.id ?? '(unscoped)'}' after ` +
                `${runIds.length} run(s) launched: ${msg}`,
              runIds,
              campaign,
            });
          }
          if (err instanceof ProjectsUnsupportedError) {
            return reply.code(501).send({ error: msg });
          }
          const busy = /busy|in flight|already/i.test(msg);
          return reply.code(busy ? 409 : 400).send({ error: msg });
        }
        // The same trail entry POST /runs writes — this IS a run launch, findable by the same
        // `?action=run.launched` query — plus the shared campaign label the fan is grouped by.
        audit.record('run.launched', actorOf(req), {
          runId,
          detail: {
            campaign,
            recon: true,
            ...(target !== null ? { repoRef: target.id } : {}),
            ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
          },
        });
        if (b.projectId !== undefined && deps.projects !== undefined) {
          // The post-commit half of the §2.2 filing (the POST /runs idiom): tag future /ws
          // frames and emit the membership event with the AUTHENTICATED actor id.
          deps.projects.index.set(runId, b.projectId);
          deps.projects.bus?.emit(
            MEMBERSHIP_ATTACHED,
            {
              project_id: b.projectId,
              member: { kind: 'crew.run', ref: runId },
              actor: actorOf(req).id,
            },
            membershipAttachedKey(b.projectId, 'crew.run', runId, Date.now()),
          );
        }
        runIds.push(runId);
      }
      // `runId` (first) is the single-run spelling the ReconPanel's launch already reads;
      // `runIds` is the source of truth (length ≥ 1 always — one entry per fanned repo, in the
      // caller's resolved order; one entry for an unscoped recon).
      return reply.code(201).send({ runId: runIds[0]!, runIds, campaign });
    },
  );
}
