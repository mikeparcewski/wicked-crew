// Plugin-source discovery (design v3 §3/§8): the LIVE marketplace cache (highest version) or an
// explicit `WICKED_CREW_SKILLS_SOURCE` — never the hand-installed `plugins/wicked-garden` copy
// (the stale artifact the operator's clis.toml hack pointed workers at; codex review of #480).

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  discoverLivePlugin,
  livePluginCacheDir,
  PluginSourceSymlinkError,
  pluginSourceAt,
  SKILLS_SOURCE_ENV,
} from '../src/skills/plugin-source.js';
import { removeScratch } from './setup/scratch.js';

let home: string;
let cfg: string;

function plugin(dir: string, version: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skills-source-'));
  cfg = join(home, '.claude');
});

afterEach(() => {
  removeScratch(home);
});

describe('discoverLivePlugin', () => {
  it('answers null when only the hand-installed plugins/wicked-garden copy exists — it is never a fallback', () => {
    plugin(join(cfg, 'plugins', 'wicked-garden'), '12.28.1');
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
  });

  it('picks the highest version in the live marketplace cache, ignoring the hand copy beside it', () => {
    plugin(join(cfg, 'plugins', 'wicked-garden'), '12.28.1');
    plugin(join(livePluginCacheDir(cfg), '12.9.0'), '12.9.0');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    mkdirSync(join(livePluginCacheDir(cfg), 'not-a-plugin'));
    expect(discoverLivePlugin({ env: {}, home })).toEqual({
      path: join(livePluginCacheDir(cfg), '12.32.0'),
      kind: 'claude-plugin-cache',
      plugin_version: '12.32.0',
    });
  });

  it('honours CLAUDE_CONFIG_DIR and the explicit WICKED_CREW_SKILLS_SOURCE override', () => {
    const otherCfg = join(home, 'other-config');
    plugin(join(livePluginCacheDir(otherCfg), '1.0.0'), '1.0.0');
    expect(discoverLivePlugin({ env: { CLAUDE_CONFIG_DIR: otherCfg }, home })?.plugin_version).toBe('1.0.0');
    const explicit = join(home, 'checkout');
    plugin(explicit, '0.0.1-dev');
    expect(discoverLivePlugin({ env: { [SKILLS_SOURCE_ENV]: explicit }, home })).toEqual({
      path: explicit,
      kind: 'directory',
      plugin_version: '0.0.1-dev',
    });
    // An override that is not a plugin root is null, not a fall-through to the cache.
    plugin(join(livePluginCacheDir(cfg), '2.0.0'), '2.0.0');
    expect(discoverLivePlugin({ env: { [SKILLS_SOURCE_ENV]: join(home, 'nowhere') }, home })).toBeNull();
  });

  it('a prerelease never outranks its release, and the pick among prereleases is deterministic (never readdir order — Copilot on #480)', () => {
    plugin(join(livePluginCacheDir(cfg), '12.32.0-beta.2'), '12.32.0-beta.2');
    plugin(join(livePluginCacheDir(cfg), '12.32.0-alpha'), '12.32.0-alpha');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    expect(discoverLivePlugin({ env: {}, home })?.plugin_version).toBe('12.32.0');
    // Only prereleases installed: the highest one, by the total order, whatever the listing order.
    home = mkdtempSync(join(tmpdir(), 'skills-source-pre-'));
    cfg = join(home, '.claude');
    for (const v of ['12.0.0-beta', '12.0.0-alpha', '12.0.0-beta.1', '12.0.0-rc.1']) plugin(join(livePluginCacheDir(cfg), v), v);
    expect(discoverLivePlugin({ env: {}, home })?.plugin_version).toBe('12.0.0-rc.1');
  });

  it('reads plugin.json NO-FOLLOW below a once-resolved root (codex round 6): a symlinked source ROOT is accepted; a symlinked `.claude-plugin/` or `plugin.json` throws PluginSourceSymlinkError naming it — in the live cache too, never a silent skip to another version', () => {
    plugin(join(home, 'real-plugin'), '3.0.0');
    const link = join(home, 'linked-plugin');
    symlinkSync(join(home, 'real-plugin'), link);
    expect(discoverLivePlugin({ env: { [SKILLS_SOURCE_ENV]: link }, home })).toEqual({ path: link, kind: 'directory', plugin_version: '3.0.0' });
    // A symlinked manifest FILE inside the root.
    const tampered = join(home, 'tampered');
    mkdirSync(join(tampered, '.claude-plugin'), { recursive: true });
    writeFileSync(join(home, 'outside.json'), JSON.stringify({ name: 'wicked-garden', version: '4.0.0' }));
    symlinkSync(join(home, 'outside.json'), join(tampered, '.claude-plugin', 'plugin.json'));
    expect(() => pluginSourceAt(tampered)).toThrow(PluginSourceSymlinkError);
    expect(() => pluginSourceAt(tampered)).toThrow(/\.claude-plugin\/plugin\.json is a symlink/);
    // A symlinked manifest DIR.
    const tampered2 = join(home, 'tampered2');
    mkdirSync(tampered2);
    symlinkSync(join(home, 'real-plugin', '.claude-plugin'), join(tampered2, '.claude-plugin'));
    expect(() => pluginSourceAt(tampered2)).toThrow(/\.claude-plugin is a symlink/);
    // In the live cache the refusal is loud too: a tampered version dir is not skipped in favour of another.
    plugin(join(livePluginCacheDir(cfg), '5.0.0'), '5.0.0');
    mkdirSync(join(livePluginCacheDir(cfg), '6.0.0', '.claude-plugin'), { recursive: true });
    symlinkSync(join(home, 'outside.json'), join(livePluginCacheDir(cfg), '6.0.0', '.claude-plugin', 'plugin.json'));
    expect(() => discoverLivePlugin({ env: {}, home })).toThrow(PluginSourceSymlinkError);
  });
});

describe('compareVersions — a TOTAL order (Copilot on #480)', () => {
  const sorted = (versions: string[]): string[] => [...versions].sort(compareVersions);

  it('numeric dotted order first; a prerelease sorts BELOW its release; prereleases compare the semver way', () => {
    expect(sorted(['12.32.0', '12.9.0', '12.0.0', '2.0.0'])).toEqual(['2.0.0', '12.0.0', '12.9.0', '12.32.0']);
    expect(compareVersions('12.0.0-beta', '12.0.0')).toBe(-1);
    expect(compareVersions('12.0.0', '12.0.0-beta')).toBe(1);
    expect(compareVersions('12.0.0-beta', '12.0.1')).toBe(-1); // a prerelease of an OLDER release still sorts below the newer release
    expect(sorted(['12.0.0-beta.11', '12.0.0-beta.2', '12.0.0-alpha', '12.0.0-beta', '12.0.0-1', '12.0.0-rc.1'])).toEqual([
      '12.0.0-1', // numeric identifiers first
      '12.0.0-alpha',
      '12.0.0-beta', // shorter first
      '12.0.0-beta.2',
      '12.0.0-beta.11', // numerically, not lexically
      '12.0.0-rc.1',
    ]);
    expect(sorted(['12.0.0', '12.0'])).toEqual(['12.0', '12.0.0']); // shorter-first on a shared prefix
  });

  it('distinct strings NEVER compare 0 — the same array sorts the same from any starting order', () => {
    expect(compareVersions('12.0.0-alpha', '12.0.0-beta')).not.toBe(0);
    expect(compareVersions('12.00.0', '12.0.0')).not.toBe(0);
    expect(compareVersions('12.0.0-alpha', '12.0.0-alpha')).toBe(0); // only identical strings tie
    const a = ['12.0.0-beta', '12.00.0', '12.0.0', '12.0.0-alpha', 'weird', '12.0.0-beta.1'];
    const b = [...a].reverse();
    expect(sorted(a)).toEqual(sorted(b));
    expect(Math.sign(compareVersions('12.00.0', '12.0.0'))).toBe(-Math.sign(compareVersions('12.0.0', '12.00.0'))); // antisymmetric
  });
});
