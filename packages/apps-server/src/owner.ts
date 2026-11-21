/**
 * One server owns a data volume (DES-APPS-001 §7.3: "an app with actions runs as ONE server replica"). The action
 * store is a file with an in-process lock; a second server on the same volume could run one record twice and
 * overwrite the other's records. A node:sqlite BEGIN IMMEDIATE transaction on `<data>/.owner.lock` guards it:
 *
 * - The first server holds the transaction open for its lifetime; a second stops immediately, naming the owner
 *   from `<data>/.owner.json` (informational host/pid only, never used to decide ownership).
 * - Closing the database releases the lock. The kernel also releases it on exit or crash, including SIGKILL,
 *   so a restart needs no stale window or heartbeat.
 * - {@link Claim.held} is checked before every action-store step (see main.ts). A deleted or replaced lock file
 *   fences this server as soon as its path's device/inode differs from the stat taken just after locking.
 *
 * The volume needs a filesystem with working POSIX locks; filesystems without them (such as NFS without lockd)
 * are unsupported. Leave the lock file in place, including on release: unlinking it would let a contender lock a
 * different inode while the original is still held. One server per app with actions remains the deployment rule.
 */

import { type BigIntStats, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SiteError } from './site.js';

export interface Claim {
  /** Whether the database is still open and the lock path still names the file this server locked. */
  held(): boolean;
  release(): void;
}

export async function claimDataDir(dir: string, opts: { onLost?: () => void } = {}): Promise<Claim> {
  const lock = join(dir, '.owner.lock');
  const ownerFile = join(dir, '.owner.json');
  const owner = (): string => {
    try {
      const info = JSON.parse(readFileSync(ownerFile, 'utf8')) as { host?: unknown; pid?: unknown } | null;
      if (typeof info?.host === 'string' && typeof info.pid === 'number') return `${info.host}:${info.pid}`;
    } catch {
      // The winner may not have written its diagnostic yet; only SQLite decides who owns the volume.
    }
    return 'starting up';
  };

  let db: DatabaseSync | undefined;
  let identity: BigIntStats;
  try {
    db = new DatabaseSync(lock);
    // IMMEDIATE takes SQLite's single RESERVED lock in one step: of two servers starting together, exactly one gets
    // it and the other is refused at once. EXCLUSIVE has a second step (RESERVED, then EXCLUSIVE, which waits for
    // every SHARED lock to go): a racer holding SHARED for that instant made the winner's upgrade fail too, with a
    // zero busy timeout, so nobody owned the volume. Only owners take RESERVED, so it means "owned" here.
    db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    identity = statSync(lock, { bigint: true });
    writeFileSync(ownerFile, `${JSON.stringify({ host: hostname(), pid: process.pid })}\n`, { mode: 0o600 });
  } catch (err) {
    db?.close();
    // node:sqlite reports SQLITE_BUSY as errcode 5 (code is the generic ERR_SQLITE_ERROR).
    if ((err as { errcode?: number }).errcode === 5) {
      throw new SiteError(`another wicked-apps-server owns ${dir} (${owner()}): one server per app with actions; stop the other first`);
    }
    throw err;
  }

  const database = db;
  let open = true;
  let lost = false;
  return {
    held() {
      if (!open || lost) return false;
      try {
        const current = statSync(lock, { bigint: true });
        if (current.dev === identity.dev && current.ino === identity.ino) return true;
      } catch {
        // A missing or unreadable path cannot establish ownership.
      }
      lost = true;
      opts.onLost?.();
      return false;
    },
    release() {
      if (!open) return;
      database.close();
      open = false;
    },
  };
}
