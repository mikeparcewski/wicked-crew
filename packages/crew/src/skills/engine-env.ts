/**
 * The engine handoff: `WICKED_SKILLS_SNAPSHOT` — exactly ONE variable (design v3 DECISION 2,
 * v3.1 §2, v3.4 §2).
 *
 * wicked-core consumes exactly one skills input — the absolute REAL path of a published snapshot
 * (`<state home>/skills/snapshots/<gen>`, every component — the LAST included — a real directory;
 * never the `current` link itself and never a parent dir it would have to infer a manifest from;
 * `WICKED_SKILLS_CURRENT` is withdrawn — v3.1 §2). Crew resolves `current` and exports the path
 * here; the engine reads `process.env` per worker spawn (the `WICKED_WORKER_HOME` discipline in
 * api/seat-signin.ts), so applying it at boot and after every publish is the whole mechanism — the
 * next spawn sees the new snapshot, no daemon or engine restart.
 *
 * `WICKED_CREW_STATE_HOME` is RETIRED as an engine input (v3.4 §2 — it reverses the round-4
 * "passed alongside" decision; core#399 pass 6 retires it on the engine side too). Core derives the
 * state home it fences from the snapshot path's fixed layout — parent named `snapshots`,
 * grandparent named `skills`, else a config error naming the path — so crew exports NOTHING beside
 * the snapshot. The canonical state home is still REPORTED to humans (`GET /diagnostics` →
 * `skills.stateHome`, `canonicalCrewStateHome()`); it is never an engine input.
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

/** The value this process BOOTED with (the `BOOT_WORKER_HOME` discipline): what "nothing to offer" restores. */
export const BOOT_SKILLS_SNAPSHOT: string | undefined = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

/**
 * `crewStateHome()` with every link resolved — the spelling `GET /diagnostics` reports as
 * `skills.stateHome` for humans (NOT an engine input, v3.4 §2). A state home that does not exist
 * yet (a fresh `--db` parent before the first store lands) is spelled absolute, unresolved.
 */
export function canonicalCrewStateHome(): string {
  const home = crewStateHome();
  try {
    return realpathSync(home);
  } catch {
    return resolve(home);
  }
}

/**
 * Point the engine at `snapshotPath`, or — when the daemon has no published snapshot — restore
 * the booted value, deleting the variable when there was none. `fallback` exists for the unit
 * test of the booted-without-one branch; pass `''` for "none". Nothing else is exported: the
 * snapshot path is the engine's ONE skills input (v3.4 §2).
 */
export function applySkillsSnapshotEnv(
  snapshotPath: string | null | undefined,
  fallback: string | undefined = BOOT_SKILLS_SNAPSHOT,
): void {
  if (typeof snapshotPath === 'string' && snapshotPath !== '') {
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = snapshotPath;
  } else if (typeof fallback === 'string' && fallback !== '') {
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = fallback;
  } else {
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  }
}
