import { describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../src/core/types.js';
import {
  parseReviewTarget, reviewChangeExclusion, runAuthorSeats,
  REVIEW_CHANGE_WORKFLOW, REVIEW_PROVENANCE_WINDOW_DAYS,
  type ReviewChangeDeps, type ReviewExclusion, type ReviewTarget,
} from '../src/api/review-change.js';

const HEAD = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const URL = 'https://github.com/org/repo/pull/12';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const DAY = 86_400_000;
const build = { stage: 'build', role: 'creator', assigned_cli: 'claude' };
function view(id = 'A', units: Record<string, unknown>[] = [build], session: Record<string, unknown> = {}): SessionView {
  return { session: { id, repo_ref: 'repo', created_at: (NOW - DAY) / 1000, ...session }, units } as unknown as SessionView;
}
function deps(views: SessionView[] = [view()]): ReviewChangeDeps {
  return {
    repoRef: 'repo', repoRoot: '/registered/repo', views: async () => views,
    deliveredUrl: () => undefined, pushed: () => undefined, deliveredCommit: () => undefined,
    revisesPr: () => undefined, now: () => NOW,
    gh: vi.fn(async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ headRefName: 'wicked/A', headRefOid: HEAD, url: URL, state: 'OPEN', isCrossRepository: false }) })),
    git: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  };
}
function success(result: ReviewExclusion): Extract<ReviewExclusion, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}
function pr(d: ReviewChangeDeps, headRefName: string, extra: Record<string, unknown> = {}): void {
  d.gh = vi.fn(async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ headRefName, headRefOid: HEAD, url: URL, state: 'OPEN', isCrossRepository: false, ...extra }) }));
}

describe('parseReviewTarget', () => {
  it.each<[string, ReviewTarget | null]>([
    ['review https://github.com/org/repo/pull/12/files#diff-1', { kind: 'pr', number: 12 }],
    ['https://dev.azure.com/org/project/_git/repo/pullrequest/12', { kind: 'pr', number: 12 }],
    ['review #12', { kind: 'pr', number: 12 }],
    ['review PR 12', { kind: 'pr', number: 12 }],
    ['review pull request 12', { kind: 'pr', number: 12 }],
    ['review branch feature/a', { kind: 'branch', name: 'feature/a' }],
    ['review wicked/123e4567-e89b-12d3-a456-426614174000', { kind: 'branch', name: 'wicked/123e4567-e89b-12d3-a456-426614174000' }],
    ['review ABCDEF1', { kind: 'commit', sha: 'abcdef1' }],
    [COMMIT, { kind: 'commit', sha: COMMIT }],
    ['review this change', null],
    ['PR 99999999999999999 please', null],
    ['#123456789012345678', null],
    ['branch feature/a and abcdef1 and PR 12', { kind: 'pr', number: 12 }],
    ['abcdef1 then branch feature/a', { kind: 'branch', name: 'feature/a' }],
  ])('parses %s', (words, target) => expect(parseReviewTarget(words)).toEqual(target));

  it.each(['-bad', 'a..b', 'a/', 'a.lock', 'a;bad', 'a$(bad)'])('rejects unsafe branch %s', (name) => {
    expect(parseReviewTarget(`branch ${name}`)).toBeNull();
  });
});

describe('runAuthorSeats', () => {
  it('retains reassigned authors and normalizes sorted unique seat keys', () => {
    expect(runAuthorSeats(view('A', [{ ...build, assigned_cli: 'codex#2', authored_by: ['claude#3', 'codex', '', null] }]))).toEqual(['claude', 'codex']);
  });

  it('counts only build/recon agent work', () => {
    expect(runAuthorSeats(view('A', [
      { ...build, stage: 'review', assigned_cli: 'reviewer' },
      { ...build, stage: 'test', assigned_cli: 'tester' },
      { ...build, tool_cmd: ['true'], assigned_cli: 'tool' },
      { ...build, stage: 'recon', assigned_cli: 'codex' },
    ]))).toEqual(['codex']);
  });

  it('mirrors guarded and team read steps, retaining recorded authors only', () => {
    const scope = { stage: 'recon', role: 'neutral', assigned_cli: 'reader', worktree_guarded: true };
    expect(runAuthorSeats(view('A', [scope]))).toEqual([]);
    expect(runAuthorSeats(view('A', [{ ...scope, worktree_mutation: { restored: true } }]))).toEqual([]);
    expect(runAuthorSeats(view('A', [{ ...scope, owner: 'team', worktree_guarded: false }]))).toEqual([]);
    expect(runAuthorSeats(view('A', [{ ...scope, authored_by: ['claude#2'] }]))).toEqual(['claude']);
    for (const change of [
      { executes_code: true }, { worktree_guarded: false },
      { worktree_mutation: { restored: false } }, { role: 'creator' }, { stage: 'build' },
    ]) expect(runAuthorSeats(view('A', [{ ...scope, ...change }]))).toEqual(['reader']);
  });

  it('refuses unreadable work authors but permits runs with no work', () => {
    expect(runAuthorSeats(undefined)).toBeNull();
    expect(runAuthorSeats(view('A', [{ ...build, assigned_cli: null, authored_by: [null, '', '#2'] }]))).toBeNull();
    expect(runAuthorSeats(view('A', []))).toEqual([]);
  });
});

describe('reviewChangeExclusion', () => {
  it('excludes a PR head run and records the target, head, brief and safe base', async () => {
    const d = deps();
    const result = success(await reviewChangeExclusion('review #12', d));
    expect(result).toMatchObject({ target: { kind: 'pr', number: 12 }, provenance: 'built_here', runs: ['A'], excludeSeats: ['claude'], headSha: HEAD, baseRef: 'wicked/A' });
    expect(result.label).toBe('built by runs A (authors excluded: claude)');
    expect(result.briefLines).toEqual(['Review target: PR #12', `Head SHA: ${HEAD}`, result.label, 'Post nothing to the pull request.']);
    expect(d.gh).toHaveBeenCalledWith(['pr', 'view', '12', '--json', 'headRefName,headRefOid,url,state,isCrossRepository'], { cwd: d.repoRoot, timeoutMs: 5000 });
    expect(REVIEW_CHANGE_WORKFLOW).toBe('review-change');
    expect(REVIEW_PROVENANCE_WINDOW_DAYS).toBe(90);
  });

  it('joins a revision URL and excludes all reassigned writers', async () => {
    const d = deps([view(), view('B', [{ ...build, assigned_cli: 'codex', authored_by: ['claude'] }])]);
    d.revisesPr = (id) => id === 'B' ? { number: 99, headRef: 'other', url: 'https://GITHUB.COM/org/repo.git/pull/12/files#diff' } : undefined;
    expect(success(await reviewChangeExclusion('#12', d))).toMatchObject({ runs: ['A', 'B'], excludeSeats: ['claude', 'codex'] });
  });

  it('excludes both seats when the contributing creator was reassigned', async () => {
    const d = deps([view('A', [{ ...build, assigned_cli: 'codex', authored_by: ['claude'] }])]);
    expect(success(await reviewChangeExclusion('#12', d)).excludeSeats).toEqual(['claude', 'codex']);
  });

  it('joins delivery URLs, same-repo revision numbers, recorded branches and pushed branches', async () => {
    const d = deps([view('delivery'), view('revision'), view('recorded', [build], { run_branch: 'feature/review' }), view('pushed')]);
    pr(d, 'feature/review');
    d.deliveredUrl = (id) => id === 'delivery' ? `${URL}/commits/` : undefined;
    d.revisesPr = (id) => id === 'revision' ? { number: 12, headRef: 'unrelated', url: 'https://github.com/org/old/pull/12' } : undefined;
    d.pushed = (id) => id === 'pushed' ? { branch: 'feature/review', remote: 'origin' } : undefined;
    expect(success(await reviewChangeExclusion('#12', d)).runs).toEqual(['delivery', 'pushed', 'recorded', 'revision']);
  });

  it('uses unknown provenance and every recent or undated repo author when gh fails', async () => {
    const d = deps([
      view(), view('B', [{ ...build, assigned_cli: 'codex' }], { created_at: undefined, started_at: new Date(NOW - DAY).toISOString() }),
      view('old', [{ ...build, assigned_cli: 'old-seat' }], { created_at: (NOW - 91 * DAY) / 1000 }),
      view('old-engine', [build], { created_at: undefined, started_at: new Date(NOW - 91 * DAY).toISOString() }),
      view('undated', [{ ...build, assigned_cli: 'pi' }], { created_at: undefined }),
      view('invalid', [{ ...build, assigned_cli: 'opencode' }], { created_at: 'invalid' }),
      view('boundary', [{ ...build, assigned_cli: 'boundary' }], { created_at: (NOW - 90 * DAY) / 1000 }),
      view('foreign', [{ ...build, assigned_cli: 'foreign' }], { repo_ref: 'another-repo' }),
    ]);
    // A failing command can leave valid-looking stdout; its exit status must still win.
    d.gh = async () => ({ code: 1, stdout: JSON.stringify({ headRefName: 'feature/outside', headRefOid: HEAD, url: URL, state: 'OPEN', isCrossRepository: false }), stderr: 'failed' });
    const result = success(await reviewChangeExclusion('#12', d));
    expect(result).toMatchObject({ provenance: 'unknown', runs: ['A', 'B', 'boundary', 'invalid', 'undated'], excludeSeats: ['boundary', 'claude', 'codex', 'opencode', 'pi'], headSha: null });
    expect(result.label).toContain('provenance unknown:');
    expect(result.label).toContain('last 90 days');
  });

  it('reports outside only after a readable lookup with no candidates', async () => {
    const d = deps([view('foreign', [build], { repo_ref: 'another-repo', run_branch: 'feature/outside' })]);
    pr(d, 'feature/outside');
    expect(success(await reviewChangeExclusion('#12', d))).toMatchObject({ provenance: 'outside', runs: [], excludeSeats: [], label: 'built outside this studio' });
  });

  it.each([0, 1, 128, null])('drops an ancestor candidate only for git exit 1 (exit %s)', async (code) => {
    const d = deps();
    d.deliveredCommit = () => COMMIT;
    d.git = vi.fn(async () => ({ code, stdout: '', stderr: '' }));
    const result = success(await reviewChangeExclusion('#12', d));
    expect(result.runs).toEqual(code === 1 ? [] : ['A']);
    expect(result.excludeSeats).toEqual(code === 1 ? [] : ['claude']);
    expect(result.provenance).toBe(code === 1 ? 'outside' : 'built_here');
    expect(d.git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', COMMIT, HEAD], d.repoRoot);
  });

  it('keeps candidates when membership lookup throws', async () => {
    const d = deps();
    d.deliveredCommit = () => COMMIT;
    d.git = async () => { throw new Error('object unavailable'); };
    expect(success(await reviewChangeExclusion('#12', d)).excludeSeats).toEqual(['claude']);
  });

  it('refuses a directly named contributing run missing from views', async () => {
    expect(await reviewChangeExclusion('#12', deps([]))).toEqual({ ok: false, code: 'review_authors_unknown', error: 'Run A contributed to this change and crew cannot read who wrote it, so it will not pick a reviewer blindly.' });
  });

  it('refuses unreadable authors in both built and unknown provenance', async () => {
    const d = deps([view('A', [{ ...build, assigned_cli: null }])]);
    expect(await reviewChangeExclusion('#12', d)).toMatchObject({ ok: false, code: 'review_authors_unknown' });
    d.gh = async () => { throw new Error('unavailable'); };
    expect(await reviewChangeExclusion('#12', d)).toMatchObject({ ok: false, code: 'review_authors_unknown' });
    d.views = async () => { throw new Error('unreadable'); };
    expect(await reviewChangeExclusion('#12', d)).toMatchObject({ ok: false, code: 'review_authors_unknown' });
  });

  it.each(['MERGED', 'CLOSED', 'fork'])('omits baseRef for a %s PR', async (state) => {
    const d = deps();
    pr(d, 'wicked/A', { state: state === 'fork' ? 'OPEN' : state, isCrossRepository: state === 'fork' });
    expect(success(await reviewChangeExclusion('#12', d)).baseRef).toBeUndefined();
  });

  it.each(['not JSON', '{}', JSON.stringify({ headRefName: '-bad', headRefOid: HEAD, url: URL, state: 'OPEN', isCrossRepository: false })])('treats malformed PR metadata as unknown: %s', async (stdout) => {
    const d = deps();
    d.gh = async () => ({ code: 0, stdout, stderr: '' });
    expect(success(await reviewChangeExclusion('#12', d))).toMatchObject({ provenance: 'unknown', excludeSeats: ['claude'] });
  });

  it('treats a missing target as unknown', async () => {
    const d = deps();
    const result = success(await reviewChangeExclusion('review this change', d));
    expect(result).toMatchObject({ provenance: 'unknown', excludeSeats: ['claude'] });
    expect(result.label).toContain('the request names no pull request, branch or commit');
    expect(d.gh).not.toHaveBeenCalled();
    expect(d.git).not.toHaveBeenCalled();
  });

  it('resolves branches on origin and joins revision head refs', async () => {
    const d = deps([view('B', [{ ...build, assigned_cli: 'codex' }])]);
    d.revisesPr = () => ({ number: 12, headRef: 'feature/review', url: URL });
    d.git = vi.fn(async (args) => ({ code: 0, stdout: args[0] === 'rev-parse' ? HEAD : '', stderr: '' }));
    expect(success(await reviewChangeExclusion('branch feature/review', d))).toMatchObject({ provenance: 'built_here', runs: ['B'], excludeSeats: ['codex'], headSha: HEAD, baseRef: 'feature/review' });
    expect(d.git).toHaveBeenNthCalledWith(1, ['fetch', 'origin', 'feature/review'], d.repoRoot);
    expect(d.git).toHaveBeenNthCalledWith(2, ['rev-parse', '--verify', '-q', 'origin/feature/review^{commit}'], d.repoRoot);
  });

  it('joins commits through local and remote run refs and recorded deliveries', async () => {
    const d = deps([view('A'), view('B'), view('C')]);
    d.deliveredCommit = (id) => id === 'C' ? COMMIT : undefined;
    d.git = vi.fn(async (args) => ({ code: 0, stdout: args[0] === 'for-each-ref' ? 'refs/heads/wicked/A\nrefs/remotes/origin/wicked/B\n' : '', stderr: '' }));
    const result = success(await reviewChangeExclusion(`commit ${COMMIT}`, d));
    expect(result).toMatchObject({ provenance: 'built_here', runs: ['A', 'B', 'C'], headSha: COMMIT });
    expect(result.baseRef).toBeUndefined();
    expect(d.git).toHaveBeenCalledWith(['fetch', 'origin'], d.repoRoot);
    expect(d.git).toHaveBeenCalledWith(['cat-file', '-e', `${COMMIT}^{commit}`], d.repoRoot);
    expect(d.git).toHaveBeenCalledWith(['for-each-ref', '--contains', COMMIT, '--format=%(refname)', 'refs/heads/wicked/', 'refs/remotes/origin/wicked/'], d.repoRoot);
  });

  it.each([
    ['branch feature/review', 'fetch'], ['branch feature/review', 'rev-parse'],
    [COMMIT, 'fetch'], [COMMIT, 'cat-file'], [COMMIT, 'for-each-ref'],
  ])('uses unknown when %s fails at %s', async (words, command) => {
    const d = deps();
    d.git = async (args) => ({ code: args[0] === command ? 128 : 0, stdout: HEAD, stderr: '' });
    expect(success(await reviewChangeExclusion(words, d))).toMatchObject({ provenance: 'unknown', excludeSeats: ['claude'] });
  });
});
