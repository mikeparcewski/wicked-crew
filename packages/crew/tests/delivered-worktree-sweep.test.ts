// crew#620 Acceptance 3 — sweepDeliveredWorktree: a DELIVERED run's worktree is removed and
// pruned after its PR opens; a cancelled/failed run's worktree (not passed to the sweep) is
// left intact. Real-git test following the run-diff-branch-route.test.ts pattern.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sweepDeliveredWorktree } from '../src/api/worktree-sweep.js';
import { removeScratch } from './setup/scratch.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

describe('sweepDeliveredWorktree (crew#620)', () => {
  let base: string;
  let repo: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'sweep-worktree-'));
    repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    removeScratch(base);
  });

  function addWorktree(runId: string): string {
    const branch = `wicked/${runId}`;
    const wtPath = join(repo, 'wicked-worktrees', runId);
    git(repo, 'branch', branch);
    git(repo, 'worktree', 'add', wtPath, branch);
    return wtPath;
  }

  function worktreeList(): string {
    return git(repo, 'worktree', 'list', '--porcelain');
  }

  it('removes the delivered run worktree and prunes; the run branch survives and is free to check out', async () => {
    const runId = 'run-delivered-1';
    const wtPath = addWorktree(runId);
    const logs: string[] = [];

    await sweepDeliveredWorktree(runId, repo, (m) => logs.push(m));

    expect(worktreeList()).not.toContain(wtPath);
    expect(logs.some((m) => m.includes('removed'))).toBe(true);
    // Branch still exists after sweep (GET /runs/:id/diff falls back to it — F-7R2-013).
    const branches = git(repo, 'branch', '--list', `wicked/${runId}`);
    expect(branches.trim()).toBe(`wicked/${runId}`);
  });

  it('logs "not present" and resolves without throwing when the worktree does not exist', async () => {
    const logs: string[] = [];
    await expect(sweepDeliveredWorktree('run-never-existed', repo, (m) => logs.push(m))).resolves.toBeUndefined();
    expect(logs.some((m) => /not present/i.test(m))).toBe(true);
  });

  it('a cancelled run worktree (not swept) remains intact after the delivered run is swept', async () => {
    // A cancelled run's worktree is left alone because server.ts guards the sweep behind
    // `deliveryIndex.urlFor(session) !== undefined` — the cancelled run has no delivery URL.
    // Simulate: only the delivered run's ID is passed to sweepDeliveredWorktree.
    const cancelledId = 'run-cancelled-1';
    const cancelledWtPath = addWorktree(cancelledId);

    const deliveredId = 'run-delivered-2';
    addWorktree(deliveredId);

    const logs: string[] = [];
    // Sweep only the delivered run — the cancelled one is never swept.
    await sweepDeliveredWorktree(deliveredId, repo, (m) => logs.push(m));

    // Delivered run's worktree is gone.
    expect(worktreeList()).not.toContain(join(repo, 'wicked-worktrees', deliveredId));
    // Cancelled run's worktree is still listed.
    expect(worktreeList()).toContain(cancelledWtPath);

    // Clean up the cancelled worktree so afterAll can remove the scratch dir cleanly.
    git(repo, 'worktree', 'remove', '--force', join('wicked-worktrees', cancelledId));
    git(repo, 'worktree', 'prune');
  });
});
