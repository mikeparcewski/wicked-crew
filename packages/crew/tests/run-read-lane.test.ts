// crew#1779: one-run reads started by an engine frame's listeners wait behind every request's read, and the
// listeners of one frame share one read of the run. The engine serves one-run reads one at a time on one
// read connection (`sessionDetail`), so the fakes below serve them serially, as it does.
import { describe, expect, it, vi } from 'vitest';
import { FRAME_READ_WIDTH, RunReadLane } from '../src/core/run-read-lane.js';

/** The engine's one read connection: each read takes `ms`, served in arrival order. */
function oneConnection(ms: number, answer: (id: string) => string) {
  let tail: Promise<unknown> = Promise.resolve();
  const reads: string[] = [];
  const read = (id: string): Promise<string> => {
    reads.push(id);
    // The read sees the store as it is when the connection serves it.
    const done = tail.then(() => {
      const value = answer(id);
      return new Promise<string>((r) => setTimeout(() => r(value), ms));
    });
    tail = done;
    return done;
  };
  return { read, reads };
}


describe('RunReadLane', () => {
  it('a request read is never queued behind a frame listener burst', async () => {
    const conn = oneConnection(20, (id) => id);
    const lane = new RunReadLane(conn.read);
    // A run end: eight listeners each read the run that ended, plus four other runs' frames.
    const background = lane.inFrame(() => [
      ...Array.from({ length: 8 }, () => lane.get('ended')),
      ...['a', 'b', 'c', 'd'].map((id) => lane.get(id)),
    ]);
    const t0 = performance.now();
    expect(await lane.get('gate')).toBe('gate');
    const took = performance.now() - t0;
    // At most FRAME_READ_WIDTH frame reads are ahead of it on the connection, plus its own read.
    expect(took).toBeLessThan((FRAME_READ_WIDTH + 1) * 20 + 40);
    expect(await Promise.all(background)).toEqual([...Array(8).fill('ended'), 'a', 'b', 'c', 'd']);
    // The eight listeners of the run end shared one read.
    expect(conn.reads.filter((id) => id === 'ended')).toHaveLength(1);
    expect(conn.reads).toHaveLength(6);
  });

  it('a frame read queued while that run is being read waits for the next read, never joins the older one', async () => {
    let version = 0;
    const conn = oneConnection(15, (id) => `${id}@${version}`);
    const lane = new RunReadLane(conn.read);
    const first = lane.inFrame(() => lane.get('r'));
    await vi.waitFor(() => expect(conn.reads).toHaveLength(1));
    version = 1; // a later frame: the run changed after the first read started
    const second = lane.inFrame(() => [lane.get('r'), lane.get('r')]);
    expect(await first).toBe('r@0');
    expect(await Promise.all(second)).toEqual(['r@1', 'r@1']);
    expect(conn.reads).toEqual(['r', 'r']);
  });

  it('keeps the scope down a listener’s async chain, and a failed read fails every caller that shared it', async () => {
    let n = 0;
    const lane = new RunReadLane(async (id) => {
      n += 1;
      throw new Error(`no ${id}`);
    });
    const reads = lane.inFrame(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return Promise.allSettled([lane.get('x'), lane.get('x')]);
    });
    const out = await reads;
    expect(out.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(n).toBe(1);
    expect(lane.pending).toEqual({ queued: 0, running: 0 });
  });
});
