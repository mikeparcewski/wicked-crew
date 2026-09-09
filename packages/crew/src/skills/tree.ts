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
 *     symlink entries (never followed, never copied, never hashed); `walkTree` is the variant a
 *     VERIFICATION uses — it ENUMERATES link entries with their link text (still never followed)
 *     so an injected link cannot hide from `current`'s hash (codex round 5);
 *   - `copyFiles` PREFLIGHTS every destination — each `rel` must be a safe relative path (no `..`,
 *     `.`, empty or separator-carrying segment, no absolute/drive prefix, no NUL:
 *     `assertSafeRelSegments`) and symlink-free (`assertNoSymlinkComponents`) — BEFORE it creates a
 *     parent or writes a byte, independent of where the record came from (codex round 4: a
 *     manifest-sourced skill name became a copilot-view path `views/…/<name>/SKILL.md`, and a
 *     `../…` name would have joined out of the staging dir). A refused record writes NOTHING —
 *     not the records ahead of it either;
 *   - `writeFileAtomic` refuses a symlink at the target, opens its temp file with `O_EXCL`
 *     (fails on ANY pre-existing entry, a pre-planted symlink included) and `O_NOFOLLOW` under an
 *     unpredictable name, and preserves the target's mode bits (an executable support script
 *     stays executable across an in-place edit or a replace).
 *
 * # TOCTOU discipline inside the skills root (design v3.5 §3; codex round 8)
 *
 * The lstat walk is necessary, not sufficient: every file open inside the root uses `O_NOFOLLOW`
 * where the platform has it (`readFileNoFollow`, `copyFileNoFollow`, `writeFileAtomic`'s temp
 * file), and the lstat-then-open pattern is closed EVERYWHERE — Windows has no `O_NOFOLLOW` — with a
 * post-open identity check (`fstat` dev/ino against the lstat result: the entry opened IS the entry
 * the walk judged); copies read their SOURCE through such an open, never by path
 * (`copyFileSync(path)` follows a source swapped for a link between enumeration and copy); a staged
 * tree is re-walked (lstat) and re-hashed AFTER the copy and BEFORE the rename into place
 * (store.ts `stagedTreeProblem`, `captureBaseline`, `publishSerialized`). Residual, documented: a
 * directory component swapped between the walk and the rename by another writer with access to the
 * crew-owned state home — mitigated by the single-writer daemon and the post-operation verification,
 * not eliminated.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { ATOMIC_TMP_INFIX } from './root-names.js';

/** `O_NOFOLLOW` where the platform has it (POSIX); `0` on Windows, where the post-open identity check alone closes the gap. */
const O_NOFOLLOW: number = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

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

/** A relative path whose SHAPE could join out of its root (`..`, an absolute piece, a separator in a
 *  segment, a NUL) — refused before any lstat, whatever produced it. */
export class UnsafePathSegmentError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`unsafe path ${JSON.stringify(path)}: ${reason} — the joined path must stay inside its root`);
    this.name = 'UnsafePathSegmentError';
  }
}

/**
 * Why ONE path component is not a safe segment, or `null`. A segment may not be empty, `.` or `..`,
 * may not carry a separator (`/` or `\`), a NUL, or a drive prefix (`C:`). The ONE rule every
 * joined component in the store goes through (contain.ts, `copyFiles`, the view generator).
 */
export function unsafeSegmentReason(seg: string): string | null {
  if (seg === '' || seg === '.' || seg === '..') return `segment ${JSON.stringify(seg)}`;
  if (seg.includes('/') || seg.includes('\\')) return `segment ${JSON.stringify(seg)} carries a separator`;
  if (seg.includes('\0')) return 'NUL byte';
  if (/^[A-Za-z]:/.test(seg)) return `segment ${JSON.stringify(seg)} carries a drive prefix`;
  return null;
}

/**
 * Split a POSIX-relative path into segments, refusing anything that could escape: empty, absolute
 * (`/…`), drive-prefixed, backslashes, NUL, and a `.` / `..` / empty segment. Throws
 * `UnsafePathSegmentError`. Lexical only — the caller walks the result for symlinks.
 */
export function assertSafeRelSegments(rel: string): string[] {
  if (rel === '') throw new UnsafePathSegmentError(rel, 'empty — the root itself is not a file');
  if (rel.includes('\0')) throw new UnsafePathSegmentError(rel, 'NUL byte');
  if (rel.includes('\\')) throw new UnsafePathSegmentError(rel, 'backslash — paths are POSIX');
  if (rel.startsWith('/')) throw new UnsafePathSegmentError(rel, 'absolute');
  if (/^[A-Za-z]:/.test(rel)) throw new UnsafePathSegmentError(rel, 'drive prefix');
  const segments = rel.split('/');
  for (const seg of segments) {
    const why = unsafeSegmentReason(seg);
    if (why !== null) throw new UnsafePathSegmentError(rel, why);
  }
  return segments;
}

/**
 * `join(root, ...segments)` after an lstat walk that refuses a symlink at ANY component — the
 * leaf included. A component that does not exist yet ends the walk (a not-yet-written leaf, or
 * its new parent dirs — the write creates them); so does a component whose parent turned out to
 * be a REGULAR FILE (ENOTDIR — nothing below a file exists, and no link can be crossed through
 * one; whether the caller may write there is the caller's preflight, `containedDestinations`).
 * Any other filesystem error propagates: an unreadable component is not judged lexically. `root`
 * itself is not walked — the caller decides what its root is (the store walks from the SKILLS
 * root down, so a skill dir replaced by a link is a component, not a root).
 */
export function assertNoSymlinkComponents(root: string, segments: ReadonlyArray<string>): string {
  // The walk joins each segment onto its parent, so a `..` (or a separator smuggled inside a
  // segment) would climb out of `root` before any lstat ran — refused lexically first, whatever
  // the caller already checked (codex round 4: `copyFiles` used to trust its records' shape).
  for (const seg of segments) {
    const why = unsafeSegmentReason(seg);
    if (why !== null) throw new UnsafePathSegmentError(segments.join('/'), why);
  }
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
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

/** One symlink entry: `rel` POSIX-relative to the walk root, `target` its link text as read (never followed). */
export interface LinkRecord {
  rel: string;
  abs: string;
  target: string;
}

/** A whole tree, links ENUMERATED (not followed, not skipped): what a snapshot verification must see. */
export interface TreeListing {
  files: FileRecord[];
  links: LinkRecord[];
}

/**
 * Every regular file AND every symlink under `root`, sorted by `rel` — the walk `walkFiles` does,
 * except that a symlink entry is LISTED with its link text instead of skipped (codex round 5 on
 * #480: a verification that skips links leaves an injected outside-pointing link invisible to the
 * hash). A link is never followed and never descended; `SKIP_DIR_NAMES` / `SKIP_FILE_NAMES` still
 * prune real directories and files, but a LINK bearing one of those names is listed too (the
 * snapshot's `.venv` link is exactly that). A symlinked `root` is refused like `walkFiles`.
 * `skipDir(rel)` prunes a real subtree the way `walkFiles` does (the bundle walk prunes the
 * `scripts/` dev tooling with it — a link INSIDE a pruned subtree is never reached, and never
 * copied either).
 */
export function walkTree(root: string, skipDir?: (rel: string) => boolean): TreeListing {
  const files: FileRecord[] = [];
  const links: LinkRecord[] = [];
  try {
    if (lstatSync(root).isSymbolicLink()) throw new SymlinkComponentError(root, root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files, links };
    throw err;
  }
  const visit = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ rel, abs, target: readlinkSync(abs) });
      } else if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (skipDir !== undefined && skipDir(rel)) continue;
        visit(abs, rel);
      } else if (entry.isFile()) {
        if (SKIP_FILE_NAMES.has(entry.name)) continue;
        files.push({ rel, abs });
      }
    }
  };
  visit(root, '');
  const byRel = <T extends { rel: string }>(a: T, b: T): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  files.sort(byRel);
  links.sort(byRel);
  return { files, links };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The leaf changed identity between the lstat and the open (a link swapped in, a file replaced) — refused, never read or copied (v3.5 §3). */
export class EntrySwappedError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not the entry the walk judged — it changed between lstat and open (a symlink swapped in, or the file replaced); refused`);
    this.name = 'EntrySwappedError';
  }
}

/**
 * Open the REGULAR FILE at `path` for reading without following a symlink at the leaf (`O_NOFOLLOW`
 * where available), and prove the opened descriptor IS the entry lstat saw (dev/ino equal, a regular
 * file) — the Windows close of the lstat-then-open gap, applied everywhere (v3.5 §3). Throws
 * `SymlinkComponentError` for a link at the leaf, `EntrySwappedError` when the identity moved, and
 * the filesystem's own error otherwise (ENOENT propagates). Answers the descriptor and its stats.
 */
export function openRegularNoFollow(path: string): { fd: number; stat: Stats } {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new SymlinkComponentError(path, path);
  if (!before.isFile()) throw new EntrySwappedError(path);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    // ELOOP: a link stood there by the time we opened — the swap this discipline exists for.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new EntrySwappedError(path);
    throw err;
  }
  let stat: Stats;
  try {
    stat = fstatSync(fd);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
    closeSync(fd);
    throw new EntrySwappedError(path);
  }
  return { fd, stat };
}

/** The bytes of the regular file at `path`, read through an `O_NOFOLLOW` open with the identity check (`openRegularNoFollow`). */
export function readFileNoFollow(path: string): Buffer {
  const { fd } = openRegularNoFollow(path);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy one regular file `src` → `dest`: the source is read through `openRegularNoFollow` (never by
 * path — a source swapped for a link between enumeration and copy is refused), the destination is
 * created `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with the source's mode bits (an executable
 * baseline script lands executable), so a pre-planted destination entry — a link included — fails
 * the open instead of being written through.
 */
export function copyFileNoFollow(src: string, dest: string): void {
  const { fd: inFd, stat } = openRegularNoFollow(src);
  let buf: Buffer;
  try {
    buf = readFileSync(inFd);
  } finally {
    closeSync(inFd);
  }
  const outFd = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, stat.mode & 0o777);
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(outFd, buf, off, buf.length - off);
  } catch (err) {
    closeSync(outFd);
    rmSync(dest, { force: true });
    throw err;
  }
  closeSync(outFd);
}

/**
 * One hash over a file set: sorted relative paths + content digests (`rel \0 sha256(content) \n`
 * per file). Two trees with the same relative layout and bytes hash equal wherever they live —
 * which is what lets a baseline snapshot and the effective copy be compared by hash alone.
 */
export function hashFileSet(files: ReadonlyArray<FileRecord>): string {
  return hashTree(files, []);
}

/**
 * One hash over a file set AND its symlink entries: the files as `hashFileSet` spells them, then
 * every link as `rel \0 -> \0 <link text> \n` (sorted). With no links this IS `hashFileSet`, so a
 * link-free tree hashes as before; a link added, removed or re-pointed changes the hash — which is
 * what lets `current` verification refuse an injected link (codex round 5). Only `rel` and the link
 * TEXT enter the hash, never what the link reaches: two trees with the same layout, bytes and link
 * texts hash equal wherever they live.
 */
export function hashTree(files: ReadonlyArray<FileRecord>, links: ReadonlyArray<Pick<LinkRecord, 'rel' | 'target'>>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel);
    h.update('\0');
    h.update(sha256Hex(readFileNoFollow(f.abs)));
    h.update('\n');
  }
  for (const l of [...links].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(l.rel);
    h.update('\0->\0');
    h.update(l.target);
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * Copy every record to `destRoot/<rel>`, creating parents. EVERY destination is preflighted
 * first — the shape (`assertSafeRelSegments`: a `..`, an absolute or drive-prefixed piece, a
 * separator inside a segment, a NUL is refused, whatever produced the record) and the walk
 * (`assertNoSymlinkComponents`: a pre-planted link under the destination would redirect the
 * copy) — and only then does the first byte move, so a refused record leaves NOTHING written
 * (codex round 4: the per-record check used to run only when the record was reached, after the
 * ones ahead of it had landed). Each file goes through `copyFileNoFollow` (v3.5 §3): the source is
 * read through an `O_NOFOLLOW` open with the identity check — a source swapped for a symlink between
 * enumeration and copy is refused — and the destination is created `O_EXCL | O_NOFOLLOW` with the
 * source's mode bits, so an executable baseline script lands executable.
 */
export function copyFiles(files: ReadonlyArray<FileRecord>, destRoot: string): void {
  const plan: Array<{ src: string; dest: string }> = [];
  for (const f of files) {
    const dest = assertNoSymlinkComponents(destRoot, assertSafeRelSegments(f.rel));
    plan.push({ src: f.abs, dest });
  }
  for (const { src, dest } of plan) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileNoFollow(src, dest);
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
 *   - the temp file is opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`: POSIX fails that open on ANY existing
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
  const tmp = `${path}${ATOMIC_TMP_INFIX}${randomBytes(8).toString('hex')}`;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
  const fd = mode === undefined ? openSync(tmp, flags) : openSync(tmp, flags, mode);
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
