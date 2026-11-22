// crew#1741: the projection acknowledgements are written durably, as `api/run-sources.ts` writes a run's source pick:
// the temp file is flushed before the rename, and the directory is synced after it.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsCalls = vi.hoisted(() => ({ writes: [] as Array<{ path: string; options: unknown }>, fsyncs: 0, renames: [] as string[], order: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]) => {
      fsCalls.writes.push({ path: String(path), options });
      fsCalls.order.push('write');
      return actual.writeFileSync(path, data, options);
    },
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      fsCalls.renames.push(String(to));
      fsCalls.order.push('rename');
      return actual.renameSync(from, to);
    },
    fsyncSync: (fd: number) => {
      fsCalls.fsyncs++;
      fsCalls.order.push('fsync');
      return actual.fsyncSync(fd);
    },
  };
});

const { SourceProjector } = await import('../src/knowledge/projector.js');
const { removeScratch } = await import('./setup/scratch.js');

describe('the projection acknowledgements are durable (crew#1741)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) removeScratch(dir);
    dir = undefined;
  });

  it('flushes the file before the rename and syncs the directory after it (fails before the fix)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'acks-durable-'));
    const acksFile = join(dir, 'mcp', 'knowledge-acks.json');
    const { sourceDescriptorHash } = await import('../src/sources/kinds.js');
    const { configOf } = await import('../src/mcp/registry.js');
    const at = '2026-11-22T00:00:00.000Z';
    const record = { id: '3f0c9a1e-0000-4000-8000-0000000d1741', name: 'shop-pg', kind: 'sql', command: null, args: [], url: null, auth: null, enabled: true, health: { state: 'ok', consecutiveFailures: 0, checkedAt: at, lastError: null }, registeredAt: at, updatedAt: at, tools: [], sql: { driver: 'postgres', host: 'db.test', port: 5432, database: 'd', user: 'u', tls: 'disable' }, viewsAllowed: [] as string[], address: { allow: ['127.0.0.0/8'], plaintext: false } };
    const catalog = { dialect: 'postgres', database: 'd', describedAt: at, relations: [{ schema: 's', name: 'orders', kind: 'table', rowEstimate: null, columns: [{ name: 'id', type: 'bigint', nullable: false }], primaryKey: ['id'], foreignKeys: [] }] };
    const projector = new SourceProjector({
      store: { read: async () => ({ version: 1, servers: [record] }) as never, settled: async () => undefined },
      catalogs: { read: async () => ({ catalog, descriptorHash: sourceDescriptorHash(configOf(record as never)) }) } as never,
      call: async () => ({}),
      acksFile,
    });
    fsCalls.order.length = 0;
    expect(await projector.project('shop-pg')).toBe(true);
    const ackWrites = fsCalls.writes.filter((w) => w.path.startsWith(`${acksFile}.`));
    expect(ackWrites).toHaveLength(1);
    expect(ackWrites[0]!.options).toMatchObject({ flush: true });
    expect(fsCalls.order).toEqual(['write', 'rename', 'fsync']);
  });
});
