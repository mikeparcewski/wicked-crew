// core#1043 (crew route): PUT /api/v1/repos/:id/seat-layers turns a repo's seat toolchain layers off or back on through
// the engine's `setRepoSeatLayersOff`. It is a person's choice: a seat's or agent's token is refused 403 before the
// engine is asked. Real adapter entry point over a fake engine method, and the served HTTP contract.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, RepoEntry } from '../src/core/types.js';
import { registerAuthHooks } from '../src/api/auth.js';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-seat-layers-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  core = (adapter as unknown as { core: Record<string, unknown> }).core;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  adapter.close();
  removeScratch(dir);
});

/**
 * The engine's reply, as wicked-core writes it: `RepoEntry` (core src/repo.rs:38-95, serde) with `seat_layers` rows
 * from `seat_layers::rows` (core src/seat_layers.rs:382-408: detected layers in catalog order, `off_by` `repo` for a
 * layer this repo turned off) and `seat_layers_off` sorted and deduplicated (`set_seat_layers_off`, src/repo.rs:417-441;
 * skipped on the wire when empty). `root_path` is the scratch dir, so crew adds no folder-missing finding.
 */
function engineEntry(off: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const ids = [...new Set(off)].sort();
  return {
    id: 'repo',
    name: 'repo',
    root_path: dir,
    ...over,
    default_branch: 'main',
    registered_at: 1764000000,
    graph_key: 'repo',
    code_graph_db: join(dir, 'repo-graphs', 'repo', 'estate.db'),
    findings: [],
    seat_layers: ['node', 'python'].map((id) => ({ id, enabled: !ids.includes(id), off_by: ids.includes(id) ? 'repo' : null })),
    ...(ids.length > 0 ? { seat_layers_off: ids } : {}),
  };
}

/** Core's refusals, word for word: src/repo.rs:424 `no registered repo \`{repo_id}\``, and src/seat_layers.rs:432-435
 *  `no seat layer \`{id}\` (the layers are {catalog joined by ", "})`; napi passes each as `e.to_string()`
 *  (crates/wicked-core-ts/src/lib.rs:77-79). */
const LAYERS = ['go', 'java', 'node', 'python', 'rust'];
function engineSetOver(over: Record<string, unknown>) {
  return async (repoId: string, offJson: string): Promise<string> => {
    if (repoId !== 'repo') throw new Error(`no registered repo \`${repoId}\``);
    const off = JSON.parse(offJson) as string[];
    const bad = off.find((id) => !LAYERS.includes(id));
    if (bad !== undefined) throw new Error(`no seat layer \`${bad}\` (the layers are ${LAYERS.join(', ')})`);
    return JSON.stringify(engineEntry(off, over));
  };
}
const engineSet = engineSetOver({});

async function serve() {
  const repos = (): RepoEntry[] => [engineEntry([]) as unknown as RepoEntry];
  adapter.listRepos = async () => repos();
  adapter.sessionsDetail = vi.fn(async () => []);
  const set = vi.fn(engineSet);
  core['setRepoSeatLayersOff'] = set;
  const audit = AuditLog.noop();
  const record = vi.spyOn(audit, 'record');
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    const named = req.headers['x-test-actor'];
    if (typeof named === 'string') {
      const [kind, trust] = named.split('/');
      (req as unknown as { actor: unknown }).actor = { id: `test-${kind}`, kind, trust };
    }
  });
  registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
  await app.ready();
  const put = (payload: unknown, actor = 'human/operator', id = 'repo') =>
    app!.inject({ method: 'PUT', url: `/api/v1/repos/${id}/seat-layers`, headers: { 'x-test-actor': actor }, payload: payload as object });
  return { put, set, record };
}

describe('PUT /repos/:id/seat-layers (core#1043)', () => {
  // A seat's token is an agent actor (chat-proposals.ts and server.ts audit seats as `agent/observer`); an agent at
  // operator trust and a person below operator are refused the same way.
  it.each(['agent/observer', 'agent/operator', 'agent/admin', 'system/admin', 'human/observer'])(
    'refuses %s 403 human_operator_only, and the engine is never asked',
    async (actor) => {
      const { put, set, record } = await serve();
      const res = await put({ off: ['node'] }, actor);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'human_operator_only' });
      expect(set).not.toHaveBeenCalled();
      expect(record.mock.calls.filter(([what]) => what === 'repo.seat_layers.set')).toHaveLength(0);
    },
  );

  it('a person turns a layer off: the engine gets the ids, the reply is the repo row, and it is audited', async () => {
    const { put, set, record } = await serve();
    const res = await put({ off: ['python', 'node', 'node'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(set).toHaveBeenCalledWith('repo', JSON.stringify(['python', 'node', 'node']));
    const body = res.json() as RepoEntry & { seat_layers: unknown[]; seat_layers_off: string[] };
    expect(body.id).toBe('repo');
    expect(body.seat_layers).toEqual([
      { id: 'node', enabled: false, off_by: 'repo' },
      { id: 'python', enabled: false, off_by: 'repo' },
    ]);
    expect(body.seat_layers_off).toEqual(['node', 'python']);
    const lines = record.mock.calls.filter(([what]) => what === 'repo.seat_layers.set');
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toMatchObject({ kind: 'human', trust: 'operator' });
    expect(lines[0]![2]).toEqual({ detail: { repoId: 'repo', off: ['node', 'python'] } });
  });

  it('an empty list turns every layer back on', async () => {
    const { put, set } = await serve();
    const res = await put({ off: [] }, 'human/admin');
    expect(res.statusCode, res.body).toBe(200);
    expect(set).toHaveBeenCalledWith('repo', '[]');
    expect(res.json()).toMatchObject({ seat_layers: [{ id: 'node', enabled: true, off_by: null }, { id: 'python', enabled: true, off_by: null }] });
    expect(res.json()).not.toHaveProperty('seat_layers_off');
  });

  it('a layer the engine does not have is 400, naming it and the layers there are', async () => {
    const { put, record } = await serve();
    const res = await put({ off: ['node', 'cobol'] });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ code: 'unknown_seat_layer', error: 'no seat layer `cobol` (the layers are go, java, node, python, rust)' });
    expect(record.mock.calls.filter(([what]) => what === 'repo.seat_layers.set')).toHaveLength(0);
  });

  it('an unknown repo is 404 before the engine is asked, and 404 when the engine no longer has it', async () => {
    const { put, set } = await serve();
    const res = await put({ off: [] }, 'human/operator', 'elsewhere');
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ code: 'repo_not_found' });
    expect(set).not.toHaveBeenCalled();
    // Removed between crew's check and the engine's write.
    set.mockImplementationOnce(async () => { throw new Error('no registered repo `repo`'); });
    const gone = await put({ off: [] });
    expect(gone.statusCode, gone.body).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'repo_not_found' });
  });

  it.each([
    ['no body field', {}],
    ['a string, not a list', { off: 'node' }],
    ['a blank id', { off: [' '] }],
    ['a comma list in one id', { off: ['node,python'] }],
    ['an id over 32 characters', { off: ['x'.repeat(33)] }],
    ['more than 32 ids', { off: Array.from({ length: 33 }, () => 'node') }],
    ['an extra field', { off: [], repo: 'other' }],
  ])('refuses %s 400 before the engine is asked', async (_why, payload) => {
    const { put, set } = await serve();
    const res = await put(payload);
    expect(res.statusCode, res.body).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it('an engine without setRepoSeatLayersOff is 501', async () => {
    const { put } = await serve();
    core['setRepoSeatLayersOff'] = undefined;
    const res = await put({ off: ['node'] });
    expect(res.statusCode, res.body).toBe(501);
    expect(res.json()).toMatchObject({ code: 'repo_seat_layers_unsupported' });
  });

  it('GET /repos carries the engine rows unchanged', async () => {
    await serve();
    const res = await app!.inject({ method: 'GET', url: '/api/v1/repos' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().repos[0].seat_layers).toEqual([{ id: 'node', enabled: true, off_by: null }, { id: 'python', enabled: true, off_by: null }]);
  });
});

describe('PUT /repos/:id/seat-layers: the row is the one GET /repos shows (core#1043, round 1)', () => {
  // The engine's own list read and its setter reply, for a checkout that is gone and a remote recorded with a login.
  const GIT_URL = 'https://someone:hunter2@example.invalid/org/repo.git'; // ggignore: a made-up test login, not a secret
  it('a missing checkout keeps its finding and the remote is shown without its login, as on GET /repos', async () => {
    const shape = { root_path: join(dir, 'gone'), git_url: GIT_URL };
    core['listRepos'] = async () => JSON.stringify([engineEntry([], shape)]);
    core['setRepoSeatLayersOff'] = vi.fn(engineSetOver(shape));
    adapter.sessionsDetail = vi.fn(async () => []);
    app = Fastify({ logger: false });
    registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), undefined, { audit: AuditLog.noop(), authMode: 'off' });
    await app.ready();
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/repos' })).json().repos[0] as Record<string, unknown>;
    const res = await app.inject({ method: 'PUT', url: '/api/v1/repos/repo/seat-layers', payload: { off: ['node'] } });
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json() as Record<string, unknown>;
    expect(row['findings']).toEqual([expect.objectContaining({ code: 'repo_folder_missing' })]);
    expect(row['git_url']).toBe('https://example.invalid/org/repo.git');
    const without = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'seat_layers' && k !== 'seat_layers_off'));
    expect(without(row)).toEqual(without(listed));
  });
});

describe('PUT /repos/:id/seat-layers behind the real auth boundary (core#1043, round 1)', () => {
  // auth.ts registerAuthHooks in `required` mode, with the actors tokens.json grants (auth.ts:150-170): a seat's
  // token is an `agent` actor at whatever trust its entry names.
  const TOKENS: Record<string, Actor> = {
    'seat-observer': { id: 'seat:claude', kind: 'agent', trust: 'observer' } as Actor,
    'seat-operator': { id: 'seat:codex', kind: 'agent', trust: 'operator' } as Actor,
    person: { id: 'maria', kind: 'human', trust: 'operator' } as Actor,
  };
  async function guarded() {
    const list = vi.fn(async () => [engineEntry([]) as unknown as RepoEntry]);
    adapter.listRepos = list;
    adapter.sessionsDetail = vi.fn(async () => []);
    const set = vi.fn(engineSet);
    core['setRepoSeatLayersOff'] = set;
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), undefined, { audit: AuditLog.noop(), authMode: 'required' });
    await app.ready();
    const put = (token: string, payload: unknown = { off: ['node'] }, id = 'repo') =>
      app!.inject({ method: 'PUT', url: `/api/v1/repos/${id}/seat-layers`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
    return { put, set, list };
  }

  it.each([
    ['a seat token at operator trust', 'seat-operator', { off: ['node'] }, 'repo'],
    ['a seat token, with a malformed body', 'seat-operator', { off: 'node' }, 'repo'],
    ['a seat token, for an unknown repo', 'seat-operator', { off: [] }, 'elsewhere'],
  ])('%s: 403 human_operator_only, and nothing is read or written', async (_why, token, payload, id) => {
    const { put, set, list } = await guarded();
    const res = await put(token, payload, id);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'human_operator_only' });
    expect(list).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('a seat token at observer trust is refused by the daemon\'s trust check, before the route', async () => {
    const { put, set, list } = await guarded();
    const res = await put('seat-observer');
    expect(res.statusCode, res.body).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('no token is 401, and a person\'s token changes the layers', async () => {
    const { put, set } = await guarded();
    expect((await app!.inject({ method: 'PUT', url: '/api/v1/repos/repo/seat-layers', payload: { off: ['node'] } })).statusCode).toBe(401);
    expect(set).not.toHaveBeenCalled();
    const res = await put('person');
    expect(res.statusCode, res.body).toBe(200);
    expect(set).toHaveBeenCalledWith('repo', '["node"]');
  });
});
