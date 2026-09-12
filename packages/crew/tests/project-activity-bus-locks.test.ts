// F-E2E-021 — the project activity feed must read the bus through the SAME SQLite library the
// daemon's long-lived wicked-bus subscribers use.
//
// The daemon holds better-sqlite3 connections on bus.db for its whole life (interactive seams,
// /ws relay, project bridge); in WAL mode each keeps a SHARED lock on the db file from its first
// read until close. SQLite's locks are POSIX advisory locks: the kernel drops every lock the
// PROCESS holds on a file when ANY descriptor for that file is closed. A single SQLite library
// instance defers such closes while siblings hold locks — a SECOND instance in the process
// (`node:sqlite`, which the feed used to open read-only and close per GET) does not know about
// the first and released the seams' locks. The next short-lived external emitter (`wicked-bus
// emit`, what wicked-estate spawns) then obtained the EXCLUSIVE lock on its own close,
// checkpointed and UNLINKED bus.db-wal/-shm under the seams, whose polls failed with
// "database disk image is malformed" every 2 s for the rest of the daemon's life.
//
// This test drives that exact sequence with the REAL `wicked-bus emit` CLI as the external
// emitter and asserts the sidecar inodes survive the feed read and the subscriber keeps reading.
// With the `node:sqlite` read in place, the second external emit unlinks both sidecars here.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as bus from 'wicked-bus';
import { buildActivityPage } from '../src/projects/activity.js';
import type { CoreAdapter } from '../src/core/adapter.js';

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

describe('project activity feed vs the daemon bus subscribers (F-E2E-021)', () => {
  it('reads the interactive half without dropping the subscribers locks: external emitter closes leave bus.db-wal/-shm in place and the subscriber keeps reading', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crew-fe2e021-'));
    const dbPath = join(dataDir, 'bus.db');

    // The daemon side: one long-lived subscriber connection, exactly how the seams open theirs
    // (typed locally: crew never depends on better-sqlite3's types, it reaches it through wicked-bus).
    const seam = bus.openDb({ db_path: dbPath }) as unknown as {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    const seamCount = (): number =>
      (seam.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(seamCount()).toBe(0); // first read: from here the WAL-mode SHARED lock is held for life

    const wal = inode(`${dbPath}-wal`);
    const shm = inode(`${dbPath}-shm`);
    expect(wal, 'bus.db-wal exists once the seam opened the WAL').not.toBeNull();
    expect(shm, 'bus.db-shm exists once the seam opened the WAL').not.toBeNull();

    // Control: an external emitter's close cannot take the EXCLUSIVE lock past the seam, so the
    // sidecars stay and the seam sees the row.
    externalEmit(dataDir, 1);
    expect([inode(`${dbPath}-wal`), inode(`${dbPath}-shm`)]).toEqual([wal, shm]);
    expect(seamCount()).toBe(1);

    // The read under test: the activity feed's interactive half (a GET /projects/:id/activity).
    const adapter = { runEvents: async () => [] } as unknown as CoreAdapter;
    const page = await buildActivityPage(adapter, 'proj-1', [], dbPath, undefined, 50);
    expect(page.entries.map((e) => e.id)).toEqual(['bus:1']);
    expect(page.entries[0]?.source).toBe('interactive');

    // The external emitter again. With a second SQLite library behind the feed read, THIS close
    // unlinked both sidecars (the seam's kernel locks were gone) — the F-E2E-021 failure.
    externalEmit(dataDir, 2);
    expect(inode(`${dbPath}-wal`), 'bus.db-wal must survive an external close after the feed read').toBe(wal);
    expect(inode(`${dbPath}-shm`), 'bus.db-shm must survive an external close after the feed read').toBe(shm);

    // …and the subscriber still reads a consistent view (no SQLITE_CORRUPT), including the new row.
    expect(seamCount()).toBe(2);

    // A second feed read sees both rows through the same, still-healthy bus.
    const again = await buildActivityPage(adapter, 'proj-1', [], dbPath, undefined, 50);
    expect(again.entries.map((e) => e.id)).toEqual(['bus:2', 'bus:1']);

    seam.close();
  });

  it('a missing bus db yields an empty interactive half, never an error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'crew-fe2e021-missing-'));
    const adapter = { runEvents: async () => [] } as unknown as CoreAdapter;
    const page = await buildActivityPage(adapter, 'proj-1', [], join(dataDir, 'absent', 'bus.db'), undefined, 50);
    expect(page.entries).toEqual([]);
    expect(inode(join(dataDir, 'absent', 'bus.db')), 'a read-only feed read must not create a bus db').toBeNull();
  });
});
