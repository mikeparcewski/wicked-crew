// Plugin-source discovery (design v3 §3/§8, amended v3.6 — crew #490): (1) the explicit
// `WICKED_CREW_SKILLS_SOURCE` override; (2) the LIVE marketplace cache (highest version) under every
// dir `CLAUDE_CONFIG_DIR` lists, else `~/.claude`; (3) LAST resort, the installer-managed
// `plugins/wicked-garden` copy under those dirs AND `~/.claude` — recorded as `installer-copy`, never
// preferred over a cache whatever the versions say, and held to the same no-follow rule. Every test
// runs against a temp HOME with an injected env — the developer's real config dir is never read.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeConfigDirs,
  compareVersions,
  discoverLivePlugin,
  installerCopyDir,
  livePluginCacheDir,
  PluginSourceSymlinkError,
  pluginSourceAt,
  SKILLS_SOURCE_ENV,
} from '../src/skills/plugin-source.js';
import { removeScratch } from './setup/scratch.js';

let home: string;
let cfg: string;
/** Extra temp homes a test creates beside `home` — removed with it (Copilot on #480: reassigning `home` leaked the first one). */
const extraHomes: string[] = [];

function plugin(dir: string, version: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version }));
}

/** The v3.6 warning text names this path; the tests spell the expectation through the same helper the code uses. */
const copyAt = (configDir: string, version: string) => ({ path: installerCopyDir(configDir), kind: 'installer-copy' as const, plugin_version: version });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skills-source-'));
  cfg = join(home, '.claude');
});

afterEach(() => {
  removeScratch(home);
  for (const extra of extraHomes.splice(0)) removeScratch(extra);
});

describe('claudeConfigDirs (design v3.6: CLAUDE_CONFIG_DIR may list several)', () => {
  it('is ~/.claude when CLAUDE_CONFIG_DIR is unset or lists nothing; else every non-empty entry, in the order listed', () => {
    expect(claudeConfigDirs({}, home)).toEqual([join(home, '.claude')]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '' }, home)).toEqual([join(home, '.claude')]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: delimiter }, home)).toEqual([join(home, '.claude')]);
    const a = join(home, 'cfg-a');
    const b = join(home, 'cfg-b');
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: a }, home)).toEqual([a]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: [a, '', b].join(delimiter) }, home)).toEqual([a, b]);
  });
});

describe('discoverLivePlugin', () => {
  it('LAST resort (v3.6): only the installer-managed plugins/wicked-garden copy in the config dir ⇒ that copy, kind installer-copy', () => {
    plugin(installerCopyDir(cfg), '12.28.1');
    expect(discoverLivePlugin({ env: {}, home })).toEqual(copyAt(cfg, '12.28.1'));
  });

  it('the cache wins over the copy REGARDLESS of version — a newer copy beside it is never preferred; the highest cached version wins, non-plugin entries are ignored', () => {
    plugin(installerCopyDir(cfg), '12.40.0'); // newer than anything cached — still the last resort
    plugin(join(livePluginCacheDir(cfg), '12.9.0'), '12.9.0');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    mkdirSync(join(livePluginCacheDir(cfg), 'not-a-plugin'));
    expect(discoverLivePlugin({ env: {}, home })).toEqual({
      path: join(livePluginCacheDir(cfg), '12.32.0'),
      kind: 'claude-plugin-cache',
      plugin_version: '12.32.0',
    });
  });

  it('only a copy under the literal ~/.claude while CLAUDE_CONFIG_DIR points elsewhere ⇒ that copy (garden\'s install.mjs hard-codes homedir); the cache tier stays the configured dir\'s', () => {
    const otherCfg = join(home, 'other-config');
    mkdirSync(otherCfg, { recursive: true });
    plugin(installerCopyDir(cfg), '12.30.0');
    expect(discoverLivePlugin({ env: { CLAUDE_CONFIG_DIR: otherCfg }, home })).toEqual(copyAt(cfg, '12.30.0'));
    // The cache under ~/.claude is NOT the configured Claude's cache: tier 2 is CLAUDE_CONFIG_DIR's, else ~/.claude — never both.
    plugin(join(livePluginCacheDir(cfg), '12.50.0'), '12.50.0');
    expect(discoverLivePlugin({ env: { CLAUDE_CONFIG_DIR: otherCfg }, home })).toEqual(copyAt(cfg, '12.30.0'));
    // A cache in the configured dir — any version — beats the ~/.claude copy.
    plugin(join(livePluginCacheDir(otherCfg), '1.0.0'), '1.0.0');
    expect(discoverLivePlugin({ env: { CLAUDE_CONFIG_DIR: otherCfg }, home })).toEqual({
      path: join(livePluginCacheDir(otherCfg), '1.0.0'),
      kind: 'claude-plugin-cache',
      plugin_version: '1.0.0',
    });
  });

  it('a copy without .claude-plugin/plugin.json, or whose plugin.json carries no version, is not a source ⇒ null (the seed says "install garden first")', () => {
    mkdirSync(join(installerCopyDir(cfg), 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(installerCopyDir(cfg), 'skills', 'alpha', 'SKILL.md'), '---\nname: wicked-garden-alpha\n---\n');
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
    mkdirSync(join(installerCopyDir(cfg), '.claude-plugin'));
    writeFileSync(join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden' }));
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
    writeFileSync(join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version: '' }));
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
  });

  it('a copy whose designated entry is a symlink is REFUSED by name (the existing no-follow rule applies to every kind) — never accepted, never silently skipped', () => {
    writeFileSync(join(home, 'outside.json'), JSON.stringify({ name: 'wicked-garden', version: '4.0.0' }));
    mkdirSync(join(installerCopyDir(cfg), '.claude-plugin'), { recursive: true });
    symlinkSync(join(home, 'outside.json'), join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'));
    expect(() => discoverLivePlugin({ env: {}, home })).toThrow(PluginSourceSymlinkError);
    expect(() => discoverLivePlugin({ env: {}, home })).toThrow(/\.claude-plugin\/plugin\.json is a symlink/);
    // A linked manifest DIR in a second home.
    const linkedHome = mkdtempSync(join(tmpdir(), 'skills-source-linked-'));
    extraHomes.push(linkedHome);
    plugin(join(linkedHome, 'real-plugin'), '4.0.0');
    mkdirSync(installerCopyDir(join(linkedHome, '.claude')), { recursive: true });
    symlinkSync(join(linkedHome, 'real-plugin', '.claude-plugin'), join(installerCopyDir(join(linkedHome, '.claude')), '.claude-plugin'));
    expect(() => discoverLivePlugin({ env: {}, home: linkedHome })).toThrow(/\.claude-plugin is a symlink/);
  });

  it('CLAUDE_CONFIG_DIR may list several dirs: the highest cached version ACROSS them wins; copies are searched under each of them and under ~/.claude, highest version first', () => {
    const a = join(home, 'cfg-a');
    const b = join(home, 'cfg-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: [a, b].join(delimiter) };
    expect(discoverLivePlugin({ env, home })).toBeNull();
    plugin(installerCopyDir(b), '12.1.0');
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(b, '12.1.0'));
    plugin(installerCopyDir(cfg), '12.2.0'); // ~/.claude's copy — a higher version wins WITHIN the tier
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(cfg, '12.2.0'));
    plugin(join(livePluginCacheDir(a), '12.0.0'), '12.0.0'); // a cache of ANY version beats every copy
    expect(discoverLivePlugin({ env, home })).toEqual({ path: join(livePluginCacheDir(a), '12.0.0'), kind: 'claude-plugin-cache', plugin_version: '12.0.0' });
    plugin(join(livePluginCacheDir(b), '12.5.0'), '12.5.0'); // highest across the listed dirs, not first-listed
    expect(discoverLivePlugin({ env, home })).toEqual({ path: join(livePluginCacheDir(b), '12.5.0'), kind: 'claude-plugin-cache', plugin_version: '12.5.0' });
  });

  it('honours CLAUDE_CONFIG_DIR and the explicit WICKED_CREW_SKILLS_SOURCE override — which is classified by what it IS: a plugins/wicked-garden copy is installer-copy, a cache dir is claude-plugin-cache', () => {
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
    // An override aimed at the installer copy is recorded as the copy it is (and so raises the skills.source warning downstream).
    plugin(installerCopyDir(otherCfg), '9.9.9');
    expect(discoverLivePlugin({ env: { [SKILLS_SOURCE_ENV]: installerCopyDir(otherCfg) }, home })).toEqual(copyAt(otherCfg, '9.9.9'));
    expect(discoverLivePlugin({ env: { [SKILLS_SOURCE_ENV]: join(livePluginCacheDir(otherCfg), '1.0.0') }, home })?.kind).toBe('claude-plugin-cache');
  });

  it('a prerelease never outranks its release, and the pick among prereleases is deterministic (never readdir order — Copilot on #480)', () => {
    plugin(join(livePluginCacheDir(cfg), '12.32.0-beta.2'), '12.32.0-beta.2');
    plugin(join(livePluginCacheDir(cfg), '12.32.0-alpha'), '12.32.0-alpha');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    expect(discoverLivePlugin({ env: {}, home })?.plugin_version).toBe('12.32.0');
    // Only prereleases installed: the highest one, by the total order, whatever the listing order —
    // in a SECOND home (tracked for cleanup; the first stays `home` so afterEach removes both).
    const preHome = mkdtempSync(join(tmpdir(), 'skills-source-pre-'));
    extraHomes.push(preHome);
    const preCfg = join(preHome, '.claude');
    for (const v of ['12.0.0-beta', '12.0.0-alpha', '12.0.0-beta.1', '12.0.0-rc.1']) plugin(join(livePluginCacheDir(preCfg), v), v);
    expect(discoverLivePlugin({ env: {}, home: preHome })?.plugin_version).toBe('12.0.0-rc.1');
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
