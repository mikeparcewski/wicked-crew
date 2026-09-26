// crew#679 — the bus tap follows a bus file replaced under the same path. crewBusHandle opens a
// fresh connection when the path names a new file; the tap must restart its cursor there, or it
// keeps waiting for event ids past the OLD file's newest row and goes deaf.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tapBus, type BusTap } from '../src/core/bus-tap.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let busPath: string;
let tap: BusTap | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bus-tap-'));
  busPath = join(dir, 'bus.db');
});
afterEach(async () => {
  await tap?.stop();
  tap = null;
  removeScratch(dir);
});

async function emit(n: number): Promise<void> {
  const bus = await import('wicked-bus');
  const override = { db_path: busPath };
  const db = bus.openDb(override) as { close(): void };
  bus.emit(db, bus.loadConfig(override), {
    event_type: 'wicked.interactive.status.posted',
    domain: 'wicked-interactive',
    payload: { n },
    idempotency_key: `tap-${n}-${Math.random()}`,
  });
  db.close();
}

async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('tapBus', () => {
  // Windows refuses to unlink a file SQLite holds open, so the case cannot arise there.
  it.skipIf(process.platform === 'win32')('keeps relaying after the bus file is replaced under the same path', async () => {
    const seen: number[] = [];
    await emit(0); // the old file's history: the tap starts past it
    tap = tapBus({
      dbPath: busPath,
      filter: 'wicked.interactive.**',
      pollIntervalMs: 20,
      handler: (e) => {
        seen.push((e.payload as { n: number }).n);
      },
    });
    for (let n = 1; n <= 3; n++) await emit(n);
    await until(() => seen.length === 3);

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${busPath}${suffix}`);
      } catch {
        /* absent */
      }
    }
    await emit(10); // event_id 1 in the NEW file, below the old cursor
    await until(() => seen.includes(10));
    expect(seen).toEqual([1, 2, 3, 10]);
  });
});
