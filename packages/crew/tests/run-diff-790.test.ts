// crew#790 — `GET /runs/:id/diff` answered differently for every finished run, and none of the
// answers was the run's change set:
//   - a delivered run (its work committed in a still-live worktree) read `diff: ""` because the
//     default baseline was HEAD — the default is now the engine-recorded `base_commit` when the
//     session carries one, so committed AND uncommitted run work both show (`base` names it);
//   - a git stopped by the daemon's timeout (a busy host) surfaced as a bare 500 — it is now
//     503 `diff_busy` with Retry-After, the honest "try again" answer;
//   - the untracked pass spawns one git per file and could run past any client timeout — it now
//     stops at a time budget and says the answer is `truncated`.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { worktreeDiff } from '../src/api/run-files.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function view(id: string, workdir: string | null, repoRef: string | null, status: string, extra: Record<string, unknown> = {}) {
  return {
    session: {
      id,
      workflow_id: 'wf-x',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
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

describe('GET /runs/:id/diff — every finished run answers with its change set (crew#790)', () => {
  let base: string;
  let repo: string;
  let delivered: string;
  let executing: string;
  let mainTip: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'diff-790-'));
    repo = join(base, 'registered-clone');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'shared history\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    mainTip = git(repo, 'rev-parse', 'HEAD').trim();
    // A delivered run: the engine's worktree on wicked/<id>, the deliver phase committed the work.
    delivered = join(base, 'wt-delivered');
    git(repo, 'worktree', 'add', '-q', '-b', 'wicked/run-delivered', delivered, mainTip);
    writeFileSync(join(delivered, 'cart.js'), 'export const total = 1;\n');
    git(delivered, 'add', '.');
    git(delivered, 'commit', '-q', '-m', 'run work');
    // An executing run: one unit committed, the next one is writing.
    executing = join(base, 'wt-executing');
    git(repo, 'worktree', 'add', '-q', '-b', 'wicked/run-exec', executing, mainTip);
    writeFileSync(join(executing, 'done.js'), 'committed by unit 1\n');
    git(executing, 'add', '.');
    git(executing, 'commit', '-q', '-m', 'unit 1');
    writeFileSync(join(executing, 'base.txt'), 'shared history\nedited by unit 2\n');
    writeFileSync(join(executing, 'new.js'), 'created by unit 2\n');

    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-delivered', delivered, 'repo-1', 'completed', { run_branch: 'wicked/run-delivered', base_commit: mainTip }),
        view('run-exec', executing, 'repo-1', 'executing', { run_branch: 'wicked/run-exec', base_commit: mainTip }),
        view('run-old-engine', delivered, 'repo-1', 'completed'),
      ]),
      listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'r', root_path: repo, default_branch: 'main', registered_at: 1 }]),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    removeScratch(base);
  });

  type Body = { diff: string; truncated: boolean; source?: string; base?: string };
  const getDiff = (runId: string, query?: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/diff`, ...(query === undefined ? {} : { query }) });

  it('a delivered run whose work is committed in its live worktree: the diff is that work, against the recorded base', async () => {
    const res = await getDiff('run-delivered');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Body;
    expect(body.source).toBe('worktree');
    expect(body.diff).toContain('+export const total = 1;');
    expect(body.base).toBe(mainTip);
  });

  it('an executing run: committed units AND the unit still writing (tracked edit + new file) in one answer', async () => {
    const body = (await getDiff('run-exec')).json() as Body;
    expect(body.diff).toContain('+committed by unit 1');
    expect(body.diff).toContain('+edited by unit 2');
    expect(body.diff).toContain('+created by unit 2');
  });

  it('?base= still wins over the recorded base; a session with no recorded base keeps the HEAD default', async () => {
    const head = (await getDiff('run-delivered', { base: 'HEAD' })).json() as Body;
    expect(head.diff).toBe('');
    const old = (await getDiff('run-old-engine')).json() as Body;
    expect(old.diff).toBe('');
    expect(old.base).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('a git the host stopped before it answered is 503 diff_busy with Retry-After, never a bare 500', async () => {
    const shim = join(base, 'shim');
    mkdirSync(shim, { recursive: true });
    // A git that is killed by a signal before it answers: what the daemon's timeout does to a slow git.
    writeFileSync(join(shim, 'git'), '#!/bin/sh\nkill -TERM $$\n');
    chmodSync(join(shim, 'git'), 0o755);
    const prior = process.env['PATH'];
    process.env['PATH'] = `${shim}${delimiter}${prior ?? ''}`;
    try {
      const res = await getDiff('run-delivered');
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: 'diff_busy' });
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      process.env['PATH'] = prior;
    }
  });

  it('the untracked pass stops at its time budget and says truncated (an executing run answers in bounded time)', async () => {
    const out = await worktreeDiff(executing, undefined, undefined, { budgetMs: 0 });
    expect(out.truncated).toBe(true);
    expect(out.diff).not.toContain('+created by unit 2');
  });
});
