// The Apps K2b harness: crew's connector registry (sources saved through the real preview/save routes),
// the source routes, the app store with the REAL source stage, and the app routes, on one Fastify instance
// with bearer tokens naming actors. Each harness lives in its own temp dir; `close()` removes it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { expect } from 'vitest';

import { AuditLog } from '../../src/api/audit.js';
import { LOCAL_ACTOR, registerAuthHooks } from '../../src/api/auth.js';
import { registerMcpRoutes } from '../../src/api/mcp.js';
import { AppsSourceStage } from '../../src/apps/exec/source-stage.js';
import { registerAppRoutes } from '../../src/apps/routes.js';
import { AppStore, type AppRepoRegistry } from '../../src/apps/store.js';
import type { Actor, AppDetail, AppSpec, McpPreviewResponse, McpServer } from '../../src/core/types.js';
import { probeMcpServer } from '../../src/mcp/probe.js';
import { McpRegistry } from '../../src/mcp/registry.js';
import { McpRegistryStore } from '../../src/mcp/registry-store.js';
import type { SecretStore } from '../../src/mcp/secrets.js';
import { registerSourceRoutes } from '../../src/sources/routes.js';
import { LOOPBACK } from './sources-db.js';

export const PRIYA: Actor = { id: 'priya', kind: 'human', trust: 'operator' };
export const SAM: Actor = { id: 'sam', kind: 'human', trust: 'operator' };
export const SEAT: Actor = { id: 'seat-codex', kind: 'agent', trust: 'operator' };
export const VIEWER: Actor = { id: 'olga', kind: 'human', trust: 'observer' };
const TOKENS: Record<string, Actor> = { priya: PRIYA, sam: SAM, seat: SEAT, olga: VIEWER };

export interface Harness {
  dir: string;
  app: FastifyInstance;
  registry: McpRegistry;
  store: AppStore;
  audit: AuditLog;
  env: Record<string, string>;
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, as?: keyof typeof TOKENS): Promise<{ status: number; body: Record<string, unknown> & { code?: string } }>;
  /** Save any server through the real preview/save (a REST origin the spec does not list is confirmed). */
  register(config: Record<string, unknown>): Promise<McpServer>;
  /** Save a Postgres source through the real preview/save, with its password in an env secret. */
  addPg(name: string, opts: { port: number; database: string; user: string; password: string }): Promise<McpServer>;
  /** A new app (priya's first version). */
  newApp(slug: string): Promise<AppDetail>;
  /** Land `spec` (+ query texts) on the app's head as priya; answers the route's reply. */
  land(slug: string, spec: AppSpec, texts?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> & { code?: string; app?: AppDetail } }>;
  close(): Promise<void>;
}

export async function appsHarness(opts: { extra?: (app: FastifyInstance, h: Pick<Harness, 'registry' | 'store' | 'audit'>) => void | Promise<void> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'apps-k2b-'));
  const env: Record<string, string> = {};
  const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
  const registry = new McpRegistry({ store: new McpRegistryStore(join(dir, 'mcp')), secrets, probe: probeMcpServer, discover: () => [], env });
  const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
  const repos = new Map<string, string>();
  const repoRegistry: AppRepoRegistry = {
    register: async (name, root) => {
      repos.set(name, root);
      return { id: name, name, root_path: root, registered_at: 1, default_branch: 'main' };
    },
    idTaken: async (id) => repos.has(id),
  };
  const store = new AppStore({ stateFile: join(dir, 'daemon-apps.json'), appsRoot: join(dir, 'apps'), registry: repoRegistry, sourceStage: new AppsSourceStage({ registry }) });
  const app = Fastify({ logger: false });
  registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
  const actorOf = (req: { actor?: Actor | null }): Actor => req.actor ?? LOCAL_ACTOR;
  registerMcpRoutes(app, { registry, audit, actorOf });
  registerSourceRoutes(app, { registry, audit, actorOf });
  registerAppRoutes(app, { store, audit });
  await opts.extra?.(app, { registry, store, audit });
  await app.ready();
  const call: Harness['call'] = async (method, url, payload, as = 'priya') => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${as}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = { raw: res.body };
    }
    return { status: res.statusCode, body };
  };
  const h: Harness = {
    dir,
    app,
    registry,
    store,
    audit,
    env,
    call,
    async register(config) {
      const p = await call('POST', '/mcp/servers/preview', config);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const preview = p.body as unknown as McpPreviewResponse;
      const saved = await call('POST', '/mcp/servers', { previewHash: preview.previewHash, ...(preview.egress?.confirmRequired === true ? { allowOrigin: preview.egress.origin } : {}) });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      return saved.body as unknown as McpServer;
    },
    async addPg(name, o) {
      const ref = `APPS_K2B_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      env[ref] = o.password;
      const config = { name, kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: o.port, database: o.database, user: o.user, tls: 'disable' }, auth: { ref: `env:${ref}` }, address: LOOPBACK };
      const p = await call('POST', '/mcp/servers/preview', config);
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const saved = await call('POST', '/mcp/servers', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      return saved.body as unknown as McpServer;
    },
    async newApp(slug) {
      const r = await call('POST', '/apps', { slug, projectId: 'p1' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body as { app: AppDetail }).app;
    },
    async land(slug, spec, texts = {}) {
      const head = (await store.detail(slug)).head.version;
      const ops = [{ op: 'spec', spec }, ...Object.entries(texts).map(([query, text]) => ({ op: 'query-text', query, text }))];
      return call('POST', `/apps/${slug}/edits`, { base: head, ops }) as Promise<{ status: number; body: Record<string, unknown> & { code?: string; app?: AppDetail } }>;
    },
    async close() {
      await app.close();
      await audit.flush();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** A one-page spec over `queries` and `actions`, with a table per query so every query is used. */
export function specWith(queries: AppSpec['queries'], actions: AppSpec['actions'] = [], extra: Partial<AppSpec> = {}): AppSpec {
  return {
    schema: 'wicked.apps/v1',
    name: 'K2b',
    pages: [
      {
        id: 'page-1',
        title: 'Page 1',
        components: [{ id: 'note', type: 'text', box: { x: 0, y: 0, w: 4, h: 1 }, text: 'k2b' }],
      },
    ],
    queries,
    actions,
    linkHosts: [],
    ...extra,
  };
}
