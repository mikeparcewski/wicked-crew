// crew#1019: registration survives an onboarding launch refusal; no real clone or daemon.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const launchError = "workflow 'onboarding' cannot start — unresolved tool dependencies: wicked-estate";

function routes() {
  const repos: RepoEntry[] = [];
  const adapter = {
    listRepos: vi.fn(async () => repos),
    registerRepo: vi.fn(async (name: string, root: string) => {
      const repo = { id: 'r-new', name, root_path: root, registered_at: 1, default_branch: 'main' };
      repos.push(repo);
      return repo;
    }),
    launchOnboardingRun: vi.fn(async (): Promise<string> => { throw new Error(launchError); }),
    cloneAndRegister: vi.fn<CoreAdapter['cloneAndRegister']>(async () => { throw new Error('clone failed'); }),
    projectMemberAttach: vi.fn(),
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined });
  apps.push(app);
  return { app, adapter, repos };
}

describe('POST /api/v1/repos — registration and onboarding outcomes', () => {
  it('returns the registered local repo with a null run and launch error, without filing a run', async () => {
    const { app, adapter, repos } = routes();
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', rootPath: '/srv/alpha', projectId: 'p1' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ repo: repos[0], onboardRunId: null, onboardError: launchError });
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos' })).json().repos).toEqual(repos);
    expect(adapter.projectMemberAttach).not.toHaveBeenCalled();
  });

  it('still returns 400 when local registration fails', async () => {
    const { app, adapter } = routes();
    adapter.registerRepo.mockRejectedValue(new Error('not a git repository'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', rootPath: '/bad' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not a git repository' });
    expect(adapter.launchOnboardingRun).not.toHaveBeenCalled();
  });

  it('returns the registered remote repo with a null run and launch error, without filing a run', async () => {
    const { app, adapter, repos } = routes();
    adapter.cloneAndRegister.mockImplementation(async (name, _gitUrl, rootPath) => adapter.registerRepo(name, rootPath!));
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', rootPath: '/srv/alpha', projectId: 'p1' } });
    expect(res.statusCode).toBe(201);
    expect(repos).toHaveLength(1);
    expect(res.json()).toEqual({ repo: repos[0], onboardRunId: null, onboardError: launchError });
    expect(adapter.cloneAndRegister).toHaveBeenCalledExactlyOnceWith('alpha', 'https://example.invalid/alpha.git', '/srv/alpha');
    expect(adapter.launchOnboardingRun).toHaveBeenCalledExactlyOnceWith('r-new', 'alpha');
    expect(adapter.listRepos).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos' })).json().repos).toEqual(repos);
    expect(adapter.projectMemberAttach).not.toHaveBeenCalled();
  });

  it('returns 400 when cloning fails, without launching onboarding', async () => {
    const { app, adapter, repos } = routes();
    adapter.cloneAndRegister.mockRejectedValue(new Error('clone failed'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', rootPath: '/srv/alpha' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'clone failed' });
    expect(repos).toHaveLength(0);
    expect(adapter.launchOnboardingRun).not.toHaveBeenCalled();
    expect(adapter.projectMemberAttach).not.toHaveBeenCalled();
  });

  it('returns the registered remote repo and the launched onboarding run id on success', async () => {
    const { app, adapter, repos } = routes();
    adapter.cloneAndRegister.mockImplementation(async (name, _gitUrl, rootPath) => adapter.registerRepo(name, rootPath!));
    adapter.launchOnboardingRun.mockResolvedValue('run-onboard');
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', rootPath: '/srv/alpha' } });
    expect(res.statusCode).toBe(201);
    expect(repos).toHaveLength(1);
    expect(res.json()).toEqual({ repo: repos[0], onboardRunId: 'run-onboard' });
    expect(adapter.cloneAndRegister).toHaveBeenCalledExactlyOnceWith('alpha', 'https://example.invalid/alpha.git', '/srv/alpha');
    expect(adapter.launchOnboardingRun).toHaveBeenCalledExactlyOnceWith('r-new', 'alpha');
    expect(adapter.listRepos).not.toHaveBeenCalled();
  });
});
