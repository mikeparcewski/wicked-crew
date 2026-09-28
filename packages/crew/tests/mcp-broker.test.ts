// DES-MCP-TOOLS-001 slice S3 — the MCP broker's call path (`POST /api/v1/mcp/call`, src/mcp/broker.ts).
//
// The slice's proving tests:
//   1. a crashing post hook (the output decision) gives `guard_error` and a refusal: no result;
//   2. a seeded secret comes back scrubbed, and reaches no response, record, log or output decision;
//   3. a non-idempotent (write) tool is never retried, while a read tool is, on transport errors only;
//   4. a failing record write refuses the call: its result is withheld.
//
// A real stdio MCP server answers the calls (tests/fixtures/mcp/call-server.mjs), registered through
// the real registry (preview, then save). The engine's gate is a fake here because only core's
// carriers can mint a capability token; core's own tests judge the calls (src/mcp_gate.rs,
// src/mcp_gate/output.rs). One test drives the LINKED engine to prove the wiring refuses an
// unbound token.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { brokerUrlFor } from '../src/api/server.js';
import { CoreAdapter, type McpEngineGate } from '../src/core/adapter.js';
import type { McpCallRecord, McpCallResponse, McpPreviewResponse } from '../src/core/types.js';
import { BREAKER_OPEN_MS, BREAKER_THRESHOLD, budgetFromEnv, McpBroker, type McpBrokerDeps } from '../src/mcp/broker.js';
import { McpCallRecordFile, type McpCallRecordSink } from '../src/mcp/call-records.js';
import { deriveToolClass } from '../src/mcp/classify.js';
import { classifyUpstreamError } from '../src/mcp/invoke.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { redactDeep } from '../src/mcp/redact.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { SECRET_REDACTION, type SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const CALL_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'call-server.mjs');

class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

interface CallJson {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  annotations: Record<string, boolean> | null;
  classOverride: string | null;
  registered: boolean;
}

/**
 * The engine's gate as a fake: `decide` answers each call (default allow), `output` each result
 * (default allow). Every request is kept so a test can read what the engine was handed.
 */
class FakeGate implements McpEngineGate {
  calls: Array<{ token: string; call: CallJson }> = [];
  outputs: Array<{ token: string; call: CallJson; raw: string }> = [];
  decide: (call: CallJson) => 'allow' | 'ask' | 'deny' = () => 'allow';
  /** A faulty engine that allows an unregistered subject (the broker must still refuse it). */
  allowUnregistered = false;
  output: (raw: string) => 'allow' | 'deny' | 'throw' = () => 'allow';

  async evaluateCall(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { token: string; call: CallJson };
    this.calls.push(req);
    if (req.token !== 'wmt_good') throw new Error('invalid_token: the MCP token is not bound to a running unit');
    const decision = req.call.registered || this.allowUnregistered ? this.decide(req.call) : 'deny';
    const ruleIds = !req.call.registered && !this.allowUnregistered ? ['engine:mcp-unregistered'] : decision === 'deny' ? ['SEC-NO'] : decision === 'ask' ? ['engine:mcp-first-use'] : [];
    return JSON.stringify({
      decision,
      subject: `mcp:${req.call.server}/${req.call.tool}`,
      class: deriveToolClass(req.call.annotations),
      ruleIds,
      obligations: decision === 'ask' ? ['mcp:approval'] : [],
      ...(decision !== 'allow' ? { reason: `${decision} by ${ruleIds.join(',')}`, remedy: 'do something else' } : {}),
      claimId: `mcp-${decision}:unit-2`,
      unit: { runId: 'run-1', ord: 2, attempt: 0, phase: 'unit-2', seat: 'codex' },
    });
  }

  async evaluateOutput(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { token: string; call: CallJson; raw: string };
    this.outputs.push(req);
    const d = this.output(req.raw);
    if (d === 'throw') throw new Error('guard_error: the output policy store is unreadable');
    return JSON.stringify(
      d === 'deny'
        ? { decision: 'deny', subject: `mcp:${req.call.server}/${req.call.tool}`, ruleIds: ['OUT-NO'], reason: 'withheld by OUT-NO', remedy: 'r', claimId: 'mcp-deny:unit-2' }
        : { decision: 'allow', subject: `mcp:${req.call.server}/${req.call.tool}`, ruleIds: [] },
    );
  }
}

let base: string;
let counters: string;
let secret: string;
let secrets: MemorySecretStore;
let logs: string[];
let answered: string[];
let published: McpCallRecord[];
let clock: number;
let gate: FakeGate;
let registry: McpRegistry;
let records: McpCallRecordFile;
let app: FastifyInstance;

function counted(tool: string): number {
  try {
    return readFileSync(join(counters, `${tool}.count`), 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
}

function recorded(): McpCallRecord[] {
  try {
    return readFileSync(records.path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as McpCallRecord);
  } catch {
    return [];
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function boot(overrides: Partial<McpBrokerDeps> = {}): Promise<void> {
  const broker = new McpBroker({
    registry,
    engine: () => gate,
    records,
    now: () => clock,
    sleep: async () => undefined,
    publish: (r) => {
      published.push(r);
    },
    log: (m) => logs.push(m),
    ...overrides,
  });
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  app = Fastify({ logger: { level: 'trace', stream } });
  registerMcpRoutes(app, { registry, broker, audit: new AuditLog(join(base, 'audit.log'), (m) => logs.push(m)), actorOf: () => LOCAL_ACTOR });
  await app.ready();
}

async function mcpCall(subject: string, args: Record<string, unknown> = {}, token = 'wmt_good') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token, subject, args } });
  answered.push(res.body);
  return { status: res.statusCode, body: res.json() as McpCallResponse & { code?: string; error?: string } };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-broker-'));
  counters = join(base, 'counters');
  mkdirSync(counters);
  secret = `wkd-sentinel-${randomUUID()}`;
  secrets = new MemorySecretStore();
  secrets.values.set('fx', secret);
  logs = [];
  answered = [];
  published = [];
  clock = Date.parse('2026-09-28T12:00:00Z');
  gate = new FakeGate();
  records = new McpCallRecordFile(join(base, 'state', 'mcp'));
  registry = new McpRegistry({
    store: new McpRegistryStore(join(base, 'state', 'mcp')),
    secrets,
    probe: probeMcpServer,
    discover: () => [],
    now: () => clock,
  });
  const preview = (await registry.preview({
    name: 'fx',
    kind: 'mcp-stdio',
    command: process.execPath,
    args: [CALL_SERVER, counters],
    url: null,
    auth: { ref: 'keychain:wicked-mcp/fx', env: 'FIXTURE_TOKEN' },
  })) as McpPreviewResponse;
  await registry.save(preview.previewHash);
});

afterEach(async () => {
  await app?.close();
  removeScratch(base);
});

describe('PROVING (S3): the post step fails closed', () => {
  it('a crashing output decision gives guard_error and a refusal, with no result', async () => {
    await boot();
    gate.output = () => 'throw';
    const r = await mcpCall('mcp:fx/wt_echo', { text: 'hi' });
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(r.body.result).toBeUndefined();
    expect(r.body.reason).toContain('withheld');
    expect(counted('wt_echo')).toBe(1);
    const [rec] = recorded();
    expect(rec?.decision).toMatchObject({ decision: 'guard_error', by: 'engine:mcp-output' });
    expect(rec?.status.code).toBe('error');
  });

  it('an output deny withholds the result and is recorded as a deny, never as guard_error', async () => {
    await boot();
    gate.output = () => 'deny';
    const r = await mcpCall('mcp:fx/wt_echo', { text: 'hi' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ outcome: 'withheld', denied: true, ruleIds: ['OUT-NO'] });
    expect(r.body.result).toBeUndefined();
    expect(recorded()[0]?.decision).toMatchObject({ decision: 'deny', by: 'OUT-NO', claimId: 'mcp-deny:unit-2' });
  });
});

describe('PROVING (S3): a seeded secret comes back scrubbed (D-2)', () => {
  it('the upstream gets the secret; no response, record, log, file or output decision carries it', async () => {
    await boot();
    const r = await mcpCall('mcp:fx/wt_echo', { text: 'hello' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('ok');
    const text = (r.body.result?.['content'] as Array<{ text: string }>)[0]?.text ?? '';
    // The upstream echoed the injected secret: it reached the upstream, and came back scrubbed.
    expect(text).toContain(`my token is ${SECRET_REDACTION}`);
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(text).toContain('password=[REDACTED:kv]');
    expect(r.body.result?.['structuredContent']).toEqual({ key: 'ABC-1', api_key: '[REDACTED:field:api_key]', echoedToken: '[REDACTED:field:echoedToken]' });
    // The output decision was handed the SCRUBBED result.
    expect(gate.outputs).toHaveLength(1);
    expect(gate.outputs[0]?.raw).toContain(SECRET_REDACTION);
    expect(gate.outputs[0]?.raw).not.toContain(secret);
    // The engine was handed the registry's resolution, never a secret.
    expect(gate.calls[0]?.call).toMatchObject({ server: 'fx', tool: 'wt_echo', registered: true, annotations: { readOnlyHint: true } });
    expect(JSON.stringify(gate.calls)).not.toContain(secret);

    // A failing upstream's error is scrubbed too.
    const failed = await mcpCall('mcp:fx/wt_crash_write');
    expect(failed.status).toBe(502);

    await app.close();
    const rec = recorded();
    expect(rec).toHaveLength(2);
    expect(rec[0]).toMatchObject({ traceId: 'run-1', parentSpanId: '2:0', name: 'mcp.tool.call', outcome: 'ok', attrs: { 'mcp.subject': 'mcp:fx/wt_echo', 'mcp.class': 'read', 'wicked.seat': 'codex', 'wicked.carrier': 'shim' } });
    expect(rec[0]?.attrs['bytes.out']).toBeGreaterThan(0);
    // Records never carry args or results.
    expect(JSON.stringify(rec)).not.toContain('hello');
    expect(JSON.stringify(rec)).not.toContain('ABC-1');
    for (const body of answered) expect(body).not.toContain(secret);
    for (const line of logs) expect(line).not.toContain(secret);
    for (const f of filesUnder(base).filter((p) => !p.startsWith(counters))) expect(readFileSync(f, 'utf8')).not.toContain(secret);
    expect(JSON.stringify(published)).not.toContain(secret);
  });
});

describe('PROVING (S3): retries are for read tools only', () => {
  it('a write tool that drops the connection is invoked exactly once', async () => {
    await boot();
    const r = await mcpCall('mcp:fx/wt_crash_write');
    expect(r.status).toBe(502);
    expect(r.body.outcome).toBe('upstream_error');
    expect(counted('wt_crash_write')).toBe(1);
    expect(recorded()[0]?.attrs.retries).toBe(0);
    expect(recorded()[0]?.status).toEqual({ code: 'error', errorClass: 'transport' });
  });

  it('a read tool is retried on a transport error, at most twice', async () => {
    await boot();
    const ok = await mcpCall('mcp:fx/wt_flaky_read', { fail: 2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(counted('wt_flaky_read')).toBe(3);
    expect(recorded()[0]?.attrs.retries).toBe(2);

    const gaveUp = await mcpCall('mcp:fx/wt_flaky_read', { fail: 10 });
    expect(gaveUp.status).toBe(502);
    expect(counted('wt_flaky_read')).toBe(6);
  });

  it('a tool-level error is answered, not retried', async () => {
    await boot();
    const r = await mcpCall('mcp:fx/wt_tool_error');
    expect(r.status).toBe(200);
    expect(r.body.result?.['isError']).toBe(true);
    expect(counted('wt_tool_error')).toBe(1);
    expect(recorded()[0]?.status).toEqual({ code: 'error', errorClass: 'tool_error' });
  });

  it('classifies failures: transport, 429 and 5xx retry; a timeout, 4xx and a JSON-RPC error do not', () => {
    expect(classifyUpstreamError(new Error('spawn ENOENT')).retryable).toBe(true);
    expect(classifyUpstreamError(new McpError(ErrorCode.ConnectionClosed, 'closed')).retryable).toBe(true);
    expect(classifyUpstreamError(new StreamableHTTPError(429, 'slow down')).retryable).toBe(true);
    expect(classifyUpstreamError(new StreamableHTTPError(503, 'down')).retryable).toBe(true);
    expect(classifyUpstreamError(new StreamableHTTPError(404, 'gone')).retryable).toBe(false);
    expect(classifyUpstreamError(new McpError(ErrorCode.RequestTimeout, 'late')).errorClass).toBe('timeout');
    expect(classifyUpstreamError(new McpError(ErrorCode.RequestTimeout, 'late')).retryable).toBe(false);
    expect(classifyUpstreamError(new McpError(ErrorCode.InvalidParams, 'bad')).retryable).toBe(false);
  });
});

describe('PROVING (S3): a failing record write refuses the call (D-3)', () => {
  it('the result is withheld when its record cannot be written', async () => {
    const failing: McpCallRecordSink = {
      append: async () => {
        throw new Error('EACCES: calls.ndjson');
      },
    };
    await boot({ records: failing });
    const r = await mcpCall('mcp:fx/wt_echo', { text: 'hi' });
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(r.body.result).toBeUndefined();
    expect(r.body.reason).toContain('could not be recorded');
    expect(published).toHaveLength(0);
  });
});

describe('the judgement comes before anything runs', () => {
  it('a deny never reaches the upstream and the worker gets a structured refusal', async () => {
    await boot();
    gate.decide = () => 'deny';
    const r = await mcpCall('mcp:fx/wt_note', { text: 'x' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ outcome: 'denied', denied: true, subject: 'mcp:fx/wt_note', ruleIds: ['SEC-NO'], remedy: 'do something else' });
    expect(counted('wt_note')).toBe(0);
    expect(recorded()[0]?.decision).toMatchObject({ decision: 'deny', by: 'SEC-NO', claimId: 'mcp-deny:unit-2' });
    expect(published[0]?.spanId).toBe(r.body.callId);
  });

  it('an ask never reaches the upstream and names what waits for approval', async () => {
    await boot();
    gate.decide = () => 'ask';
    const r = await mcpCall('mcp:fx/wt_note');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ outcome: 'pending_approval', pending_approval: 'mcp:fx/wt_note', ruleIds: ['engine:mcp-first-use'] });
    expect(counted('wt_note')).toBe(0);
    expect(recorded()[0]?.decision.decision).toBe('ask');
  });

  it('an unknown server, a disabled tool and an unknown tool go to the engine as unregistered (D-5)', async () => {
    await boot();
    expect((await mcpCall('mcp:nope/wt_echo')).status).toBe(403);
    await registry.patchTool('mcp:fx/wt_echo', { enabled: false });
    expect((await mcpCall('mcp:fx/wt_echo')).status).toBe(403);
    expect((await mcpCall('mcp:fx/not_a_tool')).status).toBe(403);
    expect(gate.calls.map((c) => c.call.registered)).toEqual([false, false, false]);
    expect(counted('wt_echo')).toBe(0);
  });

  it('an unbound token is refused 401 and a malformed subject 400, neither recorded', async () => {
    await boot();
    const bad = await mcpCall('mcp:fx/wt_echo', {}, 'wmt_other');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('invalid_token');
    const malformed = await mcpCall('fx.wt_echo');
    expect(malformed.status).toBe(400);
    expect(recorded()).toHaveLength(0);
  });

  it('a daemon whose engine has no MCP gate refuses every call', async () => {
    await boot({ engine: () => null });
    const r = await mcpCall('mcp:fx/wt_echo');
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(counted('wt_echo')).toBe(0);
  });
});

describe('the broker never invokes what the registry does not hold as registered', () => {
  it('an engine that wrongly allows a disabled or unknown tool is refused, and nothing runs', async () => {
    await boot();
    gate.allowUnregistered = true;
    await registry.patchTool('mcp:fx/wt_note', { enabled: false });
    const disabled = await mcpCall('mcp:fx/wt_note');
    expect(disabled.status).toBe(500);
    expect(disabled.body.outcome).toBe('guard_error');
    expect(counted('wt_note')).toBe(0);
    const unknown = await mcpCall('mcp:fx/wt_nope');
    expect(unknown.body.outcome).toBe('guard_error');
    expect(recorded().map((r) => r.decision.by)).toEqual(['broker', 'broker']);
  });
});

describe('budget and breaker', () => {
  it('a unit past its budget is refused 429 without invoking', async () => {
    await boot({ budgetPerUnit: 2 });
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);
    const third = await mcpCall('mcp:fx/wt_note');
    expect(third.status).toBe(429);
    expect(third.body.outcome).toBe('budget_exhausted');
    expect(counted('wt_note')).toBe(2);
    expect(recorded()[2]?.decision).toMatchObject({ decision: 'deny', by: 'budget' });
  });

  it('a call refused before the upstream (a missing secret) spends no budget', async () => {
    await boot({ budgetPerUnit: 1 });
    secrets.values.delete('fx');
    const missing = await mcpCall('mcp:fx/wt_note');
    expect(missing.status).toBe(502);
    expect(missing.body.reason).toContain('resolves to no secret');
    expect(counted('wt_note')).toBe(0);
    secrets.values.set('fx', secret);
    // The one call of the budget is still there.
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);
    expect(counted('wt_note')).toBe(1);
  });

  it('a secret store that throws refuses the call as guard_error, recorded, and nothing runs', async () => {
    await boot({ budgetPerUnit: 1 });
    const get = secrets.get.bind(secrets);
    secrets.get = async () => {
      throw new Error('the keychain is locked');
    };
    const r = await mcpCall('mcp:fx/wt_note');
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(r.body.result).toBeUndefined();
    expect(counted('wt_note')).toBe(0);
    expect(recorded()[0]?.decision).toMatchObject({ decision: 'guard_error', by: 'broker' });
    secrets.get = get;
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);
  });

  it('the budget comes from WICKED_MCP_CALL_BUDGET, defaulting to 200', () => {
    expect(budgetFromEnv({})).toBe(200);
    expect(budgetFromEnv({ WICKED_MCP_CALL_BUDGET: '5' })).toBe(5);
    expect(budgetFromEnv({ WICKED_MCP_CALL_BUDGET: 'lots' })).toBe(200);
  });

  it('a broker built without budgetPerUnit takes its budget from WICKED_MCP_CALL_BUDGET', async () => {
    const prior = process.env['WICKED_MCP_CALL_BUDGET'];
    process.env['WICKED_MCP_CALL_BUDGET'] = '1';
    try {
      await boot();
    } finally {
      if (prior === undefined) delete process.env['WICKED_MCP_CALL_BUDGET'];
      else process.env['WICKED_MCP_CALL_BUDGET'] = prior;
    }
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);
    const second = await mcpCall('mcp:fx/wt_note');
    expect(second.status).toBe(429);
    expect(second.body.outcome).toBe('budget_exhausted');
    expect(counted('wt_note')).toBe(1);
  });

  it('opens after 5 consecutive failures, refuses for 60 s, then lets one call through', async () => {
    await boot();
    for (let i = 0; i < BREAKER_THRESHOLD; i++) expect((await mcpCall('mcp:fx/wt_crash_write')).status).toBe(502);
    const open = await mcpCall('mcp:fx/wt_crash_write');
    expect(open.status).toBe(503);
    expect(open.body.outcome).toBe('breaker_open');
    expect(counted('wt_crash_write')).toBe(BREAKER_THRESHOLD);
    // Another tool of the same server is not affected.
    expect((await mcpCall('mcp:fx/wt_note')).status).toBe(200);

    clock += BREAKER_OPEN_MS + 1;
    expect((await mcpCall('mcp:fx/wt_crash_write')).status).toBe(502);
    expect(counted('wt_crash_write')).toBe(BREAKER_THRESHOLD + 1);
    // One failure in the half-open state reopens it.
    expect((await mcpCall('mcp:fx/wt_crash_write')).status).toBe(503);
  });
});

describe('the wiring', () => {
  it('the linked engine carries the gate and refuses a token no unit is bound to', async () => {
    const engine = CoreAdapter.mcpEngineGate();
    expect(engine, 'the linked wicked-core-ts carries evaluateMcpCall and evaluateMcpOutput').not.toBeNull();
    await boot({ engine: () => engine });
    const r = await mcpCall('mcp:fx/wt_echo', {}, 'wmt_nobody');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_token');
    expect(counted('wt_echo')).toBe(0);
  });

  it('a malformed body is refused without echoing it, and a daemon with no broker answers 503', async () => {
    await boot();
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_good', subject: 'mcp:fx/wt_echo', args: `leak-${secret}` } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
    await app.close();
    app = Fastify();
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit2.log'), () => undefined), actorOf: () => LOCAL_ACTOR });
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 't', subject: 'mcp:a/b' } })).statusCode).toBe(503);
  });

  it('the broker URL a worker is handed reaches this daemon on loopback', () => {
    expect(brokerUrlFor('127.0.0.1', 7701)).toBe('http://127.0.0.1:7701');
    expect(brokerUrlFor('0.0.0.0', 7701)).toBe('http://127.0.0.1:7701');
    expect(brokerUrlFor('::', 7701)).toBe('http://[::1]:7701');
    expect(brokerUrlFor('::1', 60785)).toBe('http://[::1]:60785');
  });

  it('the result scrub keeps a bare identifier key and redacts qualified credential keys', () => {
    expect(redactDeep({ key: 'ABC-1', accessKey: 'x', private_key: 'y', sessionId: 'z', monkey: 'ok' })).toEqual({
      key: 'ABC-1',
      accessKey: '[REDACTED:field:accessKey]',
      private_key: '[REDACTED:field:private_key]',
      sessionId: '[REDACTED:field:sessionId]',
      monkey: 'ok',
    });
    // Long-term (AKIA) and STS temporary (ASIA) AWS access key ids, under a key no field rule names.
    expect(redactDeep({ creds: 'AKIA1234567890ABCDEF and ASIA1234567890ABCDEF' })).toEqual({
      creds: '[REDACTED:aws-access-key] and [REDACTED:aws-access-key]',
    });
  });
});
