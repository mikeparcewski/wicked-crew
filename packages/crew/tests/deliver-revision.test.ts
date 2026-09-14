// DES-L9 / crew#550 — `revisesPr`: the daemon's half of revising an open pull request from a run.
//
//  - `resolvePullRequest` turns a PR number into the head branch the run bases on and pushes to,
//    through `gh pr view` (5 s), refusing BY NAME on anything but OPEN + same repository;
//  - `LaunchSchema` ties `revisesPr` to `repoRef` + `workflow` and forbids `deliver: "none"`;
//  - `POST /runs` resolves it, hands the engine `baseRef` (crew-internal) and refuses (409) a PR
//    that is not open and a launch this daemon resolved to `deliver: none` (F5);
//  - the retry index hydrates the revised PR from the `run.launched` trail entry;
//  - the deliver gate card names the push target and the identity's pin source;
//  - crew's `bug.fix` mirror carries the SAME sweep literal core's `bug_def()` does (F10).

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LaunchSchema, registerRoutes } from '../src/api/routes.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { RetryIndex } from '../src/api/retry-index.js';
import {
  BUG_FIX_SWEEP_INSTRUCTIONS,
  deliverGateInstructions,
  isSafeRefName,
  resolvePullRequest,
  type GhExec,
} from '../src/core/deliver.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { AuditEntry, LaunchRunInput } from '../src/core/types.js';

const HEAD = 'wicked/cd3ea61d-9f4f-406d-972b-13ace3a87595';
const URL_273 = 'https://github.com/mikeparcewski/wicked-studio/pull/273';

function gh(answer: Partial<{ stdout: string; stderr: string; code: number | null }> | Error): GhExec {
  return async () => {
    if (answer instanceof Error) throw answer;
    return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code === undefined ? 0 : answer.code };
  };
}
const OPEN = JSON.stringify({ headRefName: HEAD, state: 'OPEN', isCrossRepository: false, url: URL_273 });

describe('resolvePullRequest — PR number → head branch, refused by name on anything but OPEN + same repo', () => {
  it('resolves an OPEN same-repository PR, asking gh for exactly the four fields', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args, opts) => {
      calls.push(args);
      expect(opts).toEqual({ cwd: '/repo', timeoutMs: 5000 });
      return { stdout: OPEN, stderr: '', code: 0 };
    };
    const r = await resolvePullRequest('/repo', 273, exec);
    expect(r).toEqual({ ok: true, pr: { number: 273, headRef: HEAD, url: URL_273, state: 'OPEN' } });
    expect(calls).toEqual([['pr', 'view', '273', '--json', 'headRefName,state,isCrossRepository,url']]);
  });

  it('refuses a MERGED / CLOSED PR, a fork PR, an unusable head name and a non-PR URL — each by name', async () => {
    const merged = await resolvePullRequest('/repo', 273, gh({ stdout: OPEN.replace('"OPEN"', '"MERGED"') }));
    expect(merged).toEqual({ ok: false, error: 'revisesPr #273 is MERGED — only an open pull request can be revised' });
    const fork = await resolvePullRequest('/repo', 273, gh({ stdout: OPEN.replace('"isCrossRepository":false', '"isCrossRepository":true') }));
    expect(fork.ok).toBe(false);
    expect((fork as { error: string }).error).toMatch(/fork pull request/);
    const badHead = await resolvePullRequest('/repo', 273, gh({ stdout: OPEN.replace(HEAD, "a'b; rm -rf") }));
    expect((badHead as { error: string }).error).toMatch(/head branch name cannot be used as a push target/);
    const badUrl = await resolvePullRequest('/repo', 273, gh({ stdout: OPEN.replace(URL_273, 'javascript:alert(1)') }));
    expect((badUrl as { error: string }).error).toMatch(/not a pull request URL/);
  });

  it('refuses when gh fails, times out, throws or answers non-JSON — never a silent second PR', async () => {
    expect(await resolvePullRequest('/repo', 273, gh({ stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 273.', code: 1 }))).toEqual({
      ok: false,
      error: 'gh could not read PR #273: GraphQL: Could not resolve to a PullRequest with the number of 273.',
    });
    expect(await resolvePullRequest('/repo', 273, gh({ code: null }))).toEqual({
      ok: false,
      error: 'gh could not read PR #273: gh timed out or could not be spawned',
    });
    expect(await resolvePullRequest('/repo', 273, gh(new Error('spawn gh ENOENT')))).toEqual({
      ok: false,
      error: 'gh could not read PR #273: spawn gh ENOENT',
    });
    expect(await resolvePullRequest('/repo', 273, gh({ stdout: '<html>login</html>' }))).toEqual({
      ok: false,
      error: 'gh could not read PR #273: its answer was not the JSON asked for',
    });
    expect(await resolvePullRequest('/repo', 0, gh({ stdout: OPEN }))).toEqual({
      ok: false,
      error: 'revisesPr must be a positive pull request number (got 0)',
    });
  });

  it('isSafeRefName admits git-style heads and refuses what a single-quoted literal cannot carry', () => {
    for (const ok of [HEAD, 'main', 'feature/x.y-z', 'release-1.2']) expect(isSafeRefName(ok), ok).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a b', "a'b", 'a/', 'x.lock', '$(rm)', 'a:b', '~1', 'refs/heads/x^']) expect(isSafeRefName(bad), bad).toBe(false);
  });
});

describe('LaunchSchema — revisesPr needs repoRef + workflow and a deliver phase to push with', () => {
  const base = { problem: 'Revise PR #273 — the review said REQUEST CHANGES', repoRef: 'wicked-studio', workflow: 'bug' };
  it('accepts a positive integer with repoRef + workflow; rejects the rest', () => {
    expect(LaunchSchema.safeParse({ ...base, revisesPr: 273 }).success).toBe(true);
    expect(LaunchSchema.safeParse({ ...base, revisesPr: 273, deliver: 'pr' }).success).toBe(true);
    for (const bad of [0, -1, 1.5, '273', null]) {
      expect(LaunchSchema.safeParse({ ...base, revisesPr: bad }).success, String(bad)).toBe(false);
    }
    const messages = (r: ReturnType<typeof LaunchSchema.safeParse>): string => (r.success ? '' : r.error.issues.map((i) => i.message).join(' | '));
    const noRepo = LaunchSchema.safeParse({ problem: 'x', workflow: 'bug', revisesPr: 273 });
    expect(noRepo.success).toBe(false);
    expect(messages(noRepo)).toContain('revisesPr needs repoRef and workflow');
    const noWorkflow = LaunchSchema.safeParse({ problem: 'x', repoRef: 'r', revisesPr: 273 });
    expect(noWorkflow.success).toBe(false);
    const none = LaunchSchema.safeParse({ ...base, revisesPr: 273, deliver: 'none' });
    expect(none.success).toBe(false);
    expect(messages(none)).toContain('revisesPr needs deliver: "pr"');
  });
});

function buildApp(opts: { deliverDefault?: 'pr' | 'none'; resolve?: RuntimeDeps['resolvePullRequest'] } = {}) {
  const launched: LaunchRunInput[] = [];
  const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
  const adapter = {
    sessionsDetail: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    runEvents: vi.fn(async () => null),
    listRepos: vi.fn(async () => [{ id: 'wicked-studio', name: 'wicked-studio', root_path: '/srv/wicked-studio', registered_at: 1 }]),
    getWorkflow: vi.fn((id: string) => (id === 'bug' ? bug : null)),
    getSettings: vi.fn(async () => ({ deliverDefault: opts.deliverDefault ?? 'pr' })),
    launchRun: vi.fn(async (input: LaunchRunInput) => {
      launched.push(input);
      return input.sessionId;
    }),
    engineCapabilities: vi.fn(() => ({ deliverGate: true, revisesPr: true })),
    ping: vi.fn(async () => 'pong'),
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  const retryIndex = new RetryIndex();
  const runtime: Partial<RuntimeDeps> = {
    deliveryIndex: new DeliveryIndex(),
    retryIndex,
    worktreeExists: () => true,
    worktreeIsClean: async () => false,
    runBranchIsEmpty: async () => false,
    resolvePullRequest: opts.resolve ?? (async () => ({ ok: true, pr: { number: 273, headRef: HEAD, url: URL_273, state: 'OPEN' } })),
  };
  registerRoutes(
    app,
    adapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  return { app, launched, retryIndex, adapter };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const BODY = { problem: 'Revise PR #273 — the review said REQUEST CHANGES', repoRef: 'wicked-studio', workflow: 'bug', revisesPr: 273 };

describe('POST /runs {revisesPr} — resolved at the boundary, refused by name, handed to the engine as baseRef', () => {
  it('launches with baseRef = the PR head, revisesPr on the input and in the retry index; humanConfirm stays omitted', async () => {
    const { app, launched, retryIndex } = buildApp();
    apps.push(app);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: BODY });
    expect(res.statusCode).toBe(201);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ deliver: 'pr', baseRef: HEAD, revisesPr: { number: 273, headRef: HEAD, url: URL_273 }, repoRef: 'wicked-studio', workflow: 'bug' });
    expect(launched[0]).not.toHaveProperty('humanConfirm');
    expect(launched[0]).not.toHaveProperty('autoDeliver');
    const runId = (res.json() as { runId: string }).runId;
    expect(retryIndex.revisesPrFor(runId)).toEqual({ number: 273, headRef: HEAD, url: URL_273 });
  });

  it('409 by name when the PR is not open (nothing launched), 409 when this daemon resolved the launch to deliver none (F5)', async () => {
    const merged = buildApp({ resolve: async () => ({ ok: false, error: 'revisesPr #273 is MERGED — only an open pull request can be revised' }) });
    apps.push(merged.app);
    await merged.app.ready();
    const res = await merged.app.inject({ method: 'POST', url: '/api/v1/runs', payload: BODY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'revisesPr #273 is MERGED — only an open pull request can be revised' });
    expect(merged.launched).toHaveLength(0);

    const none = buildApp({ deliverDefault: 'none' });
    apps.push(none.app);
    await none.app.ready();
    const r2 = await none.app.inject({ method: 'POST', url: '/api/v1/runs', payload: BODY });
    expect(r2.statusCode).toBe(409);
    expect((r2.json() as { error: string }).error).toBe('revisesPr needs deliver: pr — this daemon resolved the launch to none (deliverDefault); send deliver: "pr"');
    expect(none.launched).toHaveLength(0);
    // …and an explicit `deliver: "pr"` on the same daemon launches.
    const r3 = await none.app.inject({ method: 'POST', url: '/api/v1/runs', payload: { ...BODY, deliver: 'pr' } });
    expect(r3.statusCode).toBe(201);
    expect(none.launched[0]).toMatchObject({ baseRef: HEAD });
  });

  it('400 on deliver: "none" (schema) and 404 on an unknown repoRef — nothing launched', async () => {
    const { app, launched } = buildApp();
    apps.push(app);
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { ...BODY, deliver: 'none' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { ...BODY, repoRef: 'nope' } })).statusCode).toBe(404);
    expect(launched).toHaveLength(0);
  });

  it('GET /health.capabilities carries revisesPr', async () => {
    const { app } = buildApp();
    apps.push(app);
    await app.ready();
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as { capabilities: Record<string, boolean> };
    expect(health.capabilities).toEqual({ deliverGate: true, revisesPr: true });
  });
});

describe('RetryIndex — the revised PR hydrates from the run.launched trail entry', () => {
  it('reads detail.revisesPr beside retryOf and ignores malformed records', () => {
    const idx = new RetryIndex();
    const entry = (runId: string, detail: Record<string, unknown>): AuditEntry =>
      ({ ts: 't', action: 'run.launched', actor: { kind: 'local' }, runId, detail }) as unknown as AuditEntry;
    idx.hydrateFromLaunchEntries([
      entry('r1', { retryOf: 'r0', revisesPr: { number: 273, headRef: HEAD, url: URL_273 }, baseRef: HEAD }),
      entry('r2', { revisesPr: { number: '273', headRef: HEAD, url: URL_273 } }),
      entry('r3', { revisesPr: null }),
      entry('r4', {}),
    ]);
    expect(idx.retryOfFor('r1')).toBe('r0');
    expect(idx.revisesPrFor('r1')).toEqual({ number: 273, headRef: HEAD, url: URL_273 });
    expect(idx.revisesPrFor('r2')).toBeUndefined();
    expect(idx.revisesPrFor('r3')).toBeUndefined();
    expect(idx.revisesPrFor('r4')).toBeUndefined();
    idx.setRevisesPr('r5', { number: 9, headRef: 'wicked/x', url: 'https://github.com/o/r/pull/9' });
    expect(idx.revisesPrFor('r5')).toEqual({ number: 9, headRef: 'wicked/x', url: 'https://github.com/o/r/pull/9' });
  });
});

describe('the deliver gate card (DES-L9 §4) — push target + identity with its pin source', () => {
  it('names the revised PR or the new-PR push, and the identity: pinned by GH_TOKEN / keyring / not set', () => {
    expect(deliverGateInstructions({ revisesPr: { number: 273, headRef: HEAD, url: URL_273 }, ghAccount: 'release-bot', ghTokenPinned: true })).toBe(
      `Pushes wicked/<run> onto pull request #273 (branch ${HEAD}); no new PR. Push identity: GH_ACCOUNT=release-bot, pinned by GH_TOKEN — the phase refuses if gh's login differs at push time.`,
    );
    expect(deliverGateInstructions({ ghAccount: 'release-bot', ghTokenPinned: false })).toBe(
      "Pushes the run branch wicked/<run> to origin and opens a pull request; merge stays human. Push identity: GH_ACCOUNT=release-bot from the gh keyring — the login can change between the check and the push; export GH_TOKEN to pin it. The phase refuses if gh's login differs.",
    );
    expect(deliverGateInstructions({})).toBe(
      'Pushes the run branch wicked/<run> to origin and opens a pull request; merge stays human. Push identity: GH_ACCOUNT is not set — pushes as whatever login gh holds.',
    );
    // Never the token itself.
    expect(deliverGateInstructions({ ghAccount: 'a', ghTokenPinned: true })).not.toMatch(/ghp_|gho_/);
  });
});

describe('bug.fix sweep instructions — one literal on both carriers (DES-L9 F10, BC-60)', () => {
  // The crew MIRROR gains the line in the row-6.9 pin PR, lockstep with wicked-core-ts 0.7.27:
  // `builtin-overlay-shadow.test.ts` compares the mirror byte-for-byte with core MAIN's
  // workflows/bug.json, which gains the field in wicked-core #522 — carrying it here first would
  // red-line crew CI until #522 merges. NOT_FIXED_YET until 6.9 — flip to `it` there.
  it.fails('NOT_FIXED_YET (row 6.9, lockstep with core-ts 0.7.27): crew’s mirror carries exactly the literal wicked-core’s bug_def() carries', () => {
    const fix = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!.phases.find((p) => p.id === 'fix')!;
    expect(fix.instructions).toBe(BUG_FIX_SWEEP_INSTRUCTIONS);
  });

  it('the literal crew will hand the mirror is core’s, byte for byte, one line, inside the PTY prompt budget', () => {
    // Pinned to the text — the drift guard against core's `BUG_FIX_SWEEP_INSTRUCTIONS`.
    expect(BUG_FIX_SWEEP_INSTRUCTIONS).toBe(
      'Update every consumer of behaviour this fix retires or changes: tests, docs, comments.',
    );
    expect(BUG_FIX_SWEEP_INSTRUCTIONS).not.toContain('\n');
    expect(Buffer.byteLength(BUG_FIX_SWEEP_INSTRUCTIONS)).toBeLessThanOrEqual(90); // the PTY prompt budget (core's headroom test)
    for (const p of BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!.phases.filter((p) => p.id !== 'fix')) {
      expect(p.instructions ?? null, p.id).toBeNull();
    }
  });
});
