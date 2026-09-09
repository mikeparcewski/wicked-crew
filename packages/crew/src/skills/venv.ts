/**
 * Per-baseline Python environment (design v3 §4): `uv sync` ONCE per baseline content hash into
 * `<baseline>/.venv`, shared read-only by every snapshot (each snapshot carries a `.venv` link to
 * it, so `uv run` from the snapshot root finds a synced env). Best-effort by design: the sync is
 * the plugin's convenience, not the daemon's correctness — a missing `uv` is a logged note and
 * `skipped`, a failed sync is logged and `failed`; neither blocks the seed or a publish.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { SkillVenvState } from '../core/types.js';

const execFileAsync = promisify(execFile);

/** A full resolve+install of the plugin's lock can legitimately take minutes on a cold cache. */
export const UV_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** Provision `<baselineDir>/.venv`; resolves to the state to record. Injectable (tests never run uv). */
export type VenvProvisioner = (baselineDir: string, log: (message: string) => void) => Promise<SkillVenvState>;

/** The `.venv` path a baseline's environment lives at. */
export function baselineVenvDir(baselineDir: string): string {
  return join(baselineDir, '.venv');
}

/** The real provisioner: `uv sync --no-dev [--frozen]` in the baseline dir. */
export const uvSyncBaseline: VenvProvisioner = async (baselineDir, log) => {
  if (!existsSync(join(baselineDir, 'pyproject.toml'))) {
    log(`[skills] ${baselineDir} carries no pyproject.toml; venv provisioning skipped`);
    return 'skipped';
  }
  const args = ['sync', '--no-dev'];
  if (existsSync(join(baselineDir, 'uv.lock'))) args.push('--frozen');
  try {
    await execFileAsync('uv', args, {
      cwd: baselineDir,
      timeout: UV_SYNC_TIMEOUT_MS,
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: baselineVenvDir(baselineDir) },
      maxBuffer: 4 * 1024 * 1024,
    });
    return 'synced';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`[skills] uv is not installed; ${baselineDir}/.venv not provisioned (skills that \`uv run\` will resolve their own env)`);
      return 'skipped';
    }
    log(`[skills] uv sync failed for ${baselineDir}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
};

/** A provisioner that never spawns anything — the unit-test seam. */
export const noVenv: VenvProvisioner = async () => 'skipped';
