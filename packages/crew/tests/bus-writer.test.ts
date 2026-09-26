// crew#679 — the one bus writer: crew's rows land from a child process, in the order crew emitted
// them; a duplicate key is refused as WB-002 (the seams treat that as success); a writer that never
// answers is bounded and replaced; an answer the child wrote before exiting is never reported failed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { crewBusHandle } from '../src/core/bus-handle.js';
import { BusWriteError, busWriterTesting, emitOnBus } from '../src/core/bus-writer.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let busPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bus-writer-'));
  busPath = join(dir, 'bus.db');
});
afterEach(() => {
  busWriterTesting.childScript = undefined;
  busWriterTesting.timeoutMs = 15_000;
  removeScratch(dir);
});

/** Stub children: they read request lines and answer (or don't) without touching any bus. */
const NEVER_ANSWERS = `process.stdin.resume();`;
// The writer process exits at once; the answer reaches its stdout pipe 300 ms later, from a
// grandchild that holds the same pipe. So the parent sees \`exit\` before the answer is read —
// the order Node allows for real ('exit' may fire before the stdio streams are drained).
const EXITS_BEFORE_ITS_ANSWER_IS_READ = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line);
  const answer = JSON.stringify({ id, ok: true, event_id: 7 });
  spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1] + "\\\\n"), 300)', answer], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.exit(0);
});
`;

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

  it('a writer that never answers is bounded: the emit rejects, and the next emit gets a fresh child', async () => {
    busWriterTesting.childScript = NEVER_ANSWERS;
    busWriterTesting.timeoutMs = 300;
    const started = Date.now();
    const err = await emitOnBus(busPath, row(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusWriteError);
    expect((err as Error).message).toMatch(/did not answer/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The wedged child was dropped: the real writer answers the next emit.
    busWriterTesting.childScript = undefined;
    busWriterTesting.timeoutMs = 15_000;
    expect(await emitOnBus(busPath, row(2))).toBeGreaterThan(0);
  });

  it('an answer read after the writer exited is delivered, never reported as a failure', async () => {
    busWriterTesting.childScript = EXITS_BEFORE_ITS_ANSWER_IS_READ;
    await expect(emitOnBus(busPath, row(1))).resolves.toBe(7);
  });

  it('opens a bus another process holds locked past the busy timeout: it retries, it does not fail the emit', async () => {
    // Another process (this test) holds the write lock on a bus with no schema yet for 6 s —
    // longer than wicked-bus's 5 s busy timeout, the way a busy engine can hold the daemon's bus
    // while the writer's first open runs the schema DDL (crew#680 CI: "cannot open the bus:
    // database is locked").
    type Db = { exec(sql: string): unknown; close(): void };
    const Database = createRequire(createRequire(import.meta.url).resolve('wicked-bus'))('better-sqlite3') as new (p: string) => Db;
    const holder = new Database(busPath);
    holder.exec('PRAGMA journal_mode = WAL');
    holder.exec('BEGIN EXCLUSIVE');
    let held = true;
    const unlock = (): void => {
      if (!held) return;
      held = false;
      holder.exec('COMMIT');
      holder.close();
    };
    const release = setTimeout(unlock, 6_000);
    try {
      expect(await emitOnBus(busPath, row(1))).toBeGreaterThan(0);
    } finally {
      clearTimeout(release);
      unlock();
    }
  }, 20_000);
});

