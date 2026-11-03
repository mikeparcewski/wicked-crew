// DES-APPS-001 (K2a): `POST /repos {create: true}` makes a new empty repo under the apps root, registers it
// and starts no onboarding; and `/health` advertises the app store only when the daemon has one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { AuditLog } from '../src/api/audit.js';
import { AppStore } from '../src/apps/store.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function routes(withStore = true) {
  const dir = mkdtempSync(join(tmpdir(), 'repos-create-'));
  dirs.push(dir);
  const repos: RepoEntry[] = [];
  const adapter = {
    listRepos: vi.fn(async () => repos),
    registerRepo: vi.fn(async (name: string, root: string) => {
      const repo = { id: `r-${name}`, name, root_path: root, registered_at: 1, default_branch: 'main' };
      repos.push(repo);
      return repo;
    }),
    launchOnboardingRun: vi.fn(async () => 'run-onboard'),
    ping: vi.fn(async () => 'ok'),
    projectMemberAttach: vi.fn(),
  };
  const store = new AppStore({
    stateFile: join(dir, 'daemon-apps.json'),
    appsRoot: join(dir, 'apps'),
    // The daemon's wiring (server.ts): the registry is the adapter's.
    registry: { register: (name, root) => adapter.registerRepo(name, root), idTaken: async (id) => repos.some((r) => r.id === id) },
  });
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    withStore ? { apps: store } : {},
  );
  apps.push(app);
  return { app, adapter, dir };
}

describe('POST /api/v1/repos {create: true}', () => {
  it('makes <apps root>/<name> with one empty commit on main, registers it, and starts no onboarding', async () => {
    const { app, adapter, dir } = routes();
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'demo', create: true } });
    expect(res.statusCode).toBe(201);
    const root = join(dir, 'apps', 'demo');
    expect(res.json()).toEqual({ repo: expect.objectContaining({ id: 'r-demo', root_path: root }), onboardRunId: null });
    expect(adapter.registerRepo).toHaveBeenCalledExactlyOnceWith('demo', root);
    expect(adapter.launchOnboardingRun).not.toHaveBeenCalled();
    const env = { ...process.env, GIT_DIR: join(root, '.git'), GIT_CONFIG_GLOBAL: '/dev/null' };
    const log = execFileSync('git', ['log', '--format=%T', 'refs/heads/main'], { env }).toString().trim().split('\n');
    expect(log).toEqual(['4b825dc642cb6eb9a060e54bf8d69288fbee4904']); // one commit, the empty tree
  });

  it('refuses a taken name with a suggestion, a reserved one, and create beside a path or URL', async () => {
    const { app } = routes();
    await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'demo', create: true } });
    const taken = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'demo', create: true } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'slug_taken', suggestion: 'demo-2' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'check', create: true } })).json()).toMatchObject({ code: 'reserved_slug' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'x', create: true, rootPath: '/srv/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'x', create: true, gitUrl: 'https://example.invalid/x.git' } })).statusCode).toBe(400);
  });

  it('answers 503 on a route set with no app store', async () => {
    const { app } = routes(false);
    expect((await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'demo', create: true } })).statusCode).toBe(503);
  });
});

describe('GET /api/v1/health: the apps capability', () => {
  it('is present with a store (each later route false until it serves) and absent without one', async () => {
    const withStore = routes();
    const h = await withStore.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(h.statusCode, h.body).toBe(200);
    const caps = h.json().capabilities;
    // Uploads serve since the sources slice (K1, POST /apps/uploads), queries since the executor (K2b); this
    // store has no source stage (the daemon's has: createServer wires it), and the rest are still to come.
    expect(caps.apps).toEqual({ query: true, actions: false, turns: false, publish: false, uploads: true, sourceCheck: false });
    const without = routes(false);
    expect((await without.app.inject({ method: 'GET', url: '/api/v1/health' })).json().capabilities.apps).toBeUndefined();
  });
});
