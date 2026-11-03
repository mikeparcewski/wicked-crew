// DES-APPS-001 §6.4, §7.6, §9.1 (K2a): the app store and its routes, over real git repos in a temp dir.
// Every acceptance item of the slice is a test here: stale edit/undo/restore → 409; an edit during a turn →
// 409 turn_in_flight; a rejected tree cannot be restored; the query route refuses an unreceipted tree; an
// agent-kind operator token cannot post an edit; two concurrent undos move the pointer once.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isUnitTokenRoute, registerAuthHooks, requiredTrust } from '../src/api/auth.js';
import { refuseRequest } from '../src/api/origin-guard.js';
import type { AppSourceStage, AppSourceStageInput } from '../src/apps/check.js';
import { AppGit, gitVersionProblem } from '../src/apps/git.js';
import { registerAppRoutes } from '../src/apps/routes.js';
import { AppStore, type AppRepoRegistry, type AppTurnLauncher } from '../src/apps/store.js';
import type { Actor, AppDetail, AppSpec } from '../src/core/types.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HUMAN: Actor = { id: 'priya', kind: 'human', trust: 'operator' };
const AGENT: Actor = { id: 'seat-codex', kind: 'agent', trust: 'operator' };
const OBSERVER: Actor = { id: 'sam', kind: 'human', trust: 'observer' };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: join(root, '.git'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    .toString('utf8')
    .trim();
}

/** A fake source stage: every checked query and action gets a contract hash; it records what it was asked. */
function fakeStage(): AppSourceStage & { calls: AppSourceStageInput[] } {
  const calls: AppSourceStageInput[] = [];
  return {
    calls,
    async check(input) {
      calls.push(input);
      const used = new Set([...input.spec.queries.filter((q) => input.queries.includes(q.id)).map((q) => q.source), ...input.spec.actions.filter((a) => input.actions.includes(a.id)).map((a) => a.source)]);
      return {
        findings: [],
        sources: Object.fromEntries([...used].map((s) => [s, { kind: 'sql', descriptor: { driver: 'postgres', host: 'db.example' }, descriptorHash: `d-${s}` }])),
        queries: Object.fromEntries(input.queries.map((q) => [q, `c-${q}`])),
        actions: Object.fromEntries(input.actions.map((a) => [a, `c-${a}`])),
        uploads: {},
      };
    },
  };
}

/** A fake repo registry keyed like core's (the slug is the id). */
function fakeRegistry(fail: () => boolean = () => false) {
  const repos = new Map<string, string>();
  const registry: AppRepoRegistry = {
    register: async (name, root) => {
      if (fail()) throw new Error('the engine refused the registration');
      repos.set(name, root);
      return { id: name, name, root_path: root, registered_at: 1, default_branch: 'main' };
    },
    idTaken: async (id) => repos.has(id),
  };
  return { registry, repos };
}

function setup(opts: { auth?: boolean; stage?: AppSourceStage | null; turns?: AppTurnLauncher | null; failRegister?: () => boolean; verifyUnitToken?: (t: string) => Promise<{ runId: string } | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apps-store-'));
  dirs.push(dir);
  const reg = fakeRegistry(opts.failRegister);
  const store = new AppStore({ stateFile: join(dir, 'daemon-apps.json'), appsRoot: join(dir, 'apps'), registry: reg.registry, sourceStage: opts.stage ?? null, turns: opts.turns ?? null });
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokens: Record<string, Actor> = { human: HUMAN, agent: AGENT, observer: OBSERVER, plugin: { id: 'plugin:x@1', kind: 'plugin', trust: 'observer' } };
  if (opts.auth === true) registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => tokens[t] ?? null }], allowedOrigins: null });
  const audit = { record: vi.fn() };
  registerAppRoutes(app, { store, audit, ...(opts.verifyUnitToken !== undefined ? { verifyUnitToken: opts.verifyUnitToken } : {}) });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}), ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & { app: AppDetail; code?: string } };
  };
  return { dir, store, app, call, audit, repos: reg.repos };
}

const textSpec = (name: string, text: string): AppSpec => ({
  schema: 'wicked.apps/v1',
  name,
  pages: [{ id: 'page-1', title: 'Page 1', components: [{ id: 'note', type: 'text', box: { x: 0, y: 0, w: 4, h: 1 }, text }] }],
  queries: [],
  actions: [],
  linkHosts: [],
});

const dataSpec = (text: string): AppSpec => ({
  ...textSpec('Escalations', text),
  queries: [{ id: 'open_count', source: 'support-pg', kind: 'sql', output: [{ name: 'open', type: 'integer' }] }],
});

async function newApp(s: ReturnType<typeof setup>, slug = 'escalations', token?: string): Promise<AppDetail> {
  const res = await s.call('POST', '/apps', { slug, projectId: 'p1' }, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.app;
}

async function edit(s: ReturnType<typeof setup>, slug: string, base: number, text: string, token?: string) {
  return s.call('POST', `/apps/${slug}/edits`, { base, ops: [{ op: 'spec', spec: textSpec('Escalations', text) }] }, token);
}

describe('apps: create, read, edit', () => {
  it("adds an app as a repo with crew's first version, accepted when a person made it", async () => {
    const s = setup();
    const a = await newApp(s);
    expect(a.head).toEqual({ version: 1, tree: a.versions[0]!.tree, receipt: 'you' });
    expect(a.history).toEqual({ states: [1], pointer: 0, canUndo: false, canRedo: false });
    expect(a.spec.pages).toHaveLength(1);
    expect(a.lock).toEqual({ schema: 'wicked.apps.lock/v1', sources: {}, queries: {}, actions: {}, uploads: {} });
    const root = join(s.dir, 'apps', 'escalations');
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(a.versions[0]!.commit);
    expect(git(root, 'cat-file', '-p', `${a.versions[0]!.commit}:apps.json`)).toContain('"wicked.apps/v1"');
    expect(s.audit.record).toHaveBeenCalledWith('apps.app.created', expect.objectContaining({ id: 'local' }), expect.anything());
  });

  it('refuses a reserved slug and a taken one, with a suggestion', async () => {
    const s = setup();
    await newApp(s);
    expect((await s.call('POST', '/apps', { slug: 'check', projectId: 'p1' })).body).toMatchObject({ code: 'reserved_slug' });
    expect((await s.call('POST', '/apps', { slug: 'uploads', projectId: 'p1' })).status).toBe(422);
    const taken = await s.call('POST', '/apps', { slug: 'escalations', projectId: 'p1' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'slug_taken', suggestion: 'escalations-2' });
  });

  it('lands an edit as a `you` version; a stale base is 409 with the head', async () => {
    const s = setup();
    await newApp(s);
    const v2 = await edit(s, 'escalations', 1, 'hello');
    expect(v2.status).toBe(200);
    expect(v2.body['landed']).toMatchObject({ version: 2, base: 1, author: { kind: 'human', id: 'local' }, receipt: { kind: 'you', version: 2 }, check: { level: 'spec', checked: [] } });
    const stale = await edit(s, 'escalations', 1, 'from another tab');
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stale_base', head: 2 });
    expect((await s.call('GET', '/apps/escalations')).body.app.versions).toHaveLength(2);
  });

  it('refuses a spec crew cannot accept with its findings, and lands nothing', async () => {
    const s = setup();
    await newApp(s);
    const bad = textSpec('x', 'y');
    (bad.pages[0]!.components[0] as { box: { x: number } }).box.x = 11;
    const res = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: bad }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'check_failed', findings: [expect.objectContaining({ code: 'schema', path: '$.ops[0].spec.pages[0].components[0].box.w' })] });
    // An over-long list is refused by the structure bound before the schema walks it.
    const huge = { ...textSpec('x', 'y'), queries: Array.from({ length: 50_000 }, () => ({})) };
    const r1 = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: huge }] });
    expect(r1.body).toMatchObject({ code: 'check_failed', findings: [expect.objectContaining({ code: 'too_complex' })] });
    const dangling = textSpec('x', 'y');
    dangling.pages[0]!.components.push({ id: 'k', type: 'kpi', box: { x: 4, y: 0, w: 2, h: 1 }, data: { query: 'nope' }, value: 'v' });
    const r2 = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dangling }] });
    expect(r2.status).toBe(422);
    expect(r2.body).toMatchObject({ code: 'check_failed', findings: [expect.objectContaining({ code: 'unknown_query' })] });
    expect((await s.call('GET', '/apps/escalations')).body.app.head.version).toBe(1);
  });

  it('re-points main when something else moved it, and lands on crew’s head', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const empty = git(root, 'rev-parse', `${a.versions[0]!.commit}^`);
    git(root, 'update-ref', 'refs/heads/main', empty);
    const v2 = await edit(s, 'escalations', 1, 'hello');
    expect(v2.status).toBe(200);
    const landed = v2.body['landed'] as { commit: string };
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(landed.commit);
    expect(git(root, 'rev-parse', `${landed.commit}^`)).toBe(a.versions[0]!.commit);
  });
});

describe('apps: undo, redo and restore move within accepted history', () => {
  it('undo lands the earlier tree as a restored version; redo returns; both refuse a stale base', async () => {
    const s = setup();
    const a = await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    const undo = await s.call('POST', '/apps/escalations/undo', { base: 2 });
    expect(undo.status).toBe(200);
    expect(undo.body['landed']).toMatchObject({ version: 3, tree: a.versions[0]!.tree, receipt: { kind: 'restored', restoredFrom: { version: 1, originKind: 'you', originVersion: 1 } }, check: { level: 'full' } });
    expect(undo.body.app.history).toEqual({ states: [1, 2], pointer: 0, canUndo: false, canRedo: true });
    expect((await s.call('POST', '/apps/escalations/undo', { base: 3 })).body).toMatchObject({ code: 'nothing_to_undo' });
    expect((await s.call('POST', '/apps/escalations/redo', { base: 2 })).body).toMatchObject({ code: 'stale_base', head: 3 });
    const redo = await s.call('POST', '/apps/escalations/redo', { base: 3 });
    expect(redo.body['landed']).toMatchObject({ version: 4, receipt: { kind: 'restored', restoredFrom: { version: 2 } } });
    expect(redo.body.app.history.pointer).toBe(1);
    expect((await s.call('POST', '/apps/escalations/redo', { base: 4 })).body).toMatchObject({ code: 'nothing_to_redo' });
    expect((await s.call('POST', '/apps/escalations/undo', { base: 3 })).body).toMatchObject({ code: 'stale_base', head: 4 });
  });

  it('a new edit after an undo clears the redo side', async () => {
    const s = setup();
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    await s.call('POST', '/apps/escalations/undo', { base: 2 });
    const v4 = await edit(s, 'escalations', 3, 'four');
    expect(v4.body.app.history).toEqual({ states: [1, 4], pointer: 1, canUndo: true, canRedo: false });
  });

  it('two concurrent undos on the same base move the pointer once', async () => {
    const s = setup();
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    await edit(s, 'escalations', 2, 'three');
    const [x, y] = await Promise.all([s.call('POST', '/apps/escalations/undo', { base: 3 }), s.call('POST', '/apps/escalations/undo', { base: 3 })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x.body.code, y.body.code]).toContain('stale_base');
    const after = (await s.call('GET', '/apps/escalations')).body.app;
    expect(after.history).toMatchObject({ states: [1, 2, 3], pointer: 1 });
    expect(after.versions).toHaveLength(4);
  });

  it('restores an accepted version; refuses a stale base and a tree with no accepted receipt (a rejected turn)', async () => {
    const s = setup();
    const a = await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    // A rejected turn's tree: a builder's commit on the run branch that never got a receipt.
    const root = join(s.dir, 'apps', 'escalations');
    const spec = textSpec('Escalations', 'agent wrote this');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: JSON.stringify(spec), env: { ...process.env, GIT_DIR: join(root, '.git') } }).toString().trim();
    const tree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob}\tapps.json\n`, env: { ...process.env, GIT_DIR: join(root, '.git') } }).toString().trim();
    const rejected = git(root, 'commit-tree', tree, '-p', git(root, 'rev-parse', 'refs/heads/main'), '-m', 'builder');
    git(root, 'update-ref', 'refs/heads/wicked/run-1', rejected);
    const refused = await s.call('POST', '/apps/escalations/restore', { base: 2, version: rejected });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'not_accepted' });
    expect((await s.call('POST', '/apps/escalations/restore', { base: 1, version: 1 })).body).toMatchObject({ code: 'stale_base', head: 2 });
    expect((await s.call('POST', '/apps/escalations/restore', { base: 2, version: 9 })).status).toBe(404);
    const ok = await s.call('POST', '/apps/escalations/restore', { base: 2, version: a.versions[0]!.commit });
    expect(ok.body['landed']).toMatchObject({ version: 3, tree: a.versions[0]!.tree, receipt: { kind: 'restored', restoredFrom: { version: 1, originKind: 'you' } } });
    expect(ok.body.app.history).toEqual({ states: [1, 2, 3], pointer: 2, canUndo: true, canRedo: false });
  });

  it("an agent-made app's first version holds no receipt: it cannot be restored or queried", async () => {
    const s = setup({ auth: true });
    const a = await newApp(s, 'bot-app', 'agent');
    expect(a.head.receipt).toBeNull();
    expect(a.history).toEqual({ states: [], pointer: -1, canUndo: false, canRedo: false });
    expect((await s.call('POST', '/apps/bot-app/edits', { base: 1, ops: [{ op: 'spec', spec: textSpec('b', 'c') }] }, 'human')).status).toBe(200);
    expect((await s.call('POST', '/apps/bot-app/restore', { base: 2, version: 1 }, 'human')).body).toMatchObject({ code: 'not_accepted' });
    expect((await s.call('POST', '/apps/bot-app/undo', { base: 2 }, 'human')).body).toMatchObject({ code: 'nothing_to_undo' });
  });
});

describe('apps: human-only routes', () => {
  it('an agent-kind operator token cannot edit, undo, redo, restore, grant, run or publish; a person can', async () => {
    const s = setup({ auth: true });
    await newApp(s, 'escalations', 'human');
    for (const [url, body] of [
      ['/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: textSpec('a', 'b') }] }],
      ['/apps/escalations/undo', { base: 1 }],
      ['/apps/escalations/redo', { base: 1 }],
      ['/apps/escalations/restore', { base: 1, version: 1 }],
      ['/apps/escalations/actions/assign/prepare', {}],
      ['/apps/escalations/actions/assign/run', {}],
      ['/apps/escalations/actions/assign/grant', {}],
      ['/apps/escalations/publish', {}],
    ] as const) {
      const res = await s.call('POST', url, body, 'agent');
      expect(res.status, url).toBe(403);
      expect(res.body.code, url).toBe('human_only');
    }
    expect((await s.call('GET', '/apps/escalations', undefined, 'agent')).body.app.versions).toHaveLength(1);
    expect((await edit(s, 'escalations', 1, 'by a person', 'human')).status).toBe(200);
    // The write path is a later slice: a person gets 501 and nothing happens.
    expect((await s.call('POST', '/apps/escalations/actions/assign/prepare', {}, 'human')).status).toBe(501);
    // An observer may read and query, never add an app.
    expect((await s.call('POST', '/apps', { slug: 'mine', projectId: 'p1' }, 'observer')).status).toBe(403);
    expect((await s.call('GET', '/apps', undefined, 'observer')).body['apps']).toHaveLength(1);
  });

  it('ranks the query route as a read and exempts only the check route from the bearer', () => {
    expect(requiredTrust('POST', '/api/v1/apps/escalations/query', {})).toBe('observer');
    expect(requiredTrust('POST', '/api/v1/apps/escalations/edits', {})).toBe('operator');
    expect(isUnitTokenRoute('POST', '/api/v1/apps/check')).toBe(true);
    expect(isUnitTokenRoute('POST', '/api/v1/apps/escalations/edits')).toBe(false);
  });
});

describe('apps: the query route runs only accepted trees', () => {
  it('refuses an unreceipted tree and another app’s commit; finds the query; then 501 until the executor', async () => {
    const stage = fakeStage();
    const s = setup({ stage, auth: true });
    await newApp(s, 'escalations', 'human');
    const v2 = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select count(*) as open from support.tickets' }] }, 'human');
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    const root = join(s.dir, 'apps', 'escalations');
    const head = git(root, 'rev-parse', 'refs/heads/main');
    const unreceipted = git(root, 'commit-tree', git(root, 'rev-parse', `${head}^{tree}`), '-p', head, '-m', 'same tree, no receipt');
    // Same tree as v2: a receipt is per (app, tree), so it IS accepted.
    expect((await s.call('POST', '/apps/escalations/query', { version: unreceipted, query: 'open_count' }, 'observer')).status).toBe(501);
    // A tree no receipt covers is refused before anything else.
    const emptyTree = execFileSync('git', ['mktree'], { input: '', env: { ...process.env, GIT_DIR: join(root, '.git') } }).toString().trim();
    const other = git(root, 'commit-tree', emptyTree, '-p', head, '-m', 'empty tree');
    const refused = await s.call('POST', '/apps/escalations/query', { version: other, query: 'open_count' }, 'observer');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'not_accepted' });
    expect((await s.call('POST', '/apps/escalations/query', { version: 2, query: 'missing' }, 'observer')).body).toMatchObject({ code: 'unknown_query' });
    expect((await s.call('POST', '/apps/escalations/query', { version: 2, query: 'open_count' }, 'observer')).body).toMatchObject({ code: 'not_implemented' });
    // App B's accepted commit is no version of app A (S7, crew side)…
    const b = await newApp(s, 'other', 'human');
    expect((await s.call('POST', '/apps/escalations/query', { version: b.versions[0]!.commit, query: 'open_count' }, 'observer')).body).toMatchObject({ code: 'unknown_version' });
    // …and when B's objects ARE readable from A (an alternates file an agent wrote), B's accepted tree is
    // still not accepted in A: receipts are per (app, tree) (codex r1 on the store).
    writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'), `${join(s.dir, 'apps', 'other', '.git', 'objects')}\n`);
    expect((await s.call('POST', '/apps/escalations/query', { version: b.versions[0]!.commit, query: 'open_count' }, 'observer')).body).toMatchObject({ code: 'not_accepted' });
    expect((await s.call('POST', '/apps/escalations/restore', { base: 2, version: b.versions[0]!.commit }, 'human')).body).toMatchObject({ code: 'not_accepted' });
  });
});

describe('apps: staged checks and the lock', () => {
  it('a data change cannot land without the source stage; with it, the lock pins text and contract', async () => {
    const none = setup();
    await newApp(none);
    const refused = await none.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }] });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'source_check_unavailable' });

    const stage = fakeStage();
    const s = setup({ stage });
    await newApp(s);
    const v2 = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }] });
    expect(v2.body['landed']).toMatchObject({ check: { level: 'data', checked: ['open_count'] } });
    expect(v2.body.app.lock.queries['open_count']).toMatchObject({ source: 'support-pg', contractHash: 'c-open_count' });
    expect(v2.body.app.lock.sources['support-pg']).toMatchObject({ descriptorHash: 'd-support-pg' });
    expect(v2.body.app.queryText).toEqual({ open_count: 'select 1 as open' });
    // A layout change carries the lock and does not call the stage.
    const v3 = await s.call('POST', '/apps/escalations/edits', { base: 2, ops: [{ op: 'spec', spec: dataSpec('moved') }] });
    expect(v3.body['landed']).toMatchObject({ check: { level: 'spec', checked: [] } });
    expect(stage.calls).toHaveLength(1);
    expect(v3.body.app.lock).toEqual(v2.body.app.lock);
    // A query whose text changed is checked again; one dropped from the spec loses its text and its lock entry.
    const v4 = await s.call('POST', '/apps/escalations/edits', { base: 3, ops: [{ op: 'query-text', query: 'open_count', text: 'select 2 as open' }] });
    expect(v4.body['landed']).toMatchObject({ check: { level: 'data', checked: ['open_count'] } });
    const v5 = await s.call('POST', '/apps/escalations/edits', { base: 4, ops: [{ op: 'spec', spec: textSpec('Escalations', 'no data') }] });
    expect(v5.body.app.queryText).toEqual({});
    expect(v5.body.app.lock.queries).toEqual({});
    // An undo checks every query against today's sources.
    await s.call('POST', '/apps/escalations/undo', { base: 5 });
    expect(stage.calls.at(-1)).toMatchObject({ queries: ['open_count'], actions: [] });
  });

  it('a source check that throws lands nothing', async () => {
    const s = setup({ stage: { check: async () => { throw new Error('connection refused'); } } });
    await newApp(s);
    const res = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'check_failed', findings: [expect.objectContaining({ code: 'source_check_error' })] });
    expect((await s.call('GET', '/apps/escalations')).body.app.head.version).toBe(1);
  });

  it('refuses a query declared without its text', async () => {
    const s = setup({ stage: fakeStage() });
    await newApp(s);
    const res = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'check_failed', findings: [expect.objectContaining({ code: 'missing_query_text' })] });
  });
});

describe('apps: the turn lock and turn landing', () => {
  function turnsFake() {
    let active = true;
    const launched: string[] = [];
    const turns: AppTurnLauncher = {
      launch: async ({ runId }) => {
        launched.push(runId);
      },
      isActive: async () => active,
    };
    return { turns, launched, end: () => (active = false) };
  }

  it('while a turn runs, edits, undo, redo, restore and a second turn are 409 turn_in_flight; after it, they land', async () => {
    const t = turnsFake();
    const s = setup({ turns: t.turns });
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    const turn = await s.call('POST', '/apps/escalations/turns', { base: 2, message: 'make it a two-page app' });
    expect(turn.status).toBe(202);
    const runId = turn.body['runId'] as string;
    expect(runId).toMatch(/^apps-escalations-[0-9a-f]{12}$/);
    expect(turn.body).toMatchObject({ turn: { runId, base: 2, actor: 'local' } });
    for (const [url, body] of [
      ['/apps/escalations/edits', { base: 2, ops: [{ op: 'spec', spec: textSpec('a', 'b') }] }],
      ['/apps/escalations/undo', { base: 2 }],
      ['/apps/escalations/redo', { base: 2 }],
      ['/apps/escalations/restore', { base: 2, version: 1 }],
      ['/apps/escalations/turns', { base: 2, message: 'again' }],
    ] as const) {
      const res = await s.call('POST', url, body);
      expect(res.status, url).toBe(409);
      expect(res.body, url).toMatchObject({ code: 'turn_in_flight', turn: { runId } });
    }
    expect((await s.call('GET', '/apps/escalations')).body.app.turn).toMatchObject({ runId });
    t.end();
    expect((await edit(s, 'escalations', 2, 'after the turn')).status).toBe(200);
    expect(t.launched).toEqual([runId]);
  });

  it('a turn route on a daemon with no launcher is 501 and holds nothing', async () => {
    const s = setup();
    await newApp(s);
    expect((await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).status).toBe(501);
    expect((await edit(s, 'escalations', 1, 'still editable')).status).toBe(200);
  });

  it('lands only the tree its check offered, after a review by a distinct seat, as `reviewed`', async () => {
    const t = turnsFake();
    const s = setup({ turns: t.turns });
    await newApp(s);
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'add a note' })).body['runId'] as string;
    const root = join(s.dir, 'apps', 'escalations');
    const env = { ...process.env, GIT_DIR: join(root, '.git') };
    const blob = (content: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, env }).toString().trim();
    const head = git(root, 'rev-parse', 'refs/heads/main');
    // A builder's candidate with a file outside apps.json and queries/ is refused by the files stage.
    const evilTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(JSON.stringify(textSpec('x', 'y')))}\tapps.json\n100755 blob ${blob('curl evil')}\trun.sh\n`, env }).toString().trim();
    const evil = git(root, 'commit-tree', evilTree, '-p', head, '-m', 'builder');
    expect(await s.store.checkTurn('escalations', runId, evil)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'unexpected_path', path: 'run.sh' })] });
    await expect(s.store.checkTurn('escalations', 'run-9', evil)).rejects.toMatchObject({ code: 'not_this_turn' });
    // An apps.json over the limit is refused by its size in the tree, never read whole.
    const bigTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(' '.repeat(3 * 1024 * 1024))}\tapps.json\n`, env }).toString().trim();
    const big = git(root, 'commit-tree', bigTree, '-p', head, '-m', 'builder');
    expect(await s.store.checkTurn('escalations', runId, big)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'too_large', path: 'apps.json' })] });
    const goodTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(JSON.stringify(textSpec('Escalations', 'from the seat')))}\tapps.json\n`, env }).toString().trim();
    const candidate = git(root, 'commit-tree', goodTree, '-p', head, '-m', 'builder');
    const checked = await s.store.checkTurn('escalations', runId, candidate);
    expect(checked).toMatchObject({ ok: true });
    const offered = (checked as { commit: string }).commit;
    expect(git(root, 'cat-file', '-p', `${offered}:apps.lock.json`)).toContain('wicked.apps.lock/v1');
    await expect(s.store.landTurn('escalations', { runId, commit: candidate, builder: 'claude', reviewer: 'codex', summary: 'x' })).rejects.toMatchObject({ code: 'not_checked' });
    await expect(s.store.landTurn('escalations', { runId, commit: offered, builder: 'claude', reviewer: 'claude', summary: 'x' })).rejects.toMatchObject({ code: 'reviewer_not_distinct' });
    const v = await s.store.landTurn('escalations', { runId, commit: offered, builder: 'claude', reviewer: 'codex', summary: 'Added a note' });
    expect(v).toMatchObject({ version: 2, author: { kind: 'seat', id: 'claude' }, receipt: { kind: 'reviewed', review: { runId, builder: 'claude', reviewer: 'codex' } } });
    const after = (await s.call('GET', '/apps/escalations')).body.app;
    expect(after.turn).toBeNull();
    expect(after.history).toMatchObject({ states: [1, 2], pointer: 1 });
    expect(after.spec.pages[0]!.components[0]).toMatchObject({ text: 'from the seat' });
  });

  it('the check route answers 503 and checks nothing while the engine cannot verify a unit token', async () => {
    const s = setup();
    const res = await s.call('POST', '/apps/check', { token: 't', app: 'escalations', commit: 'a'.repeat(40) });
    expect(res.status).toBe(503);
  });
});

describe('apps: the store survives a restart', () => {
  it('reads its versions, receipts, pointer and turn back from daemon-apps.json', async () => {
    const t: AppTurnLauncher = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t });
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 2, message: 'x' })).body['runId'] as string;
    const again = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry, turns: t });
    const d = await again.detail('escalations');
    expect(d.versions.map((v) => v.receipt?.kind)).toEqual(['you', 'you']);
    expect(d.history.states).toEqual([1, 2]);
    expect(d.turn).toMatchObject({ runId });
    writeFileSync(join(s.dir, 'garbage.json'), '{"version":2}');
    expect(() => new AppStore({ stateFile: join(s.dir, 'garbage.json'), appsRoot: s.store.appsRoot, registry: fakeRegistry().registry })).toThrow(/not an apps store/);
  });
});

// ── xreview r1 on the store (codex): one test per finding ──────────────────────────────────────────

/** Write `content` as the loose object file `sha` names (what an agent with the object store mounted can do). */
function overwriteLooseObject(root: string, sha: string, type: string, content: Buffer): void {
  const file = join(root, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  chmodSync(file, 0o644);
  writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])));
}

describe('apps: the repo is the agent’s, so crew trusts nothing in it but object ids', () => {
  it('a changed object file under an accepted tree is refused, never served (P1)', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const specBlob = git(root, 'rev-parse', `${a.versions[0]!.commit}:apps.json`);
    overwriteLooseObject(root, specBlob, 'blob', Buffer.from(JSON.stringify(textSpec('Escalations', 'swapped by an agent'))));
    // A fresh store (no cache): the read verifies the bytes against the id.
    const fresh = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry });
    await expect(fresh.detail('escalations')).rejects.toMatchObject({ code: 'unreadable_tree' });
    await expect(fresh.acceptedSpec('escalations', 1)).rejects.toMatchObject({ code: 'unreadable_tree' });
  });

  it('replace refs are ignored: crew reads the object the id names (P1)', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const env = { ...process.env, GIT_DIR: join(root, '.git') };
    const specBlob = git(root, 'rev-parse', `${a.versions[0]!.commit}:apps.json`);
    const other = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: JSON.stringify(textSpec('Escalations', 'replaced')), env }).toString().trim();
    git(root, 'replace', specBlob, other);
    const fresh = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry });
    expect((await fresh.detail('escalations')).spec.pages[0]!.components).toEqual([]);
  });

  it('runs no hook, fsmonitor or transport the repo configures, lazy fetch included (P1)', async () => {
    const s = setup();
    await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const marker = join(s.dir, 'ran');
    const script = join(s.dir, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(script, 0o755);
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(root, '.git', 'hooks', 'reference-transaction'), 0o755);
    for (const [k, v] of [
      ['core.fsmonitor', script],
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.url', `file://${join(s.dir, 'nowhere')}`],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.uploadpack', script],
      ['commit.gpgSign', 'true'],
      ['gpg.program', script],
      ['protocol.file.allow', 'always'],
      ['protocol.allow', 'always'],
    ] as const) {
      git(root, 'config', k, v);
    }
    expect((await edit(s, 'escalations', 1, 'two')).status).toBe(200); // update-ref, hash-object, mktree, commit-tree
    // A commit the repo does not hold: a promisor remote would be asked for it.
    expect((await s.call('POST', '/apps/escalations/restore', { base: 2, version: 'f'.repeat(40) })).status).toBe(404);
    expect(existsSync(marker)).toBe(false);
  });

  it('re-points a symbolic main as a direct ref, never moving the branch it named', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const tip = git(root, 'rev-parse', `${a.versions[0]!.commit}^`);
    git(root, 'update-ref', 'refs/heads/wicked/run-1', tip);
    git(root, 'symbolic-ref', 'refs/heads/main', 'refs/heads/wicked/run-1');
    const v2 = await edit(s, 'escalations', 1, 'two');
    expect(v2.status).toBe(200);
    expect(git(root, 'rev-parse', 'refs/heads/wicked/run-1')).toBe(tip);
    // main is a direct ref again (symbolic-ref -q exits 1 for a direct ref), at crew's head.
    expect(() => execFileSync('git', ['symbolic-ref', '-q', 'refs/heads/main'], { env: { ...process.env, GIT_DIR: join(root, '.git') }, stdio: 'pipe' })).toThrow();
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe((v2.body['landed'] as { commit: string }).commit);
  }, 30_000);

  it('refuses a query file that is not UTF-8', async () => {
    const t = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t, stage: fakeStage() });
    await newApp(s);
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).body['runId'] as string;
    const root = join(s.dir, 'apps', 'escalations');
    const env = { ...process.env, GIT_DIR: join(root, '.git') };
    const blob = (content: string | Buffer) => execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, env }).toString().trim();
    const q = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(Buffer.from([0x73, 0xff, 0xfe]))}\topen_count.sql\n`, env }).toString().trim();
    const tree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(JSON.stringify(dataSpec('x')))}\tapps.json\n040000 tree ${q}\tqueries\n`, env }).toString().trim();
    const c = git(root, 'commit-tree', tree, '-p', git(root, 'rev-parse', 'refs/heads/main'), '-m', 'b');
    expect(await s.store.checkTurn('escalations', runId, c)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'not_utf8' })] });
  });
});

describe('apps: the registry, creation and the state file', () => {
  it('a slug is at most four words (the registry id is the slug), and a registered id is taken', async () => {
    const s = setup();
    expect((await s.call('POST', '/apps', { slug: 'one-two-three-four-five', projectId: 'p1' })).status).toBe(400);
    s.repos.set('one-two-three-four', '/elsewhere');
    const taken = await s.call('POST', '/apps', { slug: 'one-two-three-four', projectId: 'p1' });
    expect(taken.body).toMatchObject({ code: 'slug_taken', suggestion: 'one-two-three-four2' });
    const long = `a${'b'.repeat(38)}-c-d-${'e'.repeat(4)}`; // 48 characters, four words
    s.repos.set(long, '/elsewhere');
    const sug = (await s.call('POST', '/apps', { slug: long, projectId: 'p1' })).body.suggestion as string;
    expect(sug.length).toBeLessThanOrEqual(48);
    expect(sug).toMatch(/^(?=.{1,48}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/);
    expect(sug).not.toBe(long);
  });

  it('a dangling link under the root takes its slug, and the suggestion is another one', async () => {
    const s = setup();
    mkdirSync(join(s.dir, 'apps'), { recursive: true });
    symlinkSync(join(s.dir, 'gone'), join(s.dir, 'apps', 'ghost'));
    expect((await s.call('POST', '/apps', { slug: 'ghost', projectId: 'p1' })).body).toMatchObject({ code: 'slug_taken', suggestion: 'ghost-2' });
  });

  it('a refused registration leaves nothing behind, so the same slug can be tried again', async () => {
    let fail = true;
    const s = setup({ failRegister: () => fail });
    const res = await s.app.inject({ method: 'POST', url: '/api/v1/apps', payload: { slug: 'escalations', projectId: 'p1' } });
    expect(res.statusCode).toBe(500);
    expect(existsSync(join(s.dir, 'apps', 'escalations'))).toBe(false);
    expect(s.store.has('escalations')).toBe(false);
    fail = false;
    expect((await newApp(s)).head.version).toBe(1);
  });

  it('a state write that fails leaves memory as the file says (P2)', async () => {
    const s = setup();
    await newApp(s);
    chmodSync(s.dir, 0o555);
    try {
      expect((await s.app.inject({ method: 'POST', url: '/api/v1/apps/escalations/edits', payload: { base: 1, ops: [{ op: 'spec', spec: textSpec('a', 'b') }] } })).statusCode).toBe(500);
    } finally {
      chmodSync(s.dir, 0o755);
    }
    expect((await s.call('GET', '/apps/escalations')).body.app.head.version).toBe(1);
    expect((await edit(s, 'escalations', 1, 'now it lands')).body['landed']).toMatchObject({ version: 2 });
  });
});

describe('apps: turns and reads under concurrency', () => {
  it('records the turn before the run starts', async () => {
    let seen: unknown = null;
    const s = setup({
      turns: {
        launch: async ({ runId }) => {
          seen = JSON.parse(readFileSync(join(s.dir, 'daemon-apps.json'), 'utf8')).apps.escalations.turn?.runId === runId;
        },
        isActive: async () => true,
      },
    });
    await newApp(s);
    expect((await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).status).toBe(202);
    expect(seen).toBe(true);
  });

  it('a launch that fails releases the turn', async () => {
    const s = setup({ turns: { launch: async () => { throw new Error('no seat'); }, isActive: async () => true } });
    await newApp(s);
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/apps/escalations/turns', payload: { base: 1, message: 'x' } })).statusCode).toBe(500);
    expect((await edit(s, 'escalations', 1, 'editable')).status).toBe(200);
  });

  it('a late "ended" answer about an old turn never clears a newer one (P2)', async () => {
    let answer!: (v: boolean) => void;
    const active = new Map<string, boolean>();
    const turns: AppTurnLauncher = {
      launch: async ({ runId }) => {
        active.set(runId, true);
      },
      isActive: (runId) => (runId === first ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(active.get(runId) ?? false)),
    };
    const s = setup({ turns });
    await newApp(s);
    let first = '';
    first = (await s.store.beginTurn('escalations', { base: 1, message: 'a', about: [], actor: HUMAN })).runId;
    const reading = s.store.detail('escalations'); // asks about `first` and waits
    await s.store.endTurn('escalations', first);
    const second = (await s.store.beginTurn('escalations', { base: 1, message: 'b', about: [], actor: HUMAN })).runId;
    answer(false);
    await reading;
    expect((await s.store.detail('escalations')).turn).toMatchObject({ runId: second });
  });

  it('a read during a landing answers one version, never a new head with an old spec (P2)', async () => {
    const s = setup();
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    const fresh = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry });
    // Hold the detail read inside its tree read, land v3 meanwhile, then let the read finish (codex r2).
    const inner = fresh as unknown as { files: (a: unknown, tree: string) => Promise<unknown> };
    const original = inner.files.bind(fresh);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const reading = new Promise<void>((r) => (entered = r));
    inner.files = async (a, tree) => {
      if (inner.files !== original) {
        inner.files = original;
        entered();
        await gate;
      }
      return original(a, tree);
    };
    const detail = fresh.detail('escalations');
    await reading;
    const landed = await fresh.edit('escalations', { base: 2, ops: [{ op: 'spec', spec: textSpec('Escalations', 'three') }], actor: HUMAN });
    expect(landed.version).toBe(3);
    release();
    const d = await detail;
    expect({ head: d.head.version, text: (d.spec.pages[0]!.components[0] as { text: string }).text, versions: d.versions.length, top: d.history.states.at(-1) }).toEqual({ head: 2, text: 'two', versions: 2, top: 2 });
  });
});

describe('apps: the lock across shared sources and the two namespaces', () => {
  it('a source whose pin moves re-checks every query on it, not only the edited one (P2)', async () => {
    let host = 'db.example';
    const calls: string[][] = [];
    const stage: AppSourceStage = {
      check: async (input) => {
        calls.push([...input.queries]);
        return {
          findings: [],
          sources: { 'support-pg': { kind: 'sql', descriptor: { host }, descriptorHash: `d-${host}` } },
          queries: Object.fromEntries(input.queries.map((q) => [q, `c-${q}-${host}`])),
          actions: {},
          uploads: {},
        };
      },
    };
    const s = setup({ stage });
    await newApp(s);
    const two: AppSpec = { ...dataSpec('x'), queries: [...dataSpec('x').queries, { id: 'second', source: 'support-pg', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }] };
    await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: two }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }, { op: 'query-text', query: 'second', text: 'select 2 as n' }] });
    host = 'replacement.example';
    const v3 = await s.call('POST', '/apps/escalations/edits', { base: 2, ops: [{ op: 'query-text', query: 'open_count', text: 'select 3 as open' }] });
    expect(calls.slice(1)).toEqual([['open_count'], ['open_count', 'second']]);
    expect(v3.body.app.lock.queries).toMatchObject({ open_count: { contractHash: 'c-open_count-replacement.example' }, second: { contractHash: 'c-second-replacement.example' } });
    expect(v3.body['landed']).toMatchObject({ check: { checked: ['open_count', 'second'] } });
  });

  it('a query and an action with one id are each held to their own source (P2)', async () => {
    const stage: AppSourceStage = {
      check: async (input) => ({
        findings: [],
        sources: { 'writer-pg': { kind: 'sql', descriptor: {}, descriptorHash: 'w' } }, // no pin for the query's source
        queries: Object.fromEntries(input.queries.map((q) => [q, 'c'])),
        actions: Object.fromEntries(input.actions.map((a) => [a, 'c'])),
        uploads: {},
      }),
    };
    const s = setup({ stage });
    await newApp(s);
    const spec: AppSpec = {
      ...dataSpec('x'),
      queries: [{ id: 'shared', source: 'support-pg', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }],
      actions: [{ id: 'shared', kind: 'row-write', source: 'writer-pg', table: 's.t', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }],
    };
    const res = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec }, { op: 'query-text', query: 'shared', text: 'select 1 as n' }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ findings: [expect.objectContaining({ code: 'source_check_incomplete', path: 'query shared' })] });
  });

  it('a query named constructor with no text is a finding, not a crash', async () => {
    const s = setup({ stage: fakeStage() });
    await newApp(s);
    const spec: AppSpec = { ...dataSpec('x'), queries: [{ id: 'constructor', source: 'support-pg', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }] };
    const res = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ findings: [expect.objectContaining({ code: 'missing_query_text' })] });
  });
});

describe('apps: the check route, plugin actors and a broken state file (pi r1 on the store)', () => {
  it('the check route takes no bearer, verifies the unit token, and checks only the turn in flight', async () => {
    const t: AppTurnLauncher = { launch: async () => undefined, isActive: async () => true };
    let turnRun = '';
    const s = setup({ auth: true, turns: t, verifyUnitToken: async (tok) => (tok === 'unit-ok' ? { runId: turnRun } : tok === 'unit-other' ? { runId: 'apps-other-run' } : null) });
    await newApp(s, 'escalations', 'human');
    turnRun = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' }, 'human')).body['runId'] as string;
    const head = git(join(s.dir, 'apps', 'escalations'), 'rev-parse', 'refs/heads/main');
    // No Authorization header at all: the body's unit token is the credential.
    expect((await s.call('POST', '/apps/check', { token: 'nope', app: 'escalations', commit: head })).status).toBe(401);
    expect((await s.call('POST', '/apps/check', { token: 'unit-other', app: 'escalations', commit: head })).body).toMatchObject({ code: 'not_this_turn' });
    expect((await s.call('POST', '/apps/check', { token: 'unit-ok', app: 'nope', commit: head })).status).toBe(404);
    expect((await s.call('POST', '/apps/check', { token: 'unit-ok', app: 'escalations', tree: head })).status).toBe(400);
    const ok = await s.call('POST', '/apps/check', { token: 'unit-ok', app: 'escalations', commit: head });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, summary: { level: 'spec' } });
  });

  it('a plugin actor cannot run an app query', async () => {
    const s = setup({ auth: true });
    await newApp(s, 'escalations', 'human');
    const res = await s.call('POST', '/apps/escalations/query', { version: 1, query: 'q' }, 'plugin');
    expect(res.status).toBe(403);
  });

  it('a state file that is not JSON fails the store (the daemon then leaves Apps off)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apps-store-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'daemon-apps.json'), '{"version":1,"apps":');
    expect(() => new AppStore({ stateFile: join(dir, 'daemon-apps.json'), appsRoot: join(dir, 'apps'), registry: fakeRegistry().registry })).toThrow(SyntaxError);
  });
});

// ── xreview r2 on the store (codex, pi): one test per finding ──────────────────────────────────────

describe('apps: crew writes only into the app repo’s own .git (P1)', () => {
  it('a commondir file an agent planted is refused, and the repo it names is untouched', async () => {
    const s = setup();
    await newApp(s);
    const other = await newApp(s, 'other');
    const root = join(s.dir, 'apps', 'escalations');
    const otherRoot = join(s.dir, 'apps', 'other');
    writeFileSync(join(root, '.git', 'commondir'), `${join(otherRoot, '.git')}\n`);
    const res = await edit(s, 'escalations', 1, 'two');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'unreadable_tree' });
    expect(git(otherRoot, 'rev-parse', 'refs/heads/main')).toBe(other.versions[0]!.commit);
  });

  it('a linked objects fan-out directory or refs/heads is refused before any write', async () => {
    const s = setup();
    await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const elsewhere = join(s.dir, 'elsewhere');
    mkdirSync(elsewhere);
    for (let i = 0; i < 256; i++) {
      const fan = join(root, '.git', 'objects', i.toString(16).padStart(2, '0'));
      rmSync(fan, { recursive: true, force: true });
      symlinkSync(elsewhere, fan);
    }
    expect((await edit(s, 'escalations', 1, 'two')).body).toMatchObject({ code: 'unreadable_tree' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('needs a git whose lazy-fetch switch is honoured', () => {
    expect(gitVersionProblem('git version 2.45.0')).toMatch(/2\.45\.1 or later/);
    expect(gitVersionProblem('git version 2.39.5 (Apple Git-154)')).toMatch(/or later/);
    expect(gitVersionProblem('git version 2.45.1')).toBeNull();
    expect(gitVersionProblem('git version 2.56.0')).toBeNull();
  });
});

describe('apps: recovery, the mirror and provenance (codex r2)', () => {
  it('recovery never deletes an app: a failed registration leaves it, a later boot finishes it', async () => {
    const s = setup();
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    const state = JSON.parse(readFileSync(s.store.stateFile, 'utf8'));
    state.apps.escalations.repoId = '';
    writeFileSync(s.store.stateFile, JSON.stringify(state));
    let fail = true;
    const reg = fakeRegistry(() => fail);
    const again = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: reg.registry });
    await again.reconcile();
    const kept = await again.detail('escalations');
    expect(kept.versions).toHaveLength(2);
    expect(kept.repoId).toBe('');
    expect(existsSync(join(s.dir, 'apps', 'escalations'))).toBe(true);
    fail = false;
    await again.reconcile();
    expect((await again.detail('escalations')).repoId).toBe('escalations');
  });

  it('a main that cannot be moved never fails a landing; the next change repairs it', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const spy = vi.spyOn(AppGit.prototype, 'setMain').mockRejectedValueOnce(new Error('disk full'));
    const v2 = await edit(s, 'escalations', 1, 'two');
    spy.mockRestore();
    expect(v2.status).toBe(200);
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe(a.versions[0]!.commit);
    const v3 = await edit(s, 'escalations', 2, 'three');
    expect(git(root, 'rev-parse', 'refs/heads/main')).toBe((v3.body['landed'] as { commit: string }).commit);
    expect(git(root, 'rev-parse', `${(v3.body['landed'] as { commit: string }).commit}^`)).toBe((v2.body['landed'] as { commit: string }).commit);
  });

  it("restoring a version keeps THAT version's provenance when two versions share a tree", async () => {
    const t: AppTurnLauncher = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t });
    const a = await newApp(s);
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).body['runId'] as string;
    // The builder offers exactly v1's spec: the checked tree is v1's tree, landed as `reviewed` v2.
    const checked = await s.store.checkTurn('escalations', runId, a.versions[0]!.commit);
    expect(checked).toMatchObject({ ok: true, tree: a.versions[0]!.tree });
    await s.store.landTurn('escalations', { runId, commit: (checked as { commit: string }).commit, builder: 'claude', reviewer: 'codex', summary: 'same' });
    await edit(s, 'escalations', 2, 'three');
    const r = await s.call('POST', '/apps/escalations/restore', { base: 3, version: 2 });
    expect(r.body['landed']).toMatchObject({ receipt: { kind: 'restored', restoredFrom: { version: 2, originKind: 'reviewed', originVersion: 2 } } });
  });
});

describe('apps: turns, registration and request bounds (codex r2)', () => {
  it('a poll while the launch is in flight never releases the turn', async () => {
    let launched!: () => void;
    const launching = new Promise<void>((r) => (launched = r));
    let started!: () => void;
    const inLaunch = new Promise<void>((r) => (started = r));
    let known = false;
    const s = setup({
      turns: {
        launch: async () => {
          started();
          await launching;
          known = true;
        },
        isActive: async () => known,
      },
    });
    await newApp(s);
    const turn = s.store.beginTurn('escalations', { base: 1, message: 'x', about: [], actor: HUMAN });
    await inLaunch;
    expect((await s.store.detail('escalations')).turn).not.toBeNull();
    launched();
    const t = await turn;
    expect((await s.store.detail('escalations')).turn).toMatchObject({ runId: t.runId });
    expect((await edit(s, 'escalations', 1, 'blocked')).body).toMatchObject({ code: 'turn_in_flight' });
  });

  it('an id registered between the check and the registration is refused, and nothing is left', async () => {
    let calls = 0;
    const repos = new Map<string, string>();
    const registry: AppRepoRegistry = {
      register: async (name, root) => {
        repos.set(name, root);
        return { id: name, name, root_path: root, registered_at: 1, default_branch: 'main' };
      },
      idTaken: async () => ++calls > 1, // free when first asked, taken just before registering
    };
    const dir = mkdtempSync(join(tmpdir(), 'apps-store-'));
    dirs.push(dir);
    const store = new AppStore({ stateFile: join(dir, 'daemon-apps.json'), appsRoot: join(dir, 'apps'), registry });
    await expect(store.create({ slug: 'race', name: 'race', projectId: 'p', actor: HUMAN })).rejects.toMatchObject({ code: 'slug_taken' });
    expect(repos.size).toBe(0);
    expect(store.has('race')).toBe(false);
    expect(existsSync(join(dir, 'apps', 'race'))).toBe(false);
  });

  it('an over-long ops or about list is refused before the schema walks it', async () => {
    const s = setup({ turns: { launch: async () => undefined, isActive: async () => true } });
    await newApp(s);
    const ops = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: Array.from({ length: 100_000 }, () => ({})) });
    expect(ops.body).toMatchObject({ code: 'bad_request', error: 'an edit holds at most 50 ops' });
    const about = await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x', about: Array.from({ length: 21 }, () => 'c') });
    expect(about.body).toMatchObject({ code: 'bad_request', error: 'a turn is about at most 20 components' });
  });

  it('a tree that repeats a name is refused by the files stage', async () => {
    const t = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t });
    await newApp(s);
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).body['runId'] as string;
    const root = join(s.dir, 'apps', 'escalations');
    const env = { ...process.env, GIT_DIR: join(root, '.git') };
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: JSON.stringify(textSpec('x', 'y')), env }).toString().trim();
    const entry = Buffer.concat([Buffer.from('100644 apps.json\0'), Buffer.from(blob, 'hex')]);
    const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], { input: Buffer.concat([entry, entry]), env }).toString().trim();
    const c = git(root, 'commit-tree', tree, '-p', git(root, 'rev-parse', 'refs/heads/main'), '-m', 'b');
    expect(await s.store.checkTurn('escalations', runId, c)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'bad_tree' })] });
  });

  it('a long four-word slug that is taken still gets a valid, free suggestion', async () => {
    const s = setup();
    const slug = `${'a'.repeat(42)}-b-c-d`;
    s.repos.set(slug, '/elsewhere');
    const res = await s.call('POST', '/apps', { slug, projectId: 'p1' });
    const sug = res.body.suggestion as string;
    expect(sug).toMatch(/^(?=.{1,48}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/);
    expect(sug).not.toBe(slug);
  });

  it('a rechecked source loses an upload pin the stage no longer answers', async () => {
    let uploaded = true;
    const stage: AppSourceStage = {
      check: async (input) => ({
        findings: [],
        sources: { 'support-pg': { kind: 'sql', descriptor: { uploaded }, descriptorHash: uploaded ? 'snap' : 'remote' } },
        queries: Object.fromEntries(input.queries.map((q) => [q, `c-${q}`])),
        actions: {},
        uploads: uploaded ? { 'support-pg': { digest: 'd1' } } : {},
      }),
    };
    const s = setup({ stage });
    await newApp(s);
    const v2 = await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }] });
    expect(v2.body.app.lock.uploads).toEqual({ 'support-pg': { digest: 'd1' } });
    uploaded = false;
    const v3 = await s.call('POST', '/apps/escalations/undo', { base: 2 });
    expect(v3.status).toBe(200);
    const redo = await s.call('POST', '/apps/escalations/redo', { base: 3 });
    expect(redo.body.app.lock.uploads).toEqual({});
  });
});

// ── xreview r3 on the store (codex, pi): one test per finding ──────────────────────────────────────

describe('apps: crew writes its objects and refs itself (codex r3 P1)', () => {
  it('writes objects git itself accepts as valid', async () => {
    const s = setup({ stage: fakeStage() });
    await newApp(s);
    await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: dataSpec('x') }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }] });
    await s.call('POST', '/apps/escalations/undo', { base: 2 });
    const root = join(s.dir, 'apps', 'escalations');
    execFileSync('git', ['fsck', '--strict', '--no-dangling'], { env: { ...process.env, GIT_DIR: join(root, '.git'), GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
    expect(git(root, 'log', '--format=%s', 'refs/heads/main').split('\n')).toEqual(['v3: Undo to v1', 'v2: Edited', 'v1: a new app', 'Empty app repository']);
  });

  it('a planted reflog link or a reftable setting never takes a write outside the repo', async () => {
    const s = setup();
    await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const outside = join(s.dir, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    mkdirSync(join(root, '.git', 'logs', 'refs', 'heads'), { recursive: true });
    symlinkSync(outside, join(root, '.git', 'logs', 'refs', 'heads', 'main'));
    expect((await edit(s, 'escalations', 1, 'two')).status).toBe(200);
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    git(root, 'config', 'core.repositoryformatversion', '1');
    git(root, 'config', 'extensions.refStorage', 'reftable');
    const res = await edit(s, 'escalations', 2, 'three');
    expect([200, 409]).toContain(res.status); // the agent can break its own repo's reads; it cannot move crew's writes
    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
  });
});

describe('apps: the lock, turns and the guard after round 3 (codex, pi)', () => {
  it('an upload pin that appears or goes away re-checks every query on that source', async () => {
    let upload: string | null = null;
    const calls: string[][] = [];
    const stage: AppSourceStage = {
      check: async (input) => {
        calls.push([...input.queries]);
        return {
          findings: [],
          sources: { 'support-pg': { kind: 'sql', descriptor: {}, descriptorHash: 'same' } },
          queries: Object.fromEntries(input.queries.map((q) => [q, `c-${q}-${upload ?? 'none'}`])),
          actions: {},
          uploads: upload === null ? {} : { 'support-pg': { digest: upload } },
        };
      },
    };
    const s = setup({ stage });
    await newApp(s);
    const two: AppSpec = { ...dataSpec('x'), queries: [...dataSpec('x').queries, { id: 'second', source: 'support-pg', kind: 'sql', output: [{ name: 'n', type: 'integer' }] }] };
    await s.call('POST', '/apps/escalations/edits', { base: 1, ops: [{ op: 'spec', spec: two }, { op: 'query-text', query: 'open_count', text: 'select 1 as open' }, { op: 'query-text', query: 'second', text: 'select 2 as n' }] });
    upload = 'd1'; // absent -> present
    const v3 = await s.call('POST', '/apps/escalations/edits', { base: 2, ops: [{ op: 'query-text', query: 'open_count', text: 'select 3 as open' }] });
    expect(calls.at(-1)).toEqual(['open_count', 'second']);
    expect(v3.body.app.lock.uploads).toEqual({ 'support-pg': { digest: 'd1' } });
    upload = null; // present -> absent, with the sibling still on the source
    const v4 = await s.call('POST', '/apps/escalations/edits', { base: 3, ops: [{ op: 'query-text', query: 'open_count', text: 'select 4 as open' }] });
    expect(calls.at(-1)).toEqual(['open_count', 'second']);
    expect(v4.body.app.lock.uploads).toEqual({});
    expect(v4.body.app.lock.queries['second']).toMatchObject({ contractHash: 'c-second-none' });
  });

  it('a landed tree whose lock is gone or changed reads as unreadable, never as an empty lock', async () => {
    const s = setup();
    const a = await newApp(s);
    const root = join(s.dir, 'apps', 'escalations');
    const lockBlob = git(root, 'rev-parse', `${a.versions[0]!.commit}:apps.lock.json`);
    overwriteLooseObject(root, lockBlob, 'blob', Buffer.from('{"schema":"x"}'));
    const fresh = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry });
    await expect(fresh.detail('escalations')).rejects.toMatchObject({ code: 'unreadable_tree' });
    await expect(fresh.acceptedSpec('escalations', 1)).rejects.toMatchObject({ code: 'unreadable_tree' });
  });

  it('after a restart a turn whose launch never finished is asked about, and released', async () => {
    const t: AppTurnLauncher = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t });
    await newApp(s);
    await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' });
    // The daemon restarts; the engine never heard of the run.
    const again = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, registry: fakeRegistry().registry, turns: { launch: async () => undefined, isActive: async () => false } });
    expect((await again.detail('escalations')).turn).toBeNull();
    expect(JSON.parse(readFileSync(s.store.stateFile, 'utf8')).apps.escalations.turn).toBeNull();
  });

  it("anchors the checked commit under a crew ref until the turn lands", async () => {
    const t: AppTurnLauncher = { launch: async () => undefined, isActive: async () => true };
    const s = setup({ turns: t });
    const a = await newApp(s);
    const runId = (await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'x' })).body['runId'] as string;
    const root = join(s.dir, 'apps', 'escalations');
    const checked = (await s.store.checkTurn('escalations', runId, a.versions[0]!.commit)) as { commit: string };
    expect(git(root, 'rev-parse', `refs/wicked/apps-checked/${runId}`)).toBe(checked.commit);
    await s.store.landTurn('escalations', { runId, commit: checked.commit, builder: 'claude', reviewer: 'codex', summary: 'x' });
    expect(existsSync(join(root, '.git', 'refs', 'wicked', 'apps-checked', runId))).toBe(false);
  });

  it('the origin guard lets the worker check route through, as it does /mcp/call (pi r3)', () => {
    const req = { method: 'POST', path: '/api/v1/apps/check', host: 'seat-gateway.internal', origin: 'http://elsewhere.example', secFetchSite: 'cross-site', upgrade: undefined };
    expect(refuseRequest(req, { mode: 'off', allowedOrigins: null })).toBeNull();
    expect(refuseRequest({ ...req, path: '/api/v1/apps/escalations/edits' }, { mode: 'off', allowedOrigins: null })).not.toBeNull();
  });
});
