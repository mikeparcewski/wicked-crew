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
 *     one commit of history, `--no-hardlinks` so the snapshot never aliases the live object
 *     store. Because a clone checks out EVERY tracked path, the result is then swept: tracked
 *     `node_modules` trees and every symlink are removed (see below), and the swept snapshot
 *     is re-measured against the budget before it counts as usable.
 *  2. A plain file copy that skips `.git`/`node_modules` AND symlinks — for roots that are not
 *     git repos (or where git itself is unavailable/failing).
 *
 * SYMLINKS NEVER SURVIVE into a snapshot, on either path (Copilot, crew#313): the snapshot
 * lands inside the worker-visible inbox, so a repo symlink pointing OUTSIDE the repo would
 * hand the worker readable reach beyond the governance boundary — and a link to a huge tree
 * would bypass the size cap the preflight walk (which skips links) enforced. The copy filter
 * refuses them and the post-clone sweep deletes the ones a clone checked out.
 *
 * The snapshot is CAPPED: a working tree whose (`.git`/`node_modules`/symlink-excluded) size
 * exceeds the budget is not snapshotted at all — the caller degrades honestly to an ungrounded
 * launch with a visible status note, never a truncated half-repo the worker would mistake for
 * the whole. Snapshots are launch-scoped: the seams remove them when the run reaches a
 * terminal state (finalize/failure folds), so the inbox never accretes dead clones.
 *
 * OVERLAP REFUSAL: a configured draft dir could place `dest` inside the live repo (or a repo
 * could be registered AT the inbox). Clearing a stale dest with `rm -rf` before noticing that
 * would DELETE live repository content — so source/dest containment is checked (realpath'd,
 * both directions) BEFORE anything is removed, and any overlap refuses the snapshot outright.
 * For the same reason THIS helper creates `dest`'s parent directory (after the check passes) —
 * a caller that pre-created it would already have written into the live repo (Copilot round 2).
 *
 * Fully ASYNC on purpose: this runs inline in a bus handler whose process also feeds ~15s UI
 * heartbeats — a synchronous clone/copy of a big repo would starve the event loop and the
 * canvas would read frozen (Copilot, crew#313). All I/O is fs/promises; the clone goes through
 * the daemon's capped exec chokepoint (`execCapped`, FINDING-016).
 */

import { cp, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path, { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execCapped } from '../core/exec.js';

/** Default snapshot budget (~200MB). A repo whose working tree exceeds this is not
 *  snapshotted — the launch proceeds ungrounded, honestly narrated. */
export const REPO_SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;

/** Never snapshotted: git's object store (the clone brings its own shallow one; the copy
 *  fallback wants working files only) and dependency trees (huge, reproducible, ungrounding). */
const SNAPSHOT_SKIP = new Set(['.git', 'node_modules']);

/** Why a snapshot was refused — each maps to a DIFFERENT operator-facing degrade message in
 *  the calling seam, so "too large" is never claimed about a repo that was merely unreadable
 *  (Copilot, crew#313). */
export type SnapshotFailureReason =
  /** `rootPath` does not exist or is not a directory. */
  | 'root-unreadable'
  /** The tree (preflight) — or the swept clone (post-check) — exceeds the byte budget. */
  | 'too-large'
  /** `rootPath` and `dest` overlap (either direction) — clearing/cloning would eat live data. */
  | 'dest-overlap'
  /** The stale `dest` could not be cleared. */
  | 'dest-unclearable'
  /** Both the git clone and the file-copy fallback failed. */
  | 'copy-failed';

/** The honest outcome of {@link snapshotRepo}: usable snapshot, or the reason there is none. */
export type SnapshotResult = { ok: true } | { ok: false; reason: SnapshotFailureReason };

/** `true` when the tree under `root` exceeds `cap` bytes, skipping {@link SNAPSHOT_SKIP} dirs
 *  and symlinks (a link to a huge tree — or out of the repo — must not distort the estimate;
 *  the copy filter and post-clone sweep exclude exactly the same set, so the preflight counts
 *  what a snapshot would actually hold), with an early exit the moment the cap is passed so a
 *  10GB monorepo is never fully walked just to learn it is too big. */
async function treeExceeds(root: string, cap: number): Promise<boolean> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subdir — the clone/copy will surface a real error if it matters
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        try {
          total += (await stat(join(dir, entry.name))).size;
        } catch {
          // raced deletion — ignore
        }
        if (total > cap) return true;
      }
    }
  }
  return false;
}

/** Post-clone sweep: delete every symlink (junctions included — boundary escape, cap bypass)
 *  and every {@link SNAPSHOT_SKIP} tree a `git clone` checked out (a clone materializes ALL
 *  tracked paths — tracked `node_modules` ignores the skip list otherwise). The clone's own
 *  top-level `.git` (its shallow object store) is the one deliberate survivor. */
async function sweepSnapshot(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        await rm(p, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        if (dir === root && entry.name === '.git') continue; // the shallow clone's own store
        if (SNAPSHOT_SKIP.has(entry.name)) {
          await rm(p, { recursive: true, force: true });
        } else {
          stack.push(p);
        }
      }
    }
  }
}

/** Resolve `p` through its nearest EXISTING ancestor's realpath (the path itself may not exist
 *  yet — a fresh dest usually does not), so symlinked parents cannot hide an overlap. Only
 *  ENOENT falls to the ancestor walk (the `api/open-path.ts` rule, Copilot round 2): any OTHER
 *  error (EACCES, ELOOP, …) means an EXISTING component could not be resolved — a lexical
 *  reconstruction there could miss an overlap through the unresolved link, so it THROWS and
 *  the caller's overlap-check catch fails closed (no snapshot, degrade). */
async function realpathNearest(p: string): Promise<string> {
  let existing = resolve(p);
  const tail: string[] = [];
  // Walk up until something exists; dirname() at the root returns itself, which always exists.
  for (;;) {
    try {
      const real = await realpath(existing);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) return existing; // unreachable in practice — a root always resolves
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** The subset of `node:path` {@link pathsOverlap} needs — injectable so the win32 drive-root
 *  behavior is unit-testable on any host (`path.win32`). */
type PathImpl = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>;

/** Is `child` equal to `parent` or inside it? `relative()`-based (the `api/open-path.ts`
 *  containment pattern) — a plain `startsWith(base + sep)` never matches a ROOT base (`/`,
 *  `C:\`), whose spelling already ends in the separator (Copilot round 2). */
function contains(parent: string, child: string, p: PathImpl): boolean {
  const rel = p.relative(parent, child);
  if (rel === '') return true; // the same path
  if (p.isAbsolute(rel)) return false; // different drive/tree entirely (win32)
  return rel !== '..' && !rel.startsWith(`..${p.sep}`);
}

/** `true` when `a` and `b` name the same path or one contains the other — including when one
 *  of them is a filesystem root (`/`, a win32 drive root). Exported for its unit tests. */
export function pathsOverlap(a: string, b: string, p: PathImpl = path): boolean {
  return contains(a, b, p) || contains(b, a, p);
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
 * READ as grounding context. Resolves `{ok: true}` when `dest` now holds a usable snapshot,
 * `{ok: false, reason}` when it does not — see {@link SnapshotFailureReason}; the reason lets
 * the caller narrate the RIGHT degrade (too large ≠ unreadable ≠ clone failed) — in which case
 * any partial `dest` has been removed and the caller must launch UNGROUNDED (and say so on the
 * thread). Never rejects: a grounding failure must degrade the launch, not kill it.
 *
 * The clone is the git-preferred path, so on a real repo the snapshot is HEAD's tracked
 * content (uncommitted/untracked files are not included) minus swept symlinks/`node_modules`;
 * the copy fallback takes the working tree as-is minus `.git`/`node_modules`/symlinks.
 */
export async function snapshotRepo(
  rootPath: string,
  dest: string,
  opts: SnapshotRepoOptions = {},
): Promise<SnapshotResult> {
  const log = opts.log ?? (() => {});
  const maxBytes = opts.maxBytes ?? REPO_SNAPSHOT_MAX_BYTES;

  try {
    if (!(await stat(rootPath)).isDirectory()) {
      log(`[repo-snapshot] repo root ${rootPath} is not a directory — no snapshot`);
      return { ok: false, reason: 'root-unreadable' };
    }
  } catch {
    log(`[repo-snapshot] repo root ${rootPath} does not exist — no snapshot`);
    return { ok: false, reason: 'root-unreadable' };
  }

  // Overlap refusal comes BEFORE the stale-dest clear (Copilot, crew#313): with a configurable
  // draft dir, `dest` can sit inside the registered repo (or vice versa) — clearing it first
  // would `rm -rf` live repository content, and a copy could recurse into its own output.
  try {
    const realRoot = await realpath(rootPath);
    const realDest = await realpathNearest(dest);
    if (pathsOverlap(realRoot, realDest)) {
      log(
        `[repo-snapshot] refusing snapshot: destination ${dest} (${realDest}) overlaps the repo root ${rootPath} (${realRoot})`,
      );
      return { ok: false, reason: 'dest-overlap' };
    }
  } catch (err) {
    log(
      `[repo-snapshot] could not resolve ${rootPath} / ${dest} for the overlap check: ${
        err instanceof Error ? err.message : String(err)
      } — no snapshot`,
    );
    return { ok: false, reason: 'root-unreadable' };
  }

  if (await treeExceeds(rootPath, maxBytes)) {
    log(`[repo-snapshot] repo at ${rootPath} exceeds the ${maxBytes}-byte snapshot budget — no snapshot`);
    return { ok: false, reason: 'too-large' };
  }

  // The snapshot's PARENT (the caller's per-run dir) is created HERE — only after containment
  // was validated. The caller must never pre-create it: with an overlapping config that mkdir
  // would write into the live repository before the refusal above could fire (Copilot round 2).
  try {
    await mkdir(dirname(dest), { recursive: true });
  } catch (err) {
    log(
      `[repo-snapshot] could not create the snapshot parent for ${dest}: ${
        err instanceof Error ? err.message : String(err)
      } — no snapshot`,
    );
    return { ok: false, reason: 'copy-failed' };
  }

  // A stale snapshot (crashed prior run, replayed key) never survives into a new launch.
  try {
    await rm(dest, { recursive: true, force: true });
  } catch (err) {
    log(`[repo-snapshot] could not clear ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: 'dest-unclearable' };
  }

  // Preferred: shallow local clone. `file://` (not a plain path) is what makes --depth honored
  // on a local source; pathToFileURL keeps the URL spelling right on Windows too.
  try {
    await execCapped('git', ['clone', '--depth', '1', '--no-hardlinks', pathToFileURL(rootPath).href, dest], {
      timeout: 120_000,
      windowsHide: true,
    });
    // The clone checked out EVERY tracked path — sweep what the snapshot contract excludes
    // (tracked node_modules, all symlinks), then verify the SWEPT tree against the budget:
    // the preflight measured the source with these exclusions, so a clean sweep normally
    // passes, but the honest gate is what actually landed on disk.
    await sweepSnapshot(dest);
    if (await treeExceeds(dest, maxBytes)) {
      log(`[repo-snapshot] clone of ${rootPath} exceeds the ${maxBytes}-byte budget after sweep — no snapshot`);
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'too-large' };
    }
    return { ok: true };
  } catch (err) {
    log(
      `[repo-snapshot] git clone of ${rootPath} failed (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to a file copy`,
    );
  }

  try {
    await rm(dest, { recursive: true, force: true }); // whatever the failed clone left behind
    await cp(rootPath, dest, {
      recursive: true,
      filter: async (src) => {
        if (SNAPSHOT_SKIP.has(basename(src))) return false;
        try {
          // Symlinks NEVER ride into the worker-visible inbox: a link out of the repo is a
          // boundary escape, a link to a huge tree a cap bypass (Copilot, crew#313).
          return !(await lstat(src)).isSymbolicLink();
        } catch {
          return false; // raced deletion / unreadable — leave it out
        }
      },
    });
    // The honest gate is what actually LANDED (same rule as the clone path's post-sweep
    // re-measure): the preflight walked the SOURCE, and a file that grew between that walk and
    // the copy would otherwise put an over-budget tree in the worker-visible inbox
    // (Copilot round 2).
    if (await treeExceeds(dest, maxBytes)) {
      log(`[repo-snapshot] copy of ${rootPath} exceeds the ${maxBytes}-byte budget — no snapshot`);
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'too-large' };
    }
    return { ok: true };
  } catch (err) {
    log(
      `[repo-snapshot] file copy of ${rootPath} failed too (${
        err instanceof Error ? err.message : String(err)
      }) — no snapshot`,
    );
    await rm(dest, { recursive: true, force: true }).catch(() => {}); // never leave a partial snapshot
    return { ok: false, reason: 'copy-failed' };
  }
}
