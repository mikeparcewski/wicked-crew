// DES-CATALOG-002 CS10 over the CS9 web source (journey CJ12: "Research X, but don't use support-pg").
// The data gate is real (a registered `kind: 'web'` entry and a SQL source with querying on), the pick is checked and
// recorded the way launch does it, and the unit tool list is driven through the daemon's own route. A unit of a job
// that picked only the web is listed no support-pg tool, a forced support-pg call is refused with the pick rule and
// recorded, and a re-planned unit (a later ord, a new attempt) of the same run is refused the same way.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jobInputsOfProposal } from '../src/api/chat-jobs.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { checkSourcePick, RunSourcePicks, runSourcesDeps } from '../src/api/run-sources.js';
import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import type { ArtifactProposal, McpCallRecord } from '../src/core/types.js';
import { WebSource } from '../src/knowledge/adapters/web/source.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { McpBroker } from '../src/mcp/broker.js';
import type { McpRegistry } from '../src/mcp/registry.js';
import type { McpRegistryFile, McpServerRecord } from '../src/mcp/registry-store.js';
import { PICK_RULE } from '../src/mcp/run-fence.js';
import { SourceCatalogStore } from '../src/sources/store.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs10-pick-web-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(name: string, patch: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: `registry-id-${name}`, name, kind: 'mcp-stdio', command: null, args: [], url: null, auth: null,
    enabled: true, agents: { see: true, query: true, projects: ['proj_a'], everyProject: false },
    health: { state: 'ok', consecutiveFailures: 0, checkedAt: null, lastError: null },
    registeredAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', tools: [], ...patch,
  };
}

// The token names the unit: `t-<ord>-<attempt>` of run `run-cj12`, or the unpicked control run `run-open`.
const unitOf = (token: string) => {
  const [, ord, attempt] = /^t-(\d+)-(\d+)$/.exec(token) ?? ['', '1', '0'];
  return { runId: token === 'open' ? 'run-open' : 'run-cj12', ord: Number(ord), attempt: Number(attempt), phase: 'work', seat: 'codex' };
};

function fixture() {
  const file: McpRegistryFile = {
    version: 1,
    servers: [
      entry('support-pg', { kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'support', user: 'reader', tls: 'disable' } }),
      entry('web', { kind: 'web' }),
    ],
  };
  const web = new WebSource({ mcpDir: join(scratch(), 'web') });
  // No runtime is started: only the gate's read of availability matters to the pick check.
  vi.spyOn(web, 'setup').mockResolvedValue({ installed: true, search: { ready: true } } as Awaited<ReturnType<WebSource['setup']>>);
  const gate = new DataGate({
    store: { read: async () => structuredClone(file), mutate: async () => { throw new Error('read only'); } },
    catalogs: new SourceCatalogStore(join(scratch(), 'catalogs')),
    secret: async () => { throw new Error('must not read credentials'); },
    record: { append: async () => { throw new Error('must not record a query'); } },
    audit: { record: () => { throw new Error('must not audit a query'); } },
    resolver: () => async (json: string) => {
      const { token } = JSON.parse(json) as { token: string };
      return JSON.stringify({ unit: unitOf(token), projectId: 'proj_a', repoId: null });
    },
    lister: () => null,
    web,
  });
  const picks = new RunSourcePicks(join(scratch(), 'mcp', 'run-source-picks.json'));
  // The engine's judgment of a listing: every requested tool allowed (the pick, not the engine, is under test).
  const lister = async (json: string) => {
    const { token, calls } = JSON.parse(json) as { token: string; calls: Array<{ server: string; tool: string }> };
    return JSON.stringify({ unit: unitOf(token), tools: calls.map((c) => ({ subject: `mcp:${c.server}/${c.tool}`, class: 'read', decision: 'allow', ruleIds: [] })) });
  };
  const registry = { callableTools: async () => [] } as unknown as McpRegistry;
  const routes = async (withPicks: boolean) => {
    const app = Fastify();
    apps.push(app);
    registerMcpRoutes(app, {
      registry,
      toolLister: () => lister,
      gate,
      ...(withPicks ? { picks } : {}),
      audit: new AuditLog(join(scratch(), 'audit.log'), () => {}),
      actorOf: () => LOCAL_ACTOR,
    });
    await app.ready();
    return async (token: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/tools', payload: { token } });
      expect(res.statusCode).toBe(200);
      return (res.json() as { tools: Array<{ subject: string }> }).tools.map((t) => t.subject);
    };
  };
  const records: McpCallRecord[] = [];
  const invoked = vi.fn(async () => ({ content: [] }));
  const broker = new McpBroker({
    registry: { resolveCall: vi.fn(async () => { throw new Error('a source never resolves as a plain upstream'); }), callSecret: vi.fn() } as never,
    engine: () => null,
    gate,
    picks,
    invoke: invoked,
    records: { append: async (r) => { records.push(r); } },
  });
  return { gate, picks, routes, broker, records, invoked };
}

describe('CS10 over the CS9 web source (CJ12)', () => {
  it('the pick is "the web" only; a unit is listed no support-pg tool through the daemon route, across a re-plan', async () => {
    const f = fixture();
    // Launch checks the pick against the live switches, then records it (CS4).
    const checked = await checkSourcePick('proj_a', ['web'], runSourcesDeps(f.gate));
    expect(checked).toEqual({ ok: true, ids: ['web'] });
    f.picks.set('run-cj12', checked.ok ? checked.ids : []);

    const list = await f.routes(true);
    for (const token of ['t-1-0', 't-7-1']) {
      const tools = await list(token);
      expect(tools).toContain('mcp:web/search');
      expect(tools.filter((s) => s.startsWith('mcp:support-pg/'))).toEqual([]);
    }
    // Control: a run with no pick still sees support-pg (the pick narrows; it is not a blanket off switch).
    expect((await list('open')).some((s) => s.startsWith('mcp:support-pg/'))).toBe(true);
  });

  it('fails without the route wiring: a daemon route that is not handed the picks lists support-pg', async () => {
    const f = fixture();
    f.picks.set('run-cj12', ['web']);
    const unwired = await f.routes(false);
    expect((await unwired('t-1-0')).some((s) => s.startsWith('mcp:support-pg/'))).toBe(true);
  });

  it('a forced support-pg call is refused with the pick rule and recorded, for every unit of the run', async () => {
    const f = fixture();
    f.picks.set('run-cj12', ['web']);
    for (const token of ['t-1-0', 't-7-1', 't-9-3']) {
      const answer = await f.broker.call({ token, subject: 'mcp:support-pg/execute_sql', args: { sql: 'select 1' } });
      expect(answer).toMatchObject({ status: 403, body: { outcome: 'denied', ruleIds: [PICK_RULE], reason: 'this job did not pick support-pg; it reads only web' } });
    }
    expect(f.records.map((r) => [r.traceId, r.outcome, r.decision?.by])).toEqual([
      ['run-cj12', 'denied', PICK_RULE], ['run-cj12', 'denied', PICK_RULE], ['run-cj12', 'denied', PICK_RULE],
    ]);
    expect(f.invoked).not.toHaveBeenCalled();
    // The picked web source is not refused by the pick (the engine's absence refuses it here, under its own rule).
    const webAnswer = await f.broker.call({ token: 't-1-0', subject: 'mcp:web/search', args: { query: 'x' } });
    expect(JSON.stringify(webAnswer.body)).not.toContain(PICK_RULE);
  });
});

describe('CS10: a reshape keeps the held run\'s pick', () => {
  const held = (runId: string) => (runId === 'run-held' ? ['web'] : null);
  const proposal = (patch: Partial<ArtifactProposal>) => ({ needs: [], inputs: {}, ...patch }) as unknown as ArtifactProposal;

  it('a reshape to a shape that takes no sources launches with the held run\'s pick', () => {
    expect(jobInputsOfProposal(proposal({ reshapes: 'run-held' }), held).sources).toEqual(['web']);
  });

  it('a reshape whose shape takes sources sends its own (inherited) inputs; a held run with no pick adds none', () => {
    const withNeed = proposal({ reshapes: 'run-held', needs: [{ id: 'sources', kind: 'sources' }] as never, inputs: { sources: { kind: 'sources', ids: [] } } as never });
    expect(jobInputsOfProposal(withNeed, held).sources).toEqual([]);
    expect(jobInputsOfProposal(proposal({ reshapes: 'run-unpicked' }), held).sources).toBeUndefined();
    expect(jobInputsOfProposal(proposal({}), held).sources).toBeUndefined();
  });
});
