/**
 * (F1/F2, program B7) The ONE answer to "which seats may new work use". Agents › "Use <seat> for new work" writes the
 * `newWorkSeats` setting. Every chat job proposal, its edits, the two helpers of a document proposal and the seat
 * words the chat shows read this pool, so a seat the person turned off is never put on work they did not name it on.
 *
 * - `eligible`: the seats that can work now and that work may NAME (`proposalRoster`: enabled, work-eligible, not
 *   signed out, opt-in seats included). Unchanged by the pick: naming a seat on a job is still the person's choice.
 * - `pool`: the seats work is drawn from when nobody named one. With no pick (`newWorkSeats` absent or `null`) it is
 *   the default launch rule over the eligible seats (`defaultLaunchRoster`: no opt-in seat unless it is the only one
 *   that can work); with a pick, the picked eligible seats in roster order, an opt-in seat included (crew#1590:
 *   picking it is the opt-in).
 */
import { defaultLaunchRoster } from './opt-in-seats.js';


export interface PoolSeat {
  key: string;
  name: string;
}

export interface JobSeatPool {
  eligible: readonly PoolSeat[];
  pool: readonly PoolSeat[];
}

/** A `newWorkSeats` value: at most 64 non-blank seat keys of at most 64 characters each. */
export function isSeatKeyList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 64 && v.every((k) => typeof k === 'string' && k.trim() !== '' && k.length <= 64);
}

/**
 * Why the `newWorkSeats` setting can't be honored, so new work is REFUSED rather than drawn from every seat:
 * `settings_unavailable` = the settings file can't be read or parsed (whether a pick is set can't be known);
 * `setting_invalid` = it is set, to something that is not a list of seat keys. Not set at all is not a refusal.
 */
export class NewWorkSeatsRefusal extends Error {
  constructor(
    readonly code: 'settings_unavailable' | 'setting_invalid',
    message: string,
  ) {
    super(message);
  }
}

/** How to set the value again, for a refusal's message (the Agents toggle moves onto it in F1/F2 PR 3). */
export const NEW_WORK_SEATS_FIX =
  'set it again with PUT /api/v1/settings: newWorkSeats is a list of seat keys, or null for the default (every seat that can work; an opt-in seat such as OpenCode only when no other can, so name it in the list to use it)';

export function jobSeatPool(eligible: readonly PoolSeat[], newWorkSeats: readonly string[] | null | undefined): JobSeatPool {
  if (newWorkSeats === null || newWorkSeats === undefined) return { eligible, pool: defaultLaunchRoster(eligible) };
  const picked = new Set(newWorkSeats);
  return { eligible, pool: eligible.filter((s) => picked.has(s.key)) };
}
