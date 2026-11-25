// crew#1514 — renaming a source: `POST /mcp/servers/:name/rename`.
//
// Driven over the same rig as the policy tests: a REAL engine (a stub-runner CoreAdapter on a scratch store, which seeds
// the `mcp-defaults` pack) and a real stdio MCP server (tests/fixtures/mcp/fixture-server.mjs). Every entry is made
// through the product's own preview + save routes, never a hand-written record.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, ConformanceRule, McpPolicyPreviewResponse, McpPreviewResponse, McpServer } from '../src/core/types.js';
import { FIRST_USE_LEDGER, McpPolicies, WRITE_LEDGER } from '../src/mcp/policies.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { keychainRef, type SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

const TOOLS = [
  { name: 'wt_echo', description: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'wt_note', description: 'write a note', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];

let base: string;
let specPath: string;
let adapter: CoreAdapter;
let app: FastifyInstance;
let audit: AuditLog;
let registry: McpRegistry;
let actor: Actor;
let usingApps: Array<{ slug: string; name: string }>;
/** An in-memory keychain: account -> value. */
let keychain: Map<string, string>;

function secrets(): SecretStore {
  return {
    available: true,
    get: async (a) => keychain.get(a) ?? null,
    has: async (a) => keychain.has(a),
    set: async (a, v) => { keychain.set(a, v); },
    delete: async (a) => { keychain.delete(a); },
  };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** Register `name` through preview + save, with its own keychain entry staged when `secret` is given. */
async function register(name: string, secret?: string): Promise<McpServer> {
  const auth = secret === undefined ? {} : { auth: { ref: keychainRef(name), env: 'FX_TOKEN' }, secret };
  const preview = await call('POST', '/mcp/servers/preview', { name, kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], ...auth });
  expect(preview.statusCode, preview.body).toBe(200);
  const body = preview.json() as McpPreviewResponse;
  const saved = await call('POST', '/mcp/servers', { previewHash: body.previewHash, enabledWrites: ['wt_note'] });
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json() as McpServer;
}

async function rule(id: string): Promise<ConformanceRule | undefined> {
  return (await adapter.listConformanceRules()).find((r) => r.id === id);
}

async function upsert(r: Partial<ConformanceRule> & { id: string }): Promise<void> {
  await adapter.upsertConformanceRule({
    rule_type: 'policy', severity: 'error', confidence: 1, targets: {}, steering_type: 'security',
    provenance: { source: 'ui', ref: 'test', source_kinds: ['doc'] }, statement: r.id, ...r,
  } as ConformanceRule);
}

async function matrix(server: string): Promise<McpPolicyPreviewResponse> {
  const res = await call('POST', '/mcp/policies/preview', { server });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as McpPolicyPreviewResponse;
}

async function auditEvents(): Promise<Array<{ action: string; detail?: Record<string, unknown> }>> {
  await audit.flush();
  return audit.read({ limit: 500 });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-rename-'));
  specPath = join(base, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ tools: TOOLS }));
  keychain = new Map();
  actor = LOCAL_ACTOR;
  usingApps = [];
  adapter = new CoreAdapter({ dbPath: join(base, 'core.db'), stub: true });
  registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets: secrets(), probe: probeMcpServer, discover: () => [] });
  const policies = new McpPolicies(registry, {
    listRules: () => adapter.listConformanceRules(),
    upsertRule: (r) => adapter.upsertConformanceRule(r),
    previewCalls: (j) => adapter.previewMcpCalls(j),
  });
  audit = new AuditLog(join(base, 'audit.log'), () => undefined);
  app = Fastify();
  registerMcpRoutes(app, { registry, policies, audit, actorOf: () => actor, appsUsing: async () => usingApps });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  removeScratch(base);
});

describe('renaming a source (crew#1514)', () => {
  it('keeps the entry: its id, secret reference, granted writes and switch; the old name is gone and retired', async () => {
    const before = await register('fx', 'fixture-tok-1');
    const res = await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as McpServer;
    expect(after.name).toBe('fx2');
    expect(after.id).toBe(before.id);
    expect(after.auth?.ref).toBe(keychainRef('fx'));
    expect(after.keychainAccount).toBe('fx');
    expect(after.formerNames).toEqual(['fx']);
    expect(after.authState).toBe('set');
    expect(after.tools.map((t) => [t.subject, t.enabled])).toEqual([['mcp:fx2/wt_echo', true], ['mcp:fx2/wt_note', true]]);
    expect((await call('GET', '/mcp/servers')).json().servers.map((s: McpServer) => s.name)).toEqual(['fx2']);
    expect((await auditEvents()).some((e) => e.action === 'mcp.server.renamed' && e.detail?.['from'] === 'fx' && e.detail?.['to'] === 'fx2' && e.detail?.['id'] === before.id)).toBe(true);
  });

  it('keeps using the secret it was saved with: a re-key and a removal reach the old account, and nothing else', async () => {
    await register('fx', 'fixture-tok-1');
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' })).statusCode).toBe(200);
    const rekey = await call('PUT', '/mcp/servers/fx2/secret', { value: 'fixture-tok-2' });
    expect(rekey.statusCode, rekey.body).toBe(200);
    expect([...keychain.entries()]).toEqual([['fx', 'fixture-tok-2']]);
    expect((await call('DELETE', '/mcp/servers/fx2')).statusCode).toBe(200);
    expect(keychain.size).toBe(0);
  });

  it('retires the old name while the renamed entry lives: a new save (with or without a secret) or a rename to it is refused, a rename back is not', async () => {
    await register('fx', 'fixture-tok-1');
    await register('other');
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' })).statusCode).toBe(200);
    for (const body of [
      { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] },
      { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], auth: { ref: keychainRef('fx'), env: 'FX_TOKEN' } },
      { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], auth: { ref: keychainRef('fx'), env: 'FX_TOKEN' }, secret: 'fixture-evil' },
    ]) {
      const res = await call('POST', '/mcp/servers/preview', body);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('name_retired');
    }
    expect(keychain.get('fx')).toBe('fixture-tok-1');
    const taken = await call('POST', '/mcp/servers/other/rename', { to: 'fx' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('name_retired');
    const back = await call('POST', '/mcp/servers/fx2/rename', { to: 'fx' });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().formerNames).toEqual(['fx2']);
    expect(back.json().keychainAccount).toBeUndefined();
  });

  it('refuses a preview held across the rename before it writes any secret', async () => {
    await register('fx', 'fixture-tok-1');
    const held = await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], auth: { ref: keychainRef('fx'), env: 'FX_TOKEN' }, secret: 'fixture-tok-9' });
    expect(held.statusCode, held.body).toBe(200);
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' })).statusCode).toBe(200);
    const saved = await call('POST', '/mcp/servers', { previewHash: (held.json() as McpPreviewResponse).previewHash });
    expect(saved.statusCode).toBe(409);
    expect(keychain.get('fx')).toBe('fixture-tok-1');
  });

  it('copies approvals and denies to the new name, and drops approvals a removed source left under it', async () => {
    await register('fx');
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:fx' })).statusCode).toBe(200);
    expect((await call('POST', '/mcp/approvals', { subject: 'mcp:fx/wt_note' })).statusCode).toBe(200);
    await upsert({ id: 'SEC-FX-NO-NOTE', applies_to: ['mcp:fx/wt_note'], effect: 'deny', severity: 'critical' });
    // A token another source left behind under the new name.
    const ledger = (await rule(FIRST_USE_LEDGER))!;
    await adapter.upsertConformanceRule({ ...ledger, excludes: [...(ledger.excludes ?? []), 'mcp:fx2/wt_echo'] });

    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' })).statusCode).toBe(200);
    expect((await rule(FIRST_USE_LEDGER))!.excludes).toEqual(expect.arrayContaining(['mcp:fx', 'mcp:fx/wt_note', 'mcp:fx2', 'mcp:fx2/wt_note']));
    expect((await rule(FIRST_USE_LEDGER))!.excludes).not.toContain('mcp:fx2/wt_echo');
    expect((await rule(WRITE_LEDGER))!.excludes).toEqual(expect.arrayContaining(['mcp:fx2/wt_note']));
    expect((await rule('SEC-FX-NO-NOTE'))!.applies_to).toEqual(['mcp:fx/wt_note', 'mcp:fx2/wt_note']);
    const note = (await matrix('fx2')).tools.find((t) => t.tool === 'wt_note')!;
    expect(note.cells.every((c) => c.decision === 'deny')).toBe(true);
  });

  it('refuses when a rule matches the source by its content, and leaves rules and registry as they were', async () => {
    await register('fx');
    await upsert({ id: 'SEC-FX-BY-TEXT', applies_to: ['mcp'], effect: 'deny', severity: 'critical', trigger: { contains: '"server":"fx"' } });
    const rulesBefore = JSON.stringify(await adapter.listConformanceRules());
    const res = await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('rules_differ');
    expect(res.json().subjects).toEqual(['mcp:fx/wt_echo', 'mcp:fx/wt_note']);
    expect(JSON.stringify(await adapter.listConformanceRules())).toBe(rulesBefore);
    expect((await call('GET', '/mcp/servers')).json().servers.map((s: McpServer) => s.name)).toEqual(['fx']);
  });

  it('lists the apps that use the source and renames once the request names exactly them', async () => {
    await register('fx');
    usingApps = [{ slug: 'board', name: 'Board' }];
    const first = await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' });
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ code: 'apps_bound', apps: [{ slug: 'board', name: 'Board' }] });
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2', apps: ['board', 'extra'] })).json().code).toBe('apps_bound');
    const ok = await call('POST', '/mcp/servers/fx/rename', { to: 'fx2', apps: ['board'] });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("is a human operator's only, and refuses reserved, taken and unchanged names", async () => {
    await register('fx');
    await register('fy');
    for (const [to, code] of [['fy', 'name_taken'], ['web', 'reserved_name'], ['apps', 'reserved_name'], ['estate', 'reserved_name'], ['crew', 'reserved_name'], ['fx', 'name_unchanged']] as const) {
      const res = await call('POST', '/mcp/servers/fx/rename', { to });
      expect(res.statusCode, `${to}: ${res.body}`).toBe(409);
      expect(res.json().code).toBe(code);
    }
    expect((await call('POST', '/mcp/servers/nope/rename', { to: 'x1' })).statusCode).toBe(404);
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'Bad Name' })).statusCode).toBe(400);
    actor = { id: 'seat:x', kind: 'agent', trust: 'admin' };
    const agent = await call('POST', '/mcp/servers/fx/rename', { to: 'fx3' });
    expect(agent.statusCode).toBe(403);
    expect(agent.json().code).toBe('rename_human_only');
  });

  it('refuses to restore a generation that holds the entry under its old name', async () => {
    await register('fx');
    const { current } = (await call('GET', '/mcp/registry/generations')).json() as { current: number };
    expect((await call('POST', '/mcp/servers/fx/rename', { to: 'fx2' })).statusCode).toBe(200);
    const res = await call('POST', '/mcp/registry/restore', { generation: current });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('restore_crosses_rename');
  });

  it('a new registration never inherits approvals left under its name', async () => {
    const ledger = (await rule(FIRST_USE_LEDGER))!;
    await adapter.upsertConformanceRule({ ...ledger, excludes: [...(ledger.excludes ?? []), 'mcp:fz', 'mcp:fz/wt_echo'] });
    await register('fz');
    expect((await rule(FIRST_USE_LEDGER))!.excludes ?? []).not.toEqual(expect.arrayContaining(['mcp:fz']));
    expect((await rule(FIRST_USE_LEDGER))!.excludes ?? []).not.toContain('mcp:fz/wt_echo');
  });
});
