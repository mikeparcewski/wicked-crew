/**
 * Per-baseline Python environment (design v3 §4): `uv sync` ONCE per baseline content hash into
 * `<baseline>/.venv`, shared READ-ONLY by every snapshot that links it (`uv run` from a snapshot
 * root finds a synced env through the link). Best-effort by design: the sync is the plugin's
 * convenience, not the daemon's correctness — a missing `uv` is a logged note and `skipped`, a
 * failed sync is logged and `failed`; neither blocks a publish. What DOES hold (codex review of
 * #480): the store awaits the provisioner BEFORE it publishes, so a snapshot never links an env
 * that is still being written; the daemon's own `uv` writes go to a cache under the skills root
 * (`UV_CACHE_DIR`), never the operator's; and every child process runs through `execCapped`
 * (src/core/exec.ts), the daemon's one child-process chokepoint.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execCapped } from '../core/exec.js';
import type { SkillVenvState } from '../core/types.js';

/** A full resolve+install of the plugin's lock can legitimately take minutes on a cold cache. */
export const UV_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** The uv cache dir's name under the skills root — the daemon's writable uv state, redirected. */
export const UV_CACHE_DIRNAME = '.uv-cache';

export interface VenvProvisionOptions {
  log: (message: string) => void;
  /** Absolute dir `UV_CACHE_DIR` is pointed at (under the skills root). */
  cacheDir: string;
}

/** Provision `<baselineDir>/.venv`; resolves to the state to record. Injectable (tests never run uv). */
export type VenvProvisioner = (baselineDir: string, opts: VenvProvisionOptions) => Promise<SkillVenvState>;

/** The `.venv` path a baseline's environment lives at. */
export function baselineVenvDir(baselineDir: string): string {
  return join(baselineDir, '.venv');
}

/** The real provisioner: `uv sync --no-dev [--frozen]` in the baseline dir. */
export const uvSyncBaseline: VenvProvisioner = async (baselineDir, { log, cacheDir }) => {
  if (!existsSync(join(baselineDir, 'pyproject.toml'))) {
    log(`[skills] ${baselineDir} carries no pyproject.toml; venv provisioning skipped`);
    return 'skipped';
  }
  const args = ['sync', '--no-dev'];
  if (existsSync(join(baselineDir, 'uv.lock'))) args.push('--frozen');
  try {
    await execCapped('uv', args, {
      cwd: baselineDir,
      timeout: UV_SYNC_TIMEOUT_MS,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: baselineVenvDir(baselineDir),
        UV_CACHE_DIR: cacheDir,
      },
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
