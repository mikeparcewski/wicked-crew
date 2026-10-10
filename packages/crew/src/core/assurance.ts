/**
 * The launcher's half of the engine's assurance contract (wicked-core#850, codex audit EX-01/EX-02;
 * wicked-core-ts >= 0.7.46).
 *
 * The engine refuses, by default, to let a run grade itself: an evaluator unit is never seated on
 * the seat that built what it checks (EX-01: refused at distribution, the run parks at the
 * `dead_seat` gate), and a gate whose judge could not run on a seat distinct from the work's author
 * HOLDS (EX-02: `judge_unavailable`). The explicit opt-out is `LaunchOptions.reducedAssurance`: the
 * creator's seat may then evaluate and a judge-less gate may pass, both disclosed on every receipt.
 *
 * A roster of ONE CLI cannot satisfy either requirement — there is no other seat to evaluate and no
 * other identity to judge. That is the one-CLI quickstart (`npx wicked-crew serve` with only Claude
 * Code signed in). crew never chooses for the caller: a launch on such a roster that did not opt in
 * runs under full assurance (the engine holds it for a distinct seat), and its 201 answer carries
 * {@link LaunchAssuranceNotice} naming the seat and the explicit opt-in to relaunch with.
 */

/** `LaunchRunResponse.assuranceNotice.code`: every work seat of the launch's roster is one CLI identity. */
export const SINGLE_CLI_ROSTER_CODE = 'single_cli_roster' as const;

/**
 * A seat's JUDGE identity, the engine's rule (wicked-core `validator::seat_identity`): the basename of
 * its headless invocation's argv[0], case-folded — so `claude` and `claude-sonnet`, both invoking
 * `claude`, are ONE identity. A seat with no invocation falls back to its key's CLI (`claude#2` →
 * `claude`).
 */
export function seatIdentity(seat: { key: string; headless_invocation?: unknown }): string {
  const inv = typeof seat.headless_invocation === 'string' ? seat.headless_invocation.trim() : '';
  const argv0 = inv.split(/\s+/, 1)[0] ?? '';
  const tok = argv0 !== '' ? argv0 : seat.key.split('#', 1)[0]!;
  return (tok.split(/[\\/]/).pop() ?? tok).toLowerCase();
}

/**
 * The seats of the roster crew hands the engine (`engineRosterJson` output) that can do WORK — and
 * so evaluate or judge — with their identities. Excluded: a seat the launcher benched
 * (`health.usable === false`) and a ballot-only seat (`seat_eligible_for_work === false`, which the
 * engine never routes work or a judge to). A seat with no `health` is usable (the engine treats it as
 * eligible). `null` when the roster does not parse as an array of keyed seats: the engine reports its
 * own parse error, crew does not predict around it.
 */
export function workSeats(engineClisJson: string): Array<{ key: string; identity: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(engineClisJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seats: Array<{ key: string; identity: string }> = [];
  for (const seat of parsed) {
    if (typeof seat !== 'object' || seat === null) return null;
    const s = seat as { key?: unknown; headless_invocation?: unknown; health?: { usable?: unknown }; seat_eligible_for_work?: unknown };
    if (typeof s.key !== 'string' || s.key === '') return null;
    if (s.health?.usable === false || s.seat_eligible_for_work === false) continue;
    seats.push({ key: s.key, identity: seatIdentity({ key: s.key, headless_invocation: s.headless_invocation }) });
  }
  return seats;
}

/** `LaunchRunResponse.assuranceNotice` (api-types 0.102.0). */
export interface LaunchAssuranceNotice {
  code: typeof SINGLE_CLI_ROSTER_CODE;
  message: string;
  /** The seats that can work — all one CLI identity. */
  seats: string[];
  /** Relaunch with these fields to accept reduced assurance (`retryOf` names this run). */
  retryWith: { retryOf: string; reducedAssurance: true };
}

/**
 * The notice a full-assurance launch on a one-CLI roster answers with; `null` when the launch opted
 * in, or its roster has work seats of two CLI identities (or none the launcher could read).
 */
export function launchAssuranceNotice(opts: {
  runId: string;
  reducedAssurance: boolean | undefined;
  engineClisJson: string;
}): LaunchAssuranceNotice | null {
  if (opts.reducedAssurance === true) return null;
  const seats = workSeats(opts.engineClisJson);
  if (seats === null || seats.length === 0) return null;
  const identities = new Set(seats.map((s) => s.identity));
  if (identities.size !== 1) return null;
  const cli = [...identities][0]!;
  const usable = seats.map((s) => s.key);
  return {
    code: SINGLE_CLI_ROSTER_CODE,
    message:
      `Every seat that can work runs ${cli} (${usable.join(', ')}), so no other CLI can evaluate or judge this run's ` +
      `work. Under full assurance the engine refuses a review on its builder's seat and holds a gate that needs a ` +
      `judge, so if this run reviews or changes code it will wait at a gate for a distinct seat. Sign a second CLI ` +
      `in, or relaunch with "reducedAssurance": true to let ${cli} evaluate its own work, disclosed on every receipt.`,
    seats: usable,
    retryWith: { retryOf: opts.runId, reducedAssurance: true },
  };
}
