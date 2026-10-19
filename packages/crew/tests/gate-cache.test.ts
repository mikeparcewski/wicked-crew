// Unit tests: gate-prompt cache + durable replay (src/api/gate-cache.ts).
//
// FINDING-051: every path into this cache was prune-only, so a daemon restart dropped the map and
// nothing could put an entry back. A run stayed parked at `awaiting_human` while the operator was
// never shown what they were being asked to approve — and the prompt had been on disk the whole
// time, in the event log core writes. These pin the read that closes that, and pin it to the SAME
// fold the live stream uses, because a second hand-written fold would only ever drift after a
// restart: the one condition nobody exercises.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateCache, replayOpenGate, type GateCacheEntry, type GateRead } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, SessionView } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const RUN = 'verify-022-155143';

/** A log entry as `runEvents` returns it: the `/ws` frame plus a capture-time `ts` and a `seq`. */
function logged(type: string, extra: Record<string, unknown> = {}, ts = 1_785_614_004_730): CoreEvent {
  return { type, session: RUN, ts, ...extra } as CoreEvent;
}

/** The real gate that was live when FINDING-051 was found. */
function awaitingHuman(ord = 2, ts?: number): CoreEvent {
  return logged(
    'awaitingHuman',
    { ord, reviewingOrd: null, prompt: `Approve unit ${ord} before it runs: design` },
    ts,
  );
}

/** A `sessionsDetail()` view, reduced to the one field `reconcile` reads. */
function view(id: string, status: string): SessionView {
  return { session: { id, status }, units: [] } as unknown as SessionView;
}

describe('GateCache', () => {
  it('serves a gate the live stream delivered', () => {
    const cache = new GateCache();
    cache.ingest(awaitingHuman());
    expect(cache.get(RUN)).toMatchObject({ ord: 2, lifecycle: 'open' });
  });

  it('rebuilds an open gate from the durable log after the cache is gone', async () => {
    // The restart: nothing was ingested, so the map is empty — exactly the 404 state.
    const cache = new GateCache();
    expect(cache.get(RUN)).toBeUndefined();

    const entry = await cache.resolve(RUN, async () => replayOpenGate(RUN, [
      logged('sessionStarted'),
      logged('unitDone', { ord: 1 }),
      awaitingHuman(2),
    ]) ?? null);
    expect(entry).toMatchObject({ ord: 2, prompt: expect.stringContaining('Approve unit 2') });
    // Adopted, so the next read is a cache hit rather than another log replay.
    expect(cache.get(RUN)).toEqual(entry);
  });

  it('does not resurrect a gate the run already moved past', () => {
    // The whole rule: the LAST awaitingHuman not followed by a resumed/terminal event. Replaying a
    // closed gate would show an operator a question that has already been answered.
    for (const closing of ['resumed', 'sessionCompleted', 'runCancelled', 'sessionFailed']) {
      expect(replayOpenGate(RUN, [awaitingHuman(2), logged(closing, { ord: 2 })])).toBeUndefined();
    }
  });

  it('serves the second gate when a run pauses, resumes, then pauses again', () => {
    const entry = replayOpenGate(RUN, [
      awaitingHuman(2),
      logged('resumed', { ord: 2 }),
      awaitingHuman(5),
    ]);
    expect(entry?.ord).toBe(5);
  });

  it('stamps a replayed gate with the event time, not the replay time', () => {
    // Studio sorts the open-gate list newest-first on `receivedAt`. Stamping a rebuild with "now"
    // would collapse every gate to the restart instant and scramble that order.
    const ts = 1_785_614_004_730;
    expect(replayOpenGate(RUN, [awaitingHuman(2, ts)])?.receivedAt).toBe(new Date(ts).toISOString());
  });

  it('reports no gate for a run whose history is empty or unknown', () => {
    // An absent history is not an error — a run that emitted nothing, or one predating the log.
    expect(replayOpenGate(RUN, [])).toBeUndefined();
    expect(replayOpenGate(RUN, [logged('unitDone', { ord: 1 })])).toBeUndefined();
  });

  it('replays only the requested run out of a mixed history', () => {
    const other: CoreEvent = { type: 'awaitingHuman', session: 'other-run', ord: 9, prompt: 'x' } as CoreEvent;
    expect(replayOpenGate(RUN, [other])).toBeUndefined();
    expect(replayOpenGate(RUN, [other, awaitingHuman(2)])?.ord).toBe(2);
  });

  it('drops a rebuilt entry once the run is no longer awaiting', async () => {
    // Self-healing still applies to an adopted replay — it is a cache, not a second source of truth.
    const cache = new GateCache();
    await cache.resolve(RUN, async () => replayOpenGate(RUN, [awaitingHuman(2)]) ?? null);
    cache.reconcile([view(RUN, 'completed')]);
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('ignores a malformed gate event rather than caching a blank prompt', () => {
    // A gate with no question is worse than no gate: it renders an empty approval dialog.
    expect(replayOpenGate(RUN, [logged('awaitingHuman', { ord: 2 })])).toBeUndefined();
    expect(replayOpenGate(RUN, [logged('awaitingHuman', { prompt: 'no ord' })])).toBeUndefined();
  });
});

// Issue #969: the opening `awaitingHuman` frame carries the answers the engine offered (`choices`)
// and its pick among them (`recommended`). The gate read dropped both, so a client that missed the
// live frame drew a team_dispute gate as Approve/Reject only.
const DISPUTE = ['approve', 'request_changes', 'reject'];

function disputeFrame(session: string, extra: Record<string, unknown> = {}, ts = 1_785_614_004_730): CoreEvent {
  return {
    type: 'awaitingHuman', session, ts, ord: 3, prompt: 'The team disagrees on unit 3.', gateKind: 'team_dispute',
    choices: DISPUTE, recommended: 1, ...extra,
  } as unknown as CoreEvent;
}

describe('GateCache: offered choices (issue #969)', () => {
  it('keeps a well-formed choices + recommended from the live frame', () => {
    const cache = new GateCache();
    cache.ingest(disputeFrame(RUN));
    expect(cache.get(RUN)).toMatchObject({ ord: 3, gateKind: 'team_dispute', choices: DISPUTE, recommended: 1 });
  });

  it('a frame without them yields an entry with neither key', () => {
    const cache = new GateCache();
    cache.ingest(awaitingHuman());
    const entry = cache.get(RUN);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('choices');
    expect(entry).not.toHaveProperty('recommended');
  });

  it.each([
    ['a non-array', { choices: 'approve' }],
    ['an empty array', { choices: [] }],
    ['non-string elements', { choices: ['approve', 2, 'reject'] }],
  ])('drops choices that are %s (and the recommended that indexes them)', (_label, extra) => {
    const cache = new GateCache();
    cache.ingest(disputeFrame(RUN, extra));
    expect(cache.get(RUN)).not.toHaveProperty('choices');
    expect(cache.get(RUN)).not.toHaveProperty('recommended');
  });

  it.each([
    ['out of range', 3],
    ['negative', -1],
    ['not an integer', 1.5],
    ['not a number', '1'],
  ])('drops a recommended that is %s but keeps the choices', (_label, recommended) => {
    const cache = new GateCache();
    cache.ingest(disputeFrame(RUN, { recommended }));
    expect(cache.get(RUN)).toMatchObject({ choices: DISPUTE });
    expect(cache.get(RUN)).not.toHaveProperty('recommended');
  });

  it('a log replay after a restart restores choices and recommended', async () => {
    const live = new GateCache();
    live.ingest(disputeFrame(RUN));
    // The restart: a fresh cache, nothing ingested, then the log replay.
    const restarted = new GateCache();
    expect(restarted.get(RUN)).toBeUndefined();
    const entry = await restarted.resolve(RUN, async () => replayOpenGate(RUN, [logged('sessionStarted'), logged('unitDone', { ord: 2 }), disputeFrame(RUN)]) ?? null);
    expect(entry).toMatchObject({ choices: DISPUTE, recommended: 1 });
    expect(entry).toEqual(live.get(RUN));
  });
});

function awaitingView(id: string): SessionView {
  return {
    session: {
      id, workflow_id: 'wf-x', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['pi'], status: 'awaiting_human', human_confirm: 'all', unit_ix: 3, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

describe('GET /runs/:id/gate serves the offered choices (issue #969)', () => {
  let app: FastifyInstance;
  const gateCache = new GateCache();
  const durableRow = { kind: 'gate', ord: 3, prompt: 'The team disagrees on unit 3.', gate_kind: 'team_dispute', created_at: 1_785_614_004_730 };

  beforeAll(async () => {
    gateCache.ingest(disputeFrame('run-live'));
    gateCache.ingest(disputeFrame('run-plain', { choices: undefined, recommended: undefined }));
    const ids = ['run-live', 'run-plain', 'run-durable', 'run-durable-nolog', 'run-durable-throws', 'run-durable-other-ord'];
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue(ids.map(awaitingView)),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => (id.startsWith('run-durable') ? [durableRow] : [])),
      runEvents: vi.fn(async (id: string) => {
        if (id === 'run-durable-nolog') return null;
        if (id === 'run-durable-throws') throw new Error('binding failed');
        if (id === 'run-durable-other-ord') return [disputeFrame(id, { ord: 2 })];
        if (id === 'run-durable') {
          // An older gate on the same ord offered different answers; the NEWEST one is served.
          return [
            disputeFrame(id, { choices: ['approve', 'reject'], recommended: 0 }, 1),
            { type: 'resumed', session: id, ts: 2 },
            disputeFrame(id, {}, 3),
          ];
        }
        return [];
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  it('the live frame\'s choices and recommended are on the body', async () => {
    const { status, body } = await gate('run-live');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ord: 3, gateKind: 'team_dispute', choices: DISPUTE, recommended: 1 });
  });

  it('a frame without them serves a body with neither key', async () => {
    const { status, body } = await gate('run-plain');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ord: 3, gateKind: 'team_dispute' });
    expect(body).not.toHaveProperty('choices');
    expect(body).not.toHaveProperty('recommended');
  });

  it('a gate served from the durable row takes them from the log\'s newest matching-ord awaitingHuman', async () => {
    const { status, body } = await gate('run-durable');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ord: 3, gateKind: 'team_dispute', choices: DISPUTE, recommended: 1 });
  });

  it.each(['run-durable-nolog', 'run-durable-throws', 'run-durable-other-ord'])(
    'a durable-row gate whose log has no readable matching frame (%s) is still 200 with gateKind, without them',
    async (id) => {
      const { status, body } = await gate(id);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ord: 3, gateKind: 'team_dispute' });
      expect(body).not.toHaveProperty('choices');
      expect(body).not.toHaveProperty('recommended');
    },
  );
});

// crew#1083 review (codex, two rounds): `resolveOpenGate` awaits the durable row and then the log
// before adopting. A live gate event for the run can land in that window, and NEITHER side is then
// known to be the newer: the record may have moved on since the read began (ord 3 answered and ord 4
// opened while an ord-3 row was being read), or the engine's pump may have delivered an OLDER frame
// late (an `awaitingHuman` for ord 3, or its `resumed`, after the row already shows ord 4). Round 1
// let the live side win: it served the late ord-3 frame over the current ord-4 row, let a POST
// naming ord 3 pass the gate check and answer ord 4, and read a late `resumed` as no gate at all.
// Now no winner is picked. The read is run again, and only a read nothing overlapped is adopted.
describe('GateCache.resolve: a read a live gate event overlapped is run again, never adopted (crew#1083 review)', () => {
  /** What a read of the record finds — distinguishable from any ingested frame's entry by `receivedAt`. */
  const gate = (ord: number): GateCacheEntry => ({ ord, prompt: `Gate before unit ${ord}.`, lifecycle: 'open', receivedAt: '2026-10-18T00:00:00.000Z' });
  /** A read that ingests `landing` into `cache` while its FIRST call is in flight; call n yields `results[n]` (the last one repeats). */
  function reading(cache: GateCache, landing: CoreEvent[], ...results: GateRead[]) {
    let calls = 0;
    return vi.fn(async (): Promise<GateRead> => {
      const call = calls++;
      if (call === 0) for (const event of landing) cache.ingest(event);
      return results[Math.min(call, results.length - 1)]!;
    });
  }

  it('a read nothing overlapped is adopted and returned', async () => {
    const cache = new GateCache();
    const read = reading(cache, [], gate(4));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(cache.get(RUN)).toEqual(gate(4));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a cached gate is served without a read', async () => {
    const cache = new GateCache();
    cache.adopt(RUN, gate(4));
    const read = reading(cache, [], gate(9));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(read).not.toHaveBeenCalled();
  });

  it('a late OLDER awaitingHuman during the read: the read is run again and its ord 4 is adopted, not the frame\'s ord 3', async () => {
    const cache = new GateCache();
    const read = reading(cache, [awaitingHuman(3)], gate(4));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(cache.get(RUN)).toEqual(gate(4));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a late resumed during the read does not turn a real ord-4 gate into "no gate"', async () => {
    const cache = new GateCache();
    const read = reading(cache, [logged('resumed', { ord: 3 })], gate(4));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(cache.get(RUN)).toEqual(gate(4));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a NEWER gate opening during the read of an older row: the re-read sees the row the engine wrote with it', async () => {
    // The engine answered ord 3 and paused at ord 4: it wrote the ord-4 row, then emitted both frames.
    const cache = new GateCache();
    const read = reading(cache, [logged('resumed', { ord: 3 }), awaitingHuman(4)], gate(3), gate(4));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(cache.get(RUN)).toEqual(gate(4));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('an overlapped "no open gate" or "no log" read is run again too', async () => {
    // A read that found nothing while the gate moved is as suspect as one that found a gate.
    for (const first of [null, 'no-log'] as const) {
      const cache = new GateCache();
      const read = reading(cache, [logged('resumed', { ord: 3 })], first, gate(4));
      expect(await cache.resolve(RUN, read)).toEqual(gate(4));
      expect(read).toHaveBeenCalledTimes(2);
    }
  });

  it('a clean "no open gate" is null and a clean "no log" is no-log; neither is adopted', async () => {
    const cache = new GateCache();
    expect(await cache.resolve(RUN, reading(cache, [], null))).toBeNull();
    expect(await cache.resolve(RUN, reading(cache, [], 'no-log'))).toBe('no-log');
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('another run\'s gate events do not disturb the read', async () => {
    const cache = new GateCache();
    const other = { type: 'awaitingHuman', session: 'other-run', ord: 9, prompt: 'x' } as CoreEvent;
    const read = reading(cache, [other], gate(4));
    expect(await cache.resolve(RUN, read)).toEqual(gate(4));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a clean "no open gate" after an overlapped read EVICTS what the late frame folded (agy, round 3)', async () => {
    // Attempt one is overlapped by a late awaitingHuman(3), which `ingest` folds into the cache;
    // attempt two reads cleanly and finds gate 3 already answered. Round 2 returned null and left
    // ord 3 in the cache, where every later resolve() served it as a hit, unread.
    for (const clean of [null, 'no-log'] as const) {
      const cache = new GateCache();
      const read = reading(cache, [awaitingHuman(3)], gate(3), clean);
      expect(await cache.resolve(RUN, read)).toBe(clean);
      expect(cache.get(RUN)).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(2);
      // Not a cache hit now: the next resolve reads again.
      expect(await cache.resolve(RUN, read)).toBe(clean);
      expect(read).toHaveBeenCalledTimes(3);
    }
  });

  it('a read that throws after an overlap evicts what the late frame folded; the error propagates', async () => {
    const cache = new GateCache();
    const read = vi.fn(async (): Promise<GateRead> => {
      cache.ingest(awaitingHuman(3));
      throw new Error('binding failed');
    });
    await expect(cache.resolve(RUN, read)).rejects.toThrow('binding failed');
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('an ordered backlog, one frame per read, exhausts the reads: "unstable", the unverified entry evicted, logged once (codex, round 3)', async () => {
    // awaitingHuman(2), resumed(2), awaitingHuman(3) are pumped late, one during each read, while
    // every read finds ord 4 open. Round 2 served the cache's ord 3 here, unverified, and a
    // decision naming ord 3 then answered ord 4.
    const warn = vi.fn();
    const cache = new GateCache({ warn });
    const backlog = [awaitingHuman(2), logged('resumed', { ord: 2 }), awaitingHuman(3)];
    const read = vi.fn(async (): Promise<GateRead> => {
      cache.ingest(backlog.shift()!);
      return gate(4);
    });
    expect(await cache.resolve(RUN, read)).toBe('unstable');
    expect(cache.get(RUN)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(RUN);
    // Quiet again: the next resolve reads, and the record's ord 4 is adopted.
    expect(await cache.resolve(RUN, reading(cache, [], gate(4)))).toEqual(gate(4));
  });
});

describe('resolveOpenGate: neither a stale row nor a late frame wins a race (crew#1083 review)', () => {
  let app: FastifyInstance;
  const warn = vi.fn();
  const gateCache = new GateCache({ warn });
  /** The engine's open-gate row per run, by ord. A test moves it exactly when the engine would. */
  const rows = new Map<string, number>([
    ['late-frame-get', 4], ['late-frame-post', 4], ['late-resumed', 4], ['stale-row-get', 3], ['stale-row-post', 3], ['backlog-get', 4],
  ]);
  /** Every run the routes know; `evict-then-move` starts with NO open row (its gate 3 was answered). */
  const runs = [...rows.keys(), 'evict-then-move'];
  /** Runs whose FIRST log read is held until the test releases it. */
  const parkFirst = new Set(['late-frame-get', 'late-resumed', 'stale-row-get']);
  const pending = new Map<string, () => void>();
  /** Frames the engine's pump delivers late — one lands during each log read of that run. */
  const landings = new Map<string, CoreEvent[]>();
  const confirmCalls: unknown[][] = [];
  const interactionRequests = vi.fn(async (id: string) => {
    const ord = rows.get(id);
    return ord === undefined ? [] : [{ kind: 'gate', ord, prompt: `Gate before unit ${ord}.`, gate_kind: 'team_dispute', created_at: 1_785_614_004_730 }];
  });
  /** The run's log: ord 3 offered approve/reject and was answered; ord 4 offers the dispute set. */
  const log = (id: string): CoreEvent[] => [
    disputeFrame(id, { ord: 3, choices: ['approve', 'reject'], recommended: 0 }, 1),
    { type: 'resumed', session: id, ord: 3, ts: 2 } as unknown as CoreEvent,
    ...(id === 'evict-then-move' ? [] : [disputeFrame(id, { ord: 4 }, 3)]),
  ];
  // A late frame, if the pump has one for this run, lands during the read. For the parked runs the
  // FIRST log read is held until the test releases it; later reads answer at once.
  const runEvents = vi.fn((id: string) => {
    const late = landings.get(id)?.shift();
    if (late !== undefined) gateCache.ingest(late);
    return new Promise<CoreEvent[]>((resolve) => {
      if (!parkFirst.has(id) || pending.has(id)) resolve(log(id));
      else pending.set(id, () => resolve(log(id)));
    });
  });
  /** The ord-3 frame, delivered by the engine's pump after its row already showed ord 4 open. */
  const lateFrame3 = (id: string): CoreEvent =>
    ({ type: 'awaitingHuman', session: id, ord: 3, prompt: 'Gate before unit 3.', gateKind: 'team_dispute', choices: ['approve', 'reject'], recommended: 0 }) as unknown as CoreEvent;
  /** The engine answers ord 3 and pauses at ord 4: it writes the ord-4 row, then emits. */
  const engineMovesOn = (id: string) => () => {
    rows.set(id, 4);
    gateCache.ingest({ type: 'resumed', session: id, ord: 3 } as unknown as CoreEvent);
    gateCache.ingest({ type: 'awaitingHuman', session: id, ord: 4, prompt: 'Gate before unit 4.', gateKind: 'team_dispute' } as unknown as CoreEvent);
  };

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue(runs.map(awaitingView)),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests,
      runEvents,
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
  });

  /** Run `land` while the run's first log read is parked, then release that read. */
  async function whileFirstReadIsParked(id: string, land: () => void): Promise<void> {
    await vi.waitFor(() => expect(pending.has(id)).toBe(true));
    land();
    pending.get(id)!();
  }
  const rowReads = (id: string) => interactionRequests.mock.calls.filter(([run]) => run === id).length;
  const logReads = (id: string) => runEvents.mock.calls.filter(([run]) => run === id).length;

  it('a late ord-3 awaitingHuman during the read of the ord-4 row: GET serves ord 4, from a second read', async () => {
    const id = 'late-frame-get';
    const res = app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    await whileFirstReadIsParked(id, () => gateCache.ingest(lateFrame3(id)));
    const done = await res;
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ord: 4, gateKind: 'team_dispute', choices: DISPUTE, recommended: 1 });
    expect(rowReads(id)).toBe(2);
    expect(gateCache.get(id)?.ord).toBe(4);
  });

  it('… and a POST naming ord 3 answers to the RECORD, not to the late frame the cache holds: 409, nothing confirmed, no log read', async () => {
    const id = 'late-frame-post';
    gateCache.ingest(lateFrame3(id)); // the cache holds the late ord-3 frame; the record shows ord 4
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: 3 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
    expect(confirmCalls).toEqual([]);
    // A named decision is authorized by the row alone: one row read, no cache or log resolution.
    expect(rowReads(id)).toBe(1);
    expect(logReads(id)).toBe(0);
  });

  it('a late resumed(3) during the read of the ord-4 row: ord 4 is still served, not a false 404', async () => {
    const id = 'late-resumed';
    const res = app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    await whileFirstReadIsParked(id, () => gateCache.ingest({ type: 'resumed', session: id, ord: 3 } as unknown as CoreEvent));
    const done = await res;
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ord: 4, choices: DISPUTE, recommended: 1 });
    expect(rowReads(id)).toBe(2);
  });

  it('round 1: ord 4 opens while the ord-3 row is being read — GET serves ord 4, from the re-read row', async () => {
    const id = 'stale-row-get';
    const res = app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    await whileFirstReadIsParked(id, engineMovesOn(id));
    const done = await res;
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ord: 4, gateKind: 'team_dispute', choices: DISPUTE, recommended: 1 });
    expect(rowReads(id)).toBe(2);
    expect(gateCache.get(id)?.ord).toBe(4);
  });

  it('round 1: … and once the engine has moved the row to ord 4, a POST naming the stale ord 3 is refused and ord 4 is confirmed', async () => {
    const id = 'stale-row-post';
    engineMovesOn(id)(); // the row is ord 4; the live frames fold ord 4 into the cache
    const stale = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: 3 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
    expect(confirmCalls).toEqual([]);
    const real = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: 4 } });
    expect(real.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(logReads(id)).toBe(0);
  });

  it('an ordered backlog landing one frame per read: GET is a retryable 503 gate_unstable, nothing is served from the cache (codex, round 3)', async () => {
    const id = 'backlog-get';
    landings.set(id, [
      { type: 'awaitingHuman', session: id, ord: 2, prompt: 'Gate before unit 2.' } as unknown as CoreEvent,
      { type: 'resumed', session: id, ord: 2 } as unknown as CoreEvent,
      { type: 'awaitingHuman', session: id, ord: 3, prompt: 'Gate before unit 3.' } as unknown as CoreEvent,
    ]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'gate_unstable' });
    expect(rowReads(id)).toBe(3);
    expect(gateCache.get(id)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(id);
    // Quiet again: the next GET reads and serves the record's ord 4.
    const again = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ord: 4, choices: DISPUTE, recommended: 1 });
  });

  it('a late frame for an answered gate is evicted by the clean read that finds no gate; when ord 4 then opens, ord 3 cannot answer it (agy, round 3)', async () => {
    const id = 'evict-then-move';
    // The pump delivers awaitingHuman(3) during the first log read; the record shows gate 3 answered and nothing open.
    landings.set(id, [{ type: 'awaitingHuman', session: id, ord: 3, prompt: 'Gate before unit 3.' } as unknown as CoreEvent]);
    const first = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    expect(first.statusCode).toBe(404);
    expect(gateCache.get(id)).toBeUndefined();
    expect(rowReads(id)).toBe(2);
    // Not served from the cache now: another GET reads again, and still finds no gate.
    expect((await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` })).statusCode).toBe(404);
    expect(rowReads(id)).toBe(3);
    // The run pauses at ord 4 before awaitingHuman(4) is pumped: a decision naming ord 3 is refused by the record.
    rows.set(id, 4);
    const stale = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: 3 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
    expect(confirmCalls).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` })).json()).toMatchObject({ ord: 4 });
  });

});
