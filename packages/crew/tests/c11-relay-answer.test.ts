// crew-C11 seam A: what the estate relay hands back and what its call record says.
//   - crew#1520: the result scrub keeps a JSON text block valid JSON. A record with a quoted `password=` value used to
//     come back as text that no longer parsed (the `kv-secret` pattern ate the `\` before the closing quote).
//   - crew#1442 item 1: when the release re-check withholds records, the call record carries the count, and the pick
//     rule when the run has a source pick, so a reader can tell "withheld" from "nothing found".

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpCallRecord, McpCallResponse } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { EstateRelay, type EstateRelayAnswer, type EstateRelayInvocation, type EstateUnitScope } from '../src/mcp/estate-relay.js';
import { redactDeep, scrubResult } from '../src/mcp/redact.js';
import { PICK_RULE, type SourcePicks } from '../src/mcp/run-fence.js';
import { removeScratch } from './setup/scratch.js';

const UNIT = { runId: 'run-c11', ord: 2, attempt: 1, phase: 'unit-2', seat: 'pi' };
const SCOPE: EstateUnitScope = { unit: UNIT, projectId: 'proj_c11', repoId: 'repo-c11', codeGraphDb: '/state/repo-graphs/c11/estate.db' };
const SUPPORT_ID = '3f0c9a1e-0000-4000-8000-00000000c111';
const BILLING_ID = '3f0c9a1e-0000-4000-8000-00000000c112';

const envelope = (payload: unknown): Record<string, unknown> => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
const textOf = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';

describe('crew#1520: the scrub redacts a JSON text block as JSON', () => {
  it('a quoted password= value is redacted and the block still parses (fails before the fix)', () => {
    const record = { items: [{ id: 'k1', text: 'the seed login is "password=admin" on the test box' }] };
    const out = scrubResult(envelope(record), []);
    // Before the fix the text ended `…password=[REDACTED:kv]" on the test box"}]}` with a bare quote: JSON.parse threw.
    const parsed = JSON.parse(textOf(out)) as typeof record;
    expect(parsed.items[0]?.text).toBe('the seed login is "password=[REDACTED:kv]" on the test box');
    expect(textOf(out)).not.toContain('admin');
  });

  it('every value shape is still redacted inside the JSON, keys included, and nested blocks are found', () => {
    const payload = { nodes: [{ note: 'Authorization: Bearer abcdefghijklmnop', 'token=abcdef': 1, deep: ['ghp_0123456789abcdefghij0123'] }] };
    const out = redactDeep({ result: envelope(payload) }) as { result: unknown };
    const text = textOf(out.result);
    const parsed = JSON.parse(text) as { nodes: Array<Record<string, unknown>> };
    expect(parsed.nodes[0]?.['note']).toBe('Authorization: [REDACTED:bearer]');
    expect(parsed.nodes[0]?.['token=[REDACTED:kv]']).toBe(1);
    expect(parsed.nodes[0]?.['deep']).toEqual(['[REDACTED:github-token]']);
  });

  it('a clean JSON block is handed back byte for byte, and a non-JSON block keeps the string redaction', () => {
    const pretty = JSON.stringify({ items: [{ id: 'k1', text: 'nothing secret' }] }, null, 2);
    const clean = { content: [{ type: 'text', text: pretty }], isError: false };
    expect(scrubResult(clean, [])).toEqual(clean);
    const prose = { content: [{ type: 'text', text: 'STALENESS: 0 commits behind; password=hunter22 seen' }] };
    expect(textOf(scrubResult(prose, []))).toBe('STALENESS: 0 commits behind; password=[REDACTED:kv] seen');
    // A text that only looks like JSON is redacted as a string, as before.
    const broken = { content: [{ type: 'text', text: '{ not json, password=hunter22' }] };
    expect(textOf(scrubResult(broken, []))).toBe('{ not json, password=[REDACTED:kv]');
  });

  it('a __proto__ key inside the JSON stays a key', () => {
    const text = '{"__proto__":{"x":"password=hunter22"},"y":1}';
    const out = textOf(scrubResult({ content: [{ type: 'text', text }] }, []));
    expect(JSON.parse(out)).toEqual(JSON.parse('{"__proto__":{"x":"password=[REDACTED:kv]"},"y":1}'));
  });
});

describe('the relay answer through the broker (crew#1520, crew#1442 item 1)', () => {
  let base: string;
  let app: FastifyInstance | undefined;
  let records: McpCallRecordFile;

  async function boot(answer: (call: EstateRelayInvocation) => Promise<EstateRelayAnswer>, picks?: SourcePicks): Promise<void> {
    const relay = new EstateRelay({
      resolver: () => async () => JSON.stringify(SCOPE),
      invoke: answer,
      memoryDb: () => '/daemon/memory.db',
      exists: () => true,
      visible: async () => [`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-c11'],
      sourceNames: async () => [{ id: SUPPORT_ID, name: 'support-pg' }, { id: BILLING_ID, name: 'billing-pg' }],
      ...(picks !== undefined ? { picks } : {}),
    });
    const broker = new McpBroker({
      registry: { resolveCall: async () => null, callSecret: async () => ({ secret: null, missing: false }) } as never,
      engine: () => null,
      records,
      budgetPerUnit: 50,
      estate: relay,
      ...(picks !== undefined ? { picks } : {}),
    });
    app = Fastify();
    registerMcpRoutes(app, { broker, audit: AuditLog.noop(), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  }

  async function call(subject: string, args: Record<string, unknown> = {}) {
    const res = await app!.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_good', subject, args } });
    return { status: res.statusCode, body: res.json() as McpCallResponse };
  }

  const recorded = (): McpCallRecord[] => readFileSync(records.path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as McpCallRecord);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(base);
  });

  const setup = (): void => {
    base = mkdtempSync(join(tmpdir(), 'crew-c11-relay-'));
    records = new McpCallRecordFile(join(base, 'mcp'));
  };

  it('a knowledge record with a quoted password= value comes back as JSON a seat can parse (fails before the fix)', async () => {
    setup();
    await boot(async () => ({ result: envelope({ items: [{ id: 'k1', text: 'seed with "password=admin"', deps: [`source:${SUPPORT_ID}`] }] }) }));
    const r = await call('mcp:estate/knowledge.recall', { query: 'seed' });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(textOf(r.body.result)) as { items: Array<{ text: string }> };
    expect(parsed.items[0]?.text).toBe('seed with "password=[REDACTED:kv]"');
    // memory.recall (no release re-check) passes through the same scrub.
    await app!.close();
    await boot(async () => ({ result: envelope({ memories: [{ text: 'use "password=admin" locally' }] }) }));
    const m = await call('mcp:estate/memory.recall', { query: 'seed' });
    expect((JSON.parse(textOf(m.body.result)) as { memories: Array<{ text: string }> }).memories[0]?.text).toBe('use "password=[REDACTED:kv]" locally');
  });

  it('records how many items the pick withheld, with the pick rule (fails before the fix)', async () => {
    setup();
    const items = [
      { id: 'a', text: 'support tickets', deps: [`source:${SUPPORT_ID}`] },
      { id: 'b', text: 'billing invoices', deps: [`source:${BILLING_ID}`] },
      { id: 'c', text: 'billing refunds', deps: [`source:${BILLING_ID}`] },
    ];
    await boot(async () => ({ result: envelope({ items }) }), { get: (runId) => (runId === UNIT.runId ? ['support-pg'] : null) });
    const r = await call('mcp:estate/knowledge.recall', { query: 'tickets' });
    expect(r.status).toBe(200);
    expect((JSON.parse(textOf(r.body.result)) as { items: unknown[] }).items).toHaveLength(1);
    const [rec] = recorded();
    expect(rec?.outcome).toBe('ok');
    expect(rec?.attrs['estate.withheld']).toBe(2);
    expect(rec?.decision.ruleIds).toEqual([PICK_RULE]);
  });

  it('a run with no pick records the count without the pick rule, and nothing withheld records no count', async () => {
    setup();
    const items = [
      { id: 'a', text: 'support tickets', deps: [`source:${SUPPORT_ID}`] },
      { id: 'z', text: 'another project', deps: ['source:not-visible-here'] },
    ];
    await boot(async () => ({ result: envelope({ items }) }), { get: () => null });
    await call('mcp:estate/knowledge.recall', { query: 'tickets' });
    await app!.close();
    await boot(async () => ({ result: envelope({ items: items.slice(0, 1) }) }), { get: () => null });
    await call('mcp:estate/knowledge.recall', { query: 'tickets' });
    const [withheld, clean] = recorded();
    expect(withheld?.attrs['estate.withheld']).toBe(1);
    expect(withheld?.decision.ruleIds).toEqual([]);
    expect(clean?.attrs['estate.withheld']).toBeUndefined();
    expect(clean?.decision.ruleIds).toEqual([]);
  });
});
