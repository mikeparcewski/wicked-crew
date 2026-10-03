// TR-W7 — scope drift (DES-trigger-registry §4.3 row 4, §4.4 `scope_drift`, §4.7, §4.9 W1a/W1b; §8 test 2
// fixtures: file and directory prefixes, `touch_source:none`, a truncated list, the roll-up).
//
// The check is set logic over two engine-computed facts and nothing else: the creator floor's
// `repoChecksEvaluated.changed` (TR-W1b) against the run's `plan.accepted.touch` (TR-W1a, a bus row the
// registry PULLS — the first entry that listens on the bus).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedEvent, WatchFinding } from 'wicked-crew-api-types';
import { emitOnBus, readBus } from '../src/core/bus.js';
import type { CoreEvent } from '../src/core/types.js';
import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import { inScope, scopeDriftCheck, type ScopeDriftThreshold } from '../src/watch/checks/scope-drift.js';
import { WATCH_FINDING_CLEARED, WATCH_FINDING_PREFIX, WATCH_FINDING_RAISED } from '../src/watch/events.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { WatchRegistry, type WatchRegistryOptions } from '../src/watch/registry.js';
import { Router } from '../src/watch/router.js';
import type { CheckOutput, KeyPointInput, RunWatchState } from '../src/watch/types.js';
import { removeScratch } from './setup/scratch.js';

const PLAN_ACCEPTED = 'wicked.team.plan.accepted';
const ctx = { now: () => 0, stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }) };
const T1: ScopeDriftThreshold = { min_paths: 1 };

const core = (event: Record<string, unknown>, at = 1, replay = false): KeyPointInput => ({
  source: 'core',
  type: String(event['type']),
  event: { session: 'run-1', ...event },
  runId: 'run-1',
  at,
  ...(replay ? { replay: true } : {}),
});

/** A `plan.accepted` bus row as the pull hands it over (the payload carries the team envelope). */
const plan = (touch: string[] | undefined, extra: Record<string, unknown> = {}, planRev = 1): KeyPointInput => ({
  source: 'bus',
  type: PLAN_ACCEPTED,
  event: {
    event_id: 10 + planRev,
    event_type: PLAN_ACCEPTED,
    domain: 'wicked-team',
    subdomain: 'plan',
    idempotency_key: `k-${planRev}`,
    emitted_at: 1,
    payload: {
      run_id: 'run-1',
      ord: null,
      attempt: null,
      by: 'engine',
      at: 1,
      re: null,
      plan_rev: planRev,
      workflow_id: 'feature',
      band: '20-39',
      high_risk: false,
      mode: 'auto',
      steps: [],
      override: null,
      proposal_id: `p-${planRev}`,
      ...(touch !== undefined ? { touch, touch_source: 'user' } : {}),
      ...extra,
    },
  },
  runId: 'run-1',
  at: 1,
  busKey: `k-${planRev}`,
});

const changedOf = (pairs: Array<[string, string]>) => pairs.map(([status, path]) => ({ status, path }));
const floor = (ord: number, attempt: number, changed: Array<[string, string]> | undefined, extra: Record<string, unknown> = {}, at = 1, replay = false): KeyPointInput =>
  core(
    {
      type: 'repoChecksEvaluated',
      ord,
      attempt,
      passed: true,
      criterion: 'repo checks',
      checks: [],
      skipped: [],
      floor: 'creator',
      outcome: 'passed',
      ...(changed !== undefined ? { changed: changedOf(changed) } : {}),
      ...extra,
    },
    at,
    replay,
  );

async function run(steps: KeyPointInput[], threshold: ScopeDriftThreshold = T1) {
  const state: RunWatchState = { runId: 'run-1', seen: new Set(), bag: new Map() };
  const outs: CheckOutput[][] = [];
  for (const s of steps) {
    state.seen.add(s.type);
    outs.push(await scopeDriftCheck.evaluate(s, state, {}, threshold, ctx));
  }
  const raised = outs.flat().flatMap((o) => (o.op === 'raise' ? [o] : []));
  // A run-scoped check always has run coverage (never `null`); widened so a test can read `reason`.
  const coverage = scopeDriftCheck.coverage(state) as { state: 'checked' | 'not_checked'; reason?: string };
  return { outs, state, raised, subjects: raised.map((r) => r.subject), coverage };
}

describe('inScope — touch entries are files or directory prefixes (ending /)', () => {
  it('exact file, directory prefix, and the strict no-slash case', () => {
    const touch = ['src/a.ts', 'docs/', './lib/'];
    expect(inScope('src/a.ts', touch)).toBe(true);
    expect(inScope('docs/guide/x.md', touch)).toBe(true);
    expect(inScope('lib//deep/y.ts', touch)).toBe(true); // normalised: `./` and doubled slashes
    expect(inScope('src/b.ts', touch)).toBe(false);
    expect(inScope('docs', touch)).toBe(false); // the directory itself is not a file inside it
    expect(inScope('src', ['src'])).toBe(true);
    expect(inScope('src/x.ts', ['src'])).toBe(false); // no trailing slash = a file, never a prefix (§4.4)
  });
});

describe('deterministic:scope_drift — fixture table (test 2)', () => {
  it('a path per flag: files and directory prefixes in the touch set are in scope, everything else is one medium flag per (attempt, path)', async () => {
    const { raised, coverage } = await run([
      plan(['src/a.ts', 'docs/']),
      floor(3, 0, [['M', 'src/a.ts'], ['A', 'docs/x.md'], ['M', 'src/b.ts'], ['D', 'lib/y.ts']]),
    ]);
    expect(raised.map((r) => ({ subject: r.subject, kind: r.kind, severity: r.severity, ord: r.ord, attempt: r.attempt }))).toEqual([
      { subject: '3:0:drift:src/b.ts', kind: 'flag', severity: undefined, ord: 3, attempt: 0 },
      { subject: '3:0:drift:lib/y.ts', kind: 'flag', severity: undefined, ord: 3, attempt: 0 },
    ]);
    expect(raised[0]!.sentence).toBe('Changed a file outside the plan\'s declared scope: src/b.ts.');
    expect(raised[0]!.facts).toMatchObject({ path: 'src/b.ts', status: 'M', touch_source: 'user', declared: 2 });
    expect(raised[0]!.re).toBe('repoChecksEvaluated#3:0');
    expect(coverage).toEqual({ state: 'checked' });
  });

  it('touch_source none (nothing declared) → nothing is flagged and coverage says "no declared scope"', async () => {
    const { raised, coverage } = await run([plan(undefined, { touch_source: 'none' }), floor(3, 0, [['M', 'src/b.ts']])]);
    expect(raised).toEqual([]);
    expect(coverage.state).toBe('not_checked');
    expect(coverage.reason).toMatch(/no declared scope/);
  });

  it('an old plan.accepted row (no touch, no touch_source — an engine before TR-W1a) reads as none, and says so', async () => {
    const { raised, coverage } = await run([plan(undefined), floor(3, 0, [['M', 'src/b.ts']])]);
    expect(raised).toEqual([]);
    expect(coverage.state).toBe('not_checked');
    expect(coverage.reason).toMatch(/no declared scope/);
    expect(coverage.reason).toMatch(/0\.7\.35/);
  });

  it('a creator floor that arrives BEFORE the plan is kept and judged when the plan lands, anchored to the floor\'s own time and replay provenance', async () => {
    const { outs, coverage } = await run([
      floor(2, 1, [['M', 'src/b.ts']], {}, 500, true),
      floor(2, 1, [['M', 'src/b.ts']], {}, 500, true), // a redelivery of the same floor is one floor
      plan(['src/a.ts']),
    ]);
    expect(outs[0]).toEqual([]);
    expect(outs[1]).toEqual([]);
    const late = outs[2]!.flatMap((o) => (o.op === 'raise' ? [o] : []));
    expect(late.map((o) => [o.subject, o.at, o.replay])).toEqual([['2:1:drift:src/b.ts', 500, true]]);
    expect(coverage).toEqual({ state: 'checked' });
  });

  it('a floor judged live carries no override of the input\'s time (the emitter anchors it to the floor event)', async () => {
    const { raised } = await run([plan(['src/']), floor(4, 0, [['M', 'README.md']])]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.at).toBeUndefined();
    expect(raised[0]!.replay).toBeUndefined();
  });

  it('a truncated change list is still judged on the paths it names, and the fact says it was cut (coverage stays checked)', async () => {
    const { raised, coverage } = await run([plan(['src/']), floor(5, 0, [['M', 'docs/a.md']], { changedTruncated: true })]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.facts).toMatchObject({ changed_truncated: true });
    expect(coverage).toEqual({ state: 'checked' });
  });

  it('a truncated TOUCH set (the union was cut at 64) cannot say what is outside: nothing is flagged, coverage says why', async () => {
    const { raised, coverage } = await run([plan(['src/'], { touch_truncated: true }), floor(5, 0, [['M', 'docs/a.md']])]);
    expect(raised).toEqual([]);
    expect(coverage.state).toBe('not_checked');
    expect(coverage.reason).toMatch(/cut at 64/);
  });

  it('the newest accepted revision\'s touch (already the union of earlier revs) is the scope; a lower rev arriving late never narrows it', async () => {
    const { outs } = await run([
      plan(['a/'], {}, 1),
      floor(3, 0, [['M', 'b/x.ts']]),
      plan(['a/', 'b/'], {}, 2),
      floor(4, 0, [['M', 'b/y.ts']]),
      plan(['a/'], {}, 1), // a replayed rev 1 after rev 2
      floor(5, 0, [['M', 'b/z.ts']]),
    ]);
    expect(outs.flat().flatMap((o) => (o.op === 'raise' ? [o.subject] : []))).toEqual(['3:0:drift:b/x.ts']);
  });

  it('threshold.min_paths: an attempt with fewer paths outside than the threshold raises nothing; at the threshold every path is flagged', async () => {
    const steps = [plan(['src/']), floor(3, 0, [['M', 'a.md'], ['M', 'b.md']]), floor(4, 0, [['M', 'c.md'], ['M', 'd.md'], ['M', 'e.md']])];
    const { subjects } = await run(steps, { min_paths: 3 });
    expect(subjects).toEqual(['4:0:drift:c.md', '4:0:drift:d.md', '4:0:drift:e.md']);
  });

  it('one row per (attempt, path): a redelivered floor adds nothing, a later attempt on the same path is a new row', async () => {
    const { subjects } = await run([
      plan(['src/']),
      floor(3, 0, [['M', 'a.md']]),
      floor(3, 0, [['M', 'a.md']]),
      floor(3, 1, [['M', 'a.md']]),
    ]);
    expect(subjects).toEqual(['3:0:drift:a.md', '3:1:drift:a.md']);
  });

  it('paths are normalised before the comparison (`./`, doubled slashes), on both sides', async () => {
    const { raised } = await run([plan(['./src/', 'docs//readme.md']), floor(3, 0, [['M', 'src//deep/x.ts'], ['M', './docs/readme.md'], ['M', 'other.md']])]);
    expect(raised.map((r) => r.subject)).toEqual(['3:0:drift:other.md']);
  });

  it('a verify floor is not the creator\'s change (ignored even if routed); a creator floor without `changed` (the tree did not change) raises nothing and counts as checked', async () => {
    const { raised, coverage } = await run([
      plan(['src/']),
      floor(3, 0, [['M', 'docs/a.md']], { floor: 'verify' }),
      floor(3, 0, undefined),
    ]);
    expect(raised).toEqual([]);
    expect(coverage).toEqual({ state: 'checked' });
  });

  it('coverage before anything happened: no creator floor yet; with a plan but no floor: the same; a floor but no plan: waiting for the plan', async () => {
    expect((await run([])).coverage).toEqual({ state: 'not_checked', reason: 'no creator floor has run yet' });
    expect((await run([plan(['src/'])])).coverage).toEqual({ state: 'not_checked', reason: 'no creator floor has run yet' });
    const waiting = await run([floor(3, 0, [['M', 'a.md']])]);
    expect(waiting.coverage.state).toBe('not_checked');
    expect(waiting.coverage.reason).toMatch(/no accepted plan/);
  });

  it('describe names the threshold in plain words', () => {
    expect(scopeDriftCheck.describe({ min_paths: 1 })).toMatch(/outside the plan/);
    expect(scopeDriftCheck.describe({ min_paths: 3 })).toMatch(/3 paths/);
  });
});

// ── the shipped entry and the registry ────────────────────────────────────────

let dir: string;
let busPath: string;
let registries: WatchRegistry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-w7-'));
  busPath = join(dir, 'bus', 'bus.db');
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.stop();
  removeScratch(dir);
});

/** The internal shipped entries plus `scope-drift`, as shipped. */
function entriesDir(): string {
  const d = join(dir, 'entries');
  mkdirSync(d, { recursive: true });
  for (const e of loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries.filter((x) => x.on.source === 'internal' || x.id === 'scope-drift')) {
    writeFileSync(join(d, `${e.id}.json`), JSON.stringify(e));
  }
  return d;
}

function makeRegistry(over: Partial<WatchRegistryOptions> = {}): WatchRegistry {
  const r = new WatchRegistry({
    dbPath: busPath,
    settings: async () => undefined,
    projectOf: () => 'proj-1',
    flushMs: 0,
    tickMs: 0,
    pollIntervalMs: 20,
    sleep: async () => undefined,
    entriesDir: entriesDir(),
    ...over,
  });
  registries.push(r);
  return r;
}

async function watchRows(): Promise<Array<{ event_type: string; payload: WatchFinding }>> {
  return (await readBus(busPath, WATCH_FINDING_PREFIX, { history: true })).map((r) => ({ event_type: r.event_type, payload: r.payload as WatchFinding }));
}

async function emitPlan(runId: string, touch: string[], planRev = 1): Promise<void> {
  await emitOnBus(busPath, {
    event_type: PLAN_ACCEPTED,
    domain: 'wicked-team',
    subdomain: 'plan',
    idempotency_key: `team:${PLAN_ACCEPTED}:${runId}:${planRev}`,
    payload: { run_id: runId, ord: null, attempt: null, by: 'engine', at: Date.now(), re: null, plan_rev: planRev, workflow_id: 'feature', band: '20-39', high_risk: false, mode: 'auto', steps: [], override: null, proposal_id: `p-${planRev}`, touch, touch_source: 'user' },
  });
}

const liveFloor = (runId: string, ord: number, attempt: number, paths: string[]): CoreEvent =>
  ({ type: 'repoChecksEvaluated', session: runId, ord, attempt, passed: true, criterion: 'repo checks', checks: [], skipped: [], floor: 'creator', outcome: 'passed', changed: paths.map((path) => ({ status: 'M', path })) }) as unknown as CoreEvent;

describe('the shipped scope-drift entry', () => {
  it('is the §4.2 entry: on the creator floor, joined to plan.accepted on the bus, min_paths 1, flag medium problem, per_run 5, p1, enabled', () => {
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    const e = entries.find((x) => x.id === 'scope-drift');
    expect(e).toMatchObject({
      version: 1,
      on: { source: 'core', type: 'repoChecksEvaluated' },
      join: [{ source: 'bus', type: PLAN_ACCEPTED }],
      filter: { floor: 'creator' },
      check: 'deterministic:scope_drift',
      threshold: { min_paths: 1 },
      emit: { as: 'flag', severity: 'medium', watch_kind: 'problem', attach: null, rate: { per_run: 5 } },
      priority: 'p1',
      enabled: true,
    });
    // The first bus-listening entry: the router now names a bus type, so the registry arms the pull.
    expect(new Router(entries).busTypes()).toEqual([PLAN_ACCEPTED]);
  });

  it('replay at arm reads the run\'s plan.accepted row from the bus history; live floors then roll up past per_run (one live roll-up row per attempt)', async () => {
    await emitPlan('run-1', ['src/']);
    const recorded: RecordedEvent[] = [];
    const r = makeRegistry({ liveRuns: async () => ['run-1'], runEvents: async () => recorded });
    await r.arm();
    expect(r.health().sources.bus).toBe('ok');
    expect(r.coverage('run-1').find((c) => c.entry_id === 'scope-drift')).toEqual({ entry_id: 'scope-drift', state: 'not_checked', reason: 'no creator floor has run yet' });
    r.offer(liveFloor('run-1', 3, 0, ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']));
    await r.flush();
    const rows = await watchRows();
    const raised = rows.filter((x) => x.event_type === WATCH_FINDING_RAISED).map((x) => x.payload);
    const plain = raised.filter((p) => p.rolled_up === 0);
    expect(plain.map((p) => p.facts['path'])).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    expect(plain[0]).toMatchObject({ entry_id: 'scope-drift', kind: 'flag', severity: 'medium', watch_kind: 'problem', run_id: 'run-1', project_id: 'proj-1', ord: 3, attempt: 0 });
    // Two more than the rate: the roll-up chain for attempt 0 ends at one LIVE roll-up row standing for both.
    const rollups = raised.filter((p) => p.rolled_up > 0);
    const cleared = rows.filter((x) => x.event_type === WATCH_FINDING_CLEARED).map((x) => x.payload as unknown as { watch_id: string; reason: string });
    const live = rollups.filter((p) => !cleared.some((c) => c.watch_id === p.watch_id));
    expect(live).toHaveLength(1);
    expect(live[0]!.rolled_up).toBe(2);
    expect(live[0]!.sentence).toMatch(/2 more like this on this run/);
    expect(r.coverage('run-1').find((c) => c.entry_id === 'scope-drift')).toEqual({ entry_id: 'scope-drift', state: 'checked' });
  });

  it('live: a floor that arrives before the plan waits; the PULLED plan.accepted row then yields its flags (the bus source, end to end)', async () => {
    const r = makeRegistry();
    await r.arm();
    r.offer(liveFloor('run-2', 2, 0, ['src/x.ts', 'docs/y.md']));
    await r.flush();
    expect(await watchRows()).toEqual([]);
    expect(r.coverage('run-2').find((c) => c.entry_id === 'scope-drift')).toMatchObject({ state: 'not_checked', reason: expect.stringMatching(/no accepted plan/) as unknown as string });
    await emitPlan('run-2', ['src/']);
    let rows: Awaited<ReturnType<typeof watchRows>> = [];
    for (let i = 0; i < 100 && rows.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await r.flush();
      rows = await watchRows();
    }
    expect(rows.map((x) => [x.event_type, x.payload.facts['path']])).toEqual([[WATCH_FINDING_RAISED, 'docs/y.md']]);
    expect(rows[0]!.payload.anchor).toMatchObject({ run_id: 'run-2', ord: 2, attempt: 0 });
    expect(r.coverage('run-2').find((c) => c.entry_id === 'scope-drift')).toEqual({ entry_id: 'scope-drift', state: 'checked' });
  });
});
