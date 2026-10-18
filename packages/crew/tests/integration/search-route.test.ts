// `GET /api/v1/search` at the route: the request contract (400s), the grouped answer through the
// real route set (registerRoutes with a stubbed estate client — no process is spawned), a write that
// keeps the index current through the onResponse hook, and the daemon's frame fan-in feeding the
// index (createServer over a fake adapter whose frames this test emits).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../../src/api/routes.js';
import { createServer } from '../../src/api/server.js';
import { GateCache } from '../../src/api/gate-cache.js';
import { ElicitationCache } from '../../src/api/elicitation-cache.js';
import { crewStateHome, setCrewStateHome } from '../../src/projects/state-home.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { CoreEvent, SearchResponse, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const armedStateHome = crewStateHome();

function view(id: string, problem: string): SessionView {
  return { session: { id, problem, status: 'completed', workflow_id: null, repo_ref: null, archived_at: null }, units: [] } as unknown as SessionView;
}

async function waitFor(pred: () => Promise<boolean>, label: string, ms = 6_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('GET /api/v1/search — the route set', () => {
  let app: FastifyInstance;
  const repos = [{ id: 'repo-1', name: 'upload-api', root_path: '/src/upload-api', default_branch: 'main', registered_at: 1 }];
  const estate = vi.fn(async (tool: string) => {
    if (tool === 'memory.list') return { items: [{ memory_id: 'm1', scope: '', content: 'uploads stream to the bucket', tier: 'semantic', facets: {}, created_at: 1 }] };
    throw new Error(`unexpected ${tool}`);
  });

  beforeAll(async () => {
    const adapter = {
      sessionsDetail: vi.fn(async () => [view('r-up', 'add rate-limiting to the upload endpoint')]),
      workOutput: vi.fn(async () => null),
      listRepos: vi.fn(async () => repos),
      projectList: vi.fn(async () => []),
      listConformanceRules: vi.fn(async () => []),
      // `POST /repos` registers through the adapter; the onResponse hook then re-reads repos.
      registerRepo: vi.fn(async (name: string, rootPath: string) => {
        const r = { id: `repo-${repos.length + 1}`, name, root_path: rootPath, default_branch: 'main', registered_at: 2 };
        repos.push(r);
        return r;
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
      callEstateTool: estate as unknown as (t: string, a: Record<string, unknown>) => Promise<unknown>,
    });
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it.each([
    ['no q', '', 'at least 2'],
    ['a one-letter q', '?q=a', 'at least 2'],
    ['a q of quotes only', '?q=%22%22', 'characters of words'],
    ['a q of spaces only', '?q=%20%20%20', 'at least 2'],
    ['a 257-char q', `?q=${'x'.repeat(257)}`, 'longer than 256'],
    ['an unknown type', '?q=upload&types=run,widgets', '`types`'],
    ['limit 0', '?q=upload&limit=0', '`limit`'],
    ['limit 51', '?q=upload&limit=51', '`limit`'],
    ['a cursor over several types', '?q=upload&cursor=5', 'exactly one'],
    ['a negative cursor', '?q=upload&types=run&cursor=-1', 'cursor'],
  ])('400 for %s', async (_label, qs, words) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/search${qs}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(words);
  });

  it('answers grouped hits with a source row per asked type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=upload&types=run,repo,memory,doc' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.query).toBe('upload');
    expect(body.groups.map((g) => [g.type, g.hits[0]?.id])).toEqual([['run', 'r-up'], ['repo', 'repo-1'], ['memory', 'm1']]);
    expect(body.sources.map((s) => s.type)).toEqual(['run', 'repo', 'memory', 'doc']);
    expect(body.sources.find((s) => s.type === 'memory')!.state).toBe('ready');
    expect(estate).toHaveBeenCalledWith('memory.list', {});
    expect(typeof body.took_ms).toBe('number');
  });

  it('pages one type with its cursor', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/v1/search?q=upload&types=repo&limit=1' })).json() as SearchResponse;
    expect(first.groups[0]!.next_cursor === null || typeof first.groups[0]!.next_cursor === 'string').toBe(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=upload&types=repo&limit=1&cursor=0' });
    expect(res.statusCode).toBe(200);
  });

  it('a successful write re-reads what it changed (POST /repos → the new repo is found)', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'search-svc', rootPath: '/src/search-svc' } });
    expect(reg.statusCode).toBeLessThan(400);
    await waitFor(async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/v1/search?q=search-svc&types=repo' })).json() as SearchResponse;
      return body.groups[0]?.hits[0]?.title === 'search-svc';
    }, 'the registered repo');
  });
});

describe('GET /api/v1/search — the daemon fan-in keeps it current', () => {
  let scratch: string;
  let app: FastifyInstance;
  let emit: (frame: CoreEvent) => void;
  const runs: SessionView[] = [view('r-one', 'migrate the auth tables')];

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'search-route-server-'));
    const home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);
    const listeners = new Set<(e: CoreEvent) => void>();
    emit = (frame) => { for (const l of listeners) l(frame); };
    const adapter = {
      dbPath: join(home, 'core.db'),
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (l: (e: CoreEvent) => void): (() => void) => { listeners.add(l); return () => listeners.delete(l); },
      listRepos: async () => [],
      sessionsDetail: async () => runs,
      workOutput: async () => null,
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter;
    app = await createServer(adapter, {
      auth: { mode: 'off' },
      seats: { signedIn: () => true },
      auditPath: join(scratch, 'audit.log'),
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    });
    await app.ready();
  }, 150_000);

  afterAll(async () => {
    await app.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  it('a run started after the first search is found once its frame arrives', async () => {
    const q = async (text: string): Promise<SearchResponse> =>
      (await app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(text)}&types=run` })).json() as SearchResponse;
    expect((await q('auth tables')).groups[0]!.hits[0]!.id).toBe('r-one');
    runs.push(view('r-two', 'ship the global search modal'));
    emit({ type: 'sessionStarted', session: 'r-two', problem: 'ship the global search modal' } as unknown as CoreEvent);
    await waitFor(async () => (await q('search modal')).groups[0]?.hits[0]?.id === 'r-two', 'the new run');
  });
});
