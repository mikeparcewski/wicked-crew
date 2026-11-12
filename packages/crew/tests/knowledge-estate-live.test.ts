// DES-KNOWLEDGE-DATA-001 §19 B3b against a REAL wicked-estate-mcp (the knowledge plane, estate#389), when
// WICKED_ESTATE_MCP_EXE names one (skipped otherwise; CI has no estate binary). Every store is a temp file.
//
// - the describe projection lands as one generation estate accepts, and a later one without a relation
//   tombstones it;
// - through the broker's relay, recall and the source catalog answer a source's structure only to a unit whose
//   project may see it, and the release re-check drops it once the switch is off.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { callEstateTool } from '../src/core/estate-mcp-client.js';
import type { McpCallResponse } from '../src/core/types.js';
import { agentAccessOf } from '../src/knowledge/gate/access.js';
import type { GateSource } from '../src/knowledge/gate/sources.js';
import { visibleDeps } from '../src/knowledge/package.js';
import { SourceProjector, sourceGeneration } from '../src/knowledge/projector.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { defaultEstateInvoker, EstateRelay } from '../src/mcp/estate-relay.js';
import { configOf } from '../src/mcp/registry.js';
import { McpRegistryStore, type McpServerRecord } from '../src/mcp/registry-store.js';
import type { CatalogRelation, SqlCatalog } from '../src/sources/catalog/types.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { SourceCatalogStore } from '../src/sources/store.js';
import { removeScratch } from './setup/scratch.js';

const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';
const SOURCE_ID = '3f0c9a1e-0000-4000-8000-00000000b3e1';

const rel = (name: string): CatalogRelation => ({
  schema: 'support',
  name,
  kind: 'table',
  rowEstimate: 41_234,
  columns: [
    { name: 'id', type: 'bigint', nullable: false },
    { name: 'status', type: 'support.ticket_status', nullable: false, enumValues: ['open', 'pending', 'closed'] },
    { name: 'region', type: 'text', nullable: true },
  ],
  primaryKey: ['id'],
  foreignKeys: [],
});
const catalogOf = (names: string[], at: string): SqlCatalog => ({ dialect: 'postgres', database: 'd', relations: names.map(rel), describedAt: at });

describe.skipIf(EXE === '' || process.platform === 'win32')('the knowledge package against a real wicked-estate-mcp', () => {
  let base: string;
  let app: FastifyInstance;
  let projects: string[] = [];
  // The hermetic arming rides along (...process.env, tests/setup/hermetic-home.ts); every estate store is pinned here.
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: base,
    WICKED_HOME: join(base, 'wicked'),
    WICKED_MEMORY_DB: join(base, 'memory.db'),
    WICKED_KNOWLEDGE_DB: join(base, 'knowledge.db'),
    WICKED_XEDGE_DB: join(base, 'xedge.db'),
    WICKED_ESTATE_DB: ':memory:',
  });
  const write = (tool: string, args: Record<string, unknown>) => callEstateTool(tool, args, { spawn: () => spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env() } }), timeoutMs: 60_000 });
  const source = (names: string[], at: string): GateSource =>
    ({
      id: SOURCE_ID,
      name: 'support-pg',
      enabled: true,
      access: agentAccessOf({ agents: { projects } }),
      descriptorHash: 'h',
      description: { catalog: catalogOf(names, at), descriptorHash: 'h' },
      viewsAllowed: [],
      tools: [],
      dialect: 'postgres',
      runtime: 'native',
      queryable: true,
    }) as unknown as GateSource;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-b3b-estate-'));
    const relay = new EstateRelay({
      resolver: () => async () => JSON.stringify({ unit: { runId: 'run-live', ord: 1, attempt: 1, phase: 'unit-1', seat: 'claude' }, projectId: 'proj_a', repoId: null, codeGraphDb: null }),
      invoke: defaultEstateInvoker({ spawn: () => spawn(EXE, ['--readonly'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env() } }) }),
      visible: async (scope) => visibleDeps([source([], '2026-11-04T00:00:00Z')], scope.projectId, []),
      timeoutMs: 60_000,
    });
    const broker = new McpBroker({ registry: { resolveCall: async () => null, callSecret: async () => ({ secret: null, missing: false }) } as never, engine: () => null, records: new McpCallRecordFile(join(base, 'mcp')), estate: relay });
    app = Fastify();
    registerMcpRoutes(app, { broker, audit: AuditLog.noop(), actorOf: () => LOCAL_ACTOR });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (base !== undefined) removeScratch(base);
  });

  const relayed = async (tool: string, args: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt', subject: `mcp:estate/${tool}`, args } });
    const body = res.json() as McpCallResponse;
    const text = (body.result as { content?: Array<{ text: string }>; isError?: boolean } | undefined)?.content?.[0]?.text;
    let payload: unknown = null;
    try {
      payload = text === undefined ? null : JSON.parse(text);
    } catch {
      payload = text;
    }
    return { status: res.statusCode, body, payload };
  };

  it('acks all six described sources during a boot backfill (crew#1524)', async () => {
    const store = new McpRegistryStore(join(base, 'backfill', 'mcp'));
    const catalogs = new SourceCatalogStore(join(base, 'backfill', 'catalogs'));
    const stamp = '2026-11-04T03:00:00Z';
    const sources: Array<McpServerRecord & { id: string }> = Array.from({ length: 6 }, (_, i) => ({
      id: `backfill-source-${i}`, name: `backfill-pg-${i}`, kind: 'sql',
      command: null, args: [], url: null, auth: null, enabled: true, tools: [],
      health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
      registeredAt: stamp, updatedAt: stamp,
      sql: { driver: 'postgres', host: 'db.test', port: 5432, database: 'd', user: 'u', tls: 'disable' },
    }));
    await store.mutate((file) => { file.servers = sources; });
    // 400 relations a source: big enough that two writers at once hit 'database is locked' on estate 0.35.3 (crew
    // 0.18.11 ran two; 2 of 3 local runs failed with the issue's exact log line before the shared lane).
    for (const s of sources) {
      await catalogs.write(s.name, { descriptorHash: sourceDescriptorHash(configOf(s)), catalog: catalogOf(Array.from({ length: 400 }, (_, j) => `t${j}`), stamp) });
    }
    const logs: string[] = [];
    const projector = new SourceProjector({ store, catalogs, call: write, log: (line) => logs.push(line) });
    await projector.backfill();
    expect(logs).toEqual([]);
    for (const s of sources) expect(projector.projectedDescriptor(s.id), s.name).not.toBeNull();
  }, 120_000);

  it('estate takes the generation, and a later one without a relation tombstones it', async () => {
    const first = (await write('knowledge.replace_source', sourceGeneration(source(['tickets', 'customers'], '2026-11-04T03:00:00Z'), 1000)! as never)) as Record<string, unknown>;
    expect(first).toMatchObject({ sourceId: SOURCE_ID, docs: 2 });
    const second = (await write('knowledge.replace_source', sourceGeneration(source(['tickets'], '2026-11-04T04:00:00Z'), 2000)! as never)) as { tombstoned: { doc_count: number; docs: string[] } };
    expect(second.tombstoned.doc_count).toBe(1);
    expect(second.tombstoned.docs).toEqual(['support.customers']);
    // A legal name with a newline (quoted SQL identifier) is a key estate's validator takes (codex r2).
    const odd = source(['tickets'], '2026-11-04T04:30:00Z');
    (odd.description!.catalog as SqlCatalog).relations.push(rel('a\nb'), rel('q"x'));
    const third = (await write('knowledge.replace_source', sourceGeneration(odd, 3000)! as never)) as Record<string, unknown>;
    expect(third).toMatchObject({ docs: 3 });
    expect((await write('knowledge.replace_source', sourceGeneration(source(['tickets'], '2026-11-04T04:40:00Z'), 4000)! as never)) as Record<string, unknown>).toMatchObject({ docs: 1 });
    // An older describe is refused and changes nothing.
    await expect(write('knowledge.replace_source', sourceGeneration(source(['tickets', 'customers'], '2026-11-04T02:00:00Z'), 500)! as never)).rejects.toThrow();
  }, 120_000);

  it("a unit sees the source's structure through the relay only once its project is ticked", async () => {
    projects = [];
    const hidden = await relayed('knowledge.recall', { query: 'support tickets status region', visible: [`source:${SOURCE_ID}`] });
    expect(hidden.status).toBe(200);
    expect(JSON.stringify(hidden.payload)).not.toContain('support.tickets');
    const catalogHidden = await relayed('knowledge.source_catalog', { sourceId: SOURCE_ID });
    expect(JSON.stringify(catalogHidden.body)).not.toContain('support.tickets');

    projects = ['proj_a'];
    const seen = await relayed('knowledge.recall', { query: 'support tickets status region' });
    const items = (seen.payload as { items: Array<{ scope: string; deps: string[]; untrusted: boolean; body_snippet: string }> }).items;
    const hit = items.find((i) => i.scope === `source:${SOURCE_ID}`);
    expect(hit, JSON.stringify(items)).toBeDefined();
    expect(hit?.untrusted).toBe(true);
    expect(hit?.deps).toEqual([`source:${SOURCE_ID}`]);
    expect(JSON.stringify(items)).not.toContain('41234');
    const catalog = await relayed('knowledge.source_catalog', { sourceId: SOURCE_ID });
    expect(catalog.status).toBe(200);
    expect((catalog.payload as { docs: Array<{ key: string }> }).docs.map((d) => d.key)).toEqual(['support.tickets']);
    projects = [];
  }, 120_000);
});
