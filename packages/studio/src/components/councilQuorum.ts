import type { RoutingInfo } from '../api/types.js';

/** The council arm of {@link RoutingInfo}, narrowed once so each renderer doesn't re-narrow it. */
export type CouncilRouting = Extract<RoutingInfo, { method: 'council' }>;

/**
 * How many seats answered, against how many were CONVENED.
 *
 * `returned` alone is not readable: `1` describes a complete one-seat council and a three-seat
 * council that lost two seats, and only `seated` separates them (FINDING-026 D). Every surface
 * that shows one of these numbers goes through here so they cannot drift apart.
 *
 * `seated` is absent on runs recorded by an engine older than the quorum fix. That reads as
 * UNKNOWN — the label falls back to the old wording rather than inventing `seated === returned`,
 * which would relabel every historical collapsed council as a healthy one.
 */
export function quorumLabel(r: CouncilRouting): string {
  return r.seated === undefined ? `${r.returned} polled` : `${r.returned} of ${r.seated} seats`;
}

/**
 * Did the council lose its quorum — i.e. did fewer than a strict majority of the seated seats
 * answer? Mirrors the engine's `consensus = winning_count * 2 > seated`, conservatively: this
 * counts everyone who returned, so it only fires when the shortfall is unambiguous.
 *
 * `false` when `seated` is unknown. An unknown quorum must not be reported as a lost one.
 */
export function lostQuorum(r: CouncilRouting): boolean {
  return r.seated !== undefined && r.returned * 2 <= r.seated;
}

/**
 * Whether the council genuinely agreed with itself, as opposed to nobody having disagreed
 * because nobody was left to.
 *
 * `dissent === 0` alone is NOT unanimity: a three-seat council reduced to one survivor records
 * zero dissent and 100% agreement, and calling that "unanimous" is precisely the false consensus
 * FINDING-026 D was filed against.
 */
export function isUnanimous(r: CouncilRouting): boolean {
  return r.dissent === 0 && !lostQuorum(r);
}
