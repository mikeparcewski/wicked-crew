/**
 * File-tree primitives for the skills store: walk, hash, copy, remove — POSIX-relative paths,
 * sorted, symlinks never followed.
 *
 * NO-FOLLOW EVERYWHERE (design v3 §API; codex review of #480). A plugin tree is copied INTO the
 * daemon's root and later handed to worker spawns, so a link anywhere on a path the store reads or
 * writes would turn "copy the plugin" into "copy whatever the link reaches" and "write this skill
 * file" into "write wherever the link points". Therefore:
 *
 *   - `walkFiles` refuses a symlinked ROOT (the skill dir itself replaced by a link) and skips
 *     symlink entries (never followed, never copied, never hashed);
 *   - `copyFiles` lstat-walks every destination path and refuses a symlink component before it
 *     creates a parent or writes a byte (`assertNoSymlinkComponents`);
 *   - `writeFileAtomic` refuses a symlink at the target, opens its temp file with `O_EXCL`
 *     (`'wx'` — fails on ANY pre-existing entry, a pre-planted symlink included) under an
 *     unpredictable name, and preserves the target's mode bits (an executable support script
 *     stays executable across an in-place edit or a replace).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** One regular file: `rel` is POSIX-relative to the walk root, `abs` its on-disk path. */
export interface FileRecord {
  rel: string;
  abs: string;
}

/** Directory names never walked (build caches, vendored deps, the per-baseline `uv sync` env). */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['__pycache__', 'node_modules', '.venv']);
/** File names never copied into the root (Finder noise). */
export const SKIP_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store']);

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** A path the store would have to FOLLOW a symlink to reach — refused, never judged lexically. */
export class SymlinkComponentError extends Error {
  constructor(
    readonly path: string,
    readonly component: string,
  ) {
    super(`${path} crosses a symlink at ${component} — the skills root never follows links`);
    this.name = 'SymlinkComponentError';
  }
}

/**
 * `join(root, ...segments)` after an lstat walk that refuses a symlink at ANY component — the
 * leaf included. A component that does not exist yet ends the walk (a not-yet-written leaf, or
 * its new parent dirs — the write creates them). Any filesystem error other than ENOENT
 * propagates: an unreadable component is not judged lexically. `root` itself is not walked — the
 * caller decides what its root is (the store walks from the SKILLS root down, so a skill dir
 * replaced by a link is a component, not a root).
 */
export function assertNoSymlinkComponents(root: string, segments: ReadonlyArray<string>): string {
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
    if (st.isSymbolicLink()) throw new SymlinkComponentError(segments.join('/'), seg);
  }
  return join(root, ...segments);
}

/**
 * Every regular file under `root`, sorted by `rel`. `skipDir(rel)` prunes a subtree (rel is the
 * subtree's POSIX path from `root`); `SKIP_DIR_NAMES`/`SKIP_FILE_NAMES` always apply. A missing
 * `root` yields `[]` — callers treat optional plugin dirs (`schemas/`) as empty, not as errors. A
 * `root` that IS a symlink is refused: `readdirSync` would follow it, and "list this skill's own
 * files" must never enumerate a tree outside the store.
 */
export function walkFiles(root: string, skipDir?: (rel: string) => boolean): FileRecord[] {
  const out: FileRecord[] = [];
  try {
    if (lstatSync(root).isSymbolicLink()) throw new SymlinkComponentError(root, root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  const visit = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && relDir === '') return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (skipDir !== undefined && skipDir(rel)) continue;
        visit(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (SKIP_FILE_NAMES.has(entry.name)) continue;
        out.push({ rel, abs: join(dir, entry.name) });
      }
    }
  };
  visit(root, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * One hash over a file set: sorted relative paths + content digests (`rel \0 sha256(content) \n`
 * per file). Two trees with the same relative layout and bytes hash equal wherever they live —
 * which is what lets a baseline snapshot and the effective copy be compared by hash alone.
 */
export function hashFileSet(files: ReadonlyArray<FileRecord>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel);
    h.update('\0');
    h.update(sha256Hex(readFileSync(f.abs)));
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * Copy every record to `destRoot/<rel>`, creating parents — after refusing a symlink at any
 * destination component (a pre-planted link under the effective root would otherwise redirect
 * the copy). `copyFileSync` carries the source mode bits (libuv `copyfile`), so an executable
 * baseline script lands executable.
 */
export function copyFiles(files: ReadonlyArray<FileRecord>, destRoot: string): void {
  for (const f of files) {
    const dest = assertNoSymlinkComponents(destRoot, f.rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
}

export interface AtomicWriteOptions {
  /** Mode bits for a NEW file; an existing regular file's mode is preserved regardless. */
  mode?: number;
}

/**
 * Atomic write (tmp + rename), creating parents — the settings-store discipline, hardened:
 *
 *   - the target is lstat'ed: a symlink there is refused (the rename would replace the link,
 *     but the caller's containment already forbids links, and a write "over" one is never what
 *     the file manager meant);
 *   - the temp file is opened `'wx'` (`O_CREAT | O_EXCL`): POSIX fails that open on ANY existing
 *     entry — a symlink included, regardless of where it points — so a pre-planted temp symlink
 *     cannot redirect the bytes; the name carries 64 random bits so it cannot be pre-planted by
 *     guessing either;
 *   - the target's mode bits survive (an in-place edit of an executable support script keeps
 *     it executable); a new file takes `opts.mode` or the platform default.
 */
export function writeFileAtomic(path: string, content: string | Buffer, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = opts.mode;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new SymlinkComponentError(path, path);
    if (st.isFile()) mode = st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  const fd = mode === undefined ? openSync(tmp, 'wx') : openSync(tmp, 'wx', mode);
  try {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Remove the records, then prune directories left empty between each file and `upTo`
 * (exclusive). Never removes a non-empty directory — a nested skill living under a disabled
 * parent's directory stays exactly where it is.
 */
export function removeFiles(files: ReadonlyArray<FileRecord>, upTo: string): void {
  for (const f of files) rmSync(f.abs, { force: true });
  for (const f of files) pruneEmptyDirs(dirname(f.abs), upTo);
}

/** Remove `dir` and its ancestors while they are empty, stopping at `upTo` (which is kept). */
export function pruneEmptyDirs(dir: string, upTo: string): void {
  let cur = dir;
  for (;;) {
    const rel = relative(upTo, cur);
    if (rel === '' || rel.startsWith('..')) return;
    try {
      rmdirSync(cur); // ENOTEMPTY / ENOENT both end the climb
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Every directory under `root` (root included, deepest first), symlinks never followed. `strict`
 * propagates every error but ENOENT (an entry that vanished mid-walk); the lenient mode (the
 * force-remove's) skips what it cannot list — `rmSync` reports what matters there.
 */
function directoriesUnder(root: string, strict: boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (strict && !isEnoent(err)) throw err;
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      visit(join(dir, entry.name));
    }
    out.push(dir);
  };
  try {
    if (!lstatSync(root).isDirectory()) return out;
  } catch (err) {
    if (strict && !isEnoent(err)) throw err;
    return out;
  }
  visit(root);
  return out;
}

const WRITE_BITS = 0o222;

/**
 * Strip the write bits from every directory and file under `root` — the shared per-baseline
 * `.venv` is read-only by contract (design v3 §4): a worker's `uv run` from a snapshot must not
 * install into, or remove from, an env every other snapshot links; a published snapshot is locked
 * the same way (immutable by contract, verified by hash). Files first, then directories (deepest
 * first), so the walk never has to re-open a directory it already closed. A permission failure
 * PROPAGATES (codex round 2 on #480: "silently swallows permission failures while claiming to
 * lock") — a tree this cannot lock is not locked, and the caller decides what that means (the
 * store treats an unlockable env as a failed provisioning, blocking the publish). Only an entry
 * that vanished mid-walk (ENOENT) is tolerated. A no-op on platforms without POSIX modes.
 */
export function makeTreeReadOnly(root: string): void {
  if (process.platform === 'win32') return;
  for (const dir of directoriesUnder(root, true)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const p = join(dir, entry.name);
      try {
        chmodSync(p, lstatSync(p).mode & 0o777 & ~WRITE_BITS);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    try {
      chmodSync(dir, lstatSync(dir).mode & 0o777 & ~WRITE_BITS);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
}

/**
 * `rmSync(root, { recursive: true, force: true })` that also removes a tree `makeTreeReadOnly`
 * locked — OR a partial env whose lock FAILED, which can leave an UNLISTABLE directory (a `uv sync`
 * that produced a `0o000`/`0o111` dir the lock choked on; codex round 3). Each directory has its
 * owner `rwx` restored TOP-DOWN, before it is enumerated, so an unlistable dir becomes traversable
 * and removable (unlinking an entry needs a writable, listable parent, whatever the entry's own
 * mode). A missing root is a no-op.
 */
export function removeTreeForce(root: string): void {
  restoreDirPermsTopDown(root);
  rmSync(root, { recursive: true, force: true });
}

/** Give every directory under `dir` (`dir` included, symlinks never followed) owner `rwx` — restored
 *  before the dir is read, so even a `0o000` directory can be enumerated and removed. Best-effort. */
function restoreDirPermsTopDown(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return; // gone already
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  try {
    chmodSync(dir, (st.mode & 0o777) | 0o700);
  } catch {
    /* not ours to chmod — rmSync below reports what matters */
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // still unreadable (not ours) — rmSync reports it
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    restoreDirPermsTopDown(join(dir, entry.name));
  }
}

/** Unlink one path without following it (a link is removed, its target untouched). */
export function unlinkNoFollow(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
