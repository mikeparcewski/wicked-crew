// crew#1950: SharedGateReads on its own: one read running per gate, later requests share the next, a stall bound.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_READ_STALL_MS, SharedGateReads } from '../src/api/gate-actions-shared.js';

const deferred = () => {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const read = new Promise<string>((ok, no) => { resolve = ok; reject = no; });
  return { read, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); });

describe('SharedGateReads (crew#1950)', () => {
  it('runs one read per gate; requests during it share the next, which starts after it settles', async () => {
    const reads = new SharedGateReads<string>(() => 0, () => 0);
    const first = deferred();
    const second = deferred();
    const starts: string[] = [];
    const a = reads.read('r', { ord: 2 }, () => { starts.push('a'); return first.read; });
    const b = reads.read('r', { ord: 2 }, () => { starts.push('b'); return second.read; });
    const c = reads.read('r', { ord: 2 }, () => { starts.push('c'); return deferred().read; });
    expect([a.queued, b.queued, c.queued]).toEqual([false, true, true]);
    expect(starts).toEqual(['a']);
    first.resolve('as of a');
    await flush();
    // The next read starts only now, after b and c arrived; both get it.
    expect(starts).toEqual(['a', 'b']);
    second.resolve('as of b');
    await expect(a.read).resolves.toBe('as of a');
    await expect(b.read).resolves.toBe('as of b');
    await expect(c.read).resolves.toBe('as of b');
    await flush();
    expect(reads.size).toBe(0);
  });

  it('another gate, opening, run or generation never queues behind this one', () => {
    let revision = 0;
    const reads = new SharedGateReads<string>(() => revision, () => 0);
    reads.read('r', { ord: 2 }, () => deferred().read);
    expect(reads.read('r', { ord: 3 }, () => deferred().read).queued).toBe(false);
    expect(reads.read('r', { ord: 2, gateSeq: 2 }, () => deferred().read).queued).toBe(false);
    expect(reads.read('other', { ord: 2 }, () => deferred().read).queued).toBe(false);
    revision = 1;
    expect(reads.read('r', { ord: 2 }, () => deferred().read).queued).toBe(false);
  });

  it('a running read past GATE_READ_STALL_MS releases its waiters: their read starts; the stalled one is not cancelled', async () => {
    vi.useFakeTimers();
    let t = 0;
    const reads = new SharedGateReads<string>(() => 0, () => t);
    const stalled = deferred();
    const fresh = deferred();
    let started = 0;
    const a = reads.read('r', { ord: 2 }, () => stalled.read);
    t = 4_000;
    const b = reads.read('r', { ord: 2 }, () => { started += 1; return fresh.read; });
    await vi.advanceTimersByTimeAsync(GATE_READ_STALL_MS - 4_000 - 1);
    expect(started).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(1);
    fresh.resolve('fresh');
    await expect(b.read).resolves.toBe('fresh');
    // The stalled read settling later answers its own request and starts nothing.
    stalled.resolve('late');
    await expect(a.read).resolves.toBe('late');
    await flush();
    expect(started).toBe(1);
    expect(reads.size).toBe(0);
  });

  it('a read that throws rejects only its own request; the queued read still starts', async () => {
    const reads = new SharedGateReads<string>(() => 0, () => 0);
    const first = deferred();
    const a = reads.read('r', { ord: 2 }, () => first.read);
    const b = reads.read('r', { ord: 2 }, () => Promise.resolve('next'));
    first.reject(new Error('engine read failed'));
    await expect(a.read).rejects.toThrow('engine read failed');
    await expect(b.read).resolves.toBe('next');
  });

  it('a settled decision lets the next request read at once and keeps nothing per run', async () => {
    const reads = new SharedGateReads<string>(() => 0, () => 0);
    const first = deferred();
    reads.read('r', { ord: 2 }, () => first.read);
    reads.read('s', { ord: 1 }, () => deferred().read);
    reads.decided('r');
    expect(reads.size).toBe(1);
    expect(reads.read('r', { ord: 2 }, () => deferred().read).queued).toBe(false);
    reads.decided('nothing-in-flight');
    expect(reads.size).toBe(2);
    // The decided-away slot's read settling never removes the new slot.
    first.resolve('old');
    await flush();
    expect(reads.size).toBe(2);
  });
});
