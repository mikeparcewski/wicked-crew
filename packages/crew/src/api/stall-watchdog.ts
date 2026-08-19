// Worker stall watchdog (crew#287): platform-native liveness detection for executing runs.
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
// DETECTION ONLY. The watchdog never cancels, mutates, or re-dispatches a run — the operator
// decides. The synthetic frame goes straight to the /ws fan-out, never back through the engine
// relay, so it cannot stamp or re-arm itself.

import type { CoreEvent } from '../core/types.js';
import { DEFAULT_WORKER_STALL_MINUTES } from '../core/types.js';

/**
 * The synthetic /ws frame (crew#287). LOCAL type: `wicked-crew-api-types` 0.6.0 does not name
 * it yet — the contract's permissive `CoreEvent` (index signature; DES-STUDIO-001 §5.1) is what
 * lets it ride the wire to consumers today. NOTE for the next api-types release: add this frame
 * (and `SystemSettings.workerStallMinutes`) to the published contract. A `type` alias on
 * purpose, not an `interface`: only anonymous object types satisfy `CoreEvent`'s index
 * signature, which is what lets the frame flow into the CoreEvent-typed broadcast seam.
 */
export type WorkerStalledFrame = {
  type: 'workerStalled';
  /** The stalled run's id. */
  session: string;
  /** The current unit ord, when any observed event or the run header named one. */
  ord?: number;
  /** How long the run has been silent when the frame fired, ms. */
  quietForMs: number;
};

/** Default sweep cadence — frequent enough that `quietForMs` is at most ~30s stale. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** The slice of a run the sweep needs; the server maps it from `sessionsDetail()`. */
export interface ExecutingRun {
  id: string;
  /** The run's current unit ord when the caller knows it (`session.unit_ix`). */
  ord?: number;
}

export interface StallWatchdogDeps {
  /** Runs whose engine status is `executing`, right now. Read per sweep, never cached. */
  listExecuting: () => Promise<ExecutingRun[]>;
  /** The /ws fan-out for the synthetic frame (`events/bus.ts` `broadcast` in the daemon). */
  broadcast: (frame: WorkerStalledFrame) => void;
  /** Threshold resolver, minutes — read per sweep so a PUT /settings change applies live. */
  stallMinutes?: () => number | Promise<number | undefined> | undefined;
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
      // their silence is not a stall, and a later return to executing starts a fresh clock.
      for (const key of [...this.lastEventAt.keys()]) {
        if (!ids.has(key)) {
          this.lastEventAt.delete(key);
          this.lastOrd.delete(key);
          this.alerted.delete(key);
        }
      }
      const thresholdMs = await this.thresholdMs();
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
        if (quietForMs < thresholdMs || this.alerted.has(run.id)) continue;
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
            `${(quietForMs / 60_000).toFixed(1)} min — workerStalled frame broadcast ` +
            `(detection only: the run was NOT touched; the operator decides)`,
        );
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
}
