// DES-TRIGGER-REGISTRY-001 TR-W5a — the watch registry runtime.
//
// Pinned here (§8 test plan):
//   1. key vectors: the watch keys are `deterministic_key` over producer-assigned identity, pinned
//      per shipped entry; a replay resolves to the same `watch_id`;
//   4. the loader refuses each violating entry with a reason and loads the rest;
//   6. the hot path: 1,100 synthetic CoreEvents (68% unitOutputDelta) through `offer()` — p99 under
//      50 µs, `offer` returns nothing to await, p2 is shed before p1 and p0 never;
//   7. restart: a registry killed with rows still unflushed, then re-armed over the same bus and the
//      run's persisted events, leaves exactly one row per `watch_id`; an event the run recorded
//      while the daemon was down yields its finding after boot;
//   plus: no bus → not armed and health says why; only the two internal entries ship enabled; the
//   internal entries fire (lagging per episode, check-failed past its threshold); the roll-up; the
//   `/ws` relay carries `watchEvent`; dismiss; a failed emit is retried then dropped and audited;
//   a proposal row reaches the review-queue sink once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { RecordedEvent, WatchFinding } from 'wicked-crew-api-types';
import { busTesting, readBus } from '../src/core/bus.js';
import type { CoreEvent } from '../src/core/types.js';
import { deterministicKey } from '../src/team/key.js';
import { SHIPPED_CHECKS } from '../src/watch/checks/index.js';
import { WATCH_FINDING_CLEARED, WATCH_FINDING_PREFIX, WATCH_FINDING_RAISED } from '../src/watch/events.js';
import { clearedKey, watchIdOf } from '../src/watch/keys.js';
import { loadEntries, SHIPPED_ENTRIES_DIR } from '../src/watch/loader.js';
import { WatchRegistry, type WatchRegistryOptions } from '../src/watch/registry.js';
import { PushRing } from '../src/watch/ring.js';
import type { WatchCheck } from '../src/watch/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let busPath: string;
let registries: WatchRegistry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-registry-'));
  busPath = join(dir, 'bus', 'bus.db');
  registries = [];
});

afterEach(async () => {
  for (const r of registries) await r.stop();
  removeScratch(dir);
});

/** A test-only check: raises one finding per `testPoint` event, keyed by its own ord:attempt. */
const pointCheck: WatchCheck = {
  name: 'deterministic:test_point',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, unknown>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, unknown>>,
  evaluate(input) {
    const e = (input.source === 'bus' ? input.event['payload'] : input.event) as { ord?: number; attempt?: number; clear?: boolean };
    const subject = `${e.ord}:${e.attempt}:testPoint`;
    if (e.clear === true) return [{ op: 'clear', subject }];
    return [
      {
        op: 'raise',
        subject,
        sentence: `Point ${e.ord} attempt ${e.attempt}.`,
        ord: e.ord ?? null,
        attempt: e.attempt ?? null,
        re: `testPoint#${e.ord}:${e.attempt}`,
        facts: { secret_line: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab here' },
      },
    ];
  },
  coverage: (state) => (state.seen.has('testPoint') ? { state: 'checked' } : { state: 'not_checked', reason: 'no test point yet' }),
  describe: () => 'On every test point',
};

const throwingCheck: WatchCheck = {
  ...pointCheck,
  name: 'deterministic:test_throws',
  evaluate() {
    throw new Error('boom');
  },
};

const checks = new Map<string, WatchCheck>([...SHIPPED_CHECKS, [pointCheck.name, pointCheck], [throwingCheck.name, throwingCheck]]);

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: 1,
    on: { source: 'core', type: 'testPoint' },
    filter: {},
    check: 'deterministic:test_point',
    params: {},
    threshold: {},
    emit: { as: 'finding', severity: 'medium', watch_kind: 'problem', attach: null, rate: { per_run: 5 } },
    priority: 'p1',
    enabled: true,
    ...over,
  };
}

/** An entries dir with the shipped internal entries plus `extra`. */
function entriesDir(extra: Record<string, unknown>[]): string {
  const d = join(dir, 'entries');
  mkdirSync(d, { recursive: true });
  for (const { id, ...rest } of [
    // The INTERNAL shipped entries only: the run-scoped ones (TR-W5b) have their own tests.
    ...loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries.filter((e) => e.on.source === 'internal').map((e) => ({ ...e })),
    ...extra,
  ] as Array<Record<string, unknown>>) {
    writeFileSync(join(d, `${String(id)}.json`), JSON.stringify({ id, ...rest }));
  }
  return d;
}

function makeRegistry(over: Partial<WatchRegistryOptions> = {}): WatchRegistry {
  const r = new WatchRegistry({
    dbPath: busPath,
    checks,
    settings: async () => undefined,
    projectOf: (runId) => (runId === 'run-p' ? 'proj-1' : undefined),
    flushMs: 0,
    tickMs: 0,
    pollIntervalMs: 20,
    sleep: async () => undefined,
    ...over,
  });
  registries.push(r);
  return r;
}

async function watchRows(): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  return (await readBus(busPath, WATCH_FINDING_PREFIX, { history: true })) as unknown as Array<{
    event_type: string;
    payload: Record<string, unknown>;
  }>;
}

function point(session: string, ord: number, attempt: number, extra: Record<string, unknown> = {}): CoreEvent {
  return { type: 'testPoint', session, ord, attempt, ...extra } as unknown as CoreEvent;
}

describe('watch keys (test 1)', () => {
  it('a watch key is deterministic_key over ["watch", type, run|-, entry, version, subject]', () => {
    expect(watchIdOf('run-1', 'claim-vs-evidence', 1, '5:1:repoChecksEvaluated')).toBe(
      `w-${deterministicKey(['watch', WATCH_FINDING_RAISED, 'run-1', 'claim-vs-evidence', '1', '5:1:repoChecksEvaluated'])}`,
    );
    // A run-less row spells the run as "-".
    expect(watchIdOf(null, 'registry-lagging', 1, 'lag:1')).toBe(
      `w-${deterministicKey(['watch', WATCH_FINDING_RAISED, '-', 'registry-lagging', '1', 'lag:1'])}`,
    );
    expect(clearedKey('w-00')).toBe(deterministicKey(['watch', WATCH_FINDING_CLEARED, 'w-00', 'cleared']));
  });

  it('pins watch ids computed independently from the DES §4.5 recipe (a key change breaks every dedupe on the bus)', () => {
    // Values computed outside crew (Python hashlib over the same parts + NUL bytes); the same
    // recipe reproduces the DES-TEAMING-002 team vector f8289d40… (tests/team-events.test.ts).
    expect(watchIdOf(null, 'registry-lagging', 1, 'lag:1759300320000')).toBe('w-cbaef602805398aa4398ed7189f164e5');
    expect(watchIdOf(null, 'registry-check-failed', 1, 'check-failed:claim-vs-evidence:1759300320000')).toBe(
      'w-d80d8be7fded583aa2784045825b2730',
    );
    expect(watchIdOf('r-88', 'claim-vs-evidence', 1, '5:1:repoChecksEvaluated')).toBe('w-0ad8fb6dc7f6e90a2898b5c572eff253');
  });
});

describe('the loader (test 4)', () => {
  it('ships the two internal entries, the three TR-W5b entries and the two TR-W6 entries, all enabled', () => {
    const { entries, refused } = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS);
    expect(refused).toEqual([]);
    expect(entries.map((e) => [e.id, e.enabled, e.on.source])).toEqual([
      ['claim-vs-evidence', true, 'core'],
      ['deliver-audit', true, 'core'],
      ['quiet-after-claim', true, 'watchdog'],
      ['registry-check-failed', true, 'internal'],
      ['registry-lagging', true, 'internal'],
      ['risky-call', true, 'core'],
      ['ungated', true, 'core'],
    ]);
  });

  it('the shipped entries carry no home-directory paths or personal identifiers (§7 privacy grep)', () => {
    const files = readdirSync(SHIPPED_ENTRIES_DIR).map((n) => readFileSync(join(SHIPPED_ENTRIES_DIR, n), 'utf8'));
    expect(files.length).toBeGreaterThan(0);
    for (const text of files) {
      expect(text).not.toMatch(/\/(Users|home)\/|[A-Za-z]:\\Users|~\/|@[a-z0-9-]+\.(com|org|net|io)\b/i);
    }
  });

  it('refuses each violating entry with its reason and still loads the rest', () => {
    const d = join(dir, 'bad');
    mkdirSync(d);
    const write = (name: string, body: unknown) =>
      writeFileSync(join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
    write('good-one.json', entry('good-one'));
    write('unknown-check.json', entry('unknown-check', { check: 'deterministic:nope' }));
    write('allowish.json', entry('allowish', { emit: { as: 'allow', severity: 'high', watch_kind: 'problem', attach: null, rate: { per_run: 1 } } }));
    write('bad-bus.json', entry('bad-bus', { on: { source: 'bus', type: 'wicked.team.plan' } }));
    write('mismatch.json', entry('other-id'));
    write('broken.json', '{ not json');
    write('bad-threshold.json', entry('bad-threshold', { check: 'deterministic:lag', threshold: { queue_depth: -1, tail_lag_ms: 60000 } }));
    const { entries, refused } = loadEntries(d, checks);
    expect(entries.map((e) => e.id)).toEqual(['good-one']);
    const why = Object.fromEntries(refused.map((r) => [r.id, r.reason]));
    expect(why['unknown-check']).toMatch(/unknown check "deterministic:nope"/);
    expect(why['allowish']).toMatch(/emit\.as/);
    expect(why['bad-bus']).toMatch(/4-segment/);
    expect(why['mismatch']).toMatch(/differs from the file name/);
    expect(why['broken']).toMatch(/not JSON/);
    expect(why['bad-threshold']).toMatch(/threshold: queue_depth/);
  });
});

describe('the push ring and the hot path (test 6)', () => {
  it('sheds p2 before p1 and never p0', () => {
    const ring = new PushRing<string>(4);
    ring.push('a0', 'p0');
    ring.push('a1', 'p1');
    ring.push('a2', 'p2');
    ring.push('b0', 'p0');
    ring.push('b1', 'p1'); // over: the p2 goes
    expect(ring.stats().shed_by_priority).toEqual({ p0: 0, p1: 0, p2: 1 });
    ring.push('c0', 'p0'); // over: the oldest p1 goes
    expect(ring.stats().shed_by_priority).toEqual({ p0: 0, p1: 1, p2: 1 });
    ring.push('d0', 'p0'); // over: the last p1 goes
    ring.push('e0', 'p0'); // only p0 left: grows, sheds nothing
    expect(ring.stats().shed_by_priority).toEqual({ p0: 0, p1: 2, p2: 1 });
    expect(ring.depth).toBe(5);
    const out: string[] = [];
    for (let x = ring.shift(); x !== undefined; x = ring.shift()) out.push(x);
    expect(out).toEqual(['a0', 'b0', 'c0', 'd0', 'e0']);
  });

  it('1,100 CoreEvents a minute through offer(): p99 under 50 µs and nothing to await', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('point', { priority: 'p2' })]) });
    await r.arm();
    expect(r.armed).toBe(true);
    const events: CoreEvent[] = [];
    for (let i = 0; i < 1100; i++) {
      events.push(
        i % 100 < 68
          ? ({ type: 'unitOutputDelta', session: 'run-h', ord: 1, chunk: 'x'.repeat(80) } as unknown as CoreEvent)
          : point('run-h', i, 1),
      );
    }
    // Warm the JIT, then measure.
    for (let i = 0; i < 200; i++) r.offer({ type: 'unitOutputDelta', session: 'w' } as unknown as CoreEvent);
    const times: number[] = [];
    for (const e of events) {
      const t0 = process.hrtime.bigint();
      const ret = r.offer(e) as unknown;
      times.push(Number(process.hrtime.bigint() - t0) / 1000);
      expect(ret).toBeUndefined(); // no promise on the fan-in, ever
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)]!;
    expect(p99).toBeLessThan(50);
    await r.flush();
    // The 352 test points (the deltas were dropped by Set.has): 5 rows at the rate, then ONE live
    // roll-up row standing for the other 347; a burst's roll-up updates coalesce in the batch.
    const rows = (await watchRows()).filter((x) => x.payload['entry_id'] === 'point');
    const raised = rows.filter((x) => x.event_type === WATCH_FINDING_RAISED).map((x) => x.payload as unknown as WatchFinding);
    const clearedIds = new Set(rows.filter((x) => x.event_type === WATCH_FINDING_CLEARED).map((x) => x.payload['watch_id']));
    expect(raised.filter((x) => x.rolled_up === 0)).toHaveLength(5);
    const live = raised.filter((x) => x.rolled_up > 0 && !clearedIds.has(x.watch_id));
    expect(live.map((x) => x.rolled_up)).toEqual([347]);
    expect(raised.length).toBeLessThan(5 + 60);
  });

  it('a shed raises ONE tick, outside the push: the ring is not refilled with ticks (no recursion)', async () => {
    const r = makeRegistry({ ringCapacity: 8, entriesDir: entriesDir([entry('point', { priority: 'p2' })]) });
    await r.arm();
    for (let i = 0; i < 100; i++) r.offer(point('run-s', i, 1)); // synchronous: nothing drains in between
    const h = r.health();
    expect(h.queue.depth).toBe(8); // still capped: no tick was pushed from inside push()
    expect(h.queue.shed_by_priority.p2).toBe(92);
    await r.flush();
    const lag = (await watchRows()).filter((x) => x.payload['entry_id'] === 'registry-lagging');
    expect(lag).toHaveLength(1);
  });

  it('stop() drains what was accepted before it returns', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('point')]) });
    await r.arm();
    r.offer(point('run-stop', 1, 1));
    await r.stop();
    expect((await watchRows()).filter((x) => x.payload['entry_id'] === 'point')).toHaveLength(1);
  });

  it('a p2 entry is shed under overflow while a p0 entry keeps every input', async () => {
    const r = makeRegistry({
      ringCapacity: 8,
      entriesDir: entriesDir([
        entry('low', { priority: 'p2', on: { source: 'core', type: 'lowPoint' }, emit: { as: 'flag', severity: 'info', watch_kind: 'problem', attach: null, rate: { per_run: 1000 } } }),
        entry('high', { priority: 'p0', on: { source: 'core', type: 'highPoint' }, emit: { as: 'finding', severity: 'high', watch_kind: 'problem', attach: null, rate: { per_run: 1000 } } }),
      ]),
    });
    await r.arm();
    // Synchronous burst: nothing drains between pushes.
    for (let i = 0; i < 40; i++) {
      r.offer({ type: 'lowPoint', session: 'run-o', ord: i, attempt: 1 } as unknown as CoreEvent);
      r.offer({ type: 'highPoint', session: 'run-o', ord: i, attempt: 1 } as unknown as CoreEvent);
    }
    const shed = r.health().queue.shed_by_priority;
    expect(shed.p0).toBe(0);
    expect(shed.p2).toBeGreaterThan(0);
    await r.flush();
    const raised = (await watchRows()).filter((x) => x.event_type === WATCH_FINDING_RAISED);
    expect(raised.filter((x) => x.payload['entry_id'] === 'high')).toHaveLength(40);
    expect(raised.filter((x) => x.payload['entry_id'] === 'low').length).toBeLessThan(40);
    // The shed raised one registry-lagging flag for the episode.
    expect(raised.filter((x) => x.payload['entry_id'] === 'registry-lagging')).toHaveLength(1);
  });
});

describe('fail-safe edges', () => {
  it('a throwing shed callback never escapes push() and the ring stays capped', () => {
    const ring = new PushRing<number>(2);
    ring.onShed = () => {
      throw new Error('boom');
    };
    for (let i = 0; i < 5; i++) expect(() => ring.push(i, 'p2')).not.toThrow();
    expect(ring.depth).toBe(2);
  });

  it('the lane never rejects, even when its failure report throws; one failure is counted once', async () => {
    const { DeterministicLane } = await import('../src/watch/lanes.js');
    const lane = new DeterministicLane({
      onFailure: () => {
        throw new Error('report failed');
      },
    });
    const e = loadEntries(SHIPPED_ENTRIES_DIR, SHIPPED_CHECKS).entries[0]!;
    const state = { runId: null, seen: new Set<string>(), bag: new Map() };
    const ctx = { now: Date.now, stats: () => ({ queueDepth: 0, queueHwm: 0, shedTotal: 0, tailLagMs: 0 }) };
    await expect(lane.run(throwingCheck, e, { source: 'core', type: 't', event: {}, runId: null, at: 0 }, state, ctx)).resolves.toEqual([]);
    expect(lane.stats).toMatchObject({ failures: 1, timeouts: 0 });
  });

  it('an object-valued filter matches regardless of key order', async () => {
    const { matchesFilter } = await import('../src/watch/router.js');
    expect(matchesFilter({ x: { a: 1, b: [1, { c: 2, d: 3 }] } }, { x: { b: [1, { d: 3, c: 2 }], a: 1 } })).toBe(true);
    expect(matchesFilter({ x: { a: 1 } }, { x: { a: 1, extra: true } })).toBe(false);
    expect(matchesFilter({ 'x.y': ['p', 'q'] }, { x: { y: 'q' } })).toBe(true);
  });
});

describe('arming', () => {
  it('without a bus the registry does not arm, and health says why', async () => {
    const r = makeRegistry({ dbPath: undefined });
    await r.arm();
    expect(r.armed).toBe(false);
    const h = r.health();
    expect(h.armed).toBe(false);
    expect(h.reason).toMatch(/no event bus/);
    expect(h.entries.loaded).toBe(7);
    // Coverage of a run never reads as clean when watching is off.
    const r2 = makeRegistry({ dbPath: undefined, entriesDir: entriesDir([entry('point')]) });
    await r2.arm();
    expect(r2.coverage('run-x')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: expect.stringMatching(/^watching is off: no event bus/) }]);
  });

  it('a bus no engine holds is refused at arm (the seam never arms half-way)', async () => {
    const saved = busTesting.unattached;
    busTesting.unattached = undefined;
    try {
      const r = makeRegistry();
      await r.arm();
      expect(r.armed).toBe(false);
      expect(r.health().reason).toMatch(/no engine holds the bus/);
    } finally {
      busTesting.unattached = saved;
    }
  });
});

describe('rows, the feed and the relay', () => {
  it('raises, relays as watchEvent, folds the feed, and clears on resolve', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const r = makeRegistry({ entriesDir: entriesDir([entry('point')]), broadcast: (f) => frames.push(f as unknown as Record<string, unknown>) });
    await r.arm();
    r.offer(point('run-p', 3, 1));
    await r.flush();
    const feed = r.feed({ run: 'run-p' });
    expect(feed.findings).toHaveLength(1);
    const f = feed.findings[0]!;
    expect(f).toMatchObject({
      run_id: 'run-p',
      ord: 3,
      attempt: 1,
      by: 'watch:point@1',
      re: 'testPoint#3:1',
      watch_id: watchIdOf('run-p', 'point', 1, '3:1:testPoint'),
      entry_id: 'point',
      entry_version: 1,
      check: 'deterministic:test_point',
      kind: 'finding',
      severity: 'medium',
      watch_kind: 'problem',
      attach: null,
      project_id: 'proj-1',
      sentence: 'Point 3 attempt 1.',
      anchor: { run_id: 'run-p', ord: 3, attempt: 1 },
      model: null,
      rolled_up: 0,
    });
    // Facts are redacted before they reach the bus.
    expect(JSON.stringify(f.facts)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
    expect(feed.coverage).toEqual([{ entry_id: 'point', state: 'checked' }]);
    // The relay put the bus row on /ws, tagged with the project.
    const deadline = Date.now() + 5000;
    while (frames.length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 10));
    expect(frames[0]).toMatchObject({ type: 'watchEvent', project_id: 'proj-1', event: { event_type: WATCH_FINDING_RAISED, payload: { watch_id: f.watch_id } } });
    // A resolved condition clears the row.
    r.offer(point('run-p', 3, 1, { clear: true }));
    await r.flush();
    const after = r.feed({ run: 'run-p' });
    expect(after.cleared).toEqual([expect.objectContaining({ watch_id: f.watch_id, reason: 'resolved' })]);
    // Filters.
    expect(r.feed({ project: 'proj-1' }).findings).toHaveLength(1);
    expect(r.feed({ project: 'other' }).findings).toHaveLength(0);
    expect(r.feed({ kind: 'quiet' }).findings).toHaveLength(0);
  });

  it('rolls up past emit.rate.per_run: one live roll-up row, the previous one cleared as rolled_up', async () => {
    const r = makeRegistry({
      entriesDir: entriesDir([entry('point', { emit: { as: 'flag', severity: 'medium', watch_kind: 'problem', attach: null, rate: { per_run: 2 } } })]),
    });
    await r.arm();
    for (let i = 1; i <= 3; i++) r.offer(point('run-r', i, 1));
    await r.flush(); // roll-up #1 reaches the bus
    for (let i = 4; i <= 6; i++) r.offer(point('run-r', i, 1));
    await r.flush(); // #2 and #3 coalesce in the batch: only #3 is emitted, and it replaces #1
    const rows = await watchRows();
    const raised = rows.filter((x) => x.event_type === WATCH_FINDING_RAISED).map((x) => x.payload as unknown as WatchFinding);
    expect(raised.map((x) => x.rolled_up)).toEqual([0, 0, 1, 4]);
    const cleared = rows.filter((x) => x.event_type === WATCH_FINDING_CLEARED).map((x) => x.payload);
    expect(cleared).toEqual([expect.objectContaining({ reason: 'rolled_up', watch_id: raised[2]!.watch_id, replaced_by: raised[3]!.watch_id })]);
    expect(raised[3]!.sentence).toBe('4 more like this on this run (latest: Point 6 attempt 1.)');
    // Exactly one roll-up row is live.
    const feed = r.feed({ run: 'run-r' });
    const clearedIds = new Set((feed.cleared ?? []).map((c) => c.watch_id));
    expect(feed.findings.filter((x) => x.rolled_up > 0 && !clearedIds.has(x.watch_id)).map((x) => x.rolled_up)).toEqual([4]);
  });

  it('dismiss publishes cleared{reason:"dismissed"} once', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('point')]) });
    await r.arm();
    r.offer(point('run-d', 1, 1));
    await r.flush();
    const id = r.feed({})?.findings[0]!.watch_id;
    expect(await r.dismiss(id, 'maria')).toBe('dismissed');
    expect(await r.dismiss(id, 'maria')).toBe('already_cleared');
    expect(await r.dismiss('w-' + '0'.repeat(32), 'maria')).toBe('not_found');
    const cleared = (await watchRows()).filter((x) => x.event_type === WATCH_FINDING_CLEARED);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.payload).toMatchObject({ watch_id: id, reason: 'dismissed', dismissed_by: 'maria' });
  });

  it('a failed emit is retried at 1, 2, 4 s, then dropped, counted and audited', async () => {
    const slept: number[] = [];
    const audited: Array<Record<string, unknown>> = [];
    const saved = busTesting.unattached!;
    let failEmits = false;
    busTesting.unattached = (path) => {
      const inner = saved(path);
      return {
        busRead: (...a) => inner.busRead(...a),
        busEmit: async (json) => {
          if (failEmits) throw new Error('WB-001 engine refused');
          return inner.busEmit(json);
        },
      };
    };
    try {
      const r = makeRegistry({
        entriesDir: entriesDir([entry('point')]),
        sleep: async (ms) => {
          slept.push(ms);
        },
        auditEmitFailed: (d) => audited.push(d),
      });
      await r.arm();
      failEmits = true;
      r.offer(point('run-f', 1, 1));
      await r.flush();
      expect(slept).toEqual([1000, 2000, 4000]);
      expect(r.health().emit.failed).toBe(1);
      expect(audited).toEqual([expect.objectContaining({ event_type: WATCH_FINDING_RAISED, entry_id: 'point', error: 'WB-001 engine refused' })]);
      expect(r.feed({}).findings).toHaveLength(0); // never folded: the bus is the record
    } finally {
      busTesting.unattached = saved;
    }
  });

  it('a dropped emit does not count against the rate (no false roll-up, no clearing of a row never raised)', async () => {
    const saved = busTesting.unattached!;
    let failEmits = false;
    busTesting.unattached = (path) => {
      const inner = saved(path);
      return {
        busRead: (...a) => inner.busRead(...a),
        busEmit: async (json) => {
          if (failEmits) throw new Error('WB-001 engine refused');
          return inner.busEmit(json);
        },
      };
    };
    try {
      const r = makeRegistry({
        entriesDir: entriesDir([entry('point', { emit: { as: 'flag', severity: 'medium', watch_kind: 'problem', attach: null, rate: { per_run: 1 } } })]),
      });
      await r.arm();
      failEmits = true;
      r.offer(point('run-z', 1, 1)); // dropped after its retries
      await r.flush();
      failEmits = false;
      r.offer(point('run-z', 2, 1));
      await r.flush();
      const raised = (await watchRows()).filter((x) => x.payload['entry_id'] === 'point').map((x) => x.payload as unknown as WatchFinding);
      expect(raised.map((x) => [x.ord, x.rolled_up])).toEqual([[2, 0]]);
      // A dropped roll-up row leaves the chain where it was: the next one clears nothing that never existed.
      r.offer(point('run-z', 3, 1)); // roll-up #1 lands
      await r.flush();
      failEmits = true;
      r.offer(point('run-z', 4, 1)); // roll-up #2 (and the clearing of #1) dropped
      await r.flush();
      failEmits = false;
      r.offer(point('run-z', 5, 1)); // roll-up again: replaces #1, which is on the bus
      await r.flush();
      const rows = (await watchRows()).filter((x) => x.payload['entry_id'] === 'point');
      const ids = new Set(rows.filter((x) => x.event_type === WATCH_FINDING_RAISED).map((x) => x.payload['watch_id']));
      const cleared = rows.filter((x) => x.event_type === WATCH_FINDING_CLEARED).map((x) => x.payload);
      expect(cleared).toHaveLength(1);
      expect(ids.has(cleared[0]!['watch_id'])).toBe(true);
      expect(ids.has(cleared[0]!['replaced_by'])).toBe(true);
    } finally {
      busTesting.unattached = saved;
    }
  });

  it('facts are redacted and capped at any depth, and a cycle cannot throw', async () => {
    const { scrubFacts } = await import('../src/watch/emit.js');
    const deep: Record<string, unknown> = { a: { b: { c: { d: { e: { f: { secret: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab', long: 'x'.repeat(300) } } } } } } };
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const out = JSON.stringify(scrubFacts({ deep, cyclic }));
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
    expect(out).not.toContain('x'.repeat(201));
  });

  it('a proposal row reaches the review-queue sink once, never on a replayed row', async () => {
    const submitted: WatchFinding[] = [];
    const proposalEntry = entry('propose', { emit: { as: 'proposal', severity: 'info', watch_kind: 'decision', attach: null, rate: { per_run: 5 } } });
    const opts = { entriesDir: entriesDir([proposalEntry]), submitProposal: async (f: WatchFinding) => void submitted.push(f) };
    const r = makeRegistry(opts);
    await r.arm();
    r.offer(point('run-q', 1, 1));
    r.offer(point('run-q', 1, 1)); // a redelivery
    await r.flush();
    expect(submitted.map((f) => f.kind)).toEqual(['proposal']);
    await r.stop();
    const again = makeRegistry(opts);
    await again.arm();
    again.offer(point('run-q', 1, 1));
    await again.flush();
    expect(submitted).toHaveLength(1);
  });
});

describe('the internal entries', () => {
  it('registry-lagging: one flag per episode, cleared when caught up', async () => {
    const r = makeRegistry({
      ringCapacity: 4,
      entriesDir: entriesDir([entry('point', { priority: 'p2' })]),
    });
    await r.arm();
    for (let i = 0; i < 10; i++) r.offer(point('run-l', i, 1)); // overflow: a shed episode
    await r.flush();
    r.tick();
    r.tick();
    await r.flush();
    const rows = await watchRows();
    const lag = rows.filter((x) => x.payload['entry_id'] === 'registry-lagging');
    expect(lag.map((x) => x.event_type)).toEqual([WATCH_FINDING_RAISED, WATCH_FINDING_CLEARED]);
    expect(lag[0]!.payload).toMatchObject({ run_id: null, kind: 'flag', severity: 'info', anchor: null });
  });

  it('registry-check-failed: past 3 throws in 10 min, one run-less flag naming the entry', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('boom', { check: 'deterministic:test_throws' })]) });
    await r.arm();
    for (let i = 0; i < 5; i++) r.offer(point('run-t', i, 1));
    await r.flush();
    const flags = (await watchRows()).filter((x) => x.payload['entry_id'] === 'registry-check-failed');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.payload).toMatchObject({ run_id: null, facts: { entry_id: 'boom', failures: 3 } });
    // The failing check never emitted "fine": no row of its own.
    expect((await watchRows()).filter((x) => x.payload['entry_id'] === 'boom')).toHaveLength(0);
  });
});

describe('restart (test 7)', () => {
  it('kill mid-batch, re-arm: one row per watch_id, and a downtime event yields its finding after boot', async () => {
    const recorded: RecordedEvent[] = [
      { ...point('run-k', 1, 1), ts: 1000, seq: 1 } as unknown as RecordedEvent,
      { ...point('run-k', 2, 1), ts: 2000, seq: 2 } as unknown as RecordedEvent,
    ];
    const opts: Partial<WatchRegistryOptions> = {
      entriesDir: entriesDir([entry('point')]),
      liveRuns: async () => ['run-k'],
      runEvents: async () => recorded,
    };
    const first = makeRegistry(opts);
    await first.arm(); // the boot replay emits both recorded points
    first.offer(point('run-k', 3, 1)); // live, never flushed: the daemon dies here
    // "Kill": the registry is dropped without stop(); the unflushed row is lost with the process.
    registries.splice(registries.indexOf(first), 1);
    // While it was down, the run recorded points 3 and 4.
    recorded.push(
      { ...point('run-k', 3, 1), ts: 3000, seq: 3 } as unknown as RecordedEvent,
      { ...point('run-k', 4, 1), ts: 4000, seq: 4 } as unknown as RecordedEvent,
    );
    const second = makeRegistry(opts);
    await second.arm();
    second.offer(point('run-k', 2, 1)); // an at-least-once redelivery of an old one
    await second.flush();
    const raised = (await watchRows()).filter((x) => x.event_type === WATCH_FINDING_RAISED && x.payload['entry_id'] === 'point');
    const ids = raised.map((x) => x.payload['watch_id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(raised.map((x) => x.payload['ord']).sort()).toEqual([1, 2, 3, 4]);
    // The re-armed feed was hydrated from the bus (it knows the rows the first life emitted).
    expect(second.feed({ run: 'run-k' }).findings).toHaveLength(4);
    // A replayed row's anchor keeps the recorded event's own time.
    expect(second.feed({ run: 'run-k' }).findings.find((x) => x.ord === 4)!.anchor!.at).toBe(4000);
  });

  it('a live run whose events cannot be read marks the boot core_gap and its coverage says the daemon was down', async () => {
    const r = makeRegistry({
      entriesDir: entriesDir([entry('point')]),
      liveRuns: async () => ['run-g'],
      runEvents: async () => null,
    });
    await r.arm();
    expect(r.health().replay).toEqual({ core_gap: true });
    expect(r.coverage('run-g')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'the daemon was down' }]);
  });
});

describe('Copilot round 1', () => {
  it('registry-check-failed: a quiet window closes the episode AND clears its flag; the next burst is one new live flag', async () => {
    let now = 1_000_000;
    const r = makeRegistry({ now: () => now, entriesDir: entriesDir([entry('boom', { check: 'deterministic:test_throws' })]) });
    await r.arm();
    for (let i = 0; i < 3; i++) r.offer(point('run-t', i, 1));
    await r.flush();
    now += 11 * 60_000; // past the 10-min window
    for (let i = 3; i < 6; i++) r.offer(point('run-t', i, 1));
    await r.flush();
    const rows = (await watchRows()).filter((x) => x.payload['entry_id'] === 'registry-check-failed');
    const raised = rows.filter((x) => x.event_type === WATCH_FINDING_RAISED);
    const cleared = rows.filter((x) => x.event_type === WATCH_FINDING_CLEARED);
    expect(raised).toHaveLength(2);
    expect(cleared.map((c) => c.payload['watch_id'])).toEqual([raised[0]!.payload['watch_id']]);
  });

  it('a resolve that arrives while its raise is on its way to the bus is not lost', async () => {
    const saved = busTesting.unattached!;
    const gate: { release: (() => void) | null } = { release: null };
    let holdNext = false;
    busTesting.unattached = (path) => {
      const inner = saved(path);
      return {
        busRead: (...a) => inner.busRead(...a),
        busEmit: async (json) => {
          if (holdNext) {
            holdNext = false;
            await new Promise<void>((res) => (gate.release = res));
          }
          return inner.busEmit(json);
        },
      };
    };
    try {
      const r = makeRegistry({ entriesDir: entriesDir([entry('point')]) });
      await r.arm();
      holdNext = true;
      r.offer(point('run-i', 1, 1));
      const flushing = r.flush();
      while (gate.release === null) await new Promise((res) => setImmediate(res)); // the raise is in flight
      r.offer(point('run-i', 1, 1, { clear: true }));
      await new Promise((res) => setTimeout(res, 20)); // the registry processes the resolve
      gate.release();
      await flushing;
      await r.flush();
      const rows = (await watchRows()).filter((x) => x.payload['entry_id'] === 'point');
      expect(rows.map((x) => [x.event_type, x.payload['reason'] ?? null])).toEqual([
        [WATCH_FINDING_RAISED, null],
        [WATCH_FINDING_CLEARED, 'resolved'],
      ]);
    } finally {
      busTesting.unattached = saved;
    }
  });

  it('a clearing queued behind a raise that is then dropped is skipped (never an orphan)', async () => {
    const saved = busTesting.unattached!;
    let failRaise = false;
    busTesting.unattached = (path) => {
      const inner = saved(path);
      return {
        busRead: (...a) => inner.busRead(...a),
        busEmit: async (json) => {
          if (failRaise && (JSON.parse(json) as { event_type: string }).event_type === WATCH_FINDING_RAISED) throw new Error('WB-001 refused');
          return inner.busEmit(json);
        },
      };
    };
    try {
      const r = makeRegistry({ entriesDir: entriesDir([entry('point')]) });
      await r.arm();
      failRaise = true;
      r.offer(point('run-o', 1, 1));
      r.offer(point('run-o', 1, 1, { clear: true }));
      await r.flush();
      expect((await watchRows()).filter((x) => x.payload['entry_id'] === 'point')).toEqual([]);
    } finally {
      busTesting.unattached = saved;
    }
  });

  it('an override with a bad threshold is not half-applied: the entry keeps its shipped enabled too', async () => {
    const r = makeRegistry();
    await r.arm();
    r.applySettings({ entries: { 'registry-lagging': { enabled: false, threshold: { queue_depth: -5 } } } });
    const h = r.health();
    expect(h.entries.off).toEqual([]);
    expect(h.entries.refused).toEqual([expect.objectContaining({ id: 'registry-lagging', reason: expect.stringMatching(/threshold override ignored/) })]);
  });

  it('one unreadable run at boot does not make every other run read "the daemon was down"', async () => {
    const r = makeRegistry({
      entriesDir: entriesDir([entry('point')]),
      liveRuns: async () => ['run-bad', 'run-good'],
      runEvents: async (id) => (id === 'run-bad' ? null : []),
    });
    await r.arm();
    expect(r.health().replay).toEqual({ core_gap: true });
    expect(r.coverage('run-bad')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'the daemon was down' }]);
    expect(r.coverage('run-good')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'no test point yet' }]);
    expect(r.coverage('run-new')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'no test point yet' }]);
  });

  it('a bus row emitted after the replay read the bus, before the live pull armed, is still evaluated (no loss window)', async () => {
    const { emitOnBus } = await import('../src/core/bus.js');
    let emitted = false;
    const r = makeRegistry({
      entriesDir: entriesDir([entry('point'), entry('bus-point', { on: { source: 'bus', type: 'wicked.qe.test_point.recorded' } })]),
      liveRuns: async () => ['run-b'],
      runEvents: async () => [{ ...point('run-b', 1, 1), ts: 1, seq: 1 } as unknown as RecordedEvent],
      // Called while the replay FLUSHES its rows — after it read the bus history. The row lands then.
      projectOf: () => {
        if (!emitted) {
          emitted = true;
          void emitOnBus(busPath, {
            event_type: 'wicked.qe.test_point.recorded',
            domain: 'wicked-qe',
            subdomain: 'qe',
            producer_id: 'test',
            idempotency_key: 'tp-1',
            payload: { run_id: 'run-b', ord: 7, attempt: 1 },
          });
        }
        return undefined;
      },
    });
    await r.arm();
    const deadline = Date.now() + 3000;
    while (!r.feed({ run: 'run-b' }).findings.some((f) => f.entry_id === 'bus-point') && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 20));
      await r.flush();
    }
    expect(r.feed({ run: 'run-b' }).findings.filter((f) => f.entry_id === 'bus-point').map((f) => f.ord)).toEqual([7]);
  });
});

describe('Copilot round 2: the fold is bounded', () => {
  it('the feed keeps the newest rows up to its cap (cleared rows go first), orphan clearings capped too', async () => {
    const { WatchFeed } = await import('../src/watch/emit.js');
    const feed = new WatchFeed(3);
    const row = (id: string, at: number) => ({ watch_id: id, at, run_id: 'r', entry_id: 'e', rolled_up: 0 }) as unknown as WatchFinding;
    feed.addRaised(row('w-1', 1));
    feed.addRaised(row('w-2', 2));
    feed.addCleared({ watch_id: 'w-2', reason: 'resolved' } as never);
    feed.addRaised(row('w-3', 3));
    feed.addRaised(row('w-4', 4)); // over the cap: the oldest CLEARED row (w-2) goes first
    expect([...feed.rows.keys()]).toEqual(['w-1', 'w-3', 'w-4']);
    feed.addRaised(row('w-5', 5)); // none cleared: the oldest goes
    expect([...feed.rows.keys()]).toEqual(['w-3', 'w-4', 'w-5']);
    // Orphan clearings (a clearing whose raise is not held) are capped too.
    for (let i = 0; i < 10; i++) feed.addCleared({ watch_id: `w-x${i}`, reason: 'resolved' } as never);
    expect(feed.orphanCount).toBeLessThanOrEqual(3);
  });
});

describe('run state is bounded', () => {
  it('evicts the oldest RUN past the cap even when the run-less bucket is oldest', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('point', { emit: { as: 'flag', severity: 'info', watch_kind: 'problem', attach: null, rate: { per_run: 1 } } })]) });
    await r.arm();
    r.tick(); // the run-less bucket is created first
    await r.flush();
    for (let i = 0; i <= 600; i++) r.offer(point(`run-${i}`, 1, 1));
    await r.flush();
    expect(r.coverage('run-0')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'no test point yet' }]);
    expect(r.coverage('run-600')).toEqual([{ entry_id: 'point', state: 'checked' }]);
  });
});

describe('settings', () => {
  it('turning an entry off removes it from routing and lists it in health with who and when', async () => {
    const r = makeRegistry({ entriesDir: entriesDir([entry('point')]) });
    await r.arm();
    expect(r.validateSettingsPatch({ entries: { point: { enabled: false } } })).toBeNull();
    expect(r.validateSettingsPatch({ entries: { nope: { enabled: false } } })).toMatch(/no such entry/);
    expect(r.validateSettingsPatch({ entries: { point: { check: 'x' } } })).toMatch(/cannot be changed/);
    expect(r.validateSettingsPatch({ entries: { 'registry-lagging': { threshold: { queue_depth: 0 } } } })).toMatch(/threshold/);
    expect(r.validateSettingsPatch({ rules: [] })).toMatch(/not a setting/);
    const next = r.mergeSettings(undefined, { entries: { point: { enabled: false } } }, 'maria', 1234);
    r.applySettings(next);
    expect(r.health().entries.off).toEqual([{ id: 'point', by: 'maria', at: 1234 }]);
    r.offer(point('run-s', 1, 1));
    await r.flush();
    expect(r.feed({}).findings).toHaveLength(0);
    expect(r.coverage('run-s')).toEqual([{ entry_id: 'point', state: 'not_checked', reason: 'turned off' }]);
    const t = r.mergeSettings(next, { entries: { 'registry-lagging': { threshold: { queue_depth: 100 } } } }, 'maria', 5678);
    r.applySettings(t);
    expect(r.health().entries.thresholds_changed).toEqual([{ id: 'registry-lagging', by: 'maria', at: 5678 }]);
    expect(r.entries().find((e) => e.id === 'registry-lagging')).toMatchObject({ threshold: { queue_depth: 100, tail_lag_ms: 60000 }, threshold_text: expect.stringMatching(/^When 100 or more events are waiting/) });
  });
});
