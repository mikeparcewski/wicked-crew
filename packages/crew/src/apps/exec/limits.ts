/**
 * Concurrency, queue and rate (DES-APPS-001 §7.5): 4 queries per source per app at once, a queue of 16,
 * then `429`; per viewer 60 page views or actions' query batches and 20 action runs a minute per app.
 * A view's distinct reads count once within 10 s, up to the app's declared query count.
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

interface QueryUnit {
  startedAt: number;
  reads: Set<string>;
}

export class AppLimits {
  private readonly slots = new Map<string, Slot>();
  private readonly windows = new Map<string, number[]>();
  private readonly queryUnits = new Map<string, QueryUnit>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Distinct reads join a view for up to 10 s; a repeated read or a full view costs a new unit. */
  rateQuery(app: string, who: string, read: string, appQueries: number): void {
    const key = `${app}\u0000${who}`;
    const t = this.now();
    const unit = this.queryUnits.get(key);
    if (unit !== undefined && t - unit.startedAt < 10_000 && !unit.reads.has(read) && unit.reads.size < Math.max(1, appQueries)) {
      unit.reads.add(read);
      return;
    }
    this.rate('query', app, who); // a refusal neither opens a unit nor records a read
    this.queryUnits.set(key, { startedAt: t, reads: new Set([read]) });
    if (this.queryUnits.size > 10_000) {
      for (const [k, v] of this.queryUnits) if (t - v.startedAt >= 10_000) this.queryUnits.delete(k);
    }
  }

  /** Count one call by `who` in `bucket` against `perMinute`; throws `RateLimited` past it. */
  rate(bucket: 'query' | 'action' | 'prepare', app: string, who: string): void {
    // A run is an action (20 a minute); preparing a card costs a check and a read, bounded like a query.
    const limit = bucket === 'action' ? QUERY_LIMITS.actionsPerMinute : QUERY_LIMITS.perMinute;
    const key = `${bucket}\u0000${app}\u0000${who}`;
    const t = this.now();
    const w = (this.windows.get(key) ?? []).filter((x) => t - x < 60_000);
    if (w.length >= limit) {
      this.windows.set(key, w);
      const retryAfterMs = 60_000 - (t - w[0]!);
      const message = bucket === 'query'
        ? `at most ${limit} page views or actions a minute per viewer in this app (a view's queries count once)`
        : `at most ${limit} ${bucket === 'action' ? 'action runs' : 'prepared actions'} a minute per viewer in this app`;
      throw new RateLimited(`${message}; the limit resets in ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} s`, retryAfterMs);
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
