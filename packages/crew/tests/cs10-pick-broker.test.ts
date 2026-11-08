// DES-CATALOG-002 CS10, slice X: a job's pick is shared by every unit, before admission, budget and invocation.
// The broker and lister are real; the gate and engine answer at their seams so an accidental invocation is observable.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunSourcePicks } from '../src/api/run-sources.js';
import type { McpCallRecord } from '../src/core/types.js';
import type { DataGate, GateListedTool, GateUnitResult } from '../src/knowledge/gate/gate.js';
import { McpBroker, type McpBrokerDeps } from '../src/mcp/broker.js';
import { EstateRelay } from '../src/mcp/estate-relay.js';
import type { McpCallableTool, McpCallTarget } from '../src/mcp/registry.js';
import { FENCE_RULE, pickAllows, PICK_RULE, type RunFence, type SourcePicks } from '../src/mcp/run-fence.js';
import { listUnitTools } from '../src/mcp/tool-list.js';

const SOURCE_TOOLS: GateListedTool[] = [
  { server: 'support-pg', id: 'source-pg-id', tool: 'execute_sql', disclosure: 'rows', description: 'read support', inputSchema: {} },
  { server: 'web', id: 'source-web-id', tool: 'search', disclosure: 'rows', description: 'search the web', inputSchema: {} },
];
const REGISTRY_TOOLS: McpCallableTool[] = [
  // Raw source tools must stay excluded even when the pick leaves out their gated counterpart.
  { server: 'support-pg', id: 'source-pg-id', tool: 'execute_sql', kind: 'mcp-stdio', disclosure: 'rows', annotations: null, classOverride: 'read', description: 'raw source', inputSchema: {} },
  { server: 'files', id: 'files-id', tool: 'read', kind: 'mcp-stdio', disclosure: null, annotations: { readOnlyHint: true }, classOverride: 'read', description: 'read a file', inputSchema: {} },
];
const unitOf = (token: string) => ({ runId: token === 'other-run' ? 'run-open' : 'run-web', ord: token === 'later' ? 9 : 1, attempt: token === 'retry' || token === 'later' ? 2 : 0, phase: 'work', seat: 'codex' });
const brokenPicks: SourcePicks = { get: () => { throw new Error('unreadable pick'); } };
const scratch: string[] = [];

function savedPick(ids: string[]): RunSourcePicks {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cs10-pick-'));
  scratch.push(dir);
  const picks = new RunSourcePicks(join(dir, 'run-source-picks.json'));
  picks.set('run-web', ids);
  return picks;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(picks: SourcePicks | undefined, fence?: RunFence) {
  const gate = {
    owns: vi.fn(async (server: string) => SOURCE_TOOLS.some((t) => t.server === server)),
    resolve: vi.fn(async (token: string) => ({ unit: unitOf(token), projectId: 'project' })),
    sources: vi.fn(async () => SOURCE_TOOLS.map((t) => ({ id: t.id, name: t.server }))),
    reach: vi.fn(async () => SOURCE_TOOLS),
    admitted: vi.fn(async (_token: string, calls: ReadonlyArray<{ server: string; tool: string }>) => new Map(calls.map((c) => [`mcp:${c.server}/${c.tool}`, 'allow' as const]))),
    unitCall: vi.fn(async (): Promise<GateUnitResult> => ({ ok: true, answer: { rows: [] }, isError: false })),
  };
  const registry: McpBrokerDeps['registry'] & { callableTools(): Promise<McpCallableTool[]> } = {
    resolveCall: vi.fn(async (server: string): Promise<McpCallTarget> => ({
      config: { name: server, kind: 'mcp-stdio', command: null, args: [], url: null, auth: null },
      rest: null, annotations: { readOnlyHint: true }, classOverride: 'read', schemaHash: 'hash', disclosure: null,
      id: 'files-id', registered: true, resaveRequired: false,
    })),
    callSecret: vi.fn(async () => ({ secret: null, missing: false })),
    callableTools: async () => REGISTRY_TOOLS,
  };
  const engine = {
    evaluateCall: async (json: string) => {
      const { token, call } = JSON.parse(json) as { token: string; call: { server: string; tool: string } };
      return JSON.stringify({ decision: 'allow', subject: `mcp:${call.server}/${call.tool}`, class: 'read', ruleIds: [], obligations: [], claimId: 'claim', unit: unitOf(token) });
    },
    evaluateOutput: async () => JSON.stringify({ decision: 'allow', ruleIds: [] }),
  };
  const relayed = vi.fn(async () => ({ result: { content: [] } }));
  const estate = new EstateRelay({
    resolver: () => async (json: string) => {
      const { token } = JSON.parse(json) as { token: string };
      return JSON.stringify({ unit: unitOf(token), projectId: 'project', repoId: 'repo', codeGraphDb: '/graph.db' });
    },
    memoryDb: () => '/memory.db',
    exists: () => true,
    invoke: relayed,
  });
  const records: McpCallRecord[] = [];
  const published: McpCallRecord[] = [];
  const invoked = vi.fn(async () => ({ content: [] }));
  const deps = {
    gate: gate as unknown as DataGate,
    ...(picks !== undefined ? { picks } : {}),
    ...(fence !== undefined ? { fence } : {}),
  };
  const broker = new McpBroker({
    ...deps, registry, engine: () => engine, estate, invoke: invoked, budgetPerUnit: 1,
    records: { append: async (r) => { records.push(r); } },
    publish: (r) => { published.push(r); },
  });
  const lister = vi.fn(async (json: string) => {
    const { token, calls } = JSON.parse(json) as { token: string; calls: Array<{ server: string; tool: string }> };
    return JSON.stringify({ unit: unitOf(token), tools: calls.map((c) => ({ subject: `mcp:${c.server}/${c.tool}`, class: 'read', decision: 'allow', ruleIds: [] })) });
  });
  const list = async (token = 'first') => {
    const answer = await listUnitTools({ ...deps, registry, lister: () => lister }, token);
    expect(answer.status).toBe(200);
    if (!('tools' in answer.body)) throw new Error(answer.body.error);
    return answer.body.tools.map((t) => t.subject);
  };
  const call = (subject = 'mcp:support-pg/execute_sql', token = 'first') => broker.call({ token, subject, args: {} });
  return { gate, registry, records, published, invoked, relayed, lister, list, call };
}

describe('pickAllows: the run source-pick contract', () => {
  it('allows an absent store or no pick, but only exact source names from a pick', () => {
    expect(pickAllows(undefined, 'run', 'support-pg')).toBe(true);
    expect(pickAllows({ get: () => null }, 'run', 'support-pg')).toBe(true);
    const picks = savedPick(['web']);
    expect(pickAllows(picks, 'run-web', 'web')).toBe(true);
    expect(pickAllows(picks, 'run-web', 'support-pg')).toBe(false);
    expect(pickAllows(picks, 'run-web', 'source-web-id')).toBe(false);
    expect(pickAllows(picks, 'run-open', 'support-pg')).toBe(true);
  });

  it('an empty pick allows no source', () => {
    expect(pickAllows(savedPick([]), 'run-web', 'web')).toBe(false);
  });

  it('an unreadable pick fails closed', () => {
    expect(pickAllows(brokenPicks, 'run-web', 'web')).toBe(false);
  });
});

describe('CS10: picked sources in the broker and unit tool list', () => {
  it('a web-only job cannot list support-pg, including its raw registry tool', async () => {
    const f = fixture(savedPick(['web']));
    expect(await f.list()).toEqual(['mcp:files/read', 'mcp:web/search']);
    const request = JSON.parse(f.lister.mock.calls[0]![0]) as { calls: Array<{ server: string }> };
    expect(request.calls.map((c) => c.server)).toEqual(['files', 'web']);
  });

  it('a forced support-pg call is recorded and published as denied before admission, invocation or budget', async () => {
    const f = fixture(savedPick(['web']));
    expect(await f.call()).toMatchObject({ status: 403, body: {
      outcome: 'denied', denied: true, ruleIds: [PICK_RULE], callId: expect.any(String),
      reason: 'this job did not pick support-pg; it reads only web', remedy: 'work from the sources and documents this job picked',
    } });
    expect(f.gate.admitted).not.toHaveBeenCalled();
    expect(f.gate.unitCall).not.toHaveBeenCalled();
    expect(f.registry.resolveCall).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ traceId: 'run-web', parentSpanId: '1:0', outcome: 'denied', decision: { decision: 'deny', by: PICK_RULE, ruleIds: [PICK_RULE] } });
    expect(f.published).toEqual(f.records);
    // The refused source did not spend this unit's one call: its picked web source still runs.
    expect(await f.call('mcp:web/search')).toMatchObject({ status: 200, body: { outcome: 'ok' } });
    expect(f.gate.unitCall).toHaveBeenCalledTimes(1);
    expect(await f.call('mcp:web/search')).toMatchObject({ status: 429, body: { outcome: 'budget_exhausted' } });
  });

  it('an empty pick lists and calls no source', async () => {
    const f = fixture(savedPick([]));
    expect(await f.list()).toEqual(['mcp:files/read']);
    for (const subject of ['mcp:support-pg/execute_sql', 'mcp:web/search']) {
      expect(await f.call(subject)).toMatchObject({ status: 403, body: { ruleIds: [PICK_RULE], reason: expect.stringContaining('it reads only no sources') } });
    }
    expect(f.gate.unitCall).not.toHaveBeenCalled();
  });

  it.each(['retry', 'later'])('a %s unit of the same run keeps its pick for listing and calling', async (token) => {
    const f = fixture(savedPick(['web']));
    expect(await f.list(token)).toEqual(['mcp:files/read', 'mcp:web/search']);
    expect(await f.call('mcp:support-pg/execute_sql', token)).toMatchObject({ status: 403, body: { ruleIds: [PICK_RULE] } });
    expect(f.gate.unitCall).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({ traceId: 'run-web', parentSpanId: token === 'later' ? '9:2' : '1:2' });
    // A different run with no saved pick retains the switches-only behavior.
    expect(await f.list('other-run')).toContain('mcp:support-pg/execute_sql');
    expect(await f.call('mcp:support-pg/execute_sql', 'other-run')).toMatchObject({ status: 200 });
  });

  it.each(['absent store', 'no saved pick'])('%s preserves source tools and calls', async (kind) => {
    const f = fixture(kind === 'absent store' ? undefined : { get: () => null });
    expect(await f.list()).toEqual(['mcp:files/read', 'mcp:support-pg/execute_sql', 'mcp:web/search']);
    expect(await f.call()).toMatchObject({ status: 200, body: { outcome: 'ok' } });
    expect(f.gate.admitted).toHaveBeenCalledTimes(1);
    expect(f.gate.unitCall).toHaveBeenCalledTimes(1);
  });

  it('a picked source still needs the engine admission', async () => {
    const f = fixture(savedPick(['support-pg']));
    f.gate.admitted.mockResolvedValueOnce(new Map());
    expect(await f.call()).toMatchObject({ status: 403, body: { outcome: 'denied', ruleIds: ['engine:gated-tool'] } });
    expect(f.gate.unitCall).not.toHaveBeenCalled();
  });

  it('an unreadable store lists no source and refuses a forced call with the pick rule', async () => {
    const f = fixture(brokenPicks);
    expect(await f.list()).toEqual(['mcp:files/read']);
    expect(await f.call()).toMatchObject({ status: 403, body: { outcome: 'denied', ruleIds: [PICK_RULE], reason: "this job's source pick could not be read" } });
    expect(f.gate.admitted).not.toHaveBeenCalled();
    expect(f.gate.unitCall).not.toHaveBeenCalled();
  });

  it('the detect-shape fence takes precedence over a pick', async () => {
    const f = fixture(savedPick([]), async () => true);
    expect(await f.call()).toMatchObject({ status: 403, body: { ruleIds: [FENCE_RULE] } });
    expect(f.gate.admitted).not.toHaveBeenCalled();
    expect(f.gate.unitCall).not.toHaveBeenCalled();
  });

  it.each(['empty', 'unreadable'])('an %s pick leaves plain upstream and estate graph, rules and memory calls alone', async (kind) => {
    const picks = kind === 'empty' ? savedPick([]) : brokenPicks;
    const plain = fixture(picks);
    expect(await plain.list()).toContain('mcp:files/read');
    expect(await plain.call('mcp:files/read')).toMatchObject({ status: 200, body: { outcome: 'ok' } });
    expect(plain.invoked).toHaveBeenCalledTimes(1);
    for (const tool of ['BlastRadius', 'rules.recall', 'memory.recall']) {
      const f = fixture(picks);
      expect(await f.call(`mcp:estate/${tool}`)).toMatchObject({ status: 200, body: { outcome: 'ok' } });
      expect(f.relayed).toHaveBeenCalledTimes(1);
      expect(f.gate.unitCall).not.toHaveBeenCalled();
    }
  });
});
