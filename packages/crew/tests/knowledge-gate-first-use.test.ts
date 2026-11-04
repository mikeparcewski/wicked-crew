// crew#1333: a live source's tools are allowed by its switches, never by a per-call approval, judged by a REAL
// engine. The person's "Agents can query this source" switch is the consent the engine's first-use ask waits for,
// so the data gate admits that ask, and no other one.
//
// The engine is real: a stub-runner CoreAdapter on a scratch store, which seeds the `mcp-defaults` pack at boot, so
// MCP-POSTURE-READ (an allow) fires on every read and a first-use ask names `[engine:mcp-first-use,
// MCP-POSTURE-READ]`. A rule id list alone cannot tell that ask from an operator's own asking rule (both lead with
// first use); the engine's `firstUseOnly` mark can. The unit's list comes from `Core.previewMcpCalls` for the
// token's cell: `listMcpTools` needs a token only a carrier can mint, and core's
// `the_preview_matrix_equals_evaluate_mcp_call_over_the_same_fixture_rules` pins that the preview IS the evaluation
// `listMcpTools` runs, `firstUseOnly` included. The Toolbox process is the stand-in of knowledge-gate-toolbox.test.ts.
//
// Controls, each through `POST /mcp/call` and `POST /mcp/tools`:
//   (i)   query on, server never approved, defaults loaded: the read runs (rows), in every run mode and seat role;
//   (ii)  query off: rows are refused (`query_off`), the structure tool still runs;
//   (iii) an operator rule that asks: `pending_approval`, first use approved or not;
//   (iv)  an operator deny: `denied`, the tool is not listed;
//   (v)   an ordinary registered MCP server's first use: the engine marks its read first-use-only too, and it still
//         asks (listed `ask`, a call answers `pending_approval`): the mark is honoured for a live source only.
//   (vi)  an operator deny that triggers on the call's arguments (a word in the SQL, crew#1337): the call is judged
//         with them (`judgeMcpCall`), so it is `denied` and nothing runs; the same read without the word runs, and
//         the tool stays listed (the list judges with no arguments). An engine without `judgeMcpCall` judges by the
//         list, where that rule cannot fire.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule, McpCallResponse, McpPreviewResponse, McpToolsResponse } from '../src/core/types.js';
import { ToolboxSupervisor } from '../src/knowledge/adapters/toolbox/supervisor.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { registerGateRoutes } from '../src/knowledge/gate/routes.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { FIRST_USE_LEDGER } from '../src/mcp/policies.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { removeScratch } from './setup/scratch.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'knowledge', 'fake-toolbox.mjs');
const CALL_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'call-server.mjs');
const SECRET = 'kd-first-use-secret';
const Q = 'SELECT t.a, t.b FROM s.t AS t';

const noSecrets: SecretStore = {
  available: true,
  get: async () => null,
  has: async () => false,
  set: async () => undefined,
  delete: async () => undefined,
};

/** The engine's preview cell a token's unit is judged as, and its run's project. */
const TOKENS: Record<string, { cell: { role: string; seat: string; mode: string }; projectId: string; seat: string }> = {
  wmt_balanced: { cell: { role: 'creator', seat: 'claude', mode: 'balanced' }, projectId: 'proj_a', seat: 'claude' },
  wmt_askmode: { cell: { role: 'creator', seat: 'claude', mode: 'ask' }, projectId: 'proj_a', seat: 'claude' },
  wmt_eval: { cell: { role: 'evaluator', seat: 'pi', mode: 'autonomous' }, projectId: 'proj_a', seat: 'pi' },
};
const unitOf = (token: string) => ({ runId: `run-${token}`, ord: 2, attempt: 1, phase: 'unit-2', seat: TOKENS[token]!.seat });

const gatedTools = () =>
  ['list_tables', 'execute_sql'].map((name) => ({
    name,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    classOverride: null,
    enabled: true,
    schemaHash: `h-${name}`,
    observedSchemaHash: `h-${name}`,
    present: true,
    disclosure: { class: name === 'execute_sql' ? 'rows' : 'structure', schemaHash: `h-${name}` },
  }));

function toolboxRecord(name: string, n: number): Record<string, unknown> {
  const stamp = new Date().toISOString();
  return {
    id: `3f0c9a1e-0000-4000-8000-0000000013${String(n).padStart(2, '0')}`,
    name,
    kind: 'toolbox-source',
    runtime: 'toolbox',
    command: null,
    args: [],
    url: null,
    auth: { ref: 'env:KD_FIRST_USE_SECRET' },
    toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' },
    address: { allow: ['127.0.0.0/8'], plaintext: false },
    tls: { mode: 'disable', ca: null },
    descriptorVersion: 2,
    policyVersion: 'postgres/1@toolbox-v1.15.0',
    enabled: true,
    health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
    registeredAt: stamp,
    updatedAt: stamp,
    tools: gatedTools(),
  };
}

/** `tb`: query on. `tb-off`: see only. `tb-asked`: query on, an operator rule asks. `tb-denied`: query on, an operator rule denies. */
const SOURCES = ['tb', 'tb-off', 'tb-asked', 'tb-denied'];

describe.skipIf(process.platform === 'win32')('the data gate admits a first-use ask, and only that ask, on a real engine (crew#1333)', () => {
  let base: string;
  let adapter: CoreAdapter;
  let sup: ToolboxSupervisor;
  let app: FastifyInstance;
  /** Whether the engine has `judgeMcpCall` (false: one that predates crew#1337). */
  let judgeArgs = true;

  /** The real engine's evaluation of `calls` for the token's unit (`Core.previewMcpCalls` for its cell). */
  const judge = async (token: string, calls: unknown[]) => {
    const t = TOKENS[token];
    if (t === undefined) throw new Error('invalid_token: the MCP token is not bound to a running unit');
    const rows = JSON.parse(await adapter.previewMcpCalls(JSON.stringify({ calls, cells: [t.cell] }))) as Array<{
      subject: string;
      cells: Array<{ decision: string; class: string; ruleIds: string[]; obligations: string[]; reason?: string; firstUseOnly?: boolean }>;
    }>;
    return rows.map((r) => ({ subject: r.subject, ...r.cells[0]! }));
  };
  /** `listMcpTools` for the token's unit, from the real engine's evaluation of the same calls (denies left out). */
  const lister = () => async (json: string) => {
    const { token, calls } = JSON.parse(json) as { token: string; calls: unknown[] };
    const tools = (await judge(token, calls)).flatMap((v) =>
      v.decision === 'deny'
        ? []
        : [{ subject: v.subject, class: v.class, decision: v.decision, ruleIds: v.ruleIds, ...(v.reason !== undefined ? { reason: v.reason } : {}), ...(v.firstUseOnly !== undefined ? { firstUseOnly: v.firstUseOnly } : {}) }],
    );
    return JSON.stringify({ unit: unitOf(token), tools });
  };
  /** `judgeMcpCall`: ONE call, its arguments included, by the same real evaluation, recorded nowhere. */
  const judgeCall = () => async (json: string) => {
    const { token, call } = JSON.parse(json) as { token: string; call: Record<string, unknown> };
    const v = (await judge(token, [call]))[0]!;
    return JSON.stringify({ ...v, claimId: '', unit: unitOf(token) });
  };
  /** `evaluateMcpCall` for an ordinary server's call: the same real evaluation, as the call verdict. */
  const engineGate = {
    evaluateCall: async (json: string) => {
      const { token, call } = JSON.parse(json) as { token: string; call: Record<string, unknown> };
      const v = (await judge(token, [call]))[0]!;
      return JSON.stringify({ ...v, claimId: '', unit: unitOf(token) });
    },
    evaluateOutput: async () => JSON.stringify({ decision: 'allow', ruleIds: [] }),
  };
  const resolver = () => async (json: string) => {
    const token = (JSON.parse(json) as { token: string }).token;
    const t = TOKENS[token];
    if (t === undefined) throw new Error('invalid_token: the MCP token is not bound to a running unit');
    return JSON.stringify({ unit: unitOf(token), projectId: t.projectId, repoId: null, codeGraphDb: null });
  };

  const upsert = async (rule: Partial<ConformanceRule> & { id: string }): Promise<void> => {
    await adapter.upsertConformanceRule({
      rule_type: 'policy',
      severity: 'error',
      confidence: 1,
      targets: {},
      steering_type: 'security',
      provenance: { source: 'ui', ref: 'test', source_kinds: ['doc'] },
      statement: rule.id,
      ...rule,
    } as ConformanceRule);
  };

  const call = async (token: string, subject: string, args: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token, subject, args } });
    const body = res.json() as McpCallResponse;
    const content = (body.result as { content?: Array<{ text: string }> } | undefined)?.content;
    return { status: res.statusCode, body, answer: content?.[0] !== undefined ? (JSON.parse(content[0].text) as Record<string, unknown>) : null };
  };
  const listed = async (token: string, server: string): Promise<Array<[string, string]>> => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/tools', payload: { token } });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as McpToolsResponse).tools.filter((t) => t.subject.startsWith(`mcp:${server}/`)).map((t) => [t.subject, t.decision]);
  };
  /** What the engine itself answers for a gated read of `server`, before crew's gate reads it. */
  const engineJudged = async (token: string, server: string) => {
    const raw = await lister()(JSON.stringify({ token, calls: [{ server, tool: 'execute_sql', annotations: { readOnlyHint: true }, classOverride: 'read', registered: true, kind: 'mcp-stdio', carrier: 'shim' }] }));
    return (JSON.parse(raw) as { tools: Array<{ decision: string; ruleIds: string[]; firstUseOnly?: boolean }> }).tools[0] ?? null;
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-first-use-'));
    const mcpDir = join(base, 'mcp');
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, 'registry.json'), JSON.stringify({ version: 1, servers: SOURCES.map((s, i) => toolboxRecord(s, i)) }));
    const bin = join(base, 'toolbox');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(bin, 0o755);
    adapter = new CoreAdapter({ dbPath: join(base, 'core.db'), stub: true });
    const store = new McpRegistryStore(mcpDir);
    let prober: DataGate | null = null;
    const registry = new McpRegistry({
      store,
      secrets: noSecrets,
      probe: probeMcpServer,
      discover: () => [],
      env: { KD_FIRST_USE_SECRET: SECRET },
      toolboxProbe: (c, s) => (prober as DataGate).toolboxProbe(c, s),
    });
    const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
    const record = new SourceReadLog(mcpDir);
    sup = new ToolboxSupervisor({ binary: async () => bin, runRoot: join(mcpDir, 'adapters', 'toolbox', 'run') });
    const gate = new DataGate({
      store,
      catalogs: registry.catalogs,
      secret: async (ref) => (ref === 'env:KD_FIRST_USE_SECRET' ? SECRET : null),
      record,
      audit,
      resolver,
      lister,
      judge: () => (judgeArgs ? judgeCall() : null),
      toolbox: sup,
      deadlineMs: 5_000,
      recheckMs: 60_000,
    });
    prober = gate;
    const broker = new McpBroker({ registry, engine: () => engineGate, records: new McpCallRecordFile(mcpDir), gate });
    app = Fastify({ logger: false });
    registerMcpRoutes(app, { registry, broker, toolLister: lister, gate, audit, actorOf: () => LOCAL_ACTOR });
    registerSourceRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR, gate });
    registerGateRoutes(app, { store, record, audit, actorOf: () => LOCAL_ACTOR });
    await app.ready();
    // A person describes each source and turns its switches on (the human-only route).
    for (const name of SOURCES) {
      const t = await app.inject({ method: 'POST', url: `/api/v1/sources/${name}/test` });
      expect(t.json(), `${name}: ${t.body}`).toMatchObject({ ok: true });
      const put = await app.inject({ method: 'PUT', url: `/api/v1/sources/${name}/agents`, payload: { projects: ['proj_a'], ...(name === 'tb-off' ? {} : { query: true }) } });
      expect(put.statusCode, `${name}: ${put.body}`).toBe(200);
    }
    // An ordinary registered MCP server (not a live source), its first use never approved.
    const preview = (await registry.preview({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [CALL_SERVER, join(base, 'counters')], url: null, auth: null })) as McpPreviewResponse;
    await registry.save(preview.previewHash, []);
    await upsert({ id: 'SEC-ASK-TB', applies_to: ['mcp:tb-asked'], effect: 'allow_with_conditions', obligations: ['mcp:approval'] });
    await upsert({ id: 'SEC-DENY-TB', applies_to: ['mcp:tb-denied/execute_sql'], effect: 'deny', severity: 'critical' });
  }, 90_000);

  afterAll(async () => {
    sup?.stopAll();
    await app?.close();
    adapter?.close();
    if (base !== undefined) removeScratch(base);
  });

  it('(i) query on: the engine asks for first use only, and the read runs, in every mode and seat role', async () => {
    for (const token of Object.keys(TOKENS)) {
      // The engine's own answer: an ask whose only reason is first use (the defaults' read allow fired too).
      const judged = await engineJudged(token, 'tb');
      expect(judged, token).toMatchObject({ decision: 'ask', ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-READ'], firstUseOnly: true });
      const ok = await call(token, 'mcp:tb/execute_sql', { sql: Q });
      expect(ok.status, `${token}: ${JSON.stringify(ok.body)}`).toBe(200);
      expect(ok.answer, token).toMatchObject({ source: 'tb', rows: [[1, 'x'], [2, 'y']], rowCount: 2 });
      expect(String(ok.answer?.['cite']), token).toMatch(/^src:tb@/);
      expect(await listed(token, 'tb'), token).toEqual([
        ['mcp:tb/list_tables', 'allow'],
        ['mcp:tb/execute_sql', 'allow'],
      ]);
    }
  });

  it('(ii) query off: rows are refused and not listed, the structure tool runs', async () => {
    expect(await listed('wmt_balanced', 'tb-off')).toEqual([['mcp:tb-off/list_tables', 'allow']]);
    const off = await call('wmt_balanced', 'mcp:tb-off/execute_sql', { sql: Q });
    expect(off.answer).toMatchObject({ refused: 'query_off' });
    expect(off.answer).not.toHaveProperty('rows');
    const st = await call('wmt_balanced', 'mcp:tb-off/list_tables');
    expect(st.status).toBe(200);
    expect(st.answer).toMatchObject({ source: 'tb-off', query: false, relations: [{ schema: 's', name: 't' }] });
  });

  it("(iii) an operator rule that asks stands: pending_approval, before and after the server's first use is approved", async () => {
    const judged = await engineJudged('wmt_balanced', 'tb-asked');
    expect(judged).toMatchObject({ decision: 'ask' });
    expect(judged?.ruleIds[0]).toBe('engine:mcp-first-use');
    expect(judged?.ruleIds).toContain('SEC-ASK-TB');
    expect(judged).not.toHaveProperty('firstUseOnly');
    const before = await call('wmt_balanced', 'mcp:tb-asked/execute_sql', { sql: Q });
    expect(before.status, JSON.stringify(before.body)).toBe(409);
    expect(before.body).toMatchObject({ outcome: 'pending_approval' });
    expect(await listed('wmt_balanced', 'tb-asked')).toContainEqual(['mcp:tb-asked/execute_sql', 'ask']);
    // The operator approves the server's first use: the asking rule still holds the read.
    const ledger = (await adapter.listConformanceRules()).find((r) => r.id === FIRST_USE_LEDGER);
    expect(ledger).toBeDefined();
    await adapter.upsertConformanceRule({ ...ledger!, excludes: [...(ledger!.excludes ?? []), 'mcp:tb-asked'] });
    const judgedAfter = await engineJudged('wmt_balanced', 'tb-asked');
    expect(judgedAfter).toMatchObject({ decision: 'ask', ruleIds: ['SEC-ASK-TB', 'MCP-POSTURE-READ'] });
    expect(judgedAfter).not.toHaveProperty('firstUseOnly');
    const after = await call('wmt_balanced', 'mcp:tb-asked/execute_sql', { sql: Q });
    expect(after.status, JSON.stringify(after.body)).toBe(409);
    expect(after.body).toMatchObject({ outcome: 'pending_approval' });
  });

  it('(iv) an operator deny dominates: denied, never listed, whatever the switches say', async () => {
    expect(await engineJudged('wmt_balanced', 'tb-denied')).toBeNull();
    expect(await listed('wmt_balanced', 'tb-denied')).toEqual([['mcp:tb-denied/list_tables', 'allow']]);
    const denied = await call('wmt_balanced', 'mcp:tb-denied/execute_sql', { sql: Q });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body).toMatchObject({ outcome: 'denied' });
  });

  it("(v) an ordinary MCP server's first use still asks, though the engine marks it first-use-only", async () => {
    const judged = (await judge('wmt_balanced', [{ server: 'fx', tool: 'wt_echo', annotations: { readOnlyHint: true }, registered: true, kind: 'mcp-stdio', carrier: 'shim' }]))[0];
    expect(judged).toMatchObject({ decision: 'ask', ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-READ'], firstUseOnly: true });
    expect(await listed('wmt_balanced', 'fx')).toContainEqual(['mcp:fx/wt_echo', 'ask']);
    const asked = await call('wmt_balanced', 'mcp:fx/wt_echo', { text: 'x' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(asked.body).toMatchObject({ outcome: 'pending_approval', ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-READ'] });
    expect(existsSync(join(base, 'counters', 'wt_echo.count')), 'the upstream was never invoked').toBe(false);
  });

  it('(vi) an operator deny that triggers on the SQL fires for a live-source call: judged with its arguments (crew#1337)', async () => {
    await upsert({ id: 'SEC-NO-SALARY', applies_to: ['mcp:tb/execute_sql'], effect: 'deny', severity: 'critical', trigger: { contains: 'salary' } });
    const salary = 'SELECT t.a AS salary, t.b FROM s.t AS t';
    try {
      const denied = await call('wmt_balanced', 'mcp:tb/execute_sql', { sql: salary });
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body).toMatchObject({ outcome: 'denied' });
      expect(denied.answer).toBeNull();
      // The same read without the word runs, and the tool stays listed: the list judges with no arguments.
      const ok = await call('wmt_balanced', 'mcp:tb/execute_sql', { sql: Q });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.answer).toMatchObject({ rows: [[1, 'x'], [2, 'y']] });
      expect(await listed('wmt_balanced', 'tb')).toContainEqual(['mcp:tb/execute_sql', 'allow']);
      // An engine that predates judgeMcpCall judges by the bare list, where the rule cannot fire (the documented gap).
      judgeArgs = false;
      const bare = await call('wmt_balanced', 'mcp:tb/execute_sql', { sql: salary });
      expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    } finally {
      judgeArgs = true;
      await adapter.upsertConformanceRule({ ...(await adapter.listConformanceRules()).find((r) => r.id === 'SEC-NO-SALARY')!, retired: true });
    }
  });
});
