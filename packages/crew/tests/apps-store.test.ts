// DES-APPS-001 §6.4, §7.6, §9.1 (K2a): the app store and its routes, over real git repos in a temp dir.
// Every acceptance item of the slice is a test here: stale edit/undo/restore → 409; an edit during a turn →
// 409 turn_in_flight; a rejected tree cannot be restored; the query route refuses an unreceipted tree; an
// agent-kind operator token cannot post an edit; two concurrent undos move the pointer once.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isUnitTokenRoute, registerAuthHooks, requiredTrust } from '../src/api/auth.js';
import type { AppSourceStage, AppSourceStageInput } from '../src/apps/check.js';
import { registerAppRoutes } from '../src/apps/routes.js';
import { AppStore, type AppTurnLauncher } from '../src/apps/store.js';
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

function setup(opts: { auth?: boolean; stage?: AppSourceStage | null; turns?: AppTurnLauncher | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apps-store-'));
  dirs.push(dir);
  const store = new AppStore({ stateFile: join(dir, 'daemon-apps.json'), appsRoot: join(dir, 'apps'), sourceStage: opts.stage ?? null, turns: opts.turns ?? null });
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokens: Record<string, Actor> = { human: HUMAN, agent: AGENT, observer: OBSERVER };
  if (opts.auth === true) registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => tokens[t] ?? null }], allowedOrigins: null });
  const audit = { record: vi.fn() };
  registerAppRoutes(app, { store, audit, registerRepo: async (name) => `repo-${name}` });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}), ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & { app: AppDetail; code?: string } };
  };
  return { dir, store, app, call, audit };
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
    // App B's accepted commit is no version of app A (S7, crew side).
    const b = await newApp(s, 'other', 'human');
    expect((await s.call('POST', '/apps/escalations/query', { version: b.versions[0]!.commit, query: 'open_count' }, 'observer')).body).toMatchObject({ code: 'unknown_version' });
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
      launch: async () => {
        launched.push(`run-${launched.length + 1}`);
        return launched.at(-1)!;
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
    expect(turn.body).toMatchObject({ runId: 'run-1', turn: { runId: 'run-1', base: 2, actor: 'local' } });
    for (const [url, body] of [
      ['/apps/escalations/edits', { base: 2, ops: [{ op: 'spec', spec: textSpec('a', 'b') }] }],
      ['/apps/escalations/undo', { base: 2 }],
      ['/apps/escalations/redo', { base: 2 }],
      ['/apps/escalations/restore', { base: 2, version: 1 }],
      ['/apps/escalations/turns', { base: 2, message: 'again' }],
    ] as const) {
      const res = await s.call('POST', url, body);
      expect(res.status, url).toBe(409);
      expect(res.body, url).toMatchObject({ code: 'turn_in_flight', turn: { runId: 'run-1' } });
    }
    expect((await s.call('GET', '/apps/escalations')).body.app.turn).toMatchObject({ runId: 'run-1' });
    t.end();
    expect((await edit(s, 'escalations', 2, 'after the turn')).status).toBe(200);
    expect(t.launched).toEqual(['run-1']);
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
    await s.call('POST', '/apps/escalations/turns', { base: 1, message: 'add a note' });
    const root = join(s.dir, 'apps', 'escalations');
    const env = { ...process.env, GIT_DIR: join(root, '.git') };
    const blob = (content: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, env }).toString().trim();
    const head = git(root, 'rev-parse', 'refs/heads/main');
    // A builder's candidate with a file outside apps.json and queries/ is refused by the files stage.
    const evilTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(JSON.stringify(textSpec('x', 'y')))}\tapps.json\n100755 blob ${blob('curl evil')}\trun.sh\n`, env }).toString().trim();
    const evil = git(root, 'commit-tree', evilTree, '-p', head, '-m', 'builder');
    expect(await s.store.checkTurn('escalations', 'run-1', evil)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'unexpected_path', path: 'run.sh' })] });
    await expect(s.store.checkTurn('escalations', 'run-9', evil)).rejects.toMatchObject({ code: 'not_this_turn' });
    // An apps.json over the limit is refused by its size in the tree, never read whole.
    const bigTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(' '.repeat(3 * 1024 * 1024))}\tapps.json\n`, env }).toString().trim();
    const big = git(root, 'commit-tree', bigTree, '-p', head, '-m', 'builder');
    expect(await s.store.checkTurn('escalations', 'run-1', big)).toMatchObject({ ok: false, findings: [expect.objectContaining({ code: 'too_large', path: 'apps.json' })] });
    const goodTree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob(JSON.stringify(textSpec('Escalations', 'from the seat')))}\tapps.json\n`, env }).toString().trim();
    const candidate = git(root, 'commit-tree', goodTree, '-p', head, '-m', 'builder');
    const checked = await s.store.checkTurn('escalations', 'run-1', candidate);
    expect(checked).toMatchObject({ ok: true });
    const offered = (checked as { commit: string }).commit;
    expect(git(root, 'cat-file', '-p', `${offered}:apps.lock.json`)).toContain('wicked.apps.lock/v1');
    await expect(s.store.landTurn('escalations', { runId: 'run-1', commit: candidate, builder: 'claude', reviewer: 'codex', summary: 'x' })).rejects.toMatchObject({ code: 'not_checked' });
    await expect(s.store.landTurn('escalations', { runId: 'run-1', commit: offered, builder: 'claude', reviewer: 'claude', summary: 'x' })).rejects.toMatchObject({ code: 'reviewer_not_distinct' });
    const v = await s.store.landTurn('escalations', { runId: 'run-1', commit: offered, builder: 'claude', reviewer: 'codex', summary: 'Added a note' });
    expect(v).toMatchObject({ version: 2, author: { kind: 'seat', id: 'claude' }, receipt: { kind: 'reviewed', review: { runId: 'run-1', builder: 'claude', reviewer: 'codex' } } });
    const after = (await s.call('GET', '/apps/escalations')).body.app;
    expect(after.turn).toBeNull();
    expect(after.history).toMatchObject({ states: [1, 2], pointer: 1 });
    expect(after.spec.pages[0]!.components[0]).toMatchObject({ text: 'from the seat' });
  });

  it('the check route answers 503 and checks nothing while the engine cannot verify a unit token', async () => {
    const s = setup();
    const res = await s.call('POST', '/apps/check', { token: 't', app: 'escalations', tree: 'a'.repeat(40) });
    expect(res.status).toBe(503);
  });
});

describe('apps: the store survives a restart', () => {
  it('reads its versions, receipts, pointer and turn back from daemon-apps.json', async () => {
    const t = { launch: async () => 'run-1', isActive: async () => true };
    const s = setup({ turns: t });
    await newApp(s);
    await edit(s, 'escalations', 1, 'two');
    await s.call('POST', '/apps/escalations/turns', { base: 2, message: 'x' });
    const again = new AppStore({ stateFile: s.store.stateFile, appsRoot: s.store.appsRoot, turns: t });
    const d = await again.detail('escalations');
    expect(d.versions.map((v) => v.receipt?.kind)).toEqual(['you', 'you']);
    expect(d.history.states).toEqual([1, 2]);
    expect(d.turn).toMatchObject({ runId: 'run-1' });
    writeFileSync(join(s.dir, 'garbage.json'), '{"version":2}');
    expect(() => new AppStore({ stateFile: join(s.dir, 'garbage.json'), appsRoot: s.store.appsRoot })).toThrow(/not an apps store/);
  });
});
