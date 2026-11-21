// crew-C11 seam C: what estate holds of a source follows the registry across a restart.
//   - crew#1328 item 1 / crew#1354: removing a data source, or a PM source with its trackers, writes registry-level
//     tombstones in the same write; the tracker projector (a fresh one, as after a restart) sends each an empty
//     generation and drops it once estate takes it. A restore that drops a source tombstones it too; an id a restore
//     brings back is not erased.
//   - crew#1328 item 3 (the allowlist half): a re-save that changes a source's allowed views with no new description
//     names the source for re-projection.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { trackerIdOf } from '../src/knowledge/registry/entry.js';
import { TrackerProjector } from '../src/knowledge/trackers/projector.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore, type McpRegistryFile } from '../src/mcp/registry-store.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const noSecrets: SecretStore = { available: true, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
const stamp = '2026-11-21T00:00:00.000Z';
const health = { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null };
const SOURCE_ID = '3f0c9a1e-0000-4000-8000-0000000c1101';
const PM_ID = '3f0c9a1e-0000-4000-8000-0000000c1102';
const TRACKER = trackerIdOf(PM_ID, 'c1', 'PROJA');
const RETIRED = trackerIdOf(PM_ID, 'c1', 'PROJB');

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
    return { store, registry, onDisk };
  }

  it('removing a source and a PM source writes their tombstones; a fresh projector erases them once (fails before the fix)', async () => {
    const { store, registry, onDisk } = rig([sourceRecord(), pmRecord()]);
    const named: string[][] = [];
    registry.onTombstoned = (ids) => {
      named.push(ids);
      throw new Error('a listener failure is its own');
    };
    await registry.remove('shop-db');
    await registry.remove('jira');
    expect(named).toEqual([[SOURCE_ID], [TRACKER, RETIRED]]);
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID, TRACKER, RETIRED]);

    // A projector that never projected any of them (a restarted daemon) still erases each, then drops the list.
    const sent: Array<Record<string, unknown>> = [];
    const projector = new TrackerProjector({ store, call: async (_tool, args) => void sent.push(args) });
    await projector.reconcile();
    expect(sent.map((a) => [a['sourceId'], (a['docs'] as unknown[]).length])).toEqual([[SOURCE_ID, 0], [TRACKER, 0], [RETIRED, 0]]);
    expect(onDisk().estateTombstones).toBeUndefined();
    sent.length = 0;
    await projector.reconcile();
    expect(sent).toEqual([]);
  });

  it('a tombstone estate refuses is kept and retried; one live again (restored) is dropped, never erased', async () => {
    const { store, registry, onDisk } = rig([sourceRecord(), pmRecord()]);
    await registry.remove('shop-db');
    const scheduled: number[] = [];
    let refuse = true;
    const sent: string[] = [];
    const projector = new TrackerProjector({
      store,
      call: async (_tool, args) => {
        if (refuse && args['sourceId'] === SOURCE_ID) throw new Error('estate is not up');
        sent.push(String(args['sourceId']));
      },
      schedule: (_fn, ms) => void scheduled.push(ms),
      log: () => undefined,
    });
    await projector.reconcile();
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID]);
    expect(scheduled.length).toBeGreaterThan(0);
    // The source comes back (as a restore would bring it): its tombstone is dropped and nothing erases it.
    await store.mutate((f) => {
      f.servers.push(sourceRecord() as never);
    });
    refuse = false;
    sent.length = 0;
    await projector.reconcile();
    expect(sent).not.toContain(SOURCE_ID);
    expect(onDisk().estateTombstones).toBeUndefined();
  });

  it('a restore to a generation without a source tombstones it', async () => {
    const fx = { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [], url: null, auth: null, enabled: true, health, registeredAt: stamp, updatedAt: stamp, tools: [] };
    const { store, registry, onDisk } = rig([fx]);
    // A later write keeps this file (fx only) as generation 1; the source is added after it.
    await registry.setServerEnabled('fx', false);
    await store.mutate((f) => {
      f.servers.push(sourceRecord() as never);
    });
    const tombstoned: string[][] = [];
    registry.onTombstoned = (ids) => void tombstoned.push(ids);
    await registry.restore(await registry.planRestore(1));
    expect((onDisk().estateTombstones ?? []).map((t) => t.id)).toEqual([SOURCE_ID]);
    expect(tombstoned).toEqual([[SOURCE_ID]]);
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
