/**
 * `wicked-crew apps-check` (DES-APPS-001 §9.2 `check`, slice K5): the Tool step of an `apps-turn` run.
 *
 * The engine runs it in the turn's worktree with the unit's capability token (`WICKED_MCP_TOKEN`), this
 * daemon's URL (`WICKED_CREW_URL`) and its snapshot of the builder's worktree (`WICKED_TREE`, a tree in the app
 * repo's objects). It asks crew to check that tree (`POST /apps/check`); crew does the work from the app repo's
 * own objects and writes the lock. On a pass it puts the checked tree's files in the worktree, so the review
 * step is dispatched on exactly the tree that can land. It runs no git, no hook and nothing from the worktree.
 *
 * The worktree is a directory an agent seat had, so nothing is ever written THROUGH an entry the seat could have
 * made (xreview r1: a raced parent directory, a hard link to a file elsewhere):
 *  - every path is one crew named (`apps.json`, `apps.lock.json`, `queries/<id>.<ext>`), checked against that
 *    shape again here;
 *  - every file is written to a FRESH inode (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0644`) in a staging directory crew
 *    makes BESIDE the worktree (mode 0700; a seat is given the worktree only), never inside it;
 *  - then each entry is renamed into the worktree: an existing file, link or hard link there is replaced as a
 *    directory entry, never opened, truncated or chmodded; `queries/` is swapped whole, and the old entry (whatever
 *    it is) is renamed into staging before staging is removed, so nothing in it is followed.
 * Exit 0: checked and written. Exit 1: refused (the findings are printed). Exit 2: could not ask.
 */

import { chmodSync, constants, closeSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The paths a checked tree may hold (query ids: `APP_NAMED_ID_RE`; extensions: `QUERY_EXT`). */
const FILE_RE = /^(?:apps\.json|apps\.lock\.json|queries\/[a-z][a-z0-9_]{0,63}\.(?:sql|graphql|json))$/;
const TREE_RE = /^[0-9a-f]{40}$/;
/** How long the check may take (the source stage describes every changed query, each under its deadline). */
const CHECK_TIMEOUT_MS = 120_000;

export interface AppsCheckIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
}

interface CheckedFile { path: string; text: string }

type CheckAnswer =
  | { ok: true; commit: string; tree: string; summary?: { level?: string; checked?: unknown[] }; files?: CheckedFile[] }
  | { ok: false; code?: string; findings?: Array<{ code?: string; path?: string; message?: string }> };

/** A new file at `path` (which must not exist), holding `text`, mode 0644. */
function writeFresh(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fchmodSync(fd, 0o644); // our own fresh inode: the umask may have narrowed it
  } finally {
    closeSync(fd);
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
};

/** Move the entry at `path` out of the worktree (into the staging dir `to`), whatever it is: a rename, never followed. */
function moveOut(path: string, to: string, name: string): void {
  renameSync(path, join(to, name));
}

/**
 * Put `files` (crew's checked tree) in the worktree `root`. Everything is written in a STAGING directory crew makes
 * beside the worktree (in its parent, mode 0700: a seat is given the worktree only, so it can neither see nor rename
 * it, and it is on the worktree's filesystem, so the moves below are renames). Only then is anything moved: the old
 * `queries/` entry (whatever it is) into staging, the new `queries/` and each file into the worktree, each a single
 * rename of a directory entry. Nothing is written or followed through an entry the seat made (xreview r2: a staging
 * directory inside the worktree could itself be raced). Staging is removed at the end, whatever happened.
 */
export function materialize(root: string, files: readonly CheckedFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f.text !== 'string' || !FILE_RE.test(f.path) || seen.has(f.path)) {
      throw new Error(`crew named a path a checked tree cannot hold (${JSON.stringify(f?.path)}); nothing was written`);
    }
    seen.add(f.path);
  }
  if (!seen.has('apps.json') || !seen.has('apps.lock.json')) throw new Error('crew answered without apps.json and apps.lock.json; nothing was written');
  for (const name of ['apps.json', 'apps.lock.json']) {
    const st = exists(join(root, name)) ? lstatSync(join(root, name)) : null;
    if (st !== null && st.isDirectory()) throw new Error(`${name} in the worktree is a directory; nothing was written`);
  }
  const staging = mkdtempSync(join(dirname(realpathSync(root)), '.wicked-apps-check-'));
  try {
    chmodSync(staging, 0o700);
    // 1. Every file, fresh, in staging (nothing in the worktree is touched yet).
    const queries = files.filter((f) => f.path.startsWith('queries/'));
    if (queries.length > 0) mkdirSync(join(staging, 'queries'), { mode: 0o755 });
    for (const f of files) writeFresh(join(staging, f.path), f.text);
    // 2. The moves: each one rename of a directory entry in the worktree root.
    if (exists(join(root, 'queries'))) moveOut(join(root, 'queries'), staging, 'old-queries');
    if (queries.length > 0) renameSync(join(staging, 'queries'), join(root, 'queries'));
    for (const f of files.filter((x) => !x.path.includes('/'))) renameSync(join(staging, f.path), join(root, f.path));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function runAppsCheck(argv: readonly string[], io: AppsCheckIo): Promise<number> {
  if (argv.includes('--publish')) {
    io.err('apps_check: the publish check is not served by this crew yet; nothing was checked');
    return 2;
  }
  const token = io.env['WICKED_MCP_TOKEN'] ?? '';
  const url = (io.env['WICKED_CREW_URL'] ?? '').replace(/\/+$/, '');
  const tree = (io.env['WICKED_TREE'] ?? '').toLowerCase();
  if (token === '' || url === '') {
    io.err('apps_check: no unit token or daemon URL (WICKED_MCP_TOKEN, WICKED_CREW_URL): this runs only as an apps-turn check step; nothing was checked');
    return 2;
  }
  if (!TREE_RE.test(tree)) {
    io.err('apps_check: the engine handed no worktree tree (WICKED_TREE); nothing was checked');
    return 2;
  }
  let res: Response;
  try {
    res = await (io.fetch ?? fetch)(`${url}/api/v1/apps/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, tree }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (e) {
    io.err(`apps_check: crew did not answer (${e instanceof Error ? e.message : String(e)}); nothing was checked`);
    return 2;
  }
  let body: CheckAnswer | { code?: string; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    io.err(`apps_check: crew answered ${res.status} with no JSON; nothing was checked`);
    return 2;
  }
  if (!res.ok) {
    const b = body as { code?: string; error?: string };
    io.err(`apps_check: refused: ${b.code ?? res.status}: ${(b.error ?? '').slice(0, 600)}`);
    return 1;
  }
  const a = body as CheckAnswer;
  if (a.ok !== true) {
    const findings = Array.isArray(a.findings) ? a.findings : [];
    io.out(`apps_check: refused: ${a.code ?? 'check_failed'} (${findings.length} finding${findings.length === 1 ? '' : 's'}); nothing lands`);
    for (const f of findings.slice(0, 20)) io.out(`- ${f.code ?? '?'} ${f.path ?? ''}: ${(f.message ?? '').slice(0, 300)}`);
    return 1;
  }
  if (!Array.isArray(a.files)) {
    io.err('apps_check: crew checked the tree but sent no files to write (an older crew); the review could not see the checked tree');
    return 2;
  }
  try {
    materialize(io.cwd, a.files);
  } catch (e) {
    io.out(`apps_check: refused: worktree: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const checked = Array.isArray(a.summary?.checked) ? a.summary.checked.length : 0;
  io.out(`apps_check: ok tree=${a.tree} (check level ${a.summary?.level ?? '?'}, ${checked} quer${checked === 1 ? 'y or action' : 'ies or actions'} checked against their sources; lock written by crew)`);
  return 0;
}
