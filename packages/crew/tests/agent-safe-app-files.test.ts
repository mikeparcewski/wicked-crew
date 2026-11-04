// DES-KNOWLEDGE-DATA-001 §5.2: the agent-safe view, on two more reads (one rule: `viewOf` in api/auth.ts).
// - crew#1324: `GET /runs/:id/files` and `/diff` refuse a non-human actor an app repo's files (the lock's connection
//   descriptors, the query text, the actions), from a turn's live worktree, from its run branch after the worktree
//   is gone, and through another run's id. A human's reads are unchanged, and so are a non-human's other run files.
// - crew#1325: a refused `POST /apps/:app/query` answers a non-human (a `system` bearer: agent and plugin actors are
//   refused first) its status and code, never the policy detail that names the relation. A human reads it whole.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { registerAuthHooks } from '../src/api/auth.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { AppExecError, type AppExecutor } from '../src/apps/exec/executor.js';
import { registerAppRoutes } from '../src/apps/routes.js';
import { AppStore } from '../src/apps/store.js';
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

describe('crew#1324: a non-human GET /runs/:id/files and /diff refuse an app repo’s files', () => {
  let base: string;
  let appRoot: string;
  let worktree: string;
  let other: string;
  let app: FastifyInstance;

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
    // A run on another repo.
    other = join(base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(join(other, 'README.md'), 'hello\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'base');
    writeFileSync(join(other, 'README.md'), 'hello, changed\n');

    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-app', worktree, 'desk'),
        view('run-gone', join(appRoot, 'wicked-worktrees', 'run-gone'), 'desk', { run_branch: 'wicked/run-gone', base_commit: baseCommit }),
        view('run-other', other, null),
      ]),
      listRepos: vi.fn().mockResolvedValue([
        { id: 'desk', name: 'desk', root_path: appRoot, registered_at: 1, default_branch: 'main' },
        { id: 'other', name: 'other', root_path: other, registered_at: 1, default_branch: 'main' },
      ]),
    };
    const store = new AppStore({ stateFile: join(base, 'daemon-apps.json'), appsRoot, registry: { register: async () => { throw new Error('not in this test'); }, idTaken: async () => false } });
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'required' }, { apps: store });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    removeScratch(base);
  });

  const get = async (as: keyof typeof TOKENS, url: string, query: Record<string, string> = {}) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${url}`, query, headers: { authorization: `Bearer ${as}` } });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body };
  };
  /** Every read a non-human could reach an app's files by. */
  const reads = () => [
    ['/runs/run-app/files', { path: join(worktree, 'apps.lock.json') }],
    ['/runs/run-app/files', { path: join(worktree, 'queries', 'pay.sql') }],
    ['/runs/run-app/files', { path: join(worktree, 'apps.json') }],
    // Another run's id: every registered repo root is a contained root, the app's among them.
    ['/runs/run-other/files', { path: join(worktree, 'apps.lock.json') }],
    ['/runs/run-app/diff', {}],
    ['/runs/run-app/diff', { path: join(worktree, 'queries', 'pay.sql') }],
    // The run branch, after the worktree was removed.
    ['/runs/run-gone/diff', {}],
  ] as Array<[string, Record<string, string>]>;

  it('NEGATIVE CONTROL: agent, plugin and system bearers get 403 app_files_human_only: no descriptor host, no query text', async () => {
    // Every read is answered before any is judged, so a red run lists each one that leaks.
    const seen: Array<{ read: string; status: number; code: unknown; leaked: string[] }> = [];
    for (const as of ['agent', 'plugin', 'system'] as const) {
      for (const [url, query] of reads()) {
        const r = await get(as, url, query);
        const read = `${as} ${url}${query['path'] !== undefined ? ` ${query['path'].slice(worktree.length - 'run-app'.length)}` : ''}`;
        seen.push({ read, status: r.status, code: r.body['code'], leaked: LEAKS.filter((l) => r.text.includes(l)) });
      }
    }
    expect(seen).toEqual(seen.map(({ read }) => ({ read, status: 403, code: 'app_files_human_only', leaked: [] })));
  });

  it("REGRESSION: a human's run files and diff are unchanged (operator and observer)", async () => {
    for (const as of ['human', 'observer'] as const) {
      const lock = await get(as, '/runs/run-app/files', { path: join(worktree, 'apps.lock.json') });
      expect(lock.status, lock.text).toBe(200);
      expect(lock.body['content']).toBe(LOCK);
      expect((await get(as, '/runs/run-app/files', { path: join(worktree, 'queries', 'pay.sql') })).body['content']).toBe(QUERY);
      expect((await get(as, '/runs/run-other/files', { path: join(worktree, 'apps.json') })).body['content']).toBe(SPEC);
      const live = await get(as, '/runs/run-app/diff');
      expect([live.status, live.body['source']], live.text).toEqual([200, 'worktree']);
      for (const leak of LEAKS) expect(String(live.body['diff']), leak).toContain(leak);
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

  it('the containment ladder still answers first: an unknown run 404s and a path outside every root 403s as before', async () => {
    expect((await get('agent', '/runs/nope/files', { path: join(worktree, 'apps.lock.json') })).status).toBe(404);
    const outside = await get('agent', '/runs/run-app/files', { path: join(tmpdir(), 'nowhere.txt') });
    expect([outside.status, outside.body['code']]).toEqual([403, undefined]);
  });
});

describe('crew#1325: a non-human’s refused app query answers its code, never the policy detail', () => {
  const DETAIL = `the read policy refuses query pay now (relation): ${RELATION} is not a table of this source's catalog (describe the source again if it is new)`;
  let base: string;
  let app: FastifyInstance;
  let thrown: AppExecError;

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
