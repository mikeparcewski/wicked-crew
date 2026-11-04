// DES-KNOWLEDGE-DATA-001 §5.2: the agent-safe view, on two more reads (one rule: `viewOf` in api/auth.ts).
// - crew#1324: `GET /runs/:id/files` and `/diff` refuse a non-human actor an app repo's files (the lock's connection
//   descriptors, the query text, the actions), from a turn's live worktree, from its run branch after the worktree
//   is gone, and through another run's id. A human's reads are unchanged, and so are a non-human's other run files.
// - crew#1325: a refused `POST /apps/:app/query` answers a non-human (a `system` bearer: agent and plugin actors are
//   refused first) its status and code, never the policy detail that names the relation. A human reads it whole.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { registerAuthHooks } from '../src/api/auth.js';
import { mayBeInsideRoot } from '../src/api/open-path.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { AppExecError, type AppExecutor } from '../src/apps/exec/executor.js';
import { registerAppRoutes } from '../src/apps/routes.js';
import { AppStore, AppStoreError } from '../src/apps/store.js';
import { appRefusalFor } from '../src/apps/views.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { removeScratch } from './setup/scratch.js';

const HUMAN: Actor = { id: 'priya', kind: 'human', trust: 'operator' };
const OBSERVER: Actor = { id: 'olga', kind: 'human', trust: 'observer' };
const AGENT: Actor = { id: 'seat-codex', kind: 'agent', trust: 'admin' };
const PLUGIN: Actor = { id: 'plugin:x@1.0.0', kind: 'plugin', trust: 'observer' };
const SYSTEM: Actor = { id: 'ci', kind: 'system', trust: 'admin' };
const TOKENS: Record<string, Actor> = { human: HUMAN, observer: OBSERVER, agent: AGENT, plugin: PLUGIN, system: SYSTEM };

/** git with a hermetic identity (no dependence on the developer's ~/.gitconfig). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
}

// What a K5 builder's worktree holds on disk: the lock (each source's connection descriptor), the query text that
// names the source's relations, and the spec's actions.
const DESCRIPTOR_HOST = 'pg-wh.corp.test';
const RELATION = 'finance.payroll';
const LOCK = JSON.stringify({ schema: 'wicked.apps.lock/v1', sources: { wh: { kind: 'sql', descriptorHash: 'd'.repeat(64), descriptor: { driver: 'postgres', host: DESCRIPTOR_HOST, port: 5432, database: 'wh', user: 'apps_reader' } } }, queries: {}, actions: {}, uploads: {} }, null, 1);
const QUERY = `SELECT p.id, p.amount FROM ${RELATION} AS p`;
const SPEC = JSON.stringify({ schema: 'wicked.apps/v1', name: 'Desk', pages: [], queries: [{ id: 'pay', source: 'wh', kind: 'sql', output: [] }], actions: [{ id: 'close', kind: 'row-write', source: 'wh', table: RELATION, op: 'update' }], linkHosts: [] });
const LEAKS = [DESCRIPTOR_HOST, RELATION, '"descriptor"'];

function writeApp(dir: string): void {
  mkdirSync(join(dir, 'queries'), { recursive: true });
  writeFileSync(join(dir, 'apps.lock.json'), LOCK);
  writeFileSync(join(dir, 'apps.json'), SPEC);
  writeFileSync(join(dir, 'queries', 'pay.sql'), QUERY);
}

function view(id: string, workdir: string, repoRef: string | null, extra: Record<string, unknown> = {}) {
  return {
    session: { id, workflow_id: null, problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['stub'], status: 'completed', human_confirm: 'none', unit_ix: 1, attempt: 0, workdir, repo_ref: repoRef, extra_write_roots: [], archived_at: null, archive_note: null, ...extra },
    units: [],
  };
}

/** The route set over `runs` and `repos`, with `store` (none = a daemon whose app store could not be read). */
async function routeSet(runs: unknown[], repos: unknown[], store: AppStore | undefined): Promise<FastifyInstance> {
  const adapter = { sessionsDetail: vi.fn().mockResolvedValue(runs), listRepos: vi.fn().mockResolvedValue(repos) };
  const app = Fastify({ logger: false });
  registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'required' }, store !== undefined ? { apps: store } : {});
  await app.ready();
  return app;
}

const repo = (id: string, root: string) => ({ id, name: id, root_path: root, registered_at: 1, default_branch: 'main' });

describe('crew#1324: a non-human GET /runs/:id/files and /diff refuse an app repo’s files', () => {
  let base: string;
  let appRoot: string;
  let worktree: string;
  let external: string;
  let oldRoot: string;
  let other: string;
  let caseVariant: string | null;
  let app: FastifyInstance;
  let storeOff: FastifyInstance;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-sec-views-2-files-'));
    const appsRoot = join(base, 'apps');
    appRoot = join(appsRoot, 'desk');
    mkdirSync(appRoot, { recursive: true });
    git(appRoot, 'init', '-q');
    git(appRoot, 'commit', '-q', '--allow-empty', '-m', 'v0');
    const baseCommit = git(appRoot, 'rev-parse', 'HEAD').trim();
    // A finished turn: its worktree is gone and its work is on its run branch.
    git(appRoot, 'checkout', '-q', '-b', 'wicked/run-gone');
    writeApp(appRoot);
    git(appRoot, 'add', '.');
    git(appRoot, 'commit', '-q', '-m', 'the builder’s tree');
    git(appRoot, 'checkout', '-q', 'main');
    // A live turn: the engine's worktree under the app repo, the builder's files on disk.
    worktree = join(appRoot, 'wicked-worktrees', 'run-app');
    git(appRoot, 'worktree', 'add', '-q', '-b', 'wicked/run-app', worktree);
    writeApp(worktree);
    // codex r1: a worktree of the app repo outside its root (only the run's repository says it is an app's).
    external = join(base, 'ext-wt');
    git(appRoot, 'worktree', 'add', '-q', '-b', 'wicked/run-ext', external);
    writeApp(external);
    // codex r1: an app made under an earlier apps root, recorded in the store (the root moved since).
    const stateFile = join(base, 'daemon-apps.json');
    const registry = { register: async (name: string, root: string) => repo(name, root), idTaken: async () => false };
    await new AppStore({ stateFile, appsRoot: join(base, 'old-apps'), registry }).create({ slug: 'old', name: 'Old', projectId: 'p1', actor: HUMAN });
    oldRoot = join(base, 'old-apps', 'old');
    writeApp(join(oldRoot, 'stray'));
    // A run on another repo, with a link into the app's worktree (pi r1).
    other = join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(join(other, 'README.md'), 'hello\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'base');
    writeFileSync(join(other, 'README.md'), 'hello, changed\n');
    symlinkSync(join(worktree, 'apps.lock.json'), join(other, 'lock-link'), 'file');
    // codex r1: on a case-insensitive filesystem (macOS, Windows) another spelling names the same file.
    const variant = join(base, 'APPS', 'Desk', 'wicked-worktrees', 'run-app', 'apps.lock.json');
    caseVariant = existsSync(variant) ? variant : null;

    const runs = [
      view('run-app', worktree, 'desk'),
      view('run-gone', join(appRoot, 'wicked-worktrees', 'run-gone'), 'desk', { run_branch: 'wicked/run-gone', base_commit: baseCommit }),
      view('run-ext', external, 'desk'),
      view('run-null', worktree, null),
      view('run-old', join(oldRoot, 'wicked-worktrees', 'run-old'), 'old'),
      view('run-other', other, null),
      view('run-extra', other, null, { extra_write_roots: [worktree] }),
      // A write root above the apps root: containment admits any spelling below it.
      view('run-wide', other, null, { extra_write_roots: [base] }),
    ];
    const repos = [repo('desk', appRoot), repo('old', oldRoot), repo('other', other)];
    app = await routeSet(runs, repos, new AppStore({ stateFile, appsRoot, registry }));
    storeOff = await routeSet(runs, repos, undefined);
  });
  afterAll(async () => {
    await app?.close();
    await storeOff?.close();
    removeScratch(base);
  });

  const get = async (as: keyof typeof TOKENS, url: string, query: Record<string, string> = {}, on: FastifyInstance = app) => {
    const res = await on.inject({ method: 'GET', url: `/api/v1${url}`, query, headers: { authorization: `Bearer ${as}` } });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body };
  };
  /** Every read a non-human could reach an app's files by. */
  const reads = (): Array<[string, Record<string, string>]> => [
    ['/runs/run-app/files', { path: join(worktree, 'apps.lock.json') }],
    ['/runs/run-app/files', { path: join(worktree, 'queries', 'pay.sql') }],
    ['/runs/run-app/files', { path: join(worktree, 'apps.json') }],
    ['/runs/run-app/files', { path: `${join(worktree, 'apps.lock.json')}/` }],
    // Another run's id: every registered repo root is a contained root, the app's among them.
    ['/runs/run-other/files', { path: join(worktree, 'apps.lock.json') }],
    ['/runs/run-other/files', { path: join(other, 'lock-link') }],
    ['/runs/run-extra/files', { path: join(worktree, 'queries', 'pay.sql') }],
    ['/runs/run-other/files', { path: join(oldRoot, 'stray', 'apps.lock.json') }],
    ...(caseVariant !== null ? [['/runs/run-wide/files', { path: caseVariant }] as [string, Record<string, string>]] : []),
    ['/runs/run-app/diff', {}],
    ['/runs/run-app/diff', { path: join(worktree, 'queries', 'pay.sql') }],
    ['/runs/run-app/diff', { base: 'main' }],
    // Each guard on its own: the run's repository (a worktree outside the app root), the run's worktree (no repository).
    ['/runs/run-ext/diff', {}],
    ['/runs/run-null/diff', {}],
    // The run branch, after the worktree was removed.
    ['/runs/run-gone/diff', {}],
    ['/runs/run-gone/diff', { base: 'main' }],
    ['/runs/run-gone/diff', { path: join(appRoot, 'queries', 'pay.sql') }],
    ['/runs/run-old/diff', {}],
  ];
  /** Each read's answer, all of them before any is judged, so a red run lists every one that leaks. */
  const answers = async (as: keyof typeof TOKENS, on: FastifyInstance = app) => {
    const seen: Array<{ read: string; status: number; code: unknown; leaked: string[] }> = [];
    for (const [url, query] of reads()) {
      const r = await get(as, url, query, on);
      seen.push({ read: `${as} ${url} ${JSON.stringify(query).split(base).join('<base>')}`, status: r.status, code: r.body['code'], leaked: LEAKS.filter((l) => r.text.includes(l)) });
    }
    return seen;
  };
  const refused = (seen: Array<{ read: string }>) => seen.map(({ read }) => ({ read, status: 403, code: 'app_files_human_only', leaked: [] }));

  it('NEGATIVE CONTROL: agent, plugin and system bearers get 403 app_files_human_only: no descriptor host, no query text', async () => {
    const seen = [...(await answers('agent')), ...(await answers('plugin')), ...(await answers('system'))];
    expect(seen).toEqual(refused(seen));
  });

  it('NEGATIVE CONTROL (codex r1): with no app store crew cannot tell an app’s files, so a non-human reads no run file or diff', async () => {
    const seen = await answers('agent', storeOff);
    expect(seen).toEqual(refused(seen));
    const plain = await get('system', '/runs/run-other/files', { path: join(other, 'README.md') }, storeOff);
    expect([plain.status, plain.body['code']]).toEqual([403, 'app_files_human_only']);
    expect((await get('human', '/runs/run-app/files', { path: join(worktree, 'apps.lock.json') }, storeOff)).body['content']).toBe(LOCK);
  });

  it('the case-insensitive filesystem check runs where it can (macOS, Windows)', () => {
    if (process.platform === 'darwin') expect(caseVariant, 'the fixture names the lock in another spelling').not.toBeNull();
  });

  it('mayBeInsideRoot: the filesystem’s spelling, a missing leaf through its ancestor, a sibling outside, and an unreadable path fails closed', () => {
    const appsRoot = join(base, 'apps');
    expect(mayBeInsideRoot(appsRoot, join(worktree, 'gone', 'x.sql'))).toBe(true);
    expect(mayBeInsideRoot(appsRoot, join(base, 'apps-sibling', 'x'))).toBe(false);
    expect(mayBeInsideRoot(appsRoot, other)).toBe(false);
    if (caseVariant !== null) expect(mayBeInsideRoot(appsRoot, caseVariant)).toBe(true);
    const loop = join(base, 'loop');
    mkdirSync(loop);
    symlinkSync(join(loop, 'b'), join(loop, 'a'));
    symlinkSync(join(loop, 'a'), join(loop, 'b'));
    expect(mayBeInsideRoot(appsRoot, join(loop, 'a', 'x'))).toBe(true);
  });

  it("REGRESSION: a human's run files and diff are unchanged (operator and observer)", async () => {
    for (const as of ['human', 'observer'] as const) {
      const lock = await get(as, '/runs/run-app/files', { path: join(worktree, 'apps.lock.json') });
      expect(lock.status, lock.text).toBe(200);
      expect(lock.body['content']).toBe(LOCK);
      expect((await get(as, '/runs/run-app/files', { path: join(worktree, 'queries', 'pay.sql') })).body['content']).toBe(QUERY);
      expect((await get(as, '/runs/run-other/files', { path: join(worktree, 'apps.json') })).body['content']).toBe(SPEC);
      expect((await get(as, '/runs/run-other/files', { path: join(other, 'lock-link') })).body['content']).toBe(LOCK);
      for (const run of ['run-app', 'run-ext', 'run-null']) {
        const live = await get(as, `/runs/${run}/diff`);
        expect([live.status, live.body['source']], `${run} ${live.text}`).toEqual([200, 'worktree']);
        for (const leak of LEAKS) expect(String(live.body['diff']), `${run} ${leak}`).toContain(leak);
      }
      const gone = await get(as, '/runs/run-gone/diff');
      expect([gone.status, gone.body['source']], gone.text).toEqual([200, 'branch']);
      for (const leak of LEAKS) expect(String(gone.body['diff']), leak).toContain(leak);
    }
  });

  it('a non-human still reads a run that is not an app’s: the refusal is the app repo’s only', async () => {
    const f = await get('agent', '/runs/run-other/files', { path: join(other, 'README.md') });
    expect([f.status, f.body['content']], f.text).toEqual([200, 'hello, changed\n']);
    const d = await get('system', '/runs/run-other/diff');
    expect(d.status, d.text).toBe(200);
    expect(String(d.body['diff'])).toContain('hello, changed');
  });

  it('the containment ladder still answers first: an unknown run 404s, a relative path 400s, a path outside every root 403s as before', async () => {
    expect((await get('agent', '/runs/nope/files', { path: join(worktree, 'apps.lock.json') })).status).toBe(404);
    expect((await get('agent', '/runs/run-app/files', { path: 'apps.lock.json' })).status).toBe(400);
    const outside = await get('agent', '/runs/run-app/files', { path: join(tmpdir(), 'nowhere.txt') });
    expect([outside.status, outside.body['code']]).toEqual([403, undefined]);
  });
});

describe('crew#1325: a non-human’s refused app query answers its code, never the policy detail', () => {
  const DETAIL = `the read policy refuses query pay now (relation): ${RELATION} is not a table of this source's catalog (describe the source again if it is new)`;
  let base: string;
  let app: FastifyInstance;
  let thrown: unknown;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-sec-views-2-query-'));
    const store = new AppStore({ stateFile: join(base, 'daemon-apps.json'), appsRoot: join(base, 'apps'), registry: { register: async (name, root) => ({ id: name, name, root_path: root, registered_at: 1, default_branch: 'main' }), idTaken: async () => false } });
    await store.create({ slug: 'desk', name: 'Desk', projectId: 'p1', actor: HUMAN });
    // The executor's refusal after the catalog moved (executor.ts, the SQL plan): its words name the relation.
    const executor = { runQuery: async () => { throw thrown; } } as unknown as AppExecutor;
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    registerAppRoutes(app, { store, audit: AuditLog.noop(), executor });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    removeScratch(base);
  });

  const query = async (as: keyof typeof TOKENS) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/apps/desk/query', headers: { authorization: `Bearer ${as}` }, payload: { version: 2, query: 'pay' } });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body, retryAfter: res.headers['retry-after'] };
  };

  it('NEGATIVE CONTROL: a system bearer’s refused query names no relation', async () => {
    thrown = new AppExecError(409, 'query_refused', DETAIL);
    const r = await query('system');
    expect([r.status, r.body['code']], r.text).toEqual([409, 'query_refused']);
    expect(r.text).not.toContain(RELATION);
    expect(r.body).toEqual({ code: 'query_refused', error: 'the query was not answered (query_refused)' });
  });

  it('REGRESSION: a human reads the refusal whole; agent and plugin actors are still refused before the executor', async () => {
    thrown = new AppExecError(409, 'query_refused', DETAIL);
    expect((await query('human')).body).toEqual({ code: 'query_refused', error: DETAIL });
    for (const as of ['agent', 'plugin'] as const) expect((await query(as)).body['code']).toBe('human_only');
  });

  it('codex r1: through the route, a human keeps a refusal’s findings and extras; a system bearer gets the code only', async () => {
    const findings = [{ code: 'bad_query', path: 'queries/pay.sql', message: `${RELATION} is not a table` }];
    thrown = new AppStoreError(409, 'unreadable_tree', `desk tree t cannot be read: ${RELATION}`, { findings: findings as never, head: 2 });
    expect((await query('human')).body).toEqual({ code: 'unreadable_tree', error: `desk tree t cannot be read: ${RELATION}`, findings, head: 2 });
    const sys = await query('system');
    expect([sys.status, sys.body]).toEqual([409, { code: 'unreadable_tree', error: 'the query was not answered (unreadable_tree)' }]);
  });

  it('NEGATIVE CONTROL (codex r1): an error crew did not name answers a system bearer a 500 with no words; a person’s 500 is as before', async () => {
    thrown = new SyntaxError(`Unexpected token 'f', "{"relations": [${RELATION}]}" is not valid JSON`);
    const sys = await query('system');
    expect(sys.status).toBe(500);
    expect(sys.text).not.toContain(RELATION);
    expect(sys.body['message']).toBe('the query was not answered (internal error)');
    const person = await query('human');
    expect(person.status).toBe(500);
    expect(person.text).toContain(RELATION);
  });

  it('a rate-limited system bearer still learns how long to wait', async () => {
    thrown = new AppExecError(429, 'rate_limited', `60 reads a minute per viewer of desk: ${RELATION}`, { retryAfterMs: 2_500 });
    const r = await query('system');
    expect([r.status, r.retryAfter]).toEqual([429, '3']);
    expect(r.body).toEqual({ code: 'rate_limited', error: 'the query was not answered (rate_limited)', retryAfterMs: 2_500 });
  });

  it('the projection: every non-human kind gets the code only, findings and words dropped; a human gets the body as is', () => {
    const body = { code: 'unreadable_tree', error: `queries/pay.sql reads ${RELATION}`, findings: [{ code: 'x', path: 'queries/pay.sql', message: RELATION }] };
    expect(appRefusalFor(HUMAN, body)).toBe(body);
    for (const actor of [AGENT, PLUGIN, SYSTEM, null]) expect(appRefusalFor(actor, body)).toEqual({ code: 'unreadable_tree', error: 'the query was not answered (unreadable_tree)' });
  });
});
