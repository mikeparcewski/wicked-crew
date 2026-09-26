// wicked-core#631 review (D1): a bus file the ENGINE creates has the same `events` column order as
// one wicked-bus creates. wicked-bus's archive sweep copies rows by position
// (`INSERT INTO events_archive SELECT * FROM events`), so a different order would silently shuffle
// archived rows. Real engine vs real wicked-bus, compared column by column.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bus from 'wicked-bus';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

type Sqlite = new (p: string, o?: { readonly?: boolean }) => { prepare(sql: string): { all(): unknown[] } };
const Database = createRequire(createRequire(import.meta.url).resolve('wicked-bus'))('better-sqlite3') as Sqlite;
/** Test-side read connections: held for the life of the process, never closed (a close beside the
 *  engine's connection would drop its locks). */
const held: unknown[] = [];

function columns(path: string): string[] {
  const db = new Database(path, { readonly: true });
  held.push(db);
  return (db.prepare("SELECT name FROM pragma_table_info('events') ORDER BY cid").all() as Array<{ name: string }>).map((r) => r.name);
}

describe('events column order: engine-created vs wicked-bus-created (wicked-core#631)', () => {
  it('matches, column by column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bus-cols-'));
    const savedBus = process.env['WICKED_BUS_DB'];
    const enginePath = join(dir, 'engine', 'bus.db');
    const busPath = join(dir, 'wicked-bus', 'bus.db');
    mkdirSync(join(dir, 'engine'));
    mkdirSync(join(dir, 'wicked-bus'));
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true, busDbPath: enginePath });
    try {
      held.push(bus.openDb({ db_path: busPath })); // wicked-bus creates and migrates its file
      const fromEngine = columns(enginePath);
      const fromBus = columns(busPath);
      expect(fromBus).toContain('payload_cas_sha'); // the reference really is a migrated file
      expect(fromEngine).toEqual(fromBus);
    } finally {
      adapter.close();
      if (savedBus === undefined) delete process.env['WICKED_BUS_DB'];
      else process.env['WICKED_BUS_DB'] = savedBus;
      removeScratch(dir);
    }
  });
});
