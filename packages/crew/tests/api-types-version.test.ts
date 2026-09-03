// crew#426 — `apiTypesVersion()` must stamp the WORKSPACE-LOCAL api-types version.
//
// A governed run gets a per-run worktree provisioned with `git worktree add` ALONE — no
// `node_modules`. The old resolution walked `require.resolve.paths('wicked-crew-api-types')`, which
// with no worktree-local `node_modules` falls back to the PARENT clone's symlink → the MAIN
// checkout's (un-bumped) version. So a run that bumped `packages/crew-api-types/package.json` in its
// worktree had its generated manifest + api tests stamped with the WRONG (stale) version. The fix
// reads the workspace-local `packages/crew-api-types/package.json` FIRST, so codegen is correct even
// when `node_modules` is absent (defense-in-depth; the lockfile re-sync is the deliver preflight's
// job — see deliver.ts). These tests prove the workspace read WINS over a differing node_modules
// copy, that the node_modules fallback still works when no workspace source is reachable, and that
// against the real repo the function reads the workspace file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { apiTypesVersion } from '../src/api/endpoint-manifest.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Write `{name, version}` as a package.json at `dir`, creating parents. */
function writePkg(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'wicked-crew-api-types', version }, null, 2)}\n`,
  );
}

/**
 * A crew-shaped fixture tree. Returns the `file://` URL of a stand-in module at the SAME depth the
 * real module sits (`packages/crew/dist/api/endpoint-manifest.js`) — the file itself need not exist,
 * only the ancestor directories the version walk climbs through.
 */
function fixtureModuleUrl(): { url: string; root: string; packagesDir: string; crewDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'crew-apitypes-'));
  roots.push(root);
  const packagesDir = join(root, 'packages');
  const crewDir = join(packagesDir, 'crew');
  const moduleDir = join(crewDir, 'dist', 'api');
  mkdirSync(moduleDir, { recursive: true });
  return {
    url: pathToFileURL(join(moduleDir, 'endpoint-manifest.js')).href,
    root,
    packagesDir,
    crewDir,
  };
}

describe('apiTypesVersion (crew#426)', () => {
  it('reads the WORKSPACE-LOCAL packages/crew-api-types/package.json, winning over a stale node_modules copy', () => {
    const fx = fixtureModuleUrl();
    // The workspace source of truth — the version the run actually bumped.
    writePkg(join(fx.packagesDir, 'crew-api-types'), '9.9.9-workspace');
    // A DIFFERING copy where `require.resolve` would find it (the parent-symlink / stale-node_modules
    // path that used to win). Its presence is the whole point: the workspace read must beat it.
    writePkg(join(fx.crewDir, 'node_modules', 'wicked-crew-api-types'), '0.0.0-stale-nm');

    expect(apiTypesVersion(fx.url)).toBe('9.9.9-workspace');
  });

  it('falls back to the resolvable node_modules copy when no workspace source is reachable', () => {
    const fx = fixtureModuleUrl();
    // No packages/crew-api-types here — only the installed dependency, as in a flat published tree.
    writePkg(join(fx.crewDir, 'node_modules', 'wicked-crew-api-types'), '1.2.3-node-modules');

    expect(apiTypesVersion(fx.url)).toBe('1.2.3-node-modules');
  });

  it('against the real repo, stamps the version from packages/crew-api-types/package.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const workspacePkg = fileURLToPath(
      new URL('../../crew-api-types/package.json', import.meta.url),
    );
    const onDisk = (JSON.parse(readFileSync(workspacePkg, 'utf8')) as { version: string }).version;
    expect(apiTypesVersion()).toBe(onDisk);
  });
});
