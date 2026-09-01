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
