import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { AuditLog } from '../src/api/audit.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import * as deliveryRecords from '../src/api/delivery-index.js';
import * as deliver from '../src/core/deliver.js';
import { RetryIndex } from '../src/api/retry-index.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, SessionView } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const HEAD = 'a'.repeat(40);
const BODY = { workflow: 'review-change', repoRef: 'repo', problem: 'review #12', power: false };
const AUTHOR = { key: 'claude', work_eligible: true, council_eligible: true };
const REVIEWER = { key: 'codex', work_eligible: true, council_eligible: true };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

/** Reuse the revision route's fake adapter seam: inspect exactly what the engine would receive. */
function buildApp(opts: { roster?: unknown[]; views?: SessionView[]; ghFails?: boolean; deliverOutput?: string } = {}) {
  const launched: LaunchRunInput[] = [];
  const roster = opts.roster ?? [AUTHOR, REVIEWER];
  const views = opts.views ?? [{
    session: { id: 'A', repo_ref: 'repo', created_at: Date.now() / 1000 },
    units: [{ stage: 'build', role: 'creator', assigned_cli: 'claude' }],
  } as unknown as SessionView];
  const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    runEvents: vi.fn(async () => null),
    runView: vi.fn(async (id: string) => views.find((v) => v.session.id === id) ?? null),
    listRepos: vi.fn(async () => [{ id: 'repo', name: 'repo', root_path: process.cwd(), registered_at: 1 }]),
    // A code-work default deliberately exercises the review's forced no-delivery decision.
    getWorkflow: vi.fn(() => bug),
    getSettings: vi.fn(async () => ({ deliverDefault: 'pr' })),
    launchRun: vi.fn(async (input: LaunchRunInput) => { launched.push(input); return input.sessionId; }),
  } as unknown as CoreAdapter;
  const gh = vi.fn(async () => ({
    code: opts.ghFails ? 1 : 0, stderr: opts.ghFails ? 'lookup failed' : '',
    stdout: JSON.stringify({ headRefName: 'wicked/A', headRefOid: HEAD, url: 'https://github.com/org/repo/pull/12', state: 'OPEN', isCrossRepository: false }),
  }));
  const git = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  const deliveryIndex = new DeliveryIndex();
  const retryIndex = new RetryIndex();
  const audit = AuditLog.noop();
  const record = vi.spyOn(audit, 'record');
  const runtime: Partial<RuntimeDeps> = {
    deliveryIndex, retryIndex, reviewChange: { gh, git },
    rosterWithStanding: (() => roster) as NonNullable<RuntimeDeps['rosterWithStanding']>,
    signedIn: () => true,
    resolveLinkedIssues: async () => ({ issues: [], block: null }),
    worktreeExists: () => true, worktreeIsClean: async () => false, runBranchIsEmpty: async () => false,
    deliverExec: async () => ({ status: 0, output: opts.deliverOutput ?? '' }),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'off' }, runtime);
  const post = (extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/v1/runs', payload: { ...BODY, ...extra } });
  return { app, post, launched, gh, git, record, deliveryIndex, retryIndex };
}

describe('review-change launch', () => {
  it('excludes the author from workers and judges and retains the review brief and audit', async () => {
    const { post, launched, gh, record } = buildApp();
    const res = await post();
    expect(res.statusCode, res.body).toBe(201);
    expect(launched).toHaveLength(1);
    expect(JSON.parse(launched[0]!.clisJson)).toEqual([REVIEWER]);
    expect(launched[0]!.excludeSeats).toEqual(['claude']);
    expect(launched[0]).not.toHaveProperty('deliver');
    expect(launched[0]!.baseRef).toBe('wicked/A');
    expect(launched[0]!.problem).toContain('Review target: PR #12');
    expect(launched[0]!.problem).toContain(`Head SHA: ${HEAD}`);
    expect(launched[0]!.problem).toContain('built by runs A (authors excluded: claude)');
    expect(launched[0]!.problem).toContain('Post nothing to the pull request.');
    expect(gh).toHaveBeenCalledWith(['pr', 'view', '12', '--json', 'headRefName,headRefOid,url,state,isCrossRepository'], { cwd: process.cwd(), timeoutMs: 5000 });
    expect(record).toHaveBeenCalledWith('run.launched', expect.anything(), expect.objectContaining({ detail: expect.objectContaining({
      deliver: 'none', reviewChange: { target: { kind: 'pr', number: 12 }, provenance: 'built_here', runs: ['A'], excluded: ['claude'], headSha: HEAD },
    }) }));
  });

  it('refuses an author-only roster with an explicit reduced-assurance retry', async () => {
    const { post, launched } = buildApp({ roster: [AUTHOR] });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_independent_reviewer', excluded: ['claude'], retryWith: { reducedAssurance: true } });
    expect(res.json().error).toContain('Sign in another seat');
    expect(launched).toHaveLength(0);
  });

  it('allows an explicit reduced-assurance author review and labels it', async () => {
    const { post, launched, record } = buildApp({ roster: [AUTHOR] });
    const res = await post({ reducedAssurance: true });
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(launched[0]!.clisJson)).toEqual([AUTHOR]);
    expect(launched[0]).not.toHaveProperty('excludeSeats');
    expect(launched[0]!.reducedAssurance).toBe(true);
    expect(launched[0]!.problem).toContain("reduced assurance: the change's authors may review it");
    expect(launched[0]!.problem).not.toContain('authors excluded');
    expect(record).toHaveBeenCalledWith('run.launched', expect.anything(), expect.objectContaining({ detail: expect.objectContaining({ reviewChange: expect.objectContaining({ excluded: [] }) }) }));
  });

  it.each([
    ['blank key', { ...REVIEWER, key: ' ' }],
    ['work standing', { ...REVIEWER, work_eligible: false }],
    ['work role', { ...REVIEWER, seat_eligible_for_work: false }],
    ['signed out', { ...REVIEWER, signed_in: false }],
    ['auth standing', { ...REVIEWER, auth: 'signed_out' }],
    ['engine bench', { key: 'codex', health: { usable: false } }],
  ])('refuses when the remaining seat cannot work: %s', async (_why, seat) => {
    const { post, launched } = buildApp({ roster: [AUTHOR, seat] });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('no_independent_reviewer');
    expect(launched).toHaveLength(0);
  });

  it.each([{ deliver: 'pr' }, { revisesPr: 12 }])('refuses review delivery or revision: %j', async (extra) => {
    const { post, launched } = buildApp();
    const res = await post(extra);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('a review posts nothing and never delivers');
    expect(launched).toHaveLength(0);
  });

  it('requires a repository', async () => {
    const { post, launched } = buildApp();
    const res = await post({ repoRef: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('review-change needs repoRef');
    expect(launched).toHaveLength(0);
  });

  it('refuses an unknown repository', async () => {
    const { post, launched } = buildApp();
    const res = await post({ repoRef: 'missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('repoRef names an unknown repo: missing');
    expect(launched).toHaveLength(0);
  });

  it('refuses unreadable authors even in reduced assurance', async () => {
    const { post, launched } = buildApp({ views: [] });
    for (const reducedAssurance of [false, true]) {
      const res = await post({ reducedAssurance });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('review_authors_unknown');
    }
    expect(launched).toHaveLength(0);
  });

  it('refuses a malformed roster before handing it to the engine', async () => {
    const { post, launched } = buildApp();
    for (const clisJson of ['{', '{}']) {
      const res = await post({ clisJson });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('review-change needs clisJson to be a roster array');
    }
    expect(launched).toHaveLength(0);
  });

  it('refuses an author selected as primary after filtering the roster', async () => {
    const { post, launched } = buildApp();
    const res = await post({ primary: 'claude' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not in this launch');
    expect(launched).toHaveLength(0);
  });

  it('uses the conservative provenance fallback when gh fails', async () => {
    const { post, launched, record } = buildApp({ ghFails: true });
    const res = await post();
    expect(res.statusCode, res.body).toBe(201);
    expect(launched[0]!.excludeSeats).toEqual(['claude']);
    expect(launched[0]!.problem).toContain('provenance unknown:');
    expect(record).toHaveBeenCalledWith('run.launched', expect.anything(), expect.objectContaining({ detail: expect.objectContaining({ reviewChange: expect.objectContaining({ provenance: 'unknown' }) }) }));
  });

  it('leaves an ordinary workflow launch unchanged', async () => {
    const { post, launched, gh, git, record } = buildApp();
    const res = await post({ workflow: 'bug' });
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(launched[0]!.clisJson)).toEqual([AUTHOR, REVIEWER]);
    expect(launched[0]).not.toHaveProperty('excludeSeats');
    expect(launched[0]!.deliver).toBe('pr');
    expect(launched[0]!.problem).toBe(BODY.problem);
    expect(gh).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
    expect(record.mock.calls.find(([action]) => action === 'run.launched')?.[2]?.detail).not.toHaveProperty('reviewChange');
  });

  it.each([
    ['PR', 'https://github.com/org/repo/pull/12', 200],
    ['push-only', 'deliver: PUSHED-NO-PR wicked/A /srv/remote.git', 409],
  ])('records the post-hoc delivered commit for %s delivery', async (_kind, output, status) => {
    const readCommit = vi.spyOn(deliveryRecords, 'readDeliveredCommit').mockResolvedValue(HEAD);
    vi.spyOn(deliver, 'readDeliverOriginUrl').mockResolvedValue(null);
    const views = [{ session: { id: 'A', repo_ref: 'repo', status: 'completed', workdir: process.cwd(), run_branch: 'feature/A', clis: [], workflow_id: 'bug' }, units: [] }] as unknown as SessionView[];
    const { app, record, deliveryIndex } = buildApp({ views, deliverOutput: output });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/A/deliver' });
    expect(res.statusCode, res.body).toBe(status);
    expect(readCommit).toHaveBeenCalledWith(process.cwd(), 'feature/A');
    expect(deliveryIndex.commitFor('A')).toBe(HEAD);
    expect(record).toHaveBeenCalledWith('run.delivered', expect.anything(), expect.objectContaining({ detail: expect.objectContaining({ commit: HEAD, via: 'post-hoc' }) }));
  });
});
