// Plugin-source discovery (design v3 §3/§8, amended v3.6 — crew #490, hardened by codex on #491):
// (1) the explicit `WICKED_CREW_SKILLS_SOURCE` override; (2) the marketplace cache of the FIRST config
// dir holding a valid one — the dirs `CLAUDE_CONFIG_DIR` lists, in order, then `~/.claude` appended
// once — with the highest-PRECEDENCE SemVer version-DIRECTORY NAME inside it whose `plugin.json`
// agrees (every dir validated); (3) LAST resort, the installer-managed `plugins/wicked-garden` copy of
// the first of those dirs holding one — recorded as `installer-copy`, never preferred over any cache.
// Each config dir is resolved exactly once; every level below it is lstat-walked on the canonical
// path and a link is skipped with a finding, never followed; manifests are read only below the
// validated canonical dir. Every test runs against a temp HOME with an injected env — the developer's
// real config dir is never read. Homes are realpath'd so spelled == canonical except where a test
// links a config dir deliberately.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cacheDirOrder,
  claudeConfigDirs,
  compareSemver,
  discoverLivePlugin,
  discoverLivePluginDetailed,
  installerCopyDir,
  livePluginCacheDir,
  parseSemver,
  PluginSourceSymlinkError,
  pluginSourceAt,
  SKILLS_SOURCE_ENV,
  type DiscoveryFinding,
} from '../src/skills/plugin-source.js';
import { removeScratch } from './setup/scratch.js';

let home: string;
let cfg: string;
/** Extra temp homes a test creates beside `home` — removed with it (Copilot on #480: reassigning `home` leaked the first one). */
const extraHomes: string[] = [];

/** A fresh, CANONICAL temp home (tmpdir may itself sit behind a link — macOS `/var` → `/private/var`). */
function newHome(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extraHomes.push(dir);
  return dir;
}

function plugin(dir: string, version: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version }));
}

/** Expectations spelled through the same helpers the code uses. */
const cacheAt = (configDir: string, name: string) => ({ path: join(livePluginCacheDir(configDir), name), kind: 'claude-plugin-cache' as const, plugin_version: name });
const copyAt = (configDir: string, version: string) => ({ path: installerCopyDir(configDir), kind: 'installer-copy' as const, plugin_version: version });
const judged = (findings: DiscoveryFinding[]): Array<[string, string]> => findings.map((f) => [f.kind, f.path]);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'skills-source-')));
  cfg = join(home, '.claude');
});

afterEach(() => {
  removeScratch(home);
  for (const extra of extraHomes.splice(0)) removeScratch(extra);
});

describe('claudeConfigDirs (design v3.6; codex on #491)', () => {
  it('is the CLAUDE_CONFIG_DIR entries in order with ~/.claude appended once unless listed; ~/.claude alone when unset or empty', () => {
    const dot = join(home, '.claude');
    expect(claudeConfigDirs({}, home)).toEqual([dot]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '' }, home)).toEqual([dot]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: delimiter }, home)).toEqual([dot]);
    const a = join(home, 'cfg-a');
    const b = join(home, 'cfg-b');
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: a }, home)).toEqual([a, dot]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: [a, '', b].join(delimiter) }, home)).toEqual([a, b, dot]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: [a, dot].join(delimiter) }, home)).toEqual([a, dot]); // listed: not appended again
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: [dot, a].join(delimiter) }, home)).toEqual([dot, a]); // listed first: stays first
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: [a, a].join(delimiter) }, home)).toEqual([a, dot]); // listed twice is walked once
  });
});

describe('discoverLivePlugin', () => {
  it('LAST resort (v3.6): only the installer-managed plugins/wicked-garden copy ⇒ that copy, kind installer-copy, nothing passed over', () => {
    plugin(installerCopyDir(cfg), '12.28.1');
    expect(discoverLivePluginDetailed({ env: {}, home })).toEqual({ source: copyAt(cfg, '12.28.1'), findings: [] });
  });

  it('the cache wins over the copy REGARDLESS of version — a newer copy beside it is never preferred; inside the cache the highest-precedence DIRECTORY NAME wins; a non-SemVer entry is ignored with a finding', () => {
    plugin(installerCopyDir(cfg), '12.40.0'); // newer than anything cached — still the last resort
    plugin(join(livePluginCacheDir(cfg), '12.9.0'), '12.9.0');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    mkdirSync(join(livePluginCacheDir(cfg), 'not-a-plugin'));
    const d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '12.32.0'));
    expect(d.findings).toEqual([{ kind: 'non-semver-name', path: join(livePluginCacheDir(cfg), 'not-a-plugin'), message: expect.stringContaining('not a valid SemVer version') }]);
  });

  it('~/.claude is walked AFTER the listed CLAUDE_CONFIG_DIR entries (appended once): a copy only under ~/.claude is found; a ~/.claude CACHE beats a $CLAUDE_CONFIG_DIR COPY (any cache beats any copy); the listed dir\'s cache beats the ~/.claude cache (first dir with a valid cache wins)', () => {
    const otherCfg = join(home, 'other-config');
    mkdirSync(otherCfg, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: otherCfg };
    plugin(installerCopyDir(cfg), '12.30.0');
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(cfg, '12.30.0'));
    plugin(installerCopyDir(otherCfg), '12.45.0'); // the listed dir's copy is walked first among copies
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(otherCfg, '12.45.0'));
    plugin(join(livePluginCacheDir(cfg), '12.1.0'), '12.1.0'); // a ~/.claude CACHE — older than both copies — beats them
    expect(discoverLivePlugin({ env, home })).toEqual(cacheAt(cfg, '12.1.0'));
    plugin(join(livePluginCacheDir(otherCfg), '1.0.0'), '1.0.0'); // the listed dir's cache — any version — is the first valid cache
    expect(discoverLivePlugin({ env, home })).toEqual(cacheAt(otherCfg, '1.0.0'));
  });

  it('a copy dir without .claude-plugin/plugin.json, or whose plugin.json has no version or is not JSON, is not a source ⇒ null with a no-manifest finding (an ABSENT copy is no finding at all)', () => {
    expect(discoverLivePluginDetailed({ env: {}, home })).toEqual({ source: null, findings: [] });
    mkdirSync(join(installerCopyDir(cfg), 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(installerCopyDir(cfg), 'skills', 'alpha', 'SKILL.md'), '---\nname: wicked-garden-alpha\n---\n');
    const d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toBeNull();
    expect(d.findings).toEqual([{ kind: 'no-manifest', path: installerCopyDir(cfg), message: expect.stringContaining('not a plugin root') }]);
    mkdirSync(join(installerCopyDir(cfg), '.claude-plugin'));
    writeFileSync(join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden' }));
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
    writeFileSync(join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version: '' }));
    expect(discoverLivePlugin({ env: {}, home })).toBeNull();
    // Not JSON at all (Copilot on #491): skipped with the finding, never a crash out of discovery.
    writeFileSync(join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'), '{ not json');
    const corrupt = discoverLivePluginDetailed({ env: {}, home });
    expect(corrupt.source).toBeNull();
    expect(corrupt.findings).toEqual([{ kind: 'no-manifest', path: installerCopyDir(cfg), message: expect.stringContaining('parses with a version') }]);
  });

  it('a CORRUPT plugin.json in one cache dir skips that dir with a no-manifest finding and never takes discovery down — the honest sibling is the pick (Copilot on #491)', () => {
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    mkdirSync(join(livePluginCacheDir(cfg), '12.33.0', '.claude-plugin'), { recursive: true });
    writeFileSync(join(livePluginCacheDir(cfg), '12.33.0', '.claude-plugin', 'plugin.json'), '{ "name": "wicked-garden", "version": ');
    mkdirSync(join(livePluginCacheDir(cfg), '12.31.0', '.claude-plugin'), { recursive: true }); // a manifest DIR with no plugin.json
    const d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '12.32.0'));
    expect(judged(d.findings)).toEqual([
      ['no-manifest', join(livePluginCacheDir(cfg), '12.33.0')],
      ['no-manifest', join(livePluginCacheDir(cfg), '12.31.0')],
    ]);
    for (const f of d.findings) expect(f.message).toContain('parses with a version');
  });

  it('a copy whose DESIGNATED entry is a symlink is REFUSED by name (the existing no-follow rule inside a plugin root) — never accepted, never silently skipped', () => {
    writeFileSync(join(home, 'outside.json'), JSON.stringify({ name: 'wicked-garden', version: '4.0.0' }));
    mkdirSync(join(installerCopyDir(cfg), '.claude-plugin'), { recursive: true });
    symlinkSync(join(home, 'outside.json'), join(installerCopyDir(cfg), '.claude-plugin', 'plugin.json'));
    expect(() => discoverLivePlugin({ env: {}, home })).toThrow(PluginSourceSymlinkError);
    expect(() => discoverLivePlugin({ env: {}, home })).toThrow(/\.claude-plugin\/plugin\.json is a symlink/);
    // A linked manifest DIR in a second home.
    const linkedHome = newHome('skills-source-linked-');
    plugin(join(linkedHome, 'real-plugin'), '4.0.0');
    mkdirSync(installerCopyDir(join(linkedHome, '.claude')), { recursive: true });
    symlinkSync(join(linkedHome, 'real-plugin', '.claude-plugin'), join(installerCopyDir(join(linkedHome, '.claude')), '.claude-plugin'));
    expect(() => discoverLivePlugin({ env: {}, home: linkedHome })).toThrow(/\.claude-plugin is a symlink/);
  });

  it('a symlink at ANY level below the config dir — plugins/, cache/, the marketplace dir, the plugin dir, a version dir, the copy dir — is never followed: skipped with one symlink finding (codex on #491); the config dir ITSELF may be a link and the pick is recorded at its CANONICAL path', () => {
    // A real, valid tree elsewhere for the links to point at — never a config dir itself.
    const elsewhere = join(home, 'elsewhere');
    plugin(join(livePluginCacheDir(elsewhere), '12.0.0'), '12.0.0');
    plugin(installerCopyDir(elsewhere), '12.0.0');
    const levels: Array<[string, string[], string]> = [
      ['plugins/', ['plugins'], join(elsewhere, 'plugins')],
      ['plugins/cache/', ['plugins', 'cache'], join(elsewhere, 'plugins', 'cache')],
      ['the marketplace dir', ['plugins', 'cache', 'wicked-garden'], join(elsewhere, 'plugins', 'cache', 'wicked-garden')],
      ['the plugin dir', ['plugins', 'cache', 'wicked-garden', 'wicked-garden'], livePluginCacheDir(elsewhere)],
      ['a version dir', ['plugins', 'cache', 'wicked-garden', 'wicked-garden', '12.0.0'], join(livePluginCacheDir(elsewhere), '12.0.0')],
      ['the copy dir', ['plugins', 'wicked-garden'], installerCopyDir(elsewhere)],
    ];
    for (const [label, rel, target] of levels) {
      const c = join(home, `cfg-${rel.length}-${rel[rel.length - 1] as string}`);
      mkdirSync(join(c, ...rel.slice(0, -1)), { recursive: true });
      symlinkSync(target, join(c, ...rel));
      const d = discoverLivePluginDetailed({ env: { CLAUDE_CONFIG_DIR: c }, home });
      expect(d.source, label).toBeNull();
      expect(judged(d.findings), label).toEqual([['symlink', join(c, ...rel)]]); // once, even where both tiers meet the link
    }
    // A linked version dir BESIDE a real one: the real one is the pick, the link is recorded, not followed — even when it names a higher version.
    const mixed = join(home, 'cfg-mixed');
    plugin(join(livePluginCacheDir(mixed), '11.0.0'), '11.0.0');
    symlinkSync(join(livePluginCacheDir(elsewhere), '12.0.0'), join(livePluginCacheDir(mixed), '12.0.0'));
    const d = discoverLivePluginDetailed({ env: { CLAUDE_CONFIG_DIR: mixed }, home });
    expect(d.source).toEqual(cacheAt(mixed, '11.0.0'));
    expect(judged(d.findings)).toEqual([['symlink', join(livePluginCacheDir(mixed), '12.0.0')]]);
    // The config dir ITSELF may be a link (operators symlink ~/.claude): resolved exactly once, its real
    // contents accepted, and the pick recorded at the CANONICAL path — the bytes' real location.
    const linkedCfg = join(home, 'cfg-linked');
    symlinkSync(elsewhere, linkedCfg);
    expect(discoverLivePluginDetailed({ env: { CLAUDE_CONFIG_DIR: linkedCfg }, home })).toEqual({ source: cacheAt(elsewhere, '12.0.0'), findings: [] });
    // Two spellings of one dir (the link and its target) walk once.
    expect(discoverLivePluginDetailed({ env: { CLAUDE_CONFIG_DIR: [linkedCfg, elsewhere].join(delimiter) }, home })).toEqual({ source: cacheAt(elsewhere, '12.0.0'), findings: [] });
  });

  it('TOCTOU (codex confirmation pass on #491): the config dir is resolved exactly ONCE — a config-dir link retargeted between the cache walk and the manifest read never has its manifest read; the pick is the pinned root\'s, at its canonical path', () => {
    // Tree A: the honest cache. Tree B: the same version dir declaring something else — reading it
    // through the retargeted link would surface as a version-mismatch finding and no pick.
    const treeA = join(home, 'tree-a');
    const treeB = join(home, 'tree-b');
    plugin(join(livePluginCacheDir(treeA), '12.0.0'), '12.0.0');
    plugin(join(livePluginCacheDir(treeB), '12.0.0'), '99.0.0');
    plugin(installerCopyDir(treeB), '77.0.0'); // and a copy only the retargeted tree has
    const link = join(home, 'cfg-retarget');
    symlinkSync(treeA, link);
    const reads: string[] = [];
    let retargeted = false;
    const d = discoverLivePluginDetailed({
      env: { CLAUDE_CONFIG_DIR: link },
      home,
      hooks: {
        beforeManifestRead: (dir) => {
          reads.push(dir);
          if (!retargeted) {
            retargeted = true;
            rmSync(link);
            symlinkSync(treeB, link); // the link now points at tree B — after the walk pinned tree A
          }
        },
      },
    });
    expect(retargeted).toBe(true);
    expect(realpathSync(link)).toBe(treeB); // the retarget really happened…
    expect(d).toEqual({ source: cacheAt(treeA, '12.0.0'), findings: [] }); // …and was never read: tree A's manifest, at tree A's canonical path
    expect(reads).toEqual([join(livePluginCacheDir(treeA), '12.0.0')]); // every manifest read went below the pinned canonical root
    // The copy tier pins the same root: with no cache anywhere, a retarget before the copy's manifest read is not read either.
    const link2 = join(home, 'cfg-retarget-copy');
    const treeC = join(home, 'tree-c');
    plugin(installerCopyDir(treeC), '1.0.0');
    symlinkSync(treeC, link2);
    let swapped = false;
    const d2 = discoverLivePluginDetailed({
      env: { CLAUDE_CONFIG_DIR: link2 },
      home,
      hooks: {
        beforeManifestRead: () => {
          if (!swapped) {
            swapped = true;
            rmSync(link2);
            symlinkSync(treeB, link2);
          }
        },
      },
    });
    expect(swapped).toBe(true);
    expect(d2).toEqual({ source: copyAt(treeC, '1.0.0'), findings: [] });
  });

  it('CLAUDE_CONFIG_DIR lists several dirs: walked in order — the FIRST dir with a valid cache wins whatever the versions; a cache in a LATER dir beats a copy in an EARLIER dir; among copies the first dir wins', () => {
    const a = join(home, 'cfg-a');
    const b = join(home, 'cfg-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: [a, b].join(delimiter) };
    expect(discoverLivePluginDetailed({ env, home })).toEqual({ source: null, findings: [] });
    plugin(installerCopyDir(b), '12.1.0');
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(b, '12.1.0'));
    plugin(installerCopyDir(cfg), '12.9.0'); // ~/.claude's copy (appended last): a HIGHER version does not jump the order
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(b, '12.1.0'));
    plugin(installerCopyDir(a), '12.0.0'); // the first listed dir's copy wins among copies
    expect(discoverLivePlugin({ env, home })).toEqual(copyAt(a, '12.0.0'));
    plugin(join(livePluginCacheDir(b), '12.5.0'), '12.5.0'); // a cache in the LATER dir beats the copy in the EARLIER dir
    expect(discoverLivePlugin({ env, home })).toEqual(cacheAt(b, '12.5.0'));
    plugin(join(livePluginCacheDir(a), '12.0.0'), '12.0.0'); // the FIRST dir with a valid cache wins — not the highest version across dirs
    expect(discoverLivePlugin({ env, home })).toEqual(cacheAt(a, '12.0.0'));
  });

  it('EVERY SemVer-named cache dir is validated and the plugin.json version must equal the name: a mismatch ANYWHERE is a version-mismatch finding (not only above the winner); the winner is the highest-precedence agreeing name whatever the creation order (codex on #491)', () => {
    // Two dirs both declaring 12.32.0: only the dir NAMED 12.32.0 is the plugin it says it is; the
    // other is BELOW the pick and still validated — a finding.
    plugin(join(livePluginCacheDir(cfg), '12.32.0-rebuild'), '12.32.0');
    plugin(join(livePluginCacheDir(cfg), '12.32.0'), '12.32.0');
    let d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '12.32.0'));
    expect(judged(d.findings)).toEqual([['version-mismatch', join(livePluginCacheDir(cfg), '12.32.0-rebuild')]]);
    // A HIGHER-named dir whose manifest says otherwise is skipped with a finding; the honest 12.32.0 wins.
    plugin(join(livePluginCacheDir(cfg), '12.33.0'), '12.32.0');
    d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '12.32.0'));
    expect(judged(d.findings)).toEqual([
      ['version-mismatch', join(livePluginCacheDir(cfg), '12.33.0')],
      ['version-mismatch', join(livePluginCacheDir(cfg), '12.32.0-rebuild')],
    ]);
    expect(d.findings[0]?.message).toContain('declares version 12.32.0 but the directory is named 12.33.0');
    // A LOWER-named dir declaring a HIGHER version never outranks the pick — and is reported.
    plugin(join(livePluginCacheDir(cfg), '1.0.0'), '99.0.0');
    d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '12.32.0'));
    expect(judged(d.findings)).toEqual([
      ['version-mismatch', join(livePluginCacheDir(cfg), '12.33.0')],
      ['version-mismatch', join(livePluginCacheDir(cfg), '12.32.0-rebuild')],
      ['version-mismatch', join(livePluginCacheDir(cfg), '1.0.0')],
    ]);
    // The same dirs created in REVERSE order in a second home: the same pick, the same findings in the same order.
    const reversed = newHome('skills-source-reversed-');
    const reversedCfg = join(reversed, '.claude');
    plugin(join(livePluginCacheDir(reversedCfg), '1.0.0'), '99.0.0');
    plugin(join(livePluginCacheDir(reversedCfg), '12.33.0'), '12.32.0');
    plugin(join(livePluginCacheDir(reversedCfg), '12.32.0'), '12.32.0');
    plugin(join(livePluginCacheDir(reversedCfg), '12.32.0-rebuild'), '12.32.0');
    const r = discoverLivePluginDetailed({ env: {}, home: reversed });
    expect(r.source).toEqual(cacheAt(reversedCfg, '12.32.0'));
    expect(judged(r.findings)).toEqual([
      ['version-mismatch', join(livePluginCacheDir(reversedCfg), '12.33.0')],
      ['version-mismatch', join(livePluginCacheDir(reversedCfg), '12.32.0-rebuild')],
      ['version-mismatch', join(livePluginCacheDir(reversedCfg), '1.0.0')],
    ]);
    // When EVERY dir mismatches, nothing is picked — a finding each, never a guess.
    const bad = newHome('skills-source-mismatch-');
    const badCfg = join(bad, '.claude');
    plugin(join(livePluginCacheDir(badCfg), '2.0.0'), '2.0.1');
    plugin(join(livePluginCacheDir(badCfg), '1.0.0'), '1.0.1');
    const none = discoverLivePluginDetailed({ env: {}, home: bad });
    expect(none.source).toBeNull();
    expect(judged(none.findings)).toEqual([
      ['version-mismatch', join(livePluginCacheDir(badCfg), '2.0.0')],
      ['version-mismatch', join(livePluginCacheDir(badCfg), '1.0.0')],
    ]);
  });

  it('version-dir names are validated by the official SemVer grammar: `01.0.0`, `1.0.0-alpha..1`, `1.0.0-01`, `1.0`, `v1.0.0` are rejected with a finding each; a valid sibling is still the pick (codex on #491)', () => {
    for (const bad of ['01.0.0', '1.0.0-alpha..1', '1.0.0-01', '1.0', 'v1.0.0', '1.0.0+']) plugin(join(livePluginCacheDir(cfg), bad), bad);
    plugin(join(livePluginCacheDir(cfg), '1.0.0-alpha.1'), '1.0.0-alpha.1');
    const d = discoverLivePluginDetailed({ env: {}, home });
    expect(d.source).toEqual(cacheAt(cfg, '1.0.0-alpha.1'));
    expect(d.findings.map((f) => f.kind)).toEqual(['non-semver-name', 'non-semver-name', 'non-semver-name', 'non-semver-name', 'non-semver-name', 'non-semver-name']);
    expect(d.findings.map((f) => f.path).sort()).toEqual(['01.0.0', '1.0', '1.0.0+', '1.0.0-01', '1.0.0-alpha..1', 'v1.0.0'].map((n) => join(livePluginCacheDir(cfg), n)).sort());
    for (const f of d.findings) expect(f.message).toContain('not a valid SemVer version');
  });

  it('SemVer PRECEDENCE orders the pick — build metadata is ignored for ordering (`1.0.1+build` sorts above `1.0.0`) — and equal precedence has a deterministic tie-break: the plain name, else the lexicographically smallest, under either creation order (codex on #491)', () => {
    plugin(join(livePluginCacheDir(cfg), '1.0.0'), '1.0.0');
    plugin(join(livePluginCacheDir(cfg), '1.0.1+build'), '1.0.1+build');
    expect(discoverLivePluginDetailed({ env: {}, home })).toEqual({ source: cacheAt(cfg, '1.0.1+build'), findings: [] });
    // Equal precedence: the plain release name wins over its build-metadata twin…
    plugin(join(livePluginCacheDir(cfg), '1.0.1'), '1.0.1');
    expect(discoverLivePlugin({ env: {}, home })).toEqual(cacheAt(cfg, '1.0.1'));
    // …created in the other order too.
    const other = newHome('skills-source-tie-');
    const otherCfg = join(other, '.claude');
    plugin(join(livePluginCacheDir(otherCfg), '1.0.1'), '1.0.1');
    plugin(join(livePluginCacheDir(otherCfg), '1.0.1+build'), '1.0.1+build');
    plugin(join(livePluginCacheDir(otherCfg), '1.0.0'), '1.0.0');
    expect(discoverLivePluginDetailed({ env: {}, home: other })).toEqual({ source: cacheAt(otherCfg, '1.0.1'), findings: [] });
    // No plain name among equals: the lexicographically smallest full name, whatever the creation order.
    const builds = newHome('skills-source-builds-');
    const buildsCfg = join(builds, '.claude');
    plugin(join(livePluginCacheDir(buildsCfg), '1.0.1+b'), '1.0.1+b');
    plugin(join(livePluginCacheDir(buildsCfg), '1.0.1+a'), '1.0.1+a');
    expect(discoverLivePlugin({ env: {}, home: builds })).toEqual(cacheAt(buildsCfg, '1.0.1+a'));
    const builds2 = newHome('skills-source-builds2-');
    const builds2Cfg = join(builds2, '.claude');
    plugin(join(livePluginCacheDir(builds2Cfg), '1.0.1+a'), '1.0.1+a');
    plugin(join(livePluginCacheDir(builds2Cfg), '1.0.1+b'), '1.0.1+b');
    expect(discoverLivePlugin({ env: {}, home: builds2 })).toEqual(cacheAt(builds2Cfg, '1.0.1+a'));
  });

  it('honours the explicit WICKED_CREW_SKILLS_SOURCE override — classified by what it IS: a plugins/wicked-garden copy is installer-copy, a cache dir is claude-plugin-cache; not a plugin root ⇒ null, never a fall-through', () => {
    const otherCfg = join(home, 'other-config');
    plugin(join(livePluginCacheDir(otherCfg), '1.0.0'), '1.0.0');
    expect(discoverLivePlugin({ env: { CLAUDE_CONFIG_DIR: otherCfg }, home })).toEqual(cacheAt(otherCfg, '1.0.0'));
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
    // Only prereleases installed: the highest one, by precedence, whatever the listing order — in a SECOND home.
    const preHome = newHome('skills-source-pre-');
    const preCfg = join(preHome, '.claude');
    for (const v of ['12.0.0-beta', '12.0.0-alpha', '12.0.0-beta.1', '12.0.0-rc.1']) plugin(join(livePluginCacheDir(preCfg), v), v);
    expect(discoverLivePlugin({ env: {}, home: preHome })?.plugin_version).toBe('12.0.0-rc.1');
  });

  it('reads plugin.json NO-FOLLOW below a once-resolved root (codex round 6): a symlinked source ROOT is accepted for the override; a symlinked `.claude-plugin/` or `plugin.json` throws PluginSourceSymlinkError naming it — in the live cache too, never a silent skip to another version', () => {
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

describe('parseSemver / compareSemver / cacheDirOrder — semver.org grammar and precedence (codex on #491)', () => {
  it('parses by the official grammar and rejects what it forbids', () => {
    expect(parseSemver('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [], build: null });
    expect(parseSemver('1.0.0-beta+exp.sha.5114f85')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['beta'], build: 'exp.sha.5114f85' });
    expect(parseSemver('1.0.0-x.7.z.92')?.prerelease).toEqual(['x', '7', 'z', '92']);
    expect(parseSemver('1.0.0-0.3.7')?.prerelease).toEqual(['0', '3', '7']);
    expect(parseSemver('1.0.0+20130313144700')?.build).toBe('20130313144700');
    for (const bad of ['01.0.0', '1.0.0-alpha..1', '1.0.0-01', '1.0', 'v1.0.0', '1.0.0+', '1.0.0-', '1.0.0-alpha_1', '', 'weird', '12.00.0']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it('precedence: numeric parts, then prerelease below release, identifiers numeric-before-alphanumeric and numeric-numerically, shorter first; build metadata ignored', () => {
    const sorted = (versions: string[]): string[] => [...versions].sort(compareSemver);
    expect(sorted(['12.32.0', '12.9.0', '12.0.0', '2.0.0'])).toEqual(['2.0.0', '12.0.0', '12.9.0', '12.32.0']);
    expect(compareSemver('12.0.0-beta', '12.0.0')).toBe(-1);
    expect(compareSemver('12.0.0', '12.0.0-beta')).toBe(1);
    expect(compareSemver('12.0.0-beta', '12.0.1')).toBe(-1); // a prerelease of an OLDER release still sorts below the newer release
    expect(sorted(['12.0.0-beta.11', '12.0.0-beta.2', '12.0.0-alpha', '12.0.0-beta', '12.0.0-1', '12.0.0-rc.1'])).toEqual([
      '12.0.0-1', // numeric identifiers first
      '12.0.0-alpha',
      '12.0.0-beta', // shorter first
      '12.0.0-beta.2',
      '12.0.0-beta.11', // numerically, not lexically
      '12.0.0-rc.1',
    ]);
    expect(compareSemver('1.0.1+build', '1.0.0')).toBe(1); // build metadata never lowers a version
    expect(compareSemver('1.0.1', '1.0.1+build')).toBe(0); // …and never orders it either
    expect(() => compareSemver('weird', '1.0.0')).toThrow(TypeError);
  });

  it('cacheDirOrder: highest precedence first; equal precedence → the plain name, else the lexicographically smallest — a total order, the same from any starting order', () => {
    const pick = (names: string[]): string[] => [...names].sort(cacheDirOrder);
    expect(pick(['1.0.0', '1.0.1+build', '1.0.1', '1.0.1+a', '1.0.1-rc.1'])).toEqual(['1.0.1', '1.0.1+a', '1.0.1+build', '1.0.1-rc.1', '1.0.0']);
    const a = ['1.0.1+b', '1.0.1', '1.0.1+a', '1.0.0', '2.0.0-alpha', '1.0.1-beta'];
    expect(pick([...a].reverse())).toEqual(pick(a));
    expect(cacheDirOrder('1.0.1', '1.0.1+build')).toBe(-1);
    expect(cacheDirOrder('1.0.1+a', '1.0.1+b')).toBe(-1);
    expect(cacheDirOrder('1.0.1+a', '1.0.1+a')).toBe(0); // only identical names tie
    expect(Math.sign(cacheDirOrder('1.0.1+a', '1.0.1'))).toBe(-Math.sign(cacheDirOrder('1.0.1', '1.0.1+a'))); // antisymmetric
  });
});
