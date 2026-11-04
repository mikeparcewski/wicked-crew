// DES-KNOWLEDGE-DATA-001 §6.3, §7 (B2): the gate step in the broker, the switches route, and the Toolbox
// runtime's supervisor, end to end through `POST /mcp/call` and `POST /mcp/tools` with a unit's token. The
// Toolbox process here is a stand-in that speaks Toolbox's stdio protocol and substitutes `${VAR}` as text
// before it parses YAML, as Toolbox does (tests/fixtures/knowledge/fake-toolbox.mjs); the real binary runs
// against a real Postgres in sources-gate.test.ts when WICKED_TOOLBOX_BIN is set.
//
// The engine is a fake, as in the estate relay's tests: it binds a token to a unit and its run's project
// (`resolveEstateScope`) and judges subjects (`listMcpTools`), omitting every one for an Apps unit (D-7).

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { Actor, McpCallResponse, McpToolsResponse, RunDataUseResponse, SourceAgentQueriesResponse } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { yamlQuotedBody } from '../src/knowledge/adapters/toolbox/document.js';
import { ToolboxSupervisor } from '../src/knowledge/adapters/toolbox/supervisor.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { registerGateRoutes } from '../src/knowledge/gate/routes.js';
import { registerSourceRoutes } from '../src/sources/routes.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'knowledge', 'fake-toolbox.mjs');
/** A secret with a quote, a newline, a backslash and a dollar-brace (§19 B2: "a secret with a quote and a newline connects"). */
const SECRET = 'kd"b2\nsecret\\0451${HOME}';
const SECRET_FORMS = [SECRET, yamlQuotedBody(SECRET), JSON.stringify(SECRET).slice(1, -1)];
const AGENT: Actor = { id: 'worker-1', kind: 'agent', trust: 'admin' };
const TB_ID = '3f0c9a1e-0000-4000-8000-0000000000b2';
const NODL_ID = '3f0c9a1e-0000-4000-8000-0000000000b3';
const UNBOUND_ID = '3f0c9a1e-0000-4000-8000-0000000000b4';
const WRONGAPP_ID = '3f0c9a1e-0000-4000-8000-0000000000b5';

class NoSecrets implements SecretStore {
  readonly available = true;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const unit = (runId: string) => ({ runId, ord: 2, attempt: 1, phase: 'unit-2', seat: 'claude' });
const TOKENS: Record<string, { unit: ReturnType<typeof unit>; projectId: string | null; apps?: boolean; policyAsk?: boolean; bareAsk?: boolean }> = {
  wmt_a: { unit: unit('run-a'), projectId: 'proj_a' },
  wmt_b: { unit: unit('run-b'), projectId: 'proj_b' },
  wmt_apps: { unit: unit('run-apps'), projectId: 'proj_a', apps: true },
  wmt_ask: { unit: unit('run-ask'), projectId: 'proj_a', policyAsk: true },
  wmt_bare: { unit: unit('run-bare'), projectId: 'proj_a', bareAsk: true },
};

const resolver = () => async (json: string) => {
  const t = TOKENS[(JSON.parse(json) as { token: string }).token];
  if (t === undefined) throw new Error('invalid_token: the MCP token is not bound to a running unit');
  return JSON.stringify({ unit: t.unit, projectId: t.projectId, repoId: null, codeGraphDb: null });
};
const lister = () => async (json: string) => {
  const { token, calls } = JSON.parse(json) as { token: string; calls: Array<{ server: string; tool: string }> };
  const t = TOKENS[token];
  if (t === undefined) throw new Error('invalid_token: unknown');
  // D-7: an Apps unit is denied everything (and the list leaves denies out). Otherwise a first use asks.
  const tools = t.apps === true ? [] : calls.map((c) => ({ subject: `mcp:${c.server}/${c.tool}`, class: 'read', decision: 'ask', ruleIds: t.bareAsk === true ? [] : t.policyAsk === true ? ['policy:ask-data'] : ['engine:mcp-first-use'] }));
  return JSON.stringify({ unit: t.unit, tools });
};

interface Rig {
  app: FastifyInstance;
  base: string;
  gate: DataGate;
  sup: ToolboxSupervisor;
  audit: AuditLog;
  texts: string[];
  answers: string[];
  setActor: (a: Actor) => void;
  setAfterRead: (fn: (() => Promise<void>) | null) => void;
  setFailRecord: (fn: ((e: { outcome: string }) => boolean) | null) => void;
  setOnBrokerRecord: (fn: (() => Promise<void>) | null) => void;
}

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

function toolboxRecord(name: string, id: string): Record<string, unknown> {
  const stamp = new Date().toISOString();
  return {
    id,
    name,
    kind: 'toolbox-source',
    runtime: 'toolbox',
    command: null,
    args: [],
    url: null,
    auth: { ref: 'env:KD_B2_FAKE_SECRET' },
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

async function rig(): Promise<Rig> {
  const base = mkdtempSync(join(tmpdir(), 'kd-b2-gate-'));
  const mcpDir = join(base, 'mcp');
  mkdirSync(mcpDir, { recursive: true });
  // `tb-unbound`: its execute_sql class was reviewed against another schema, so none is in force.
  const unbound = toolboxRecord('tb-unbound', UNBOUND_ID);
  (unbound['tools'] as Array<{ name: string; disclosure: { schemaHash: string } }>).find((t) => t.name === 'execute_sql')!.disclosure.schemaHash = 'h-older-schema';
  unbound['agents'] = { see: true, query: true, projects: ['proj_a'], everyProject: false };
  // `tb-wrongapp`: its session does not carry the application name crew wrote (the open check refuses it).
  const wrongapp = toolboxRecord('tb-wrongapp', WRONGAPP_ID);
  (wrongapp['toolbox'] as Record<string, unknown>)['database'] = 'wrongapp';
  wrongapp['agents'] = { see: true, query: true, projects: ['proj_a'], everyProject: false };
  writeFileSync(join(mcpDir, 'registry.json'), JSON.stringify({ version: 1, servers: [toolboxRecord('tb', TB_ID), toolboxRecord('tb-nodl', NODL_ID), unbound, wrongapp] }));
  const bin = join(base, 'toolbox');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const store = new McpRegistryStore(mcpDir);
  let prober: DataGate | null = null;
  const registry = new McpRegistry({
    store,
    secrets: new NoSecrets(),
    probe: async () => ({ ok: false, error: 'no probe' }) as never,
    discover: () => [],
    env: { KD_B2_FAKE_SECRET: SECRET },
    toolboxProbe: (c, s) => (prober as DataGate).toolboxProbe(c, s),
  });
  const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
  const record = new SourceReadLog(mcpDir);
  let failRecord: ((e: { outcome: string }) => boolean) | null = null;
  const recordSink = {
    append: (e: Parameters<SourceReadLog['append']>[0]) => (failRecord !== null && failRecord(e) ? Promise.reject(new Error('disk full')) : record.append(e)),
    recent: (n: string, k?: number) => record.recent(n, k),
    dataUse: (id: string) => record.dataUse(id),
  };
  let onBrokerRecord: (() => Promise<void>) | null = null;
  const calls = new McpCallRecordFile(mcpDir);
  const sup = new ToolboxSupervisor({ binary: async () => bin, runRoot: join(mcpDir, 'adapters', 'toolbox', 'run') });
  const texts: string[] = [];
  let afterRead: (() => Promise<void>) | null = null;
  const gate = new DataGate({
    store,
    catalogs: registry.catalogs,
    secret: async (ref) => (ref === 'env:KD_B2_FAKE_SECRET' ? SECRET : null),
    record: recordSink,
    audit,
    resolver,
    lister,
    toolbox: sup,
    deadlineMs: 1_500,
    recheckMs: 60_000,
    omitStatementTimeout: (id) => id === NODL_ID,
    onText: (t) => texts.push(t),
    afterRead: async () => {
      const fn = afterRead;
      afterRead = null;
      if (fn !== null) await fn();
    },
  });
  prober = gate;
  const broker = new McpBroker({
    registry,
    engine: () => null,
    records: {
      append: async (rec) => {
        const fn = onBrokerRecord;
        onBrokerRecord = null;
        if (fn !== null) await fn();
        return calls.append(rec);
      },
    },
    gate,
  });
  let actor: Actor = LOCAL_ACTOR;
  const app = Fastify({ logger: false });
  registerMcpRoutes(app, { registry, broker, toolLister: lister, gate, audit, actorOf: () => actor });
  registerSourceRoutes(app, { registry, audit, actorOf: () => actor, gate });
  registerGateRoutes(app, { store, record: recordSink, audit, actorOf: () => actor });
  await app.ready();
  return {
    app,
    base,
    gate,
    sup,
    audit,
    texts,
    answers: [],
    setActor: (a) => {
      actor = a;
    },
    setAfterRead: (fn) => {
      afterRead = fn;
    },
    setFailRecord: (fn) => {
      failRecord = fn;
    },
    setOnBrokerRecord: (fn) => {
      onBrokerRecord = fn;
    },
  };
}

const put = (r: Rig, name: string, body: Record<string, unknown>) => r.app.inject({ method: 'PUT', url: `/api/v1/sources/${name}/agents`, payload: body });

async function call(r: Rig, token: string, subject: string, args: Record<string, unknown> = {}) {
  const res = await r.app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token, subject, args } });
  r.answers.push(res.body);
  const body = res.json() as McpCallResponse;
  const content = (body.result as { content?: Array<{ text: string }> } | undefined)?.content;
  const answer = content?.[0] !== undefined ? (JSON.parse(content[0].text) as Record<string, unknown>) : null;
  return { status: res.statusCode, body, answer, isError: (body.result as { isError?: boolean } | undefined)?.isError === true };
}

async function listed(r: Rig, token: string): Promise<McpToolsResponse['tools']> {
  const res = await r.app.inject({ method: 'POST', url: '/api/v1/mcp/tools', payload: { token } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as McpToolsResponse).tools;
}

const alive = (pid: number | null): boolean => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 25));
  }
};

const Q = 'SELECT t.a, t.b FROM s.t AS t';

describe.skipIf(process.platform === 'win32')('the gate on a Toolbox-runtime source (stand-in process)', () => {
  let r: Rig;
  beforeAll(async () => {
    r = await rig();
  }, 60_000);
  afterAll(async () => {
    r.sup.stopAll();
    await r.app.close();
    rmSync(r.base, { recursive: true, force: true });
  });

  it('describes through Toolbox on Test, and lists nothing to any unit until a person names its project', { timeout: 90_000 }, async () => {
    const t = await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb/test' });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ ok: true, tls: 'off', catalog: { catalog: { dialect: 'postgres', relations: [{ schema: 's', name: 't', primaryKey: ['a'] }] } } });
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-nodl/test' })).json()).toMatchObject({ ok: true });
    expect((await listed(r, 'wmt_a')).filter((x) => x.subject.startsWith('mcp:tb/') || x.subject.startsWith('mcp:tb-nodl/'))).toEqual([]);
    const hidden = await call(r, 'wmt_a', 'mcp:tb/list_tables');
    expect(hidden.answer).toMatchObject({ refused: 'unknown_source' });
  });

  it('an agent-kind bearer gets a 403 on the switches route, whatever its trust; a person sets them and each change is audited', async () => {
    r.setActor(AGENT);
    const no = await put(r, 'tb', { projects: ['proj_a'], query: true });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toMatchObject({ code: 'agents_switch_human_only' });
    r.setActor(LOCAL_ACTOR);
    const yes = await put(r, 'tb', { projects: ['proj_a'] });
    expect(yes.statusCode, yes.body).toBe(200);
    expect(yes.json()).toEqual({ name: 'tb', agents: { see: true, query: false, projects: ['proj_a'], everyProject: false } });
    await r.audit.flush();
    expect(readFileSync(join(r.base, 'audit.log'), 'utf8')).toContain('knowledge.source.agent_projects_set');
    expect((await put(r, 'tb', { see: false, query: true })).statusCode).toBe(409);
  });

  it('see on: the structure tool is listed (no first-use ask) for that project only; query off refuses rows', async () => {
    const a = (await listed(r, 'wmt_a')).filter((x) => x.subject.startsWith('mcp:tb/'));
    expect(a.map((x) => [x.subject, x.decision])).toEqual([['mcp:tb/list_tables', 'allow']]);
    expect((await listed(r, 'wmt_b')).filter((x) => x.subject.startsWith('mcp:tb/'))).toEqual([]);
    const st = await call(r, 'wmt_a', 'mcp:tb/list_tables');
    expect(st.status).toBe(200);
    expect(st.answer).toMatchObject({ source: 'tb', query: false, relations: [{ schema: 's', name: 't' }] });
    const off = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(off.answer).toMatchObject({ refused: 'query_off' });
  });

  it('query on: one read through the policy, the LIMIT rewrite, the envelope with cite and deps, and a two-step release', async () => {
    expect((await put(r, 'tb', { query: true })).statusCode).toBe(200);
    expect((await listed(r, 'wmt_a')).filter((x) => x.subject.startsWith('mcp:tb/')).map((x) => x.subject)).toEqual(['mcp:tb/list_tables', 'mcp:tb/execute_sql']);
    r.texts.length = 0;
    const ok = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: `${Q};` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Object.keys(ok.answer ?? {})[0]).toBe('untrusted');
    expect(ok.answer).toMatchObject({ source: 'tb', kind: 'postgres', deps: [`source:${TB_ID}`], columns: [{ name: 'a', type: null }, { name: 'b', type: null }], rows: [[1, 'x'], [2, 'y']], rowCount: 2, truncated: false, rowCap: 200, byteCap: 65536 });
    expect(String(ok.answer?.['cite'])).toMatch(/^src:tb@.+#[0-9a-f]{8}$/);
    expect(r.texts).toEqual([`SELECT * FROM (\n${Q}\n) AS q LIMIT 201`]);
    const lines = readFileSync(join(r.base, 'mcp', 'source-queries.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const mine = lines.filter((l) => l['callId'] === ok.body.callId);
    expect(mine.map((l) => [l['outcome'], l['released']])).toEqual([['unconfirmed', false], ['ok', true]]);
    expect(JSON.stringify(mine)).not.toContain('SELECT');
    const use = (await r.app.inject({ method: 'GET', url: '/api/v1/runs/run-a/data-use' })).json() as RunDataUseResponse;
    expect(use).toMatchObject({ known: true, sources: [{ source: 'tb', released: 1, rows: 2 }] });
    const recent = (await r.app.inject({ method: 'GET', url: '/api/v1/sources/tb/agent-queries' })).json() as SourceAgentQueriesResponse;
    expect(recent.queries[0]).toMatchObject({ source: 'tb', sourceId: TB_ID, outcome: 'ok', released: true });
  });

  it('SET, DDL, DML and two statements are refused before the process sees anything', async () => {
    r.texts.length = 0;
    for (const sql of ['SET default_transaction_read_only = off', 'CREATE TEMP TABLE x (a int)', 'UPDATE s.t SET b = 1', 'SELECT 1; SELECT 2']) {
      const res = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql });
      expect(res.isError, sql).toBe(true);
      expect(['not_select', 'statements']).toContain(res.answer?.['refused']);
    }
    expect(r.texts).toEqual([]);
  });

  it("a source error is its SQLSTATE only: the source's words (which echo a value) never leave crew", async () => {
    const res = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'ERROR'" });
    expect(res.answer).toMatchObject({ refused: 'source_error', sqlstate: '22P02' });
    expect(JSON.stringify(res.body)).not.toContain('invalid input syntax');
  });

  it('the deadline kills only that process; the next call finds a warm one', { timeout: 60_000 }, async () => {
    const before = r.sup.current(TB_ID)?.pid ?? null;
    expect(alive(before)).toBe(true);
    const res = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'HANG'" });
    expect(res.answer).toMatchObject({ refused: 'deadline' });
    await until(() => !alive(before));
    // the other source's process is untouched
    const other = r.sup.current(NODL_ID)?.pid ?? null;
    expect(alive(other)).toBe(true);
    const next = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(next.answer).toMatchObject({ rowCount: 2 });
    expect(r.sup.current(TB_ID)?.pid).not.toBe(before);
  });

  it('an answer past the 1 MiB read bound kills the process before crew parses it', async () => {
    const before = r.sup.current(TB_ID)?.pid ?? null;
    const res = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'BIG'" });
    expect(res.answer).toMatchObject({ refused: 'too_large' });
    await until(() => !alive(before));
    expect((await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
  });

  it('a secret with a quote, a newline and a backslash reaches the driver byte for byte, from the environment only; stderr is kept scrubbed', async () => {
    const p = r.sup.current(TB_ID);
    expect(p).not.toBeNull();
    const who = await p!.callTool('whoami', {}, 64 * 1024, 5_000);
    const w = JSON.parse(who.content[0]?.text ?? '{}') as { pw_sha: string; leaked: string[]; application_name: string };
    expect(w.pw_sha).toBe(createHash('sha256').update(SECRET).digest('hex'));
    expect(w.leaked).toEqual([]);
    expect(w.application_name).toBe('wicked-crew-tb-3f0c9a1e0000');
    await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'STDERR'" });
    await until(() => (r.sup.current(TB_ID)?.stderr ?? '').includes('connecting with'));
    const err = r.sup.current(TB_ID)?.stderr ?? '';
    for (const f of SECRET_FORMS) expect(err).not.toContain(f);
    expect(err).toContain('[redacted:secret]');
  });

  it('with no source-side deadline (timeout removed), a kill holds the source closed until its session is confirmed gone', { timeout: 60_000 }, async () => {
    expect((await put(r, 'tb-nodl', { projects: ['proj_a'], query: true })).statusCode).toBe(200);
    expect((await call(r, 'wmt_a', 'mcp:tb-nodl/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
    const runDir = join(r.base, 'mcp', 'adapters', 'toolbox', 'run', NODL_ID);
    writeFileSync(join(runDir, 'remote-running'), '');
    const killed = await call(r, 'wmt_a', 'mcp:tb-nodl/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'HANG'" });
    expect(killed.answer).toMatchObject({ refused: 'deadline' });
    const sched = r.gate.schedulers.get(NODL_ID);
    expect(sched?.state()).toMatchObject({ reserved: true, concurrency: 1 });
    expect((await call(r, 'wmt_a', 'mcp:tb-nodl/execute_sql', { sql: Q })).answer).toMatchObject({ refused: 'remote_work_pending' });
    expect(await sched?.recheck()).toBe(false);
    expect((await call(r, 'wmt_a', 'mcp:tb-nodl/execute_sql', { sql: Q })).answer).toMatchObject({ refused: 'remote_work_pending' });
    rmSync(join(runDir, 'remote-running'));
    expect(await sched?.recheck()).toBe(true);
    expect((await call(r, 'wmt_a', 'mcp:tb-nodl/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
    // the source WITH a deadline never held one
    expect(r.gate.schedulers.get(TB_ID)?.state().reserved).toBe(false);
  });

  it('a switch turned off while a read runs withholds its rows, and the record says not released', async () => {
    r.setAfterRead(async () => {
      await put(r, 'tb', { query: false });
    });
    const res = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ outcome: 'withheld', ruleIds: ['gate:changed'] });
    const lines = readFileSync(join(r.base, 'mcp', 'source-queries.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ outcome: 'changed_while_running', released: false });
    expect((await put(r, 'tb', { query: true })).statusCode).toBe(200);
  });

  it('an Apps unit is denied by the engine (D-7); an operator policy that asks is not answered by the switch', async () => {
    const apps = await call(r, 'wmt_apps', 'mcp:tb/execute_sql', { sql: Q });
    expect(apps.status).toBe(403);
    expect(apps.body).toMatchObject({ outcome: 'denied', ruleIds: ['engine:gated-tool'] });
    expect(await listed(r, 'wmt_apps')).toEqual([]);
    const ask = await call(r, 'wmt_ask', 'mcp:tb/execute_sql', { sql: Q });
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ outcome: 'pending_approval' });
  });

  it("a catalog that cannot be read is that source's own problem: the others and the tool list still answer", async () => {
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-unbound/test' })).json()).toMatchObject({ ok: true });
    const path = join(r.base, 'mcp', 'catalogs', 'tb-unbound.json');
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, '{ not json');
    expect((await listed(r, 'wmt_a')).some((x) => x.subject === 'mcp:tb/execute_sql')).toBe(true);
    expect((await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
    expect((await call(r, 'wmt_a', 'mcp:tb-unbound/list_tables')).answer).toMatchObject({ refused: 'not_described' });
    writeFileSync(path, good);
  });

  it('a tool whose disclosure class is not in force (reviewed against another schema) is offered to no agent', async () => {
    const tools = (await listed(r, 'wmt_a')).filter((x) => x.subject.startsWith('mcp:tb-unbound/')).map((x) => x.subject);
    expect(tools).toEqual(['mcp:tb-unbound/list_tables']);
    const res = await call(r, 'wmt_a', 'mcp:tb-unbound/execute_sql', { sql: Q });
    expect(res.answer).toMatchObject({ refused: 'tool_unreviewed' });
  });

  it("the registry previews a Toolbox-runtime source through the gate's probe: its tools and structure, from a throwaway process", async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/preview',
      payload: { name: 'tb-new', kind: 'toolbox-source', runtime: 'toolbox', toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' }, tls: { mode: 'disable' }, auth: { ref: 'env:KD_B2_FAKE_SECRET' }, address: { allow: ['127.0.0.0/8'], plaintext: false } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { tools: Array<{ name: string; disclosure?: string | null }> };
    expect(body.tools.map((t) => t.name).sort()).toEqual(['execute_sql', 'list_tables']);
    for (const s of SECRET_FORMS) expect(res.body.includes(s)).toBe(false);
    // a host name is refused by host mode before any process starts
    const named = await r.app.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers/preview',
      payload: { name: 'tb-named', kind: 'toolbox-source', runtime: 'toolbox', toolbox: { kind: 'source', type: 'postgres', host: 'db.example.com', port: '5432', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' }, tls: { mode: 'verify-full' }, auth: { ref: 'env:KD_B2_FAKE_SECRET' } },
    });
    expect(named.statusCode).toBeGreaterThanOrEqual(400);
    expect(named.body).toContain('container runtime');
  });

  it('a tool class cleared, or a switch turned off while the broker records the call, withholds the rows', async () => {
    // the class cleared during the read
    r.setAfterRead(async () => {
      const file = JSON.parse(readFileSync(join(r.base, 'mcp', 'registry.json'), 'utf8')) as { servers: Array<{ name: string; tools: Array<{ name: string; disclosure: unknown }> }> };
      const t = file.servers.find((x) => x.name === 'tb')?.tools.find((x) => x.name === 'execute_sql');
      if (t !== undefined) t.disclosure = null;
      writeFileSync(join(r.base, 'mcp', 'registry.json'), JSON.stringify(file));
    });
    const cleared = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(cleared.body).toMatchObject({ outcome: 'withheld', ruleIds: ['gate:changed'] });
    const file = JSON.parse(readFileSync(join(r.base, 'mcp', 'registry.json'), 'utf8')) as { servers: Array<{ name: string; tools: unknown[] }> };
    (file.servers.find((x) => x.name === 'tb') as { tools: unknown[] }).tools = gatedTools();
    writeFileSync(join(r.base, 'mcp', 'registry.json'), JSON.stringify(file));
    // the switch turned off while the broker writes its own call record
    r.setOnBrokerRecord(async () => {
      await put(r, 'tb', { query: false });
    });
    const flipped = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(flipped.body).toMatchObject({ outcome: 'withheld', ruleIds: ['gate:changed'] });
    expect(JSON.stringify(flipped.body)).not.toContain('"rows"');
    const lines = readFileSync(join(r.base, 'mcp', 'source-queries.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l['callId'] === flipped.body.callId).at(-1)).toMatchObject({ released: false });
    expect((await put(r, 'tb', { query: true })).statusCode).toBe(200);
  });

  it('a record that cannot be written withholds the rows, at either step', async () => {
    r.setFailRecord((e) => e.outcome === 'unconfirmed');
    const first = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(first.body).toMatchObject({ outcome: 'withheld', ruleIds: ['gate:record'] });
    r.setFailRecord((e) => e.outcome === 'ok');
    const second = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q });
    expect(second.body).toMatchObject({ outcome: 'withheld', ruleIds: ['gate:record'] });
    r.setFailRecord(null);
    const lines = readFileSync(join(r.base, 'mcp', 'source-queries.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l['callId'] === second.body.callId).at(-1)).toMatchObject({ outcome: 'unconfirmed', released: false });
  });

  it('a record damaged mid-file is unknown, never "no data used"; a torn last line is skipped, and cut before the next append', async () => {
    const path = join(r.base, 'mcp', 'source-queries.ndjson');
    const good = readFileSync(path, 'utf8');
    const use = async () => (await r.app.inject({ method: 'GET', url: '/api/v1/runs/run-a/data-use' })).json() as RunDataUseResponse;
    writeFileSync(path, `${good}{"callId":"torn`);
    expect((await use()).known).toBe(true);
    // the next append cuts the torn tail: the file holds whole lines only
    expect((await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
    const after = readFileSync(path, 'utf8');
    expect(after.includes('{"callId":"torn')).toBe(false);
    expect(after.endsWith('\n')).toBe(true);
    // a damaged entry in the middle (it starts like one, and a whole line follows it) makes the record unknown
    const lines = after.trim().split('\n');
    const damaged = [...lines.slice(0, -2), `${lines.at(-2)!.slice(0, 30)}`, lines.at(-1)!].join('\n') + '\n';
    writeFileSync(path, damaged);
    expect((await use()).known).toBe(false);
    writeFileSync(path, `garbage line\n${after}`);
    expect((await use()).known).toBe(false);
    writeFileSync(path, after);
    expect((await use()).known).toBe(true);
  });

  it('after a restart a no-deadline source is reconciled before a Test describes it too', { timeout: 60_000 }, async () => {
    const runDir = join(r.base, 'mcp', 'adapters', 'toolbox', 'run', NODL_ID);
    writeFileSync(join(runDir, 'remote-running'), '');
    // a fresh process (as after a daemon restart): the old one is gone
    r.sup.current(NODL_ID)?.kill();
    await until(() => r.sup.current(NODL_ID) === null);
    const t = (await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-nodl/test' })).json() as { ok: boolean; code?: string };
    expect(t).toMatchObject({ ok: false, code: 'remote_work_pending' });
    expect(r.gate.schedulers.get(NODL_ID)?.state().reserved).toBe(true);
    rmSync(join(runDir, 'remote-running'));
    expect(await r.gate.schedulers.get(NODL_ID)?.recheck()).toBe(true);
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-nodl/test' })).json()).toMatchObject({ ok: true });
  });

  it('two probes of one saved entry at once (its id is their label) each get their own process directory', { timeout: 60_000 }, async () => {
    const [a, b] = await Promise.all([1, 2].map(() => r.app.inject({ method: 'POST', url: '/api/v1/mcp/servers/tb/test' })));
    expect([a?.statusCode, b?.statusCode], `${a?.body} ${b?.body}`).toEqual([200, 200]);
    expect([a?.json(), b?.json()].map((x) => (x as { ok?: boolean }).ok)).toEqual([true, true]);
    expect(readdirSync(join(r.base, 'mcp', 'adapters', 'toolbox', 'run')).filter((d) => d.startsWith('preview-'))).toEqual([]);
  });

  it('an ask with no rule ids is not first use: it stays pending', async () => {
    const bare = await call(r, 'wmt_bare', 'mcp:tb/execute_sql', { sql: Q });
    expect(bare.status).toBe(409);
    expect((await listed(r, 'wmt_bare')).find((x) => x.subject === 'mcp:tb/execute_sql')?.decision).toBe('ask');
  });

  it('two output columns of one name are refused on the Toolbox runtime, never answered short', async () => {
    const dup = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: 'SELECT t.a, t.a FROM s.t AS t' });
    expect(dup.answer).toMatchObject({ refused: 'ambiguous_columns' });
    const collapsed = await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a, t.b AS c FROM s.t AS t WHERE t.b = 'DUPCOLS'" });
    expect(collapsed.answer).toMatchObject({ refused: 'ambiguous_columns' });
  });

  it('a session without the application name crew wrote is refused at open; a half-written secret never shows in stderr', async () => {
    const wrong = (await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-wrongapp/test' })).json() as { ok: boolean; code?: string };
    expect(wrong).toMatchObject({ ok: false, code: 'adapter_unverified' });
    expect(r.sup.current(WRONGAPP_ID)).toBeNull();
    await call(r, 'wmt_a', 'mcp:tb/execute_sql', { sql: "SELECT t.a FROM s.t AS t WHERE t.b = 'STDERRPART'" });
    await until(() => (r.sup.current(TB_ID)?.stderr ?? '').includes('half a write'));
    const err = r.sup.current(TB_ID)?.stderr ?? '';
    expect(err.endsWith(SECRET.slice(0, 6))).toBe(false);
    expect(err).not.toContain(SECRET.slice(0, 6));
  });

  it("a preview of a Toolbox source saves with its tools on: preview -> save -> the person's switch -> a read", async () => {
    const body = { name: 'tb-saved', kind: 'toolbox-source', runtime: 'toolbox', toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' }, tls: { mode: 'disable' }, auth: { ref: 'env:KD_B2_FAKE_SECRET' }, address: { allow: ['127.0.0.0/8'], plaintext: false } };
    const p = await r.app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: body });
    expect(p.statusCode, p.body).toBe(200);
    const saved = await r.app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: (p.json() as { previewHash: string }).previewHash } });
    expect(saved.statusCode, saved.body).toBeLessThan(300);
    expect((await r.app.inject({ method: 'POST', url: '/api/v1/sources/tb-saved/test' })).json()).toMatchObject({ ok: true });
    expect((await put(r, 'tb-saved', { projects: ['proj_a'], query: true })).statusCode).toBe(200);
    expect((await listed(r, 'wmt_a')).filter((x) => x.subject.startsWith('mcp:tb-saved/')).map((x) => x.subject).sort()).toEqual(['mcp:tb-saved/execute_sql', 'mcp:tb-saved/list_tables']);
    expect((await call(r, 'wmt_a', 'mcp:tb-saved/execute_sql', { sql: Q })).answer).toMatchObject({ rowCount: 2 });
  }, 60_000);

  it('a scan finds the secret in no file, log or answer', async () => {
    await r.audit.flush();
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(r.base);
    expect(files.some((f) => f.endsWith('tools.yaml'))).toBe(true);
    for (const f of files) {
      if (f === join(r.base, 'toolbox')) continue;
      const text = readFileSync(f, 'utf8');
      for (const s of SECRET_FORMS) expect(text.includes(s), `${f} holds the secret`).toBe(false);
    }
    for (const a of r.answers) for (const s of SECRET_FORMS) expect(a.includes(s)).toBe(false);
    expect(existsSync(join(r.base, 'audit.log'))).toBe(true);
    void randomUUID;
  });
});
