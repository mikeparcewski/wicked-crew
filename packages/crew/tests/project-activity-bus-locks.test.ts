// F-E2E-021 — the project activity feed reads the bus without dropping the locks of the one
// connection that holds it.
//
// The daemon's bus file is held for the life of the process by ONE connection: the engine's
// (DES-TEAMING-002 T0), in WAL mode, keeping a SHARED lock from its first read. SQLite's locks are
// POSIX advisory locks: the kernel drops every lock the PROCESS holds on a file when ANY descriptor
// for that file is closed, and a second SQLite library in the process does not know about the
// first. The feed once read through `node:sqlite` (open read-only, close per GET) and later
// through crew's own better-sqlite3 handle; a close by either released the holder's locks, and the
// next short-lived external emitter (`wicked-bus emit`, what wicked-estate spawns) obtained the
// EXCLUSIVE lock on its own close, checkpointed and UNLINKED bus.db-wal/-shm under the daemon,
// whose reads failed with "database disk image is malformed" for the rest of its life.
//
// Since wicked-core#631 crew opens no SQLite at all: the feed reads through the engine that holds
// the bus (`Core.busRead`, src/core/bus.ts). This test drives the sequence with the REAL engine as
// the holder and the REAL `wicked-bus emit` CLI as the external emitter, and asserts the sidecar
// inodes survive the feed reads and the engine keeps reading every row.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildActivityPage } from '../src/projects/activity.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { busTesting } from '../src/core/bus.js';
import { removeScratch } from './setup/scratch.js';

const require = createRequire(import.meta.url);
/** The real `wicked-bus` CLI entry — the process wicked-estate spawns to emit (`WICKED_ESTATE_EMIT_PROGRAM`). */
const WICKED_BUS_CLI = join(dirname(require.resolve('wicked-bus')), '..', 'commands', 'cli.js');

const inode = (path: string): number | null => {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
};

/** A short-lived external emitter: open → emit → close → exit, in its OWN process, on `dataDir/bus.db`. */
function externalEmit(dataDir: string, n: number): void {
  const r = spawnSync(
    process.execPath,
    [
      WICKED_BUS_CLI,
      'emit',
      '--type',
      'wicked.interactive.status.posted',
      '--domain',
      'wicked-interactive',
      '--subdomain',
      'status',
      '--payload',
      JSON.stringify({ project_id: 'proj-1', document_id: `doc-${n}`, n }),
    ],
    { encoding: 'utf8', env: { ...process.env, WICKED_BUS_DATA_DIR: dataDir } },
  );
  expect(r.status, `wicked-bus emit #${n} failed: ${r.stderr}${r.stdout}`).toBe(0);
}

describe('project activity feed vs the engine holding the bus (F-E2E-021)', () => {
  it('reads the interactive half through the engine: external emitter closes leave bus.db-wal/-shm in place and every row is read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crew-fe2e021-'));
    const dbPath = join(dataDir, 'bus.db');
    const savedBus = process.env['WICKED_BUS_DB'];
    // The daemon side: the engine is handed the bus and holds it (its launch bridge opens it at
    // spawn and reads the tail, so the WAL-mode SHARED lock is held from here on).
    const adapter = new CoreAdapter({ dbPath: join(dataDir, 'core.db'), stub: true, busDbPath: dbPath });
    try {
      const wal = inode(`${dbPath}-wal`);
      const shm = inode(`${dbPath}-shm`);
      expect(wal, 'bus.db-wal exists once the engine opened the WAL').not.toBeNull();
      expect(shm, 'bus.db-shm exists once the engine opened the WAL').not.toBeNull();

      // Control: an external emitter's close cannot take the EXCLUSIVE lock past the engine.
      externalEmit(dataDir, 1);
      expect([inode(`${dbPath}-wal`), inode(`${dbPath}-shm`)]).toEqual([wal, shm]);

      // The read under test: the activity feed's interactive half (a GET /projects/:id/activity).
      const page = await buildActivityPage(adapter, 'proj-1', [], dbPath, undefined, 50);
      expect(page.entries.map((e) => e.id)).toEqual(['bus:1']);
      expect(page.entries[0]?.source).toBe('interactive');

      // The external emitter again: with a second SQLite library behind the feed read, THIS close
      // unlinked both sidecars — the F-E2E-021 failure.
      externalEmit(dataDir, 2);
      expect(inode(`${dbPath}-wal`), 'bus.db-wal must survive an external close after the feed read').toBe(wal);
      expect(inode(`${dbPath}-shm`), 'bus.db-shm must survive an external close after the feed read').toBe(shm);

      // A second feed read sees both rows through the same, still-healthy bus.
      const again = await buildActivityPage(adapter, 'proj-1', [], dbPath, undefined, 50);
      expect(again.entries.map((e) => e.id)).toEqual(['bus:2', 'bus:1']);
    } finally {
      adapter.close();
      if (savedBus === undefined) delete process.env['WICKED_BUS_DB'];
      else process.env['WICKED_BUS_DB'] = savedBus;
      removeScratch(dataDir);
    }
  });

  it('a bus no engine holds yields an empty interactive half, never an error, and creates nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crew-fe2e021-missing-'));
    const double = busTesting.unattached;
    busTesting.unattached = undefined; // the daemon has no double: an unheld bus is just absent
    try {
      const adapter = { runEvents: async () => [] } as unknown as CoreAdapter;
      const page = await buildActivityPage(adapter, 'proj-1', [], join(dataDir, 'absent', 'bus.db'), undefined, 50);
      expect(page.entries).toEqual([]);
      expect(inode(join(dataDir, 'absent', 'bus.db')), 'a feed read must not create a bus db').toBeNull();
    } finally {
      busTesting.unattached = double;
      removeScratch(dataDir);
    }
  });
});
