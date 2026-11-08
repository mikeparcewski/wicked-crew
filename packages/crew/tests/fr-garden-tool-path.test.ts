import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureInstallerToolPath, withInstallerBinDirs } from '../src/setup/tool-path.js';

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'fr-garden-path-'))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('installer tool PATH', () => {
  it('appends existing directories in XDG, local, cargo order, preserving user precedence', () => {
    const dirs = [join(home, 'bin'), join(home, '.local', 'bin'), join(home, '.cargo', 'bin')];
    dirs.forEach((dir) => mkdirSync(dir, { recursive: true }));
    const env = { PATH: '/usr/bin:/bin', XDG_BIN_HOME: dirs[0] };
    // Linux: no app-bundle folder, so a host's Docker Desktop never changes the expectation (codex r1).
    expect(withInstallerBinDirs(env, home, 'linux')).toEqual({ path: ['/usr/bin:/bin', ...dirs].join(':'), added: dirs });
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('skips absent paths and regular files, with no empty leading PATH entry', () => {
    mkdirSync(join(home, '.local'));
    writeFileSync(join(home, '.local', 'bin'), 'not a directory');
    const cargo = join(home, '.cargo', 'bin');
    mkdirSync(cargo, { recursive: true });
    expect(withInstallerBinDirs({ XDG_BIN_HOME: join(home, 'absent') }, home, 'linux')).toEqual({ path: cargo, added: [cargo] });
  });

  it('deduplicates normalized paths, directory aliases and overlapping installer directories', () => {
    const local = join(home, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    symlinkSync(local, join(home, 'alias'));
    expect(withInstallerBinDirs({ PATH: join(home, 'alias'), XDG_BIN_HOME: `${local}/../bin` }, home, 'linux').added).toEqual([]);
    expect(withInstallerBinDirs({ PATH: '', XDG_BIN_HOME: local }, home, 'linux').added).toEqual([local]);
  });

  it('uses Windows Path and semicolons, comparing normalized entries without case sensitivity', () => {
    const env = { Path: 'C:\\Tools;C:\\Users\\TEST\\.local\\bin\\', XDG_BIN_HOME: 'C:\\xdg' };
    expect(withInstallerBinDirs(env, 'C:\\Users\\test', 'win32', () => true)).toEqual({
      path: `${env.Path};C:\\xdg;C:\\Users\\test\\.cargo\\bin`, added: ['C:\\xdg', 'C:\\Users\\test\\.cargo\\bin'],
    });
    expect(withInstallerBinDirs({ PATH: 'C:\\first', Path: 'C:\\other' }, 'C:\\fake', 'win32', () => false).path).toBe('C:\\first');
  });

  it('exports the augmented PATH once and logs added home directories with ~/ spellings', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const logs: string[] = [];
    configureInstallerToolPath(env, home, (message) => logs.push(message), 'linux');
    expect(env.PATH).toBe(`/usr/bin:${join(home, '.local', 'bin')}`);
    expect(logs).toEqual(['[crew] added tool directories to PATH: ~/.local/bin']);
    configureInstallerToolPath(env, home, (message) => logs.push(message), 'linux');
    expect(logs).toHaveLength(1);
    expect(logs.join()).not.toContain(home);
  });

  it('appends Rancher Desktop and Docker Desktop bin folders that exist, after the installer ones (e2e-1105 CJ2)', () => {
    const rd = join(home, '.rd', 'bin');
    mkdirSync(rd, { recursive: true });
    const docker = '/Applications/Docker.app/Contents/Resources/bin';
    const present = (p: string): boolean => p === rd || p === docker;
    expect(withInstallerBinDirs({ PATH: '/usr/bin' }, home, 'darwin', present)).toEqual({ path: `/usr/bin:${rd}:${docker}`, added: [rd, docker] });
    // Linux has no Docker Desktop bundle; a folder that does not exist is never added.
    expect(withInstallerBinDirs({ PATH: '/usr/bin' }, home, 'linux', present).added).toEqual([rd]);
    expect(withInstallerBinDirs({ PATH: '/usr/bin' }, home, 'darwin', () => false).added).toEqual([]);
    // Already on PATH: kept where the person put it.
    expect(withInstallerBinDirs({ PATH: `${rd}:/usr/bin` }, home, 'darwin', present).added).toEqual([docker]);
    // Windows: Docker Desktop's installer puts its bin on PATH, so nothing container-related is added.
    expect(withInstallerBinDirs({ PATH: 'C:\\Tools' }, 'C:\\Users\\test', 'win32', (p) => !p.includes('.local') && !p.includes('.cargo')).added).toEqual([]);
  });

  it('a daemon started without the profile finds a docker that lives only in ~/.rd/bin', () => {
    const rd = join(home, '.rd', 'bin');
    mkdirSync(rd, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    configureInstallerToolPath(env, home, () => undefined, 'linux');
    expect(env.PATH!.split(':')).toContain(rd);
  });
});
