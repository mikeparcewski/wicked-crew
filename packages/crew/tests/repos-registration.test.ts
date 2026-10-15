// crew#1019: registration survives an onboarding launch refusal; no real clone or daemon.
import Fastify, { type FastifyInstance } from 'fastify';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
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
    cloneAndRegisterRepo: vi.fn<CoreAdapter['cloneAndRegisterRepo']>(async () => { throw new Error('clone failed'); }),
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

  const cloneDestinations: Array<[string | undefined, string]> = [
    ['/srv/alpha/../checkout', '/srv/checkout'],
    ['~/crew-clone', join(homedir(), 'crew-clone')],
    [undefined, join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.wicked', 'repos', 'alpha')],
  ];
  it.each(cloneDestinations)('recovers a registered remote repo after launch fails (destination %s)', async (rootPath, cloneRoot) => {
    const { app, adapter, repos } = routes();
    adapter.cloneAndRegisterRepo.mockImplementation(async () => {
      await adapter.registerRepo('alpha', cloneRoot);
      await adapter.launchOnboardingRun();
      return { repoId: 'r-new', runId: 'unreachable' };
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', ...(rootPath !== undefined ? { rootPath } : {}), projectId: 'p1' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ repo: repos[0], onboardRunId: null, onboardError: launchError });
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos' })).json().repos).toEqual(repos);
    expect(adapter.projectMemberAttach).not.toHaveBeenCalled();
  });

  it.each(['throws', 'missing'])('returns 500 with the registered id when the post-clone lookup %s', async (lookup) => {
    const { app, adapter } = routes();
    adapter.cloneAndRegisterRepo.mockImplementation(async () => {
      if (lookup === 'throws') adapter.listRepos.mockRejectedValueOnce(new Error('registry unreadable'));
      else adapter.listRepos.mockResolvedValueOnce([]);
      return { repoId: 'r-landed', runId: 'onboard-1' };
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Repo registered but could not be retrieved', repoId: 'r-landed' });
    expect(adapter.projectMemberAttach).not.toHaveBeenCalled();
  });

  it('normalizes the default clone destination before a failed realpath lookup', async () => {
    const { app, adapter, repos } = routes();
    const previousHome = process.env.HOME;
    const temporaryHome = mkdtempSync(join(tmpdir(), 'repo-home-'));
    process.env.HOME = relative(process.cwd(), temporaryHome);
    try {
      adapter.cloneAndRegisterRepo.mockImplementation(async () => {
        await adapter.registerRepo('alpha', join(temporaryHome, '.wicked', 'repos', 'alpha'));
        throw new Error(launchError);
      });
      const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git' } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ repo: repos[0], onboardRunId: null, onboardError: launchError });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  it('matches the registered canonical root when a remote destination is a symlink', async () => {
    const base = mkdtempSync(join(tmpdir(), 'repo-register-'));
    try {
      const actual = join(base, 'actual');
      const destination = join(base, 'checkout');
      mkdirSync(actual);
      symlinkSync(actual, destination, 'dir');
      const { app, adapter, repos } = routes();
      adapter.cloneAndRegisterRepo.mockImplementation(async () => {
        await adapter.registerRepo('alpha', realpathSync(actual));
        throw new Error(launchError);
      });
      const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', rootPath: destination } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ repo: repos[0], onboardRunId: null, onboardError: launchError });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each(['no registration', 'same name elsewhere', 'different name at root', 'same name at same root'])('keeps a remote clone failure a 400 with %s', async (existing) => {
    const { app, repos } = routes();
    if (existing !== 'no registration') repos.push({ id: 'other', name: existing.startsWith('same name') ? 'alpha' : 'beta', root_path: existing === 'same name elsewhere' ? '/srv/other' : '/srv/alpha', default_branch: 'main', registered_at: 1 });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'alpha', gitUrl: 'https://example.invalid/alpha.git', rootPath: '/srv/alpha' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'clone failed' });
  });
});
