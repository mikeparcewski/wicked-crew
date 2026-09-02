/**
 * Post-hoc delivery (crew#393): run the SAME hardened deliver script the deliver phase runs
 * (`core/deliver.ts`, crew#293/#317) against a completed run's existing worktree — the recovery
 * path for a run whose reviewable work was left stranded (completed, repo-scoped, no PR).
 *
 * ONE script, two entry points. The deliver PHASE is `bash -lc <script>` spawned by the engine's
 * `run_tool_cmd` inside the run worktree; this module is the daemon spawning the identical
 * invocation itself, because a post-hoc lift has no phase to ride. Everything the script
 * hardened — commit the run's work, refuse the default branch, rebase onto origin's default
 * branch with a LOUD abort on conflict, never force, push, `gh pr create` with output and status
 * captured separately, success re-derived from a real PR URL — is therefore hardened here too,
 * by construction rather than by copy.
 *
 * The exit status + merged output travel back verbatim: the ROUTE decides what they mean
 * (non-zero ⇒ a loud 4xx carrying the script's own words; zero ⇒ the PR URL is re-extracted
 * crew-side via `prUrlFrom`, the same grep the script itself ends with).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deliverPrScript } from '../core/deliver.js';

/** What one spawn of the deliver script produced: its exit status and merged output. */
export interface DeliverScriptResult {
  /** 0 = the script itself reported a delivery; anything else is the script's loud refusal. */
  status: number;
  /** stdout + stderr, chronological (the script folds stderr into stdout itself: `exec 2>&1`). */
  output: string;
  /** True when the SCRIPT never ran to its own verdict — a spawn failure (ENOENT) or the
   *  timeout kill. The route answers 500 (infra fault, retryable), never the refusal 409. */
  spawnFailure?: boolean;
}

/** The exec seam the deliver route runs the script through — injectable so route tests can
 *  point HOME/PATH at a fixture (a stub `gh`, a temp home) without touching the daemon env. */
export type DeliverExec = (workdir: string, intent?: string) => Promise<DeliverScriptResult>;

/** A worktree stood back up from a run's `wicked/<id>` branch, plus its teardown (crew#418). */
export interface ReprovisionedWorktree {
  /** The path to deliver in — a throwaway checkout of `wicked/<runId>`. */
  workdir: string;
  /** Remove the throwaway worktree; the `wicked/<runId>` branch (the record) survives. */
  cleanup: () => Promise<void>;
}

/** The reprovision seam (crew#418) — injectable so route tests never shell out to git. Resolves
 *  to a throwaway worktree checked out on the run's branch, or `null` when the branch is gone. */
export type WorktreeReprovisioner = (
  repoRoot: string,
  runId: string,
) => Promise<ReprovisionedWorktree | null>;

/**
 * Stand a run's committed work back up from its `wicked/<runId>` branch (crew#418).
 *
 * The engine REAPS a failed-deliver run's worktree once the deliver phase has committed the work
 * (a clean tree; `git worktree remove` succeeds even with the branch ahead) — the work then lives
 * ONLY on the `wicked/<runId>` branch, which the reap never deletes ("the checkout is scaffolding,
 * the branch is the record"). A post-hoc lift therefore has no worktree to run in; this checks the
 * branch out at a THROWAWAY path so the hardened deliver script can commit-nothing / rebase / push
 * it. The path's basename is deliberately NOT the run id, so the script's branch derivation falls
 * back to `git branch --show-current` — which the checkout puts on `wicked/<runId>` — instead of
 * `wicked/<basename>`. Never touches the engine's recorded worktree path, so it cannot race the
 * engine's own worktree bookkeeping.
 *
 * Resolves `null` when the branch does not exist (nothing to reprovision) — the caller then
 * answers the same "nothing to deliver" refusal as a truly empty run.
 */
export const gitReprovisionWorktree: WorktreeReprovisioner = async (repoRoot, runId) => {
  const branch = `wicked/${runId}`;
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile('git', ['-C', repoRoot, ...args], { windowsHide: true }, (err) =>
        err === null ? resolve() : reject(err),
      );
    });
  const dir = await mkdtemp(join(tmpdir(), `wicked-deliver-${runId.replace(/[^\w.-]/g, '_')}-`));
  // Is the run's branch even there? Absent ⇒ the work is genuinely GONE → null (the route answers
  // 409 "nothing to deliver"). This is the ONLY reason to report null: an OPERATIONAL git failure
  // below (permissions, corruption, a busy repo) must surface as an error, not be misreported as
  // "gone" — so it is left to throw and the route answers 500.
  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
  try {
    // Drop any dangling admin entry the reap left, THEN check the branch out at the empty temp dir
    // (`git worktree add` accepts an existing empty directory).
    await run(['worktree', 'prune']);
    await run(['worktree', 'add', dir, branch]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err; // operational failure standing the worktree up — NOT "gone"
  }
  return {
    workdir: dir,
    cleanup: async () => {
      await run(['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
};

/** Everything the script prints stays bounded — 8 MiB is far past any real transcript. */
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

/** A post-hoc lift talks to a real remote; 5 minutes is generous, hanging forever is not. */
const SCRIPT_TIMEOUT_MS = 5 * 60_000;

/**
 * The production {@link DeliverExec}: `bash -lc <script>` in the run's worktree — the exact
 * invocation core's `run_tool_cmd` uses for the deliver phase (login shell, so the operator's
 * PATH — where `gh` lives — is loaded). `env` overlays the daemon's own environment; tests use
 * it to substitute HOME (whose `.bash_profile` prepends a stub `gh`), production passes none.
 */
export function runDeliverScript(
  workdir: string,
  intent?: string,
  env?: Record<string, string>,
): Promise<DeliverScriptResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-lc', deliverPrScript(intent)],
      {
        cwd: workdir,
        env: { ...process.env, ...env },
        maxBuffer: OUTPUT_CAP_BYTES,
        timeout: SCRIPT_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        // The script folds stderr into stdout (`exec 2>&1`), but bash itself (a spawn failure,
        // a timeout kill) can still write stderr — append it so the route's error names it.
        const output = `${stdout ?? ''}${stderr ?? ''}`;
        if (err === null) {
          resolve({ status: 0, output });
          return;
        }
        const { code, killed } = err as { code?: unknown; killed?: boolean };
        // A non-numeric code (ENOENT) or a kill (the timeout) means the script never reached
        // its own verdict — mark it so the route answers 500, not the script-refusal 409.
        // Surface the error's own message in the output so the response is never blank.
        resolve({
          status: typeof code === 'number' ? code : 1,
          output: output !== '' ? output : (err as Error).message,
          spawnFailure: typeof code !== 'number' || killed === true,
        });
      },
    );
  });
}
