/**
 * program DES-LEARN §4: what the first run shows before it asks — the registered repositories'
 * languages (`git ls-files`), the git checkouts near them (one level under closed roots, registered ones
 * left out, never the home itself), the git identity, and the operator-trust route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../src/core/types.js';
import { gitIdentity, languagesOf, NEARBY_DEADLINE_MS, nearbyRepos } from '../src/setup/known.js';
import { registerSetupRoutes } from '../src/setup/routes.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'setup-known-')));
  dirs.push(d);
  return d;
}

function gitRepo(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(path, f, '..'), { recursive: true });
    writeFileSync(join(path, f), text);
  }
  execFileSync('git', ['add', '.'], { cwd: path });
}

describe('languagesOf', () => {
  it('counts tracked source files by language, largest first, docs and config left out', async () => {
    const home = scratch();
    gitRepo(join(home, 'code', 'web'), { 'a.ts': '', 'b.tsx': '', 'c.ts': '', 'README.md': '', 'package.json': '{}' });
    gitRepo(join(home, 'code', 'api'), { 'main.go': '', 'x.py': '' });
    const r = await languagesOf([{ root_path: join(home, 'code', 'web') }, { root_path: join(home, 'code', 'api') }, { root_path: join(home, 'gone') }]);
    expect(r.files).toBe(5);
    expect(r.languages.map((l) => l.name)).toEqual(['TypeScript', 'Go', 'Python']);
    expect(r.languages[0]).toMatchObject({ files: 3, share: 0.6 });
  });
});

describe('nearbyRepos', () => {
  it('finds checkouts one level under the code roots and the registered repos\' folders, minus the registered', async () => {
    const home = scratch();
    for (const n of ['web', 'api', '.hidden']) mkdirSync(join(home, 'code', n, '.git'), { recursive: true });
    mkdirSync(join(home, 'code', 'notes'), { recursive: true });
    mkdirSync(join(home, 'elsewhere', 'tool', '.git'), { recursive: true });
    mkdirSync(join(home, 'elsewhere', 'mine', '.git'), { recursive: true });
    mkdirSync(join(home, 'loose', '.git'), { recursive: true });
    // A linked worktree's `.git` is a file.
    mkdirSync(join(home, 'code', 'wt'), { recursive: true });
    writeFileSync(join(home, 'code', 'wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const found = await nearbyRepos([{ root_path: join(home, 'code', 'web') }, { root_path: join(home, 'elsewhere', 'mine') }], home);
    expect(found).toEqual([
      { name: 'api', path: join(home, 'code', 'api') },
      { name: 'tool', path: join(home, 'elsewhere', 'tool') },
      { name: 'wt', path: join(home, 'code', 'wt') },
    ]);
  });

  it('a repository registered directly in the home never makes the home a scan root', async () => {
    const home = scratch();
    mkdirSync(join(home, 'loose', '.git'), { recursive: true });
    expect(await nearbyRepos([{ root_path: join(home, 'top') }], home)).toEqual([]);
  });

  it('a symlink never widens the scan: a root or child resolving outside the home, or to it, is skipped', async () => {
    const base = scratch();
    const home = join(base, 'home');
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'secret', '.git'), { recursive: true });
    mkdirSync(join(home, 'loose', '.git'), { recursive: true });
    mkdirSync(join(home, 'src'), { recursive: true });
    symlinkSync(outside, join(home, 'code'));            // a root that leaves the home
    symlinkSync(home, join(home, 'Projects'));            // a root that IS the home
    symlinkSync(join(outside, 'secret'), join(home, 'src', 'linked')); // a child that leaves the home
    expect(await nearbyRepos([], home)).toEqual([]);
  });

  it('a repository registered through a symlinked path is still recognized as registered', async () => {
    const home = scratch();
    mkdirSync(join(home, 'code', 'web', '.git'), { recursive: true });
    symlinkSync(join(home, 'code'), join(home, 'alias'));
    expect(await nearbyRepos([{ root_path: join(home, 'alias', 'web') }], home)).toEqual([]);
  });

  it('stops at its deadline: the response cap is not the only bound on the work', async () => {
    const home = scratch();
    for (let i = 0; i < 5; i += 1) mkdirSync(join(home, 'code', `r${i}`, '.git'), { recursive: true });
    let t = 0;
    // Each clock read moves time past the deadline after the first entry.
    const found = await nearbyRepos([], home, () => (t += NEARBY_DEADLINE_MS));
    expect(found.length).toBeLessThan(5);
  });
});

describe('gitIdentity', () => {
  it('reads the GLOBAL name and email (never a local repository\'s), null when neither is set', async () => {
    const home = scratch();
    const prior = process.env['GIT_CONFIG_GLOBAL'];
    const priorXdg = process.env['XDG_CONFIG_HOME'];
    try {
      delete process.env['GIT_CONFIG_GLOBAL'];
      delete process.env['XDG_CONFIG_HOME'];
      // The home is itself a checkout with a different local identity: it must not be read.
      execFileSync('git', ['init', '-q'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Local Only'], { cwd: home });
      expect(await gitIdentity(home)).toBeNull();
      writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Sam Rivera\n\temail = sam@example.com\n');
      expect(await gitIdentity(home)).toEqual({ name: 'Sam Rivera', email: 'sam@example.com' });
    } finally {
      if (prior !== undefined) process.env['GIT_CONFIG_GLOBAL'] = prior;
      if (priorXdg !== undefined) process.env['XDG_CONFIG_HOME'] = priorXdg;
    }
  });
});

describe('GET /api/v1/setup/known', () => {
  it('answers the facts for the registered repos, and refuses below operator trust', async () => {
    const app = Fastify();
    const who: { actor?: Actor } = {};
    app.addHook('onRequest', async (req) => { if (who.actor !== undefined) (req as { actor?: Actor }).actor = who.actor; });
    const seen: unknown[] = [];
    registerSetupRoutes(app, {
      adapter: { listRepos: async () => [{ id: 'r1', name: 'web', root_path: '/x/web', default_branch: 'main', registered_at: 0 }] },
      known: async (repos) => { seen.push(repos); return { git: null, languages: [], filesCounted: 0, nearby: [] }; },
    });
    const ok = await app.inject({ method: 'GET', url: '/api/v1/setup/known' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ git: null, languages: [], filesCounted: 0, nearby: [] });
    expect(seen).toHaveLength(1);
    who.actor = { id: 'viewer', kind: 'human', trust: 'observer' };
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup/known' })).statusCode).toBe(403);
  });
});
