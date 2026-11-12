// wicked-core#1018 option A — the broker's estate relay (`mcp:estate/<tool>`, src/mcp/estate-relay.ts).
//
// A container seat has no estate of its own, so garden's shim sends its estate calls to the broker
// as `mcp:estate/<tool>`. These tests pin what the relay promises:
//   1. the token is resolved by the ENGINE (a fake here: only core's carriers can mint one; core's
//      `a_token_resolves_to_its_units_estate_scope_while_bound` pins the real resolver), and an
//      unknown token is a 401, an engine without the resolver a refusal;
//   2. only the read-only lookups and `proposal.submit` are relayed; a graph lookup needs the run's
//      code graph; a proposal needs a memory store to land in;
//   3. a recall's intent and a proposal's facets are the RUN's project and repo, never the worker's,
//      and a worker's provenance is dropped (the server stamps it from the unit);
//   4. sizes are clamped, a result over the bound is withheld, a deadline is a 504, and every call
//      spends the unit's budget and is recorded against its run; a landed proposal is audited;
//   5. the real invocation spawns `wicked-estate-mcp --readonly` with the run's graph (never the
//      daemon's boot store), this daemon's memory store and the unit's provenance;
//   6. no registered server may take the reserved name;
//   7. `rules.recall` is answered from the rules in force for the run's project (the set the rule judge reads),
//      never from the code graph, by id or whole, and an unreadable set is a failure, never "no rules".

import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { readInForce, type InForceRead } from '../src/decisions/consider.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { ConformanceRule, McpCallRecord, McpCallResponse } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import {
  ARG_CAPS,
  defaultEstateInvoker,
  ESTATE_RELAY_MAX_RESULT_BYTES,
  EstateRelay,
  estateRelayEnv,
  estateRefusal,
  scopeEstateArgs,
  type EstateProposalLanded,
  type EstateRelayAnswer,
  type EstateRelayInvocation,
  type EstateUnitScope,
} from '../src/mcp/estate-relay.js';
import { McpRegistry, McpRegistryError } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { removeScratch } from './setup/scratch.js';

const UNIT = { runId: 'run-b445', ord: 4, attempt: 1, phase: 'unit-4', seat: 'pi' };
const SCOPED: EstateUnitScope = { unit: UNIT, projectId: 'proj_abc', repoId: 'repo-core', codeGraphDb: '/state/repo-graphs/k1/estate.db' };
const BARE: EstateUnitScope = { unit: UNIT, projectId: null, repoId: null, codeGraphDb: null };

function envelope(payload: unknown, diagnostics?: string): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: JSON.stringify(payload) }];
  if (diagnostics !== undefined) content.push({ type: 'text', text: diagnostics });
  return { content, isError: false };
}

describe('scopeEstateArgs: the run decides project and repo, never the worker', () => {
  it("sets a recall's intent to the run's project and repo, over what the worker asked for", () => {
    const out = scopeEstateArgs('memory.recall', { query: 'q', intent: { project: 'someone-else', cli: 'pi' } }, SCOPED);
    expect(out['intent']).toEqual({ project: 'proj_abc', repo: 'repo-core', cli: 'pi' });
  });

  it('removes a project or repo axis the run has none for, so no other project is reachable', () => {
    const out = scopeEstateArgs('memory.recall', { query: 'q', intent: { project: 'someone-else', repo: 'x' } }, BARE);
    expect(out['intent']).toEqual({});
  });

  it("files a proposal under the run's project and repo and drops the worker's provenance", () => {
    const out = scopeEstateArgs(
      'proposal.submit',
      { kind_type: 'memory', payload: { content: 'c' }, facets: { project: 'forged', repo: 'forged' }, provenance: { run_id: 'forged' } },
      SCOPED,
    );
    expect(out['facets']).toEqual({ project: 'proj_abc', repo: 'repo-core' });
    expect(out).not.toHaveProperty('provenance');
  });

  it("keeps the worker's own project on a proposal only when the run is filed into none", () => {
    const out = scopeEstateArgs('proposal.submit', { kind_type: 'memory', payload: {}, facets: { project: 'wicked', repo: 'x' } }, BARE);
    expect(out['facets']).toEqual({ project: 'wicked' });
  });

  it('lowers every capped size argument to its cap and leaves smaller ones alone', () => {
    const out = scopeEstateArgs('BlastRadius', { symbol: 's', depth: 99, limit: 5, token_budget: 1e9 }, SCOPED);
    expect(out).toEqual({ symbol: 's', depth: ARG_CAPS['depth'], limit: 5, token_budget: ARG_CAPS['token_budget'] });
  });
});

describe('estateRefusal: what the relay never makes', () => {
  const store = (present: boolean) => () => present;
  it('refuses a tool off the list (a write, an approval) by name', () => {
    for (const tool of ['memory.capture', 'proposal.approve', 'knowledge.ingest', 'FetchContent']) {
      expect(estateRefusal(tool, SCOPED, '/m.db', store(true))?.ruleId).toBe('estate:not-relayed');
    }
  });
  it('refuses a graph lookup for a run with no code graph, and relays memory and knowledge recall and the rules in force', () => {
    expect(estateRefusal('BlastRadius', BARE, '/m.db', store(true))?.ruleId).toBe('estate:no-code-graph');
    expect(estateRefusal('rules.recall', BARE, '/m.db', store(true))).toBeNull();
    expect(estateRefusal('memory.recall', BARE, '/m.db', store(true))).toBeNull();
    expect(estateRefusal('knowledge.recall', BARE, '/m.db', store(true))).toBeNull();
    expect(estateRefusal('BlastRadius', SCOPED, '/m.db', store(true))).toBeNull();
  });
  it('refuses a proposal when this daemon has no memory store for it to land in', () => {
    expect(estateRefusal('proposal.submit', SCOPED, '/m.db', store(false))?.ruleId).toBe('estate:no-memory-store');
    expect(estateRefusal('proposal.submit', SCOPED, '/m.db', store(true))).toBeNull();
  });
});

describe('estateRelayEnv: which store, whose provenance', () => {
  it("opens the run's graph (never the daemon's boot store) and stamps the unit's provenance", () => {
    const env = estateRelayEnv(SCOPED, { WICKED_ESTATE_DB: '/daemon/core.db', WICKED_RUN_PROJECT: 'leaked', WICKED_MEMORY_DB: '/mem/memory.db', PATH: '/bin' });
    expect(env['WICKED_ESTATE_DB']).toBe('/state/repo-graphs/k1/estate.db');
    expect(env['WICKED_MEMORY_DB']).toBe('/mem/memory.db');
    expect([env['WICKED_RUN_ID'], env['WICKED_RUN_UNIT'], env['WICKED_RUN_AGENT']]).toEqual(['run-b445', '4', 'pi']);
    expect(env['WICKED_RUN_PROJECT']).toBeUndefined();
  });
  it('opens no graph at all for a run that has none', () => {
    expect(estateRelayEnv(BARE, { WICKED_ESTATE_DB: '/daemon/core.db' })['WICKED_ESTATE_DB']).toBe(':memory:');
  });
});

describe('the broker relays mcp:estate/<tool>', () => {
  let base: string;
  let app: FastifyInstance;
  let records: McpCallRecordFile;
  let published: McpCallRecord[];
  let invocations: EstateRelayInvocation[];
  let landed: EstateProposalLanded[];
  let answer: (call: EstateRelayInvocation) => Promise<EstateRelayAnswer>;
  let scope: EstateUnitScope;
  let resolverPresent: boolean;
  let memoryStorePresent: boolean;

  async function boot(budgetPerUnit = 200, rules?: (projectId: string | null) => Promise<InForceRead>): Promise<void> {
    const relay = new EstateRelay({
      ...(rules !== undefined ? { rules } : {}),
      resolver: () =>
        resolverPresent
          ? async (requestJson: string) => {
              const { token } = JSON.parse(requestJson) as { token: string };
              if (token !== 'wmt_good') throw new Error('invalid_token: the MCP token is not bound to a running unit');
              return JSON.stringify(scope);
            }
          : null,
      invoke: async (call) => {
        invocations.push(call);
        return answer(call);
      },
      memoryDb: () => '/daemon/memory.db',
      exists: () => memoryStorePresent,
      onProposal: (p) => landed.push(p),
    });
    const broker = new McpBroker({
      registry: { resolveCall: async () => null, callSecret: async () => ({ secret: null, missing: false }) } as never,
      // A gate is never consulted for an estate call: the relay judges it (wicked-core#1018).
      engine: () => null,
      records,
      budgetPerUnit,
      publish: (r) => {
        published.push(r);
      },
      estate: relay,
    });
    app = Fastify();
    registerMcpRoutes(app, { broker, audit: AuditLog.noop(), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  }

  async function call(subject: string, args: Record<string, unknown> = {}, token = 'wmt_good') {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token, subject, args } });
    return { status: res.statusCode, body: res.json() as McpCallResponse & { code?: string } };
  }

  function recorded(): McpCallRecord[] {
    return readFileSync(records.path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as McpCallRecord);
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crew-estate-relay-'));
    records = new McpCallRecordFile(join(base, 'mcp'));
    published = [];
    invocations = [];
    landed = [];
    scope = SCOPED;
    resolverPresent = true;
    memoryStorePresent = true;
    answer = async () => ({ result: envelope({ dependents: ['a', 'b'] }, 'STALENESS: 0 commits behind') });
  });

  afterEach(async () => {
    await app?.close();
    removeScratch(base);
  });

  it('answers a graph lookup with the envelope as estate wrote it, diagnostics included, recorded against the run', async () => {
    await boot();
    const r = await call('mcp:estate/BlastRadius', { symbol: 'arm_worker_mcp_channel', depth: 50 });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('ok');
    expect(r.body.result).toEqual(envelope({ dependents: ['a', 'b'] }, 'STALENESS: 0 commits behind'));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual({ symbol: 'arm_worker_mcp_channel', depth: ARG_CAPS['depth'] });
    expect(invocations[0]?.scope).toEqual(SCOPED);
    const [rec] = recorded();
    expect(rec?.traceId).toBe('run-b445');
    expect(rec?.parentSpanId).toBe('4:1');
    expect(rec?.outcome).toBe('ok');
    expect(rec?.decision.by).toBe('broker:estate');
    expect(rec?.attrs['mcp.subject']).toBe('mcp:estate/BlastRadius');
    expect(rec?.attrs['mcp.class']).toBe('read');
    expect(rec?.attrs['wicked.seat']).toBe('pi');
    expect(published).toHaveLength(1);
    expect(r.body.callId).toBe(rec?.spanId);
  });

  it('lands a proposal under the run, scoped, and hands it to the audit hook', async () => {
    answer = async () => ({ result: envelope({ id: 'prop-123' }) });
    await boot();
    const r = await call('mcp:estate/proposal.submit', {
      kind_type: 'memory',
      payload: { content: 'the container floor reaches estate through the broker', tier: 'semantic' },
      facets: { project: 'forged' },
    });
    expect(r.status).toBe(200);
    expect(invocations[0]?.args['facets']).toEqual({ project: 'proj_abc', repo: 'repo-core' });
    expect(landed).toEqual([{ ...UNIT, proposalId: 'prop-123', kindType: 'memory', callId: r.body.callId }]);
    expect(recorded()[0]?.attrs['mcp.class']).toBe('write');
  });

  it("hands estate's JSON-RPC error back as a tool error that keeps its code (-32602 = fix the args)", async () => {
    answer = async () => ({ rpcError: { code: -32602, message: 'invalid memory tier "durable"' } });
    await boot();
    const r = await call('mcp:estate/proposal.submit', { kind_type: 'memory', payload: { tier: 'durable' } });
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({
      content: [{ type: 'text', text: 'invalid memory tier "durable"' }],
      isError: true,
      rpcError: { code: -32602, message: 'invalid memory tier "durable"' },
    });
    expect(landed).toEqual([]);
    expect(recorded()[0]?.status.errorClass).toBe('tool_error');
  });

  it('is a 401 for a token the engine does not know, and runs nothing', async () => {
    await boot();
    const r = await call('mcp:estate/memory.recall', { query: 'q' }, 'wmt_forged');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('invalid_token');
    expect(invocations).toEqual([]);
  });

  it('refuses every estate call on an engine without the resolver, rather than relay it unscoped', async () => {
    resolverPresent = false;
    await boot();
    const r = await call('mcp:estate/memory.recall', { query: 'q' });
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(r.body.reason).toMatch(/resolveEstateScope/);
    expect(invocations).toEqual([]);
  });

  it('refuses a tool it does not relay, and a graph lookup for a run without a graph, without running them', async () => {
    await boot();
    const write = await call('mcp:estate/memory.capture', { content: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.outcome).toBe('denied');
    expect(write.body.ruleIds).toEqual(['estate:not-relayed']);
    scope = BARE;
    const graph = await call('mcp:estate/RankHotspots', { limit: 20 });
    expect(graph.body.ruleIds).toEqual(['estate:no-code-graph']);
    expect(invocations).toEqual([]);
    expect(recorded().map((r) => r.outcome)).toEqual(['denied', 'denied']);
  });

  it('refuses a proposal when the daemon has no memory store yet', async () => {
    memoryStorePresent = false;
    await boot();
    const r = await call('mcp:estate/proposal.submit', { kind_type: 'memory', payload: {} });
    expect(r.body.ruleIds).toEqual(['estate:no-memory-store']);
    expect(invocations).toEqual([]);
  });

  it('withholds a result over the bound, with a remedy', async () => {
    answer = async () => ({ result: envelope({ blob: 'x'.repeat(ESTATE_RELAY_MAX_RESULT_BYTES) }) });
    await boot();
    const r = await call('mcp:estate/SearchEntity', { name: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.outcome).toBe('withheld');
    expect(r.body.result).toBeUndefined();
    expect(r.body.remedy).toMatch(/narrow/);
  });

  it('answers a deadline as a 504 and a crash as a 502, never a result', async () => {
    answer = async () => {
      throw new Error('wicked-estate-mcp did not answer Lineage within 30000ms');
    };
    await boot();
    expect((await call('mcp:estate/Lineage', { symbol: 's' })).status).toBe(504);
    answer = async () => {
      throw new Error('wicked-estate-mcp exited before answering Lineage');
    };
    const crashed = await call('mcp:estate/Lineage', { symbol: 's' });
    expect(crashed.status).toBe(502);
    expect(crashed.body.outcome).toBe('upstream_error');
  });

  it("spends the unit's call budget", async () => {
    await boot(2);
    // A knowledge read answers its items list (the release check withholds any other shape).
    answer = async (c) => ({ result: envelope(c.tool === 'knowledge.recall' ? { items: [] } : { dependents: ['a', 'b'] }) });
    expect((await call('mcp:estate/memory.recall', { query: 'a' })).status).toBe(200);
    expect((await call('mcp:estate/knowledge.recall', { query: 'b' })).status).toBe(200);
    const third = await call('mcp:estate/memory.recall', { query: 'c' });
    expect(third.status).toBe(429);
    expect(third.body.outcome).toBe('budget_exhausted');
    expect(invocations).toHaveLength(2);
  });
});

describe('(ctx-pull) rules.recall answers the set the rule judge reads', () => {
  const rule = (id: string, severity: ConformanceRule['severity'], project?: string): ConformanceRule =>
    ({ id, rule_type: 'policy', severity, statement: `${id}: the whole statement.`, confidence: 1, targets: project === undefined ? {} : { project }, provenance: { source: 'ui', source_kinds: [] }, steering_type: 'testing' }) as ConformanceRule;
  // The engine's considerRules: the global rules plus the asked project's own (core `rules_in_force`, which the judge calls).
  const GLOBAL = [rule('POL-2500', 'critical'), rule('learn-tests-with-fixes', 'warn')];
  const OWN = [rule('proposal:01a07cd5-1111', 'error', 'proj_abc')];
  const OTHER = [rule('proposal:other-project', 'error', 'proj_other')];
  const asked: Array<string[] | undefined> = [];
  const engine = {
    projectRulesSupported: () => true,
    considerRules: async (q: { projects?: string[] }) => {
      asked.push(q.projects);
      const p = q.projects ?? [];
      return { in_force: [...GLOBAL, ...(p.includes('proj_abc') ? OWN : []), ...(p.includes('proj_other') ? OTHER : [])], set_aside: [] };
    },
  };
  let base: string;
  let app: FastifyInstance;
  let invocations: EstateRelayInvocation[];

  async function boot(scope: EstateUnitScope, rules?: (projectId: string | null) => Promise<InForceRead>): Promise<void> {
    const relay = new EstateRelay({
      resolver: () => async () => JSON.stringify(scope),
      // The code graph's own rule rows (code-extracted fixtures, no steering rules): never what a seat is judged on.
      invoke: async (call) => {
        invocations.push(call);
        return { result: envelope({ rules: [{ id: 'rego:fixture/deny_all' }], returned: 1, total: 1 }) };
      },
      memoryDb: () => '/daemon/memory.db',
      exists: () => true,
      ...(rules !== undefined ? { rules } : {}),
    });
    const broker = new McpBroker({
      registry: { resolveCall: async () => null, callSecret: async () => ({ secret: null, missing: false }) } as never,
      engine: () => null,
      records: new McpCallRecordFile(join(base, 'mcp')),
      budgetPerUnit: 200,
      publish: () => undefined,
      estate: relay,
    });
    app = Fastify();
    registerMcpRoutes(app, { broker, audit: AuditLog.noop(), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  }

  async function recall(args: Record<string, unknown> = {}) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_good', subject: 'mcp:estate/rules.recall', args } });
    const body = res.json() as McpCallResponse & { reason?: string };
    const text = ((body.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text) ?? 'null';
    return { status: res.statusCode, body, payload: JSON.parse(text) as { rules: ConformanceRule[]; returned: number; total: number; missing: string[]; source: string } | null };
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crew-estate-rules-'));
    invocations = [];
    asked.length = 0;
  });
  afterEach(async () => {
    await app?.close();
    removeScratch(base);
  });

  it("(fails before the fix) returns exactly the ids the judge's considerRules({projects:[p]}) holds for the run's project, with no code graph and no estate spawn", async () => {
    const judged = (await engine.considerRules({ projects: ['proj_abc'] })).in_force.map((r) => r.id).sort();
    await boot({ ...BARE, projectId: 'proj_abc' }, (p) => readInForce(engine, p));
    const r = await recall();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.payload!.rules.map((x) => x.id).sort()).toEqual(judged);
    expect(r.payload!.rules[0]!.statement).toBe('POL-2500: the whole statement.');
    expect(r.payload!.source).toBe('considerRules');
    expect(asked.at(-1)).toEqual(['proj_abc']);
    expect(invocations).toEqual([]);
  });

  it("answers from the in-force set even when the run has a code graph, and a worker's own project argument changes nothing", async () => {
    await boot(SCOPED, (p) => readInForce(engine, p));
    const r = await recall({ project: 'proj_other', ids: ['proposal:other-project', 'proposal:01a07cd5-1111'] });
    expect(r.payload!.rules.map((x) => x.id)).toEqual(['proposal:01a07cd5-1111']);
    expect(r.payload!.missing).toEqual(['proposal:other-project']);
    expect(invocations).toEqual([]);
  });

  it('pulls by id (or a single id), names an id not in force as missing, and keeps severity order, filters and limit', async () => {
    await boot(SCOPED, (p) => readInForce(engine, p));
    const byIds = await recall({ ids: ['learn-tests-with-fixes', 'POL-2500', 'nope'] });
    expect(byIds.payload).toMatchObject({ returned: 2, total: 2, missing: ['nope'] });
    expect(byIds.payload!.rules.map((x) => x.id)).toEqual(['POL-2500', 'learn-tests-with-fixes']);
    expect((await recall({ id: 'POL-2500' })).payload!.rules.map((x) => x.id)).toEqual(['POL-2500']);
    expect((await recall({ severity: 'warn' })).payload!.rules.map((x) => x.id)).toEqual(['learn-tests-with-fixes']);
    expect((await recall({ rule_type: 'pattern' })).payload!.rules).toEqual([]);
    expect((await recall({ limit: 1 })).payload).toMatchObject({ returned: 1, total: 3 });
  });

  it('an unreadable rule store is a failure with its reason, never an empty set a seat could read as "no rules"', async () => {
    await boot(SCOPED, (p) => readInForce({}, p));
    const r = await recall({ ids: ['POL-2500'] });
    expect(r.status).toBe(502);
    expect(r.body.outcome).toBe('upstream_error');
    expect(r.body.reason).toMatch(/could not be read/);
    expect(invocations).toEqual([]);
  });

  it('a relay with no rule read refuses rules.recall rather than answer it from the code graph', async () => {
    await boot(SCOPED);
    const r = await recall();
    expect(r.body.ruleIds).toEqual(['estate:no-rules-source']);
    expect(invocations).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('defaultEstateInvoker: the real spawn', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-estate-relay-spawn-'));
    saved = process.env['WICKED_ESTATE_MCP_EXE'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['WICKED_ESTATE_MCP_EXE'];
    else process.env['WICKED_ESTATE_MCP_EXE'] = saved;
    removeScratch(dir);
  });

  it('spawns wicked-estate-mcp --readonly on the run graph with the unit provenance, and returns a JSON-RPC error as data', async () => {
    const exe = join(dir, 'fake-estate-mcp');
    // A fake estate-mcp: answers tools/call with its own argv and the env the relay set, or with a
    // JSON-RPC error for the tool named `fail`.
    writeFileSync(
      exe,
      `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'wicked-estate' } } });
  if (msg.method !== 'tools/call') return;
  if (msg.params.name === 'fail') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad args' } });
  const pick = ['WICKED_ESTATE_DB', 'WICKED_MEMORY_DB', 'WICKED_RUN_ID', 'WICKED_RUN_UNIT', 'WICKED_RUN_AGENT'];
  const env = Object.fromEntries(pick.map((k) => [k, process.env[k]]));
  send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), env, args: msg.params.arguments }) }], isError: false } });
});
`,
    );
    chmodSync(exe, 0o755);
    mkdirSync(join(dir, 'state'));
    process.env['WICKED_ESTATE_MCP_EXE'] = exe;
    const invoke = defaultEstateInvoker();
    const got = await invoke({ tool: 'BlastRadius', args: { symbol: 's' }, scope: SCOPED, timeoutMs: 10_000 });
    expect('result' in got).toBe(true);
    const text = ((got as { result: { content: Array<{ text: string }> } }).result.content[0]?.text) ?? '';
    const echoed = JSON.parse(text) as { argv: string[]; env: Record<string, string>; args: unknown };
    expect(echoed.argv).toEqual(['--readonly']);
    expect(echoed.env['WICKED_ESTATE_DB']).toBe(SCOPED.codeGraphDb);
    expect(echoed.env['WICKED_MEMORY_DB']).toMatch(/memory\.db$/);
    expect([echoed.env['WICKED_RUN_ID'], echoed.env['WICKED_RUN_UNIT'], echoed.env['WICKED_RUN_AGENT']]).toEqual(['run-b445', '4', 'pi']);
    expect(echoed.args).toEqual({ symbol: 's' });
    expect(await invoke({ tool: 'fail', args: {}, scope: SCOPED, timeoutMs: 10_000 })).toEqual({ rpcError: { code: -32602, message: 'bad args' } });
  });
});

describe('the reserved name', () => {
  it('no registered server may be saved as "estate"', async () => {
    const base = mkdtempSync(join(tmpdir(), 'crew-estate-reserved-'));
    try {
      const registry = new McpRegistry({
        store: new McpRegistryStore(join(base, 'mcp')),
        secrets: { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined },
        probe: async () => {
          throw new Error('never probed');
        },
        discover: () => [],
      });
      const err = await registry.preview({ name: 'estate', kind: 'mcp-stdio', command: 'x', args: [], env: {}, auth: null } as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpRegistryError);
      expect((err as McpRegistryError).code).toBe('reserved_name');
    } finally {
      removeScratch(base);
    }
  });
});
