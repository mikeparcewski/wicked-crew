/**
 * (crew#1885, codex-check on crew#1946) THE DELIVER SCRIPT'S READ KEY: the credential `POST /deliver/text` takes, kept
 * out of every process's argv.
 *
 * The engine runs the deliver unit as `bash -lc <script>`, so whatever the script text holds is on the shell's command
 * line, and another local user can read it with `ps` while the script runs. The sentinel nonce (`DELIVER_NONCE`,
 * crew#739) has to stay there (the engine reads it off the unit's command), so it is no credential. The read key is a
 * separate 32-byte value in a file only the daemon's user can read: `<crew state home>/deliver-keys/<id>.key`, the dir
 * 0700 and the file 0600, minted where the script is composed. The script names only the path; it reads the key with
 * the shell's own `read` and hands it to curl's stdin with the shell's own `printf`, so no program it starts carries
 * the key in its arguments. The route reads the key back from the file the run's deliver script names, never from
 * anything on a command line.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { crewStateHome } from '../projects/state-home.js';

/** The script variable naming the key file. */
export const DELIVER_KEY_FILE_VAR = 'DELIVER_KEY_FILE';

/** A key: 32 random bytes as lowercase hex. */
const KEY_RE = /^[0-9a-f]{64}$/;
/** A key file's name: a random id (no secret: it is on the command line), then `.key`. */
const KEY_NAME_RE = /^[0-9a-f]{32}\.key$/;

/** Where the keys live: `<crew state home>/deliver-keys`. */
export function deliverKeyDir(): string {
  return resolve(crewStateHome(), 'deliver-keys');
}

/**
 * Mint a key for one script composition and write it to a fresh file (0600, created exclusively, in a 0700 dir).
 * Returns the file's path, which the script names. Throws when the path could not be spliced into the script safely
 * (a quote or a line break in the state home), so a delivery never goes out without its key.
 */
export function mintDeliverKey(): string {
  const dir = deliverKeyDir();
  if (/['\n\r]/.test(dir)) throw new Error('the deliver read key: the crew state home path holds a quote or a line break');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  if (!isKeyPath(path)) return null;
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0) || st.size > 128) return null;
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
