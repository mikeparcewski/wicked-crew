// DES-APPS-001 §5, §7.6 — the source routes over crew's one connector registry, against the shared
// fixture services (GraphQL, OpenAPI, the reference MCP server) and real uploads: describe, check,
// the G6 test call (named first, then sent exactly), uploads with sample rows for humans only.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { Actor, McpPreviewResponse, McpServer, SourceCatalogResponse, SourceTestCallResponse, SourceUploadResponse } from '../src/core/types.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { startGraphqlServer, startMcpServer, startOpenApiService } from './fixtures/apps-sources/servers.mjs';
import { makeSqlite } from './fixtures/apps-sources/uploads/make.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apps-sources', 'uploads');
const AGENT: Actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
const LOOP = { allow: ['127.0.0.0/8'] };

class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  async get(a: string): Promise<string | null> {
    return this.values.get(a) ?? null;
  }
  async has(a: string): Promise<boolean> {
    return this.values.has(a);
  }
  async set(a: string, v: string): Promise<void> {
    this.values.set(a, v);
  }
  async delete(a: string): Promise<void> {
    this.values.delete(a);
  }
}

type Fixture = { origin: string; hits: Array<{ method: string; path: string; body: string }>; close: () => Promise<void> };
let gql: Fixture;
let api: Fixture;
let mcp: Fixture;
beforeAll(async () => {
  gql = (await startGraphqlServer()) as Fixture;
  api = (await startOpenApiService()) as Fixture;
  mcp = (await startMcpServer()) as Fixture;
});
afterAll(async () => {
  await gql?.close();
  await api?.close();
  await mcp?.close();
});

let base = '';
const base0 = (): string => base;
let app: FastifyInstance;
let actor: Actor;
let audit: AuditLog;
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'apps-sources-routes-'));
  const registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets: new MemorySecretStore(), probe: probeMcpServer, discover: () => [] });
  audit = new AuditLog(join(base, 'audit.log'), () => undefined);
  actor = LOCAL_ACTOR;
  app = Fastify({ logger: false });
  registerMcpRoutes(app, { registry, audit, actorOf: () => actor });
  registerSourceRoutes(app, { registry, audit, actorOf: () => actor, snapshotDir: join(base, 'snapshots') });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

async function register(config: Record<string, unknown>): Promise<{ preview: McpPreviewResponse; server: McpServer }> {
  const p = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: config });
  expect(p.statusCode, p.body).toBe(200);
  const preview = p.json() as McpPreviewResponse;
  const s = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: preview.previewHash, ...(preview.egress?.confirmRequired === true ? { allowOrigin: preview.egress.origin } : {}) } });
  expect(s.statusCode, s.body).toBe(201);
  return { preview, server: s.json() as McpServer };
}

describe('a GraphQL source (DES §5.1)', () => {
  it('is described by introspection, has no tools, and checks documents: one query only', async () => {
    const { preview, server } = await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    expect(server.tools).toEqual([]);
    expect(server.descriptorHash).toMatch(/^[0-9a-f]{64}$/);
    const cat = preview.source?.catalog as { queries: Array<{ name: string }>; mutations: Array<{ name: string }>; enums: Array<{ name: string; values: string[] }> };
    expect(cat.queries.map((q) => q.name)).toEqual(['tickets', 'ticket']);
    expect(cat.mutations.map((m) => m.name)).toEqual(['assign']);
    expect(cat.enums.find((e) => e.name === 'Status')?.values).toEqual(['OPEN', 'CLOSED']);
    const check = (text: string) => app.inject({ method: 'POST', url: '/api/v1/sources/tix/check', payload: { text } }).then((r) => r.json() as { ok: boolean; code?: string; params?: string[] });
    expect(await check('query Open($s: Status) { tickets(status: $s) { id owner } }')).toMatchObject({ ok: true, params: ['s'] });
    expect(await check('mutation { assign(id: 1, owner: "x") { id } }')).toMatchObject({ ok: false, code: 'not_query' });
    expect(await check('query A { tickets { id } } query B { tickets { id } }')).toMatchObject({ ok: false, code: 'operations' });
    expect(await check('{ tickets { nope } }')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('G6: a test call names its request first and sends nothing; then sends exactly that request; humans only', async () => {
    await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    const doc = '{ tickets(status: CLOSED) { id status } }';
    const before = gql.hits.length;
    const named = (await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: doc } })).json() as Extract<SourceTestCallResponse, { sent: false }>;
    expect(named).toMatchObject({ sent: false, request: { kind: 'graphql', method: 'POST', url: `${gql.origin}/graphql` } });
    expect(gql.hits.length).toBe(before); // nothing sent yet
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: '{ tickets { id } }', confirm: named.requestHash } });
    expect(wrong.statusCode).toBe(409);
    actor = AGENT;
    expect((await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: doc, confirm: named.requestHash } })).statusCode).toBe(403);
    actor = LOCAL_ACTOR;
    const sent = (await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: doc, confirm: named.requestHash } })).json() as Extract<SourceTestCallResponse, { sent: true }>;
    expect(sent).toMatchObject({ sent: true, ok: true, status: 200 });
    expect(JSON.stringify(sent.result)).toContain('CLOSED');
    expect(gql.hits.length).toBe(before + 1); // exactly one request
    expect((await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: 'mutation { assign(id: 4800, owner: "x") { id } }' } })).statusCode).toBe(400);
    await audit.flush();
    expect((await audit.read()).filter((e) => e.action === 'apps.source.test_call')).toHaveLength(1);
  });

  it('a confirmation hash binds the destination: re-pointing the source name elsewhere makes it stale (codex r1)', async () => {
    const other = (await startGraphqlServer()) as Fixture;
    try {
      await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
      const doc = '{ tickets { id } }';
      const named = (await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: doc } })).json() as Extract<SourceTestCallResponse, { sent: false }>;
      await register({ name: 'tix', kind: 'graphql', url: `${other.origin}/graphql`, address: LOOP });
      const before = other.hits.length;
      const stale = await app.inject({ method: 'POST', url: '/api/v1/sources/tix/test-call', payload: { target: doc, confirm: named.requestHash } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'request_changed' });
      expect(other.hits.length).toBe(before); // nothing sent to the new destination on the old confirmation
    } finally {
      await other.close();
    }
  });

  it('a description taken under another descriptor is not the source\'s; the auth prefix is part of the descriptor (codex r1)', async () => {
    await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    const base = { name: 'x', kind: 'graphql' as const, command: null, args: [], url: 'https://g.example/graphql', auth: { ref: 'env:T', header: 'Authorization', prefix: 'Bearer ' } };
    expect(sourceDescriptorHash(base)).not.toBe(sourceDescriptorHash({ ...base, auth: { ...base.auth, prefix: 'Token ' } }));
    // A stale catalog file (another descriptor) reads as "not described".
    const cat = await app.inject({ method: 'GET', url: '/api/v1/sources/tix/catalog' });
    expect(cat.statusCode).toBe(200);
    const store = join(base0(), 'mcp', 'catalogs', 'tix.json');
    const stored = JSON.parse(readFileSync(store, 'utf8')) as { descriptorHash: string };
    writeFileSync(store, JSON.stringify({ ...stored, descriptorHash: 'f'.repeat(64) }));
    expect((await app.inject({ method: 'GET', url: '/api/v1/sources/tix/catalog' })).statusCode).toBe(404);
  });

  it('an unconfirmed loopback endpoint is refused at the preview with a code, and never contacted', async () => {
    const before = gql.hits.length;
    const p = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: { name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql` } });
    expect(p.statusCode).toBe(409);
    expect(p.json()).toMatchObject({ code: 'address_unconfirmed' });
    expect(gql.hits.length).toBe(before);
  });
});

describe('the OpenAPI test service and the reference MCP server as sources', () => {
  it('REST: a test call on a read operation returns its nested page; a write operation is refused', async () => {
    await register({ name: 'tickets', kind: 'rest', url: `${api.origin}/v1`, openapiUrl: `${api.origin}/openapi.json`, address: LOOP });
    const named = (await app.inject({ method: 'POST', url: '/api/v1/sources/tickets/test-call', payload: { target: 'listTickets', args: { page: 2 } } })).json() as Extract<SourceTestCallResponse, { sent: false }>;
    expect(named.request).toMatchObject({ kind: 'rest', method: 'GET', url: `${api.origin}/v1/tickets?page=2` });
    const sent = (await app.inject({ method: 'POST', url: '/api/v1/sources/tickets/test-call', payload: { target: 'listTickets', args: { page: 2 }, confirm: named.requestHash } })).json() as Extract<SourceTestCallResponse, { sent: true }>;
    expect(sent).toMatchObject({ sent: true, ok: true, status: 200 });
    expect(sent.result).toMatchObject({ data: { page: { number: 2, next: 3 } } });
    const write = await app.inject({ method: 'POST', url: '/api/v1/sources/tickets/test-call', payload: { target: 'assignTicket', args: { id: 4800, owner: 'x' } } });
    expect(write.statusCode).toBe(409); // a write tool is registered disabled: never a test call
  });

  it('MCP: a read tool can be test-called; nothing is sent before the confirmation', async () => {
    await register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    const before = mcp.hits.length;
    const named = (await app.inject({ method: 'POST', url: '/api/v1/sources/ref/test-call', payload: { target: 'list_tickets', args: { status: 'CLOSED' } } })).json() as Extract<SourceTestCallResponse, { sent: false }>;
    expect(named.request).toMatchObject({ kind: 'mcp', tool: 'list_tickets' });
    expect(mcp.hits.length).toBe(before);
    const sent = (await app.inject({ method: 'POST', url: '/api/v1/sources/ref/test-call', payload: { target: 'list_tickets', args: { status: 'CLOSED' }, confirm: named.requestHash } })).json() as Extract<SourceTestCallResponse, { sent: true }>;
    expect(sent).toMatchObject({ sent: true, ok: true });
    expect(JSON.stringify(sent.result)).toContain('CLOSED');
  });
});

describe('uploads (DES §5.1): a file becomes a sql/sqlite source', () => {
  it('a CSV: the source is registered, its first rows answered to a human only, the catalog and check work', async () => {
    const csv = readFileSync(join(FIX, 'with-header.csv'));
    const up = await app.inject({ method: 'POST', url: '/api/v1/apps/uploads?name=refunds&filename=refunds.csv', headers: { 'content-type': 'application/octet-stream' }, payload: csv });
    expect(up.statusCode, up.body).toBe(201);
    const body = up.json() as SourceUploadResponse;
    expect(body.source).toMatchObject({ name: 'refunds', kind: 'sql', sql: { driver: 'sqlite', snapshot: body.snapshot.digest } });
    expect(body.header?.detected).toBe(true);
    expect(body.sample).toHaveLength(3);
    actor = AGENT;
    const agentUp = await app.inject({ method: 'POST', url: '/api/v1/apps/uploads?name=refunds2&filename=refunds.csv', headers: { 'content-type': 'application/octet-stream' }, payload: csv });
    expect(agentUp.statusCode).toBe(201);
    expect((agentUp.json() as SourceUploadResponse).sample).toEqual([]); // values never to an agent
    actor = LOCAL_ACTOR;
    const cat = (await app.inject({ method: 'GET', url: '/api/v1/sources/refunds/catalog' })).json() as SourceCatalogResponse;
    expect(cat).toMatchObject({ kind: 'sql', catalog: { dialect: 'sqlite' } });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/sources/refunds/check', payload: { text: 'SELECT region, sum(amount) FROM refunds GROUP BY region' } });
    expect(ok.json()).toMatchObject({ ok: true, columns: [{ name: 'region' }, { name: 'sum(amount)' }] });
    const rec = await app.inject({ method: 'POST', url: '/api/v1/sources/refunds/check', payload: { text: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r' } });
    expect(rec.statusCode).toBe(200); // a refusal is a check RESULT, the same shape for every dialect (pi r1)
    expect(rec.json()).toMatchObject({ ok: false, code: 'authorizer' });
    const named = await app.inject({ method: 'POST', url: '/api/v1/sources/refunds/check', payload: { text: 'SELECT * FROM refunds WHERE id = :id' } });
    expect(named.json()).toMatchObject({ ok: false, code: 'params' });
  });

  it('a .sqlite holding a trigger is refused with its code; a name another kind holds is refused', async () => {
    makeSqlite(join(base, 't.sqlite'), { trigger: true });
    const r = await app.inject({ method: 'POST', url: '/api/v1/apps/uploads?name=trig&filename=t.sqlite', headers: { 'content-type': 'application/octet-stream' }, payload: readFileSync(join(base, 't.sqlite')) });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'sqlite_code' });
    await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    const taken = await app.inject({ method: 'POST', url: '/api/v1/apps/uploads?name=tix&filename=x.csv', headers: { 'content-type': 'application/octet-stream' }, payload: readFileSync(join(FIX, 'no-header.csv')) });
    expect(taken.statusCode).toBe(409);
  });
});

describe('the registry kinds and the built-in crew source', () => {
  it('sql and graphql configs are validated; `crew` is reserved; Allow writes is Postgres only', async () => {
    const bad = [
      { name: 'x', kind: 'sql' },
      { name: 'x', kind: 'sql', sql: { driver: 'postgres', host: 'db', database: 'd', user: 'u' }, url: 'https://x' },
      { name: 'x', kind: 'sql', sql: { driver: 'sqlite', host: 'db', database: 'd', user: 'u' } },
      { name: 'x', kind: 'sql', sql: { driver: 'postgres', host: 'db', database: 'd', user: 'u' }, auth: { ref: 'env:PW', header: 'X' } },
      { name: 'x', kind: 'graphql', url: 'ftp://x/graphql' },
      { name: 'x', kind: 'rest', url: 'https://x', openapiUrl: 'https://x/o', sql: { driver: 'postgres', host: 'db', database: 'd', user: 'u' } },
    ];
    for (const payload of bad) expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload })).statusCode, JSON.stringify(payload)).toBe(400);
    const crew = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: { name: 'crew', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP } });
    expect(crew.statusCode).toBe(400);
    expect(crew.json()).toMatchObject({ code: 'reserved_name' });
    await register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/sources/tix/allow-writes', payload: { allowed: true } })).statusCode).toBe(400);
    const builtin = (await app.inject({ method: 'GET', url: '/api/v1/sources/crew/catalog' })).json() as SourceCatalogResponse;
    expect(builtin.kind).toBe('crew');
    expect((builtin.catalog as { routes: Array<{ path: string }> }).routes.map((r) => r.path)).toContain('/runs');
  });
});
