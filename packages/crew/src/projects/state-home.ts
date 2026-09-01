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

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Set once at bootstrap from the `--db` parent; `undefined` for library consumers and unit tests
 * that never boot a daemon (they fall through to the homedir default, the pre-#330 behaviour).
 */
let configuredStateHome: string | undefined;

/**
 * Thread the daemon's ACTUAL state home in — called from the CLI bootstrap (the one place that
 * knows the resolved `--db`), before the server constructs any store. `undefined` clears it
 * (tests). Idempotent; the last call wins, which is harmless because a process boots one daemon.
 */
export function setCrewStateHome(stateHome: string | undefined): void {
  configuredStateHome = stateHome;
}

/** The state home every durable store resolves under: the bootstrap-configured `--db` parent when
 *  a daemon is running, the historical `~/.wicked-crew` default otherwise. */
export function crewStateHome(): string {
  return configuredStateHome ?? join(homedir(), '.wicked-crew');
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
