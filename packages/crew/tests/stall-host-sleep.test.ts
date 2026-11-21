// wicked-core#1151 — host sleep is not worker silence. Drive both clocks independently.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerStallWatchdog,
  type ExecutingRun,
  type WorkerStalledFrame,
  type WorkerStallEscalatedFrame,
} from '../src/api/stall-watchdog.js';
import type { CoreEvent } from '../src/core/types.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-20T20:03:41Z');
const RUNS: ExecutingRun[] = [
  { id: 'r-sleep', ord: 3, cli: 'claude', seats: ['claude', 'pi'] },
];
const output = (): CoreEvent =>
  ({ type: 'unitOutputDelta', session: 'r-sleep', ord: 3, text: 'working' }) as CoreEvent;

/** The watchdog build() harness, with an armed reassign and independent wall/monotonic clocks. */
function build(opts?: {
  clocks?: 'paired' | 'defaults' | 'wall-only';
  listExecuting?: () => Promise<ExecutingRun[]>;
}) {
  let wallMs = T0;
  let monoMs = 0;
  const frames: (WorkerStalledFrame | WorkerStallEscalatedFrame)[] = [];
  const logs: string[] = [];
  const reassigns: { runId: string; ord: number; cli?: string }[] = [];
  if (opts?.clocks === 'defaults') {
    vi.spyOn(Date, 'now').mockImplementation(() => wallMs);
    vi.spyOn(performance, 'now').mockImplementation(() => monoMs);
  }
  const wd = new WorkerStallWatchdog({
    listExecuting: opts?.listExecuting ?? (async () => RUNS),
    broadcast: (frame) => frames.push(frame),
    escalation: {
      config: () => ({ minutes: 30 }),
      reassign: async (runId, ord, cli) => {
        reassigns.push({ runId, ord, ...(cli !== undefined ? { cli } : {}) });
      },
    },
    ...(opts?.clocks === 'defaults' ? {} : { now: () => wallMs }),
    ...(opts?.clocks === 'defaults' || opts?.clocks === 'wall-only'
      ? {}
      : { monoNow: () => monoMs }),
    log: (message) => logs.push(message),
  });
  return {
    wd,
    frames,
    logs,
    reassigns,
    tick: (wall: number, mono = wall): void => {
      wallMs += wall;
      monoMs += mono;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('WorkerStallWatchdog — host sleep (wicked-core#1151)', () => {
  it('does not detect or reassign a worker when wall moves 45 min but mono moves 30 s', async () => {
    const { wd, frames, reassigns, logs, tick } = build();
    wd.ingest(output());
    await wd.sweep();

    tick(45 * MIN, 30_000);
    await wd.sweep();
    expect.soft(frames).toEqual([]);
    expect.soft(reassigns).toEqual([]);
    expect(logs).toEqual([
      '[stall-watchdog] the host slept ~45 min (wall clock moved 45.0 min, the monotonic clock 30 s): quiet clocks moved forward; sleep is not worker silence',
    ]);
    await wd.sweep();
    expect(logs).toHaveLength(1);
  });

  it('does not emit during DarkWake: 30 s awake, then wall +16.5 min and mono +32 s', async () => {
    const { wd, frames, reassigns, tick } = build();
    wd.ingest(output());
    tick(30_000);
    await wd.sweep();

    tick(16.5 * MIN, 32_000);
    await wd.sweep();
    expect(frames).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('still detects exactly one stall after 16 awake minutes, with 16 min of quiet', async () => {
    const { wd, frames, tick } = build();
    wd.ingest(output());
    await wd.sweep();

    tick(16 * MIN);
    await wd.sweep();
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-sleep', ord: 3, quietForMs: 16 * MIN },
    ]);
  });

  it('detects after 45 min asleep plus 16 awake min, counting only the awake quiet time', async () => {
    const { wd, frames, tick } = build();
    wd.ingest(output());
    await wd.sweep();

    tick(45 * MIN, 0);
    await wd.sweep();
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-sleep', ord: 3, quietForMs: 16 * MIN },
    ]);
  });

  it('clamps an event ingested after wake so the next 16 awake silent minutes fire', async () => {
    const { wd, frames, tick } = build();
    wd.ingest(output());
    await wd.sweep();

    tick(45 * MIN, 0);
    wd.ingest(output()); // The relay delivers evidence before the first post-wake sweep.
    await wd.sweep();
    expect(frames).toEqual([]);
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-sleep', ord: 3, quietForMs: 16 * MIN },
    ]);
  });

  it('moves quiet clocks for every run without changing the timestamp of evidence', async () => {
    const { wd, tick } = build({ listExecuting: async () => [...RUNS, { id: 'r-other' }] });
    wd.ingest(output());
    wd.ingest({ ...output(), session: 'r-other' });
    await wd.sweep();

    tick(45 * MIN, 30_000);
    await wd.sweep();
    for (const id of ['r-sleep', 'r-other']) {
      expect(wd.clockStart(id)).toBe(T0 + 45 * MIN - 30_000);
      expect(wd.evidence(id)).toEqual({ at: T0, source: 'relay' });
    }
  });

  it('adjusts before awaiting a listing and does not double-shift on skipped sweeps', async () => {
    let release!: (runs: ExecutingRun[]) => void;
    const listing = new Promise<ExecutingRun[]>((resolve) => { release = resolve; });
    let calls = 0;
    const { wd, frames, logs, tick } = build({
      listExecuting: async () => (++calls === 2 ? listing : RUNS),
    });
    wd.ingest(output());
    await wd.sweep();
    const pending = wd.sweep(); // An engine listing is in flight when the host sleeps.
    try {
      tick(45 * MIN, 0);
      await wd.sweep(); // Skipped, but must already adjust the pending sweep's quiet clock.
      expect.soft(wd.clockStart('r-sleep')).toBe(T0 + 45 * MIN);
      await wd.sweep(); // Same pair must not apply the gap twice.
      expect.soft(wd.clockStart('r-sleep')).toBe(T0 + 45 * MIN);
    } finally {
      release(RUNS);
      await pending;
    }
    expect(frames).toEqual([]);
    expect(logs.filter((message) => message.includes('the host slept'))).toHaveLength(1);
  });

  it('remembers a sleep adjustment even when the post-wake listing fails', async () => {
    let calls = 0;
    const { wd, frames, tick } = build({
      listExecuting: async () => {
        if (++calls === 2) throw new Error('engine unavailable');
        return RUNS;
      },
    });
    wd.ingest(output());
    await wd.sweep();
    tick(45 * MIN, 0);
    await wd.sweep();
    expect.soft(wd.clockStart('r-sleep')).toBe(T0 + 45 * MIN);
    tick(16 * MIN);
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-sleep', ord: 3, quietForMs: 16 * MIN },
    ]);
  });

  it('detects sleep with the default clocks, without daemon wiring', async () => {
    const { wd, frames, reassigns, tick } = build({ clocks: 'defaults' });
    wd.ingest(output());
    await wd.sweep();
    tick(45 * MIN, 30_000);
    await wd.sweep();
    expect(frames).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('keeps legacy fake-wall-clock tests unchanged when monoNow is omitted', async () => {
    const { wd, frames, tick } = build({ clocks: 'wall-only' });
    wd.ingest(output());
    await wd.sweep();
    tick(16 * MIN, 0);
    await wd.sweep();
    expect(frames).toEqual([
      { type: 'workerStalled', session: 'r-sleep', ord: 3, quietForMs: 16 * MIN },
    ]);
  });
});
