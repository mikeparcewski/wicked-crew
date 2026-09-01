// Worker stall watchdog (crew#287 detection + crew#341 escalation): platform-native liveness
// for executing runs, and — opt-in — recovery when liveness is gone.
//
// A wedged worker emits nothing — no unitOutputDelta, no gate frames — and its run sits in
// `executing` until an operator notices by absence (run 8aa1cd42: a design unit burned 3+ hours
// with zero output before anyone looked). The daemon already observes every engine event on its
// single CoreEvent relay, so "time since the last event" is cheap to compute right here:
//
// - `ingest` stamps the run's last-observed-event time on EVERY frame carrying a `session`
//   (any CoreEvent counts, `unitOutputDelta` included) and RE-ARMS the alert for that run.
// - a periodic sweep lists the runs whose engine status is `executing` (`awaiting_human` is
//   quiet BY DESIGN and never counts) and, when a run has been silent past the threshold
//   (`workerStallMinutes` setting, default 15), broadcasts ONE synthetic frame on /ws —
//   `{ type: "workerStalled", session, ord?, quietForMs }` — and logs it at warn.
// - once per quiet period: after the frame fires, the run stays alerted until a NEW event for
//   it arrives; a second quiet period then emits a second frame.
//
// THE ESCALATION LADDER (crew#341) — detection now drives action, but only when armed:
//
//   notify (always)  →  act (opt-in, `workerStallEscalateMinutes` > 0)  →  fail loud
//
// - OFF BY DEFAULT. The issue's design: automatic recovery on a run that is merely slow rather
//   than wedged would be worse than the wedge. `workerStallEscalateMinutes` absent/0 keeps the
//   watchdog detection-only — bit-for-bit the crew#287 behaviour.
// - When armed, a run still silent past the escalation threshold (never before the detection
//   threshold — the ladder notifies before it acts) gets ONE escalation per quiet period:
//   - action `reassign` (default): recycle the wedged cursor unit IN PLACE via the engine's
//     `reassignUnit` — the stale turn is superseded (not folded as a failure), the worker
//     session closed, the attempt bumped, the unit re-dispatched to the same seat; queued
//     operator injects survive into the fresh turn. This is both of crew#341's candidate
//     recoveries in one primitive.
//   - action `notify`: the fail-loud rung — surface a `needsYou` frame + an audit entry and
//     leave the run alone.
// - A per-run budget (`workerStallMaxEscalations`, default 2) caps AUTOMATIC reassigns: a
//   worker that wedges deterministically must reach a human, not loop through re-dispatches
//   forever. A spent budget answers further quiet periods with `outcome: "exhausted"`.
// - Every escalation is REPORTED on its own distinctly-named /ws frame —
//   `workerStallEscalated` (`workerStalled` is already two producers deep: the daemon's
//   synthetic detection frame AND the engine's PTY-path event) — and AUDITED via the crew
//   audit trail (`run.stall.escalated`), because an automated actor touching a run is a
//   privileged action exactly like an operator doing it.
//
// The synthetic frames go straight to the /ws fan-out, never back through the engine relay, so
// they cannot stamp or re-arm the watchdog themselves. A SUCCESSFUL reassign, by contrast,
// makes the engine emit real events (workerSessionClosed, unitReassigned, unitDispatched, …),
// which restamp the clock and re-arm both stages — a re-wedged fresh turn walks the same ladder
// with the remaining budget.

import type { CoreEvent, WorkerStallEscalatedFrame, WorkerStalledFrame } from '../core/types.js';
import {
  DEFAULT_WORKER_STALL_ESCALATE_ACTION,
  DEFAULT_WORKER_STALL_MAX_ESCALATIONS,
  DEFAULT_WORKER_STALL_MINUTES,
} from '../core/types.js';

// Published contract shapes (api-types 0.18.0 — previously daemon-local here). Re-exported so
// existing importers of this module keep compiling.
export type { WorkerStalledFrame, WorkerStallEscalatedFrame };

/** Default sweep cadence — frequent enough that `quietForMs` is at most ~30s stale. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** Bound on the `error` excerpt an escalation frame / audit entry carries. */
const ESCALATION_ERROR_EXCERPT_CHARS = 300;

/** The slice of a run the sweep needs; the server maps it from `sessionsDetail()`. */
export interface ExecutingRun {
  id: string;
  /** The run's CURSOR unit ord when the caller knows it — what `reassignUnit` must name. */
  ord?: number;
  /** The cursor unit's assigned seat, for reassign-in-place. Absent = let the council pick. */
  cli?: string;
}

/**
 * The escalation stage's per-sweep configuration (crew#341), resolved live so a PUT /settings
 * change applies without a restart. `minutes` absent/0/invalid = escalation OFF (the default).
 */
export interface StallEscalationConfig {
  /** Quiet minutes before the watchdog ACTS. Clamped to at least the detection threshold. */
  minutes?: number | undefined;
  /** What an armed escalation does (default `reassign`). */
  action?: 'reassign' | 'notify' | undefined;
  /** Automatic reassigns per run before fail-loud (default 2; clamped to ≥ 1). */
  maxPerRun?: number | undefined;
}

export interface StallWatchdogDeps {
  /** Runs whose engine status is `executing`, right now. Read per sweep, never cached. */
  listExecuting: () => Promise<ExecutingRun[]>;
  /** The /ws fan-out for the synthetic frames (`events/bus.ts` `broadcast` in the daemon). */
  broadcast: (frame: WorkerStalledFrame | WorkerStallEscalatedFrame) => void;
  /** Threshold resolver, minutes — read per sweep so a PUT /settings change applies live. */
  stallMinutes?: () => number | Promise<number | undefined> | undefined;
  /**
   * The escalation stage (crew#341). Absent = the watchdog is detection-only (crew#287),
   * regardless of settings — a server that does not wire recovery cannot perform it.
   */
  escalation?: {
    /** Resolved per sweep; `minutes` absent/0/invalid keeps escalation OFF. */
    config: () => StallEscalationConfig | undefined | Promise<StallEscalationConfig | undefined>;
    /**
     * Recycle the wedged cursor unit in place (the daemon wires `adapter.reassignUnit`).
     * `cli` set = re-dispatch to the same seat; absent = the engine re-runs the council.
     */
    reassign: (runId: string, ord: number, cli?: string) => Promise<void>;
    /** Audit sink — the server appends `run.stall.escalated` to the crew audit trail. */
    audit?: (frame: WorkerStallEscalatedFrame) => void;
  };
  /** Clock (tests stub it). */
  now?: () => number;
  /** Wired to the daemon's warn logger — a stall is an operator-attention signal. */
  log?: (m: string) => void;
}

export class WorkerStallWatchdog {
  /** run id → epoch ms of the last engine event observed for it (or the seed, see sweep). */
  private readonly lastEventAt = new Map<string, number>();
  /** run id → last unit ord any of its events named. */
  private readonly lastOrd = new Map<string, number>();
  /** Runs already alerted for the CURRENT quiet period (cleared by any new event). */
  private readonly alerted = new Set<string>();
  /** Runs already escalated for the CURRENT quiet period (cleared by any new event). */
  private readonly escalated = new Set<string>();
  /** run id → automatic reassigns consumed (the crew#341 budget). Pruned with the run. */
  private readonly escalationCount = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private handle: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly deps: StallWatchdogDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((): void => undefined);
  }

  /** Fold one relay frame: any event for a run is proof of life — stamp its clock and RE-ARM. */
  ingest(event: CoreEvent): void {
    const session =
      typeof event.session === 'string' && event.session.length > 0 ? event.session : undefined;
    if (session === undefined) return;
    this.lastEventAt.set(session, this.now());
    if (typeof event.ord === 'number') this.lastOrd.set(session, event.ord);
    this.alerted.delete(session);
    this.escalated.delete(session);
  }

  /** One detection pass. Public so tests drive it directly; the armed interval calls it too. */
  async sweep(): Promise<void> {
    if (this.sweeping) return; // a slow engine read must never stack sweeps
    this.sweeping = true;
    try {
      let executing: ExecutingRun[];
      try {
        executing = await this.deps.listExecuting();
      } catch (err) {
        this.log(`[stall-watchdog] run listing failed, skipping sweep: ${String(err)}`);
        return;
      }
      const ids = new Set(executing.map((r) => r.id));
      // Prune state for runs no longer executing (completed / cancelled / awaiting_human):
      // their silence is not a stall, and a later return to executing starts a fresh clock —
      // and a fresh escalation budget (the run left the wedge; a NEW wedge is a new fact).
      for (const key of [...this.lastEventAt.keys()]) {
        if (!ids.has(key)) {
          this.lastEventAt.delete(key);
          this.lastOrd.delete(key);
          this.alerted.delete(key);
          this.escalated.delete(key);
          this.escalationCount.delete(key);
        }
      }
      const thresholdMs = await this.thresholdMs();
      const escalation = await this.escalationArmed(thresholdMs);
      const now = this.now();
      for (const run of executing) {
        const last = this.lastEventAt.get(run.id);
        if (last === undefined) {
          // First observation with no event on record — e.g. the run was already executing
          // (and possibly already wedged) before this daemon booted. Silence before the relay
          // existed is unknowable, so the quiet clock starts HERE; the threshold still trips
          // one full quiet period later, which is exactly the restart-survival the issue asks.
          this.lastEventAt.set(run.id, now);
          continue;
        }
        const quietForMs = now - last;
        // ── stage 1: detect + notify (crew#287, always on) ──────────────────────────────
        if (quietForMs >= thresholdMs && !this.alerted.has(run.id)) {
          this.alerted.add(run.id);
          const ord = this.lastOrd.get(run.id) ?? run.ord;
          this.deps.broadcast({
            type: 'workerStalled',
            session: run.id,
            ...(ord !== undefined ? { ord } : {}),
            quietForMs,
          });
          this.log(
            `[stall-watchdog] run ${run.id}${ord !== undefined ? ` (unit ${ord})` : ''} silent for ` +
              `${(quietForMs / 60_000).toFixed(1)} min — workerStalled frame broadcast` +
              (escalation === undefined
                ? ` (detection only: the run was NOT touched; the operator decides)`
                : ` (escalation armed at ${(escalation.thresholdMs / 60_000).toFixed(1)} min)`),
          );
        }
        // ── stage 2: act (crew#341, opt-in) — never before stage 1's threshold ──────────
        if (
          escalation !== undefined &&
          quietForMs >= escalation.thresholdMs &&
          !this.escalated.has(run.id)
        ) {
          this.escalated.add(run.id);
          await this.escalate(run, quietForMs, escalation);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Arm the periodic sweep. Unref'd — the daemon's server lifecycle owns shutdown. */
  start(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        this.log(`[stall-watchdog] sweep failed: ${String(err)}`);
      });
    }, intervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle !== null) clearInterval(this.handle);
    this.handle = null;
  }

  /** Threshold in ms — an unset/invalid setting falls back to the 15-minute default. */
  private async thresholdMs(): Promise<number> {
    let minutes: number | undefined;
    try {
      minutes = await this.deps.stallMinutes?.();
    } catch (err) {
      this.log(`[stall-watchdog] threshold read failed, using default: ${String(err)}`);
      minutes = undefined;
    }
    const m =
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_WORKER_STALL_MINUTES;
    return m * 60_000;
  }

  /**
   * Resolve the escalation stage for THIS sweep, or `undefined` while it is off. Fail-safe on
   * a throwing config read: acting on a run is exactly the wrong response to uncertainty, so a
   * failed read logs and keeps this sweep detection-only.
   */
  private async escalationArmed(detectMs: number): Promise<
    | {
        thresholdMs: number;
        action: 'reassign' | 'notify';
        maxPerRun: number;
      }
    | undefined
  > {
    if (this.deps.escalation === undefined) return undefined;
    let cfg: StallEscalationConfig | undefined;
    try {
      cfg = await this.deps.escalation.config();
    } catch (err) {
      this.log(
        `[stall-watchdog] escalation config read failed, staying detection-only this sweep: ${String(err)}`,
      );
      return undefined;
    }
    const minutes = cfg?.minutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      return undefined; // OFF — the crew#341 default
    }
    const action = cfg?.action === 'notify' ? 'notify' : DEFAULT_WORKER_STALL_ESCALATE_ACTION;
    const rawMax = cfg?.maxPerRun;
    const maxPerRun =
      typeof rawMax === 'number' && Number.isFinite(rawMax) && Math.floor(rawMax) >= 1
        ? Math.floor(rawMax)
        : DEFAULT_WORKER_STALL_MAX_ESCALATIONS;
    // The ladder notifies before it acts: an escalation threshold set below the detection
    // threshold acts AT the detection threshold, never before it.
    return { thresholdMs: Math.max(minutes * 60_000, detectMs), action, maxPerRun };
  }

  /** Perform one escalation for `run`, emit its `workerStallEscalated` frame, audit, log. */
  private async escalate(
    run: ExecutingRun,
    quietForMs: number,
    escalation: { action: 'reassign' | 'notify'; maxPerRun: number },
  ): Promise<void> {
    // Prefer the cursor ord read from the engine THIS sweep (`run.ord`) over the last event's
    // ord: `reassignUnit` validates against the live cursor, and events can predate a rework.
    const ord = run.ord ?? this.lastOrd.get(run.id);
    const base = {
      type: 'workerStallEscalated' as const,
      session: run.id,
      ...(ord !== undefined ? { ord } : {}),
      quietForMs,
    };
    let frame: WorkerStallEscalatedFrame;
    if (escalation.action === 'notify') {
      // The fail-loud rung: surface for a human, touch nothing. No budget — notifying is free.
      frame = { ...base, action: 'notify', outcome: 'ok', needsYou: true };
    } else {
      const used = this.escalationCount.get(run.id) ?? 0;
      if (used >= escalation.maxPerRun) {
        frame = {
          ...base,
          action: 'reassign',
          outcome: 'exhausted',
          needsYou: true,
          escalations: used,
        };
      } else if (ord === undefined) {
        // Cannot name the cursor unit — the engine would reject any ord we invent. Loud, no
        // budget consumed: nothing was attempted.
        frame = {
          ...base,
          action: 'reassign',
          outcome: 'failed',
          needsYou: true,
          escalations: used,
          error: 'cursor unit unknown: the run listing carried no ord for this run',
        };
      } else {
        // Budget is consumed by the ATTEMPT, success or not — a rejecting engine call must not
        // be retried indefinitely on the platform's own initiative.
        this.escalationCount.set(run.id, used + 1);
        try {
          await this.deps.escalation?.reassign(run.id, ord, run.cli);
          frame = {
            ...base,
            action: 'reassign',
            outcome: 'ok',
            needsYou: false,
            escalations: used + 1,
            ...(run.cli !== undefined ? { cli: run.cli } : {}),
          };
        } catch (err) {
          frame = {
            ...base,
            action: 'reassign',
            outcome: 'failed',
            needsYou: true,
            escalations: used + 1,
            error: String(err instanceof Error ? err.message : err).slice(
              0,
              ESCALATION_ERROR_EXCERPT_CHARS,
            ),
          };
        }
      }
    }
    this.deps.broadcast(frame);
    try {
      this.deps.escalation?.audit?.(frame);
    } catch (err) {
      this.log(`[stall-watchdog] escalation audit sink failed: ${String(err)}`);
    }
    const where = `run ${run.id}${ord !== undefined ? ` (unit ${ord})` : ''}`;
    const quiet = `${(quietForMs / 60_000).toFixed(1)} min silent`;
    if (frame.action === 'notify') {
      this.log(
        `[stall-watchdog] ESCALATED ${where}: ${quiet} — action notify (fail-loud): ` +
          `needs-you frame broadcast, the run was NOT touched`,
      );
    } else if (frame.outcome === 'ok') {
      this.log(
        `[stall-watchdog] ESCALATED ${where}: ${quiet} — reassigned in place` +
          `${run.cli !== undefined ? ` (seat ${run.cli})` : ''} ` +
          `(automatic recovery ${frame.escalations}/${escalation.maxPerRun}; the stale turn is ` +
          `superseded and the unit re-dispatched)`,
      );
    } else if (frame.outcome === 'exhausted') {
      this.log(
        `[stall-watchdog] ESCALATION EXHAUSTED for ${where}: ${quiet} and the per-run budget ` +
          `(${escalation.maxPerRun}) is spent — needs-you frame broadcast; a human must intervene`,
      );
    } else {
      this.log(
        `[stall-watchdog] ESCALATION FAILED for ${where}: ${quiet} — reassign was attempted but ` +
          `did not take (${frame.error ?? 'unknown error'}); needs-you frame broadcast`,
      );
    }
  }
}
