// GET /runs/:id/files + GET /runs/:id/diff machinery (DES-FEEDBACK-002 CREW-1).
//
// The studio's in-app file & diff viewer cannot read the daemon host's filesystem, so the daemon
// serves the bytes — which is exactly why every path is contained FIRST against the same root set
// `POST /open` validates (`allowedRootsFor` + `isInsideRoot`, open-path.ts), every payload is
// capped, and git runs through `execCapped` with argv arrays only (never a shell string) and
// `--no-ext-diff` (a configured external diff driver must never execute here). Both routes are
// read-only by construction: `fs` reads and `git diff`/`git status` — zero write capability, a
// strictly smaller threat surface than `/open` handing the path to an OS opener.

import { promises as fsp } from 'node:fs';
import { execCapped } from '../core/exec.js';

/** File-content cap (DES-FEEDBACK-002 §3.3): past this, `content` holds the first 512 KB and
 *  `truncated: true` — the studio renders a labeled truncation banner, never a silent amputation. */
export const FILE_CONTENT_CAP_BYTES = 512 * 1024;

/** Binary sniff window: a NUL byte in the first 8 KB ⇒ `binary: true`, `content: ""` — the studio
 *  falls back to the external-open affordance rather than rendering mojibake. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/** Diff output cap (§3.3): past this the diff is cut at 1 MB and `truncated: true`. */
export const DIFF_OUTPUT_CAP_BYTES = 1024 * 1024;

/** `GET /runs/:id/files` 200 body (published as `RunFileContent` in wicked-crew-api-types). */
export interface CappedFileRead {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** The target exists but is not a regular file (directory, socket, …) — the route's 400, distinct
 *  from ENOENT's 404. Serving directory listings is explicitly out of scope (§3.3). */
export class NotARegularFileError extends Error {
  constructor(readonly path: string) {
    super(`not a regular file: ${path}`);
    this.name = 'NotARegularFileError';
  }
}

/**
 * Read at most `FILE_CONTENT_CAP_BYTES` of `target`. The open-then-fstat order (not stat-then-open)
 * closes the classic swap race: the size and the bytes come from the SAME open file description.
 * Callers must have contained `target` already — this function does filesystem work only.
 */
export async function readFileCapped(target: string): Promise<CappedFileRead> {
  const fh = await fsp.open(target, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotARegularFileError(target);
    const size = st.size;
    const toRead = Math.min(size, FILE_CONTENT_CAP_BYTES);
    const buf = Buffer.alloc(toRead);
    let off = 0;
    while (off < toRead) {
      const { bytesRead } = await fh.read(buf, off, toRead - off, off);
      if (bytesRead === 0) break; // file shrank underneath us — serve what exists
    off += bytesRead;
    }
    const got = buf.subarray(0, off);
    if (got.subarray(0, Math.min(off, BINARY_SNIFF_BYTES)).includes(0)) {
      return { content: '', size, truncated: false, binary: true };
    }
    return { content: got.toString('utf8'), size, truncated: size > FILE_CONTENT_CAP_BYTES, binary: false };
  } finally {
    await fh.close();
  }
}

/** `GET /runs/:id/diff` 200 body (published as `RunDiff` in wicked-crew-api-types). */
export interface WorktreeDiff {
  diff: string;
  truncated: boolean;
}

const GIT_TIMEOUT_MS = 10_000;

/** Git's ways of saying "there is nothing here to diff" — a real answer (`diff: ""`), not an
 *  error. Mirrors the git-history route's tolerance (routes.ts): a workdir that is not a repo, or
 *  a repo with no commits yet (`HEAD` unresolvable — every file is untracked and the untracked
 *  pass still runs for the commit-less case). */
function isEmptyDiffAnswer(msg: string): boolean {
  return (
    msg.includes('not a git repository') ||
    msg.includes('does not have any commits') ||
    msg.includes("ambiguous argument 'HEAD'") ||
    msg.includes('unknown revision')
  );
}

/**
 * The run's worktree diff against HEAD — staged + unstaged in one answer — with untracked files
 * appended as `git diff --no-index /dev/null <file>` all-addition hunks (§3.3: a run's *created*
 * files must diff as additions rather than vanish). `relPath`, when given, narrows both passes to
 * that one file; it is always a single argv element after `--` (the open-path rule — no shell
 * string is ever composed). The literal `/dev/null` is git's own cross-platform null-device
 * spelling (git special-cases it, including on Windows).
 */
export async function worktreeDiff(workdir: string, relPath?: string): Promise<WorktreeDiff> {
  const limit = relPath === undefined ? [] : ['--', relPath];
  let out = '';

  // Tracked changes (staged + unstaged): diff the worktree against HEAD.
  try {
    const { stdout } = await execCapped(
      'git',
      ['diff', '--no-color', '--no-ext-diff', 'HEAD', ...limit],
      { timeout: GIT_TIMEOUT_MS, cwd: workdir },
    );
    out = stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err; // git missing — the route's 500
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not a git repository')) return { diff: '', truncated: false };
    if (!isEmptyDiffAnswer(msg)) throw err;
    // No commits yet: tracked diff is vacuously empty; fall through to the untracked pass.
  }

  // Untracked files → all-addition hunks. `-z` (NUL separators, no quoting) + `-uall` (individual
  // files, never a collapsed `?? dir/` entry that --no-index could not diff).
  const { stdout: statusOut } = await execCapped(
    'git',
    ['status', '--porcelain', '-z', '-uall', ...limit],
    { timeout: GIT_TIMEOUT_MS, cwd: workdir },
  );
  const untracked = statusOut
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3));
  for (const file of untracked) {
    if (out.length > DIFF_OUTPUT_CAP_BYTES) break; // already past the cap — stop spawning
    try {
      const { stdout } = await execCapped(
        'git',
        ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file],
        { timeout: GIT_TIMEOUT_MS, cwd: workdir },
      );
      out += stdout;
    } catch (err) {
      // `--no-index` exits 1 WHEN THE FILES DIFFER — which is every hit here. The diff is still
      // on stdout; only a stdout-less failure is a real error.
      const stdout = (err as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && stdout.length > 0) out += stdout;
      else if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      else throw err;
    }
  }

  if (out.length > DIFF_OUTPUT_CAP_BYTES) {
    return { diff: out.slice(0, DIFF_OUTPUT_CAP_BYTES), truncated: true };
  }
  return { diff: out, truncated: false };
}
