/**
 * The daemon's half of workflow discovery (DES-walkthrough-proof §4.13; WT-W4): the project-level
 * view the two discovery entries count over, built from records the daemon already keeps and handed
 * to the watch registry as its `discovery` source (the registry reads it on a cadence, with a
 * deadline; the checks in `src/watch/checks/discovery.ts` stay pure over the view).
 *
 * Per run of the project:
 *   - `human_added` — the catalog ids a PERSON put in the plan, from the run's `wicked.team.plan.*`
 *     bus rows ({@link humanAddedOf}): `plan.proposed{by:"human"}` steps the PA's proposal did not
 *     carry, floor-added never, `plan.revised` (pa_added / member_request) never, less any step an
 *     accepted override removed;
 *   - `walkthrough` — the newest `walkthrough_review` recorder's `WALKTHROUGH-SEAL … overall`, read
 *     from the unit's engine-captured output (what the recorder reported; discovery counts, it does
 *     not accept evidence, so the seal is not re-verified here — acceptance does that);
 *   - `test` — the QE verdict the acceptance gate attributes to the run (the same ledger read
 *     `GET /runs/:id/acceptance` makes), only for a run with a `test` step and a registered repo;
 *   - `launched_at` — the session's `created_at`, else the run's first recorded frame.
 *
 * A run whose event log cannot be read is counted `unreadable`, never treated as "no". Terminal runs
 * are cached for the daemon's life (their facts cannot change); live ones are re-read.
 */

import type { RecordedEvent, RepoEntry, SessionView } from 'wicked-crew-api-types';
import { readBus, type BusEvent } from '../core/bus.js';
import { runWindowFromEvents } from '../qe/acceptance.js';
import { readAcceptanceState } from '../qe/ledger.js';
import { parseSeal } from '../qe/walkthrough-acceptance.js';
import type { DiscoveryRun, DiscoverySnapshot } from '../watch/types.js';
import { coreUnitId } from './evidence.js';

/** A `wicked.team.plan.*` bus row as discovery reads it. */
export type PlanRow = Pick<BusEvent, 'event_id' | 'event_type' | 'payload'>;

const PLAN_PREFIX = 'wicked.team.plan.';
const PLAN_PROPOSED = 'wicked.team.plan.proposed';
const PLAN_ACCEPTED = 'wicked.team.plan.accepted';
const WALKTHROUGH_REVIEW_CATALOG = 'walkthrough_review';
const TEST_CATALOG = 'test';
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

interface Step {
  catalog: string;
  id: string;
  added_by?: string;
}

const stepsOf = (v: unknown): Step[] =>
  Array.isArray(v)
    ? v.filter((s): s is Step => typeof s === 'object' && s !== null && typeof (s as Step).catalog === 'string' && typeof (s as Step).id === 'string')
    : [];

/**
 * §4.13 `added_by_hand`: the catalog ids a PERSON put in one run's plan. The steps of every
 * `plan.proposed{by:"human"}` row (an initial human plan, or a human edit at the gate) that no
 * non-human proposal of the run carried (the PA's base), floor-added steps never, less the catalog
 * of any step an accepted `override.remove` took back ("never overrode"). `plan.revised` rows
 * (`pa_added`, `member_request`) are the PA's and are not read.
 */
export function humanAddedOf(rows: readonly PlanRow[]): string[] {
  const base = new Set<string>();
  const human = new Set<string>();
  const stepCatalog = new Map<string, string>();
  const removedSteps = new Set<string>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (r.event_type === PLAN_PROPOSED) {
      const steps = stepsOf(p['steps']);
      for (const s of steps) stepCatalog.set(s.id, s.catalog);
      if (p['by'] === 'human') {
        for (const s of steps) if (s.added_by !== 'floor') human.add(s.catalog);
      } else {
        for (const s of steps) base.add(s.catalog);
      }
    } else if (r.event_type === PLAN_ACCEPTED) {
      for (const s of stepsOf(p['steps'])) stepCatalog.set(s.id, s.catalog);
      const override = p['override'] as { remove?: unknown } | null | undefined;
      if (override !== null && typeof override === 'object' && Array.isArray(override.remove)) {
        for (const id of override.remove) if (typeof id === 'string') removedSteps.add(id);
      }
    }
  }
  const removed = new Set<string>();
  for (const id of removedSteps) {
    const catalog = stepCatalog.get(id);
    if (catalog !== undefined) removed.add(catalog);
  }
  return [...human].filter((c) => !base.has(c) && !removed.has(c)).sort();
}

export interface DiscoverySourceDeps {
  /** The engine's bus (plan rows); `undefined` = no bus, nothing human-added is known. */
  dbPath: string | undefined;
  /** The run (and chat) ids that belong to the project (the membership index). */
  runsOf(projectId: string): string[];
  sessions(): Promise<SessionView[]>;
  runEvents(runId: string): Promise<RecordedEvent[] | null>;
  workOutput(unitId: string): Promise<string | null>;
  repos(): Promise<RepoEntry[]>;
  /** The run's attributed QE verdict (the acceptance gate's ledger read); injectable for tests. */
  testVerdict?(repoRoot: string, runId: string, events: RecordedEvent[]): Promise<string | null>;
  now?(): number;
}

/** The verdict `GET /runs/:id/acceptance` would attribute to the run from the repo's QE ledger. */
export async function attributedTestVerdict(repoRoot: string, runId: string, events: RecordedEvent[]): Promise<string | null> {
  const state = await readAcceptanceState(repoRoot, { run: runWindowFromEvents(events, runId) });
  return state.verdict?.verdict ?? null;
}

export function makeDiscoverySource(deps: DiscoverySourceDeps): (projectId: string) => Promise<DiscoverySnapshot> {
  /** Terminal runs, by id: their facts cannot change for the daemon's life. */
  const cache = new Map<string, DiscoveryRun>();
  const testVerdict = deps.testVerdict ?? attributedTestVerdict;
  return async (projectId) => {
    const wanted = new Set(deps.runsOf(projectId));
    if (wanted.size === 0) return { project_id: projectId, runs: [], unreadable: 0 };
    const views = (await deps.sessions()).filter((v) => wanted.has(v.session.id));
    const rowsByRun = new Map<string, PlanRow[]>();
    if (deps.dbPath !== undefined) {
      let rows: BusEvent[] = [];
      try {
        rows = await readBus(deps.dbPath, PLAN_PREFIX, { history: true });
      } catch {
        rows = [];
      }
      for (const r of rows) {
        const runId = (r.payload as { run_id?: unknown } | null)?.run_id;
        if (typeof runId !== 'string' || !wanted.has(runId)) continue;
        const list = rowsByRun.get(runId) ?? [];
        list.push(r);
        rowsByRun.set(runId, list);
      }
    }
    let repos: RepoEntry[] | null = null;
    const runs: DiscoveryRun[] = [];
    let unreadable = 0;
    for (const v of views) {
      const id = v.session.id;
      const cached = cache.get(id);
      if (cached !== undefined) {
        runs.push(cached);
        continue;
      }
      let events: RecordedEvent[] | null;
      try {
        events = await deps.runEvents(id);
      } catch {
        events = null;
      }
      if (events === null) {
        unreadable += 1;
        continue;
      }
      const units = [...(v.units ?? [])].sort((a, b) => a.ord - b.ord);
      const review = units.filter((u) => u.catalog === WALKTHROUGH_REVIEW_CATALOG && u.status !== 'pending').at(-1);
      let walkthrough: string | null = null;
      if (review !== undefined) {
        const output = await deps.workOutput(coreUnitId(id, review)).catch(() => null);
        walkthrough = parseSeal(output)?.overall ?? null;
      }
      let test: string | null = null;
      if (v.session.repo_ref !== null && units.some((u) => u.catalog === TEST_CATALOG)) {
        repos ??= await deps.repos().catch(() => []);
        const repo = repos.find((r) => r.id === v.session.repo_ref);
        if (repo !== undefined) test = await testVerdict(repo.root_path, id, events).catch(() => null);
      }
      const created = (v.session as { created_at?: unknown }).created_at;
      let firstTs = Number.POSITIVE_INFINITY;
      for (const e of events) if (typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts < firstTs) firstTs = e.ts;
      const launchedAt = typeof created === 'number' && Number.isFinite(created) ? created : Number.isFinite(firstTs) ? firstTs : 0;
      const run: DiscoveryRun = {
        run_id: id,
        kind: v.session.workflow_id,
        launched_at: launchedAt,
        human_added: humanAddedOf(rowsByRun.get(id) ?? []),
        walkthrough,
        test,
      };
      if (TERMINAL_STATUSES.has(v.session.status)) cache.set(id, run);
      runs.push(run);
    }
    runs.sort((a, b) => a.launched_at - b.launched_at || a.run_id.localeCompare(b.run_id));
    return { project_id: projectId, runs, unreadable };
  };
}
