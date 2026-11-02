/**
 * OPEN BENEATH A ROOT, FOLLOWING NO LINK BELOW IT (crew#1274; DES-CHAT-ARTIFACTS-001 §5.3 containment).
 *
 * The chat's per-turn block reads and writes under directories a run or a seat can change: a run's evidence root, the
 * chat's scratch root (the seat's own working directory), and a project's docs root. Checking a path (`realpath`,
 * `lstat`) and then opening it is a race: `O_NOFOLLOW` covers only the last component, so an ancestor directory
 * swapped for a link between the check and the open sends the open outside the root. Node has no `openat`, so this
 * module opens with the platform's own guarantee instead of a check:
 *
 *  - macOS: `O_NOFOLLOW_ANY` (Darwin ≥ 20): the open fails with ELOOP if ANY component of the path is a link. The
 *    root is passed as its real path (no link in it by construction), so the guarantee covers exactly the components
 *    below it.
 *  - Linux: a descriptor walk: the root is opened as a directory, then each component is opened through the magic
 *    link `/proc/self/fd/<dir>/<name>` with `O_NOFOLLOW` — the kernel resolves the magic link to the directory the
 *    descriptor holds (never a path re-read), so this is `openat(dir, name, O_NOFOLLOW)`.
 *  - Anywhere else (Windows): refused, with the reason. A brief or a copy is then simply not made there.
 *
 * The root itself is trusted: its ancestors belong to the daemon, and a run or a seat cannot rename the root (it can
 * write only inside it). Every component below it is checked on every open, by the kernel.
 *
 * Listing a directory is path-based on macOS (`/dev/fd/<n>` cannot be listed there), so a listing may be raced; that
 * is harmless here because nothing a listing returns is used except as a name to open beneath the root, and an open
 * through a swapped component fails.
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, opendirSync, readSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** `O_NOFOLLOW_ANY` from Darwin's `<sys/fcntl.h>`: Node does not export it, and passes open flags through. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

export type BeneathMode = 'darwin' | 'procfd' | 'unsupported';

let modeHeld: BeneathMode | null = null;
/** How this platform opens beneath a root. */
export function beneathMode(): BeneathMode {
  modeHeld ??= process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' && existsSync('/proc/self/fd') ? 'procfd' : 'unsupported';
  return modeHeld;
}

/** A test seam: called with the absolute path, just before the open of a path beneath a root. */
export const beneathTestHooks: { beforeOpen?: (absPath: string) => void } = {};

export class BeneathError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The components of a path relative to a root: no empty, `.`, `..`, absolute or NUL-bearing part. */
function partsOf(rel: string): string[] {
  const parts = rel.split('/');
  if (rel === '' || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0') || p.includes('\\'))) {
    throw new BeneathError('EINVAL', `not a path beneath a root: ${JSON.stringify(rel)}`);
  }
  return parts;
}

export interface OpenBeneathOptions {
  /** Open flags for the leaf (`O_RDONLY` by default). No link is followed at the leaf either way. */
  flags?: number;
  /** The mode a created file gets. */
  mode?: number;
}

/**
 * Open `rel` beneath the real directory `root`, following no link at or below it. Throws the open's own error (its
 * `code`: ELOOP for a link anywhere below the root, ENOENT, ENOTDIR, EEXIST…) or a {@link BeneathError}.
 */
export function openBeneath(root: string, rel: string, opts: OpenBeneathOptions = {}): number {
  const parts = partsOf(rel);
  const base = opts.flags ?? fsConstants.O_RDONLY;
  const abs = join(root, ...parts);
  beneathTestHooks.beforeOpen?.(abs);
  const mode = beneathMode();
  // Darwin refuses O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL); the latter covers the last component too.
  if (mode === 'darwin') return openSync(abs, base | DARWIN_O_NOFOLLOW_ANY, opts.mode);
  const leafFlags = base | (fsConstants.O_NOFOLLOW ?? 0);
  if (mode === 'procfd') {
    let dir = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      for (const p of parts.slice(0, -1)) {
        const next = openSync(`/proc/self/fd/${dir}/${p}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
        closeSync(dir);
        dir = next;
      }
      return openSync(`/proc/self/fd/${dir}/${parts.at(-1)!}`, leafFlags, opts.mode);
    } finally {
      closeSync(dir);
    }
  }
  throw new BeneathError('ENOTSUP', 'this platform cannot open a file without following links in its folders');
}

/** Read the regular file `rel` beneath `root`, at most `max` bytes (over = refused, never cut), non-blocking (a FIFO
 *  is refused, not waited on). Returns the bytes and the file's stats from the same descriptor. */
export function readBeneath(root: string, rel: string, max: number): { data: Buffer; st: Stats } {
  const fd = openBeneath(root, rel, { flags: fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) });
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new BeneathError('EFTYPE', 'not a regular file');
    if (st.size > max) throw new BeneathError('EFBIG', `over ${max} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { data: buf.subarray(0, off), st };
  } finally {
    closeSync(fd);
  }
}

/** What `rel` beneath `root` is (a regular file, a directory, something else), by its own descriptor; `null` if absent. */
export function statBeneath(root: string, rel: string): Stats | null {
  let fd: number;
  try {
    fd = openBeneath(root, rel, { flags: fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create the file `rel` beneath `root` exclusively (never through a link, never over an existing entry) with `data`. */
export function createBeneath(root: string, rel: string, data: Buffer, mode: number): void {
  const fd = openBeneath(root, rel, { flags: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode });
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
  } finally {
    closeSync(fd);
  }
}

/**
 * Make the directory `name` directly beneath `root` (one component: the root's own entry) and prove it is a real
 * directory, not a link, by opening it beneath the root.
 */
export function mkdirBeneath(root: string, name: string, mode = 0o700): void {
  partsOf(name);
  if (name.includes('/')) throw new BeneathError('EINVAL', 'one folder at a time');
  try {
    mkdirSync(join(root, name), { recursive: false, mode });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = statBeneath(root, name);
  if (st === null || !st.isDirectory()) throw new BeneathError('ENOTDIR', `${name} is not a real folder`);
}

/**
 * The names in the directory `rel` beneath `root` (`''` = the root itself), at most `max`. On Linux the listing is of
 * the directory the walk opened; on macOS it is by path after the directory was proven real (a raced listing yields
 * only names, which the caller opens beneath the root). Returns `null` when the directory cannot be listed.
 */
export function listBeneath(root: string, rel: string, max: number): { names: string[]; more: boolean } | null {
  let target = root;
  let fd: number | null = null;
  try {
    if (rel !== '') {
      fd = openBeneath(root, rel, { flags: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY });
      target = beneathMode() === 'procfd' ? `/proc/self/fd/${fd}` : join(root, ...partsOf(rel));
    }
    const names: string[] = [];
    let more = false;
    const handle = opendirSync(target);
    try {
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
        if (names.length >= max) {
          more = true;
          break;
        }
        names.push(e.name);
      }
    } finally {
      handle.closeSync();
    }
    return { names, more };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
