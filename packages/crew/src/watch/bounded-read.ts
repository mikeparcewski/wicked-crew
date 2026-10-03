/**
 * One bounded, cached read (TR-W6's rules-snapshot rule, shared by WT-W4's discovery view): a TTL'd
 * value, at most one read in flight, and a per-ask DEADLINE below the deterministic lane's timeout —
 * a slow read must never get a check's evaluation abandoned mid-way (its dedupe state would move
 * while its output is dropped). Past the deadline the ask is refused — or, with `staleOk`, answered
 * from the last value — while the read itself goes on and fills the snapshot when it lands. A read
 * that has not settled within one TTL is abandoned: the next ask starts a new one (a hung source
 * never pins the slot), and a late answer from an abandoned read never overwrites a newer snapshot.
 */
export class BoundedRead<T> {
  private snapshot: { at: number; value: T } | null = null;
  private inFlight: { startedAt: number; promise: Promise<T> } | null = null;

  constructor(
    private readonly opts: {
      /** Names the read in the timeout's message ("the rules read timed out after 400 ms"). */
      name: string;
      source: () => Promise<T>;
      ttlMs: number;
      deadlineMs: number;
      now: () => number;
      /** Answer an ask past its deadline from the last value when there is one (advisory data). */
      staleOk?: boolean;
    },
  ) {}

  read(): Promise<T> {
    const { name, ttlMs, deadlineMs, now } = this.opts;
    const t = now();
    if (this.snapshot !== null && t - this.snapshot.at < ttlMs) return Promise.resolve(this.snapshot.value);
    if (this.inFlight === null || t - this.inFlight.startedAt >= ttlMs) {
      const flight: { startedAt: number; promise: Promise<T> } = { startedAt: t, promise: Promise.resolve(undefined as unknown as T) };
      flight.promise = Promise.resolve()
        .then(this.opts.source)
        .then((value) => {
          // Only the read that still owns the slot may publish (an abandoned one is stale by definition).
          if (this.inFlight === flight) this.snapshot = { at: now(), value };
          return value;
        })
        .finally(() => {
          if (this.inFlight === flight) this.inFlight = null;
        });
      flight.promise.catch(() => undefined); // an ask past its deadline no longer listens
      this.inFlight = flight;
    }
    const read = this.inFlight.promise;
    const stale = this.snapshot;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.opts.staleOk === true && stale !== null) resolve(stale.value);
        else reject(new Error(`${name} timed out after ${deadlineMs} ms`));
      }, deadlineMs);
      timer.unref();
      read.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}
