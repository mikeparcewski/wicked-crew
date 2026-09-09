/**
 * The engine handoff: `WICKED_SKILLS_SNAPSHOT` + `WICKED_CREW_STATE_HOME` (design v3 DECISION 2,
 * v3.1 §1/§2; core#399 round 3).
 *
 * wicked-core consumes exactly one SKILLS input — the absolute REAL path of a published snapshot
 * (`<skills root>/snapshots/<gen>` with every link resolved, never the `current` link itself and
 * never a parent dir it would have to infer a manifest from; `WICKED_SKILLS_CURRENT` is withdrawn —
 * v3.1 §2). Crew resolves `current` and exports the path here; the engine reads `process.env` per
 * worker spawn (the `WICKED_WORKER_HOME` discipline in api/seat-signin.ts), so applying it at boot,
 * after every publish, and on every settings change is the whole mechanism — the next spawn sees
 * the new snapshot, no daemon or engine restart.
 *
 * Beside it, ALWAYS: `WICKED_CREW_STATE_HOME` = the canonical realpath of `crewStateHome()`. Core
 * derives the worker Read fence from it (one deny rule per registered state-home subtree —
 * tests/fixtures/state-home-subtrees.json — with `skills/snapshots/<gen>/` the only non-denied
 * path) instead of recognising a literal `.wicked-crew` basename (core#399 round 3: a scratch or
 * custom state home used to be unfenced), and cross-checks that the snapshot it is handed IS
 * `<state home>/skills/snapshots/<gen>` — a mismatch fails the launch. Exported on every apply,
 * whatever the skills outcome: the fence guards `core.db`, the ledgers and the skills root's
 * mutable halves regardless of whether a snapshot exists.
 *
 * The degradation ladder (v3 §3) is the engine's: with the snapshot variable unset it falls back to
 * the live installed garden cache and logs `skills.fallback`; with it set to a path that does not
 * resolve, every launch FAILS loudly (config error). Crew uses both rungs deliberately
 * (runtime.ts): a VERIFIED snapshot path when it has one; the boot value / unset ONLY when the
 * configuration is absent (no garden installed — an operator-exported value, or the hermetic test
 * arming, survives); and a non-existent refusal path (`<root>/refused/skills.{blocked,config}`)
 * when the configuration is present but defective — a blocked first publish or a corrupt root
 * must never be "restored" into a live-cache fallback that bypasses recorded disablement.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { crewStateHome } from '../projects/state-home.js';

export const SKILLS_SNAPSHOT_ENGINE_ENV = 'WICKED_SKILLS_SNAPSHOT';

/** The daemon state home the engine fences — the canonical realpath of `crewStateHome()`. */
export const CREW_STATE_HOME_ENGINE_ENV = 'WICKED_CREW_STATE_HOME';

/** The value this process BOOTED with (the `BOOT_WORKER_HOME` discipline): what "nothing to offer" restores. */
export const BOOT_SKILLS_SNAPSHOT: string | undefined = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

/**
 * `crewStateHome()` with every link resolved — the spelling core compares the snapshot path
 * against (`realpathSync` on both sides). A state home that does not exist yet (a fresh `--db`
 * parent before the first store lands) is spelled absolute, unresolved.
 */
export function canonicalCrewStateHome(): string {
  const home = crewStateHome();
  try {
    return realpathSync(home);
  } catch {
    return resolve(home);
  }
}

/** Export the fenced state home for the engine; answers the value exported. */
export function applyCrewStateHomeEnv(stateHome: string = canonicalCrewStateHome()): string {
  process.env[CREW_STATE_HOME_ENGINE_ENV] = stateHome;
  return stateHome;
}

/**
 * Point the engine at `snapshotPath`, or — when the daemon has no published snapshot — restore
 * the booted value, deleting the variable when there was none. `fallback` exists for the unit
 * test of the booted-without-one branch; pass `''` for "none". The state home is exported on EVERY
 * call (module header): the fence does not depend on the skills outcome.
 */
export function applySkillsSnapshotEnv(
  snapshotPath: string | null | undefined,
  fallback: string | undefined = BOOT_SKILLS_SNAPSHOT,
): void {
  applyCrewStateHomeEnv();
  if (typeof snapshotPath === 'string' && snapshotPath !== '') {
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = snapshotPath;
  } else if (typeof fallback === 'string' && fallback !== '') {
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = fallback;
  } else {
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  }
}
