// core#1043 (crew route): PUT /api/v1/repos/:id/seat-layers turns a repo's seat toolchain layers off or back on through
// the engine's `setRepoSeatLayersOff`. It is a person's choice: a seat's or agent's token is refused 403 before the
// engine is asked. Real adapter entry point over a fake engine method, and the served HTTP contract.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
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
function engineEntry(off: string[]): Record<string, unknown> {
  const ids = [...new Set(off)].sort();
  return {
    id: 'repo',
    name: 'repo',
    root_path: dir,
    default_branch: 'main',
    registered_at: 1764000000,
    graph_key: 'repo',
    code_graph_db: join(dir, 'repo-graphs', 'repo', 'estate.db'),
    findings: [],
    seat_layers: ['node', 'python'].map((id) => ({ id, enabled: !ids.includes(id), off_by: ids.includes(id) ? 'repo' : null })),
    ...(ids.length > 0 ? { seat_layers_off: ids } : {}),
  };
}

/** Core's refusals, word for word (src/repo.rs:424 and src/seat_layers.rs:432-435). */
const LAYERS = ['go', 'java', 'node', 'python', 'rust'];
async function engineSet(repoId: string, offJson: string): Promise<string> {
  if (repoId !== 'repo') throw new Error(`no registered repo \`${repoId}\``);
  const off = JSON.parse(offJson) as string[];
  const bad = off.find((id) => !LAYERS.includes(id));
  if (bad !== undefined) throw new Error(`no seat layer \`${bad}\` (the layers are ${LAYERS.join(', ')})`);
  return JSON.stringify(engineEntry(off));
}

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
