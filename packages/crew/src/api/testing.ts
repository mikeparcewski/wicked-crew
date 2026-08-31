/**
 * The `/api/v1/testing/*` surface (crew-testing) — the wire behind the studio's Testing page:
 * RUN the governance evals (does the steering corpus actually catch the behaviors it claims
 * to?) and IMPORT a named eval corpus for later runs.
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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { GovernanceEvalsUnsupportedError, type CoreAdapter } from '../core/adapter.js';
import type { Actor, GovernanceEvalSample } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { API_PREFIX } from './api-prefix.js';
import { STEERING_TYPE_VALUES } from './governance-steering.js';

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

export interface TestingRoutesDeps {
  audit: AuditLog;
  actorOf: (req: FastifyRequest & { actor?: Actor }) => Actor;
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
}
