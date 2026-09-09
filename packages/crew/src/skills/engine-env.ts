/**
 * The engine handoff: `WICKED_SKILLS_SNAPSHOT` (design v3 DECISION 2).
 *
 * wicked-core consumes exactly one input for skills — the CONCRETE path of a published snapshot
 * (`<skills root>/snapshots/<gen>`, never the `current` link and never a parent dir it would have
 * to infer a manifest from). Crew resolves `current` and exports the path here; the engine reads
 * `process.env` per worker spawn (the `WICKED_WORKER_HOME` discipline in api/seat-signin.ts), so
 * applying it at boot, after every publish, and on every settings change is the whole mechanism —
 * the next spawn sees the new snapshot, no daemon or engine restart.
 *
 * The degradation ladder (v3 §3) is the engine's: with the variable unset it falls back to the
 * live installed garden cache and logs `skills.fallback`. Crew therefore only ever exports a path
 * that RESOLVES; when it has nothing to offer (no plugin installed, seed refused) it restores what
 * the process booted with — an operator-exported value, or the hermetic test arming — and
 * deletes the variable when there was none.
 */

export const SKILLS_SNAPSHOT_ENGINE_ENV = 'WICKED_SKILLS_SNAPSHOT';

/** The value this process BOOTED with (the `BOOT_WORKER_HOME` discipline): what "nothing to offer" restores. */
export const BOOT_SKILLS_SNAPSHOT: string | undefined = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

/**
 * Point the engine at `snapshotPath`, or — when the daemon has no published snapshot — restore
 * the booted value, deleting the variable when there was none. `fallback` exists for the unit
 * test of the booted-without-one branch; pass `''` for "none".
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
