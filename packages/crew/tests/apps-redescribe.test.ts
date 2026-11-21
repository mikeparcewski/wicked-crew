// crew#1299: the daemon refreshes active apps' sources, once each and one at a time.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppsRedescriber, REDESCRIBE_MS } from '../src/apps/exec/redescribe.js';
import type { AppSpec } from '../src/core/types.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { sourceDescriptorHash, type SourceDescription } from '../src/sources/kinds.js';
import { appsHarness, specWith } from './support/apps-harness.js';
import { DB_REQUIRED, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

const description: SourceDescription = { catalog: { dialect: 'postgres', database: 'apps', describedAt: 'now', relations: [] } };
const config = (name: string): McpUpstreamConfig => ({ name, kind: name === 'gql' ? 'graphql' : 'sql', command: null, args: [], url: 'https://example.test/graphql', auth: null });
const spec = (sources: string[]): AppSpec => specWith(sources.map((source, i) => ({ id: `q${i}`, source, kind: source === 'gql' ? 'graphql' : source === 'crew' ? 'crew' : source === 'rest' ? 'rest' : 'sql', output: [] })));

afterEach(() => vi.useRealTimers());

describe('periodic Apps source descriptions', () => {
  it('each tick describes distinct SQL/GraphQL sources from active heads, including actions, serially; close stops ticks', async () => {
    vi.useFakeTimers();
    const active = spec(['db', 'db', 'gql', 'crew', 'rest']);
    active.actions = [{ id: 'write', kind: 'api', source: 'action-only', call: { kind: 'tool', tool: 'write' }, args: {}, params: { type: 'object', properties: {} } }];
    const store = { list: vi.fn(() => [{ slug: 'active' }, { slug: 'second' }]), detail: vi.fn(async () => ({ spec: active })) };
    const seen: string[] = [];
    let inFlight = 0;
    const describe = vi.fn(async (c: McpUpstreamConfig) => {
      expect(inFlight++).toBe(0);
      await Promise.resolve();
      seen.push(c.name);
      inFlight--;
      return description;
    });
    const registry = {
      snapshot: vi.fn(async (name: string) => ({ config: config(name), enabled: true })),
      callSecret: vi.fn(async () => ({ secret: null, missing: false })),
      saveDescription: vi.fn(async () => undefined),
    };
    const refresh = new AppsRedescriber({ store: () => store, registry, describe, log: vi.fn() });
    refresh.start();
    expect(describe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REDESCRIBE_MS);
    expect(seen).toEqual(['db', 'gql', 'action-only']);
    expect(store.list).toHaveBeenCalledWith();
    expect(registry.saveDescription).toHaveBeenCalledWith('db', description, sourceDescriptorHash(config('db')));
    await refresh.close();
    await vi.advanceTimersByTimeAsync(REDESCRIBE_MS * 2);
    expect(describe).toHaveBeenCalledTimes(3);
  });

  it('coalesces overlapping ticks, logs a failed source once, and continues to the next source', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = { list: () => [{ slug: 'desk' }], detail: async () => ({ spec: spec(['bad', 'db']) }) };
    const log = vi.fn();
    let release!: () => void;
    const describe = vi.fn(async (c: McpUpstreamConfig) => {
      if (c.name === 'bad') { await new Promise<void>((r) => { release = r; }); throw new Error('unavailable'); }
      return description;
    });
    const registry = { snapshot: async (name: string) => ({ config: config(name), enabled: true }), callSecret: async () => ({ secret: null, missing: false }), saveDescription: vi.fn(async () => undefined) };
    const refresh = new AppsRedescriber({ store: () => store, registry, describe, log });
    refresh.start();
    await vi.advanceTimersByTimeAsync(REDESCRIBE_MS * 2);
    expect(describe).toHaveBeenCalledTimes(1);
    release();
    await refresh.refresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(registry.saveDescription).toHaveBeenCalledWith('db', description, sourceDescriptorHash(config('db')));
    await refresh.close();
  });

  it('a describe past its deadline is logged once and cannot save a late answer', async () => {
    vi.useFakeTimers();
    let release!: (value: SourceDescription) => void;
    const log = vi.fn();
    const registry = { snapshot: async () => ({ config: config('db'), enabled: true }), callSecret: async () => ({ secret: null, missing: false }), saveDescription: vi.fn(async () => undefined) };
    const refresh = new AppsRedescriber({ store: () => ({ list: () => [{ slug: 'desk' }], detail: async () => ({ spec: spec(['db']) }) }), registry, describe: () => new Promise<SourceDescription>((r) => { release = r; }), log });
    const pending = refresh.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(log).toHaveBeenCalledTimes(1);
    release(description);
    await Promise.resolve();
    expect(registry.saveDescription).not.toHaveBeenCalled();
    await refresh.close();
  });

  it('skips an upload snapshot and saves a description with the source secret scrubbed out', async () => {
    const secret = 's3cret-reader-pass';
    const upload: McpUpstreamConfig = { name: 'upload', kind: 'sql', command: null, args: [], url: null, auth: null, sql: { driver: 'sqlite', snapshot: 'abc' } };
    const echoed: SourceDescription = { catalog: { ...description.catalog, database: `db-${secret}` } };
    const describe = vi.fn(async () => echoed);
    const registry = {
      snapshot: async (name: string) => ({ config: name === 'upload' ? upload : config(name), enabled: true }),
      callSecret: async () => ({ secret, missing: false }),
      saveDescription: vi.fn(async () => undefined),
    };
    const refresh = new AppsRedescriber({ store: () => ({ list: () => [{ slug: 'desk' }], detail: async () => ({ spec: spec(['upload', 'db']) }) }), registry, describe, log: vi.fn() });
    await refresh.refresh();
    expect(describe).toHaveBeenCalledTimes(1);
    expect(registry.saveDescription).toHaveBeenCalledTimes(1);
    const saved = JSON.stringify((registry.saveDescription.mock.calls[0] as unknown[])[1]);
    expect(saved).not.toContain(secret);
    await refresh.close();
  });

  it('a source saved during describe keeps its newer descriptor and description', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redescribe-race-'));
    const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
    const registry = new McpRegistry({ store: new McpRegistryStore(join(dir, 'mcp')), secrets, discover: () => [], probe: async () => ({ ok: true, tools: [], serverInfo: null, source: description }) });
    try {
      const connection = config('gql');
      await registry.save((await registry.preview(connection)).previewHash);
      const old = await registry.source('gql');
      const log = vi.fn();
      const refresh = new AppsRedescriber({ store: () => ({ list: () => [{ slug: 'desk' }], detail: async () => ({ spec: spec(['gql']) }) }), registry, describe: async () => {
        await registry.save((await registry.preview({ ...connection, url: 'https://changed.test/graphql' })).previewHash);
        return { ...description, catalog: { ...description.catalog, describedAt: 'stale' } };
      }, log });
      await refresh.refresh();
      const current = await registry.source('gql');
      expect(current.descriptorHash).not.toBe(old.descriptorHash);
      expect(current.description?.catalog).toEqual(description.catalog);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("re-describing keeps the registry's generations and restore points as they were (coord review W12)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redescribe-generations-'));
    const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
    const store = new McpRegistryStore(join(dir, 'mcp'));
    const registry = new McpRegistry({ store, secrets, discover: () => [], probe: async () => ({ ok: true, tools: [], serverInfo: null, source: description }) });
    try {
      await registry.save((await registry.preview(config('gql'))).previewHash);
      await registry.save((await registry.preview(config('warehouse'))).previewHash);
      const before = { generation: (await store.read()).generation, kept: (await store.generations()).map((g) => g.generation) };
      let n = 0;
      const refresh = new AppsRedescriber({ store: () => ({ list: () => [{ slug: 'desk' }], detail: async () => ({ spec: spec(['gql', 'warehouse']) }) }), registry, describe: async () => ({ ...description, catalog: { ...description.catalog, describedAt: `tick-${++n}` } }), log: vi.fn() });
      for (let i = 0; i < 12; i += 1) await refresh.refresh();
      expect(n).toBe(24);
      expect((await registry.source('gql')).description?.catalog).toMatchObject({ describedAt: 'tick-23' });
      expect({ generation: (await store.read()).generation, kept: (await store.generations()).map((g) => g.generation) }).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

if (PG_TARGETS.length === 0) {
  it.skipIf(!DB_REQUIRED)('periodic re-describe needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
    throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
  });
}
for (const target of PG_TARGETS) {
  it(`a used column changes type on ${target.label}: stale read runs, next tick refuses contract_changed`, async () => {
    const db = await freshPgDatabase(target);
    const h = await appsHarness();
    const refresh = new AppsRedescriber({ store: () => h.store, registry: h.registry, log: () => undefined });
    try {
      await h.addPg('support', { port: db.port, database: db.database, user: 'apps_reader', password: 'apps-reader' });
      await h.newApp('desk');
      expect((await h.land('desk', specWith([{ id: 'kids', source: 'support', kind: 'sql', output: [{ name: 'id', type: 'integer' }] }]), { kids: 'SELECT k.id FROM s.kids AS k' })).status).toBe(200);
      await db.admin.unsafe('ALTER TABLE s.kids ALTER COLUMN id TYPE int8');
      const read = () => h.call('POST', '/apps/desk/query', { version: 2, query: 'kids' });
      expect((await read()).status).toBe(200);
      // Only the scheduler uses fake time; database drivers keep their real deadlines and sockets.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      refresh.start();
      await vi.advanceTimersByTimeAsync(REDESCRIBE_MS);
      await refresh.refresh();
      const changed = await read();
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ code: 'contract_changed' });
      expect(String(changed.body.error)).toContain('kids');
    } finally { await refresh.close(); vi.useRealTimers(); await h.close(); await db.drop(); }
  }, 60_000);
}
