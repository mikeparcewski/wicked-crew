// crew#1501 — a heartbeat keeps a seat alive but never resets the stall clock. A seat that is silent
// past workerStallMinutes while heartbeats arrive reads `stalled` on the Nerve Center row; a seat that
// produces output does not.

import { describe, expect, it } from 'vitest';
import { WorkerStallWatchdog, type WorkerStalledFrame } from '../src/api/stall-watchdog.js';
import { runLiveness } from '../src/api/system-snapshot.js';
import type { CoreEvent, SessionView } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const VIEW = {
  session: { id: 'r1', status: 'executing', problem: 'p', title: 't', created_at: 0 },
  units: [{ id: 'r1:fix', ord: 0, status: 'distributed', assigned_cli: 'claude' }],
} as unknown as SessionView;

function build() {
  let now = Date.parse('2026-11-12T10:00:00Z');
  const frames: WorkerStalledFrame[] = [];
  const wd = new WorkerStallWatchdog({
    listExecuting: async () => [{ id: 'r1', ord: 0 }],
    broadcast: (f) => frames.push(f as WorkerStalledFrame),
    stallMinutes: () => 1, // 60 s
    now: () => now,
  });
  // The Nerve Center's read of the watchdog: evidence, else the clock the first sweep started.
  const row = () => {
    const e = wd.evidence('r1');
    const clock = wd.clockStart('r1');
    const evidence = e ?? (clock === undefined ? null : { at: clock, source: 'relay' as const });
    return runLiveness({ view: VIEW, now, evidence, gate: null, quietAfterMs: 20_000, stallAfterMs: 60_000 });
  };
  return { wd, frames, row, tick: (ms: number) => (now += ms) };
}

const beats = (wd: WorkerStallWatchdog, tick: (ms: number) => void, ms: number): void => {
  for (let t = 0; t < ms; t += 15_000) {
    tick(15_000);
    wd.ingest(ev({ type: 'toolActivity', session: 'r1', ord: 0, state: 'working', target: 'npm test' }));
    wd.ingest(ev({ type: 'heartbeat', session: 'r1' }));
  }
};

describe('heartbeats do not reset the stall clock (crew#1501)', () => {
  it('a seat silent for 150 s against a 60 s threshold is stalled while heartbeats arrive', async () => {
    const { wd, frames, row, tick } = build();
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r1', ord: 0, text: 'start' }));
    beats(wd, tick, 150_000);
    await wd.sweep();
    expect(row()).toMatchObject({ liveness: 'stalled' });
    expect(row().quietForMs).toBe(150_000);
    expect(frames).toMatchObject([{ type: 'workerStalled', session: 'r1' }]);
  });

  it('a seat producing output is not stalled', async () => {
    const { wd, frames, row, tick } = build();
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r1', ord: 0, text: 'start' }));
    for (let i = 0; i < 10; i++) {
      beats(wd, tick, 15_000);
      wd.ingest(ev({ type: i % 2 ? 'toolActivity' : 'unitOutputDelta', session: 'r1', ord: 0, state: 'started', text: 'x' }));
    }
    await wd.sweep();
    expect(row()).toMatchObject({ liveness: 'working' });
    expect(frames).toEqual([]);
  });

  it('a restarted daemon that only sees heartbeats starts the clock at its first sweep and stalls', async () => {
    const { wd, frames, row, tick } = build();
    await wd.sweep(); // first observation seeds the clock
    expect(wd.evidence('r1')).toBeUndefined();
    beats(wd, tick, 150_000);
    await wd.sweep();
    expect(row()).toMatchObject({ liveness: 'stalled' });
    expect(frames).toHaveLength(1);
  });
});
