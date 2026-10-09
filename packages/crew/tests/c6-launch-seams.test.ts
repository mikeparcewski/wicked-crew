// W2-C6 — the crew HTTP layer's launch path and run record:
//  - crew#471: `/health` answers while the engine's actor is busy; a recon fan acks while the
//    engine is still launching it; a restart crash-resumes the campaigns left `running`; a
//    shutdown whose steps hang still exits.
//  - crew#496: an onboarding run started by `POST /repos` / `POST /repos/:id/onboard` is filed into
//    the chosen project and carries a launch record.
//  - crew#627: a workflow launch whose intent links an issue reaches the engine with the issue text,
//    and says which issues were read.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { ENGINE_BUSY_PING, HEALTH_PING_WAIT_MS, registerRoutes } from '../src/api/routes.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { resumeRunningCampaigns } from '../src/campaign/boot-resume.js';
import { shutdownWithDeadline } from '../src/core/shutdown.js';
import { LINKED_ISSUES_OPEN } from '../src/core/linked-issues.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';
import type { AuditEntry, CampaignDef, LaunchRunInput, RepoEntry } from '../src/core/types.js';
import type { Campaign } from 'wicked-crew-api-types';

const dirs: string[] = [];
const servers: FastifyInstance[] = [];
const adapters: CoreAdapter[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const a of adapters.splice(0)) a.close();
});
afterAll(() => dirs.forEach(removeScratch));

const REPOS: RepoEntry[] = [
  { id: 'repo-alpha', name: 'alpha', root_path: '/x/alpha', default_branch: 'main', registered_at: 1 },
  { id: 'repo-beta', name: 'beta', root_path: '/x/beta', default_branch: 'main', registered_at: 2 },
];

async function server(setup: (a: CoreAdapter) => void): Promise<{ app: FastifyInstance; auditPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'c6-launch-'));
  dirs.push(dir);
  const auditPath = join(dir, 'audit.log');
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapters.push(adapter);
  adapter.listRepos = async () => REPOS;
  setup(adapter);
  const app = await createServer(adapter, { auditPath });
  servers.push(app);
  return { app, auditPath };
}

/** The trail as written so far (the audit log appends asynchronously — poll it with vi.waitFor). */
function trail(auditPath: string): AuditEntry[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditEntry);
}

describe('crew#471 — the daemon stays answerable while the engine is busy', () => {
  it('GET /health answers `ping: "busy"` within the wait when the actor does not answer, and never stacks pings', async () => {
    let pings = 0;
    const { app } = await server((a) => {
      a.ping = () => {
        pings += 1;
        return new Promise<string>(() => undefined); // the actor is planning a big launch
      };
    });
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/health' }),
      app.inject({ method: 'GET', url: '/api/v1/health' }),
    ]);
    expect(Date.now() - t0).toBeLessThan(HEALTH_PING_WAIT_MS + 1_500);
    for (const r of [r1, r2]) {
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: 'ok', ping: ENGINE_BUSY_PING });
    }
    expect(pings).toBe(1); // one probe in flight; the second health call joined it
  });

  it('GET /health still reports the actor’s own answer when it comes back in time', async () => {
    const { app } = await server((a) => {
      a.ping = async () => 'ok';
    });
    const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.json()).toMatchObject({ status: 'ok', ping: 'ok' });
  });

  it('a recon fan the engine is still launching is acked 202 with its final run ids; the trail lands when the engine answers', async () => {
    let finish!: () => void;
    let launched: CampaignDef | null = null;
    const { app, auditPath } = await server((a) => {
      a.campaignsSupported = () => true;
      a.launchCampaign = (def: CampaignDef) => {
        launched = def;
        return new Promise<string>((resolve) => {
          finish = () => resolve(def.id);
        });
      };
    });
    const t0 = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/testing/recon',
      payload: { problem: 'Recon: survey the targets', repoRefs: ['repo-alpha', 'repo-beta'] },
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(res.statusCode).toBe(202);
    const body = res.json() as { runIds: string[]; campaign: string; campaignRegistered: boolean; launching?: boolean };
    expect(body.launching).toBe(true);
    expect(body.campaignRegistered).toBe(true);
    expect(body.runIds).toHaveLength(2);
    expect(body.runIds.every((id) => id.startsWith(`${body.campaign}:`))).toBe(true);
    expect(launched).not.toBeNull();
    // Nothing is recorded as launched before the engine accepted it…
    await new Promise((r) => setTimeout(r, 200));
    expect(trail(auditPath).filter((e) => e.action === 'run.launched')).toHaveLength(0);
    finish();
    await vi.waitFor(() => {
      expect(trail(auditPath).filter((e) => e.action === 'run.launched').map((e) => e.runId)).toEqual(body.runIds);
    });
    expect(trail(auditPath).some((e) => e.action === 'campaign.launched')).toBe(true);
  });

  it('a late refusal after the ack is written to the trail as campaign.launch_failed', async () => {
    let fail!: (e: Error) => void;
    const { app, auditPath } = await server((a) => {
      a.campaignsSupported = () => true;
      a.launchCampaign = () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/testing/recon',
      payload: { problem: 'Recon: survey the targets', repoRefs: ['repo-alpha', 'repo-beta'] },
    });
    expect(res.statusCode).toBe(202);
    fail(new Error('worktree add failed'));
    await vi.waitFor(() => {
      const failed = trail(auditPath).find((e) => e.action === 'campaign.launch_failed');
      expect(failed?.detail).toMatchObject({ error: 'worktree add failed' });
    });
    expect(trail(auditPath).filter((e) => e.action === 'run.launched')).toHaveLength(0);
  });

  it('at boot the engine is asked to crash-resume every campaign the store still calls running — never a paused one', async () => {
    const resumed: string[] = [];
    const campaigns = [
      { id: 'c-running', status: 'running' },
      { id: 'c-paused', status: 'paused' },
      { id: 'c-done', status: 'completed' },
    ] as unknown as Campaign[];
    await server((a) => {
      a.campaignsSupported = () => true;
      a.campaignList = async () => campaigns;
      a.resumeCampaign = async (id: string) => {
        resumed.push(id);
        return 'running';
      };
    });
    await vi.waitFor(() => expect(resumed).toEqual(['c-running']));
  });

  it('resumeRunningCampaigns never throws: a list failure or a refused resume is logged', async () => {
    const logs: string[] = [];
    const listFails = await resumeRunningCampaigns(
      { campaignsSupported: () => true, campaignList: async () => { throw new Error('store busy'); }, resumeCampaign: async () => 'x' },
      (m) => logs.push(m),
    );
    expect(listFails).toEqual({ resumed: [], failed: [] });
    const refused = await resumeRunningCampaigns(
      {
        campaignsSupported: () => true,
        campaignList: async () => [{ id: 'c1', status: 'running' }] as unknown as Campaign[],
        resumeCampaign: async () => { throw new Error('campaign not found: c1'); },
      },
      (m) => logs.push(m),
    );
    expect(refused.failed).toEqual([{ id: 'c1', error: 'campaign not found: c1' }]);
    expect(logs.join('\n')).toMatch(/could not list campaigns: store busy[\s\S]*1 refused/);
    // An adapter without the campaign surface is a no-op.
    expect(await resumeRunningCampaigns({} as never, () => undefined)).toEqual({ resumed: [], failed: [] });
  });

  it('a shutdown whose steps hang still exits at the deadline, exactly once', async () => {
    const exits: number[] = [];
    const warns: string[] = [];
    shutdownWithDeadline(() => new Promise<void>(() => undefined), (c) => exits.push(c), 50, (m) => warns.push(m));
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(warns[0]).toMatch(/still running after 50 ms/);
    const quick: number[] = [];
    shutdownWithDeadline(async () => undefined, (c) => quick.push(c), 50);
    await new Promise((r) => setTimeout(r, 120));
    expect(quick).toEqual([0]);
  });
});

describe('crew#496 — onboarding runs are filed and dated', () => {
  function onboardingAdapter(a: CoreAdapter, attaches: Array<{ projectId: string; kind: string; ref: string }>): void {
    // Run mechanics, not grounding: with no published generation a daemon refuses an onboard before it
    // registers anything (crew#753), so these filing cases turn the base skill off (tests/setup/base-skill-off.ts).
    baseSkillOff();
    a.registerRepo = async (name: string, rootPath: string) => ({ id: `repo-${name}`, name, root_path: rootPath, default_branch: 'main', registered_at: 3 });
    a.launchOnboardingRun = async (repoId: string) => `onboard-${repoId}`;
    a.projectMemberAttach = async (projectId: string, kind: string, ref: string) => {
      attaches.push({ projectId, kind, ref });
      return {
        member: { id: `${projectId}:${kind}:${ref}`, project_id: projectId, member_kind: kind, member_ref: ref, meta: null, attached_at: 5, attached_by: 'api' },
        created: true,
      };
    };
  }

  it('POST /repos with a projectId files the onboarding run there and writes its launch record', async () => {
    const attaches: Array<{ projectId: string; kind: string; ref: string }> = [];
    const { app, auditPath } = await server((a) => onboardingAdapter(a, attaches));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { name: 'gamma', rootPath: '/x/gamma', projectId: 'wicked-platform', channel: 'studio' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ onboardRunId: 'onboard-repo-gamma' });
    expect(attaches).toEqual([{ projectId: 'wicked-platform', kind: 'crew.run', ref: 'onboard-repo-gamma' }]);
    await vi.waitFor(() => {
      const entry = trail(auditPath).find((e) => e.action === 'run.launched' && e.runId === 'onboard-repo-gamma');
      expect(entry?.detail).toMatchObject({ workflow: 'onboarding', repoRef: 'repo-gamma', projectId: 'wicked-platform', channel: 'studio' });
    });
  });

  it('POST /repos/:id/onboard files the re-run too; without a projectId it is dated but unfiled', async () => {
    const attaches: Array<{ projectId: string; kind: string; ref: string }> = [];
    const { app, auditPath } = await server((a) => onboardingAdapter(a, attaches));
    const filed = await app.inject({ method: 'POST', url: '/api/v1/repos/repo-alpha/onboard', payload: { projectId: 'p1' } });
    expect(filed.statusCode).toBe(201);
    expect(attaches).toEqual([{ projectId: 'p1', kind: 'crew.run', ref: 'onboard-repo-alpha' }]);
    const bare = await app.inject({ method: 'POST', url: '/api/v1/repos/repo-beta/onboard' });
    expect(bare.statusCode).toBe(201);
    expect(attaches).toHaveLength(1);
    await vi.waitFor(() => {
      expect(trail(auditPath).filter((e) => e.action === 'run.launched').map((e) => e.runId)).toEqual(['onboard-repo-alpha', 'onboard-repo-beta']);
    });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/repos/repo-beta/onboard', payload: { projectID: 'typo' } });
    expect(bad.statusCode).toBe(400);
  });

  it('attaching a repo to a project files its onboarding run there too (studio registers, then attaches)', async () => {
    const attaches: Array<{ projectId: string; kind: string; ref: string }> = [];
    const { app } = await server((a) => {
      onboardingAdapter(a, attaches);
      a.getOnboardRunId = (repoId: string) => (repoId === 'repo-alpha' ? 'onboard-repo-alpha' : undefined);
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/p1/members', payload: { kind: 'crew.repo', ref: 'repo-alpha', attachedBy: 'studio' } });
    expect(res.statusCode).toBe(201);
    expect(attaches).toEqual([
      { projectId: 'p1', kind: 'crew.repo', ref: 'repo-alpha' },
      { projectId: 'p1', kind: 'crew.run', ref: 'onboard-repo-alpha' },
    ]);
    // A repo with no onboarding run on this daemon attaches alone.
    await app.inject({ method: 'POST', url: '/api/v1/projects/p1/members', payload: { kind: 'crew.repo', ref: 'repo-beta' } });
    expect(attaches).toHaveLength(3);
  });

  it('a filing failure is named in the 201, never turned into a failed register', async () => {
    const { app } = await server((a) => {
      onboardingAdapter(a, []);
      a.projectMemberAttach = async () => {
        throw new Error('project p9 is archived');
      };
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'delta', rootPath: '/x/delta', projectId: 'p9' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ onboardRunId: 'onboard-repo-delta', projectAttachError: 'project p9 is archived' });
  });
});

describe('crew#627 — a workflow launch reads the issues its intent links', () => {
  function routes(resolveLinkedIssues: RuntimeDeps['resolveLinkedIssues']): { app: FastifyInstance; launched: LaunchRunInput[] } {
    const launched: LaunchRunInput[] = [];
    const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
    const adapter = {
      sessionsDetail: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      runEvents: vi.fn(async () => null),
      listRepos: vi.fn(async () => [{ id: 'wicked-studio', name: 'wicked-studio', root_path: '/srv/wicked-studio', registered_at: 1 }]),
      getWorkflow: vi.fn((id: string) => (id === 'bug' ? bug : null)),
      getSettings: vi.fn(async () => ({ deliverDefault: 'none' })),
      launchRun: vi.fn(async (input: LaunchRunInput) => {
        launched.push(input);
        return input.sessionId;
      }),
      engineCapabilities: vi.fn(() => ({ deliverGate: true, revisesPr: true })),
      ping: vi.fn(async () => 'ok'),
    } as unknown as CoreAdapter;
    const app = Fastify({ logger: false });
    const runtime: Partial<RuntimeDeps> = { ...(resolveLinkedIssues !== undefined ? { resolveLinkedIssues } : {}) };
    registerRoutes(
      app,
      adapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      runtime,
    );
    servers.push(app);
    return { app, launched };
  }

  it('"fix #541" reaches the engine with the issue text appended in the marked block, and the answer names what was read', async () => {
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const { app, launched } = routes(async (problem, root, ref) => {
      calls.push([problem, root, ref]);
      return {
        issues: [{ ref: '#541', resolved: true, title: 'the bug' }, { ref: '#540', resolved: false, error: 'gh exit 4' }],
        block: `${LINKED_ISSUES_OPEN}\n### #541: the bug\nbody\n<!-- /wicked-crew:linked-issues -->`,
      };
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix #541 and #540', repoRef: 'wicked-studio', workflow: 'bug' } });
    expect(res.statusCode).toBe(201);
    expect(calls).toEqual([['fix #541 and #540', '/srv/wicked-studio', 'wicked-studio']]);
    expect(launched[0]!.problem.startsWith('fix #541 and #540\n\n<!-- wicked-crew:linked-issues -->')).toBe(true);
    expect(launched[0]!.problem).toContain('### #541: the bug');
    expect(res.json()).toMatchObject({
      linkedIssues: [{ ref: '#541', resolved: true, title: 'the bug' }, { ref: '#540', resolved: false, error: 'gh exit 4' }],
    });
  });

  it('a free-text launch is not touched: the planner would turn issue text into work units', async () => {
    const resolver = vi.fn(async () => ({ issues: [], block: null }));
    const { app, launched } = routes(resolver);
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix #541', repoRef: 'wicked-studio' } });
    expect(res.statusCode).toBe(201);
    expect(resolver).not.toHaveBeenCalled();
    expect(launched[0]!.problem).toBe('fix #541');
    expect(res.json()).not.toHaveProperty('linkedIssues');
  });

  it('crew#825: excludeLinkedIssues reaches the resolver; an all-excluded intent launches unchanged and answers what it left out', async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const { app, launched } = routes(async (_p, _root, _ref, exclude) => {
      seen.push(exclude);
      return { issues: [{ ref: '#539', resolved: false, excluded: true, error: 'left out by the launch (excludeLinkedIssues)' }], block: null };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'wicked-studio#539 records this', repoRef: 'wicked-studio', workflow: 'bug', excludeLinkedIssues: ['wicked-studio#539'] },
    });
    expect(res.statusCode).toBe(201);
    expect(seen).toEqual([['wicked-studio#539']]);
    expect(launched[0]!.problem).toBe('wicked-studio#539 records this');
    expect(res.json().linkedIssues).toEqual([{ ref: '#539', resolved: false, excluded: true, error: 'left out by the launch (excludeLinkedIssues)' }]);
  });

  it('crew#825: POST /linked-issues/preview answers the same reading before Send and launches nothing', async () => {
    const block = `${LINKED_ISSUES_OPEN}\nx\n<!-- /wicked-crew:linked-issues -->`;
    const { app, launched } = routes(async (_p, _root, _ref, exclude) => ({
      issues: [{ ref: '#541', resolved: true, title: 'the bug', chars: 42 }],
      block: exclude !== undefined && exclude.length > 0 ? null : block,
    }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/linked-issues/preview', payload: { problem: 'fix #541', repoRef: 'wicked-studio' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issues: [{ ref: '#541', resolved: true, title: 'the bug', chars: 42 }], appendedChars: block.length + 2 });
    const none = await app.inject({ method: 'POST', url: '/api/v1/linked-issues/preview', payload: { problem: 'fix #541', repoRef: 'wicked-studio', excludeLinkedIssues: ['541'] } });
    expect(none.json().appendedChars).toBe(0);
    expect(launched).toEqual([]);
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.json().capabilities.linkedIssuesExclude).toBe(true);
  });

  it('crew#662: a schema 400 names the field and what it expected, not only "Invalid request body"', async () => {
    const { app } = routes(undefined);
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', repoRef: 'wicked-studio', workflow: 'bug', revisesPr: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Invalid request body: `revisesPr` — Expected number, received boolean/);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', excludeLinkedIssues: ['issue 7'] } });
    expect(bad.json().error).toMatch(/`excludeLinkedIssues\.0` — an issue ref/);
  });
});
