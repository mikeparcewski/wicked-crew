// wicked-studio#284: a run the watchdog handed to a human ('needs you') showed nothing after a
// reload — the stall frames were live-only (`/ws`), never part of `GET /runs/:id/events`. The crew
// companion (L3, DES-L3 addendum PR-L3-W hand-off from L8): the watchdog remembers the frames it
// broadcast and the events route merges them, in capture order, beside the engine's own log.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RecordedEvent } from '../src/core/types.js';
import { StallFrameIndex, stallFrameAction, type RecordedStallFrame } from '../src/api/stall-frame-index.js';
import type { AuditEntry } from '../src/core/types.js';

const RUN = 'r-needs-you';
const ENGINE: RecordedEvent[] = [
  { type: 'sessionStarted', session: RUN, ts: 1_000, seq: 1 } as unknown as RecordedEvent,
  { type: 'unitDispatched', session: RUN, ord: 1, attempt: 0, ts: 2_000, seq: 2 } as unknown as RecordedEvent,
];
const STALLED: RecordedStallFrame = { type: 'workerStalled', session: RUN, ord: 1, quietForMs: 900_000, ts: 1_500, daemon: true };
const ESCALATED: RecordedStallFrame = {
  type: 'workerStallEscalated', session: RUN, ord: 1, quietForMs: 1_800_000, action: 'notify', outcome: 'ok', needsYou: true, ts: 2_500, daemon: true,
} as RecordedStallFrame;

function buildApp(frames: readonly RecordedStallFrame[] | undefined): FastifyInstance {
  const adapter = {
    sessions: vi.fn(async () => [RUN]),
    sessionsDetail: vi.fn(async () => []),
    runEvents: vi.fn(async () => ENGINE),
    listRepos: vi.fn(async () => []),
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  const runtime: Partial<RuntimeDeps> = frames === undefined ? {} : { stallFrames: () => frames };
  registerRoutes(
    app,
    adapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  return app;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe('GET /runs/:id/events merges the remembered watchdog frames (wicked-studio#284)', () => {
  it('interleaves the daemon frames by capture time beside the engine events, marked daemon:true, and counts them in total/returned', async () => {
    const app = buildApp([STALLED, ESCALATED]);
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; returned: number; events: Array<Record<string, unknown>> };
    expect(body.events.map((e) => e['type'])).toEqual(['sessionStarted', 'workerStalled', 'unitDispatched', 'workerStallEscalated']);
    expect(body.total).toBe(4);
    expect(body.returned).toBe(4);
    expect(body.events[1]).toMatchObject({ daemon: true, quietForMs: 900_000 });
    expect(body.events[3]).toMatchObject({ daemon: true, needsYou: true, action: 'notify' });
    // `RecordedEvent.seq` is REQUIRED by the wire contract and a daemon frame has none of its own,
    // so each rides the seq of the engine record it follows — the served array stays monotonic
    // non-decreasing and a consumer that re-sorts by seq keeps each frame where it was captured.
    expect(body.events.map((e) => e['seq'])).toEqual([1, 1, 2, 2]);
  });

  it('a daemon frame captured BEFORE any engine record still carries a seq (0), never an absent one', async () => {
    const early: RecordedStallFrame = { ...STALLED, ts: 10 };
    const app = buildApp([early]);
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
    const body = res.json() as { events: Array<Record<string, unknown>> };
    expect(body.events.map((e) => e['type'])).toEqual(['workerStalled', 'sessionStarted', 'unitDispatched']);
    expect(body.events[0]).toMatchObject({ seq: 0, daemon: true });
  });

  it('the ?type filter reaches the daemon frames too', async () => {
    const app = buildApp([STALLED, ESCALATED]);
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events?type=workerStallEscalated` });
    const body = res.json() as { total: number; returned: number; events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: 'workerStallEscalated', needsYou: true });
    expect(body.total).toBe(4);
    expect(body.returned).toBe(1);
  });

  it('with no remembered frames — or no watchdog wired — the route serves the engine log unchanged', async () => {
    for (const frames of [[] as RecordedStallFrame[], undefined]) {
      const app = buildApp(frames);
      apps.push(app);
      const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
      const body = res.json() as { total: number; events: Array<Record<string, unknown>> };
      expect(body.events.map((e) => e['type'])).toEqual(['sessionStarted', 'unitDispatched']);
      expect(body.total).toBe(2);
    }
  });
});

// The half wicked-studio#284 is actually about: the run has ENDED (so the watchdog pruned its
// state) and the daemon has RESTARTED (so its memory is gone) — which is exactly when a human opens
// the run page to find out what happened. The frames come back from the audit trail, through the
// index the events route reads; nothing is re-emitted to get them there.
describe('the remembered frames survive the run ending and the daemon restarting', () => {
  /** An audit line as the daemon's recorder writes it: the frame minus `type` and `session`. */
  function line(frame: RecordedStallFrame): AuditEntry {
    const { type, session, ts, daemon, ...detail } = frame;
    void type;
    void daemon;
    return {
      ts,
      action: stallFrameAction(frame),
      actor: { id: 'stall-watchdog', kind: 'system', trust: 'admin' },
      runId: session,
      detail,
    } as AuditEntry;
  }

  it('a NEW index hydrated from the trail serves the same frames the live daemon did', async () => {
    // What the previous daemon wrote, answered newest-first the way `readAll` answers.
    const trail = [line(ESCALATED), line(STALLED)];
    const rebuilt = new StallFrameIndex();
    rebuilt.hydrateFromEntries(trail);

    const app = buildApp(rebuilt.framesFor(RUN));
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
    const body = res.json() as { total: number; events: Array<Record<string, unknown>> };

    expect(body.events.map((e) => e['type'])).toEqual([
      'sessionStarted',
      'workerStalled',
      'unitDispatched',
      'workerStallEscalated',
    ]);
    expect(body.events[1]).toMatchObject({ daemon: true, quietForMs: 900_000, ord: 1, seq: 1 });
    expect(body.events[3]).toMatchObject({ daemon: true, needsYou: true, action: 'notify', seq: 2 });
    expect(body.total).toBe(4);
  });

  it('a trail with no stall lines leaves the route serving the engine log unchanged', async () => {
    const rebuilt = new StallFrameIndex();
    rebuilt.hydrateFromEntries([
      { ts: 1, action: 'run.launched', actor: { id: 'daemon', kind: 'system', trust: 'admin' }, runId: RUN, detail: {} } as AuditEntry,
    ]);
    const app = buildApp(rebuilt.framesFor(RUN));
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/events` });
    const body = res.json() as { total: number; events: Array<Record<string, unknown>> };
    expect(body.events.map((e) => e['type'])).toEqual(['sessionStarted', 'unitDispatched']);
    expect(body.total).toBe(2);
  });
});
