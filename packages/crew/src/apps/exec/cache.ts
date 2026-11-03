/**
 * The per-app read cache (DES-APPS-001 §7.2 "Cache and coalescing", §7.5): keyed by tree, query, bound
 * parameter values (viewer values included), descriptor hash and contract hash, and for the crew source the
 * viewing actor (the caller builds the key). Entries live by the query's refresh mode (`load` 5 s, `every` N
 * → N/2 s, `events` never cached), at most 500 entries or 50 MB per app, least recently used first out.
 *
 * Identical reads in flight share one source call. ANY action outcome on the app invalidates its whole
 * cache and bumps its generation; a read that started before the bump answers its caller but never writes
 * back.
 */

export const CACHE_LIMITS = { entries: 500, bytes: 50 * 1024 * 1024 } as const;

interface Entry<T> {
  at: number;
  ttlMs: number;
  bytes: number;
  value: T;
}

interface AppCacheState<T> {
  generation: number;
  bytes: number;
  entries: Map<string, Entry<T>>;
  inflight: Map<string, Promise<{ value: T; bytes: number }>>;
}

export class AppReadCache<T> {
  private readonly apps = new Map<string, AppCacheState<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  private state(app: string): AppCacheState<T> {
    let s = this.apps.get(app);
    if (s === undefined) {
      s = { generation: 0, bytes: 0, entries: new Map(), inflight: new Map() };
      this.apps.set(app, s);
    }
    return s;
  }

  generation(app: string): number {
    return this.state(app).generation;
  }

  /** Every entry of `app` gone, its generation bumped: reads in flight cannot write back. */
  invalidate(app: string): void {
    const s = this.state(app);
    s.generation++;
    s.entries.clear();
    s.inflight.clear();
    s.bytes = 0;
  }

  /**
   * The cached value for `key` (and when it was taken), or `fn()`'s, shared with any identical read in
   * flight. `ttlMs` 0 = never cached (still coalesced).
   */
  async read(app: string, key: string, ttlMs: number, fn: () => Promise<{ value: T; bytes: number }>): Promise<{ value: T; cachedAt: number | null }> {
    const s = this.state(app);
    const hit = s.entries.get(key);
    if (hit !== undefined) {
      if (this.now() - hit.at < hit.ttlMs) {
        s.entries.delete(key);
        s.entries.set(key, hit); // most recently used
        return { value: hit.value, cachedAt: hit.at };
      }
      s.entries.delete(key);
      s.bytes -= hit.bytes;
    }
    const pending = s.inflight.get(key);
    if (pending !== undefined) return { value: (await pending).value, cachedAt: null };
    const gen = s.generation;
    const started = this.now();
    const p = fn();
    s.inflight.set(key, p);
    try {
      const r = await p;
      // Only a read of the current generation is kept (an action since may have changed the rows).
      if (ttlMs > 0 && s.generation === gen && r.bytes <= CACHE_LIMITS.bytes) {
        s.entries.set(key, { at: started, ttlMs, bytes: r.bytes, value: r.value });
        s.bytes += r.bytes;
        for (const [k, e] of s.entries) {
          if (s.entries.size <= CACHE_LIMITS.entries && s.bytes <= CACHE_LIMITS.bytes) break;
          s.entries.delete(k);
          s.bytes -= e.bytes;
        }
      }
      return { value: r.value, cachedAt: null };
    } finally {
      if (s.inflight.get(key) === p) s.inflight.delete(key);
    }
  }

  /** TESTS: entries held for `app`. */
  size(app: string): number {
    return this.state(app).entries.size;
  }
}

/** The cache lifetime a query's refresh mode allows. */
export function ttlOf(refresh: { mode: 'load' } | { mode: 'every'; seconds: number } | { mode: 'events' } | undefined): number {
  if (refresh === undefined || refresh.mode === 'load') return 5_000;
  if (refresh.mode === 'every') return Math.floor((refresh.seconds * 1000) / 2);
  return 0;
}
