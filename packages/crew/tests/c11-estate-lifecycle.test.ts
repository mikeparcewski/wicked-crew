// crew-C11 seam C: what estate holds of a source follows the registry across a restart.
//   - crew#1328 item 1 / crew#1354: removing a data source, or a PM source with its trackers, writes registry-level
//     tombstones in the same write; the one writer of each id (the source projector for a data source, the tracker
//     projector for a tracker; a fresh one, as after a restart) sends each an empty generation and drops it once
//     estate takes it. A restore that drops a source tombstones it too; an id a restore brings back is not erased.
//   - codex and agy on #1735: every estate write of a source id runs on that id's lane and reads the registry there,
//     so a projection never lands after the erasure of what was removed, an erasure never lands after the projection
//     of what a restore brought back, and an acknowledgement is never kept for a key estate may no longer hold.
//   - crew#1328 item 3 (the allowlist half): a re-save that changes a source's allowed views with no new description
//     names the source for re-projection.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SourceProjector } from '../src/knowledge/projector.js';
import { trackerIdOf } from '../src/knowledge/registry/entry.js';
import { TrackerProjector } from '../src/knowledge/trackers/projector.js';
import { addEstateTombstones, configOf, McpRegistry, normalizeRegistryFile } from '../src/mcp/registry.js';
import { McpRegistryStore, type McpRegistryFile } from '../src/mcp/registry-store.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { removeScratch } from './setup/scratch.js';

const noSecrets: SecretStore = { available: true, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
const stamp = '2026-11-21T00:00:00.000Z';
const health = { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null };
const SOURCE_ID = '3f0c9a1e-0000-4000-8000-0000000c1101';
const PM_ID = '3f0c9a1e-0000-4000-8000-0000000c1102';
const TRACKER = trackerIdOf(PM_ID, 'c1', 'PROJA');
const RETIRED = trackerIdOf(PM_ID, 'c1', 'PROJB');

const fx = { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [], url: null, auth: null, enabled: true, health, registeredAt: stamp, updatedAt: stamp, tools: [] };
const sqlConfig = { driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'shop', user: 'reader', tls: 'disable' };
function sourceRecord(viewsAllowed: string[] = []): Record<string, unknown> {
  return { id: SOURCE_ID, name: 'shop-db', kind: 'sql', command: null, args: [], url: null, auth: null, sql: sqlConfig, viewsAllowed, address: { allow: ['127.0.0.0/8'], plaintext: false }, enabled: true, health, registeredAt: stamp, updatedAt: stamp, tools: [] };
}
function pmRecord(): Record<string, unknown> {
  return {
    id: PM_ID, name: 'jira', kind: 'mcp-stdio', command: process.execPath, args: [], url: null, auth: null, pm: { system: 'jira' }, enabled: true, health, registeredAt: stamp, updatedAt: stamp, tools: [],
    trackers: [{ id: TRACKER, tenant: 'c1', tenantLabel: 'site c1', key: 'PROJA', label: 'PROJA project', links: [{ id: 'tl_0000000000000001', target: { kind: 'project', id: 'proj' }, linkedAt: stamp, linkedBy: 'local' }] }],
    retired: [{ id: RETIRED, since: stamp }],
  };
}

describe('estate tombstones survive the entry and a restart (crew#1328 item 1, crew#1354)', () => {
  let base: string | undefined;
  afterEach(() => {
    if (base !== undefined) removeScratch(base);
    base = undefined;
  });

  function rig(servers: Array<Record<string, unknown>>) {
    base = mkdtempSync(join(tmpdir(), 'c11-tombstones-'));
    const dir = join(base, 'mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, servers }));
    const store = new McpRegistryStore(dir);
    const registry = new McpRegistry({ store, secrets: noSecrets, probe: probeMcpServer, discover: () => [] });
    const onDisk = (): McpRegistryFile => JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as McpRegistryFile;
    const acksFile = join(dir, 'knowledge-acks.json');
    return { store, registry, onDisk, acksFile };
  }

  /** The source's catalog, as a describe writes it (one table). */
  async function describeShop(store: McpRegistryStore, registry: McpRegistry): Promise<void> {
    const r = normalizeRegistryFile(await store.read()).servers.find((x) => x.name === 'shop-db')!;
    const catalog = { dialect: 'mysql', database: 'shop', describedAt: stamp, relations: [{ schema: 'shop', name: 'orders', kind: 'table', rowEstimate: null, columns: [{ name: 'id', type: 'bigint', nullable: false }], primaryKey: ['id'], foreignKeys: [] }] };
    await registry.catalogs.write('shop-db', { descriptorHash: sourceDescriptorHash(configOf(r)), catalog: catalog as never });
  }

  /** An estate whose first write waits for `release()`; every write is recorded as [source id, docs]. */
  function heldEstate() {
    const sent: Array<[unknown, number]> = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    let first = true;
    const call = async (_tool: string, args: Record<string, unknown>): Promise<unknown> => {
      if (first) {
        first = false;
        holding = true;
        await held;
      }
      sent.push([args['sourceId'], (args['docs'] as unknown[]).length]);
      return {};
    };
    return { sent, call, release: () => release(), holding: () => holding };
  }

  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(pred()).toBe(true);
  }

  it('removing a source and a PM source writes their tombstones; fresh writers erase them once (fails before the fix)', async () => {
    const { store, registry, onDisk } = rig([sourceRecord(), pmRecord()]);
    const named: unknown[] = [];
    registry.onTombstoned = (targets) => {
      named.push(targets);
      throw new Error('a listener failure is its own');
    };
    await registry.remove('shop-db');
    await registry.remove('jira');
    expect(named).toEqual([[{ id: SOURCE_ID, kind: 'source' }], [{ id: TRACKER, kind: 'tracker' }, { id: RETIRED, kind: 'tracker' }]]);
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID, TRACKER, RETIRED]);

    // Writers that never projected any of them (a restarted daemon) still erase each, each its own ids.
    const sent: Array<Record<string, unknown>> = [];
    const call = async (_tool: string, args: Record<string, unknown>): Promise<unknown> => void sent.push(args);
    const trackers = new TrackerProjector({ store, call });
    await trackers.reconcile();
    expect(sent.map((a) => [a['sourceId'], (a['docs'] as unknown[]).length])).toEqual([[TRACKER, 0], [RETIRED, 0]]);
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID]);
    sent.length = 0;
    await new SourceProjector({ store, catalogs: registry.catalogs, call }).backfill();
    expect(sent.map((a) => [a['sourceId'], (a['docs'] as unknown[]).length])).toEqual([[SOURCE_ID, 0]]);
    expect(onDisk().estateTombstones).toBeUndefined();
    sent.length = 0;
    await trackers.reconcile();
    await new SourceProjector({ store, catalogs: registry.catalogs, call }).backfill();
    expect(sent).toEqual([]);
  });

  it('a removal whose erasure had not run before a restart: the kept acknowledgement goes before the empty generation is sent', async () => {
    const { store, registry, onDisk, acksFile } = rig([sourceRecord()]);
    await describeShop(store, registry);
    const sent: Array<[unknown, number]> = [];
    const call = async (_tool: string, args: Record<string, unknown>): Promise<unknown> => void sent.push([args['sourceId'], (args['docs'] as unknown[]).length]);
    const before = new SourceProjector({ store, catalogs: registry.catalogs, call, acksFile });
    expect(await before.project('shop-db')).toBe(true);
    const key = before.projectedDescriptor(SOURCE_ID);
    expect(key).not.toBeNull();
    // The daemon stops after the removal lands and before its erasure runs (no listener).
    await registry.remove('shop-db');
    // Restarted: the acknowledgement is still true (estate still holds that projection) until the erasure.
    const after = new SourceProjector({ store, catalogs: registry.catalogs, call, acksFile });
    expect(after.projectedDescriptor(SOURCE_ID)).toBe(key);
    let ackOnDiskAtSend: unknown = 'unread';
    const watching = new SourceProjector({
      store,
      catalogs: registry.catalogs,
      acksFile,
      call: async (tool, args) => {
        ackOnDiskAtSend = (JSON.parse(readFileSync(acksFile, 'utf8')) as { acked: Record<string, string> }).acked[SOURCE_ID] ?? null;
        return call(tool, args);
      },
    });
    sent.length = 0;
    await watching.backfill();
    expect(sent).toEqual([[SOURCE_ID, 0]]);
    expect(ackOnDiskAtSend).toBeNull();
    expect(watching.projectedDescriptor(SOURCE_ID)).toBeNull();
    expect(new SourceProjector({ store, catalogs: registry.catalogs, acksFile }).projectedDescriptor(SOURCE_ID)).toBeNull();
    expect(onDisk().estateTombstones).toBeUndefined();
  });

  it('an erasure estate refuses is kept and retried; one whose source is live again is dropped, never erased', async () => {
    const { store, registry, onDisk } = rig([sourceRecord(), pmRecord()]);
    await registry.remove('shop-db');
    const scheduled: number[] = [];
    let refuse = true;
    const sent: string[] = [];
    const projector = new SourceProjector({
      store,
      catalogs: registry.catalogs,
      call: async (_tool, args) => {
        if (refuse && args['sourceId'] === SOURCE_ID) throw new Error('estate is not up');
        sent.push(String(args['sourceId']));
      },
      schedule: (_fn, ms) => void scheduled.push(ms),
      log: () => undefined,
    });
    projector.erase([SOURCE_ID]);
    await projector.idle();
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID]);
    expect(scheduled.length).toBe(1);
    // The source is live again with its tombstone still there (a hand edit): it is dropped and nothing erases it.
    await store.mutate((f) => {
      f.servers.push(sourceRecord() as never);
    });
    refuse = false;
    sent.length = 0;
    projector.erase([SOURCE_ID]);
    await projector.idle();
    expect(sent).toEqual([]);
    expect(onDisk().estateTombstones).toBeUndefined();
  });

  it('a projection queued before a removal never lands after its erasure (codex and agy on #1735)', async () => {
    const { store, registry, onDisk } = rig([sourceRecord()]);
    await describeShop(store, registry);
    const estate = heldEstate();
    const projector = new SourceProjector({ store, catalogs: registry.catalogs, call: estate.call });
    registry.onTombstoned = (targets) => projector.erase(targets.filter((t) => t.kind === 'source').map((t) => t.id));
    projector.written('shop-db');
    projector.written('shop-db');
    await until(estate.holding);
    await registry.remove('shop-db');
    estate.release();
    await projector.idle();
    // The first projection was in flight; the queued one found the source gone; the erasure is the last write.
    expect(estate.sent).toEqual([[SOURCE_ID, 1], [SOURCE_ID, 0]]);
    expect(projector.projectedDescriptor(SOURCE_ID)).toBeNull();
    expect(onDisk().estateTombstones).toBeUndefined();
  });

  it('an erasure in flight when a restore brings the source back lands before its projection, never after (codex and agy on #1735)', async () => {
    const { store, registry, onDisk } = rig([fx, sourceRecord()]);
    const estate = heldEstate();
    const projector = new SourceProjector({ store, catalogs: registry.catalogs, call: estate.call });
    registry.onTombstoned = (targets) => projector.erase(targets.filter((t) => t.kind === 'source').map((t) => t.id));
    registry.onSourceChanged = (name) => projector.written(name);
    // The removal keeps the first file (fx and the source) as generation 1.
    await registry.remove('shop-db');
    await until(estate.holding);
    await registry.restore(await registry.planRestore(1));
    // The restore that brings an id back drops its tombstone at once (agy on #1735).
    expect(onDisk().estateTombstones).toBeUndefined();
    // Described again (its catalog left with the removal).
    await describeShop(store, registry);
    projector.written('shop-db');
    estate.release();
    await projector.idle();
    expect(estate.sent[0]).toEqual([SOURCE_ID, 0]);
    expect(estate.sent[estate.sent.length - 1]).toEqual([SOURCE_ID, 1]);
    expect(projector.projectedDescriptor(SOURCE_ID)).not.toBeNull();
  });

  it('a drop of an acknowledgement that cannot be written sends nothing, and the next attempt drops it again first (codex and agy on #1735)', async () => {
    const { store, registry, acksFile } = rig([sourceRecord([])]);
    await describeShop(store, registry);
    const sent: Array<[unknown, number]> = [];
    const projector = new SourceProjector({ store, catalogs: registry.catalogs, acksFile, call: async (_tool, args) => void sent.push([args['sourceId'], (args['docs'] as unknown[]).length]) });
    expect(await projector.project('shop-db')).toBe(true);
    const first = projector.projectedDescriptor(SOURCE_ID);
    // The allowed views change (another projection key), and the acknowledgement file cannot be replaced.
    await store.mutate((f) => {
      f.servers[0]!.viewsAllowed = ['shop.v_orders'];
    });
    rmSync(acksFile);
    mkdirSync(acksFile);
    sent.length = 0;
    await expect(projector.project('shop-db')).rejects.toThrow();
    await expect(projector.project('shop-db')).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(projector.projectedDescriptor(SOURCE_ID)).toBe(first);
    rmSync(acksFile, { recursive: true });
    expect(await projector.project('shop-db')).toBe(true);
    expect(sent).toEqual([[SOURCE_ID, 1]]);
    const second = projector.projectedDescriptor(SOURCE_ID);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect((JSON.parse(readFileSync(acksFile, 'utf8')) as { acked: Record<string, string> }).acked[SOURCE_ID]).toBe(second);
  });

  it('a tracker erased then restored unchanged is projected again (codex on #1735)', async () => {
    const { store, registry } = rig([fx, pmRecord()]);
    const sent: Array<Record<string, unknown>> = [];
    const trackers = new TrackerProjector({ store, call: async (_tool, args) => void sent.push(args) });
    await trackers.reconcile();
    expect(trackers.acknowledged(TRACKER)).toBe(true);
    // The removal keeps the first file (fx and the PM entry) as generation 1.
    await registry.remove('jira');
    await trackers.reconcile();
    expect(trackers.acknowledged(TRACKER)).toBe(false);
    await registry.restore(await registry.planRestore(1));
    sent.length = 0;
    await trackers.reconcile();
    const again = sent.filter((a) => a['sourceId'] === TRACKER);
    expect(again).toHaveLength(1);
    expect((again[0]!['docs'] as unknown[]).length).toBeGreaterThan(0);
    expect(trackers.acknowledged(TRACKER)).toBe(true);
  });

  it('an unreadable address record does not hold up a tracker erasure (codex on #1735)', async () => {
    const { store, registry, onDisk } = rig([pmRecord()]);
    await registry.remove('jira');
    const sent: Array<[unknown, number]> = [];
    const trackers = new TrackerProjector({
      store,
      call: async (_tool, args) => void sent.push([args['sourceId'], (args['docs'] as unknown[]).length]),
      addresses: async () => {
        throw new Error('the address file is damaged');
      },
      schedule: () => undefined,
      log: () => undefined,
    });
    await trackers.reconcile();
    expect(sent).toEqual([[TRACKER, 0], [RETIRED, 0]]);
    expect(onDisk().estateTombstones).toBeUndefined();
  });

  it('no tombstone is ever evicted, and a second removal of a waiting id adds none (codex and agy on #1735)', () => {
    const file: McpRegistryFile = { version: 1, servers: [] };
    addEstateTombstones(file, Array.from({ length: 2_500 }, (_, i) => ({ id: `s${i}`, kind: 'source' as const })), stamp);
    expect(file.estateTombstones).toHaveLength(2_500);
    addEstateTombstones(file, [{ id: 's0', kind: 'source' }, { id: 's0', kind: 'tracker' }], '2026-11-21T00:00:01.000Z');
    expect(file.estateTombstones).toHaveLength(2_501);
    expect(file.estateTombstones![0]).toEqual({ id: 's0', kind: 'source', at: stamp });
  });

  it('a restore to a generation without a source tombstones it', async () => {
    const { store, registry, onDisk } = rig([fx]);
    // A later write keeps this file (fx only) as generation 1; the source is added after it.
    await registry.setServerEnabled('fx', false);
    await store.mutate((f) => {
      f.servers.push(sourceRecord() as never);
    });
    const tombstoned: unknown[] = [];
    registry.onTombstoned = (ids) => void tombstoned.push(ids);
    await registry.restore(await registry.planRestore(1));
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID]);
    expect(tombstoned).toEqual([[{ id: SOURCE_ID, kind: 'source' }]]);
  });
});

describe('a re-save that changes only the allowed views re-projects the source (crew#1328 item 3)', () => {
  let base: string | undefined;
  afterEach(() => {
    if (base !== undefined) removeScratch(base);
    base = undefined;
  });

  it('names the source once its write lands; a re-save with the same views does not (fails before the fix)', async () => {
    base = mkdtempSync(join(tmpdir(), 'c11-views-'));
    const dir = join(base, 'mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, servers: [sourceRecord([])] }));
    const registry = new McpRegistry({ store: new McpRegistryStore(dir), secrets: noSecrets, probe: probeMcpServer, discover: () => [] });
    const named: string[] = [];
    registry.onSourceChanged = (name) => named.push(name);
    // A held preview with no new description (a Toolbox-runtime re-save describes nothing at preview).
    const hold = (hash: string, viewsAllowed: string[]): void => {
      (registry as unknown as { previews: Map<string, unknown> }).previews.set(hash, {
        config: { name: 'shop-db', kind: 'sql', command: null, args: [], url: null, auth: null, sql: sqlConfig, viewsAllowed, address: { allow: ['127.0.0.0/8'], plaintext: false } },
        tools: [],
        expiresAt: Date.now() + 60_000,
        secret: null,
        egress: null,
        source: null,
      });
    };
    hold('p1', ['shop.v_orders']);
    await registry.save('p1');
    expect(named).toEqual(['shop-db']);
    hold('p2', ['shop.v_orders']);
    await registry.save('p2');
    expect(named).toEqual(['shop-db']);
  });
});
