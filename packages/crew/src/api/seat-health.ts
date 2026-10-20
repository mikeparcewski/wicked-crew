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

/**
 * (R5 / R5b — DES-L3 PR-3D, F-RC2-006 / F-RC2-021 / F-RC2-041 / F-RC2-004) What this tracker NO
 * LONGER does: flip a seat `inactive` on a `stepFailed{workerError}`, on quota / 401 / timeout
 * phrases, or on repeated ACP fallbacks; and keep a daemon-wide council-count bench
 * (`council_bench`, 30-min window). Both were second classifiers beside the engine's own per-run
 * ballot ledger (`session.benched_seats`, `unitDistributed.degradedReason`) and they blamed the
 * seat for launch refusals and load timeouts — a roster at 0 eligible seats that only a restart
 * cleared. Seat health is now: the engine's bench (per run) + the seat's OWN auth refusal
 * (`auth: signed_out`, cleared by an ok output). `health.status` is always `active`; observed
 * errors stamp `lastErrorAt` and nothing else.
 */

/** Health messages are operator-facing chips, not transcripts — bound them hard. */
const EXCERPT_MAX = 240;

function excerpt(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/** The wrapped runner's seat-naming failure message: "(cli `x` exited N) …" (execute_wrapped.rs). */
const CLI_IN_DETAIL = /\(cli `([^`]+)` exited /;

/** The engine's worker failover (wicked-core `actor.rs`): "seat 'x' failed (worker error); failing
 *  over to 'y' …". It re-dispatches the unit on `y` with no `unitReassigned`, so this detail is the
 *  only frame that names the seat the next attempt runs on. It names the failed seat too, which
 *  matters when a `seatBenched` frame for it already dropped the unit's assignment. */
const FAILOVER_IN_DETAIL = /seat '([^']+)' failed \([^)]*\); failing over to '([^']+)'/;

/** `acpFallback` kinds that are deliberate routing rather than a failure — never counted:
 *  `governance_requires_wrapped` (crew#276) and `read_only_requires_wrapped` (wicked-core#431 —
 *  an `executes_code: false` unit on an ACP seat not admitted to input governance is routed to the
 *  wrapped carrier before any ACP turn, where the read-only lever is an argv fact). */
const BENIGN_FALLBACK_KINDS = new Set(['governance_requires_wrapped', 'read_only_requires_wrapped']);

/**
 * A worker's ACP session died mid-turn (crew#411's correlation subject). Since wicked-core#925 a
 * GOVERNED unit's death on an ACP-admitted non-claude seat is emitted as `governed_requires_acp`
 * (nothing fell back, so the cause's `session_died` slug is not used); its reason still opens with
 * the engine's session-death cause, which is what tells it apart from the other refusal causes
 * (startup failure, workdir, transport, version pin).
 */
const SESSION_DEATH_CAUSES = ['[wicked-core] ACP session exited for ', '[wicked-core] ACP error for '];
export function isSessionDeath(fallbackKind: string | undefined, reason: string | undefined): boolean {
  if (fallbackKind === 'session_died') return true;
  if (fallbackKind !== 'governed_requires_acp' || reason === undefined) return false;
  return SESSION_DEATH_CAUSES.some((c) => reason.startsWith(c));
}

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
  /no api key(?: found)?/i,
  /not logged in/i,
  /\bunauthenticated\b/i,
  /\bunauthori[sz]ed\b/i,
  // A 401 only as an HTTP STATUS, never a bare number (review M-3 of #536: a bare `\b401\b` matched
  // stack-trace line/column numbers — `src/foo.ts:401:12` — and benched a healthy seat for 30 min).
  /\bHTTP\/?[0-9.]*\s+401\b/i,
  /\b401\s+unauthori[sz]ed\b/i,
  /\bstatus(?:\s*code)?\s*[:=]?\s*401\b/i,
  /login required/i,
  /please (sign|log) in/i,
  /invalid api key/i,
  /authentication (failed|required)/i,
  /missing (api[ _-]?key|credentials?)/i,
  // crew#645: claude's expired login — "Failed to authenticate: OAuth session expired and could not
  // be refreshed" — said nothing any pattern above matched, so four failed ballots flipped nothing.
  // Keyed on the OAuth words, never a bare "failed to authenticate" (a unit's own `git push` to a
  // remote says that too, and it says nothing about the seat's login — codex review of #696).
  /oauth (session|token) (has )?expired/i,
  // crew#645: a free tier the installed CLI is too old to use ("OpenCode 1.18.0 or newer is
  // required to use the free tier") — the seat cannot answer until it is upgraded.
  /required to use the free tier/i,
];

/** Whether a failure detail / stderr says the seat has no usable credential. */
export function isAuthRefusal(text: string): boolean {
  return AUTH_REFUSAL_PATTERNS.some((re) => re.test(text));
}

/**
 * A8 (DES-seats-page §4.3): what a seat's refusal SAID, in crew's own vocabulary — the words each
 * {@link AUTH_REFUSAL_PATTERNS} entry matched (`No API key`, `Not logged in`, `HTTP/1.1 401`,
 * `OAuth session expired`), deduplicated, joined `; ` — or `null` when none matched. Never the
 * CLI's surrounding prose: a refusal can carry a key, an account or an organisation in any shape,
 * and no mask can know them all, so the roster carries only what crew's patterns name.
 */
export function refusalSummary(text: string): string | null {
  const hits: string[] = [];
  for (const re of AUTH_REFUSAL_PATTERNS) {
    const m = re.exec(text);
    if (m === null) continue;
    const phrase = m[0].replace(/\s+/g, ' ').trim();
    if (!hits.some((h) => h.toLowerCase() === phrase.toLowerCase())) hits.push(phrase);
  }
  return hits.length > 0 ? hits.join('; ') : null;
}

/** `acpFallback.fallbackKind` values that mean the seat's ACCOUNT refused (wave 6 adds two). */
const AUTH_FALLBACK_KINDS = new Set(['auth_required', 'auth_failed', 'unauthenticated']);

/** How long a seat's own "no credential" report keeps its `auth` at `signed_out` with no ok output
 *  since — the same window as the council bench; an ok unit output clears it at once. */
export const AUTH_FAILURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a seat the ENGINE benched in a run (`seatBenched`) stays out of the next launches with
 * no ok output since. After this the seat is eligible again: if it is still dead, its next run
 * finds out with one refused turn and benches it again; an ok output (a chat turn, a unit the
 * operator sent there) clears the bench at once.
 */
export const SEAT_BENCH_WINDOW_MS = 30 * 60 * 1000;

/**
 * How long a seat's last step outcome stands as its live sign-in check on the container floor
 * (`roster-standing.ts`). There the daemon sends no live request of its own: the credential broker
 * answers the status, and the seat's own steps are the live check, because they ran on the floor
 * work runs on (the same seat container, the same broker credential).
 */
export const SEAT_ANSWER_WINDOW_MS = 30 * 60 * 1000;

/** Why a seat's step did not answer: the engine's turn ceiling fired (`stepFailed{timedOut}`), or
 *  the CLI process failed with no ok output (`stepFailed{workerError}`, not a deliver refusal and
 *  not the seat's own "no credential" report, which signs it out instead). */
export type SeatNoAnswer = 'timed_out' | 'worker_error';

/** The seat's latest step outcome inside {@link SEAT_ANSWER_WINDOW_MS}. */
export interface SeatLastAnswer {
  /** ISO-8601 of the outcome. */
  at: string;
  /** `true`: a unit's output came back ok (a chat's answer is one), or the engine vetoed the
   *  substance of an answer the seat gave. */
  answered: boolean;
  /** Present when `answered` is false. */
  why?: SeatNoAnswer;
}

/**
 * A seat the engine benched in a run, carried to the next launches (`seatBenched`, wicked-core
 * after #590 S5). Since S5 no ballot finds a dead seat before routing, so a seat that reads signed
 * in but cannot work (out of quota, say) is only found when its first unit refuses. Without this,
 * every new run handed that seat a unit again.
 */
export interface SeatRecentBench {
  /** ISO-8601 of the bench. */
  at: string;
  /** ISO-8601 of when the seat is eligible again ({@link SEAT_BENCH_WINDOW_MS} after `at`). */
  until: string;
  /** The engine's bench reason, as it persisted it (`quota_exhausted (no success in the run)`). */
  reason: string;
  /** Who benched it in the run: the unit's `worker`, or a `judge`. */
  source: string;
  /** The run that benched it, when the frame named one. */
  run?: string;
  /** (A3) How many runs benched the seat while this bench was active (at least 1). */
  runs: number;
}

/**
 * crew#1071: where a seat's recent bench is kept across a daemon restart. The bench used to live in
 * this tracker's memory only, and the boot replay re-reads only LIVE runs' events, so a bench
 * recorded by a run that has since ended (cancelled or failed: the normal end of a quota failure)
 * was gone after a restart. The seat read Ready again, and the next ask was seated on it alone and
 * failed with the same 429. The daemon wires this to its audit trail: one entry per bench and per
 * lift, read back at boot by {@link SeatHealthTracker.hydrateBenches}.
 */
export interface SeatBenchStore {
  /** A bench (or a later bench of the same seat) was recorded. */
  benched(cli: string, rec: SeatBenchRecord): void;
  /** The seat's bench was lifted before its window ran out: an ok output, a chat reply, or its own
   *  live sign-in check answering after it. */
  lifted(cli: string, atMs: number): void;
}

/** One persisted bench, as {@link SeatBenchStore.benched} receives it and the boot reads it back. */
export interface SeatBenchRecord {
  /** Unix millis of the bench (the engine frame's own `ts` when it carried one). */
  at: number;
  reason: string;
  source: string;
  session?: string;
  runs: number;
}

/** One persisted entry read back at boot, oldest first or in any order (it is sorted). */
export type SeatBenchEntry =
  | { kind: 'benched'; cli: string; rec: SeatBenchRecord }
  | { kind: 'lifted'; cli: string; at: number };

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
 * default (and the one the declarative-roster doctrine implies). One exception (crew#1071): the
 * engine's in-run bench of a seat is its own recorded verdict, not a guess, so it is kept through
 * the {@link SeatBenchStore} for its window and restored at boot.
 */
export class SeatHealthTracker {
  private readonly entries = new Map<string, SeatHealth>();
  /** `${session}:${ord}` → cli key. `unitOutputCaptured` carries no seat; this is the correlation. */
  private readonly assignments = new Map<string, string>();
  /** cli key → the seat's latest own "no credential" report (F-A45-006), cleared by an ok output. */
  private readonly authFailures = new Map<string, { at: number; detail: string; source: SeatAuthFailure['source']; session?: string }>();
  /** cli key → the engine's latest in-run bench of the seat (`seatBenched`), cleared by an ok
   *  output or by {@link SEAT_BENCH_WINDOW_MS}. */
  private readonly recentBenches = new Map<string, { at: number; reason: string; source: string; session?: string; runs: number }>();
  /** cli key → the seat's latest step outcome (container-floor live check, {@link lastAnswerFor}). */
  private readonly answers = new Map<string, { at: number; answered: boolean; why?: SeatNoAnswer }>();
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

  /** crew#1071: where benches and their lifts are kept across a restart. `null`: memory only. */
  private benchStore: SeatBenchStore | null = null;

  /** crew#1071: keep every bench and lift from now on in `store` (the daemon's audit trail). */
  attachBenchStore(store: SeatBenchStore): void {
    this.benchStore = store;
  }

  /**
   * crew#1071: rebuild the benches still inside {@link SEAT_BENCH_WINDOW_MS} from the persisted
   * entries (the daemon's audit trail), so a restart does not hand a seat that is out of quota its
   * next ask. Entries are folded in time order: a lift at or after a bench drops it, a later bench
   * replaces it. Nothing is re-persisted.
   */
  hydrateBenches(entries: readonly SeatBenchEntry[], nowMs = Date.now()): void {
    const ordered = [...entries].sort(
      (a, b) => (a.kind === 'benched' ? a.rec.at : a.at) - (b.kind === 'benched' ? b.rec.at : b.at),
    );
    for (const e of ordered) {
      if (e.kind === 'lifted') {
        const cur = this.recentBenches.get(e.cli);
        if (cur !== undefined && e.at >= cur.at) this.recentBenches.delete(e.cli);
        continue;
      }
      if (nowMs - e.rec.at >= SEAT_BENCH_WINDOW_MS) continue;
      const cur = this.recentBenches.get(e.cli);
      if (cur !== undefined && cur.at > e.rec.at) continue;
      this.recentBenches.set(e.cli, {
        at: e.rec.at,
        reason: e.rec.reason,
        source: e.rec.source,
        runs: Math.max(1, e.rec.runs),
        ...(e.rec.session !== undefined ? { session: e.rec.session } : {}),
      });
    }
  }

  /** Drop the seat's bench, and say so to the store when there was one to drop (crew#1071). */
  private liftBench(key: string, atMs: number): void {
    if (this.recentBenches.delete(key)) this.benchStore?.lifted(key, atMs);
  }

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
        if (seat !== undefined) {
          this.markActive(seat, at);
          // Only a unit's own outcome is recorded as an answer: a chat's `chatReply` is this same
          // unit's output read back later (`AskRelay`), stamped when the relay folds it, so it could
          // otherwise replace a newer step that did not answer.
          this.recordAnswer(seat, at, true);
        }
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
        // The detail names the seat when the wrapped runner produced it; otherwise fall back to
        // the unit's assignment (a workerError detail is the CLI's own output and rarely does).
        const failover = FAILOVER_IN_DETAIL.exec(detail);
        const named = failover?.[1] ?? CLI_IN_DETAIL.exec(detail)?.[1];
        const assigned =
          session !== undefined && ord !== undefined
            ? this.assignments.get(`${session}:${ord}`)
            : undefined;
        // codex xreview on #1095: the next attempt runs on the failover seat, so its outcome is that
        // seat's, never the one that just failed.
        if (failover?.[2] !== undefined && session !== undefined && ord !== undefined) {
          this.assignments.set(`${session}:${ord}`, failover[2]);
        }
        const seat = named ?? assigned;
        if (seat === undefined) return;
        // F-A45-006: the seat's own words beat the file probe — "No API key found" flips `auth`.
        if (isAuthRefusal(detail)) this.recordAuthFailure(seat, detail, 'worker', at, session);
        // (R5) Every other worker failure is an OBSERVED error, never a status flip: a launch
        // refusal, a load timeout or a worker crash says nothing about whether the seat can take
        // the next turn — the engine's per-run ballot ledger judges that (F-RC2-006).
        else {
          this.stampError(seat, at);
          // …but whether the seat answered is what the container floor's live check reads. A
          // substance veto came after the seat answered (it is an answer, without the recovery an
          // ok output gets). An environment refusal (a trust prompt, a missing TTY) is the CLI
          // refusing its directory before any request: it says nothing about the session either way.
          const kind = str((event as { failureKind?: unknown }).failureKind);
          if (kind === 'timedOut') this.recordAnswer(seat, at, false, 'timed_out');
          else if (kind === 'workerError') this.recordAnswer(seat, at, false, 'worker_error');
          else if (kind === 'substanceRejected') this.recordAnswer(seat, at, true);
        }
        return;
      }
      case 'councilSeatFailed': {
        const cli = str(event.cli);
        const kind = str((event as { kind?: unknown }).kind);
        // crew#630: the engine's real frame is `{kind: 'non_zero_exit', reason: 'not_logged_in',
        // stdout: 'Not logged in · Please run /login', stderr: '', detail: ''}` — claude prints its
        // refusal on STDOUT and the classified cause rides `reason`, neither of which was read, so
        // four failed ballots left the roster at `signed_in`. Every text field is read now.
        const reason = str((event as { reason?: unknown }).reason);
        const texts = [event.detail, (event as { stderr?: unknown }).stderr, (event as { stdout?: unknown }).stdout]
          .map(str)
          .filter((t): t is string => t !== undefined);
        const said = texts.find(isAuthRefusal);
        // F-A45-006: a ballot the seat lost to its own missing credential (`not_logged_in`, or
        // its own words saying "No API key found") flips `auth`, whatever the file probe read.
        if (cli !== undefined && (kind === 'not_logged_in' || reason === 'not_logged_in' || said !== undefined)) {
          this.recordAuthFailure(cli, said ?? texts[0] ?? '', 'ballot', at, session, 'not logged in');
        }
        // (R5b) An observed error — stamped, never counted: the engine benches the seat for the
        // run at its own ballot threshold and says so in `unitDistributed.degradedReason`; crew
        // keeps no cross-run council ledger any more (one bench ledger, DES-L3 PR-3D).
        if (cli !== undefined && kind !== undefined && kind !== 'benched') this.stampError(cli, at);
        return;
      }
      case 'chatReply': {
        // A seat that ANSWERED a chat turn did work: the same recovery an ok unit output is. (An
        // ask does not seat a seat under an active bench — crew#1071 — so this lifts one only for a
        // seat that answered anyway: a chat opened before the bench landed.)
        const cliKey = str((event as { cliKey?: unknown }).cliKey);
        if (cliKey !== undefined && (event as { ok?: unknown }).ok === true) this.markActive(cliKey, at);
        return;
      }
      case 'seatBenched': {
        // The engine benched this seat for the run on its worker's or judge's own refusal
        // (`not_logged_in`, `quota_exhausted`, `not_installed`, `approval_unavailable`). Crew
        // classifies nothing here (R5): it carries the ENGINE's verdict to the next launches for
        // a bounded window, so a seat that reads signed in but cannot work is not handed a unit
        // by every new run. A launcher bench is crew's own reading and never comes back this way.
        const cli = str(event.cli);
        const reason = str((event as { reason?: unknown }).reason);
        const source = str((event as { source?: unknown }).source);
        // Only the engine's IN-RUN benches are carried: a `worker` or `judge` refusal. A launcher
        // bench is crew's own reading, and a frame with no (or an unknown) source is malformed —
        // neither may bench a seat for the window.
        if (cli === undefined || reason === undefined || (source !== 'worker' && source !== 'judge')) return;
        // A3: a bench that lands while the last one is still active counts one more run (the same
        // run benching twice — its worker, then its judge — counts once).
        const prev = this.recentBenches.get(cli);
        const active = prev !== undefined && at - prev.at < SEAT_BENCH_WINDOW_MS;
        // The same frame folded twice (a replayed log entry after the live frame, or a boot
        // replay of a live run after the trail already restored its bench) changes nothing.
        const repeat = prev !== undefined && prev.at === at && prev.session === session && prev.reason === reason;
        if (!repeat) {
          const runs = !active ? 1 : session !== undefined && session === prev.session ? prev.runs : prev.runs + 1;
          const rec = { at, reason, source, runs, ...(session !== undefined ? { session } : {}) };
          this.recentBenches.set(cli, rec);
          this.benchStore?.benched(cli, rec);
        }
        this.stampError(cli, at);
        // The run moves its units OFF the benched seat: the refusing unit fails over (a
        // `stepFailed` naming the new seat, no `unitReassigned`) and a later one is re-seated
        // before it runs. So none of this run's units is on that seat any more, and an ok output
        // for one of them must not be read as the benched seat recovering (it ran elsewhere).
        // An operator's explicit reassign back onto the seat re-records the assignment.
        if (session !== undefined) {
          const prefix = `${session}:`;
          for (const [key, seat] of [...this.assignments]) {
            if (seat === cli && key.startsWith(prefix)) this.assignments.delete(key);
          }
        }
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
          this.recordAuthFailure(cliKey, why, 'acp', at, session, fallbackKind);
        }
        // (R5) A fallback — one or many — is an observed error, never a status flip: the unit
        // still runs on the wrapped carrier, and the seat's next turn is the engine's call.
        this.stampError(cliKey, at);
        // ── crew#411: signal correlation ───────────────────────────────────────
        // A session_died fallback is a silent bridge exit-0; whether the daemon was
        // also signalled at the same time determines the likely cause. Both branches
        // always log when the signal log is wired so post-mortems have the evidence.
        if (isSessionDeath(fallbackKind, str((event as { reason?: unknown }).reason)) && this.opts.signalLog !== undefined) {
          const match = this.opts.signalLog.findInWindow(at);
          const who = `acpFallback(${fallbackKind ?? 'session_died'}) for ${cliKey} on run ${session ?? 'unknown'}`;
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
    this.authFailures.delete(key); // …and the seat's own "no credential" report (F-A45-006)
    this.liftBench(key, atMs); // …and a run's bench of it: the seat just did work
  }

  /** Keep the seat's newest step outcome; an older frame (a replay folded late) never replaces it. */
  private recordAnswer(key: string, atMs: number, answered: boolean, why?: SeatNoAnswer): void {
    const cur = this.answers.get(key);
    if (cur !== undefined && cur.at > atMs) return;
    this.answers.set(key, { at: atMs, answered, ...(why !== undefined ? { why } : {}) });
  }

  /**
   * The seat's latest step outcome inside {@link SEAT_ANSWER_WINDOW_MS}, or `null` when no step ran
   * on it in that window. The roster reads it as the container floor's live sign-in check.
   */
  lastAnswerFor(key: string, nowMs = Date.now()): SeatLastAnswer | null {
    const rec = this.answers.get(key);
    if (rec === undefined) return null;
    if (nowMs - rec.at >= SEAT_ANSWER_WINDOW_MS) {
      this.answers.delete(key);
      return null;
    }
    return { at: new Date(rec.at).toISOString(), answered: rec.answered, ...(rec.why !== undefined ? { why: rec.why } : {}) };
  }

  /**
   * (A3) Lift the seat's recent bench because something else proved it can work again — the roster
   * calls this when the seat's own LIVE sign-in check answered after an account bench (signed out,
   * out of quota). An ok output does the same through {@link markActive}.
   */
  clearRecentBench(key: string, atMs = Date.now()): void {
    this.liftBench(key, atMs);
  }

  /**
   * Drop the seat's own "no credential" report when it is OLDER than `beforeMs` — the roster calls
   * this when the seat's LIVE sign-in check answered after it (the operator signed in since). A
   * report that landed after the check is kept: the seat refused again.
   */
  clearAuthFailureBefore(key: string, beforeMs: number): void {
    const rec = this.authFailures.get(key);
    if (rec !== undefined && rec.at < beforeMs) this.authFailures.delete(key);
  }

  /** Record a seat's own "no credential" report (F-A45-006) — the newest report wins. */
  private recordAuthFailure(
    key: string,
    detail: string,
    source: SeatAuthFailure['source'],
    atMs: number,
    session: string | undefined,
    fallback = 'no credential',
  ): void {
    this.authFailures.set(key, {
      at: atMs,
      // A8: a seat's own words can carry a key or name its account, so only crew's own vocabulary
      // for them is kept (`refusalSummary`); every reader — the roster, a chat refusal, a bench
      // reason — gets that, never the CLI's prose. A refusal no pattern names keeps its source's
      // controlled word (the caller's `fallback`).
      detail: excerpt(refusalSummary(detail) ?? fallback),
      source,
      ...(session !== undefined ? { session } : {}),
    });
    this.stampError(key, atMs);
  }

  /** Stamp an OBSERVED error on the seat — `lastErrorAt` only; the status stays `active` (R5). */
  private stampError(key: string, atMs: number): void {
    const prev = this.entries.get(key);
    this.entries.set(key, {
      status: 'active',
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
   * The engine's latest in-run bench of the seat (`seatBenched`) inside
   * {@link SEAT_BENCH_WINDOW_MS} with no ok output since, or `null`. `seatStanding` reads it as
   * `council_eligible: false` with the reason and the time it lifts, so the next launch benches the
   * seat up front (`health.usable: false`) and the operator sees why on the roster.
   */
  recentBenchFor(key: string, nowMs = Date.now()): SeatRecentBench | null {
    const rec = this.recentBenches.get(key);
    if (rec === undefined) return null;
    if (nowMs - rec.at >= SEAT_BENCH_WINDOW_MS) {
      this.recentBenches.delete(key);
      return null;
    }
    return {
      at: new Date(rec.at).toISOString(),
      until: new Date(rec.at + SEAT_BENCH_WINDOW_MS).toISOString(),
      reason: rec.reason,
      source: rec.source,
      ...(rec.session !== undefined ? { run: rec.session } : {}),
      runs: rec.runs,
    };
  }

  /** The seat's health — a seat never seen in an event is ACTIVE with no message (the default). */
  healthFor(key: string): SeatHealth {
    return this.entries.get(key) ?? { status: 'active', since: this.startedAt };
  }
}
