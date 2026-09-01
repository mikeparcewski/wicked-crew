/**
 * Pre-provisioned campaign-node worktrees — the daemon-side workaround for an ENGINE defect
 * (found while landing crew#390): the engine names every run's worktree branch
 * `wicked/{run_id}` VERBATIM (`wicked-core src/repo.rs create_worktree`), and a campaign node's
 * run id is `{campaign}:{node}:a{attempt}` — a string git REFUSES as a branch name (':' is
 * illegal in a ref). Every repo-scoped campaign node therefore fails at dispatch with
 * "git worktree add failed: … is not a valid branch name" before a single unit runs, on every
 * released engine.
 *
 * The workaround rides the same function's DOCUMENTED contract: `create_worktree` is
 * "idempotent for a genuine resume: a live worktree already at the path is reused". So the
 * daemon creates each node's worktree FIRST — at the engine's own layout
 * (`<repo_root>/wicked-worktrees/<run_id>`, the crew#276 non-dotted root every engine this
 * daemon can install uses: `wicked-core-ts` floor ^0.7.6) — on a branch-SAFE name
 * (`wicked/<run_id with ':' → '-'>`), and the engine's dispatch finds and reuses it instead of
 * minting the illegal branch. When the engine later sanitizes its branch names natively, these
 * pre-created worktrees keep reading as the same legitimate resume state.
 *
 * Fail-closed and atomic-ish: provisioning happens BEFORE the campaign launches, so a git
 * failure aborts the whole request with nothing scheduled; the returned rollback lets the
 * caller reclaim the worktrees when the launch itself is then refused. NOTE: the run-id path
 * carries ':' — legal on macOS/Linux, ILLEGAL on Windows filesystems — so callers must keep a
 * non-campaign fallback on win32 (the recon route does).
 */

import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execCapped } from '../core/exec.js';

/** One node's provisioning target: the engine-derived run id and its repo's root checkout. */
export interface WorktreeTarget {
  runId: string;
  repoRoot: string;
}

/** The branch-safe spelling of a campaign-node run id (':' is illegal in a git ref). */
export function branchSafe(runId: string): string {
  return runId.replaceAll(':', '-');
}

async function git(repoRoot: string, args: string[]): Promise<void> {
  await execCapped('git', ['-C', repoRoot, ...args], { windowsHide: true });
}

/** Mirror of the engine's `ensure_worktrees_excluded` (repo-local `.git/info/exclude`) — the
 *  engine only writes it on the mint path, which the reuse contract skips. Best-effort. */
async function ensureExcluded(repoRoot: string): Promise<void> {
  const ENTRY = 'wicked-worktrees/';
  const exclude = join(repoRoot, '.git', 'info', 'exclude');
  try {
    const existing = await readFile(exclude, 'utf8').catch(() => '');
    if (existing.split('\n').some((l) => l.trim() === ENTRY)) return;
    const body = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
    await mkdir(join(repoRoot, '.git', 'info'), { recursive: true });
    await writeFile(exclude, `${body}${ENTRY}\n`, 'utf8');
  } catch {
    /* cosmetic — a dirty `git status` in the parent checkout, never a failed run */
  }
}

/**
 * Create one live worktree per target at the engine's layout, on a branch-safe branch.
 * Throws (after removing whatever it already created) when any `git worktree add` refuses —
 * the caller aborts the launch with nothing scheduled. Returns a best-effort rollback for the
 * caller's own abort paths (e.g. the engine then refusing the campaign def).
 */
export async function provisionCampaignWorktrees(
  targets: WorktreeTarget[],
): Promise<() => Promise<void>> {
  const created: WorktreeTarget[] = [];
  const rollback = async (): Promise<void> => {
    for (const t of created) {
      const wt = join(t.repoRoot, 'wicked-worktrees', t.runId);
      // Forced remove is correct here: the run never started, so there is no work to preserve.
      await execCapped('git', ['-C', t.repoRoot, 'worktree', 'remove', '--force', wt], {
        windowsHide: true,
      }).catch(() => {});
      await execCapped('git', ['-C', t.repoRoot, 'branch', '-D', `wicked/${branchSafe(t.runId)}`], {
        windowsHide: true,
      }).catch(() => {});
    }
  };
  for (const t of targets) {
    const wt = join(t.repoRoot, 'wicked-worktrees', t.runId);
    const branch = `wicked/${branchSafe(t.runId)}`;
    try {
      await mkdir(join(t.repoRoot, 'wicked-worktrees'), { recursive: true });
      try {
        await git(t.repoRoot, ['worktree', 'add', wt, '-b', branch]);
      } catch {
        // The engine's own retry idiom: a stale branch from a prior attempt blocks `-b` — reuse it.
        await git(t.repoRoot, ['worktree', 'add', wt, branch]);
      }
      await ensureExcluded(t.repoRoot);
      created.push(t);
    } catch (err) {
      await rollback();
      throw new Error(
        `pre-provisioning the campaign worktree for run '${t.runId}' failed in ` +
          `'${t.repoRoot}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rollback;
}
