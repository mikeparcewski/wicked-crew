/**
 * `/api/v1/testing/default-evals*` (DES-DEFAULT-EVALS-001 §7): run the default evals over this daemon's own run
 * store, per project or across projects, and read the history.
 *
 *   GET  /testing/default-evals/suites  what each suite checks, and whether crew can replay it
 *   POST /testing/default-evals/run     {project?: string | "all", suites?: SuiteId[], baseline?: boolean}
 *   GET  /testing/default-evals         the history, newest first
 *   GET  /testing/default-evals/:id     one run's report and its cases
 *
 * Everything is read from the run store (sessions, events, decisions, QE ledgers, the latest steering eval); the
 * only write is the report itself, under `<home>/evals/default/`.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../api/api-prefix.js';
import type { EvalRunStore } from '../api/eval-store.js';
import { readRunVerdicts, runQeLedgerRoot } from '../qe/ledger.js';
import { captureAll, type CaptureInput, type DecisionLike, type EventLike, type QeVerdictLike, type RunLike } from './capture.js';
import type { ReplaySet } from './replay.js';
import { runDefaultEvals, SUITE_TITLES } from './runner.js';
import { needsYouSeed } from './seed-needs-you.js';
import { RIG_SEED } from './seed-rig.js';
import { steeringCasesFrom } from './steering.js';
import type { DefaultEvalStore } from './store.js';
import { syntheticSuites } from './synthetic.js';
import { SUITE_IDS, type EvalCase, type SuiteId } from './types.js';

const V = API_PREFIX;

export interface DefaultEvalDeps {
  /** Where runs are kept. Absent (a directly-driven route set): a run is computed and answered, never stored. */
  store?: DefaultEvalStore;
  /** Every run with its units (`adapter.sessionsDetail()`). */
  runs: () => Promise<RunLike[]>;
  /** One run's recorded events (`adapter.runEvents(id)`); `null` when the engine predates the binding. */
  events: (runId: string) => Promise<EventLike[] | null>;
  /** The operator's gate decisions (the decision ledger); empty when decision capture is off. */
  decisions: () => DecisionLike[];
  /** The steering evals' run history, for S5. */
  steeringEvals?: EvalRunStore;
  replay: ReplaySet;
  now?: () => Date;
  newId?: () => string;
}

const RunBody = z
  .object({
    project: z.string().trim().min(1).max(200).optional(),
    suites: z.array(z.enum(SUITE_IDS)).min(1).optional(),
    baseline: z.boolean().optional(),
  })
  .strict();

/** The cases this daemon's own store yields right now (and the baseline, when asked for). */
export async function gatherCases(deps: DefaultEvalDeps, opts: { baseline: boolean }): Promise<EvalCase[]> {
  const runs = await deps.runs();
  const events = new Map<string, EventLike[]>();
  const qeVerdicts: QeVerdictLike[] = [];
  for (const run of runs) {
    const id = typeof run.session['id'] === 'string' ? run.session['id'] : null;
    if (id === null) continue;
    events.set(id, (await deps.events(id)) ?? []);
    const root = runQeLedgerRoot(run.session, null);
    if (root === null) continue;
    try {
      for (const v of readRunVerdicts(root, id)) qeVerdicts.push({ runId: id, ...v });
    } catch {
      // an unreadable ledger is that run's QE cases missing, never the eval failing
    }
  }
  const input: CaptureInput = { runs, events: (id) => events.get(id) ?? [], decisions: deps.decisions(), qeVerdicts };
  const live = captureAll(input);
  let steering: EvalCase[] = [];
  if (deps.steeringEvals !== undefined) {
    const latest = (await deps.steeringEvals.list())[0];
    if (latest !== undefined) steering = steeringCasesFrom(await deps.steeringEvals.get(latest.id));
  }
  const baseline = opts.baseline ? [...RIG_SEED, ...needsYouSeed()] : [];
  // Live cases come last: a live capture of a baseline case replaces it (same id), so nothing counts twice.
  const liveIds = new Set(live.map((c) => c.id));
  return [...baseline.filter((c) => !liveIds.has(c.id)), ...live, ...steering];
}

export function registerDefaultEvalRoutes(app: FastifyInstance, deps: DefaultEvalDeps): void {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  app.get(
    `${V}/testing/default-evals/suites`,
    { config: { manifest: { responseType: 'DefaultEvalSuitesResponse', statusCodes: [200] } } },
    async () => {
      const synth = new Set<SuiteId>(syntheticSuites());
      return {
        suites: SUITE_IDS.map((id) => ({
          id,
          title: SUITE_TITLES[id],
          replay: deps.replay.adapters[id] !== undefined || id === 'steering',
          synthetic: synth.has(id),
          note: deps.replay.missing[id] ?? null,
        })),
      };
    },
  );

  app.post(
    `${V}/testing/default-evals/run`,
    { config: { manifest: { requestType: 'RunDefaultEvalsBody', responseType: 'DefaultEvalReport', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const parsed = RunBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid default-evals run body', details: parsed.error.issues });
      const project = parsed.data.project === undefined || parsed.data.project === 'all' ? null : parsed.data.project;
      const cases = await gatherCases(deps, { baseline: parsed.data.baseline === true });
      const { report, cases: scored } = await runDefaultEvals({
        id: newId(),
        now: now(),
        project,
        cases,
        replay: deps.replay,
        previous: deps.store !== undefined ? await deps.store.previous(project) : {},
        ...(parsed.data.suites !== undefined ? { suites: parsed.data.suites } : {}),
      });
      if (deps.store !== undefined) await deps.store.record({ report, cases: scored });
      return report;
    },
  );

  app.get(
    `${V}/testing/default-evals`,
    { config: { manifest: { responseType: 'ListDefaultEvalRunsResponse', statusCodes: [200] } } },
    async () => ({ runs: deps.store !== undefined ? await deps.store.list() : [] }),
  );

  app.get(
    `${V}/testing/default-evals/:id`,
    { config: { manifest: { responseType: 'DefaultEvalDetail', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const detail = deps.store !== undefined ? await deps.store.get(id) : null;
      if (detail === null) return reply.code(404).send({ error: `no default-eval run ${id}` });
      return detail;
    },
  );
}
