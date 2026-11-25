// crew#1794 against real git: reviewing a commit on main joins only the run that wrote it. A run branched from main
// after the commit landed, and a `wicked/*` branch on origin from a run this daemon does not know, both contain it.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionView } from '../src/core/types.js';
import { reviewChangeExclusion, type ReviewChangeDeps } from '../src/api/review-change.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** The daemon's git seam as routes.ts wires it: exit codes kept, never thrown. */
const realGit: ReviewChangeDeps['git'] = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** A session as the engine serves it: `run_branch` and `base_commit` recorded at launch (wicked-core domain.rs Session). */
function run(id: string, seat: string, base: string): SessionView {
  return {
    session: { id, repo_ref: 'repo', run_branch: `wicked/${id}`, base_commit: base, created_at: Date.now() / 1000 },
    units: [{ stage: 'build', role: 'creator', assigned_cli: seat }],
  } as unknown as SessionView;
}

describe('review-change of a main commit (crew#1794, real git)', () => {
  it('joins the run that wrote the commit, not later runs or unknown run branches on origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-1794-'));
    dirs.push(root);
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    const other = join(root, 'other');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'clone', '-q', origin, repo);
    git(repo, 'checkout', '-q', '-b', 'main');
    const c0 = commit(repo, 'c0');
    // Run A wrote X on its branch; X then reached main.
    git(repo, 'checkout', '-q', '-b', 'wicked/A');
    const x = commit(repo, 'x');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'wicked/A');
    git(repo, 'push', '-q', 'origin', 'main', 'wicked/A');
    // Run S branched from main after X landed.
    git(repo, 'checkout', '-q', '-b', 'wicked/S');
    commit(repo, 's');
    git(repo, 'checkout', '-q', 'main');
    // Another clone pushed a run branch of a run this daemon never saw.
    git(root, 'clone', '-q', origin, other);
    git(other, 'checkout', '-q', '-b', 'wicked/0adbfc95-elsewhere', 'origin/main');
    commit(other, 'foreign');
    git(other, 'push', '-q', 'origin', 'wicked/0adbfc95-elsewhere');

    const deps: ReviewChangeDeps = {
      repoRef: 'repo', repoRoot: repo,
      views: async () => [run('A', 'claude', c0), run('S', 'codex', x)],
      deliveredUrl: () => undefined, pushed: () => undefined, deliveredCommit: () => undefined, revisesPr: () => undefined,
      gh: async () => ({ code: 1, stdout: '', stderr: 'unused' }),
      git: realGit,
    };
    const result = await reviewChangeExclusion(`review commit ${x}`, deps);
    expect(result).toMatchObject({ ok: true, provenance: 'built_here', runs: ['A'], excludeSeats: ['claude'], headSha: x });
  });
});
