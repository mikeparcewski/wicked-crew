// crew#1524: source and tracker projections share one writer and retry only SQLite contention.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EstateMcpError } from '../src/core/estate-mcp-client.js';
import { SourceProjector, type EstateCall, type SourceProjectorDeps } from '../src/knowledge/projector.js';
import { trackerIdOf, trackerLinkIdOf } from '../src/knowledge/registry/entry.js';
import { TrackerProjector } from '../src/knowledge/trackers/projector.js';
import { configOf } from '../src/mcp/registry.js';
import { McpRegistryStore, type McpServerRecord } from '../src/mcp/registry-store.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { SourceCatalogStore } from '../src/sources/store.js';
import { removeScratch } from './setup/scratch.js';

const STAMP = '2026-11-04T03:00:12.000Z';
const LOCKED = "replace_source committed nothing and tombstoned nothing (any link rows it staged stay hidden, and the source's next generation deletes them): storage error: database is locked";
const OLDER = "replace_source committed nothing and tombstoned nothing (any link rows it staged stay hidden, and the source's next generation deletes them): invalid argument: generation 1 is older than the stored generation 2 for source src-1";
const TRACKER_ID = trackerIdOf('jira-id', 'site', 'PROJ');
const TARGET = { kind: 'project', id: 'project-id' } as const;
const common = {
  command: null, args: [], url: null, auth: null, enabled: true, tools: [],
  health: { state: 'ok', consecutiveFailures: 0, checkedAt: STAMP, lastError: null },
  registeredAt: STAMP, updatedAt: STAMP,
} as const;
const sources: Array<McpServerRecord & { id: string }> = ['a', 'b'].map((name) => ({
  ...common, args: [], tools: [], name: `source-${name}`, id: `source-${name}`, kind: 'sql',
  sql: { driver: 'postgres', host: 'db.test', port: 5432, database: 'd', user: 'u', tls: 'disable' },
}));
const jira: McpServerRecord = {
  ...common, args: [], tools: [], name: 'jira', id: 'jira-id', kind: 'mcp-stdio', pm: { system: 'jira' },
  trackers: [{
    id: TRACKER_ID, tenant: 'site', tenantLabel: 'Site', siteHost: 'jira.test', key: 'PROJ', label: 'Project',
    links: [{ id: trackerLinkIdOf(TRACKER_ID, TARGET), target: TARGET, linkedAt: STAMP, linkedBy: 'local' }],
  }],
};

describe('estate projection writer', () => {
  let base: string;
  let store: McpRegistryStore;
  let catalogs: SourceCatalogStore;
  const projector = (deps: Partial<SourceProjectorDeps>) => new SourceProjector({ store, catalogs, ...deps });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'crew-projection-'));
    store = new McpRegistryStore(join(base, 'mcp'));
    catalogs = new SourceCatalogStore(join(base, 'catalogs'));
    await store.mutate((file) => { file.servers = [...sources, jira]; });
    for (const source of sources) {
      await catalogs.write(source.name, {
        descriptorHash: sourceDescriptorHash(configOf(source)),
        catalog: {
          dialect: 'postgres', database: 'd', describedAt: STAMP,
          relations: [{ schema: 'public', name: 'tickets', kind: 'table', rowEstimate: null, columns: [{ name: 'id', type: 'bigint', nullable: false }], primaryKey: ['id'], foreignKeys: [] }],
        },
      });
    }
  });
  afterEach(() => removeScratch(base));

  it.each([LOCKED, LOCKED.replace('database is locked', 'DATABASE IS BUSY')])('acks the third attempt after contention: %s', async (message) => {
    const call = vi.fn<EstateCall>()
      .mockRejectedValueOnce(new EstateMcpError(message))
      .mockRejectedValueOnce(new EstateMcpError(message))
      .mockResolvedValue({ docs: 1 });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn();
    const p = projector({ call, sleep, log });
    p.written('source-a');
    await p.idle();
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(Array(3).fill('knowledge.replace_source'));
    expect(call.mock.calls[1]![1]).toBe(call.mock.calls[0]![1]);
    expect(call.mock.calls[2]![1]).toBe(call.mock.calls[0]![1]);
    expect(sleep.mock.calls).toEqual([[250], [1_000]]);
    expect(p.projectedDescriptor('source-a')).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not retry another refusal, and logs only its first line', async () => {
    const call = vi.fn<EstateCall>().mockRejectedValue(new EstateMcpError(`${OLDER}\nExtra diagnostics`));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn();
    const p = projector({ call, sleep, log });
    p.written('source-a');
    await p.idle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(p.projectedDescriptor('source-a')).toBeNull();
    expect(log).toHaveBeenCalledExactlyOnceWith(`[knowledge] source-a's structure was not projected into estate: ${OLDER}`);
  });

  it('gives up after three retries, logs the lock cause, and releases the lane for the next source', async () => {
    const call = vi.fn<EstateCall>(async (_tool, args) => {
      if (args['sourceId'] === 'source-a') throw new EstateMcpError(`${LOCKED}\nExtra diagnostics`);
      return { docs: 1 };
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn();
    const p = projector({ call, sleep, log });
    await p.backfill();
    expect(call.mock.calls.filter(([, args]) => args['sourceId'] === 'source-a')).toHaveLength(4);
    expect(call).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls).toEqual([[250], [1_000], [3_000]]);
    expect(p.projectedDescriptor('source-a')).toBeNull();
    expect(p.projectedDescriptor('source-b')).not.toBeNull();
    expect(log).toHaveBeenCalledExactlyOnceWith(`[knowledge] source-a's structure was not projected into estate: ${LOCKED}`);
  });

  it.each(['current', 'removed'] as const)('serializes two sources with a %s tracker, across projector instances', async (state) => {
    // Keep preparation in memory so all three contenders reach the lane before the first call's setImmediate.
    let registry = await store.read();
    const concurrentStore = { read: async () => registry, settled: async () => undefined, mutate: store.mutate.bind(store) };
    const descriptions = new Map(await Promise.all(sources.map(async (s) => [s.name, await catalogs.read(s.name)] as const)));
    vi.spyOn(catalogs, 'read').mockImplementation(async (name) => descriptions.get(name) ?? null);
    let running = 0;
    let peak = 0;
    const call = vi.fn<EstateCall>(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => setImmediate(resolve));
      running--;
      return {};
    });
    const trackers = new TrackerProjector({ store: concurrentStore, call });
    if (state === 'removed') {
      await trackers.reconcile();
      registry = { ...registry, servers: registry.servers.filter((s) => s.name !== 'jira') };
      call.mockClear();
    }
    const a = projector({ call, store: concurrentStore });
    const b = projector({ call, store: concurrentStore });
    await Promise.all([a.project('source-a'), b.project('source-b'), trackers.reconcile()]);
    expect(call).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(a.projectedDescriptor('source-a')).not.toBeNull();
    expect(b.projectedDescriptor('source-b')).not.toBeNull();
    expect(trackers.acknowledged(TRACKER_ID)).toBe(state === 'current');
    if (state === 'removed') expect(call.mock.calls.find(([, args]) => args['sourceId'] === TRACKER_ID)?.[1]['docs']).toEqual([]);
  });

  it('retries a tracker lock with the same generation before acknowledging it', async () => {
    const call = vi.fn<EstateCall>()
      .mockRejectedValueOnce(new EstateMcpError(LOCKED))
      .mockRejectedValueOnce(new EstateMcpError(LOCKED))
      .mockResolvedValue({ docs: 1 });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const schedule = vi.fn();
    const trackers = new TrackerProjector({ store, call, sleep, schedule });
    await trackers.reconcile();
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[1]![1]).toBe(call.mock.calls[0]![1]);
    expect(call.mock.calls[2]![1]).toBe(call.mock.calls[0]![1]);
    expect(sleep.mock.calls).toEqual([[250], [1_000]]);
    expect(trackers.projection(TRACKER_ID)).toBe('current');
    expect(trackers.acknowledged(TRACKER_ID)).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
  });
});
