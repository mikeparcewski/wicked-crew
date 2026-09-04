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
// Recovery is an `ok` output — full stop. The old `--version` recovery probe (crew#274 §3) is
// RETIRED (perf recon fix #3): a version probe is liveness, not readiness — it re-admitted a
// seat that could never complete a ballot 9× (agy), and readiness now lives engine-side as the
// dispatch-layer bench with a probationary REAL ballot (wicked-core#355). This tracker never
// gated dispatch (display-only), so an inactive seat keeps receiving work and its next real
// `ok` output flips it active — recovery by real work, no probe required.

import type { CoreEvent, SeatHealth } from '../core/types.js';
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
          // The correlation is the whole point of crew#411 — never silently dropped when a
          // caller wired a signalLog but no log sink; fall back to console.warn.
          const emit = this.opts.log ?? ((m: string) => console.warn(m));
          emit(
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
