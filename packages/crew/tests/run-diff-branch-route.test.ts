// Wave 6 (F-7R2-013) — `GET /runs/:id/diff` when the engine has reaped the run worktree: the diff is
// served from the run's `wicked/<id>` branch in the REGISTERED repo (`source: 'branch'`) against the
// engine-recorded `base_commit` (else the merge-base with the default branch); 409 only when there
// is neither a worktree nor a branch. The live worktree read now says `source: 'worktree'`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function view(id: string, workdir: string | null, repoRef: string | null, extra: Record<string, unknown> = {}) {
  return {
    session: {
      id,
      workflow_id: 'wf-x',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir,
      repo_ref: repoRef,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
      ...extra,
    },
    units: [],
  };
}

describe('GET /runs/:id/diff — branch fallback for a reaped worktree (F-7R2-013)', () => {
  let base: string;
  let repo: string;
  let gone: string;
  let live: string;
  let mainTip: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'diff-branch-'));
    repo = join(base, 'registered-clone');
    gone = join(base, 'worktrees', 'run-gone'); // never created — the reaped worktree
    live = join(base, 'live-worktree');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'shared history\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    mainTip = git(repo, 'rev-parse', 'HEAD').trim();
    // The run branch the engine minted (and the deliver phase / worker committed to), then main moves on.
    git(repo, 'checkout', '-q', '-b', 'wicked/run-gone');
    writeFileSync(join(repo, 'committed.txt'), 'committed run work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'run work');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'main-only.txt'), 'landed on main after the fork\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved on');
    // A second run whose branch the ENGINE recorded under a custom name, with its base.
    git(repo, 'checkout', '-q', '-b', 'wicked/custom-branch', mainTip);
    writeFileSync(join(repo, 'recorded.txt'), 'recorded run work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'recorded run');
    git(repo, 'checkout', '-q', 'main');
    // A third run whose LOCAL branch the engine's retention pruned — only the PUSHED copy under
    // refs/remotes/origin/ remains (review L-1 of #536).
    git(repo, 'checkout', '-q', '-b', 'wicked/run-remote-only', mainTip);
    writeFileSync(join(repo, 'remote-only.txt'), 'pushed, then pruned locally\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'pushed run');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/wicked/run-remote-only', 'wicked/run-remote-only');
    git(repo, 'branch', '-q', '-D', 'wicked/run-remote-only');
    // (crew#2006) A run branch holding a nested file, a directory, a binary file, a file past the 512 KB cap and a
    // symlink: what GET /files reads from a reaped worktree.
    git(repo, 'checkout', '-q', '-b', 'wicked/run-files', mainTip);
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, 'src', 'deep', 'nested.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x47, 0x49, 0x46, 0x00, 0x01, 0x02]));
    writeFileSync(join(repo, 'big.txt'), 'a'.repeat(600 * 1024));
    symlinkSync('src/deep/nested.ts', join(repo, 'link.ts'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'files run');
    git(repo, 'checkout', '-q', 'main');
    // A LIVE worktree for the source:'worktree' stamp.
    mkdirSync(live);
    git(live, 'init', '-q', '-b', 'main');
    writeFileSync(join(live, 'dirt.txt'), 'worktree dirt\n');

    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-gone', gone, 'repo-1'),
        view('run-rec', gone, 'repo-1', { run_branch: 'wicked/custom-branch', base_commit: mainTip }),
        view('run-nobranch', gone, 'repo-1'),
        view('run-remote-only', gone, 'repo-1'),
        view('run-norepo', gone, null),
        view('run-live', live, 'repo-1'),
        view('run-files', join(base, 'worktrees', 'run-files'), 'repo-1'),
      ]),
      listRepos: vi.fn().mockResolvedValue([
        { id: 'repo-1', name: 'r', root_path: repo, default_branch: 'main', registered_at: 1 },
      ]),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), new GateCache(), new ElicitationCache());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    removeScratch(base);
  });

  const getDiff = (runId: string, query?: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/diff`, ...(query === undefined ? {} : { query }) });
  type Body = { diff: string; truncated: boolean; source?: string; branch?: string; base?: string };

  it('a reaped worktree is served from the run branch against its merge-base — the committed work is visible, main-only work is not', async () => {
    const res = await getDiff('run-gone');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.source).toBe('branch');
    expect(body.branch).toBe('wicked/run-gone');
    expect(body.base).toBe(mainTip);
    expect(body.truncated).toBe(false);
    expect(body.diff).toContain('+committed run work');
    expect(body.diff).not.toContain('main-only.txt');
  });

  it('the engine-recorded run_branch + base_commit win when the session carries them', async () => {
    const body = (await getDiff('run-rec')).json() as Body;
    expect(body).toMatchObject({ source: 'branch', branch: 'wicked/custom-branch', base: mainTip });
    expect(body.diff).toContain('+recorded run work');
  });

  it('?base=<plain ref> overrides the base; ?base=merge-base keeps the derived one; a malformed base is a named 400', async () => {
    const vsMain = (await getDiff('run-gone', { base: 'main' })).json() as Body;
    expect(vsMain.base).toBe('main');
    expect(vsMain.diff).toContain('-landed on main after the fork'); // main-only.txt reads as a deletion vs main's tip
    const mb = (await getDiff('run-gone', { base: 'merge-base' })).json() as Body;
    expect(mb.base).toBe(mainTip);
    const bad = await getDiff('run-gone', { base: '--output=/tmp/x' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toContain('InvalidDiffBaseError');
  });

  it('?path= under the (gone) worktree or the repo root narrows the branch diff to that file', async () => {
    const viaWorktree = (await getDiff('run-gone', { path: join(gone, 'committed.txt') })).json() as Body;
    expect(viaWorktree.diff).toContain('committed.txt');
    const viaRepo = (await getDiff('run-gone', { path: join(repo, 'base.txt') })).json() as Body;
    expect(viaRepo.diff).toBe(''); // base.txt is unchanged on the branch
  });

  it('a run branch pruned LOCALLY is still served from its pushed copy refs/remotes/origin/<branch>, labelled origin/<branch> (review L-1 of #536)', async () => {
    const res = await getDiff('run-remote-only');
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body).toMatchObject({ source: 'branch', branch: 'origin/wicked/run-remote-only' });
    expect(body.diff).toContain('remote-only.txt');
    expect(body.diff).not.toContain('main-only.txt');
  });

  it('409 only when there is neither a worktree nor a run branch — and the reason says so', async () => {
    const noBranch = await getDiff('run-nobranch');
    expect(noBranch.statusCode).toBe(409);
    expect((noBranch.json() as { error: string }).error).toMatch(/run branch holds no commits/);
    const noRepo = await getDiff('run-norepo');
    expect(noRepo.statusCode).toBe(409);
    expect((noRepo.json() as { error: string }).error).toMatch(/no longer exists|no run branch/);
  });

  // crew#2006 — the live proof (run 62ef0b25, 2026-11-28): every [File] read of a finished run answered 404 (`no such
  // file`) because the worktree was reaped, while [Diff] on the same row read 200 from the run branch.
  const getFile = (runId: string, path: string) =>
    app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/files`, query: { path } });

  it('crew#2006: a reaped worktree\'s file is read from the run branch, the same branch its diff reads', async () => {
    const res = await getFile('run-gone', join(gone, 'committed.txt'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ content: 'committed run work\n', size: 19, truncated: false, binary: false, source: 'branch', branch: 'wicked/run-gone' });
  });

  it('crew#2006: the recorded run_branch, the pushed copy, and a path under the repo root read as the diff does', async () => {
    expect((await getFile('run-rec', join(gone, 'recorded.txt'))).json()).toMatchObject({ content: 'recorded run work\n', source: 'branch', branch: 'wicked/custom-branch' });
    expect((await getFile('run-remote-only', join(gone, 'remote-only.txt'))).json()).toMatchObject({ content: 'pushed, then pruned locally\n', branch: 'origin/wicked/run-remote-only' });
    // The registered checkout is on main, where the run's file is not: the run branch has it.
    expect((await getFile('run-gone', join(repo, 'committed.txt'))).json()).toMatchObject({ content: 'committed run work\n', source: 'branch' });
    const filesGone = join(base, 'worktrees', 'run-files');
    expect((await getFile('run-files', join(filesGone, 'src', 'deep', 'nested.ts'))).json()).toMatchObject({ content: 'export const x = 1;\n', size: 20 });
  });

  it('crew#2006: the RunFileContent rules hold on the branch: binary sniff, the 512 KB cap, no directory, no symlink', async () => {
    const filesGone = join(base, 'worktrees', 'run-files');
    expect((await getFile('run-files', join(filesGone, 'blob.bin'))).json()).toMatchObject({ content: '', size: 6, truncated: false, binary: true });
    const big = (await getFile('run-files', join(filesGone, 'big.txt'))).json() as { content: string; size: number; truncated: boolean };
    expect({ size: big.size, truncated: big.truncated, served: big.content.length }).toEqual({ size: 600 * 1024, truncated: true, served: 512 * 1024 });
    const dir = await getFile('run-files', join(filesGone, 'src'));
    expect(dir.statusCode).toBe(400);
    expect(dir.json().error).toContain('not a regular file in the run branch');
    expect((await getFile('run-files', join(filesGone, 'link.ts'))).statusCode).toBe(400);
  });

  it('crew#2006: what neither the worktree nor the branch has stays 404, and containment is judged first', async () => {
    expect((await getFile('run-gone', join(gone, 'never-committed.txt'))).statusCode).toBe(404);
    expect((await getFile('run-gone', join(gone, 'src'))).statusCode).toBe(404);
    expect((await getFile('run-nobranch', join(gone, 'committed.txt'))).statusCode).toBe(404);
    expect((await getFile('run-norepo', join(gone, 'committed.txt'))).statusCode).toBe(404);
    // A file of another run's branch is not this run's: run-gone's branch has no recorded.txt.
    expect((await getFile('run-gone', join(gone, 'recorded.txt'))).statusCode).toBe(404);
    expect((await getFile('run-gone', join(tmpdir(), 'outside.txt'))).statusCode).toBe(403);
    // A live worktree's missing file is not read from any branch.
    expect((await getFile('run-live', join(live, 'committed.txt'))).statusCode).toBe(404);
  });

  it('a LIVE worktree is still read from the tree, stamped source:worktree', async () => {
    const body = (await getDiff('run-live')).json() as Body;
    expect(body.source).toBe('worktree');
    expect(body.diff).toContain('+worktree dirt');
    expect(body.branch).toBeUndefined();
  });
});
