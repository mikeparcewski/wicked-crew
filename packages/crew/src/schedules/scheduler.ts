/**
 * The generic workflow scheduler (DES-RUNS-REVIEW-001 §2). Once a minute:
 *
 *  1. TICK HOOKS: work that folds terminal runs (the run review's ingest) gets the status map first.
 *  2. RECONCILE: a schedule's launched run that reached a terminal status records its outcome.
 *  3. LAUNCH: at most ONE due schedule launches. A schedule whose last run is still open is SKIPPED (it never runs
 *     twice at once; its due time stays, so it fires once that run ends); one parked on a person says so and
 *     names the run. Other runs on the daemon never block a launch: it runs several at once, each under its
 *     own budget (crew#1544). A refused launch backs off 2^n hours, at most a day, and a scheduled refusal is also told
 *     to {@link SchedulerDeps.onScheduledRefusal} (the activity trail, crew#1656). Missed intervals coalesce into one run.
 *     (crew#1578) A last run that never got seats (still planning or distributing with none,
 *     {@link STUCK_UNSEATED_MS} after its scheduled launch) never started work: the schedule cancels it, on the run's
 *     own record too, and launches. A last run waiting on a person is never cancelled for them: the row says it is
 *     blocked, since when, on which gate, and how many due times it skipped.
 *
 * The next due time is persisted the moment a launch returns, before any bookkeeping, so a restart can never
 * launch the same interval twice. Sweeps never stack, and Run it now shares their lock.
 */

import { randomUUID } from 'node:crypto';
import type { SessionStatus, SessionView } from 'wicked-crew-api-types';
import { HOUR_MS, blockedDetail, notSchedulable, type ScheduleBlocked, type ScheduleStore, type WorkflowSchedule } from './store.js';

export const DEFAULT_SWEEP_MS = 60_000;
/** A launched run the daemon does not list holds its schedule's slot this long, then lets go. */
export const STALE_LAUNCH_MS = 48 * HOUR_MS;
/** A reservation (the run id chosen before the engine was called) the daemon never lists lets go after this. */
export const RESERVATION_GRACE_MS = 15 * 60_000;
const TERMINAL: ReadonlySet<string> = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);
/** (crew#1578) A scheduled run still unseated this long after its launch never started work: its schedule cancels it. */
export const STUCK_UNSEATED_MS = 6 * HOUR_MS;
/** What the run's own history says when its schedule cancels it (coord, crew#1578). */
export const STUCK_CANCEL_REASON = 'cancelled by its schedule: no seats for 6 h';
const UNSEATED_STATES: ReadonlySet<string> = new Set<SessionStatus>(['planning', 'distributing']);
/** (crew#1578) A cancel that has not answered by now is reported as failed (the sweep never hangs on it). */
export const CANCEL_DEADLINE_MS = 60_000;

/**
 * (crew#1578) The scheduler's `cancel`: the engine cancels the run, then the run's own record says who and why
 * (`run.cancelled` with the reason, which the run's history reads as "stopped the job: <reason>"). A cancel the
 * engine refused records nothing and throws, so the schedule says it failed.
 */
export function cancelOnItsRecord(
  cancelRun: (runId: string) => Promise<string>,
  record: (runId: string, detail: { status: string; reason: string }) => void,
): (runId: string, reason: string) => Promise<string> {
  return async (runId, reason) => {
    const status = await cancelRun(runId);
    // A run that had already ended was not cancelled by its schedule: nothing is recorded as if it were.
    if (status === 'cancelled') record(runId, { status, reason });
    return status;
  };
}

/** Launch one scheduled run under `runId`; resolves to the engine's run id. Throws when the launch is refused. */
export type ScheduledLaunch = (schedule: WorkflowSchedule, runId: string, trigger: 'schedule' | 'manual') => Promise<string>;

export interface SchedulerDeps {
  store: ScheduleStore;
  sessionsDetail: () => Promise<SessionView[]>;
  launch: ScheduledLaunch;
  /** (crew#1578) Cancel a stuck scheduled run, on its own record with `reason`; resolves to the engine's status token
   *  (a run that had already ended answers its end). Absent: a stuck run only blocks. */
  cancel?: (runId: string, reason: string) => Promise<string>;
  /** (crew#1578) One run read from a fold that starts after this call (never a cached snapshot): the check right before
   *  a cancel. Absent: `sessionsDetail` is read again. */
  runViewFresh?: (runId: string) => Promise<SessionView | undefined>;
  /** Called every sweep with the run statuses (the review ingest). Errors are logged, never thrown. */
  onTick?: Array<(status: ReadonlyMap<string, string>) => Promise<void>>;
  /**
   * (crew#1656) Called once per refused SCHEDULED launch (never for Run it now: the person who asked gets the refusal as
   * the answer), after the row recorded it and backed off, so an unattended refusal can be told off the schedule row
   * (the server writes it to the activity trail). Errors are logged, never thrown: the refusal is already recorded.
   */
  onScheduledRefusal?: (row: WorkflowSchedule, reason: string) => void;
  log: (msg: string) => void;
  now?: () => Date;
}

export class ScheduleBusyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private sweeping = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs = DEFAULT_SWEEP_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Serialize with every other sweep and Run it now. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** One sweep. Never throws; a sweep already running is not stacked. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.exclusive(async () => {
        const { status, seats } = await this.readRuns();
        await this.tick(status);
        this.reconcile(status);
        await this.launchDue(status, seats);
      });
    } catch (err) {
      this.deps.log(`[schedules] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async tick(status: ReadonlyMap<string, string>): Promise<void> {
    for (const hook of this.deps.onTick ?? []) {
      try {
        await hook(status);
      } catch (err) {
        this.deps.log(`[schedules] tick hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Every run's status, and how many seats each has (crew#1578: a run with none never started work). */
  private async readRuns(): Promise<{ status: Map<string, string>; seats: Map<string, number> }> {
    const views = await this.deps.sessionsDetail();
    return {
      status: new Map(views.map((v) => [v.session.id, String(v.session.status)])),
      // A seat list the daemon cannot read is never "no seats" (-1): only a known empty list makes a run stuck.
      seats: new Map(views.map((v) => [v.session.id, Array.isArray(v.session.clis) ? v.session.clis.length : -1])),
    };
  }

  /**
   * (crew#1578) Cancel the row's last run when it is stuck: listed, still planning or distributing, with no seats,
   * {@link STUCK_UNSEATED_MS} after its scheduled launch. Only the row's own launched run, only in that shape. On a
   * cancel, `status` (this sweep's copy) records it so the row launches now. Returns why it could not, or null.
   */
  private async cancelIfStuck(row: WorkflowSchedule, status: Map<string, string>, seats: ReadonlyMap<string, number>): Promise<string | null> {
    const stuck = (st: ReadonlyMap<string, string>, se: ReadonlyMap<string, number>): boolean => {
      if (row.lastRunId === null || row.lastOutcome !== 'launched' || row.lastRunAt === null) return false;
      const launchedAt = Date.parse(row.lastRunAt);
      const s = st.get(row.lastRunId);
      return Number.isFinite(launchedAt) && this.now().getTime() - launchedAt >= STUCK_UNSEATED_MS && s !== undefined && UNSEATED_STATES.has(s) && se.get(row.lastRunId) === 0;
    };
    if (this.deps.cancel === undefined || !stuck(status, seats)) return null;
    const runId = row.lastRunId as string;
    // Still this row's run (codex r2 #2): a schedule replaced meanwhile is not cancelled for.
    const ours = (): boolean => {
      const cur = this.deps.store.get(row.id);
      return cur !== undefined && cur.createdAt === row.createdAt && cur.lastRunId === runId && cur.lastOutcome === 'launched';
    };
    // Read again right before the cancel, from a fold that starts now (codex r1 #1, r2 #1): a run that got seats or
    // moved on is left alone. The engine's cancel is unconditional, so a change inside this one call's window is not caught.
    let fresh: { status: Map<string, string>; seats: Map<string, number> };
    if (this.deps.runViewFresh !== undefined) {
      const v = await this.deps.runViewFresh(runId);
      fresh = {
        status: new Map(v === undefined ? [] : [[runId, String(v.session.status)]]),
        seats: new Map(v === undefined ? [] : [[runId, Array.isArray(v.session.clis) ? v.session.clis.length : -1]]),
      };
    } else {
      fresh = await this.readRuns();
    }
    if (!stuck(fresh.status, fresh.seats) || !ours()) {
      const s = fresh.status.get(runId);
      if (s !== undefined) status.set(runId, s);
      return null;
    }
    let ended: string;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${CANCEL_DEADLINE_MS / 1000} s`)), CANCEL_DEADLINE_MS);
      });
      try {
        ended = await Promise.race([this.deps.cancel(runId, STUCK_CANCEL_REASON), deadline]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return `its last run ${runId} has had no seats for 6 h and cancelling it failed (${err instanceof Error ? err.message : String(err)})`;
    }
    status.set(runId, ended);
    if (!ours()) return null;
    if (ended === 'cancelled') {
      this.deps.store.update(row.id, { lastOutcome: 'cancelled', lastNote: `its last run ${runId} was ${STUCK_CANCEL_REASON}`, blocked: null }, this.now());
      this.deps.log(`[schedules] ${row.id}: ${runId} ${STUCK_CANCEL_REASON}`);
    } else if (TERMINAL.has(ended)) {
      // It ended on its own first: its real end is the outcome, never a cancel by the schedule.
      this.deps.store.update(row.id, { lastOutcome: ended as 'completed' | 'failed', blocked: null }, this.now());
    } else {
      return `its last run ${runId} has had no seats for 6 h and the engine answered "${ended}" to the cancel`;
    }
    return null;
  }

  /** (crew#1578) Bring every row's waiting-on-you record up to date: set when its last run waits on a person,
   *  cleared when it no longer does. Only the structured `blocked` field: `lastNote` keeps the words every shipped
   *  studio renders (`skipped: …`, written when a due time is skipped), so an older studio still shows the warning
   *  (coord merge check on #1617). */
  private noteBlocked(status: ReadonlyMap<string, string>): void {
    for (const r of this.deps.store.list()) {
      const b = this.blockedOnYou(r, status);
      if (b !== null) {
        if (r.blocked?.since !== b.since || r.blocked.missedDue !== b.missedDue || r.blocked.runId !== b.runId || r.blocked.detail !== b.detail) {
          this.deps.store.update(r.id, { blocked: b }, this.now());
        }
      } else if (r.blocked != null) {
        this.deps.store.update(r.id, { blocked: null }, this.now());
      }
    }
  }

  /** (crew#1578) The row's "blocked on your decision" record while its last run waits on a person, else null. */
  private blockedOnYou(row: WorkflowSchedule, status: ReadonlyMap<string, string>): ScheduleBlocked | null {
    if (row.lastRunId === null || status.get(row.lastRunId) !== 'awaiting_human') return null;
    const nowMs = this.now().getTime();
    // Since: first seen waiting (every sweep looks, due or not). A skipped row keeps its due time ("skipped, not
    // moved"), so the due times it skipped while waiting are those from `since` to now.
    const since = row.blocked?.runId === row.lastRunId && Number.isFinite(Date.parse(row.blocked.since)) ? row.blocked.since : this.now().toISOString();
    const every = row.everyHours * HOUR_MS;
    const due0 = Date.parse(row.nextDueAt);
    const sinceMs = Date.parse(since);
    const first = sinceMs <= due0 ? due0 : due0 + Math.ceil((sinceMs - due0) / every) * every;
    const missedDue = Number.isFinite(first) && first <= nowMs ? Math.floor((nowMs - first) / every) + 1 : 0;
    return {
      reason: 'awaiting_human',
      runId: row.lastRunId,
      since,
      missedDue,
      target: { kind: 'run', runId: row.lastRunId },
      detail: blockedDetail(row.lastRunId, since, missedDue),
    };
  }

  private reconcile(status: ReadonlyMap<string, string>): void {
    for (const row of this.deps.store.list()) {
      if (row.lastRunId === null || (row.lastOutcome !== 'launched' && row.lastOutcome !== 'launching')) continue;
      const s = status.get(row.lastRunId);
      if (s !== undefined && TERMINAL.has(s)) this.deps.store.update(row.id, { lastOutcome: s as 'completed' | 'failed' | 'cancelled', blocked: null }, this.now());
      // A reservation the engine took (the daemon stopped before recording it): it is a launched run.
      else if (s !== undefined && row.lastOutcome === 'launching') this.deps.store.update(row.id, { lastOutcome: 'launched' }, this.now());
    }
  }

  /** Why `row` may not launch now, or `null`. */
  private blocker(row: WorkflowSchedule, status: ReadonlyMap<string, string>): string | null {
    // A row saved before its workflow was refused for schedules (J6 K1): it never fires, and says why.
    const never = notSchedulable(row.workflow);
    if (never !== null) return never;
    if (row.lastRunId !== null && (row.lastOutcome === 'launched' || row.lastOutcome === 'launching')) {
      const s = status.get(row.lastRunId);
      // A run the daemon does not list yet holds the slot: a launched one for two days, a reservation the engine
      // may never have seen for a few minutes.
      const hold = row.lastOutcome === 'launching' ? RESERVATION_GRACE_MS : STALE_LAUNCH_MS;
      const open = s !== undefined ? !TERMINAL.has(s) : row.lastRunAt !== null && this.now().getTime() - Date.parse(row.lastRunAt) < hold;
      if (open) return s === 'awaiting_human' ? `its last run ${row.lastRunId} is waiting on you (awaiting_human)` : 'its last run is still going';
    }
    return null;
  }

  private async launchDue(observed: ReadonlyMap<string, string>, seats: ReadonlyMap<string, number>): Promise<void> {
    const status = new Map(observed);
    // A stuck run is cancelled 6 h after its launch, due or not (codex r1 #10); a failed cancel says so on the row.
    const cancelFailed = new Map<string, string>();
    for (const r of this.deps.store.list().filter((x) => x.enabled)) {
      const failed = await this.cancelIfStuck(r, status, seats);
      if (failed !== null) {
        cancelFailed.set(r.id, failed);
        const now = this.deps.store.get(r.id);
        if (now !== undefined && now.lastNote !== `skipped: ${failed}`) this.deps.store.update(r.id, { lastNote: `skipped: ${failed}` }, this.now());
      }
    }
    this.noteBlocked(status);
    const nowMs = this.now().getTime();
    const due = this.deps.store.list().filter((r) => r.enabled && Date.parse(r.nextDueAt) <= nowMs);
    for (const row of due) {
      const current = this.deps.store.get(row.id) ?? row;
      const why = cancelFailed.get(row.id) ?? this.blocker(current, status);
      if (why === null) {
        // A refusal is recorded (and backed off) by launchOne; the sweep itself carries on.
        await this.launchOne(current, 'schedule').catch(() => undefined);
        return; // at most one launch per sweep
      }
      // Skipped, not moved: it fires on the first sweep after the blocker clears. Said once, not every minute, in the
      // words main writes (a shipped studio renders a `skipped` note; the structured `blocked` field is the new detail).
      if (current.lastNote !== `skipped: ${why}`) this.deps.store.update(row.id, { lastNote: `skipped: ${why}` }, this.now());
    }
  }

  /** "Run it now": the same guards as a sweep, minus "is it due". Resolves to the run id. */
  async runNow(id: string): Promise<string> {
    return this.exclusive(async () => {
      if (this.deps.store.get(id) === undefined) throw new Error(`no schedule ${id}`);
      const { status, seats } = await this.readRuns();
      // What a sweep would fold first (agy r1): a review that ended since the last tick is ingested, so this run's
      // window starts where that one ended rather than re-reviewing it.
      await this.tick(status);
      this.reconcile(status);
      const cancelFailed = await this.cancelIfStuck(this.deps.store.get(id) as WorkflowSchedule, status, seats);
      // The row says what Run it now found (codex r1 #13), as a sweep would.
      if (cancelFailed !== null) this.deps.store.update(id, { lastNote: `skipped: ${cancelFailed}` }, this.now());
      this.noteBlocked(status);
      const row = this.deps.store.get(id) as WorkflowSchedule;
      const why = cancelFailed ?? this.blocker(row, status);
      if (why !== null) throw new ScheduleBusyError(`not started: ${why}`);
      return this.launchOne(row, 'manual');
    });
  }

  private async launchOne(row: WorkflowSchedule, trigger: 'schedule' | 'manual'): Promise<string> {
    const now = this.now();
    const reserved = randomUUID();
    // RESERVED before the engine is called (codex r1): a daemon that dies after the engine accepted the run but
    // before the bookkeeping below restarts with this run id already holding the slot, so it never launches the
    // same interval twice. A reservation the engine never saw lets go after RESERVATION_GRACE_MS.
    this.deps.store.update(
      row.id,
      {
        lastRunId: reserved,
        lastRunAt: now.toISOString(),
        lastOutcome: 'launching',
        nextDueAt: new Date(now.getTime() + row.everyHours * HOUR_MS).toISOString(),
      },
      now,
    );
    let runId: string;
    try {
      runId = await this.deps.launch(row, reserved, trigger);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failures = row.failures + 1;
      this.deps.store.update(
        row.id,
        {
          failures,
          lastOutcome: 'refused',
          lastNote: message.slice(0, 500),
          // The reservation is released: nothing runs under it.
          lastRunId: row.lastRunId,
          lastRunAt: row.lastRunAt,
          // A scheduled refusal backs off; Run it now leaves the cadence where it was.
          nextDueAt: trigger === 'schedule' ? new Date(now.getTime() + Math.min(2 ** failures, 24) * HOUR_MS).toISOString() : row.nextDueAt,
        },
        now,
      );
      this.deps.log(`[schedules] ${row.id} launch refused (${failures}): ${message}`);
      if (trigger === 'schedule') {
        try {
          this.deps.onScheduledRefusal?.(row, message);
        } catch (hookErr) {
          this.deps.log(`[schedules] ${row.id}: telling its refusal failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
        }
      }
      throw err;
    }
    // Recorded FIRST: the next due time and the slot are durable before anything else can fail.
    this.deps.store.update(
      row.id,
      {
        lastRunId: runId,
        lastRunAt: now.toISOString(),
        lastOutcome: 'launched',
        lastNote: null,
        blocked: null,
        failures: 0,
        nextDueAt: new Date(now.getTime() + row.everyHours * HOUR_MS).toISOString(),
      },
      now,
    );
    this.deps.log(`[schedules] ${row.id} (${trigger}) → ${row.workflow} ${runId}`);
    return runId;
  }
}
