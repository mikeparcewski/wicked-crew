// crew#679 — the one bus writer: crew's rows land from a child process, in the order crew emitted
// them, a duplicate key is refused as WB-002 (the seams treat that as success), and the daemon
// process never opens a writing connection on the file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crewBusHandle } from '../src/core/bus-handle.js';
import { BusWriteError, emitOnBus } from '../src/core/bus-writer.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let busPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bus-writer-'));
  busPath = join(dir, 'bus.db');
});
afterEach(() => removeScratch(dir));

const row = (n: number, key = `k-${n}-${Math.random()}`) => ({
  event_type: 'wicked.interactive.status.posted',
  domain: 'wicked-interactive',
  subdomain: 'status',
  payload: { n },
  producer_id: 'wi-crew',
  idempotency_key: key,
});

describe('emitOnBus (the single bus writer)', () => {
  it('lands every row, in the order crew emitted them', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, (_, n) => emitOnBus(busPath, row(n))));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const rows = crewBusHandle(busPath, { create: false })
      .prepare('SELECT event_id, payload FROM events ORDER BY event_id')
      .all() as Array<{ event_id: number; payload: string }>;
    expect(rows.map((r) => (JSON.parse(r.payload) as { n: number }).n)).toEqual(Array.from({ length: 20 }, (_, n) => n));
  });

  it('refuses a key already emitted with WB-002', async () => {
    await emitOnBus(busPath, row(1, 'same-key'));
    const err = await emitOnBus(busPath, row(2, 'same-key')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusWriteError);
    expect((err as BusWriteError).error).toBe('WB-002');
  });

  it('fails a bus it cannot open, loudly, and never hangs', async () => {
    writeFileSync(join(dir, 'a-file'), ''); // a path under a regular file can never be a db
    const err = await emitOnBus(join(dir, 'a-file', 'bus.db'), row(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusWriteError);
    expect((err as Error).message).toMatch(/bus writer/);
  });
});
