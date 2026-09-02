// Seat health (crew#274): runtime health per council seat, folded from the live CoreEvent stream.
//
// The operator doctrine this implements (recorded in ~/.config/wicked-council/clis.toml): every
// CLI seat stays LISTED and ENABLED in config — quota/auth/runtime errors are RUNTIME state the
// platform detects and DISPLAYS (`inactive` + the error excerpt), never a hand-edited disable.
// The old pattern left stale disables behind: quotas that had long reset, and an "out of credits"
// comment masking what had become a `401 Unauthorized` needing a re-login.
//
// The fold (one rule per event, shared by every caller — the gate-cache posture):
//
// - `stepFailed` marks the seat INACTIVE when the failure is seat-level: `failureKind:
//   "workerError"` (the CLI process itself failed — crew#277 asks exactly this stamp), or a
//   `detail` naming the wrapped runner's "(cli `x` exited N)" message, an ACP "timeout waiting",
//   or an auth/quota string (401/unauthorized/quota/rate-limit/credits). The seat is read from
//   the detail when it names one, else from the unit's `unitDistributed` assignment.
// - `acpFallback` is NOT alone inactive — `session_died` falls back to single-shot and the unit
//   can still succeed — but REPEATED fallback (3+ in 10 minutes) is a seat that cannot hold a
//   session, and that is. `governance_requires_wrapped` is deliberate routing, not a failure,
//   and never counts.
// - `unitOutputCaptured` with `stepStatus: "ok"` marks the assigned seat ACTIVE again and clears
//   the message (the event carries no seat, so `unitDistributed`/`unitReassigned` are folded
//   into a per-unit assignment map for the correlation).
//
// Recovery without an ok output comes from `startSeatHealthProbe`: every `intervalMs` (default
// 10 minutes), INACTIVE seats only, run the seat's `version_probe` command with a short timeout;
// exit 0 flips the seat active. Active seats are never probed — this is a recovery path, not a
// monitor.

import type { CoreEvent, SeatHealth } from '../core/types.js';
import { execCapped } from '../core/exec.js';
import {
  DaemonSignalLog,
  SIGNAL_CORRELATION_WINDOW_MS,
} from '../core/daemon-signal-log.js';

export type { SeatHealth };

/** Rolling window for the repeated-acpFallback rule. */
export const FALLBACK_WINDOW_MS = 10 * 60 * 1000;
/** Fallbacks within the window that flip a seat inactive. */
export const FALLBACK_THRESHOLD = 3;

/** Health messages are operator-facing chips, not transcripts — bound them hard. */
const EXCERPT_MAX = 240;

function excerpt(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/** The wrapped runner's seat-naming failure message: "(cli `x` exited N) …" (execute_wrapped.rs). */
const CLI_IN_DETAIL = /\(cli `([^`]+)` exited /;

/**
 * Seat-level failure signatures in a `stepFailed` detail. Deliberately narrow: a unit that failed
 * its WORK (missing deliverable, gate veto) says nothing about the seat's health, so only strings
 * that name the CLI process, its transport, or its account state qualify.
 */
const SEAT_FAILURE_PATTERNS: RegExp[] = [
  CLI_IN_DETAIL, // non-zero exit, seat named by the runner itself
  /timeout waiting/i, // ACP "timeout waiting for response id=…" (acp_runner.rs)
  /\b401\b|\bunauthorized\b/i, // auth: needs a re-login
  /\bquota\b|rate.?limit|too many requests|\b429\b/i, // quota/rate ceiling
  /\bout of credits\b|\binsufficient credits\b/i, // account balance
];

/** `acpFallback` kinds that are deliberate routing rather than a failure — never counted. */
const BENIGN_FALLBACK_KINDS = new Set(['governance_requires_wrapped']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * In-memory per-seat health, folded from live CoreEvents. In-memory ON PURPOSE: health is a
 * statement about the running platform's ability to reach a CLI right now — a daemon restart
 * genuinely does not know, and "assume active, let the next failure/probe speak" is the honest
 * default (and the one the declarative-roster doctrine implies).
 */
export class SeatHealthTracker {
  private readonly entries = new Map<string, SeatHealth>();
  /** `${session}:${ord}` → cli key. `unitOutputCaptured` carries no seat; this is the correlation. */
  private readonly assignments = new Map<string, string>();
  /** cli key → recent failure-fallback timestamps (epoch ms), pruned to the rolling window. */
  private readonly fallbacks = new Map<string, number[]>();
  /** Default `since` for seats that have never changed state. */
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly opts: {
    /**
     * When present, `acpFallback(session_died)` events check it for a correlated
     * daemon signal and log which case it was (crew#411). Absent: correlation skipped.
     */
    signalLog?: DaemonSignalLog;
    /** Receives the correlation log lines (daemon wires `app.log.warn`). */
    log?: (m: string) => void;
  } = {}) {}

  /** Fold one CoreEvent into the map. Safe on every event type; unknown types are ignored. */
  ingest(event: CoreEvent): void {
    // Replayed log entries carry the engine's capture-time `ts`; live frames don't, and for
    // those "now" IS the observation time (the gate-cache's observedAt rule).
    const at = typeof event.ts === 'number' ? event.ts : Date.now();
    const session = str(event.session);
    const ord = typeof event.ord === 'number' ? event.ord : undefined;

    switch (event.type) {
      case 'unitDistributed': {
        const cli = str(event.cli);
        if (session !== undefined && ord !== undefined && cli !== undefined) {
          this.assignments.set(`${session}:${ord}`, cli);
        }
        return;
      }
      case 'unitReassigned': {
        // `newCli: null` means the council re-convenes — the follow-up unitDistributed will set
        // the new seat. DROP the stale assignment meanwhile: leaving it in place would attribute
        // the interregnum's events to the seat that was just taken off the unit (Copilot, #279).
        const newCli = str((event as { newCli?: unknown }).newCli);
        if (session !== undefined && ord !== undefined && newCli === undefined) {
          this.assignments.delete(`${session}:${ord}`);
        }
        if (session !== undefined && ord !== undefined && newCli !== undefined) {
          this.assignments.set(`${session}:${ord}`, newCli);
        }
        return;
      }
      case 'unitOutputCaptured': {
        if (event.stepStatus !== 'ok' || session === undefined || ord === undefined) return;
        const seat = this.assignments.get(`${session}:${ord}`);
        if (seat !== undefined) this.markActive(seat, at);
        return;
      }
      case 'stepFailed': {
        const detail = typeof event.detail === 'string' ? event.detail : '';
        const failureKind = str((event as { failureKind?: unknown }).failureKind);
        // The detail names the seat when the wrapped runner produced it; otherwise fall back to
        // the unit's assignment (a workerError detail is the CLI's own output and rarely does).
        const named = CLI_IN_DETAIL.exec(detail)?.[1];
        const assigned =
          session !== undefined && ord !== undefined
            ? this.assignments.get(`${session}:${ord}`)
            : undefined;
        const seat = named ?? assigned;
        if (seat === undefined) return;
        const seatLevel =
          failureKind === 'workerError' || SEAT_FAILURE_PATTERNS.some((re) => re.test(detail));
        if (seatLevel) {
          const msg = excerpt(detail) || `seat failure (${failureKind ?? 'unreported'})`;
          this.markInactive(seat, msg, at);
        }
        return;
      }
      case 'acpFallback': {
        const cliKey = str((event as { cliKey?: unknown }).cliKey);
        const fallbackKind = str((event as { fallbackKind?: unknown }).fallbackKind);
        if (cliKey === undefined) return;
        if (fallbackKind !== undefined && BENIGN_FALLBACK_KINDS.has(fallbackKind)) return;
        const fresh = (this.fallbacks.get(cliKey) ?? []).filter(
          (t) => at - t < FALLBACK_WINDOW_MS,
        );
        fresh.push(at);
        this.fallbacks.set(cliKey, fresh);
        if (fresh.length >= FALLBACK_THRESHOLD) {
          const reason = str((event as { reason?: unknown }).reason) ?? fallbackKind ?? 'unknown';
          this.markInactive(
            cliKey,
            `repeated ACP fallback (${fresh.length} in 10 min): ${reason}`,
            at,
          );
        } else {
          // One fallback is not inactive (session death falls back and the unit can still work),
          // but it IS an observed error — stamp lastErrorAt without flipping the status.
          const prev = this.entries.get(cliKey);
          this.entries.set(cliKey, {
            status: prev?.status ?? 'active',
            ...(prev?.message !== undefined ? { message: prev.message } : {}),
            since: prev?.since ?? this.startedAt,
            lastErrorAt: new Date(at).toISOString(),
          });
        }
        // ── crew#411: signal correlation ───────────────────────────────────────
        // A session_died fallback is a silent bridge exit-0; whether the daemon was
        // also signalled at the same time determines the likely cause. Both branches
        // always log when the signal log is wired so post-mortems have the evidence.
        if (fallbackKind === 'session_died' && this.opts.signalLog !== undefined) {
          const match = this.opts.signalLog.findInWindow(at);
          const who = `acpFallback(session_died) for ${cliKey} on run ${session ?? 'unknown'}`;
          this.opts.log?.(
            match
              ? `[seat-health] ${who}: daemon also received ${match.signal} at ` +
                `${new Date(match.at).toISOString()} (Δ${Math.abs(at - match.at)}ms)` +
                ` — likely group/terminal signal (crew#411)`
              : `[seat-health] ${who}: no daemon signal within ` +
                `±${SIGNAL_CORRELATION_WINDOW_MS / 1000}s` +
                ` — pid-targeted external signal or transport close (crew#411)`,
          );
        }
        return;
      }
      // A finished run's assignments can never activate/deactivate anyone again — drop them.
      case 'sessionCompleted':
      case 'sessionFailed':
      case 'runCancelled': {
        if (session === undefined) return;
        const prefix = `${session}:`;
        for (const key of [...this.assignments.keys()]) {
          if (key.startsWith(prefix)) this.assignments.delete(key);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Flip a seat ACTIVE: message cleared, `since` updated on a genuine transition. */
  markActive(key: string, atMs = Date.now()): void {
    const prev = this.entries.get(key);
    this.entries.set(key, {
      status: 'active',
      since: prev?.status === 'active' ? prev.since : new Date(atMs).toISOString(),
      ...(prev?.lastErrorAt !== undefined ? { lastErrorAt: prev.lastErrorAt } : {}),
    });
    this.fallbacks.delete(key); // an ok output resets the repeated-fallback window too
  }

  /** Flip a seat INACTIVE with the error excerpt; `since` survives while already inactive. */
  markInactive(key: string, message: string, atMs = Date.now()): void {
    const prev = this.entries.get(key);
    const iso = new Date(atMs).toISOString();
    this.entries.set(key, {
      status: 'inactive',
      message: excerpt(message),
      since: prev?.status === 'inactive' ? prev.since : iso,
      lastErrorAt: iso,
    });
  }

  /** The seat's health — a seat never seen in an event is ACTIVE with no message (the default). */
  healthFor(key: string): SeatHealth {
    return this.entries.get(key) ?? { status: 'active', since: this.startedAt };
  }
}

/** The roster slice the probe needs (a `RosterSeat` satisfies it structurally). */
export interface ProbeSeat {
  key: string;
  /** The seat's cheap liveness command, e.g. `["claude", "--version"]`. */
  version_probe?: unknown;
  [k: string]: unknown;
}

export interface SeatProbeOptions {
  /** Probe cadence. Default 10 minutes — a recovery path, not a monitor. */
  intervalMs?: number;
  /** Per-probe timeout. Default 5s; a probe that hangs counts as still-down. */
  timeoutMs?: number;
  /** Injectable prober (tests). Resolve `true` ⇔ the command exited 0. */
  runProbe?: (argv: string[], timeoutMs: number) => Promise<boolean>;
  log?: (m: string) => void;
}

/** Default prober: run the version command; exit 0 → true, anything else (incl. timeout) → false. */
async function defaultRunProbe(argv: string[], timeoutMs: number): Promise<boolean> {
  const [file, ...args] = argv;
  if (file === undefined) return false;
  try {
    await execCapped(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The low-frequency recovery probe (crew#274 §3): every `intervalMs`, for INACTIVE seats only,
 * run the seat's `version_probe`; exit 0 flips the seat active with the message cleared. Quota
 * resets and re-logins are thus detected without operator action. Callers own the guard against
 * probing in tests (the daemon arms this from `createServer`, env-gated).
 */
export function startSeatHealthProbe(
  tracker: SeatHealthTracker,
  roster: () => ProbeSeat[],
  opts: SeatProbeOptions = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? FALLBACK_WINDOW_MS; // 10 min
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const runProbe = opts.runProbe ?? defaultRunProbe;
  const log = opts.log ?? ((): void => undefined);
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return; // a slow round must never stack onto the next interval
    inFlight = true;
    try {
      let seats: ProbeSeat[];
      try {
        seats = roster();
      } catch (err) {
        log(`[seat-health] roster read failed, skipping probe round: ${String(err)}`);
        return;
      }
      for (const seat of seats) {
        const key = str(seat.key);
        if (key === undefined) continue;
        if (tracker.healthFor(key).status !== 'inactive') continue; // recovery only
        const probe = seat.version_probe;
        const argv = Array.isArray(probe)
          ? probe.filter((s): s is string => typeof s === 'string' && s.length > 0)
          : [];
        if (argv.length === 0) continue; // unprobeable seat: only an ok output can recover it
        try {
          if (await runProbe(argv, timeoutMs)) {
            tracker.markActive(key);
            log(`[seat-health] '${key}' recovered (version probe exited 0)`);
          }
        } catch {
          /* a throwing prober reads as still-down */
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Never hold the process open for a probe — the daemon's server lifecycle owns shutdown.
  handle.unref?.();
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
