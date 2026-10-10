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

/** `LaunchRunResponse.assuranceNotice.code`: every usable seat of the launch's roster is one CLI. */
export const SINGLE_CLI_ROSTER_CODE = 'single_cli_roster' as const;

/** The CLI behind a roster key: `claude#2` → `claude` (the engine's `model_of`). */
export function cliOfSeatKey(key: string): string {
  const at = key.indexOf('#');
  return at >= 0 ? key.slice(0, at) : key;
}

/**
 * The usable seats of the roster crew hands the engine (`engineRosterJson` output), by key. A seat
 * the launcher benched (`health.usable === false`) is not usable; a seat with no `health` is (the
 * engine treats it as eligible). `null` when the roster does not parse as an array of keyed seats:
 * the engine reports its own parse error, crew does not predict around it.
 */
export function usableSeatKeys(engineClisJson: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(engineClisJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const keys: string[] = [];
  for (const seat of parsed) {
    if (typeof seat !== 'object' || seat === null) return null;
    const s = seat as { key?: unknown; health?: { usable?: unknown } };
    if (typeof s.key !== 'string' || s.key === '') return null;
    if (s.health?.usable === false) continue;
    keys.push(s.key);
  }
  return keys;
}

/** `LaunchRunResponse.assuranceNotice` (api-types 0.102.0). */
export interface LaunchAssuranceNotice {
  code: typeof SINGLE_CLI_ROSTER_CODE;
  message: string;
  /** The usable seats — all one CLI. */
  seats: string[];
  /** Relaunch with these fields to accept reduced assurance (`retryOf` names this run). */
  retryWith: { retryOf: string; reducedAssurance: true };
}

/**
 * The notice a full-assurance launch on a one-CLI roster answers with; `null` when the launch opted
 * in, or its roster has seats of two CLIs (or none the launcher could read).
 */
export function launchAssuranceNotice(opts: {
  runId: string;
  reducedAssurance: boolean | undefined;
  engineClisJson: string;
}): LaunchAssuranceNotice | null {
  if (opts.reducedAssurance === true) return null;
  const usable = usableSeatKeys(opts.engineClisJson);
  if (usable === null || usable.length === 0) return null;
  const clis = new Set(usable.map(cliOfSeatKey));
  if (clis.size !== 1) return null;
  const cli = [...clis][0]!;
  return {
    code: SINGLE_CLI_ROSTER_CODE,
    message:
      `Every usable seat is ${cli} (${usable.join(', ')}), so no other CLI can evaluate or judge this run's work. ` +
      `Under full assurance the engine refuses a review on its builder's seat and holds a gate whose judge could ` +
      `not run on a distinct seat, so this run will wait at a gate for one. Sign a second CLI in, or relaunch with ` +
      `"reducedAssurance": true to let ${cli} evaluate its own work, disclosed on every receipt.`,
    seats: usable,
    retryWith: { retryOf: opts.runId, reducedAssurance: true },
  };
}
