/**
 * The push ring (DES-TRIGGER-REGISTRY-001 §4.6): where the daemon fan-in and the watchdog tee drop
 * their key points. A push is O(1) and never blocks the producer.
 *
 * Capacity is shared by three priority classes. On overflow the oldest `p2` item goes first, then
 * the oldest `p1`. A `p0` item is NEVER shed: when only `p0` items remain the ring grows past its
 * capacity rather than lose one (`claim-vs-evidence` and `deliver-audit` are `p0`).
 */

import type { WatchPriority } from 'wicked-crew-api-types';

/** A growable FIFO with an O(1) shift (a head index, compacted now and then). */
class Fifo<T> {
  private items: (T | undefined)[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(): T | undefined {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined;
    this.head++;
    // Compact once the dead prefix is half the array: amortised O(1), bounded memory.
    if (this.head > 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

export interface RingStats {
  depth: number;
  /** The deepest the ring has been since boot. */
  hwm: number;
  shed_by_priority: Record<WatchPriority, number>;
}

export class PushRing<T> {
  private readonly classes: Record<WatchPriority, Fifo<{ seq: number; item: T }>> = {
    p0: new Fifo(),
    p1: new Fifo(),
    p2: new Fifo(),
  };
  private seq = 0;
  private hwm = 0;
  private readonly shed: Record<WatchPriority, number> = { p0: 0, p1: 0, p2: 0 };
  /** Called once per shed item (the registry raises one `registry-lagging` flag per episode). */
  onShed: ((priority: WatchPriority) => void) | undefined;

  constructor(readonly capacity = 512) {}

  get depth(): number {
    return this.classes.p0.length + this.classes.p1.length + this.classes.p2.length;
  }

  /** O(1); never throws, never blocks. */
  push(item: T, priority: WatchPriority): void {
    this.classes[priority].push({ seq: this.seq++, item });
    while (this.depth > this.capacity) {
      const victim: WatchPriority | null =
        this.classes.p2.length > 0 ? 'p2' : this.classes.p1.length > 0 ? 'p1' : null;
      if (victim === null) break; // only p0 left: never shed, grow instead
      this.classes[victim].shift();
      this.shed[victim]++;
      try {
        this.onShed?.(victim);
      } catch {
        /* a reporting hook never breaks the producer's push */
      }
    }
    if (this.depth > this.hwm) this.hwm = this.depth;
  }

  /** The oldest item across classes, in arrival order. */
  shift(): T | undefined {
    let best: WatchPriority | null = null;
    let bestSeq = Infinity;
    for (const p of ['p0', 'p1', 'p2'] as const) {
      const head = this.classes[p].peek();
      if (head !== undefined && head.seq < bestSeq) {
        best = p;
        bestSeq = head.seq;
      }
    }
    return best === null ? undefined : this.classes[best].shift()?.item;
  }

  stats(): RingStats {
    return { depth: this.depth, hwm: this.hwm, shed_by_priority: { ...this.shed } };
  }
}
