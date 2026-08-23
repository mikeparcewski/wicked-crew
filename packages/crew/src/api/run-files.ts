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

// ── Diff base (DES-UX-001 §8.1, CREW-UX-1) ─────────────────────────────────────────────────────

/** `?base=merge-base` — the one non-ref literal: diff against `git merge-base <default-branch>
 *  HEAD`, i.e. the run branch's fork point, so committed run work is visible (§8.1). */
export const MERGE_BASE_LITERAL = 'merge-base';

/** `base` is not a plain ref — a flag, a path, a revision range, a separator. Rejected BEFORE any
 *  git process sees it: the query parameter is a diff baseline, never a command surface (§8.1). */
export class InvalidDiffBaseError extends Error {
  constructor(readonly base: string) {
    super(
      '`base` must be a plain git ref (branch, tag, or commit id) — ' +
        'flags, paths, revision ranges, and separators are rejected',
    );
    this.name = 'InvalidDiffBaseError';
  }
}

/** `base` is well-formed but does not resolve to a commit inside the run's repo — containment:
 *  a ref from another repo (or thin air) is a 400, never a git error surfaced as a 500. */
export class UnresolvableDiffBaseError extends Error {
  constructor(readonly base: string, detail: string) {
    super(`unresolvable \`base\`: ${detail}`);
    this.name = 'UnresolvableDiffBaseError';
  }
}

/** A plain ref: git's own charset for the safe subset — alphanumeric start (excludes `-flag`,
 *  `.hidden`, `/abs/path`), then word/dot/slash/dash. `..` (ranges AND traversal), `~`/`^`/`@{}`
 *  (rev operators), `:`, whitespace, and `;` are all outside the charset or explicitly banned. */
const PLAIN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
export function isPlainRef(base: string): boolean {
  return PLAIN_REF_RE.test(base) && !base.includes('..') && !base.endsWith('/');
}

/** One contained git read: argv array (never a shell string), capped, cwd-scoped to the run's
 *  workdir. Returns trimmed stdout, or `null` when git answered "no" (unresolvable ref, no
 *  merge base, …). Rethrows ENOENT (git missing) and "not a git repository" untouched. */
async function gitQuery(workdir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execCapped('git', args, { timeout: GIT_TIMEOUT_MS, cwd: workdir });
    return stdout.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not a git repository')) throw err;
    return null;
  }
}

/** SHA shapes rev-parse may emit (SHA-1 today, SHA-256 repos exist). Anything else is treated as
 *  "did not resolve" — the resolved value is what reaches `git diff`, never the caller's text. */
const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * Resolve `?base=` to a commit SHA inside the run's repo, or throw the route's named 400s.
 * Two accepted spellings (§8.1): the literal `merge-base` → `git merge-base <default-branch>
 * HEAD`; or a plain ref that `git rev-parse --verify` resolves IN THIS repo. Everything git
 * ultimately diffs against is the resolved SHA — the raw parameter never reaches `git diff`,
 * and `--end-of-options` keeps even a validated ref from ever parsing as a flag.
 */
async function resolveDiffBase(workdir: string, base: string): Promise<string> {
  if (base === MERGE_BASE_LITERAL) {
    // Default branch: origin's HEAD when the repo has one, else local main/master.
    let branch: string | null = null;
    const symref = await gitQuery(workdir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (symref !== null && symref.startsWith('refs/remotes/')) {
      branch = symref.slice('refs/remotes/'.length);
    } else {
      for (const cand of ['main', 'master']) {
        if ((await gitQuery(workdir, ['rev-parse', '--verify', `refs/heads/${cand}`])) !== null) {
          branch = cand;
          break;
        }
      }
    }
    if (branch === null) {
      throw new UnresolvableDiffBaseError(
        base,
        'no default branch found in this repo to merge-base against',
      );
    }
    const sha = await gitQuery(workdir, ['merge-base', '--end-of-options', branch, 'HEAD']);
    if (sha === null || !COMMIT_SHA_RE.test(sha)) {
      throw new UnresolvableDiffBaseError(base, `no merge base between ${branch} and HEAD`);
    }
    return sha;
  }
  if (!isPlainRef(base)) throw new InvalidDiffBaseError(base);
  const sha = await gitQuery(workdir, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${base}^{commit}`,
  ]);
  if (sha === null || !COMMIT_SHA_RE.test(sha)) {
    throw new UnresolvableDiffBaseError(base, `ref does not resolve inside the run's repo: ${base}`);
  }
  return sha;
}

/** Git's ways of saying "there is nothing here to diff" — a real answer (`diff: ""`), not an
 *  error. Mirrors the git-history route's tolerance (routes.ts): a workdir that is not a repo, or
 *  a repo with no commits yet (`HEAD` unresolvable — every file is untracked and the untracked
 *  pass still runs for the commit-less case). */
function isEmptyDiffAnswer(msg: string): boolean {
  // Case-insensitive on the repo check: `git log` says "fatal: not a git repository" but
  // `git diff` says "warning: Not a git repository. Use --no-index …" — measured, not assumed.
  const lower = msg.toLowerCase();
  return (
    lower.includes('not a git repository') ||
    msg.includes('does not have any commits') ||
    msg.includes("ambiguous argument 'HEAD'") ||
    msg.includes('unknown revision')
  );
}

/**
 * The run's worktree diff against `base` (default HEAD) — staged + unstaged in one answer — with
 * untracked files appended as `git diff --no-index /dev/null <file>` all-addition hunks (§3.3: a
 * run's *created* files must diff as additions rather than vanish). `relPath`, when given, narrows
 * both passes to that one file; it is always a single argv element after `--` (the open-path rule
 * — no shell string is ever composed). The literal `/dev/null` is git's own cross-platform
 * null-device spelling (git special-cases it, including on Windows).
 *
 * `base` (CREW-UX-1, DES-UX-001 §8.1): the literal `merge-base` diffs from the run branch's fork
 * point off the default branch — committed run work becomes visible; a plain ref diffs from that
 * ref, resolved inside this repo first (`resolveDiffBase` — the raw parameter never reaches
 * `git diff`). Throws `InvalidDiffBaseError` / `UnresolvableDiffBaseError` for the route's 400s.
 */
export async function worktreeDiff(
  workdir: string,
  relPath?: string,
  base?: string,
): Promise<WorktreeDiff> {
  const limit = relPath === undefined ? [] : ['--', relPath];
  let out = '';

  // Resolve the baseline BEFORE any diff pass: a bad `base` must 400 without partial output.
  let baseRev = 'HEAD';
  if (base !== undefined && base.length > 0) {
    try {
      baseRev = await resolveDiffBase(workdir, base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err; // git missing — 500
      const msg = err instanceof Error ? err.message : String(err);
      // The route's standing tolerance: a non-repo workdir answers an empty diff, base or not.
      if (msg.toLowerCase().includes('not a git repository')) return { diff: '', truncated: false };
      throw err;
    }
  }

  // Tracked changes (staged + unstaged, plus committed-since-base when a base was resolved):
  // diff the worktree against the baseline.
  try {
    const { stdout } = await execCapped(
      'git',
      ['diff', '--no-color', '--no-ext-diff', baseRev, ...limit],
      { timeout: GIT_TIMEOUT_MS, cwd: workdir },
    );
    out = stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err; // git missing — the route's 500
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not a git repository')) return { diff: '', truncated: false };
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
    // Cap is in BYTES; `out.length` counts UTF-16 code units. `>=`: exactly-at-cap is
    // already done — spawning one more git only to discard its output is waste (Copilot, #305).
    if (Buffer.byteLength(out, 'utf8') >= DIFF_OUTPUT_CAP_BYTES) break;
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

  // Byte-accurate cap (Copilot, #305): `slice` on the string counts UTF-16 code units, which
  // under-enforces for non-ASCII diffs. Cut on the UTF-8 byte buffer, then back off any
  // incomplete trailing multibyte sequence — decoding a torn tail yields U+FFFD, which
  // re-encodes LARGER and would breach the cap by a byte.
  const outBytes = Buffer.from(out, 'utf8');
  if (outBytes.byteLength > DIFF_OUTPUT_CAP_BYTES) {
    let end = DIFF_OUTPUT_CAP_BYTES;
    while (end > 0 && (outBytes[end]! & 0xc0) === 0x80) end--; // land on a sequence boundary
    return { diff: outBytes.subarray(0, end).toString('utf8'), truncated: true };
  }
  return { diff: out, truncated: false };
}
