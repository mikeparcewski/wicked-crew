// crew 0.9.1 release smoke (S04, macOS): `GET /runs/:id/diff` answered 500 "git executable not found
// on server" when the delivered-worktree sweep removed the worktree WHILE the request ran — git's
// spawn into a vanished cwd fails ENOENT. That is a worktree that is gone, not a missing git: the
// route serves the run branch, as it does for a worktree that was already gone (F-7R2-013).
// crew 0.9.3's release smoke (S04, macOS) hit the same race one step later: git was already running
// when the sweep removed its cwd and exited 128 "Unable to read current working directory".
// crew#1057 (the v0.13.2 release leg): `?base=merge-base` answered 400 "no merge base between
// origin/main and HEAD". `git worktree remove` deletes the worktree's files, its `.git` link among
// them, before the directory: a base lookup in that window fails with no named error, and the route
// blamed the caller's `base`. Reproduced against a real sweep: 37 of 180 racing reads answered 400.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ mode: 'spawn' as 'spawn' | 'running' | 'unlinked' }));
vi.mock('../src/api/run-files.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/run-files.js')>();
  return {
    ...real,
    // The sweep lands between the route's existence check and git's spawn (`spawn`), or while git
    // is already running in the worktree (`running`).
    worktreeDiff: async (workdir: string, _rel: string | undefined, base: string | undefined) => {
      if (race.mode === 'unlinked') {
        // The sweep has removed the `.git` link but not yet the directory: the base lookup fails.
        rmSync(join(workdir, '.git'), { force: true });
        if (base === undefined || base === real.MERGE_BASE_LITERAL) {
          throw new real.UnresolvableDiffBaseError(real.MERGE_BASE_LITERAL, 'no merge base between origin/main and HEAD');
        }
        throw new real.UnresolvableDiffBaseError(base, `ref does not resolve inside the run's repo: ${base}`);
      }
      rmSync(workdir, { recursive: true, force: true });
      if (race.mode === 'spawn') throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      throw Object.assign(new Error('Command failed: git diff --no-color --no-ext-diff abc\nfatal: Unable to read current working directory: No such file or directory\n'), { code: 128 });
    },
  };
});

const { registerRoutes } = await import('../src/api/routes.js');
const { GateCache } = await import('../src/api/gate-cache.js');
const { ElicitationCache } = await import('../src/api/elicitation-cache.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

const base = mkdtempSync(join(tmpdir(), 'diff-vanished-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('GET /runs/:id/diff — the worktree vanished mid-request', () => {
  it.each(['spawn', 'running'] as const)('serves the run branch (200, source: branch) when the sweep lands %s, never a 500', async (mode) => {
    race.mode = mode;
    const repo = join(base, `repo-${mode}`);
    // Engine worktrees live UNDER the registered repo (`wicked-worktrees/<id>`).
    const wt = join(repo, 'wicked-worktrees', 'run-v');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wicked/run-v');
    writeFileSync(join(repo, 'b.txt'), 'run work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'run work');
    git(repo, 'checkout', '-q', 'main');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'b.txt'), 'run work\n');
    const view = {
      session: { id: 'run-v', workflow_id: 'wf-x', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['stub'], status: 'completed', human_confirm: 'none', unit_ix: 1, attempt: 0, workdir: wt, repo_ref: 'repo-1', extra_write_roots: [], archived_at: null, archive_note: null },
      units: [],
    };
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view]),
      listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'repo', root_path: repo }]),
    };
    const app = Fastify({ logger: false });
    registerRoutes(app, adapter as never, new GateCache(), new ElicitationCache());
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-v/diff' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { source: string; diff: string };
    expect(body.source).toBe('branch');
    expect(body.diff).toContain('b.txt');
    // A path narrowed inside the (now gone) worktree is worktree-relative on the branch (codex r1).
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'b.txt'), 'run work\n');
    const narrowed = await app.inject({ method: 'GET', url: `/api/v1/runs/run-v/diff?path=${encodeURIComponent(join(wt, 'b.txt'))}` });
    await app.close();
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect((narrowed.json() as { diff: string }).diff).toContain('b.txt');
  });
});

describe('GET /runs/:id/diff?base=merge-base — the sweep is removing the worktree (crew#1057)', () => {
  const setUp = async (name: string) => {
    race.mode = 'unlinked';
    const repo = join(base, `repo-${name}`);
    const wt = join(repo, 'wicked-worktrees', 'run-u');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wicked/run-u');
    writeFileSync(join(repo, 'b.txt'), 'run work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'run work');
    git(repo, 'checkout', '-q', 'main');
    mkdirSync(wt, { recursive: true });
    // A linked worktree's `.git` is a file naming its admin dir.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'run-u')}\n`);
    const view = {
      session: { id: 'run-u', workflow_id: 'wf-x', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['stub'], status: 'completed', human_confirm: 'none', unit_ix: 1, attempt: 0, workdir: wt, repo_ref: 'repo-1', extra_write_roots: [], archived_at: null, archive_note: null },
      units: [],
    };
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view]),
      listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'repo', root_path: repo }]),
    };
    const app = Fastify({ logger: false });
    registerRoutes(app, adapter as never, new GateCache(), new ElicitationCache());
    await app.ready();
    return { app, wt };
  };

  it('serves the run branch (200, source: branch), never a 400 that blames the caller', async () => {
    const { app } = await setUp('merge-base');
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-u/diff?base=merge-base' });
    await app.close();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { source: string; diff: string };
    expect(body.source).toBe('branch');
    expect(body.diff).toContain('b.txt');
  });

  it("a ref the caller named that does not resolve stays the caller's 400", async () => {
    const { app } = await setUp('callers-ref');
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-u/diff?base=no-such-ref' });
    await app.close();
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('UnresolvableDiffBaseError');
  });
});
