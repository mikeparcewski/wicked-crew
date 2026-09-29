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
import { expect, it } from 'vitest';

import { installedPluginState } from '../src/skills/installed.js';
import type { FileRecord } from '../src/skills/tree.js';
import type { PluginSource } from '../src/skills/plugin-source.js';

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
