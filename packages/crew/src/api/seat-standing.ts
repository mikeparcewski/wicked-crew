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

import type { SeatHealth } from './seat-health.js';

/** The seat's auth state, read for what it MEANS for the seat's usability. */
export type SeatAuth = 'signed_in' | 'signed_out' | 'not_required' | 'unknown';

/**
 * Seats known to answer with NO credential at all — a free tier the CLI selects by itself when no
 * provider is configured. What the daemon knows about the CLI, not something it observed: opencode
 * runs its free "OpenCode Zen" models (`big-pickle` and friends) with no account, which is exactly
 * what the fresh-rig chat exercised (F-2R2-009). Keyed by roster `key`; the value is the label the
 * UI can show beside "no sign-in".
 */
export const FREE_TIER_SEATS: Readonly<Record<string, string>> = Object.freeze({
  opencode: 'OpenCode Zen free models (no account needed)',
});

/** The auth reading for one seat: the probe's answer, re-read against the seat's free tier. */
export function seatAuth(seatKey: string, signedIn: boolean | null): SeatAuth {
  if (signedIn === true) return 'signed_in';
  if (signedIn === null) return 'unknown';
  return Object.hasOwn(FREE_TIER_SEATS, seatKey) ? 'not_required' : 'signed_out';
}

/** The roster fields standing reads. Structural, so both the wire seat and a test stub satisfy it. */
export interface StandingSeat {
  key: string;
  enabled_for_council?: boolean;
  acp?: { acp_input_governance?: boolean; os_sandbox?: boolean } | null;
}

export interface SeatStanding {
  auth: SeatAuth;
  /** Present when `auth` is `not_required`: the free tier the seat answers on. */
  free_tier?: string;
  council_eligible: boolean;
  /** Present when `council_eligible` is false: the one reason, in the operator's words. */
  council_ineligible_reason?: string;
}

/** A seat whose `auth` lets it take a turn — the ONE predicate the roster and the chat share. */
export function authUsable(auth: SeatAuth): boolean {
  return auth !== 'signed_out';
}

export function seatStanding(seat: StandingSeat, signedIn: boolean | null, health: SeatHealth): SeatStanding {
  const auth = seatAuth(seat.key, signedIn);
  const base: SeatStanding = {
    auth,
    ...(auth === 'not_required' ? { free_tier: FREE_TIER_SEATS[seat.key] as string } : {}),
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
        'signed out — a council would bench this seat on its first ballot; sign it in from the System page',
    };
  }
  if (health.status === 'inactive') {
    return {
      ...base,
      council_eligible: false,
      council_ineligible_reason: `inactive after a seat-level error${health.message !== undefined ? `: ${health.message}` : ''}`,
    };
  }
  return base;
}

export type ChatAdmission = { ok: true } | { ok: false; reason: string };

/**
 * Whether a chat seats this seat BY DEFAULT — the seat's own auth standing plus, for a SCOPED chat,
 * the engine's admission rule (`acp_runner.rs` `scoped_seat_admission`) restated so a refused seat
 * is named with its reason instead of silently absent (F-2R2-007). Explicitly requested seats
 * (`clis`) bypass this: the engine refuses them per seat, and its reason rides on the outcome.
 */
export function chatSeatAdmission(seat: StandingSeat, standing: SeatStanding, scoped: boolean): ChatAdmission {
  const reasons: string[] = [];
  if (!authUsable(standing.auth)) {
    reasons.push('signed out — it cannot take a turn until it is signed in from the System page');
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
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join('; ') };
}
