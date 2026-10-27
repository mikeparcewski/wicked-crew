/**
 * The generic workflow scheduler (DES-RUNS-REVIEW-001 §2). Once a minute:
 *
 *  1. TICK HOOKS: work that folds terminal runs (the run review's ingest) gets the status map first.
 *  2. RECONCILE: a schedule's launched run that reached a terminal status records its outcome.
 *  3. LAUNCH: at most ONE due schedule launches. A schedule whose last run is still open is SKIPPED (it never runs
 *     twice at once; its due time stays, so it fires once that run ends). Nothing launches while any run is
 *     planning, distributing or executing (one governed run at a time; one parked on a person is not busy).
 *     A refused launch backs off 2^n hours, at most a day. Missed intervals coalesce into one run.
 *
 * The next due time is persisted the moment a launch returns, before any bookkeeping, so a restart can never
 * launch the same interval twice. Sweeps never stack, and Run it now shares their lock.
 */

import { randomUUID } from 'node:crypto';
import type { SessionStatus, SessionView } from 'wicked-crew-api-types';
import { HOUR_MS, type ScheduleStore, type WorkflowSchedule } from './store.js';

export const DEFAULT_SWEEP_MS = 60_000;
/** A launched run the daemon does not list holds its schedule's slot this long, then lets go. */
export const STALE_LAUNCH_MS = 48 * HOUR_MS;
const BUSY: ReadonlySet<string> = new Set<SessionStatus>(['planning', 'distributing', 'executing']);
const TERMINAL: ReadonlySet<string> = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);

/** Launch one scheduled run under `runId`; resolves to the engine's run id. Throws when the launch is refused. */
export type ScheduledLaunch = (schedule: WorkflowSchedule, runId: string, trigger: 'schedule' | 'manual') => Promise<string>;

export interface SchedulerDeps {
  store: ScheduleStore;
  sessionsDetail: () => Promise<SessionView[]>;
  launch: ScheduledLaunch;
  /** Called every sweep with the run statuses (the review ingest). Errors are logged, never thrown. */
  onTick?: Array<(status: ReadonlyMap<string, string>) => Promise<void>>;
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
        const status = await this.statusMap();
        for (const hook of this.deps.onTick ?? []) {
          try {
            await hook(status);
          } catch (err) {
            this.deps.log(`[schedules] tick hook failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.reconcile(status);
        await this.launchDue(status);
      });
    } catch (err) {
      this.deps.log(`[schedules] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async statusMap(): Promise<Map<string, string>> {
    const views = await this.deps.sessionsDetail();
    return new Map(views.map((v) => [v.session.id, String(v.session.status)]));
  }

  private reconcile(status: ReadonlyMap<string, string>): void {
    for (const row of this.deps.store.list()) {
      if (row.lastRunId === null || row.lastOutcome !== 'launched') continue;
      const s = status.get(row.lastRunId);
      if (s !== undefined && TERMINAL.has(s)) this.deps.store.update(row.id, { lastOutcome: s as 'completed' | 'failed' | 'cancelled' }, this.now());
    }
  }

  /** Why `row` may not launch now, or `null`. */
  private blocker(row: WorkflowSchedule, status: ReadonlyMap<string, string>): string | null {
    if (row.lastRunId !== null && row.lastOutcome === 'launched') {
      const s = status.get(row.lastRunId);
      const open = s !== undefined ? !TERMINAL.has(s) : row.lastRunAt !== null && this.now().getTime() - Date.parse(row.lastRunAt) < STALE_LAUNCH_MS;
      if (open) return 'its last run is still going';
    }
    if ([...status.values()].some((s) => BUSY.has(s))) return 'another run is working (one governed run at a time)';
    return null;
  }

  private async launchDue(status: ReadonlyMap<string, string>): Promise<void> {
    const nowMs = this.now().getTime();
    const due = this.deps.store.list().filter((r) => r.enabled && Date.parse(r.nextDueAt) <= nowMs);
    for (const row of due) {
      const why = this.blocker(row, status);
      if (why === null) {
        // A refusal is recorded (and backed off) by launchOne; the sweep itself carries on.
        await this.launchOne(row, 'schedule').catch(() => undefined);
        return; // at most one launch per sweep
      }
      // Skipped, not moved: it fires on the first sweep after the blocker clears. Said once, not every minute.
      if (row.lastNote !== `skipped: ${why}`) this.deps.store.update(row.id, { lastNote: `skipped: ${why}` }, this.now());
    }
  }

  /** "Run it now": the same guards as a sweep, minus "is it due". Resolves to the run id. */
  async runNow(id: string): Promise<string> {
    return this.exclusive(async () => {
      const row = this.deps.store.get(id);
      if (row === undefined) throw new Error(`no schedule ${id}`);
      const why = this.blocker(row, await this.statusMap());
      if (why !== null) throw new ScheduleBusyError(`not started: ${why}`);
      return this.launchOne(row, 'manual');
    });
  }

  private async launchOne(row: WorkflowSchedule, trigger: 'schedule' | 'manual'): Promise<string> {
    const now = this.now();
    let runId: string;
    try {
      runId = await this.deps.launch(row, randomUUID(), trigger);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failures = row.failures + 1;
      this.deps.store.update(
        row.id,
        {
          failures,
          lastOutcome: 'refused',
          lastNote: message.slice(0, 500),
          // A scheduled refusal backs off; Run it now leaves the cadence alone.
          ...(trigger === 'schedule' ? { nextDueAt: new Date(now.getTime() + Math.min(2 ** failures, 24) * HOUR_MS).toISOString() } : {}),
        },
        now,
      );
      this.deps.log(`[schedules] ${row.id} launch refused (${failures}): ${message}`);
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
        failures: 0,
        nextDueAt: new Date(now.getTime() + row.everyHours * HOUR_MS).toISOString(),
      },
      now,
    );
    this.deps.log(`[schedules] ${row.id} (${trigger}) → ${row.workflow} ${runId}`);
    return runId;
  }
}
