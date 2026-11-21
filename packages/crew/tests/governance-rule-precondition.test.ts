import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreAdapter, withRuleDefaults } from '../src/core/adapter.js';
import type { ConformanceRule } from '../src/core/types.js';
import type { AuditLog } from '../src/api/audit.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { removeScratch } from './setup/scratch.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const rule: ConformanceRule = { id: 'r', rule_type: 'pattern', statement: 'Before', severity: 'warn', confidence: 1,
  targets: { layer: 'api', language: 'ts' }, provenance: { source: 'markdown', source_kinds: ['doc'] } };
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'rule-precondition-'));
  const writer = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  let current: ConformanceRule | undefined = withRuleDefaults(rule);
  const core = {
    listConformanceRules: vi.fn(async () => JSON.stringify(current === undefined ? [] : [current])),
    upsertConformanceRule: vi.fn(async (json: string) => { await Promise.resolve(); current = withRuleDefaults(JSON.parse(json) as ConformanceRule); return 'ok'; }),
    retireConformanceRule: vi.fn(async () => { if (current) current = { ...current, retired: true }; return 'true'; }),
  };
  const realCore = (writer as unknown as { core: unknown }).core;
  Object.assign(writer, { core });
  const app = Fastify({ logger: false });
  const adapter = { sessionsDetail: async () => [], listRepos: async () => [], listWorkflows: () => BUILTIN_WORKFLOWS,
    steeringSupported: () => true, projectRulesSupported: () => true,
    listConformanceRules: () => writer.listConformanceRules(), upsertConformanceRule: writer.upsertConformanceRule.bind(writer) };
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined,
    { audit: { record: vi.fn() } as unknown as AuditLog, authMode: 'off' });
  cleanups.push(async () => { await app.close(); Object.assign(writer, { core: realCore }); writer.close(); removeScratch(dir); });
  const get = () => app.inject({ method: 'GET', url: '/api/v1/governance/rules' });
  const post = (statement: string, revision?: string, extra = {}) => app.inject({ method: 'POST', url: '/api/v1/governance/rules',
    payload: { ...rule, statement, ...extra }, ...(revision === undefined ? {} : { headers: { 'if-match': revision } }) });
  return { get, post, core, writer, clear: () => { current = undefined; } };
}
describe('rule revision preconditions', () => {
  it('GET returns a canonical revision and a matching quoted revision writes a new one', async () => {
    const { get, post, core } = harness();
    const before = (await get()).json().rules[0].revision as string;
    expect(before).toMatch(/^[a-f0-9]{16}$/);
    const res = await post('After', `"${before}"`);
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toMatch(/^[a-f0-9]{16}$/);
    expect(res.json().revision).not.toBe(before);
    expect((await get()).json().rules[0].revision).toBe(res.json().revision);
    expect(core.upsertConformanceRule).toHaveBeenCalledOnce();
    const reordered = await post('After', res.json().revision as string, {
      targets: { language: 'ts', layer: 'api' }, provenance: { source_kinds: ['doc'], source: 'markdown' },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().revision).toBe(res.json().revision);
  });
  it('a stale revision refuses without writing', async () => {
    const { get, post, core } = harness();
    const res = await post('After', '0000000000000000');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'rule_changed', revision: (await get()).json().rules[0].revision });
    expect(core.upsertConformanceRule).not.toHaveBeenCalled();
  });
  it('an absent rule refuses with null revision', async () => {
    const { post, core, clear } = harness(); clear();
    const res = await post('After', '0000000000000000');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'rule_changed', revision: null });
    expect(core.upsertConformanceRule).not.toHaveBeenCalled();
  });
  it('two concurrent writers with the same revision produce one write', async () => {
    const { get, post, core } = harness();
    const revision = (await get()).json().rules[0].revision as string;
    const responses = await Promise.all([post('One', revision ?? 'missing'), post('Two', revision ?? 'missing')]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(core.upsertConformanceRule).toHaveBeenCalledOnce();
    expect(responses.find((r) => r.statusCode === 409)?.json()).toMatchObject({ code: 'rule_changed' });
  });
  it('an unconditional write ignores a client revision', async () => {
    const { post, core } = harness();
    expect((await post('After', undefined, { revision: 'forged' })).statusCode).toBe(200);
    expect(JSON.parse(core.upsertConformanceRule.mock.calls[0]![0])).not.toHaveProperty('revision');
  });
  it.each(['*', '0123456789abcdef, fedcba9876543210', 'W/"0123456789abcdef"', '', 'ABCDEF0123456789', '"0123456789abcdef', '0123456789abcdef"', 'stale'])('rejects malformed If-Match %j without writing', async (header) => {
    const { post, core } = harness();
    const res = await post('After', header);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'If-Match must be one rule revision from GET /governance/rules' });
    expect(core.upsertConformanceRule).not.toHaveBeenCalled();
  });
  it('GET hashes exactly the adapter row and its revision is accepted by conditional POST', async () => {
    const { get, post, writer, core } = harness();
    // An adapter row without materialized defaults must be compared in that same shape.
    vi.spyOn(writer, 'listConformanceRules').mockResolvedValue([rule]);
    const revision = (await get()).json().rules[0].revision as string;
    expect((await post('After', revision)).statusCode).toBe(200);
    expect(core.upsertConformanceRule).toHaveBeenCalledOnce();
  });
  it('an unconditional adapter write returns void without listing rules', async () => {
    const { writer, core } = harness();
    core.listConformanceRules.mockRejectedValue(new Error('read unavailable'));
    expect(await writer.upsertConformanceRule(rule)).toBeUndefined();
    expect(core.upsertConformanceRule).toHaveBeenCalledOnce();
    expect(core.listConformanceRules).not.toHaveBeenCalled();
  });
  it.each(['failed', 'missing'])('a successful POST omits revision when readback is %s', async (readback) => {
    const { post, core } = harness();
    if (readback === 'failed') core.listConformanceRules.mockRejectedValue(new Error('read unavailable'));
    else core.listConformanceRules.mockResolvedValue('[]');
    const res = await post('After');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(core.upsertConformanceRule).toHaveBeenCalledOnce();
    expect(core.listConformanceRules).toHaveBeenCalledOnce();
  });
  it('retire shares the write lock with upsert', async () => {
    const { writer, core } = harness();
    let release!: () => void;
    core.upsertConformanceRule.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return 'ok'; });
    const write = writer.upsertConformanceRule(rule);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const retire = writer.retireConformanceRule('r');
    await Promise.resolve(); await Promise.resolve();
    expect(core.retireConformanceRule).not.toHaveBeenCalled();
    release(); await Promise.all([write, retire]);
    expect(core.retireConformanceRule).toHaveBeenCalledOnce();
  });
});
