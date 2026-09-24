/**
 * THE CREW BUS HANDLE (DES-TEAMING-002 T0) — one long-lived better-sqlite3 connection per bus file
 * per process, opened once and never closed.
 *
 * Since T0 the daemon's bus file is shared by TWO SQLite libraries in one process: crew's seams
 * (wicked-bus → better-sqlite3) and the engine (wicked-core-ts → its bundled rusqlite), which crew
 * hands the same file as `WICKED_BUS_DB` on every boot. SQLite's file locks are POSIX advisory
 * locks, owned by the process and released for the WHOLE process the moment ANY descriptor for
 * the file is closed. One library defers such a close while its own sibling connections hold
 * locks; the other library knows nothing about them. So a connection either library opens and
 * later closes can release the locks the other holds, and the next external `wicked-bus emit`
 * then wins EXCLUSIVE on its own close, checkpoints and unlinks `-wal`/`-shm` under the survivors
 * (F-E2E-021: "database disk image is malformed" on every poll, for the life of the daemon).
 *
 * The rule both sides now follow: each library holds its connection to the bus file for the life
 * of the process and never opens-and-closes one. The engine's side is `BusDb::shared` in
 * wicked-core. Crew's side is this handle: ad-hoc bus reads (the project activity feed) go through
 * it instead of a per-request open/close, and the daemon opens it at boot BEFORE the engine spawns
 * (the boot probe in `cli/index.ts`), so crew's library always has a connection holding its locks.
 * There is deliberately no close.
 *
 * The better-sqlite3 module is the INSTANCE wicked-bus itself loads (resolved from wicked-bus's own
 * entry — the walk its `lib/db.js` `require('better-sqlite3')` takes), so this handle and the seams
 * are one SQLite library, never two.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** The better-sqlite3 surface the handle uses (typed locally — crew reaches it through wicked-bus). */
export interface BusSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  pragma(sql: string): unknown;
}
type SqliteCtor = new (path: string, opts?: { fileMustExist?: boolean }) => BusSqlite;

let sqliteCtor: SqliteCtor | null | undefined;
function sqlite(): SqliteCtor | null {
  if (sqliteCtor === undefined) {
    try {
      const busEntry = createRequire(import.meta.url).resolve('wicked-bus');
      sqliteCtor = createRequire(busEntry)('better-sqlite3') as SqliteCtor;
    } catch {
      sqliteCtor = null;
    }
  }
  return sqliteCtor;
}

const handles = new Map<string, BusSqlite>();
/** Handles whose file was replaced under the same path: kept referenced so they are never closed. */
const retired: BusSqlite[] = [];
let opens = 0;

/**
 * The process-wide handle to the bus db at `dbPath`. `create: true` (the boot probe) creates the
 * file and sets the bus's WAL mode; `create: false` (a read route) needs the file to exist.
 * Throws when the db cannot be opened — callers decide what that means.
 */
export function crewBusHandle(dbPath: string, opts: { create: boolean }): BusSqlite {
  const key = resolve(dbPath);
  const cached = handles.get(key);
  // A bus file deleted and recreated under the same path is a different database.
  if (cached !== undefined && existsSync(key)) return cached;
  const Database = sqlite();
  if (Database === null) throw new Error('better-sqlite3 is not resolvable from wicked-bus');
  const db = new Database(key, opts.create ? {} : { fileMustExist: true });
  try {
    // wicked-bus's own PRAGMAs (lib/db.js): WAL + a busy timeout.
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
  } catch (err) {
    // Opened but unusable: keep it referenced (a collected connection is a closed one) and fail.
    retired.push(db);
    throw err;
  }
  if (cached !== undefined) retired.push(cached);
  handles.set(key, db);
  opens += 1;
  return db;
}

/** How many bus connections this process has opened through the handle (tests: exactly one). */
export function crewBusHandleOpens(): number {
  return opens;
}
