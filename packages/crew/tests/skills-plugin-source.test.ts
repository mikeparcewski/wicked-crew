// Plugin-source discovery (design v3 §3/§8): the LIVE marketplace cache (highest version) or an
// explicit `WICKED_CREW_SKILLS_SOURCE` — never the hand-installed `plugins/wicked-garden` copy
// (the stale artifact the operator's clis.toml hack pointed workers at; codex review of #480).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverLivePlugin, livePluginCacheDir, SKILLS_SOURCE_ENV } from '../src/skills/plugin-source.js';
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
});
