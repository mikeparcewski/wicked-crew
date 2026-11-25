// PR B: real adapter entry points over fake engine methods, and the served HTTP contract.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDecision, PowerPauseRequest } from 'wicked-crew-api-types';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CampaignDef, LaunchPlan, RepoEntry, SessionView } from '../src/core/types.js';
import { registerRoutes } from '../src/api/routes.js';
import { AuditLog } from '../src/api/audit.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { withRunViews } from './support/run-views.js';
import { removeScratch } from './setup/scratch.js';

let adapter: CoreAdapter;
let dir: string;
let app: FastifyInstance | undefined;
let core: Record<string, unknown>;
let calls: Record<string, ReturnType<typeof vi.fn>>;
const input = { sessionId: 'new-run', problem: 'inspect this', clisJson: '[]' };
const campaign = { id: 'campaign', nodes: [], edges: [], run_specs: [] } as unknown as CampaignDef;
function view(id: string, status: string, repo = 'repo'): SessionView {
  return { session: { id, status, repo_ref: repo, workflow_id: 'bug', problem: 'p', unit_ix: 0 }, units: [] } as unknown as SessionView;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-c5-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  core = (adapter as unknown as { core: Record<string, unknown> }).core;
  calls = {};
  for (const method of ['launchRun', 'resumeRun', 'confirmGate', 'launchCampaign', 'resumeCampaign', 'cancelCampaign', 'campaignDetail', 'campaignList']) {
    calls[method] = vi.fn(async () => 'accepted');
    core[method] = calls[method];
  }
  calls['answerPowerPause'] = vi.fn(async () => '{}');
  core['answerPowerPause'] = calls['answerPowerPause'];
  adapter.sessionsDetail = vi.fn(async () => []);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  adapter.close();
  removeScratch(dir);
});

async function serve(views: SessionView[] = []) {
  adapter.sessionsDetail = vi.fn(async () => views);
  adapter.sessions = async () => views.map((v) => v.session.id);
  adapter.listRepos = async () => [];
  adapter.listWorkflows = () => [];
  const audit = AuditLog.noop();
  const record = vi.spyOn(audit, 'record');
  app = Fastify({ logger: false });
  registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
  await app.ready();
  return { app, record };
}

const drainError = { name: 'MaintenanceDrainError', code: 'maintenance_drain' };
describe('drain fence', () => {
  it.each(['launchRun', 'resumeRun', 'launchCampaign', 'resumeCampaign'] as const)('%s is refused before notices and the core, then passes when drain clears', async (method) => {
    adapter.setDraining(true);
    const notice = vi.fn();
    adapter.onLaunch(notice);
    const invoke = () => method === 'launchRun' ? adapter.launchRun(input)
      : method === 'launchCampaign' ? adapter.launchCampaign(campaign)
      : adapter[method]('run');
    await expect(invoke()).rejects.toMatchObject(drainError);
    expect(calls[method]).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    adapter.setDraining(false);
    await expect(invoke()).resolves.toBe('accepted');
    expect(calls[method]).toHaveBeenCalledOnce();
  });

  it('checks drain after an already queued launch finishes waiting', async () => {
    let release!: () => void;
    adapter.setLaunchGate(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = adapter.resumeRun('run');
    adapter.setDraining(true);
    release();
    await expect(pending).rejects.toMatchObject(drainError);
    expect(calls['resumeRun']).not.toHaveBeenCalled();
  });

  it.each([
    [false, undefined, false], [false, 'reject', false], [false, 'request_changes', true],
    [true, undefined, true], [true, 'approve', true], [true, 'edit_plan', true],
  ] as const)('gate approve=%s action=%s refuses=%s, including versioned answers', async (approve, action, refused) => {
    adapter.setDraining(true);
    adapter.supportsPlanSendBack = () => true;
    const notice = vi.fn();
    adapter.onLaunch(notice);
    for (const expectVersion of [undefined, { ord: 1, planRev: 2 }]) {
      const answer = adapter.confirmGate('run', approve, undefined, action, undefined, undefined, expectVersion);
      if (refused) await expect(answer).rejects.toMatchObject(drainError);
      else await expect(answer).resolves.toBe('accepted');
    }
    expect(calls['confirmGate']).toHaveBeenCalledTimes(refused ? 0 : 2);
    expect(notice).toHaveBeenCalledTimes(refused ? 0 : 4);
  });

  it('an edited plan resumes work even when approve is false', async () => {
    adapter.setDraining(true);
    const plan = { steps: [] } as unknown as LaunchPlan;
    await expect(adapter.confirmGate('run', false, undefined, undefined, undefined, plan)).rejects.toMatchObject(drainError);
    expect(calls['confirmGate']).not.toHaveBeenCalled();
  });

  it.each(['continue', 'continue_high', 'switch_phased', 'stop'] as const)('power pause %s only permits stop', async (decision) => {
    adapter.setDraining(true);
    const answer = adapter.answerPowerPause('run', decision, null, 'operator');
    if (decision === 'stop') await expect(answer).resolves.toEqual({});
    else await expect(answer).rejects.toMatchObject(drainError);
    expect(calls['answerPowerPause']).toHaveBeenCalledTimes(decision === 'stop' ? 1 : 0);
  });
});

describe('maintenance HTTP', () => {
  it('reports idle, stable since, only active statuses, and clears state when disabled', async () => {
    const views = ['planning', 'distributing', 'executing', 'parked', 'awaiting_human', 'completed', 'failed', 'cancelled'].map((s) => view(s, s));
    const { app } = await serve(views);
    expect((await app.inject('/api/v1/maintenance')).json()).toEqual({ draining: false, since: null, idle: false, active: views.slice(0, 3).map((v) => ({ runId: v.session.id, status: v.session.status })) });
    const on = await app.inject({ method: 'POST', url: '/api/v1/maintenance', payload: { drain: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ draining: true, since: expect.any(Number) });
    expect((await app.inject({ method: 'POST', url: '/api/v1/maintenance', payload: { drain: true } })).json()).toEqual(on.json());
    views.splice(0, 3);
    expect((await app.inject('/api/v1/maintenance')).json()).toMatchObject({ idle: true, active: [] });
    expect((await app.inject({ method: 'POST', url: '/api/v1/maintenance', payload: { drain: false } })).json()).toEqual({ draining: false, since: null, idle: true, active: [] });
  });

  it.each([{}, { drain: 'true' }, { drain: true, extra: 1 }])('rejects a non-strict maintenance request %j', async (payload) => {
    const { app } = await serve();
    expect((await app.inject({ method: 'POST', url: '/api/v1/maintenance', payload })).statusCode).toBe(400);
  });

  it('POST /runs returns a typed 503 without reaching core; disabling drain admits it', async () => {
    const { app } = await serve();
    adapter.setDraining(true);
    const launch = () => app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'inspect this', standIns: true } });
    const refused = await launch();
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'maintenance_drain', error: expect.any(String), hint: expect.any(String) });
    expect(calls['launchRun']).not.toHaveBeenCalled();
    adapter.setDraining(false);
    expect((await launch()).statusCode).toBe(201);
    expect(calls['launchRun']).toHaveBeenCalledOnce();
  });

  it.each(['resume', 'gate', 'power/pause'])('%s maps the adapter drain refusal to 503', async (path) => {
    const { app } = await serve([view('run', path === 'gate' ? 'awaiting_human' : 'parked')]);
    adapter.supportsPowerMode = () => true;
    // Exercise each route's catch independently of its engine-version/gate preconditions.
    const error = Object.assign(new Error('Daemon is draining'), { name: 'MaintenanceDrainError', code: 'maintenance_drain' });
    // Get the actual typed error from the fence once that feature exists.
    adapter.setDraining(true);
    let typedError: unknown = error;
    try { await adapter.resumeRun('probe'); } catch (err) { typedError = err; }
    adapter.resumeRun = vi.fn().mockRejectedValue(typedError);
    adapter.confirmGate = vi.fn().mockRejectedValue(typedError);
    adapter.answerPowerPause = vi.fn().mockRejectedValue(typedError);
    const payload: GateDecision | PowerPauseRequest | object = path === 'gate' ? { approve: true } : path === 'power/pause' ? { decision: 'continue' } : {};
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/run/${path}`, payload });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'maintenance_drain', hint: expect.any(String) });
  });
});

describe('repo removal HTTP and optional engine binding', () => {
  const repo: RepoEntry = { id: 'repo', name: 'repo', root_path: 'missing-checkout', default_branch: 'main', registered_at: 0 };
  async function registry(views: SessionView[] = []) {
    const h = await serve(views);
    const repos = [repo];
    adapter.listRepos = async () => repos;
    const unregister = vi.fn(async (id: string) => {
      const ix = repos.findIndex((r) => r.id === id);
      if (ix < 0) return 'false';
      repos.splice(ix, 1);
      return 'true';
    });
    core['unregisterRepo'] = unregister;
    return { ...h, unregister };
  }

  it.each(['planning', 'distributing', 'executing', 'parked', 'awaiting_human'])('refuses a %s run before asking the engine', async (status) => {
    const { app, unregister } = await registry([view('held', status), view('other', status, 'elsewhere')]);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/repos/repo' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'repo_in_use', runIds: ['held'] });
    expect(unregister).not.toHaveBeenCalled();
  });

  it('unknown repo is 404, including an engine false after the crew check', async () => {
    const { app, unregister } = await registry();
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/repos/unknown' })).json()).toMatchObject({ code: 'repo_not_found' });
    expect(unregister).not.toHaveBeenCalled();
    unregister.mockResolvedValue('false');
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/repos/repo' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'repo_not_found' });
  });

  it('removes a repo with only terminal runs, disappears from GET /repos, and audits success', async () => {
    const { app, unregister, record } = await registry(['completed', 'failed', 'cancelled'].map((s) => view(s, s)));
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/repos/repo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repoId: 'repo', removed: true });
    expect(unregister).toHaveBeenCalledWith('repo');
    expect((await app.inject('/api/v1/repos')).json()).toEqual({ repos: [] });
    expect(record).toHaveBeenCalledWith('repo.unregistered', expect.anything(), { detail: { repoId: 'repo' } });
  });

  it.each([
    ['repo_in_use: repository repo has live runs: run-a — wait for them to end or stop them first', 'repo_in_use'],
    ['repo_in_project: repository repo belongs to project(s) project-a — remove it from the project first', 'repo_in_project'],
  ])('maps engine refusal %s', async (message, code) => {
    const { app, unregister, record } = await registry();
    unregister.mockRejectedValue(new Error(message as string));
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/repos/repo' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code, error: message });
    expect(record).not.toHaveBeenCalled();
  });

  it('absent engine binding is a typed 501, never a simulated removal', async () => {
    const { app } = await registry();
    core['unregisterRepo'] = undefined;
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/repos/repo' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'repo_unregister_unsupported' });
    expect((await app.inject('/api/v1/repos')).json()).toMatchObject({ repos: [repo] });
  });
});
