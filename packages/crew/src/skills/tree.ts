/**
 * File-tree primitives for the skills store: walk, hash, copy, remove — POSIX-relative paths,
 * sorted, symlinks never followed.
 *
 * Symlinks are skipped on every walk (never followed, never copied): a plugin tree is copied INTO
 * the daemon's root and later handed to worker spawns, so a link pointing outside the plugin would
 * turn "copy the plugin" into "copy whatever the link reaches". The live plugin carries none.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
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

/**
 * Every regular file under `root`, sorted by `rel`. `skipDir(rel)` prunes a subtree (rel is the
 * subtree's POSIX path from `root`); `SKIP_DIR_NAMES`/`SKIP_FILE_NAMES` always apply. A missing
 * `root` yields `[]` — callers treat optional plugin dirs (`schemas/`) as empty, not as errors.
 */
export function walkFiles(root: string, skipDir?: (rel: string) => boolean): FileRecord[] {
  const out: FileRecord[] = [];
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

/** Copy every record to `destRoot/<rel>`, creating parents. */
export function copyFiles(files: ReadonlyArray<FileRecord>, destRoot: string): void {
  for (const f of files) {
    const dest = join(destRoot, ...f.rel.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
}

/** Atomic text write (tmp + rename), creating parents — the settings-store discipline. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
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
