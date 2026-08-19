// crew#287 — the worker stall watchdog: detection-only liveness for executing runs.
//
// Unit half: a fake run and a stubbed clock drive `WorkerStallWatchdog` directly — the threshold
// crossing emits EXACTLY ONE `workerStalled` frame per quiet period, any new event re-arms, and
// a second quiet period emits a second frame (the issue's three named cases), plus the pruning /
// seeding / threshold-resolution edges. Integration half: the real server (createServer →
// fastify-websocket → broadcast) proves the synthetic frame reaches a /ws client and that a
// relayed engine event re-arms the live watchdog.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  WorkerStallWatchdog,
  type ExecutingRun,
  type WorkerStalledFrame,
} from '../src/api/stall-watchdog.js';
import { DEFAULT_WORKER_STALL_MINUTES } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, SessionView, CrewSystemSettings } from '../src/core/types.js';

const MIN = 60_000;

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

/** A watchdog over a fake run list, a hand-cranked clock, and a captured frame sink. */
function build(opts?: {
  runs?: ExecutingRun[];
  stallMinutes?: () => number | undefined;
  listExecuting?: () => Promise<ExecutingRun[]>;
}): {
  wd: WorkerStallWatchdog;
  frames: WorkerStalledFrame[];
  logs: string[];
  tick: (ms: number) => void;
} {
  let nowMs = Date.parse('2026-08-19T10:00:00Z');
  const frames: WorkerStalledFrame[] = [];
  const logs: string[] = [];
  const runs = opts?.runs ?? [{ id: 'r-stall', ord: 3 }];
  const wd = new WorkerStallWatchdog({
    listExecuting: opts?.listExecuting ?? (async () => runs),
    broadcast: (f) => frames.push(f),
    ...(opts?.stallMinutes !== undefined ? { stallMinutes: opts.stallMinutes } : {}),
    now: () => nowMs,
    log: (m) => logs.push(m),
  });
  return { wd, frames, logs, tick: (ms) => (nowMs += ms) };
}

describe('WorkerStallWatchdog (crew#287) — fake run, stubbed clock', () => {
  it('crossing the threshold emits EXACTLY ONE workerStalled frame, repeated sweeps stay silent', async () => {
    const { wd, frames, logs, tick } = build();
    // Proof of life at t0: any event for the run stamps its clock.
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 3, attempt: 0, text: 'x' }));

    tick(14 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]); // under the 15-min default — quiet but not stalled

    tick(2 * MIN); // 16 min quiet in total
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-stall', ord: 3, quietForMs: 16 * MIN },
    ]);
    expect(logs.some((m) => m.includes('workerStalled') && m.includes('r-stall'))).toBe(true);

    // Once per quiet period: more sweeps deeper into the SAME silence add nothing.
    tick(30 * MIN);
    await wd.sweep();
    await wd.sweep();
    expect(frames).toHaveLength(1);
  });

  it('a new event re-arms, and a second quiet period emits a second frame', async () => {
    const { wd, frames, tick } = build();
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 3, text: 'a' }));
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toHaveLength(1);

    // The worker wakes up: ANY event for the run is proof of life and re-arms the alert.
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 4, text: 'b' }));
    tick(5 * MIN);
    await wd.sweep();
    expect(frames).toHaveLength(1); // fresh clock — 5 min quiet is not a stall

    tick(11 * MIN); // second quiet period: 16 min since the wake-up delta
    await wd.sweep();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      type: 'workerStalled',
      session: 'r-stall',
      ord: 4, // the re-arming event's ord, not the stale one
      quietForMs: 16 * MIN,
    });
  });

  it('any event type counts as liveness — a gate frame resets the clock like a delta does', async () => {
    const { wd, frames, tick } = build();
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 3, text: 'x' }));
    tick(14 * MIN);
    wd.ingest(ev({ type: 'gateRequested', session: 'r-stall', ord: 3, prompt: 'ok?' }));
    tick(14 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]); // 14 min since the LAST event — never 28
  });

  it('a run the relay has never seen gets its clock seeded at first sweep and trips one period later', async () => {
    // The restart case: the run was executing (and possibly already wedged) before this daemon
    // booted, so zero events will ever arrive. Silence before the relay existed is unknowable —
    // the quiet clock starts at first observation and the threshold still trips a period later.
    const { wd, frames, tick } = build({ runs: [{ id: 'r-preboot', ord: 1 }] });
    await wd.sweep(); // seeds, no frame
    expect(frames).toEqual([]);
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-preboot', ord: 1, quietForMs: 16 * MIN },
    ]);
  });

  it('omits ord when neither an event nor the run header named one', async () => {
    const { wd, frames, tick } = build({ runs: [{ id: 'r-noord' }] });
    wd.ingest(ev({ type: 'sessionStarted', session: 'r-noord', problem: 'p' })); // no ord field
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([{ type: 'workerStalled', session: 'r-noord', quietForMs: 16 * MIN }]);
    expect(Object.keys(frames[0] ?? {})).not.toContain('ord');
  });

  it('a run that leaves the executing state is pruned — silence after completion is not a stall', async () => {
    let executing: ExecutingRun[] = [{ id: 'r-done', ord: 2 }];
    const { wd, frames, tick } = build({ listExecuting: async () => executing });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-done', ord: 2, text: 'x' }));
    executing = []; // completed / cancelled / awaiting_human before the next sweep
    tick(60 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]);

    // Back to executing later (e.g. a gate resume): the clock starts FRESH, no instant fire.
    executing = [{ id: 'r-done', ord: 2 }];
    await wd.sweep(); // re-seeds
    tick(10 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]);
  });

  it('reads the threshold per sweep (a settings change applies live) and defaults invalid values to 15', async () => {
    let minutes: number | undefined = 30;
    const { wd, frames, tick } = build({ stallMinutes: () => minutes });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 3, text: 'x' }));
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]); // 16 min quiet under a 30-min threshold

    minutes = undefined; // unset → the DEFAULT_WORKER_STALL_MINUTES fallback (15)
    expect(DEFAULT_WORKER_STALL_MINUTES).toBe(15);
    await wd.sweep();
    expect(frames).toHaveLength(1);

    // An invalid resolved value (zero would fire on every sweep) also falls back to 15.
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-stall', ord: 3, text: 'y' }));
    minutes = 0;
    tick(1 * MIN);
    await wd.sweep();
    expect(frames).toHaveLength(1);
  });

  it('a failing run listing skips the sweep loudly instead of throwing', async () => {
    const { wd, frames, logs } = build({
      listExecuting: async () => {
        throw new Error('engine unreachable');
      },
    });
    await expect(wd.sweep()).resolves.toBeUndefined();
    expect(frames).toEqual([]);
    expect(logs.some((m) => m.includes('run listing failed'))).toBe(true);
  });

  it('start() arms an interval that sweeps, stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      const sweeps: number[] = [];
      const wd = new WorkerStallWatchdog({
        listExecuting: async () => {
          sweeps.push(Date.now());
          return [];
        },
        broadcast: () => undefined,
      });
      wd.start(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sweeps).toHaveLength(3);
      wd.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweeps).toHaveLength(3);
      expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Integration: the daemon seam end-to-end (relay ingest → sweep → /ws broadcast) ────────────

type Listener = (event: CoreEvent) => void;

const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

afterEach(() => {
  if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
  else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
});

/** One executing run, engine-shaped enough for the watchdog's `sessionsDetail` mapping. */
function executingView(id: string, unitIx: number): SessionView {
  return {
    session: { id, status: 'executing', unit_ix: unitIx },
    units: [],
  } as unknown as SessionView;
}

describe('stall watchdog through the real server (/ws)', () => {
  it('broadcasts the synthetic frame to a /ws client, once per quiet period, re-armed by a relayed event', async () => {
    const listeners = new Set<Listener>();
    const mockAdapter = {
      getSettings: async (): Promise<CrewSystemSettings> => ({ graphNodeLimit: 150 }),
      projectsSupported: (): boolean => false,
      sessionsDetail: async (): Promise<SessionView[]> => [executingView('r-live', 2)],
      onEvent: (l: Listener): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as CoreAdapter;

    const app = await createServer(mockAdapter, {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      // Opt in (tests default the watchdog OFF) with a compressed clock: 240 ms threshold,
      // 40 ms sweeps. `stallMinutes` here is the test override, not the persisted setting.
      stallWatchdog: { enabled: true, sweepIntervalMs: 40, stallMinutes: 0.004 },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const received: CoreEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data: Buffer | string) => {
      received.push(JSON.parse(data.toString()) as CoreEvent);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const stalledFrames = (): CoreEvent[] => received.filter((f) => f.type === 'workerStalled');
    const waitFor = async (pred: () => boolean, label: string, ms = 5_000): Promise<void> => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    try {
      // Proof of life on the relay, then silence: the first stall frame must arrive.
      for (const l of listeners) l(ev({ type: 'unitOutputDelta', session: 'r-live', ord: 2, text: 'x' }));
      await waitFor(() => stalledFrames().length >= 1, 'first workerStalled frame');
      const first = stalledFrames()[0] as unknown as WorkerStalledFrame;
      expect(first.session).toBe('r-live');
      expect(first.ord).toBe(2);
      expect(first.quietForMs).toBeGreaterThanOrEqual(240);

      // Once per quiet period: continued silence over many sweeps must NOT repeat the frame.
      await new Promise((r) => setTimeout(r, 300));
      expect(stalledFrames()).toHaveLength(1);

      // A relayed engine event re-arms the live watchdog → a second quiet period, second frame.
      for (const l of listeners) l(ev({ type: 'unitOutputDelta', session: 'r-live', ord: 2, text: 'y' }));
      await waitFor(() => stalledFrames().length >= 2, 'second workerStalled frame');
      expect(stalledFrames()).toHaveLength(2);
    } finally {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await app.close();
    }
  }, 15_000);
});
