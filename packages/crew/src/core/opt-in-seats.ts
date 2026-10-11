// (operator ruling 2026-10-11) OPT-IN seats. opencode keeps wedging (30-minute silent ACP units,
// hangs in both modes), so it is never in a DEFAULT seat pool — the roster a launch gets when it
// names none, and (engine side, wicked-core OPT_IN_SEATS) the judge and council pools beyond a run's
// own roster. It stays available whenever the operator picks it (the launch wizard, `clisJson`, a
// clis.toml).

/** The opt-in CLI keys; an instance (`opencode#2`) is its CLI's. */
export const OPT_IN_SEAT_KEYS: readonly string[] = ['opencode'];

/** The one-line note a launch surface shows beside an opt-in seat. */
export const OPT_IN_NOTE = 'opt-in: known to stall';

export function isOptInSeat(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const cli = key.split('#')[0] ?? key;
  return OPT_IN_SEAT_KEYS.includes(cli);
}

/** The DEFAULT launch roster: every seat but the opt-in ones. */
export function defaultLaunchRoster<T extends { key?: unknown }>(roster: readonly T[]): T[] {
  return roster.filter((s) => !isOptInSeat(s.key));
}

/** The roster as `GET /roster` serves it: opt-in seats marked `optIn: true` with their note. */
export function markOptIn<T extends { key?: unknown }>(roster: readonly T[]): Array<T & { optIn?: true; optInNote?: string }> {
  return roster.map((s) => (isOptInSeat(s.key) ? { ...s, optIn: true as const, optInNote: OPT_IN_NOTE } : s));
}
