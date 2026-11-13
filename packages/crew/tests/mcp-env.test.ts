// SPDX-License-Identifier: MIT
// chat-extend CX1 — a stdio MCP server's non-secret `env`: the one validator, the schema, the spawned
// process, the preview hash and the Settings / agent views.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { McpServerConfigSchema, registerMcpRoutes } from '../src/api/mcp.js';
import type { McpPreviewResponse, McpServer } from '../src/core/types.js';
import { validateServerEnv } from '../src/mcp/env.js';
import { probeMcpServer, transportFor } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');
const SECRET_VAR = 'FIXTURE_TOKEN';
const SENTINEL = 'zz-public-value-9f3a';

describe('validateServerEnv', () => {
  const refused: Array<[string, Record<string, string>, string]> = [
    ['NODE_OPTIONS', { NODE_OPTIONS: SENTINEL }, 'reserved_name'],
    ['NPM_CONFIG_REGISTRY', { NPM_CONFIG_REGISTRY: 'https://example.test' }, 'reserved_name'],
    ['npm_config_userconfig', { npm_config_userconfig: '/tmp/rc' }, 'reserved_name'],
    ['API_TOKEN', { API_TOKEN: SENTINEL }, 'credential_name'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', { NODE_TLS_REJECT_UNAUTHORIZED: SENTINEL }, 'reserved_name'],
    ['node_tls_reject_unauthorized', { node_tls_reject_unauthorized: SENTINEL }, 'reserved_name'],
    ['OPENSSL_CONF', { OPENSSL_CONF: SENTINEL }, 'reserved_name'],
    ['PYTHONHTTPSVERIFY', { PYTHONHTTPSVERIFY: SENTINEL }, 'reserved_name'],
    ['HTTPS_PROXY', { HTTPS_PROXY: 'http://p' }, 'reserved_name'],
    ['LD_PRELOAD', { LD_PRELOAD: 'x.so' }, 'reserved_name'],
    ['1BAD', { '1BAD': 'x' }, 'bad_name'],
    [SECRET_VAR, { [SECRET_VAR]: SENTINEL }, 'secret_variable'],
    ['fixture_token', { fixture_token: SENTINEL }, 'secret_variable'],
    ['GREETING', { GREETING: 'ghp_' + 'a'.repeat(30) }, 'credential_value'],
    ['BIG', { BIG: 'x'.repeat(1025) }, 'value_too_long'],
  ];
  it.each(refused)('refuses %s with its name, a reason and no value', (name, env, code) => {
    const r = validateServerEnv(env, SECRET_VAR);
    expect(r?.code).toBe(code);
    expect(r?.name).toBe(name);
    expect(r?.message).toContain(name);
    for (const v of Object.values(env)) expect(r?.message).not.toContain(v);
  });

  it('refuses a 17th name, naming it', () => {
    const env = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`VAR_${i}`, 'v']));
    const r = validateServerEnv(env);
    expect(r).toMatchObject({ code: 'too_many', name: 'VAR_16' });
    expect(validateServerEnv(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`VAR_${i}`, 'v'])))).toBeNull();
  });

  it('accepts a plain env, refuses names equal without case', () => {
    expect(validateServerEnv({ LOG_LEVEL: 'debug', REGION: 'eu', 'x_1': 'y' }, SECRET_VAR)).toBeNull();
    expect(validateServerEnv({ A: '1', a: '2' })?.code).toBe('duplicate');
  });
});

describe('McpServerConfigSchema env', () => {
  const stdio = { name: 'fx', kind: 'mcp-stdio', command: 'node' };
  it('accepts env on mcp-stdio and refuses it elsewhere', () => {
    expect(McpServerConfigSchema.safeParse({ ...stdio, env: { LOG_LEVEL: 'debug' } }).success).toBe(true);
    const http = McpServerConfigSchema.safeParse({ name: 'h', kind: 'mcp-http', url: 'https://x.example/mcp', env: { LOG_LEVEL: 'debug' } });
    expect(http.success).toBe(false);
    expect(JSON.stringify(http.error?.issues)).toContain('env is for an mcp-stdio server');
  });
  it("judges against the server's own secret variable and long names through the validator", () => {
    const own = McpServerConfigSchema.safeParse({ ...stdio, auth: { ref: 'keychain:wicked-mcp/fx', env: SECRET_VAR }, env: { [SECRET_VAR]: 'x' } });
    expect(JSON.stringify(own.error?.issues)).toContain('secret_variable');
    const long = McpServerConfigSchema.safeParse({ ...stdio, env: { ['A'.repeat(65)]: 'x' } });
    expect(JSON.stringify(long.error?.issues)).toContain('bad_name');
  });
});

describe('transportFor', () => {
  it('reaches the spawned process, after the SDK env and before the secret', async () => {
    const script = `process.stderr.write(JSON.stringify({pub: process.env.WKD_PUBLIC, tok: process.env.${SECRET_VAR}}) + "\\n"); setTimeout(() => {}, 5000);`;
    const { transport, stderrTail } = transportFor(
      { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: ['-e', script], url: null, auth: { ref: 'env:X', env: SECRET_VAR }, env: { WKD_PUBLIC: SENTINEL } },
      'the-secret',
    );
    await transport.start();
    const deadline = Date.now() + 10_000;
    while (!stderrTail().includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await transport.close();
    expect(JSON.parse(stderrTail())).toEqual({ pub: SENTINEL, tok: 'the-secret' });
  });
});

class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  async get(a: string): Promise<string | null> { return this.values.get(a) ?? null; }
  async has(a: string): Promise<boolean> { return this.values.has(a); }
  async set(a: string, v: string): Promise<void> { this.values.set(a, v); }
  async delete(a: string): Promise<void> { this.values.delete(a); }
}

describe('the routes', () => {
  let base: string;
  let specPath: string;
  let app: FastifyInstance;
  let registry: McpRegistry;
  const config = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], ...extra });
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'crew-mcp-env-'));
    specPath = join(base, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ tools: [{ name: 'wt_echo', description: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }));
    registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets: new MemorySecretStore(), probe: probeMcpServer, discover: () => [], now: () => Date.parse('2026-11-13T12:00:00Z') });
    app = Fastify();
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit.log'), () => {}), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    removeScratch(base);
  });

  it('round-trips env through preview and save; the agent view has none; env changes the preview hash', async () => {
    const a = await post('/mcp/servers/preview', config({ env: { LOG_LEVEL: 'debug' } }));
    expect(a.statusCode, a.body).toBe(200);
    const b = await post('/mcp/servers/preview', config({ env: { LOG_LEVEL: 'info' } }));
    const none = await post('/mcp/servers/preview', config());
    const hashes = [a, b, none].map((r) => (r.json() as McpPreviewResponse).previewHash);
    expect(new Set(hashes).size).toBe(3);

    const saved = await post('/mcp/servers', { previewHash: hashes[0] });
    expect(saved.statusCode, saved.body).toBe(201);
    expect((saved.json() as McpServer).env).toEqual({ LOG_LEVEL: 'debug' });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/mcp/servers' });
    expect((listed.json() as { servers: McpServer[] }).servers[0]?.env).toEqual({ LOG_LEVEL: 'debug' });

    const agent = await registry.listForAgents();
    expect(JSON.stringify(agent)).not.toContain('LOG_LEVEL');
    expect(agent.servers[0]).not.toHaveProperty('env');
  });

  it('refuses a bad env at the preview, naming the variable and not the value, and env on mcp-http', async () => {
    const bad = await post('/mcp/servers/preview', config({ env: { NODE_OPTIONS: SENTINEL } }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('NODE_OPTIONS');
    expect(bad.body).not.toContain(SENTINEL);
    const http = await post('/mcp/servers/preview', { name: 'h', kind: 'mcp-http', url: 'https://x.example/mcp', env: { LOG_LEVEL: 'debug' } });
    expect(http.statusCode).toBe(400);
  });
});
