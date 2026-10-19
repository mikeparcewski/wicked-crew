// Unit tests: gate-prompt cache + durable replay (src/api/gate-cache.ts).
//
// FINDING-051: every path into this cache was prune-only, so a daemon restart dropped the map and
// nothing could put an entry back. A run stayed parked at `awaiting_human` while the operator was
// never shown what they were being asked to approve — and the prompt had been on disk the whole
// time, in the event log core writes. These pin the read that closes that, and pin it to the SAME
// fold the live stream uses, because a second hand-written fold would only ever drift after a
// restart: the one condition nobody exercises.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GateCache } from '../src/api/gate-cache.js';
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

  it('rebuilds an open gate from the durable log after the cache is gone', () => {
    // The restart: nothing was ingested, so the map is empty — exactly the 404 state.
    const cache = new GateCache();
    expect(cache.get(RUN)).toBeUndefined();

    const entry = cache.rebuild(RUN, [
      logged('sessionStarted'),
      logged('unitDone', { ord: 1 }),
      awaitingHuman(2),
    ]);
    expect(entry).toMatchObject({ ord: 2, prompt: expect.stringContaining('Approve unit 2') });
    // Adopted, so the next read is a cache hit rather than another log replay.
    expect(cache.get(RUN)).toEqual(entry);
  });

  it('does not resurrect a gate the run already moved past', () => {
    // The whole rule: the LAST awaitingHuman not followed by a resumed/terminal event. Replaying a
    // closed gate would show an operator a question that has already been answered.
    const cache = new GateCache();
    for (const closing of ['resumed', 'sessionCompleted', 'runCancelled', 'sessionFailed']) {
      expect(cache.rebuild(RUN, [awaitingHuman(2), logged(closing, { ord: 2 })])).toBeUndefined();
      expect(cache.get(RUN)).toBeUndefined();
    }
  });

  it('serves the second gate when a run pauses, resumes, then pauses again', () => {
    const cache = new GateCache();
    const entry = cache.rebuild(RUN, [
      awaitingHuman(2),
      logged('resumed', { ord: 2 }),
      awaitingHuman(5),
    ]);
    expect(entry?.ord).toBe(5);
  });

  it('stamps a replayed gate with the event time, not the replay time', () => {
    // Studio sorts the open-gate list newest-first on `receivedAt`. Stamping a rebuild with "now"
    // would collapse every gate to the restart instant and scramble that order.
    const cache = new GateCache();
    const ts = 1_785_614_004_730;
    expect(cache.rebuild(RUN, [awaitingHuman(2, ts)])?.receivedAt).toBe(new Date(ts).toISOString());
  });

  it('reports no gate for a run whose history is empty or unknown', () => {
    // An absent history is not an error — a run that emitted nothing, or one predating the log.
    const cache = new GateCache();
    expect(cache.rebuild(RUN, [])).toBeUndefined();
    expect(cache.rebuild(RUN, [logged('unitDone', { ord: 1 })])).toBeUndefined();
  });

  it('replays only the requested run out of a mixed history', () => {
    const cache = new GateCache();
    const other: CoreEvent = { type: 'awaitingHuman', session: 'other-run', ord: 9, prompt: 'x' } as CoreEvent;
    expect(cache.rebuild(RUN, [other])).toBeUndefined();
    expect(cache.rebuild(RUN, [other, awaitingHuman(2)])?.ord).toBe(2);
  });

  it('drops a rebuilt entry once the run is no longer awaiting', () => {
    // Self-healing still applies to an adopted replay — it is a cache, not a second source of truth.
    const cache = new GateCache();
    cache.rebuild(RUN, [awaitingHuman(2)]);
    cache.reconcile([view(RUN, 'completed')]);
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('ignores a malformed gate event rather than caching a blank prompt', () => {
    // A gate with no question is worse than no gate: it renders an empty approval dialog.
    const cache = new GateCache();
    expect(cache.rebuild(RUN, [logged('awaitingHuman', { ord: 2 })])).toBeUndefined();
    expect(cache.rebuild(RUN, [logged('awaitingHuman', { prompt: 'no ord' })])).toBeUndefined();
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

  it('rebuild() from the log after a restart restores choices and recommended', () => {
    const live = new GateCache();
    live.ingest(disputeFrame(RUN));
    // The restart: a fresh cache, nothing ingested, then the log replay.
    const restarted = new GateCache();
    expect(restarted.get(RUN)).toBeUndefined();
    const entry = restarted.rebuild(RUN, [logged('sessionStarted'), logged('unitDone', { ord: 2 }), disputeFrame(RUN)]);
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
