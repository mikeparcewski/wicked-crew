/**
 * Launch-scoped REPO SNAPSHOTS for grounding governed interactive runs (CREW-UX-8 v4).
 *
 * WHY a snapshot instead of the live repo: the interactive seams launch their governed runs
 * UNBOUND — on a repoRef-bound run the worker's ACP tool-permission stream closes on the first
 * call that needs a permission prompt and the session dies (wicked-core#293) — and an unbound
 * worker's governance boundary is {sandbox, extraWriteRoots, ~/.claude/plugins}, so even READS
 * of the live repo root are governance-denied (wicked-core#294; the v3 "hand the worker the
 * root path to read" design rested on read evidence gathered under a *bound* boundary, which
 * does not transfer). The one location an unbound worker can always read is the inbox the run
 * already writes to — write roots are readable (wicked-core#259) — so grounding means putting
 * a copy of the repo INSIDE the inbox, crew-side, BEFORE the launch, and naming that snapshot
 * in the task.
 *
 * Mechanism, in preference order:
 *  1. `git clone --depth 1 --no-hardlinks file://<root> <dest>` — a shallow LOCAL clone:
 *     one commit of history, tracked content only (no node_modules, no build junk),
 *     `--no-hardlinks` so the snapshot never aliases the live object store.
 *  2. A plain file copy that skips `.git`/`node_modules` — for roots that are not git repos
 *     (or where git itself is unavailable/failing).
 *
 * The snapshot is CAPPED: a working tree whose (`.git`/`node_modules`-excluded) size exceeds
 * the budget is not snapshotted at all — the caller degrades honestly to an ungrounded launch
 * with a visible status note, never a truncated half-repo the worker would mistake for the
 * whole. Snapshots are launch-scoped: the seams remove them when the run reaches a terminal
 * state (finalize/failure folds), so the inbox never accretes dead clones.
 */

import { cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Default snapshot budget (~200MB). A repo whose working tree exceeds this is not
 *  snapshotted — the launch proceeds ungrounded, honestly narrated. */
export const REPO_SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;

/** Never snapshotted: git's object store (the clone brings its own shallow one; the copy
 *  fallback wants working files only) and dependency trees (huge, reproducible, ungrounding). */
const SNAPSHOT_SKIP = new Set(['.git', 'node_modules']);

/** `true` when the tree under `root` exceeds `cap` bytes, skipping {@link SNAPSHOT_SKIP} dirs
 *  and symlinks (a link to a huge tree — or out of the repo — must not distort the estimate),
 *  with an early exit the moment the cap is passed so a 10GB monorepo is never fully walked
 *  just to learn it is too big. */
function treeExceeds(root: string, cap: number): boolean {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subdir — the clone/copy will surface a real error if it matters
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        try {
          total += statSync(join(dir, entry.name)).size;
        } catch {
          // raced deletion — ignore
        }
        if (total > cap) return true;
      }
    }
  }
  return false;
}

/** Options for {@link snapshotRepo}. */
export interface SnapshotRepoOptions {
  /** Size budget in bytes (default {@link REPO_SNAPSHOT_MAX_BYTES}; tests shrink it). */
  maxBytes?: number | undefined;
  /** Diagnostics sink — every degrade path logs its real reason here. */
  log?: ((message: string) => void) | undefined;
}

/**
 * Materialize a snapshot of the repo at `rootPath` into `dest` (creating it), for a worker to
 * READ as grounding context. Returns `true` when `dest` now holds a usable snapshot, `false`
 * when it does not — too large, missing root, both clone and copy failed — in which case any
 * partial `dest` has been removed and the caller must launch UNGROUNDED (and say so on the
 * thread). Never throws: a grounding failure must degrade the launch, not kill it.
 *
 * The clone is the git-preferred path, so on a real repo the snapshot is HEAD's tracked
 * content (uncommitted/untracked files are not included); the copy fallback takes the working
 * tree as-is minus `.git`/`node_modules`.
 */
export function snapshotRepo(rootPath: string, dest: string, opts: SnapshotRepoOptions = {}): boolean {
  const log = opts.log ?? (() => {});
  const maxBytes = opts.maxBytes ?? REPO_SNAPSHOT_MAX_BYTES;

  // A stale snapshot (crashed prior run, replayed key) never survives into a new launch.
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    log(`[repo-snapshot] could not clear ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  try {
    if (!statSync(rootPath).isDirectory()) {
      log(`[repo-snapshot] repo root ${rootPath} is not a directory — no snapshot`);
      return false;
    }
  } catch {
    log(`[repo-snapshot] repo root ${rootPath} does not exist — no snapshot`);
    return false;
  }

  if (treeExceeds(rootPath, maxBytes)) {
    log(`[repo-snapshot] repo at ${rootPath} exceeds the ${maxBytes}-byte snapshot budget — no snapshot`);
    return false;
  }

  // Preferred: shallow local clone. `file://` (not a plain path) is what makes --depth honored
  // on a local source; pathToFileURL keeps the URL spelling right on Windows too.
  try {
    execFileSync('git', ['clone', '--depth', '1', '--no-hardlinks', pathToFileURL(rootPath).href, dest], {
      stdio: 'pipe',
      timeout: 120_000,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    log(
      `[repo-snapshot] git clone of ${rootPath} failed (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to a file copy`,
    );
  }

  try {
    rmSync(dest, { recursive: true, force: true }); // whatever the failed clone left behind
    cpSync(rootPath, dest, {
      recursive: true,
      filter: (src) => !SNAPSHOT_SKIP.has(basename(src)),
    });
    return true;
  } catch (err) {
    log(
      `[repo-snapshot] file copy of ${rootPath} failed too (${
        err instanceof Error ? err.message : String(err)
      }) — no snapshot`,
    );
    try {
      rmSync(dest, { recursive: true, force: true }); // never leave a partial snapshot behind
    } catch {
      // best-effort
    }
    return false;
  }
}
