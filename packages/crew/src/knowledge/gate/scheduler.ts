/**
 * One scheduler per source (DES-KNOWLEDGE-DATA-001 §7.4): every caller of the gate, and the gate's own
 * background work, share ONE load budget on the person's database.
 *
 * - One concurrency limit (default 4; 1 where the source has no source-side deadline, §7.2/§7.3), with
 *   priority person > app-viewer/site > unit > describe > profile, FIFO within a class.
 * - A bounded queue: past it, `busy`; a queued call waits at most `queueWaitMs`, then `busy` too.
 * - Per-class rates (unit: 30 a minute), counted at admission.
 * - Jitter and backoff after connection failures: admissions wait out a growing pause.
 * - The **remote-work reservation**: after a kill on a source with no source-side deadline, the remote work
 *   may still run (a database does not always notice a dropped client), so the source admits nothing until a
 *   check confirms the session is gone. The check repeats every `recheckMs` (60 s); `unknown`, `running` or a
 *   failed check keeps it closed (fail closed).
 */

export type CallerClass = 'person' | 'app-viewer' | 'site' | 'unit' | 'describe' | 'profile';

const PRIORITY: Record<CallerClass, number> = { person: 0, 'app-viewer': 1, site: 1, unit: 2, describe: 3, profile: 4 };

export interface SchedulerLimits {
  concurrency: number;
  queueMax: number;
  queueWaitMs: number;
  /** Admissions a minute per class; absent = unlimited. */
  perMinute: Partial<Record<CallerClass, number>>;
  /** How often a held reservation is checked again. */
  recheckMs: number;
}

export const DEFAULT_LIMITS: Readonly<SchedulerLimits> = Object.freeze({
  concurrency: 4,
  queueMax: 16,
  queueWaitMs: 10_000,
  perMinute: Object.freeze({ unit: 30 }),
  recheckMs: 60_000,
});

/** Whether the remote work a kill left behind is gone. */
export type RemoteCheck = () => Promise<'gone' | 'running' | 'unknown'>;

/** An admission the scheduler refused: crew's code and words for the caller. */
export class GateBusyError extends Error {
  constructor(
    readonly code: 'busy' | 'rate_limited' | 'remote_work_pending',
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'GateBusyError';
  }
}

/** How a call that held a slot ended. */
export interface LeaseEnd {
  /** `error` with `connection: true` moves the backoff; `killed` with a `remoteCheck` holds the reservation. */
  outcome: 'ok' | 'error' | 'killed';
  connection?: boolean;
  /** Given only for a source with no source-side deadline: the check that releases the reservation. */
  remoteCheck?: RemoteCheck;
}

export interface Lease {
  done(end: LeaseEnd): void;
}

interface Waiter {
  cls: CallerClass;
  seq: number;
  resolve: (l: Lease) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class SourceScheduler {
  private running = 0;
  private seq = 0;
  private readonly queue: Waiter[] = [];
  private readonly recent = new Map<CallerClass, number[]>();
  private errorStreak = 0;
  private backoffUntil = 0;
  private pumpTimer: NodeJS.Timeout | null = null;
  private reservation: { check: RemoteCheck; timer: NodeJS.Timeout | null; inflight: Promise<boolean> | null } | null = null;

  constructor(
    private limits: SchedulerLimits,
    private readonly label: string,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  /** Change the limits (a source's verified capabilities can lower its concurrency). */
  setLimits(limits: SchedulerLimits): void {
    this.limits = limits;
    this.pump();
  }

  /** For diagnostics and tests. */
  state(): { running: number; queued: number; reserved: boolean; concurrency: number } {
    return { running: this.running, queued: this.queue.length, reserved: this.reservation !== null, concurrency: this.limits.concurrency };
  }

  /** Take a slot for one call of `cls`, or be refused (`busy`, `rate_limited`, `remote_work_pending`). */
  admit(cls: CallerClass): Promise<Lease> {
    if (this.reservation !== null) return Promise.reject(this.pending());
    const cap = this.limits.perMinute[cls];
    if (cap !== undefined) {
      const at = this.now();
      const window = (this.recent.get(cls) ?? []).filter((t) => at - t < 60_000);
      this.recent.set(cls, window);
      if (window.length >= cap) {
        return Promise.reject(new GateBusyError('rate_limited', `${this.label} has had ${cap} ${cls} reads in the last minute`, 'wait a minute, or fold several questions into one query'));
      }
      window.push(at);
    }
    if (this.queue.length >= this.limits.queueMax) {
      return Promise.reject(new GateBusyError('busy', `${this.label} has ${this.queue.length} reads waiting already`, 'try again when one has finished'));
    }
    return new Promise<Lease>((resolve, reject) => {
      const w: Waiter = {
        cls,
        seq: this.seq++,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new GateBusyError('busy', `${this.label} was busy for ${Math.round(this.limits.queueWaitMs / 1000)} s`, 'try again when its reads have finished'));
        }, this.limits.queueWaitMs),
      };
      w.timer.unref();
      this.queue.push(w);
      this.pump();
    });
  }

  private pending(): GateBusyError {
    return new GateBusyError('remote_work_pending', `${this.label} is closed: a read was stopped, and crew has not yet confirmed its work ended at the source`, 'try again in a minute; crew re-checks the source');
  }

  private pump(): void {
    if (this.pumpTimer !== null) return;
    while (this.queue.length > 0 && this.running < this.limits.concurrency && this.reservation === null) {
      const wait = this.backoffUntil - this.now();
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, wait);
        this.pumpTimer.unref();
        return;
      }
      this.queue.sort((a, b) => PRIORITY[a.cls] - PRIORITY[b.cls] || a.seq - b.seq);
      const w = this.queue.shift() as Waiter;
      clearTimeout(w.timer);
      this.running += 1;
      let ended = false;
      w.resolve({
        done: (end) => {
          if (ended) return;
          ended = true;
          this.running -= 1;
          this.settle(end);
          this.pump();
        },
      });
    }
  }

  private settle(end: LeaseEnd): void {
    if (end.outcome === 'error' && end.connection === true) {
      this.errorStreak += 1;
      const base = Math.min(5_000, 250 * 2 ** (this.errorStreak - 1));
      this.backoffUntil = this.now() + Math.round(base * (0.8 + 0.4 * this.random()));
    } else if (end.outcome === 'ok') {
      this.errorStreak = 0;
      this.backoffUntil = 0;
    }
    if (end.outcome === 'killed' && end.remoteCheck !== undefined) this.reserve(end.remoteCheck);
  }

  /** Close the source until `check` says the remote work is gone (first check at once, then every `recheckMs`). */
  reserve(check: RemoteCheck): void {
    if (this.reservation !== null) {
      this.reservation.check = check;
      return;
    }
    this.reservation = { check, timer: null, inflight: null };
    // Callers already queued are refused too: none of them may run while the source is closed.
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      w.reject(this.pending());
    }
    void this.recheck();
  }

  /**
   * Run the reservation's check now (the periodic timer, and tests). A check already running is waited for
   * first, so the answer is always a check that started after the call. Resolves with whether the source opened.
   */
  async recheck(): Promise<boolean> {
    const r = this.reservation;
    if (r === null) return true;
    if (r.inflight !== null) await r.inflight;
    if (this.reservation !== r) return this.reservation === null;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = null;
    const run = (async (): Promise<boolean> => {
      let state: 'gone' | 'running' | 'unknown';
      try {
        state = await r.check();
      } catch {
        state = 'unknown';
      }
      if (this.reservation !== r) return this.reservation === null;
      if (state === 'gone') {
        this.reservation = null;
        this.pump();
        return true;
      }
      r.timer = setTimeout(() => void this.recheck(), this.limits.recheckMs);
      r.timer.unref();
      return false;
    })();
    r.inflight = run;
    try {
      return await run;
    } finally {
      if (r.inflight === run) r.inflight = null;
    }
  }
}

/** The schedulers of one daemon, by source id. */
export class GateSchedulers {
  private readonly by = new Map<string, SourceScheduler>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The scheduler of source `id`, with `limits` applied (created on first use). */
  for(id: string, label: string, limits: SchedulerLimits): SourceScheduler {
    let s = this.by.get(id);
    if (s === undefined) {
      s = new SourceScheduler(limits, label, this.now);
      this.by.set(id, s);
    } else s.setLimits(limits);
    return s;
  }

  get(id: string): SourceScheduler | undefined {
    return this.by.get(id);
  }
}
