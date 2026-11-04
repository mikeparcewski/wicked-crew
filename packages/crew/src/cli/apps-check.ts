/**
 * `wicked-crew apps-check` (DES-APPS-001 §9.2 `check`, slice K5): the Tool step of an `apps-turn` run.
 *
 * The engine runs it in the turn's worktree with the unit's capability token (`WICKED_MCP_TOKEN`), this
 * daemon's URL (`WICKED_CREW_URL`) and its snapshot of the builder's worktree (`WICKED_TREE`, a tree in the app
 * repo's objects). It asks crew to check that tree (`POST /apps/check`); crew does the work from the app repo's
 * own objects and writes the lock. On a pass it writes the checked tree's files into the worktree, so the review
 * step is dispatched on exactly the tree that can land. It runs no git, no hook and nothing from the worktree.
 *
 * Writing into a worktree an agent seat had: every path is one crew named (`apps.json`, `apps.lock.json`,
 * `queries/<id>.<ext>`), checked against that shape again here; a symlink, or a directory where a file belongs
 * (or a non-directory where `queries/` belongs), is refused rather than followed; files are opened with
 * `O_NOFOLLOW` and left `0644`; a stale file under `queries/` crew did not name is removed (only a file or a link,
 * never followed). Exit 0: checked and written. Exit 1: refused (the findings are printed). Exit 2: could not ask.
 */

import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

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

/** A path under `root` that is a regular file or absent; anything else is a refusal naming it. */
function plainOrAbsent(path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${label} in the worktree is not a regular file (${st.isSymbolicLink() ? 'a symlink' : 'a directory or special file'}); nothing was written`);
}

function writePlain(path: string, text: string): void {
  // O_NOFOLLOW: a symlink planted between the check above and this open is refused by the kernel, not followed.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    // An executable bit left on the file would make the worktree's tree differ from the checked one.
    fchmodSync(fd, 0o644);
  } finally {
    closeSync(fd);
  }
}

/** Write `files` (crew's checked tree) into `root`, removing what crew did not name under `queries/`. */
export function materialize(root: string, files: readonly CheckedFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f.text !== 'string' || !FILE_RE.test(f.path) || seen.has(f.path)) {
      throw new Error(`crew named a path a checked tree cannot hold (${JSON.stringify(f?.path)}); nothing was written`);
    }
    seen.add(f.path);
  }
  if (!seen.has('apps.json') || !seen.has('apps.lock.json')) throw new Error('crew answered without apps.json and apps.lock.json; nothing was written');
  const qdir = join(root, 'queries');
  let qdirState: 'absent' | 'dir';
  try {
    const st = lstatSync(qdir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('queries in the worktree is not a directory (a symlink or a file); nothing was written');
    qdirState = 'dir';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    qdirState = 'absent';
  }
  // Every target is checked before anything is written.
  for (const f of files) plainOrAbsent(join(root, f.path), f.path);
  const queryFiles = files.filter((f) => f.path.startsWith('queries/'));
  if (queryFiles.length > 0 && qdirState === 'absent') mkdirSync(qdir, { mode: 0o755 });
  for (const f of files) writePlain(join(root, f.path), f.text);
  if (qdirState === 'dir' || queryFiles.length > 0) {
    for (const name of readdirSync(qdir)) {
      if (seen.has(`queries/${name}`)) continue;
      const p = join(qdir, name);
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) throw new Error(`queries/${name} is a directory crew did not name; the worktree differs from the checked tree`);
      unlinkSync(p); // a file or a link (the link itself, never what it points at)
    }
    if (queryFiles.length === 0) rmdirSync(qdir);
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
