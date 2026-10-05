/**
 * Seat STANDING — what the daemon can say about a roster seat's usability from what it already
 * knows, so the roster and the chat admission read the SAME predicate (F-2R2-009, F-2R2-007).
 *
 * # The defect
 *
 * `GET /roster` carried `signed_in: false` for four seats and the Health rail rendered every one
 * of them as "active · signed out" with a green tick. Two of those seats mean two different
 * things by "signed out": codex / pi / copilot bench on their first ballot (`non_zero_exit`: "No
 * API key found", "exceeded your monthly quota"), while opencode ANSWERED a scoped chat on its
 * free tier (OpenCode Zen, no account). One word, two outcomes, and nothing on the wire to tell
 * them apart — and `POST /chats` seated its defaults through a third, unrelated filter.
 *
 * # The model
 *
 *  - `auth` — the sign-in probe's three values re-read against the seat's free-tier capability:
 *    `signed_in` (a credential artifact is observable), `signed_out` (none is, and the seat needs
 *    one to answer), `not_required` (none is, but the seat answers unauthenticated on a free tier
 *    — see {@link FREE_TIER_SEATS}), `unknown` (the probe cannot tell cheaply: keychain-backed
 *    seats, seat keys with no rule).
 *  - `council_eligible` — whether a council would seat and keep this seat as far as the daemon
 *    can tell: enabled for council, runtime health `active`, and `auth` not `signed_out`. A
 *    PREDICTION from the daemon's own records, not the engine's verdict — the engine convenes
 *    whatever roster it is handed and benches a seat only after it fails (F-4R2-007). `unknown`
 *    auth is eligible: refusing a seat the daemon cannot read would bench working keychain seats.
 *  - chat admission ({@link chatSeatAdmission}) — the seats a chat seats BY DEFAULT: the same
 *    auth predicate (a `signed_out` seat is refused up front with the reason, instead of failing
 *    its first turn), plus the engine's scope rule restated (a SCOPED chat holds only a seat whose
 *    ACP adapter asks permissions or whose record arms the kernel write floor). Every refusal
 *    carries every reason that applies, so the thread can say WHY a seat is missing.
 *
 * Pure, synchronous, no IO: the probe result and the seat's own auth refusal are the inputs. The
 * runtime HEALTH record is not one any more (R5 / R5b, DES-L3 PR-3D) — `inactive` is never produced
 * and the one bench is the engine's per-run ballot ledger.
 */

import { homedir } from 'node:os';
import type {SeatAuthFailure, SeatRecentBench} from './seat-health.js';
import type {SeatProbeReading} from './seat-probe.js';

/** The longest piece of a seat's own words that may ride in the plain sentence. */
const PLAIN_EVIDENCE_MAX = 120;

/**
 * crew#771: a seat's own words, when they are one short plain line — what the plain sentence
 * (`council_ineligible_reason`, a chat refusal) may quote. `null` for anything else: a JSON blob
 * (claude's `auth status` prints its whole config, two home paths included), a path, several lines
 * or a long text. Those stay in `auth_evidence`, the technical-details field.
 */
export function plainEvidence(detail: string): string | null {
  const t = detail.trim();
  if (t === '' || t.length > PLAIN_EVIDENCE_MAX || /[\r\n{}\[\]]/.test(t)) return null;
  // Any separator at all: absolute, relative (`.wicked-worker/claude/…`), `~/`, a drive letter, a
  // URL without a scheme (`example.com/<account>/…`) — none can be told apart from a harmless `a/b`
  // cheaply and safely, so a slash or a backslash keeps the words out of the sentence (codex on #797).
  if (/[\\/]/.test(t)) return null;
  return t;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `auth_evidence` with the operator's home directory written `~` (crew#771: screen shares and
 * recordings). Only the home as a whole path segment — `/home/al` never eats the start of
 * `/home/alice` — and in every separator spelling: `/`, `\`, and the JSON-escaped `\\` a Windows
 * home takes inside a CLI's JSON status (codex on #797). A root home (`/`) is left alone.
 */
export function homeless(detail: string, home: string = homedir()): string {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed === '') return detail;
  const back = trimmed.replace(/\//g, '\\');
  const spellings = new Set([trimmed, trimmed.replace(/\\/g, '/'), back, back.replace(/\\/g, '\\\\')]);
  let out = detail;
  for (const h of [...spellings].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(`${escapeRegExp(h)}(?=$|[\\\\/\\s"'),;:])`, 'g'), '~');
  return out;
}

/** The seat's auth state, read for what it MEANS for the seat's usability. */
export type SeatAuth = 'signed_in' | 'signed_out' | 'not_required' | 'unknown';

/**
 * Seats known to answer with NO credential at all — a free tier the CLI selects by itself when no
 * provider is configured. A CREW-SIDE HEURISTIC, keyed by roster `key` (independent review of #533,
 * F-1): the CLI registry declares no credential requirement today (`AgenticCli` has none;
 * `AcpConfig.auth_method` is the ACP transport's auth, `None` for every built-in), so the daemon
 * cannot read this off the record and says so on the wire (`free_tier_source: 'crew-heuristic'`).
 * The day the `[cli]` record carries `credential = "optional"` (wicked-core follow-up), {@link seatAuth}
 * reads the record first and reports `free_tier_source: 'registry'` — this table is the fallback.
 * opencode runs its free "OpenCode Zen" models (`big-pickle` and friends) with no account, which is
 * exactly what the fresh-rig chat exercised (F-2R2-009).
 */
export const FREE_TIER_SEATS: Readonly<Record<string, string>> = Object.freeze({
  opencode: 'OpenCode Zen free models (no account needed)',
});

/** Where a `not_required` reading came from: the CLI's registry record, or crew's own table. */
export type FreeTierSource = 'registry' | 'crew-heuristic';

/** The auth reading for one seat: the probe's answer, re-read against the seat's credential requirement. */
export function seatAuth(seat: StandingSeat, signedIn: boolean | null): { auth: SeatAuth; free_tier?: string; free_tier_source?: FreeTierSource } {
  if (signedIn === true) return { auth: 'signed_in' };
  if (signedIn === null) return { auth: 'unknown' };
  // The registry record wins when it declares the requirement (forward-compatible with the core
  // follow-up: `credential: "optional"` + an optional `free_tier` label on the `[cli]` record).
  if (seat.credential === 'optional') {
    return {
      auth: 'not_required',
      free_tier: typeof seat.free_tier === 'string' && seat.free_tier !== '' ? seat.free_tier : 'free tier declared by the CLI registry',
      free_tier_source: 'registry',
    };
  }
  if (seat.credential === undefined && Object.hasOwn(FREE_TIER_SEATS, seat.key)) {
    return { auth: 'not_required', free_tier: FREE_TIER_SEATS[seat.key] as string, free_tier_source: 'crew-heuristic' };
  }
  return { auth: 'signed_out' };
}

/** The roster fields standing reads. Structural, so both the wire seat and a test stub satisfy it. */
export interface StandingSeat {
  key: string;
  enabled_for_council?: boolean;
  acp?: { acp_input_governance?: boolean; os_sandbox?: boolean } | null;
  /** A registry-declared credential requirement, when the engine's record carries one (future core). */
  credential?: 'required' | 'optional' | string;
  /** A registry-declared free-tier label, when the record carries one (future core). */
  free_tier?: string;
}

export interface SeatStanding {
  auth: SeatAuth;
  /** Present when `auth` is `not_required`: the free tier the seat answers on. */
  free_tier?: string;
  /** Present with `free_tier`: whether the CLI registry declared it, or crew's own table did. */
  free_tier_source?: FreeTierSource;
  /** Where `auth` came from (F-A45-006): `seat-stderr` = the seat ITSELF reported no credential
   *  (a council ballot, a worker failure or the ACP handshake said "No API key found" / 401 …),
   *  which overrides everything else; `probe` (crew#630) = the seat's own auth-status command
   *  answered (`seat-probe.ts`), which overrides the credential-file heuristic; absent = the
   *  file heuristic (`signed_in`) decided. */
  auth_source?: 'seat-stderr' | 'probe';
  /** Present with `auth_source: 'seat-stderr'`, and with `probe` when it read signed out: the
   *  seat's own words, bounded. */
  auth_evidence?: string;
  /** Present with `auth_source: 'probe'`: ISO-8601 of the probe the reading is from. */
  probed_at?: string;
  /** How far `auth` was VERIFIED (crew#645): `live` — the seat answered an authenticated request,
   *  or refused one for want of a credential (its own words decided); `status` — only the CLI's
   *  status command answered, which reads the stored login and not the session (an expired OAuth
   *  login still reads signed in there); `unverified` — nothing asked the seat (no status command,
   *  or its check has not answered or could not tell). */
  login_check: LoginCheck;
  /** Present unless `login_check` is `live`: why the login is not verified, in the operator's words
   *  (it starts "login unverified"). */
  login_note?: string;
  council_eligible: boolean;
  /** Present when `council_eligible` is false: the one reason, in the operator's words. */
  council_ineligible_reason?: string;
}

/** The cause a "no credential" sentence names: `<source>: <its own words>` when they are plain, else the source alone (crew#771). */
export function noCredentialCause(failure: Pick<SeatAuthFailure, 'source' | 'detail'>): string {
  const words = plainEvidence(failure.detail);
  return words === null ? failure.source : `${failure.source}: ${words}`;
}

/** What a signed-out probe says, in the sentence: its own plain words, else "it is not logged in". */
function probeWords(evidence: string | undefined): string {
  const words = evidence === undefined ? null : plainEvidence(evidence);
  return words === null ? 'it is not logged in' : `it cannot authenticate (${words})`;
}

/** See {@link SeatStanding.login_check}. */
export type LoginCheck = 'live' | 'status' | 'unverified';

/** The probe input: its answer, `'pending'` for a probed seat whose check has not answered yet,
 *  `undefined` for a seat with no probe. */
export type ProbeInput = SeatProbeReading | 'pending' | undefined;

/** A seat whose `auth` lets it take a turn — the ONE predicate the roster and the chat share. */
export function authUsable(auth: SeatAuth): boolean {
  return auth !== 'signed_out';
}

export function seatStanding(
  seat: StandingSeat,
  signedIn: boolean | null,
  authFailure: SeatAuthFailure | null = null,
  probeInput: ProbeInput = undefined,
  recentBench: SeatRecentBench | null = null,
): SeatStanding {
  const probe = probeInput === 'pending' ? undefined : probeInput;
  // F-A45-006: the seat's OWN report beats the file probe. The fresh rig's pi read `signed_in`
  // off a present-but-empty `auth.json` while every ballot failed "No API key found"; when the seat
  // itself says it has no credential, `auth` is `signed_out` — the free tier does not apply either
  // (a seat that answers on a free tier does not say "No API key") — and the evidence rides along.
  // crew#630: next, the seat's own auth-status command, when it answered; the file last.
  const read: Pick<SeatStanding, 'auth' | 'auth_source' | 'auth_evidence' | 'probed_at' | 'free_tier' | 'free_tier_source'> =
    authFailure !== null
      ? { auth: 'signed_out' as const, auth_source: 'seat-stderr' as const, auth_evidence: homeless(authFailure.detail) }
      : probe !== undefined && probe.signedIn !== null
        ? {
            auth: probe.signedIn ? ('signed_in' as const) : ('signed_out' as const),
            auth_source: 'probe' as const,
            probed_at: probe.probedAt,
            ...(probe.signedIn ? {} : { auth_evidence: homeless(probe.detail) }),
          }
        : seatAuth(seat, signedIn);
  const auth = read.auth;
  const login = loginCheck(seat.key, authFailure, probeInput);
  const base: SeatStanding = {
    ...read,
    ...login,
    council_eligible: true,
  };
  if (seat.enabled_for_council === false) {
    return { ...base, council_eligible: false, council_ineligible_reason: 'not enabled for council' };
  }
  if (!authUsable(auth)) {
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason:
        authFailure !== null
          ? `signed out — the seat itself reported no credential (${noCredentialCause(authFailure)}); sign it in from the System page`
          : read.auth_source === 'probe'
            ? `signed out — the seat's own auth check says ${probeWords(read.auth_evidence)}; sign it in from the System page`
            : 'signed out — a council would bench this seat on its first ballot; sign it in from the System page',
    };
  }
  // A seat the ENGINE benched in a recent run on its own refusal (`seatBenched`: out of quota, not
  // installed, signed out at work time) stays out of councils until the window lifts or it does
  // work again (`SeatHealthTracker.recentBenchFor`). Its sign-in may read fine — that is the case
  // this exists for: since wicked-core#590 S5 no ballot finds such a seat before routing, and every
  // new run handed it a unit. The reason leads with the engine's cause token, so the engine's
  // `degradedReason` names it (`copilot (recent quota_exhausted — launcher)`).
  if (recentBench !== null) {
    const cause = recentBench.reason.split(' (', 1)[0]!.trim();
    const run = recentBench.run !== undefined ? ` in run ${recentBench.run.slice(0, 8)}` : '';
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason:
        `recent ${cause} — the engine benched it${run} at ${hhmm(recentBench.at)} (${recentBench.source}: ` +
        `${recentBench.reason}); eligible again at ${hhmm(recentBench.until)}, or sooner once it completes a turn`,
    };
  }
  // crew#645: a seat that HAS a login check which has not answered is not routed to on the file's
  // word — a launch waits for the check (`SeatProbe.ensureFresh`), and anything that routes before
  // it answers (the seconds after a boot) leaves the seat out of the council. `auth` stays
  // `unknown`, so a chat still offers it (a chat is not a council; its first refusal signs it out).
  if (probeInput === 'pending' && authFailure === null) {
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason:
        "login not verified yet — the seat's own auth check is still running; a launch waits for it, so launch again in a few seconds",
    };
  }
  // (R5 / R5b, DES-L3 PR-3D) No `inactive` arm and no crew-classified bench: `health.status` is
  // always `active` (observed errors stamp `lastErrorAt` only). The only bench read here is the
  // ENGINE's own (`recentBench` above — its verdict, carried for a bounded window), never one crew
  // predicts from its own count of failures. The runtime health reading is therefore not an INPUT
  // to standing: the parameter is gone rather than silenced, so a caller cannot think it still
  // decides something.
  return base;
}

/** Why a seat was not seated (F-A45-011; `ChatSeatRefusal.source` on the wire): `auth` — signed
 *  out; `scope` — the scoped-chat admission rule;
 *  `budget` — the engine did not seat it (its warm-up timed out or it was dropped at dispatch; R5b —
 *  crew keeps no council bench of its own, so the engine's per-run bench surfaces here);
 *  `engine` — the engine refused it with its own reason. */
export type ChatRefusalSource = 'auth' | 'scope' | 'budget' | 'engine';

export type ChatAdmission = { ok: true } | { ok: false; reason: string; source: ChatRefusalSource };

/**
 * Whether a chat seats this seat BY DEFAULT — the seat's own auth standing plus, for a SCOPED chat,
 * the engine's admission rule (`acp_runner.rs` `scoped_seat_admission`) restated so a refused seat
 * is named with its reason instead of silently absent (F-2R2-007). Explicitly requested seats
 * (`clis`) bypass this: the engine refuses them per seat, and its reason rides on the outcome.
 * Takes the seat's `auth` only (independent review of #533, F-4): a chat is not a council, so
 * `council_eligible` / health are deliberately NOT consulted here — a seat benched in councils can
 * still answer a chat, and saying otherwise would refuse a working seat.
 */
export function chatSeatAdmission(
  seat: StandingSeat,
  auth: SeatAuth,
  scoped: boolean,
  /** `pool`: the warm chat pool (an ACP session held read-only — the structural rules below).
   *  `path` (ASK-C1/C2, DES-ASK-TEAM-CHAT-001 §4.2): an ask is a team RUN. The seat's standing
   *  (signed in, enabled) is the gate; the structural rule stays ONLY where the run itself cannot
   *  hold the repositories read-only — a scoped ask that is not bound to one repository (several
   *  repos, a project, everything): no worktree, no guard, no default sandbox (codex on #810 r9).
   *  `path-bound`: a single-repo ask — the run is bound (worktree snapshot + guard + mutation
   *  check), so every seat in standing is eligible, wrapped ones included. */
  kind: 'pool' | 'path' | 'path-bound' = 'pool',
): ChatAdmission {
  const reasons: string[] = [];
  let source: ChatRefusalSource = 'scope';
  if (!authUsable(auth)) {
    reasons.push('signed out — it cannot take a turn until it is signed in from the System page');
    source = 'auth';
  }
  if (seat.enabled_for_council === false) {
    reasons.push('disabled for the council, so it takes no turn');
  }
  if (kind === 'path-bound' || (kind === 'path' && !scoped)) {
    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; '), source };
  }
  const acp = seat.acp ?? undefined;
  if (kind === 'path') {
    // A scoped ask the run cannot bind: the seat must hold itself read-only.
    if (acp === undefined) {
      reasons.push(
        'it has no ACP adapter and this ask reads several repositories (or a project) the run cannot bind, ' +
          'so nothing would hold them read-only for it — scope the ask to one repository to include it',
      );
    } else if (acp.acp_input_governance !== true && acp.os_sandbox !== true) {
      reasons.push(
        'its ACP adapter asks no permissions and its record arms no OS sandbox, and this ask reads several ' +
          'repositories (or a project) the run cannot bind — scope the ask to one repository to include it',
      );
    }
    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; '), source };
  }
  if (acp === undefined) {
    // F-W1-003 = A (approved 2026-09-15): chat runs on ACP-adapter seats only, scoped AND
    // unscoped. A seat with no ACP adapter is a WRAPPED seat — it does governed work in runs, but
    // it has no in-process turn/permission channel to hold a chat session, so it is never a chat
    // seat and is not offered in either mode (was: admitted to an unscoped chat).
    reasons.push(
      'it has no ACP adapter, so it is not a chat seat — chat runs on ACP-adapter seats only, and ' +
        'this seat does governed work in runs instead',
    );
  } else if (scoped && acp.acp_input_governance !== true && acp.os_sandbox !== true) {
    reasons.push(
      'its ACP adapter asks no permissions and its record arms no OS sandbox, so a scoped chat ' +
        'could not hold the repositories read-only for it (open the chat unscoped to include it)',
    );
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; '), source };
}

/** `HH:MMZ` of an ISO-8601 stamp, for a reason an operator reads at a glance. */
function hhmm(iso: string): string {
  return `${iso.slice(11, 16)}Z`;
}

/** How far the seat's login was verified, and why not further (crew#645). */
function loginCheck(key: string, authFailure: SeatAuthFailure | null, probe: ProbeInput): { login_check: LoginCheck; login_note?: string } {
  if (authFailure !== null) return { login_check: 'live' };
  if (probe === 'pending') {
    return { login_check: 'unverified', login_note: "login unverified — the seat's own auth check has not answered yet" };
  }
  if (probe === undefined) {
    return {
      login_check: 'unverified',
      login_note: `login unverified — nothing asked ${key} whether its login works (no auth-status check), so its sign-in is read from its credential file; its first refused turn signs it out`,
    };
  }
  if (probe.signedIn === null) {
    return { login_check: 'unverified', login_note: `login unverified — the seat's own auth check could not tell (${probe.detail})` };
  }
  if (probe.check === 'live') return { login_check: 'live' };
  return {
    login_check: 'status',
    login_note: `login unverified — only the CLI's status command answered, and it reads the stored login, not the session (${probe.detail})`,
  };
}
