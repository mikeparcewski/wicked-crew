/**
 * Concurrency, queue and rate (DES-APPS-001 §7.5): 4 queries per source per app at once, a queue of 16,
 * then `429`; per viewer 60 queries and 20 actions a minute per app.
 */

export const QUERY_LIMITS = { concurrent: 4, queue: 16, perMinute: 60, actionsPerMinute: 20 } as const;

export class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

interface Slot {
  active: number;
  queue: Array<() => void>;
}

export class AppLimits {
  private readonly slots = new Map<string, Slot>();
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Count one call by `who` in `bucket` against `perMinute`; throws `RateLimited` past it. */
  rate(bucket: 'query' | 'action', app: string, who: string): void {
    const limit = bucket === 'query' ? QUERY_LIMITS.perMinute : QUERY_LIMITS.actionsPerMinute;
    const key = `${bucket}\u0000${app}\u0000${who}`;
    const t = this.now();
    const w = (this.windows.get(key) ?? []).filter((x) => t - x < 60_000);
    if (w.length >= limit) {
      this.windows.set(key, w);
      throw new RateLimited(`at most ${limit} ${bucket === 'query' ? 'queries' : 'actions'} a minute per viewer in this app`, 60_000 - (t - w[0]!));
    }
    w.push(t);
    this.windows.set(key, w);
    if (this.windows.size > 10_000) {
      for (const [k, v] of this.windows) if (v.every((x) => t - x >= 60_000)) this.windows.delete(k);
    }
  }

  /** Run `fn` holding one of the source's slots in this app; queue when all are busy, refuse past the queue. */
  async run<T>(app: string, source: string, fn: () => Promise<T>): Promise<T> {
    const key = `${app}\u0000${source}`;
    let s = this.slots.get(key);
    if (s === undefined) {
      s = { active: 0, queue: [] };
      this.slots.set(key, s);
    }
    const slot = s;
    if (slot.active >= QUERY_LIMITS.concurrent) {
      if (slot.queue.length >= QUERY_LIMITS.queue) throw new RateLimited(`${source} already has ${QUERY_LIMITS.concurrent} queries running and ${QUERY_LIMITS.queue} waiting in this app`, 1_000);
      await new Promise<void>((resolve) => slot.queue.push(resolve));
    } else {
      slot.active++;
    }
    try {
      return await fn();
    } finally {
      const next = slot.queue.shift();
      if (next !== undefined) next(); // the slot passes to the next waiter
      else {
        slot.active--;
        if (slot.active === 0) this.slots.delete(key);
      }
    }
  }
}
