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

import { chmodSync, constants, closeSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** The paths a checked tree may hold (query ids: `APP_NAMED_ID_RE`; extensions: `QUERY_EXT`). */
const FILE_RE = /^(?:apps\.json|apps\.lock\.json|queries\/[a-z][a-z0-9_]{0,63}\.(?:sql|graphql|json))$/;
const TREE_RE = /^[0-9a-f]{40}$/;
/** How long the check may take (the source stage describes every changed query, each under its deadline). */
const CHECK_TIMEOUT_MS = 120_000;
// Two source/manifest checks, the full three-minute render, and response overhead.
export const PUBLISH_CHECK_TIMEOUT_MS = 2 * CHECK_TIMEOUT_MS + 180_000 + 30_000;

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

/** The names crew may give an evidence file: lower-case, slash-separated, never absolute, never a `..` hop. */
const EVIDENCE_NAME_RE = /^[a-z0-9._/-]+$/;

/**
 * The on-disk path an evidence file named `name` is written to, under `dir`, or a throw. crew NAMES the paths;
 * the CLI is the boundary that makes a write outside `dir` impossible: the name is lower-case `[a-z0-9._/-]`,
 * never absolute, holds no empty or `..` segment, and the resolved path is still inside `dir` (the last check
 * catches anything the character rule did not).
 */
export function evidenceTarget(dir: string, name: string): string {
  if (typeof name !== 'string' || name === '' || !EVIDENCE_NAME_RE.test(name)) throw new Error(`crew named an evidence path with characters outside [a-z0-9._/-]: ${JSON.stringify(name)}`);
  if (name.startsWith('/') || name.includes('\0')) throw new Error(`crew named an evidence path that is absolute or has a null byte: ${JSON.stringify(name)}`);
  if (name.split('/').some((seg) => seg === '' || seg === '..')) throw new Error(`crew named an evidence path with an empty or '..' segment: ${JSON.stringify(name)}`);
  const target = join(dir, name);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`the evidence path ${JSON.stringify(name)} is outside the evidence directory`);
  return target;
}

/**
 * Write fresh evidence in private sibling staging, then replace the worktree's .wicked ENTRY.
 * Existing ancestors are moved out, never traversed for writes. Their other entries are preserved by
 * rename; even a raced link or hard link is only moved, never opened. As with materialize(), the seat
 * has the worktree, not its parent. A conflicting final rename fails closed.
 */
export function materializeEvidence(root: string, digest: string, evidence: Array<{ path?: string; base64?: string }>): void {
  const seen = new Set<string>();
  for (const e of evidence) {
    evidenceTarget(root, e.path ?? '');
    if (seen.has(e.path!)) throw new Error('crew repeated an evidence path');
    seen.add(e.path!);
  }
  const staging = mkdtempSync(join(dirname(realpathSync(root)), '.wicked-publish-check-'));
  const target = join(root, '.wicked');
  let detached = false;
  const moved: Array<{ from: string; to: string }> = [];
  const preserve = (from: string, to: string): void => { renameSync(from, to); moved.push({ from, to }); };
  try {
    chmodSync(staging, 0o700);
    const fresh = join(staging, 'fresh');
    const checks = join(fresh, 'publish-check');
    const dir = join(checks, digest.slice(0, 12));
    mkdirSync(dir, { recursive: true });
    for (const e of evidence) {
      const path = evidenceTarget(dir, e.path!);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { writeFileBytes(fd, Buffer.from(e.base64 ?? '', 'base64')); } finally { closeSync(fd); }
    }
    const old = join(staging, 'old');
    if (exists(target)) {
      renameSync(target, old);
      detached = true;
      // Inspect only the detached entries. No ancestor here is in the seat's worktree.
      if (lstatSync(old).isDirectory()) {
        for (const name of readdirSync(old)) {
          if (name !== 'publish-check') preserve(join(old, name), join(fresh, name));
        }
        const prior = join(old, 'publish-check');
        if (exists(prior) && lstatSync(prior).isDirectory()) {
          for (const name of readdirSync(prior)) {
            if (name !== digest.slice(0, 12)) preserve(join(prior, name), join(checks, name));
          }
        }
      }
    }
    renameSync(fresh, target);
    detached = false;
  } catch (err) {
    // Retain the detached directory on an unexpected conflict rather than discard unrelated files.
    if (detached) {
      try {
        for (const { from, to } of moved.reverse()) renameSync(to, from);
        renameSync(join(staging, 'old'), target);
        detached = false;
      } catch {
        throw new Error(`evidence replacement failed; the previous entries are retained in ${staging}`, { cause: err });
      }
    }
    throw err;
  } finally {
    if (!detached) rmSync(staging, { recursive: true, force: true });
  }
}

function writeFileBytes(fd: number, bytes: Buffer): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
}

interface PublishAnswer {
  ok?: boolean;
  code?: string;
  tree?: string;
  digest?: string;
  card?: string;
  report?: { rules?: Array<{ rule?: string; ok?: boolean; detail?: string }>; render?: { pages?: unknown[] } };
  evidence?: Array<{ path?: string; base64?: string }>;
  findings?: Array<{ code?: string; path?: string; message?: string }>;
  error?: string;
}

/** `wicked-crew apps-check --publish`: the publish run's `check` unit. Posts `{token, tree}` as the turn check does. */
async function runPublishCheck(io: AppsCheckIo): Promise<number> {
  const token = io.env['WICKED_MCP_TOKEN'] ?? '';
  const url = (io.env['WICKED_CREW_URL'] ?? '').replace(/\/+$/, '');
  const tree = (io.env['WICKED_TREE'] ?? '').toLowerCase();
  if (token === '' || url === '') {
    io.err('apps_check: no unit token or daemon URL (WICKED_MCP_TOKEN, WICKED_CREW_URL): this runs only as an apps-publish check step; nothing was checked');
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
      signal: AbortSignal.timeout(PUBLISH_CHECK_TIMEOUT_MS),
    });
  } catch (e) {
    io.err(`apps_check: crew did not answer (${e instanceof Error ? e.message : String(e)}); nothing was checked`);
    return 2;
  }
  let body: PublishAnswer;
  try {
    body = (await res.json()) as PublishAnswer;
  } catch {
    io.err(`apps_check: crew answered ${res.status} with no JSON; nothing was checked`);
    return 2;
  }
  if (!res.ok) {
    io.err(`apps_check: refused: ${body.code ?? res.status}: ${(body.error ?? '').slice(0, 600)}`);
    return 1;
  }
  if (body.ok !== true) {
    const findings = Array.isArray(body.findings) ? body.findings : [];
    io.out(`apps_check: publish check refused: ${body.code ?? 'check_failed'} (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
    for (const f of findings.slice(0, 20)) io.out(`- ${f.code ?? '?'} ${f.path ?? ''}: ${(f.message ?? '').slice(0, 300)}`);
    return 1;
  }
  const digest = (body.digest ?? '').toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(digest)) {
    io.err('apps_check: crew answered ok with no manifest digest; nothing was written');
    return 2;
  }
  const dir = join(io.cwd, '.wicked', 'publish-check', digest.slice(0, 12));
  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  try {
    materializeEvidence(io.cwd, digest, evidence);
  } catch (e) {
    io.out(`apps_check: refused: evidence: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const rules = body.report?.rules ?? [];
  const pages = body.report?.render?.pages?.length ?? 0;
  io.out(`apps_check: publish check ok tree=${body.tree ?? tree} digest=${digest.slice(0, 12)} (${rules.length} rule${rules.length === 1 ? '' : 's'} checked, ${pages} page render${pages === 1 ? '' : 's'})`);
  io.out(`apps_check: evidence written to ${dir} (${evidence.length} file${evidence.length === 1 ? '' : 's'})`);
  if (typeof body.card === 'string' && body.card !== '') {
    io.out('apps_check: consent card:');
    for (const line of body.card.split('\n')) io.out(`  ${line}`);
  }
  return 0;
}

export async function runAppsCheck(argv: readonly string[], io: AppsCheckIo): Promise<number> {
  if (argv.includes('--publish')) return runPublishCheck(io);
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
