// CREW-UX-1 (DES-UX-001 §8.1) — GET /runs/:id/diff?base=<ref>: the branch-vs-base baseline.
//
// The gap this closes: `worktreeDiff` diffed against HEAD only, so a run's COMMITTED work was
// invisible ("no changes to a committed file" — the A1 gaslight). With `?base=merge-base` the
// diff runs from the run branch's fork point off the default branch; with an explicit ref, from
// that ref — resolved INSIDE the run's repo first. The heart here is containment: `base` is a
// baseline parameter, never a command surface — flags, paths, revision ranges, and separators
// are all named 400s rejected before any git process sees them.
//
// Real git repos (like run-files-route.test.ts), because ref resolution, merge-base, and diff
// assembly are git facts, not stubbable ones.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { DIFF_OUTPUT_CAP_BYTES, isPlainRef } from '../src/api/run-files.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { FastifyInstance } from 'fastify';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

function view(id: string, workdir: string | null) {
  return {
    session: {
      id,
      workflow_id: null,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

describe('GET /runs/:id/diff?base= (CREW-UX-1, DES-UX-001 §8.1)', () => {
  let base: string;
  let workdir: string;
  let nogit: string;
  let firstSha: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'crewux1-diff-'));
    workdir = join(base, 'work');
    nogit = join(base, 'nogit');
    mkdirSync(workdir);
    mkdirSync(nogit);

    // The A1 shape: a run branch forked off main, with COMMITTED run work, a diverged main
    // (so merge-base ≠ main tip), a tagged fork point, and one untracked file in the worktree.
    git(workdir, 'init', '-q', '-b', 'main');
    writeFileSync(join(workdir, 'base.txt'), 'shared history\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-q', '-m', 'fork point');
    firstSha = git(workdir, 'rev-parse', 'HEAD').trim();
    git(workdir, 'tag', 'fork-tag');
    git(workdir, 'checkout', '-q', '-b', 'run/feature');
    writeFileSync(join(workdir, 'committed.txt'), 'committed run work\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-q', '-m', 'run work (committed)');
    // main moves on after the fork: merge-base(main, HEAD) is the FIRST commit, not main's tip.
    git(workdir, 'checkout', '-q', 'main');
    writeFileSync(join(workdir, 'main-only.txt'), 'landed on main after the fork\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-q', '-m', 'main moved on');
    git(workdir, 'checkout', '-q', 'run/feature');
    writeFileSync(join(workdir, 'uncommitted.txt'), 'worktree dirt\n'); // untracked

    const mockAdapter = {
      sessionsDetail: vi
        .fn()
        .mockResolvedValue([
          view('run-1', workdir),
          view('run-bare', null),
          view('run-nogit', nogit),
        ]),
      listRepos: vi.fn().mockResolvedValue([]),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const getDiff = (runId: string, query?: Record<string, string | string[]>) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/diff`,
      ...(query === undefined ? {} : { query }),
    });

  // ── the baseline gap, then the fix ─────────────────────────────────────────

  it('WITHOUT base, committed run work stays invisible — the §8.1 gap this slice closes', async () => {
    const res = await getDiff('run-1');
    expect(res.statusCode).toBe(200);
    const { diff } = res.json() as { diff: string };
    expect(diff).toContain('+worktree dirt'); // worktree dirt shows…
    expect(diff).not.toContain('committed run work'); // …committed work does not
  });

  it('base=merge-base diffs from the fork point: committed work + worktree dirt, response shape unchanged', async () => {
    const res = await getDiff('run-1', { base: 'merge-base' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { diff: string; truncated: boolean };
    expect(Object.keys(body).sort()).toEqual(['diff', 'truncated']); // RunDiff, no new fields
    expect(body.truncated).toBe(false);
    expect(body.diff).toContain('b/committed.txt'); // committed run work is now visible
    expect(body.diff).toContain('+committed run work');
    expect(body.diff).toContain('+worktree dirt'); // untracked pass still appended
    // Fork point, NOT main's tip: main-only.txt (absent from the worktree) would show as a
    // deletion if the baseline were main itself.
    expect(body.diff).not.toContain('main-only.txt');
  });

  it('an explicit in-repo branch ref works — base=main shows the full branch-vs-main picture', async () => {
    const res = await getDiff('run-1', { base: 'main' });
    expect(res.statusCode).toBe(200);
    const { diff } = res.json() as { diff: string };
    expect(diff).toContain('+committed run work');
    expect(diff).toContain('main-only.txt'); // vs main's TIP, the diverged file appears (deleted)
  });

  it('an explicit commit SHA and a tag both resolve as plain refs', async () => {
    for (const ref of [firstSha, 'fork-tag']) {
      const res = await getDiff('run-1', { base: ref });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { diff: string }).diff).toContain('+committed run work');
    }
  });

  it('?base combines with ?path narrowing', async () => {
    const res = await getDiff('run-1', {
      base: 'merge-base',
      path: join(workdir, 'committed.txt'),
    });
    expect(res.statusCode).toBe(200);
    const { diff } = res.json() as { diff: string };
    expect(diff).toContain('+committed run work');
    expect(diff).not.toContain('uncommitted.txt');
  });

  // ── the named 400s ─────────────────────────────────────────────────────────

  it('400s an unresolvable ref with the named error — well-formed but not in this repo', async () => {
    const res = await getDiff('run-1', { base: 'no-such-branch' });
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain('UnresolvableDiffBase');
    expect(error).toContain('no-such-branch');
  });

  it('rejects every injection shape with a named 400 — base is never a command surface', async () => {
    const pwned = join(base, 'pwned.txt');
    const attacks = [
      `--output=${pwned}`, // flag injection
      '-v', // short flag
      '../outside', // path traversal
      '/etc/passwd', // absolute path
      './relative', // dot path
      'main..run/feature', // revision range
      'main...run/feature', // symmetric-difference range
      'main;rm -rf /', // shell separator
      'main HEAD', // argv splitting attempt
      'HEAD~1', // rev operator
      'HEAD^', // rev operator
      'main@{upstream}', // reflog/upstream operator
      ':/fixup', // rev search syntax
    ];
    for (const attack of attacks) {
      const res = await getDiff('run-1', { base: attack });
      expect(res.statusCode, `base=${JSON.stringify(attack)} must 400`).toBe(400);
      expect((res.json() as { error: string }).error).toContain('InvalidDiffBase');
    }
    // And the flag attempt never produced its file — the parameter never reached git.
    expect(existsSync(pwned)).toBe(false);
  });

  it('400s a repeated ?base=a&base=b — never silently picks either', async () => {
    const res = await getDiff('run-1', { base: ['main', 'run/feature'] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('at most once');
  });

  // ── ladders and caps preserved ─────────────────────────────────────────────

  it('409s (no workdir / reaped) still win over base handling', async () => {
    const res = await getDiff('run-bare', { base: 'merge-base' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('no workdir');
  });

  it('a non-git workdir with a base still answers the empty diff — the standing tolerance', async () => {
    const res = await getDiff('run-nogit', { base: 'main' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ diff: '', truncated: false });
  });

  it('the byte-accurate 1 MB cap holds on a base diff', async () => {
    const huge = join(workdir, 'huge-untracked.txt');
    writeFileSync(huge, `${'y'.repeat(120)}\n`.repeat(Math.ceil((DIFF_OUTPUT_CAP_BYTES * 2) / 121)));
    try {
      const res = await getDiff('run-1', { base: 'merge-base' });
      expect(res.statusCode).toBe(200);
      const { diff, truncated } = res.json() as { diff: string; truncated: boolean };
      expect(truncated).toBe(true);
      expect(Buffer.byteLength(diff, 'utf8')).toBeLessThanOrEqual(DIFF_OUTPUT_CAP_BYTES);
    } finally {
      rmSync(huge, { force: true });
    }
  });

  it('an empty ?base= means no base — the HEAD diff, not a 400', async () => {
    const res = await getDiff('run-1', { base: '' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { diff: string }).diff).not.toContain('committed run work');
  });
});

describe('isPlainRef (the §8.1 gate, unit-level)', () => {
  it('accepts branch/tag/sha spellings', () => {
    for (const ok of ['main', 'run/feature', 'v1.2.3', 'a'.repeat(40), 'feat_x-y.z']) {
      expect(isPlainRef(ok), ok).toBe(true);
    }
  });

  it('rejects flags, paths, ranges, operators, separators, and empty', () => {
    for (const bad of [
      '',
      '-v',
      '--output=x',
      '.hidden',
      '/abs',
      '../up',
      'a..b',
      'a...b',
      'HEAD~1',
      'HEAD^',
      'a@{1}',
      'a:b',
      'a b',
      'a;b',
      'a\nb',
      'trailing/',
      'a'.repeat(300),
    ]) {
      expect(isPlainRef(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
