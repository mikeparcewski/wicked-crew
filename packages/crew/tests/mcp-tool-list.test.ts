// DES-MCP-TOOLS-001 slice S4 — the unit's tool list (`POST /api/v1/mcp/tools`, src/mcp/tool-list.ts),
// what the garden shim's `list` shows a worker.
//
// The registry is real (a stdio fixture server, previewed and saved); the engine's lister is a fake,
// because only core's carriers mint a capability token (core's own test judges the list:
// src/mcp_gate.rs `the_tool_list_is_the_units_own_judgement_and_records_nothing`). One test drives
// the LINKED engine; the end to end over a real unit's token is tests/integration/mcp-shim-e2e.test.ts.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { McpPreviewResponse, McpToolsResponse } from '../src/core/types.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const CALL_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'call-server.mjs');
const TOKEN = 'wmt_the_units_token_0123456789';

const noSecrets: SecretStore = {
  available: true,
  get: async () => null,
  has: async () => false,
  set: async () => undefined,
  delete: async () => undefined,
};

interface ListCall {
  server: string;
  tool: string;
  registered: boolean;
  annotations: Record<string, boolean> | null;
  classOverride: string | null;
  kind: string;
}

let base: string;
let registry: McpRegistry;
let app: FastifyInstance;
let logs: string[];
let requests: Array<{ token: string; calls: ListCall[] }>;
let lister: ((json: string) => Promise<string>) | null;

/** The engine as a fake: an evaluator-shaped unit — reads allowed, `wt_note` left out as a certain deny. */
async function fakeList(json: string): Promise<string> {
  const req = JSON.parse(json) as { token: string; calls: ListCall[] };
  requests.push(req);
  if (req.token !== TOKEN) throw new Error('invalid_token: the MCP token is not bound to a running unit');
  return JSON.stringify({
    unit: { runId: 'run-1', ord: 2, attempt: 0, phase: 'unit-2', seat: 'pi' },
    tools: req.calls
      .filter((c) => c.tool !== 'wt_note')
      .map((c) => ({
        subject: `mcp:${c.server}/${c.tool}`,
        class: c.annotations?.['readOnlyHint'] === true ? 'read' : 'destructive',
        decision: c.tool === 'wt_echo' ? 'allow' : 'ask',
        ruleIds: c.tool === 'wt_echo' ? [] : ['MCP-FIRST-USE'],
        ...(c.tool === 'wt_echo' ? {} : { reason: 'waits for approval' }),
      })),
  });
}

async function boot(withLister = true): Promise<void> {
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  app = Fastify({ logger: { level: 'trace', stream } });
  registerMcpRoutes(app, {
    registry,
    ...(withLister ? { toolLister: () => lister } : {}),
    audit: new AuditLog(join(base, 'audit.log'), (m) => logs.push(m)),
    actorOf: () => LOCAL_ACTOR,
  });
  await app.ready();
}

async function list(body: unknown): Promise<{ status: number; body: McpToolsResponse & { code?: string; error?: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/tools', payload: body as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-tool-list-'));
  mkdirSync(join(base, 'counters'));
  logs = [];
  requests = [];
  lister = fakeList;
  registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets: noSecrets, probe: probeMcpServer, discover: () => [] });
  const preview = (await registry.preview({
    name: 'fx',
    kind: 'mcp-stdio',
    command: process.execPath,
    args: [CALL_SERVER, join(base, 'counters')],
    url: null,
    auth: null,
  })) as McpPreviewResponse;
  await registry.save(preview.previewHash);
});

afterEach(async () => {
  await app?.close();
  removeScratch(base);
});

describe('PROVING (S4): POST /mcp/tools answers the unit its own tools', () => {
  it('judges every callable tool for the token and answers the kept ones with their schema', async () => {
    await boot();
    const r = await list({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.unit).toEqual({ runId: 'run-1', ord: 2, attempt: 0, phase: 'unit-2', seat: 'pi' });
    const subjects = r.body.tools.map((t) => t.subject);
    expect(subjects).toContain('mcp:fx/wt_echo');
    expect(subjects, 'a certain deny is left out').not.toContain('mcp:fx/wt_note');
    const echo = r.body.tools.find((t) => t.subject === 'mcp:fx/wt_echo');
    expect(echo).toMatchObject({ class: 'read', decision: 'allow', ruleIds: [], description: 'echo' });
    expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    expect(r.body.tools.find((t) => t.subject === 'mcp:fx/wt_flaky_read')).toMatchObject({ decision: 'ask', reason: 'waits for approval' });
    // The engine was handed the registry's view: registered, annotated, the upstream kind.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.calls.find((c) => c.tool === 'wt_note')).toEqual({
      server: 'fx',
      tool: 'wt_note',
      annotations: { destructiveHint: true },
      classOverride: null,
      registered: true,
      kind: 'mcp-stdio',
    });
  });

  it('never offers a disabled tool or a disabled server (D-5): the engine is not even asked about them', async () => {
    await registry.patchTool('mcp:fx/wt_flaky_read', { enabled: false });
    await boot();
    const r = await list({ token: TOKEN });
    expect(r.body.tools.map((t) => t.subject)).not.toContain('mcp:fx/wt_flaky_read');
    expect(requests[0]?.calls.map((c) => c.tool)).not.toContain('wt_flaky_read');
    await registry.setServerEnabled('fx', false);
    const off = await list({ token: TOKEN });
    expect(off.status).toBe(200);
    expect(off.body.tools).toEqual([]);
    expect(requests[1]?.calls).toEqual([]);
  });

  it('the token stays out of every log line', async () => {
    await boot();
    await list({ token: TOKEN });
    await list({ token: 'wmt_forged' });
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('wmt_forged');
  });
});

describe('refusals', () => {
  it('a token no unit is bound to is 401, a malformed body 400, a missing lister 503', async () => {
    await boot();
    const bad = await list({ token: 'wmt_forged' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('invalid_token');
    expect((await list({ token: TOKEN, extra: 1 })).status).toBe(400);
    expect((await list({})).status).toBe(400);
    lister = null;
    const none = await list({ token: TOKEN });
    expect(none.status).toBe(503);
    expect(none.body.code).toBe('mcp_unavailable');
    await app.close();
    await boot(false);
    expect((await list({ token: TOKEN })).status).toBe(503);
  });

  it('an engine that cannot judge answers guard_error, never a list', async () => {
    lister = async () => {
      throw new Error('guard_error: policy store open failed');
    };
    await boot();
    const r = await list({ token: TOKEN });
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('guard_error');
    expect(r.body.tools).toBeUndefined();
  });
});

describe('the wiring', () => {
  it('the linked engine carries listMcpTools and refuses a token no unit is bound to', async () => {
    const linked = CoreAdapter.mcpToolLister();
    expect(linked, 'the linked wicked-core-ts carries listMcpTools').not.toBeNull();
    lister = linked;
    await boot();
    const r = await list({ token: 'wmt_nobody' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_token');
  });
});
