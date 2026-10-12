/**
 * The daemon's RESOLVED state home — the ONE directory every crew-side durable store hangs off.
 *
 * # Why this module exists (crew#330 → crew#351 → crew#353)
 *
 * `~/.wicked-crew` is the daemon's DEFAULT state home, not its definition. A daemon started with
 * `--db $SCRATCH/core.db` reads as fully isolated — and anything durable that still resolves from
 * `homedir()` unconditionally silently escapes the isolation and lands in the developer's real
 * home, keyed by ids only the scratch store ever knew, with nothing to reap it. crew#330 observed
 * exactly that for project graphs (41.7 MB of them); #351 fixed it with a bootstrap-threaded state
 * home private to `graph-paths.ts`; crew#353 found the SAME escape in the project settings store.
 *
 * Rather than grow one private seam per store (two setters the bootstrap must remember to call in
 * tandem is how the second one got missed), the seam lives here once: the CLI bootstrap threads
 * the resolved `--db` parent in via {@link setCrewStateHome}, and every store that keeps durable
 * state under the crew home resolves its root through {@link crewStateHome}. Today that is the
 * project graphs (`graph-paths.ts`) and the project settings store (`settings.ts`); a new durable
 * store should resolve here too, never from `homedir()` directly.
 *
 * With no `--db` the resolved state home IS `~/.wicked-crew`, so the default daemon's paths are
 * byte-identical to what they were before either fix. Per-store env overrides
 * (`WICKED_CREW_PROJECT_GRAPH_ROOT`, `WICKED_CREW_PROJECT_SETTINGS`) still outrank the configured
 * state home at their own resolution sites: they are the more specific instruction, and the one
 * the tests and proof scripts already use.
 */

import { homedir, userInfo } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Set once at bootstrap from the `--db` parent; `undefined` for library consumers and unit tests
 * that never boot a daemon (they fall through to the homedir default, the pre-#330 behaviour).
 */
let configuredStateHome: string | undefined;

/** The DEFAULT state home's directory name under the user's home: `~/.wicked-crew`. */
export const DEFAULT_STATE_HOME_DIRNAME = '.wicked-crew';

/** The default state home for a given home directory — `<home>/.wicked-crew`. Pure, so a probe
 *  that already knows which HOME a file was found under can ask "is that home's default state home
 *  the one this daemon runs in?" without consulting the process environment. */
export function defaultStateHome(home: string): string {
  return join(home, DEFAULT_STATE_HOME_DIRNAME);
}

/**
 * Thread the daemon's ACTUAL state home in — called from the CLI bootstrap (the one place that
 * knows the resolved `--db`), before the server constructs any store. `undefined` clears it
 * (tests). Idempotent; the last call wins, which is harmless because a process boots one daemon.
 */
export function setCrewStateHome(stateHome: string | undefined): void {
  configuredStateHome = stateHome;
}

/** The state home every durable store resolves under: the bootstrap-configured `--db` parent when
 *  a daemon is running, the historical `~/.wicked-crew` default otherwise. Under a test runner it
 *  refuses the real user's `~/.wicked-crew` (crew#986, {@link refuseLiveHomeUnderTest}). */
export function crewStateHome(): string {
  return refuseLiveHomeUnderTest(configuredStateHome ?? defaultStateHome(homedir()));
}

/**
 * crew#986: a test must never resolve the operator's LIVE state home. The suite's
 * `tests/setup/hermetic-home.ts` arms a temp one, but only when vitest loads crew's
 * `vitest.config.ts`. A run from another directory (the repo root has no vitest config), or a test
 * that unconfigures the home and leaves it unset, fell back to the real `~/.wicked-crew`: a live
 * daemon's decision ledger held 21 gate decisions written by crew tests that way.
 *
 * So under a test runner (`VITEST` / `NODE_ENV=test`, the posture `server.ts` already keys on),
 * resolving the real user's default state home throws instead. "Real" is the account's home from
 * `os.userInfo()`, which ignores `HOME`, so a test that points `HOME` at a temp dir may still
 * exercise the unconfigured default. Compared by identity, like {@link isDefaultStateHome}.
 */
function refuseLiveHomeUnderTest(stateHome: string): string {
  if (process.env['VITEST'] === undefined && process.env['NODE_ENV'] !== 'test') return stateHome;
  let realHome: string;
  try {
    realHome = userInfo().homedir;
  } catch {
    realHome = homedir();
  }
  if (realSpelling(stateHome) === realSpelling(defaultStateHome(realHome))) {
    throw new Error(
      `crew#986: refusing the live state home (${stateHome}) under a test runner. Run vitest from ` +
        `packages/crew (its vitest.config.ts arms a temp state home), or give the test its own ` +
        `state home (setCrewStateHome) or a temp HOME.`,
    );
  }
  return stateHome;
}

/**
 * Is the daemon on the historical default state home (`~/.wicked-crew`, or none configured)? Compared
 * by IDENTITY, not spelling: a `--db` reached through a link or alias of `~/.wicked-crew` is still the
 * default (codex on #760). Each side is the realpath of its deepest existing ancestor plus the rest.
 */
export function isDefaultStateHome(): boolean {
  return realSpelling(crewStateHome()) === realSpelling(defaultStateHome(homedir()));
}

function realSpelling(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let prefix = abs;
  while (!existsSync(prefix)) {
    const parent = dirname(prefix);
    if (parent === prefix) return abs;
    rest.unshift(basename(prefix));
    prefix = parent;
  }
  try {
    return join(realpathSync.native(prefix), ...rest);
  } catch {
    return abs;
  }
}

/**
 * A core-db path → the state home it implies. Pure and exported so the bootstrap and the
 * regression tests spell the derivation once: `dirname` of the ABSOLUTE db path, so a relative
 * `--db ./scratch/core.db` still lands its stores next to the db it named rather than resolving
 * differently on every later `join`.
 */
export function stateHomeOfDb(dbPath: string): string {
  return dirname(resolve(dbPath));
}
