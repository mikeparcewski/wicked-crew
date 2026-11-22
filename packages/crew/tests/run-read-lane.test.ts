// crew#1779: one-run reads started by an engine frame's listeners wait behind every request's read, and the
// listeners of one frame share one read of the run. The engine serves one-run reads one at a time on one
// read connection (`sessionDetail`); the fake below holds each read until the test releases it, so the
// order and overlap of reads are the test's, never the timer's.
import { describe, expect, it, vi } from 'vitest';
import { FRAME_READ_WIDTH, RunReadLane } from '../src/core/run-read-lane.js';

/** A read connection whose reads stay open until released; each read sees `version` as it was when it started. */
function heldReads() {
  const started: Array<{ id: string; seen: number; release: () => void }> = [];
  let version = 0;
  const read = (id: string): Promise<{ id: string; v: number }> => {
    const seen = version;
    return new Promise((resolve) => started.push({ id, seen, release: () => resolve({ id, v: seen }) }));
  };
  const open = (id: string) => started.filter((s) => s.id === id);
  return { read, started, open, bump: () => (version += 1) };
}

const copy = <T>(v: T): T => structuredClone(v);
/** Two loop turns: the lane starts its reads on the turn after a read is queued or released. */
const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

describe('RunReadLane', () => {
  it('holds frame reads to FRAME_READ_WIDTH, never two of one run, while a request read starts at once', async () => {
    const c = heldReads();
    const lane = new RunReadLane(c.read, copy);
    const background = lane.inFrame(() => ['a', 'a', 'b', 'c', 'd', 'a'].map((id) => lane.get(id)));
    await tick();
    // The lane is full: two distinct runs in flight, the rest queued.
    expect(c.started.map((s) => s.id)).toEqual(['a', 'b']);
    expect(lane.pending).toEqual({ queued: 2, running: FRAME_READ_WIDTH });
    // A request's read is not queued behind them.
    const gate = lane.get('gate');
    expect(c.started.map((s) => s.id)).toEqual(['a', 'b', 'gate']);
    c.open('gate')[0]!.release();
    expect(await gate).toEqual({ id: 'gate', v: 0 });
    // Draining: each release lets the next queued run in, never a third at once.
    c.open('a')[0]!.release();
    await tick();
    expect(c.started.map((s) => s.id)).toEqual(['a', 'b', 'gate', 'c']);
    c.open('b')[0]!.release();
    c.open('c')[0]!.release();
    await tick();
    c.open('d')[0]!.release();
    expect(await Promise.all(background)).toEqual([
      { id: 'a', v: 0 }, { id: 'a', v: 0 }, { id: 'b', v: 0 }, { id: 'c', v: 0 }, { id: 'd', v: 0 }, { id: 'a', v: 0 },
    ]);
    // The three reads of `a` queued in one frame shared one read.
    expect(c.open('a')).toHaveLength(1);
    expect(lane.pending).toEqual({ queued: 0, running: 0 });
  });

  it('a frame read queued while its run is being read waits for the next read, never joins the older one', async () => {
    const c = heldReads();
    const lane = new RunReadLane(c.read, copy);
    const first = lane.inFrame(() => lane.get('r'));
    await tick();
    expect(c.open('r')).toHaveLength(1);
    c.bump(); // a later frame: the run changed after the first read started
    const later = lane.inFrame(() => [lane.get('r'), lane.get('r')]);
    await tick();
    expect(c.open('r')).toHaveLength(1); // not started while the older read is open
    c.open('r')[0]!.release();
    expect(await first).toEqual({ id: 'r', v: 0 });
    await tick();
    expect(c.open('r')).toHaveLength(2);
    c.open('r')[1]!.release();
    expect(await Promise.all(later)).toEqual([{ id: 'r', v: 1 }, { id: 'r', v: 1 }]);
  });

  it('every caller that shares a read gets its own copy', async () => {
    const c = heldReads();
    const lane = new RunReadLane(c.read, copy);
    const reads = lane.inFrame(() => [lane.get('x'), lane.get('x'), lane.get('x')]);
    await tick();
    c.open('x')[0]!.release();
    const [a, b, d] = await Promise.all(reads);
    expect(a).toEqual(b);
    expect(new Set([a, b, d]).size).toBe(3);
  });

  it('keeps the scope down a listener’s async chain, and a failed read fails every caller that shared it', async () => {
    const read = vi.fn(async (id: string): Promise<string> => {
      throw new Error(`no ${id}`);
    });
    const lane = new RunReadLane(read, copy);
    const out = await lane.inFrame(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return Promise.allSettled([lane.get('x'), lane.get('x')]);
    });
    expect(out.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(lane.pending).toEqual({ queued: 0, running: 0 });
  });
});
