// wicked-studio#388 (crew half): `GET /skills` reports the plugin INSTALLED on this host, so a
// surface can say when the daemon's baseline — and therefore every snapshot published from it — is
// behind the operator's install.
//
// From the MCP S8 dogfood. The published snapshot was generation 5, captured before
// wicked-garden#1192 added `scripts/mcp/shim.py`, so the first governed run failed with
// `scripts/mcp/shim.py: not found under the plugin root …/snapshots/000005`. Refresh baseline →
// Publish fixed it, but nothing had told the operator the root was behind their install — and every
// MCP call a worker makes goes through that shim.
//
// The comparison is the CONTENT HASH, the identity `refresh-baseline` itself decides on: a checkout
// that moved without a version bump is the dogfood's exact case, so a version-string comparison
// would have reported agreement.
import { afterEach, expect, it, vi } from 'vitest';

import { installedPluginState, installedPluginStateAsync } from '../src/skills/installed.js';
import type { FileRecord } from '../src/skills/tree.js';
import { gitStateOf, gitStateOfAsync, type PluginSource } from '../src/skills/plugin-source.js';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scaffold, type Scaffold } from './support/skills-fixture.js';
import { removeScratch } from './setup/scratch.js';

const SOURCE: PluginSource = { path: '/garden', kind: 'checkout', plugin_version: '12.38.1' };
const BUNDLE: FileRecord[] = [{ rel: 'scripts/mcp/shim.py', abs: '/garden/scripts/mcp/shim.py' }];

it('reports the installed bundle hash, comparable with the manifest baseline', () => {
  const state = installedPluginState({
    discover: () => SOURCE,
    bundle: (root) => {
      expect(root).toBe('/garden');
      return BUNDLE;
    },
    hash: (files) => {
      expect(files).toEqual(BUNDLE);
      return 'a'.repeat(64);
    },
    git: () => ({ git_sha: 'deadbeefcafe' }),
  });

  expect(state).toEqual({
    source: { kind: 'checkout', path: '/garden', plugin_version: '12.38.1' },
    git_sha: 'deadbeefcafe',
    baseline: 'a'.repeat(64),
    unreadable: null,
  });
  // The dogfood's shape: the root's baseline is another hash, so the page can say the snapshot is
  // behind the install. A version comparison could not have: the version had not moved.
  expect(state!.baseline).not.toBe('b'.repeat(64));
});

it('a bundle it cannot read is STATED, never reported as agreement', () => {
  const state = installedPluginState({
    discover: () => SOURCE,
    bundle: () => {
      throw new Error('a symlink stands in for scripts/');
    },
    git: () => ({ git_sha: null }),
  });

  expect(state?.baseline, 'null, so no caller can read it as "same as the baseline"').toBeNull();
  expect(state?.unreadable).toBe('a symlink stands in for scripts/');
  expect(state?.source.plugin_version).toBe('12.38.1');
});

it('no installed plugin is null, not an invented identity', () => {
  expect(installedPluginState({ discover: () => null })).toBeNull();
});

const scratch: Scaffold[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const sc of scratch.splice(0)) removeScratch(sc.base);
});

it('crew#1021: async installed probe has the same bundle identity as the synchronous probe', async () => {
  const sc = scaffold();
  scratch.push(sc);
  expect(await sc.store.installedStateAsync()).toEqual(sc.store.installedState());
  expect(await installedPluginStateAsync({ discover: () => null })).toBeNull();
});

it('crew#1021: async bundle probing still refuses links among designated entries', async () => {
  const sc = scaffold();
  scratch.push(sc);
  symlinkSync(sc.base, join(sc.upstream, 'skills', 'outside'));
  const state = await sc.store.installedStateAsync();
  expect(state?.baseline).toBeNull();
  expect(state?.unreadable).toContain('skills/outside is a symlink');
});

it('crew#1021: async git preserves the non-checkout and unreadable-checkout answers', async () => {
  expect(await gitStateOfAsync({ ...SOURCE, kind: 'directory' })).toEqual(gitStateOf({ ...SOURCE, kind: 'directory' }));
  const sc = scaffold();
  scratch.push(sc);
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(sc.base, 'no-global-git-config'));
  mkdirSync(join(sc.upstream, '.git'));
  expect(await gitStateOfAsync({ ...SOURCE, path: sc.upstream })).toMatchObject({ git_sha: null, git_dirty: false, error: expect.any(String) });
});
