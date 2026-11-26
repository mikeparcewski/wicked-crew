/**
 * (crew#1885, codex-check on crew#1946) THE DELIVER SCRIPT'S READ KEY: the credential `POST /deliver/text` takes, kept
 * out of every process's argv.
 *
 * The engine runs the deliver unit as `bash -lc <script>`, so whatever the script text holds is on the shell's command
 * line, and another local user can read it with `ps` while the script runs. The sentinel nonce (`DELIVER_NONCE`,
 * crew#739) has to stay there (the engine reads it off the unit's command), so it is no credential. The read key is a
 * separate 32-byte value in a file only the daemon's user can read: `<crew state home>/artifacts/deliver-keys/<id>.key`,
 * the dir 0700 and the file 0600, minted where the script is composed. `artifacts` is a registered, crew-owned top-level
 * entry no worker may read (`tests/fixtures/state-home-subtrees.json`), so the dir adds no unregistered entry for the
 * engine's state-home preflight to refuse launches over (codex r2). The script names only the path, turns tracing off,
 * reads the key with the shell's `builtin read` and hands it to curl's stdin with `builtin printf` (a function a login
 * profile defines never sees it), so no program it starts carries the key in its arguments. The route reads the key
 * back from this dir, by the id the run's deliver script names, never from anything on a command line.
 *
 * Windows: the modes below are POSIX. On Windows the key file has the state home's own ACL, the boundary every other
 * private thing in that home already relies on (`core.db`, the chats, the decision ledger, the MCP registry).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { crewStateHome } from '../projects/state-home.js';

/** The script variable naming the key file. */
export const DELIVER_KEY_FILE_VAR = 'DELIVER_KEY_FILE';

/** A key: 32 random bytes as lowercase hex. */
const KEY_RE = /^[0-9a-f]{64}$/;
/** A key file's name: a random id (no secret: it is on the command line), then `.key`. */
const KEY_NAME_RE = /^[0-9a-f]{32}\.key$/;
/** A key file's id: the hex of its name. */
const KEY_ID_RE = /^[0-9a-f]{32}$/;

/** Where the keys live: `<crew state home>/artifacts/deliver-keys`. */
export function deliverKeyDir(): string {
  return resolve(crewStateHome(), 'artifacts', 'deliver-keys');
}

/** The key file of id `id` (the 32 hex digits of its name) in {@link deliverKeyDir}, or null for any other id. */
export function deliverKeyPathOf(id: string): string | null {
  return KEY_ID_RE.test(id) ? join(deliverKeyDir(), `${id}.key`) : null;
}

const POSIX = process.platform !== 'win32';
const ownUid = (): number | null => (POSIX && typeof process.getuid === 'function' ? process.getuid() : null);

/** Whether the key dir, and `artifacts` above it, are real directories (no symlink) the daemon's user owns, the key
 *  dir open to that user alone (codex r2: an existing dir's provenance is checked, never assumed). */
function keyDirSafe(): boolean {
  const dir = deliverKeyDir();
  try {
    for (const d of [dirname(dir), dir]) {
      const st = lstatSync(d);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      const uid = ownUid();
      if (uid !== null && st.uid !== uid) return false;
    }
    // The key dir closed to others; `artifacts` above it writable by its owner alone (no one else can move it aside).
    return !POSIX || ((lstatSync(dir).mode & 0o077) === 0 && (lstatSync(dirname(dir)).mode & 0o022) === 0);
  } catch {
    return false;
  }
}

/**
 * Mint a key for one script composition and write it to a fresh file (0600, created exclusively, in a 0700 dir).
 * Returns the file's path, which the script names. Throws when the dir is not crew's own private dir, so a delivery
 * never goes out with a key another user could read.
 */
export function mintDeliverKey(): string {
  const dir = deliverKeyDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) {
    const st = lstatSync(dir);
    // Created by an earlier build or by hand with a wider mode: narrowed, when it is ours to narrow.
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === ownUid() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  if (!keyDirSafe()) throw new Error("the deliver read key: the key dir under the crew state home is not the daemon user's own private dir");
  const path = join(dir, `${randomBytes(16).toString('hex')}.key`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, `${randomBytes(32).toString('hex')}\n`);
  } finally {
    closeSync(fd);
  }
  return path;
}

/** Whether `path` names a key file in {@link deliverKeyDir} (a composed script's, nothing else). */
function isKeyPath(path: string): boolean {
  const abs = resolve(path);
  return abs === path && dirname(abs) === deliverKeyDir() && KEY_NAME_RE.test(abs.slice(dirname(abs).length + 1));
}

/** The key in `path`, or null: a key file of crew's dir, a regular file (no symlink) only its owner can read. */
export function readDeliverKey(path: string): string | null {
  if (!isKeyPath(path) || !keyDirSafe()) return null;
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || (POSIX && (st.mode & 0o077) !== 0) || (uid !== null && st.uid !== uid) || st.size > 128) return null;
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const key = buf.subarray(0, n).toString('utf8').trim();
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Whether `key` is the one in the key file `path`, compared in constant time. Logs nothing. */
export function deliverKeyMatches(path: string, key: string): boolean {
  const held = readDeliverKey(path);
  if (held === null) return false;
  const a = Buffer.from(held, 'utf8');
  const b = Buffer.from(key.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Remove a key file once its script has exited (a post-hoc delivery's). Only crew's own key files; never throws. */
export function dropDeliverKey(path: string): void {
  if (!isKeyPath(path)) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
