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
//   the detail when it names one, else from the unit's `unitDistributed` assignment. A DELIVER
//   refusal is the exception (wicked-core#431 follow-through): the deliver phase is a Tool command
//   no seat ran, and the engine's pre-push lift + re-verify (`deliver: LIFT-CONFLICT — …`, `… the
//   repository's own checks FAILED on it …`, `… could not be applied cleanly …`) and crew's own script (nothing to
//   deliver, a moved verified base, a failed `gh`) both surface as `workerError` only because the
//   Tool path has no finer kind. They are operator ESCALATIONS (`core/deliver-triage.ts`) and flip
//   no seat.
// - `acpFallback` is NOT alone inactive — `session_died` falls back to single-shot and the unit
//   can still succeed — but REPEATED fallback (3+ in 10 minutes) is a seat that cannot hold a
//   session, and that is. `governance_requires_wrapped` and `read_only_requires_wrapped`
//   (wicked-core#431: an evaluator on an unadmitted ACP seat is rerouted to the wrapped carrier,
//   where read-only is an argv fact) are deliberate routing, not failures, and never count.
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
import { triageDeliverFailure } from '../core/deliver-triage.js';

export type { SeatHealth };

/** Rolling window for the repeated-acpFallback rule. */
export const FALLBACK_WINDOW_MS = 10 * 60 * 1000;
/** Fallbacks within the window that flip a seat inactive. */
export const FALLBACK_THRESHOLD = 3;

/**
 * The council BENCH fold (independent review of #533, F-1): `councilSeatFailed { cli, kind }` is the
 * engine's own evidence that a seat cannot hold a ballot — `non_zero_exit` ("Not logged in", "No
 * API key found", "exceeded your monthly quota") or `timed_out` (opencode past the 40 s dispatch
 * budget on the phase-4 rig). Until this fold existed the tracker never read it, so a seat benched
 * in every council kept `health: active` and the roster's `council_eligible` prediction could not
 * learn. The fold is bounded on purpose: only PRIMARY failures count (`benched` is the engine's
 * derivative of an earlier failure, not a new observation), only within {@link COUNCIL_BENCH_WINDOW_MS},
 * and only from {@link COUNCIL_BENCH_THRESHOLD} failures up (one timed-out ballot is weather). It
 * does NOT flip `health` — a chat is not a council and the free tier may still answer — it feeds
 * `council_eligible` through {@link SeatHealthTracker.councilBenchFor}, and an ok unit output clears
 * it like every other recovery.
 */
export const COUNCIL_BENCH_WINDOW_MS = 30 * 60 * 1000;
export const COUNCIL_BENCH_THRESHOLD = 2;
/** The `councilSeatFailed.kind` values that are the seat's OWN failure (the engine's `benched` is derivative). */
export const COUNCIL_PRIMARY_FAILURE_KINDS: ReadonlySet<string> = new Set(['non_zero_exit', 'timed_out']);

/** One primary council failure the tracker holds for a seat, inside the window. */
interface CouncilFailure {
  at: number;
  kind: string;
  detail: string;
  session: string | undefined;
}

/** What the roster carries as `council_bench` when a seat is benched by this daemon's recent evidence. */
export interface CouncilBench {
  /** Primary ballot failures inside the window. */
  failures: number;
  last_kind: string;
  /** ISO-8601 of the last failure. */
  last_at: string;
  /** The run the last failure happened in, when the frame named one. */
  last_run?: string;
  /** A bounded excerpt of the last failure's detail / stderr, when there was one. */
  last_detail?: string;
  window_ms: number;
}

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

/** `acpFallback` kinds that are deliberate routing rather than a failure — never counted:
 *  `governance_requires_wrapped` (crew#276) and `read_only_requires_wrapped` (wicked-core#431 —
 *  an `executes_code: false` unit on an ACP seat not admitted to input governance is routed to the
 *  wrapped carrier before any ACP turn, where the read-only lever is an argv fact). */
const BENIGN_FALLBACK_KINDS = new Set(['governance_requires_wrapped', 'read_only_requires_wrapped']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * What a seat's OWN output says when it has no credential (F-A45-006, wave 6): the fresh rig's pi
 * failed every ballot with "No API key found" while the roster read `signed_in: true` off a present
 * (empty) `auth.json`. The seat's stderr is the authoritative probe — when it says so, the roster's
 * `auth` must flip to `signed_out` (not only `council_eligible`), and the evidence rides with it.
 */
export const AUTH_REFUSAL_PATTERNS: RegExp[] = [
  /no api key/i,
  /not logged in/i,
  /\bunauthenticated\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /login required/i,
  /please (sign|log) in/i,
  /invalid api key/i,
  /authentication (failed|required)/i,
  /missing (api[ _-]?key|credentials?)/i,
];

/** Whether a failure detail / stderr says the seat has no usable credential. */
export function isAuthRefusal(text: string): boolean {
  return AUTH_REFUSAL_PATTERNS.some((re) => re.test(text));
}

/** `acpFallback.fallbackKind` values that mean the seat's ACCOUNT refused (wave 6 adds two). */
const AUTH_FALLBACK_KINDS = new Set(['auth_required', 'auth_failed', 'unauthenticated']);

/** How long a seat's own "no credential" report keeps its `auth` at `signed_out` with no ok output
 *  since — the same window as the council bench; an ok unit output clears it at once. */
export const AUTH_FAILURE_WINDOW_MS = COUNCIL_BENCH_WINDOW_MS;

/** A seat's own report that it has no credential (`RosterSeat.auth_evidence`). */
export interface SeatAuthFailure {
  /** ISO-8601 of the report. */
  at: string;
  /** A bounded excerpt of the seat's own words ("No API key found …"). */
  detail: string;
  /** Where it was said: a council `ballot`, a unit's `worker` failure, or the `acp` handshake. */
  source: 'ballot' | 'worker' | 'acp';
  /** The run it happened in, when the frame named one. */
  run?: string;
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
  /** cli key → primary council ballot failures inside {@link COUNCIL_BENCH_WINDOW_MS}. */
  private readonly councilFailures = new Map<string, CouncilFailure[]>();
  /** cli key → the seat's latest own "no credential" report (F-A45-006), cleared by an ok output. */
  private readonly authFailures = new Map<string, { at: number; detail: string; source: SeatAuthFailure['source']; session?: string }>();
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
        // wicked-core#431 follow-through: a DELIVER refusal — the engine's pre-push lift
        // (LIFT-CONFLICT, a failed re-verify on the lifted tree, an apply failure) or crew's own
        // script (nothing to deliver, a moved verified base, a failed gh) — is an operator
        // ESCALATION, never a seat fault: the deliver phase is a Tool command no CLI seat ran, and
        // the engine stamps it `workerError` only because the Tool path has no finer kind. Reading
        // that literally blamed the unit's assigned seat for a git state. Recognised by phrase
        // (`core/deliver-triage.ts`), it flips nobody.
        if (triageDeliverFailure(detail) !== null) return;
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
        // F-A45-006: the seat's own words beat the file probe — "No API key found" flips `auth`.
        if (isAuthRefusal(detail)) this.recordAuthFailure(seat, detail, 'worker', at, session);
        const seatLevel =
          failureKind === 'workerError' || SEAT_FAILURE_PATTERNS.some((re) => re.test(detail));
        if (seatLevel) {
          const msg = excerpt(detail) || `seat failure (${failureKind ?? 'unreported'})`;
          this.markInactive(seat, msg, at);
        }
        return;
      }
      case 'councilSeatFailed': {
        const cli = str(event.cli);
        const kind = str((event as { kind?: unknown }).kind);
        const detail = str(event.detail) ?? str((event as { stderr?: unknown }).stderr) ?? '';
        // F-A45-006: a ballot the seat lost to its own missing credential (`not_logged_in`, or
        // stderr saying "No API key found") flips `auth`, whatever the file probe read.
        if (cli !== undefined && (kind === 'not_logged_in' || isAuthRefusal(detail))) {
          this.recordAuthFailure(cli, detail !== '' ? detail : (kind ?? 'not logged in'), 'ballot', at, session);
        }
        if (cli === undefined || kind === undefined || !COUNCIL_PRIMARY_FAILURE_KINDS.has(kind)) return;
        const fresh = (this.councilFailures.get(cli) ?? []).filter((f) => at - f.at < COUNCIL_BENCH_WINDOW_MS);
        fresh.push({ at, kind, detail: excerpt(detail), session });
        this.councilFailures.set(cli, fresh);
        // An observed error — stamped, never a status flip (see COUNCIL_BENCH_WINDOW_MS).
        const prev = this.entries.get(cli);
        this.entries.set(cli, {
          status: prev?.status ?? 'active',
          ...(prev?.message !== undefined ? { message: prev.message } : {}),
          since: prev?.since ?? this.startedAt,
          lastErrorAt: new Date(at).toISOString(),
        });
        return;
      }
      case 'acpFallback': {
        const cliKey = str((event as { cliKey?: unknown }).cliKey);
        const fallbackKind = str((event as { fallbackKind?: unknown }).fallbackKind);
        if (cliKey === undefined) return;
        if (fallbackKind !== undefined && BENIGN_FALLBACK_KINDS.has(fallbackKind)) return;
        // F-A45-006 / wave 6: an authentication fallback (`auth_required`, `auth_failed`,
        // `unauthenticated`) is the seat's account refusing — `auth` flips, with the engine's reason.
        if (fallbackKind !== undefined && AUTH_FALLBACK_KINDS.has(fallbackKind)) {
          const why = str((event as { reason?: unknown }).reason) ?? fallbackKind;
          this.recordAuthFailure(cliKey, why, 'acp', at, session);
        }
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
    this.councilFailures.delete(key); // …and the council bench: real work is the recovery
    this.authFailures.delete(key); // …and the seat's own "no credential" report (F-A45-006)
  }

  /** Record a seat's own "no credential" report (F-A45-006) — the newest report wins. */
  private recordAuthFailure(
    key: string,
    detail: string,
    source: SeatAuthFailure['source'],
    atMs: number,
    session: string | undefined,
  ): void {
    this.authFailures.set(key, {
      at: atMs,
      detail: excerpt(detail),
      source,
      ...(session !== undefined ? { session } : {}),
    });
    const prev = this.entries.get(key);
    this.entries.set(key, {
      status: prev?.status ?? 'active',
      ...(prev?.message !== undefined ? { message: prev.message } : {}),
      since: prev?.since ?? this.startedAt,
      lastErrorAt: new Date(atMs).toISOString(),
    });
  }

  /**
   * The seat's own latest "no credential" report inside {@link AUTH_FAILURE_WINDOW_MS} with no ok
   * output since (F-A45-006), or `null`. `seatStanding` reads it as `auth: 'signed_out'` — the seat
   * said so itself — whatever the credential-file probe reads.
   */
  authFailureFor(key: string, nowMs = Date.now()): SeatAuthFailure | null {
    const rec = this.authFailures.get(key);
    if (rec === undefined) return null;
    if (nowMs - rec.at >= AUTH_FAILURE_WINDOW_MS) {
      this.authFailures.delete(key);
      return null;
    }
    return {
      at: new Date(rec.at).toISOString(),
      detail: rec.detail,
      source: rec.source,
      ...(rec.session !== undefined ? { run: rec.session } : {}),
    };
  }

  /**
   * The seat's council bench from THIS daemon's recent evidence, or `null`: fewer than
   * {@link COUNCIL_BENCH_THRESHOLD} primary ballot failures inside {@link COUNCIL_BENCH_WINDOW_MS}
   * (older ones have aged out), or an ok output since.
   */
  councilBenchFor(key: string, nowMs = Date.now()): CouncilBench | null {
    const fresh = (this.councilFailures.get(key) ?? []).filter((f) => nowMs - f.at < COUNCIL_BENCH_WINDOW_MS);
    if (fresh.length === 0) {
      this.councilFailures.delete(key);
      return null;
    }
    this.councilFailures.set(key, fresh);
    if (fresh.length < COUNCIL_BENCH_THRESHOLD) return null;
    const last = fresh[fresh.length - 1]!;
    return {
      failures: fresh.length,
      last_kind: last.kind,
      last_at: new Date(last.at).toISOString(),
      ...(last.session !== undefined ? { last_run: last.session } : {}),
      ...(last.detail !== '' ? { last_detail: last.detail } : {}),
      window_ms: COUNCIL_BENCH_WINDOW_MS,
    };
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
