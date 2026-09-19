import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * Best-effort post-delivery worktree sweep (crew#620 — Acceptance 3).
 *
 * Removes the run's worktree (`<repoRoot>/wicked-worktrees/<runId>`) and prunes stale
 * worktree entries from the registered repo. Called ONLY when the run is confirmed delivered
 * (PR open); never for cancelled or failed runs.
 *
 * Never throws — all outcomes (removed / not-present / git-error) are logged. The diff
 * endpoint falls back to the run branch when the worktree is gone (F-7R2-013).
 */
export async function sweepDeliveredWorktree(
  runId: string,
  repoRoot: string,
  log: (m: string) => void,
): Promise<void> {
  const worktreePath = join('wicked-worktrees', runId);
  await new Promise<void>((resolve) => {
    execFile('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], (err) => {
      if (err !== null) {
        if (/not.*working tree|is not a working tree|no such worktree/i.test(err.message)) {
          log(`[runs] worktree sweep: ${runId} not present — nothing to remove`);
        } else {
          log(`[runs] worktree sweep: remove error for ${runId}: ${err.message}`);
        }
      } else {
        log(`[runs] worktree sweep: removed ${runId}`);
      }
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    execFile('git', ['-C', repoRoot, 'worktree', 'prune'], (err) => {
      if (err !== null) {
        log(`[runs] worktree sweep: prune error: ${err.message}`);
      }
      resolve();
    });
  });
}
