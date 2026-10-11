// Council settings (operator ruling 2026-10-11, wicked-core#888): how many seats a council
// convenes (`councilSize`, default 3, drawn at random from the run's eligible seats) and how far
// apart its seat spawns are (`councilSpawnStaggerMs`, default 3000).
//
// One mechanism, the same as `worker_config_root` → `WICKED_WORKER_HOME`: the daemon exports the
// persisted values as env at boot and on every settings change, and the engine reads the env per
// council (`wicked_council::pick::{council_size, spawn_stagger}`), so a change is live on the next
// council with no restart. An absent setting deletes the variable and the engine's default holds.

export const COUNCIL_SIZE_ENV = 'WICKED_COUNCIL_SIZE';
export const COUNCIL_STAGGER_ENV = 'WICKED_COUNCIL_SPAWN_STAGGER_MS';

export const COUNCIL_SIZE_MIN = 1;
export const COUNCIL_SIZE_MAX = 9;
export const COUNCIL_STAGGER_MAX_MS = 30_000;

/** A valid `councilSize`: an integer 1..9. */
export function isCouncilSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= COUNCIL_SIZE_MIN && v <= COUNCIL_SIZE_MAX;
}

/** A valid `councilSpawnStaggerMs`: an integer 0..30000. */
export function isCouncilStaggerMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= COUNCIL_STAGGER_MAX_MS;
}

/**
 * Export the council settings to `env` (default: this process, which the in-process engine
 * reads). A missing or invalid value deletes the variable, so the engine's own default applies.
 */
export function applyCouncilSettings(
  settings: { councilSize?: unknown; councilSpawnStaggerMs?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isCouncilSize(settings.councilSize)) env[COUNCIL_SIZE_ENV] = String(settings.councilSize);
  else delete env[COUNCIL_SIZE_ENV];
  if (isCouncilStaggerMs(settings.councilSpawnStaggerMs)) {
    env[COUNCIL_STAGGER_ENV] = String(settings.councilSpawnStaggerMs);
  } else delete env[COUNCIL_STAGGER_ENV];
}
