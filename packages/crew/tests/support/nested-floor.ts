// crew#1191 — the delivery end-to-end suites inside the repository-checks floor.
//
// `deliver-e2e` and `qe-author-tests-e2e` run a REAL engine deliver phase, and its re-verify runs the
// fixture repository's checks inside the engine's OS write boundary (wicked-core `repo_checks::
// floor_probe`). When these suites themselves run inside the floor, as `test_targeted` does on every
// crew governed run that touches `src/api/routes.ts`, the floor already wraps them in `sandbox-exec`,
// and macOS refuses a nested `sandbox_apply` (exit 71). The engine then (correctly) reports that no
// boundary can be armed, refuses the delivery, and parks the run at a deliver refusal gate. The suites
// failed on every macOS floor, base and head alike, and every such run needed an operator override.
// Host load had nothing to do with it: the suites waited out their full 90 s / 480 s on a run that had
// already parked.
//
// When, and only when, the ENGINE reports that it cannot arm a boundary on this host
// (`hostBoundary().armed === false`), these suites take the engine's own disclosed opt-in,
// `WICKED_REPO_CHECKS_UNSANDBOXED=1`, for the run they launch. That is not a skip: the deliver phase
// still runs, the fixture's checks still run and still decide, and the receipt discloses `none` as on
// any opted-in host. The fixture's scripts are this suite's own, and in the floor they already run
// inside the floor's write boundary. Wherever a boundary arms (CI's Linux runners with `bwrap`, a
// developer's shell), nothing changes and the contained path is what runs.

/** The engine's `hostBoundary()` answer, as far as this needs it (wicked-core-ts `Core.hostBoundary`). */
interface HostBoundary {
  armed?: unknown;
  reasonText?: unknown;
}

/** The engine the adapter holds: only `hostBoundary` is read (optional — an older addon lacks it). */
interface WithCore {
  core?: { hostBoundary?: () => Promise<string> };
}

export const UNSANDBOXED_OPT_IN_ENV = 'WICKED_REPO_CHECKS_UNSANDBOXED';

/**
 * Arms {@link UNSANDBOXED_OPT_IN_ENV} for this process when the adapter's engine reports it cannot arm
 * an OS write boundary here, and returns what it did plus the restore. An engine that answers nothing
 * (an older addon, an unreadable answer) leaves the environment as it is: the suite then runs exactly
 * as before.
 */
export async function optInWhenFloorCannotArm(
  adapter: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ optedIn: boolean; reason: string | null; restore: () => void }> {
  const none = { optedIn: false, reason: null, restore: () => undefined };
  const core = (adapter as WithCore).core;
  if (typeof core?.hostBoundary !== 'function') return none;
  let answer: HostBoundary;
  try {
    answer = JSON.parse(await core.hostBoundary()) as HostBoundary;
  } catch {
    return none;
  }
  if (answer.armed !== false) return none;
  const before = env[UNSANDBOXED_OPT_IN_ENV];
  env[UNSANDBOXED_OPT_IN_ENV] = '1';
  return {
    optedIn: true,
    reason: typeof answer.reasonText === 'string' ? answer.reasonText : null,
    restore: () => {
      if (before === undefined) delete env[UNSANDBOXED_OPT_IN_ENV];
      else env[UNSANDBOXED_OPT_IN_ENV] = before;
    },
  };
}

/**
 * A run state from which the delivery a suite waits for can no longer come without a person: the run
 * parked at a gate (these suites launch with `humanConfirm: 'none'` and answer nothing), or it ended
 * without delivering. The waits stop there and report why at once, instead of running out their bound
 * on a run that already decided (crew#1191). `delivery` is resolved after the run ends, so a terminal
 * run is given `graceMs` for the field to land before it counts.
 */
export function deliveryCannotCome(
  session: Record<string, unknown>,
  terminalSince: number | null,
  now: number,
  graceMs = 15_000,
): boolean {
  const status = String(session['status']);
  if (status === 'awaiting_human') return true;
  if (['completed', 'failed', 'cancelled'].includes(status)) {
    return terminalSince !== null && now - terminalSince >= graceMs && session['delivery'] !== 'delivered';
  }
  return false;
}
