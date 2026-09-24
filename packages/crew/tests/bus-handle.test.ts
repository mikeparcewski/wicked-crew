// DES-TEAMING-002 T0 — crew's side of the one-connection rule: the crew bus handle opens ONE
// long-lived better-sqlite3 connection per bus file per process and hands every caller that same one.
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crewBusHandle, crewBusHandleOpens } from '../src/core/bus-handle.js';

describe('crew bus handle (T0 connection rule)', () => {
  it('opens once per file and hands every caller the same connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-bus-handle-'));
    try {
      const busPath = join(dir, 'bus.db');
      const before = crewBusHandleOpens();
      const a = crewBusHandle(busPath, { create: true });
      const b = crewBusHandle(join(dir, '.', 'bus.db'), { create: false });
      expect(b).toBe(a);
      expect(crewBusHandleOpens() - before).toBe(1);
      expect(a.prepare('PRAGMA journal_mode').all()).toEqual([{ journal_mode: 'wal' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a read route never creates the bus: a missing file throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-bus-handle-missing-'));
    try {
      expect(() => crewBusHandle(join(dir, 'absent.db'), { create: false })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Windows refuses to unlink a file SQLite holds open, so the case cannot arise there.
  it.skipIf(process.platform === 'win32')('a bus file deleted and recreated under the same path gets a fresh handle that sees the new rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-bus-handle-recreated-'));
    try {
      const busPath = join(dir, 'bus.db');
      const before = crewBusHandleOpens();
      const old = crewBusHandle(busPath, { create: true });
      old.prepare("CREATE TABLE t (v TEXT)").run();
      old.prepare("INSERT INTO t VALUES ('old')").run();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(`${busPath}${suffix}`);
        } catch {
          /* absent */
        }
      }
      // Another writer recreates the bus at the same path.
      type Db = { prepare(s: string): { run(): unknown }; close(): void };
      const Database = createRequire(createRequire(import.meta.url).resolve('wicked-bus'))('better-sqlite3') as new (p: string) => Db;
      const external = new Database(busPath);
      external.prepare('CREATE TABLE t (v TEXT)').run();
      external.prepare("INSERT INTO t VALUES ('new')").run();
      external.close();

      const again = crewBusHandle(busPath, { create: false });
      expect(again.prepare('SELECT v FROM t').all()).toEqual([{ v: 'new' }]);
      expect(crewBusHandleOpens() - before).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
