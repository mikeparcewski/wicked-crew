/**
 * Per-baseline Python environment (design v3 §4): `uv sync` ONCE per baseline content hash into
 * `<baseline>/.venv`, shared READ-ONLY by every snapshot that links it (`uv run` from a snapshot
 * root finds a synced env through the link). The env is REQUIRED, not best-effort (codex round 2
 * on #480: "the required baseline environment is treated as optional"): when the bundle carries a
 * `pyproject.toml`, the daemon must produce the synced, shared, read-only env or the publish is
 * BLOCKED (`venv-failed`) — a missing `uv` is therefore `failed` (install uv), not a shrug. Only a
 * bundle WITHOUT `pyproject.toml` is `skipped` (there is no environment to provision). What also
 * holds: the store awaits the provisioner BEFORE it publishes, so a snapshot never links an env
 * that is still being written; one provisioning runs per baseline hash (concurrent callers await
 * it); the daemon's own `uv` writes go to a cache under the skills root (`UV_CACHE_DIR`), never
 * the operator's; and every child process runs through `execCapped` (src/core/exec.ts), the
 * daemon's one child-process chokepoint.
 */

import { existsSync, rmSync } from 'node:fs';
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

/**
 * Provision `<baselineDir>/.venv`; resolves to the state to record: `synced` (the env is complete),
 * `skipped` (nothing to provision — no `pyproject.toml`), `failed` (the required env could not be
 * built: uv missing, sync error — the store BLOCKS the publish). Injectable (tests never run uv).
 */
export type VenvProvisioner = (baselineDir: string, opts: VenvProvisionOptions) => Promise<SkillVenvState>;

/** The `.venv` path a baseline's environment lives at. */
export function baselineVenvDir(baselineDir: string): string {
  return join(baselineDir, '.venv');
}

/**
 * Written INTO a synced env by the store once `uv sync` completed and before the tree is locked
 * read-only: the on-disk fact "this env is complete". A `.venv` without it is a torn sync and is
 * removed and redone — the manifest is never the authority on what exists on disk.
 */
export const VENV_READY_MARKER = '.wicked-synced';

/**
 * The real provisioner: `uv sync --no-dev [--frozen]` in the baseline dir. The provisioner may write
 * ONLY under `.venv` (codex round 7): the baseline is content-addressed, its bundle files are locked
 * read-only after capture, and publish re-hashes the bundle after this ran (`baseline-corrupt`
 * blocks if anything else changed). A bundle WITHOUT `uv.lock` makes `uv sync` resolve and WRITE a
 * lock beside `pyproject.toml` — a resolution artifact, not bundle content — so it is removed again.
 */
export const uvSyncBaseline: VenvProvisioner = async (baselineDir, { log, cacheDir }) => {
  if (!existsSync(join(baselineDir, 'pyproject.toml'))) {
    log(`[skills] ${baselineDir} carries no pyproject.toml; venv provisioning skipped (nothing to provision)`);
    return 'skipped';
  }
  const lock = join(baselineDir, 'uv.lock');
  const hadLock = existsSync(lock);
  const args = ['sync', '--no-dev'];
  if (hadLock) args.push('--frozen');
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
    if (!hadLock && existsSync(lock)) {
      rmSync(lock, { force: true });
      log(`[skills] uv sync wrote ${lock} (the bundle ships no lock); removed — the baseline stays the bundle its hash names`);
    }
    return 'synced';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`[skills] uv is not installed but ${baselineDir} carries a pyproject.toml — the shared baseline env is REQUIRED; install uv (https://docs.astral.sh/uv/) and publish again`);
      return 'failed';
    }
    log(`[skills] uv sync failed for ${baselineDir}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
};

/**
 * A provisioner that never spawns anything — the unit-test seam. Answers `skipped` ("nothing to
 * provision"), the state the real provisioner reserves for a bundle without `pyproject.toml`.
 */
export const noVenv: VenvProvisioner = async () => 'skipped';
