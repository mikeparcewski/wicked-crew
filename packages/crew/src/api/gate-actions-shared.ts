/**
 * (crew#1950) At most one engine `gateActions` read running per run's open gate; the `GET /runs/:id/gate` requests that
 * arrive while it runs wait for the NEXT read, which they share and which starts after they arrived.
 *
 * On a loaded host each read is CPU-bound in the engine (0.65-0.94 s for a review-adjudication gate at load 15-18,
 * measured on a live daemon), and concurrent reads of one run slow each other (2.86 s each at 8 at once). Studio's
 * surfaces read the same gate together, it gives up on a read at 10 s and asks again, and crew finished every read a
 * browser had abandoned. Now n requests at once cost at most two reads, never n side by side.
 *
 * Every answer is at least as fresh as main's: a request never takes a read that began before it arrived. It takes
 * the read it started itself, or the next read, which starts once the running one settles. So whatever changes on the
 * engine side with no crew event (a seat signing in, a judge back) reaches every request that arrives after it.
 *
 * - The key is the run, the open gate as the caller knows it (its ord and, when known, its opening's `gateSeq`) and
 *   the run's live gate-event count (`GateCache` revisions), so another gate or opening never queues behind this one.
 * - A settled gate decision (`decided`) lets the next request start its own read at once instead of queueing.
 * - A running read that passes {@link GATE_READ_STALL_MS} does not hold its waiters: their read starts then. The
 *   stalled read is not cancelled and still answers the requests it holds.
 * - Nothing is kept once the reads settle. A read that throws rejects only the requests that share it, each through its
 *   own error path; the read queued behind it still starts.
 */
import { performance } from 'node:perf_hooks';

/** A running read this old no longer holds the requests queued behind it (studio's first gate-read deadline). */
export const GATE_READ_STALL_MS = 10_000;

interface Running<T> {
  read: Promise<T>;
  at: number;
}

interface Queued<T> {
  /** The running read this one waits on. */
  after: Running<T>;
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  start: () => Promise<T>;
  timer: ReturnType<typeof setTimeout>;
}

interface Slot<T> {
  runId: string;
  current: Running<T> | null;
  next: Queued<T> | null;
}

export class SharedGateReads<T> {
  private readonly slots = new Map<string, Slot<T>>();

  /** `revisionOf`: the run's live gate-event count (`GateCache.revisionOf`). */
  constructor(
    private readonly revisionOf: (runId: string) => number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** A decision on the run settled: the next request starts its own read at once (the reads in flight still answer). */
  decided(runId: string): void {
    for (const [key, slot] of this.slots) if (slot.runId === runId) this.slots.delete(key);
  }

  /**
   * The read this request gets: one it starts now when none is running for its gate, else the next read, which starts
   * once the running one settles (or stalls) and is shared by every request queued for it. `queued` says which.
   */
  read(runId: string, gate: { ord: number; gateSeq?: number | undefined }, start: () => Promise<T>): { read: Promise<T>; queued: boolean } {
    const key = JSON.stringify([runId, gate.ord, gate.gateSeq ?? null, this.revisionOf(runId)]);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { runId, current: null, next: null };
      this.slots.set(key, slot);
    }
    if (slot.current === null) return { read: this.launch(key, slot, start).read, queued: false };
    if (slot.next === null) slot.next = this.queue(key, slot, slot.current, start);
    return { read: slot.next.promise, queued: true };
  }

  /** Slots with a read running or queued (tests). */
  get size(): number {
    return this.slots.size;
  }

  private launch(key: string, slot: Slot<T>, start: () => Promise<T>): Running<T> {
    let read: Promise<T>;
    try {
      read = start();
    } catch (err) {
      read = Promise.reject(err);
    }
    const running: Running<T> = { read, at: this.now() };
    slot.current = running;
    const settle = (): void => {
      if (slot.current === running) slot.current = null;
      if (slot.next?.after === running) this.promote(key, slot);
      if (slot.current === null && slot.next === null && this.slots.get(key) === slot) this.slots.delete(key);
    };
    read.then(settle, settle);
    return running;
  }

  private queue(key: string, slot: Slot<T>, after: Running<T>, start: () => Promise<T>): Queued<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    const wait = Math.max(0, GATE_READ_STALL_MS - (this.now() - after.at));
    const queued: Queued<T> = {
      after, promise, resolve, reject, start,
      timer: setTimeout(() => {
        if (slot.next === queued) this.promote(key, slot);
      }, wait),
    };
    queued.timer.unref?.();
    return queued;
  }

  /** The queued read starts now and becomes the running one; its waiters get what it answers. */
  private promote(key: string, slot: Slot<T>): void {
    const queued = slot.next;
    if (queued === null) return;
    slot.next = null;
    clearTimeout(queued.timer);
    this.launch(key, slot, queued.start).read.then(queued.resolve, queued.reject);
  }
}
