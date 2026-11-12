import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifySource, discoverLivePluginDetailed, installerCopyDir, livePluginCacheDir,
  npmLauncherPackageDirs, PluginSourceSymlinkError, REQUIRED_GARDEN_VERSION, SKILLS_SOURCE_ENV,
} from '../src/skills/plugin-source.js';

let home: string;
let crewPackageRoot: string;
const version = REQUIRED_GARDEN_VERSION;
function plugin(dir: string, v = version): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: v }));
  return dir;
}
function npm(dir = join(home, 'prefix', 'lib', 'node_modules', 'wicked-garden'), v = version): string {
  plugin(dir, v);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wicked-garden' }));
  return dir;
}
function launcher(root: string): string {
  const bin = join(home, 'prefix', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'install.mjs'), '');
  symlinkSync(join(root, 'install.mjs'), join(bin, 'wicked-garden'));
  return bin;
}
const discover = (env: NodeJS.ProcessEnv = {}) => discoverLivePluginDetailed({ env, home, crewPackageRoot });
const codex = (market: string, v = version, root = join(home, '.codex')) => join(root, 'plugins', 'cache', market, 'wicked-garden', v);
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'fr-garden-')));
  crewPackageRoot = join(home, 'node_modules', 'wicked-crew');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('non-Claude installed garden discovery', () => {
  it('tier 4a: resolves the POSIX launcher symlink on PATH to its npm package', () => {
    const root = npm();
    expect(discover({ PATH: `${join(home, 'missing')}:${launcher(root)}` }).source).toEqual({ path: root, kind: 'npm-global', plugin_version: version });
  });

  it('tier 4a: computes the Windows .cmd package layout and the prefix/lib fallback', () => {
    expect(npmLauncherPackageDirs('C:\\npm\\wicked-garden.cmd', 'win32')).toEqual([
      'C:\\npm\\node_modules\\wicked-garden', 'C:\\lib\\node_modules\\wicked-garden',
    ]);
  });

  it('tier 4a: tries prefix/lib/node_modules beside a regular launcher', () => {
    const root = npm();
    const bin = join(home, 'prefix', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'wicked-garden'), '#!/bin/sh\n');
    expect(discover({ PATH: bin }).source?.path).toBe(root);
  });

  it('tier 4b: finds the npm package beside crew without a launcher', () => {
    const root = npm(join(dirname(crewPackageRoot), 'wicked-garden'));
    expect(discover().source).toEqual({ path: root, kind: 'npm-global', plugin_version: version });
  });

  it('tier 5: picks the highest valid Codex version across marketplaces and reports invalid entries', () => {
    plugin(codex('a', '12.64.0'), '12.64.0');
    const winner = plugin(codex('b', '12.68.0'), '12.68.0');
    plugin(codex('a', '12.65.0'), '12.65.0');
    const invalid = plugin(codex('b', 'latest'));
    const mismatch = plugin(codex('a', '99.0.0'), '12.64.0');
    const missing = codex('b', '98.0.0');
    mkdirSync(missing);
    const d = discover();
    expect(d.source).toEqual({ path: winner, kind: 'codex-plugin-cache', plugin_version: '12.68.0' });
    expect(d.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'non-semver-name', path: invalid }),
      expect.objectContaining({ kind: 'version-mismatch', path: mismatch }),
      expect.objectContaining({ kind: 'no-manifest', path: missing }),
    ]));
  });

  it('honors CODEX_HOME, resolving its root link once, and classifies an explicit override there', () => {
    const root = join(home, 'codex-config');
    const target = plugin(codex('market', version, root));
    const link = join(home, 'codex-link');
    symlinkSync(root, link);
    expect(discover({ CODEX_HOME: link }).source?.path).toBe(target);
    expect(discover({ CODEX_HOME: link, [SKILLS_SOURCE_ENV]: target }).source?.kind).toBe('codex-plugin-cache');
    expect(discover({ CODEX_HOME: root, [SKILLS_SOURCE_ENV]: target }).source?.kind).toBe('codex-plugin-cache');
    expect(classifySource(plugin(codex('market')))).toBe('codex-plugin-cache');
  });

  it('classifies an explicit Claude cache by its layout even when it carries npm metadata', () => {
    const root = npm(join(livePluginCacheDir(join(home, '.claude')), version));
    expect(discover({ [SKILLS_SOURCE_ENV]: root }).source?.kind).toBe('claude-plugin-cache');
  });

  it('keeps a deliberate garden checkout classified as checkout', () => {
    const root = npm(join(home, 'checkout'));
    mkdirSync(join(root, '.git'));
    expect(discover({ [SKILLS_SOURCE_ENV]: root }).source?.kind).toBe('checkout');
  });

  it('a Claude marketplace cache beats npm-global regardless of version', () => {
    const env = { PATH: launcher(npm(undefined, '99.0.0')) };
    const root = plugin(join(livePluginCacheDir(join(home, '.claude')), version));
    expect(discover(env).source?.path).toBe(root);
  });

  it('a Claude installer copy beats npm-global regardless of version', () => {
    const env = { PATH: launcher(npm(undefined, '99.0.0')) };
    const root = plugin(installerCopyDir(join(home, '.claude')));
    expect(discover(env).source?.path).toBe(root);
  });

  it('npm-global beats the Codex cache regardless of version', () => {
    const root = npm();
    plugin(codex('market', '99.0.0'), '99.0.0');
    expect(discover({ PATH: launcher(root) }).source?.path).toBe(root);
  });

  it('passes over too-old npm-global with a finding and uses the Codex cache', () => {
    const root = npm(undefined, '12.63.0');
    const target = plugin(codex('market'));
    const d = discover({ PATH: launcher(root) });
    expect(d.source?.path).toBe(target);
    expect(d.findings).toContainEqual(expect.objectContaining({ kind: 'too-old', path: root, version: '12.63.0' }));
  });

  it('passes over too-old Codex versions with a finding', () => {
    const old = plugin(codex('market', '12.63.0'), '12.63.0');
    expect(discover()).toMatchObject({ source: null, findings: [expect.objectContaining({ kind: 'too-old', path: old })] });
  });

  it('requires both npm package identity and a versioned plugin manifest', () => {
    const root = npm();
    const env = { PATH: launcher(root) };
    writeFileSync(join(root, 'package.json'), '{"name":"other"}');
    expect(discover(env).source).toBeNull();
    writeFileSync(join(root, 'package.json'), '{bad');
    expect(discover(env).source).toBeNull();
    writeFileSync(join(root, 'package.json'), '{"name":"wicked-garden"}');
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}');
    expect(discover(env)).toMatchObject({ source: null, findings: [expect.objectContaining({ kind: 'no-manifest', path: root })] });
  });

  it('accepts an npm-linked root and classifies explicit npm overrides', () => {
    const root = npm(join(home, 'linked-package'));
    mkdirSync(join(root, '.git'));
    const link = join(dirname(crewPackageRoot), 'wicked-garden');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(root, link);
    expect(discover().source?.path).toBe(root);
    expect(discover({ [SKILLS_SOURCE_ENV]: link }).source?.kind).toBe('npm-global');
  });

  it('reads below the once-resolved npm root even if its link is retargeted before manifest read', () => {
    const root = npm(join(home, 'original'));
    const replacement = npm(join(home, 'replacement'), '99.0.0');
    const link = join(dirname(crewPackageRoot), 'wicked-garden');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(root, link);
    const d = discoverLivePluginDetailed({ env: {}, home, crewPackageRoot, hooks: { beforeManifestRead: () => {
      rmSync(link);
      symlinkSync(replacement, link);
    } } });
    expect(d.source).toMatchObject({ path: root, plugin_version: version });
  });

  it.each(['package.json', '.claude-plugin'])('refuses linked npm designated entries: %s', (entry) => {
    const root = npm();
    const env = { PATH: launcher(root) };
    const target = join(home, `outside-${entry}`);
    if (entry === 'package.json') writeFileSync(target, '{"name":"wicked-garden"}');
    else {
      mkdirSync(target);
      writeFileSync(join(target, 'plugin.json'), JSON.stringify({ version }));
    }
    rmSync(join(root, entry), { recursive: true, force: true });
    symlinkSync(target, join(root, entry));
    expect(() => discover(env)).toThrow(PluginSourceSymlinkError);
  });

  it('skips linked Codex marketplace and version directories with symlink findings', () => {
    const target = plugin(join(home, 'external'));
    const cache = join(home, '.codex', 'plugins', 'cache');
    mkdirSync(join(cache, 'valid', 'wicked-garden'), { recursive: true });
    symlinkSync(target, join(cache, 'linked'));
    symlinkSync(target, codex('valid'));
    const d = discover();
    expect(d.source).toBeNull();
    expect(d.findings.filter((f) => f.kind === 'symlink')).toHaveLength(2);
  });

  it('refuses a linked Codex manifest and ignores skills-only copies', () => {
    const root = plugin(codex('market'));
    const target = join(home, 'outside.json');
    writeFileSync(target, JSON.stringify({ version }));
    rmSync(join(root, '.claude-plugin', 'plugin.json'));
    symlinkSync(target, join(root, '.claude-plugin', 'plugin.json'));
    expect(() => discover()).toThrow(PluginSourceSymlinkError);
    rmSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.pi', 'skills', 'wicked-garden'), { recursive: true });
    expect(discover().source).toBeNull();
  });
});
