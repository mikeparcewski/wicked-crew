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
 * Pure, synchronous, no IO: the probe result and the health record are inputs.
 */

import type { CouncilBench, SeatAuthFailure, SeatHealth } from './seat-health.js';

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
   *  which overrides the credential-file probe; absent = the probe (`signed_in`) decided. */
  auth_source?: 'seat-stderr';
  /** Present with `auth_source: 'seat-stderr'`: the seat's own words, bounded. */
  auth_evidence?: string;
  council_eligible: boolean;
  /** Present when `council_eligible` is false: the one reason, in the operator's words. */
  council_ineligible_reason?: string;
  /** Present when THIS daemon's recent councils benched the seat (`SeatHealthTracker.councilBenchFor`). */
  council_bench?: CouncilBench;
}

/** A seat whose `auth` lets it take a turn — the ONE predicate the roster and the chat share. */
export function authUsable(auth: SeatAuth): boolean {
  return auth !== 'signed_out';
}

export function seatStanding(
  seat: StandingSeat,
  signedIn: boolean | null,
  health: SeatHealth,
  bench: CouncilBench | null = null,
  authFailure: SeatAuthFailure | null = null,
): SeatStanding {
  // F-A45-006: the seat's OWN report beats the file probe. The fresh rig's pi read `signed_in`
  // off a present-but-empty `auth.json` while every ballot failed "No API key found"; when the seat
  // itself says it has no credential, `auth` is `signed_out` — the free tier does not apply either
  // (a seat that answers on a free tier does not say "No API key") — and the evidence rides along.
  const read =
    authFailure !== null
      ? { auth: 'signed_out' as const, auth_source: 'seat-stderr' as const, auth_evidence: authFailure.detail }
      : seatAuth(seat, signedIn);
  const auth = read.auth;
  const base: SeatStanding = {
    ...read,
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
          ? `signed out — the seat itself reported no credential (${authFailure.source}: ${authFailure.detail}); sign it in from the System page`
          : 'signed out — a council would bench this seat on its first ballot; sign it in from the System page',
    };
  }
  if (health.status === 'inactive') {
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason: `inactive after a seat-level error${health.message !== undefined ? `: ${health.message}` : ''}`,
    };
  }
  if (bench !== null) {
    // The engine's own evidence, from THIS daemon's recent runs (independent review of #533, F-1):
    // a seat that failed its ballots is benched whatever its auth reading says — the free tier
    // that answers a chat can still time out a 40 s dispatch budget.
    const minutes = Math.max(1, Math.round(bench.window_ms / 60_000));
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason:
        `benched by this daemon's recent councils: ${bench.failures} ballot failures in the last ${minutes} min — ` +
        `last ${bench.last_kind}${bench.last_run !== undefined ? ` on run ${bench.last_run.slice(0, 8)}` : ''}` +
        `${bench.last_detail !== undefined ? ` (${bench.last_detail})` : ''}; an ok unit output clears it`,
      council_bench: bench,
    };
  }
  return base;
}

/** Why a seat was not seated (F-A45-011; `ChatSeatRefusal.source` on the wire): `auth` — signed
 *  out; `scope` — the scoped-chat admission rule; `bench` — benched by this daemon's recent councils;
 *  `budget` — the engine did not seat it (its warm-up timed out or it was dropped at dispatch);
 *  `engine` — the engine refused it with its own reason. */
export type ChatRefusalSource = 'auth' | 'scope' | 'bench' | 'budget' | 'engine';

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
export function chatSeatAdmission(seat: StandingSeat, auth: SeatAuth, scoped: boolean): ChatAdmission {
  const reasons: string[] = [];
  let source: ChatRefusalSource = 'scope';
  if (!authUsable(auth)) {
    reasons.push('signed out — it cannot take a turn until it is signed in from the System page');
    source = 'auth';
  }
  if (scoped) {
    const acp = seat.acp ?? undefined;
    if (acp === undefined) {
      reasons.push('it has no ACP adapter registered, and a scoped chat holds only ACP-governed seats');
    } else if (acp.acp_input_governance !== true && acp.os_sandbox !== true) {
      reasons.push(
        'its ACP adapter asks no permissions and its record arms no OS sandbox, so a scoped chat ' +
          'could not hold the repositories read-only for it (open the chat unscoped to include it)',
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; '), source };
}
