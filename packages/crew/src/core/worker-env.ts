/**
 * Worker environment defaults the daemon sets once at boot (crew#844).
 *
 * Every worker the engine spawns inherits the daemon's environment (wicked-core strips a
 * targeted list — forge credentials, the estate db — never `env_clear`s), so a variable set here
 * reaches every seat CLI and the ACP bridges that host them.
 *
 * ## Foreground-only evidence
 *
 * A claude creator could end its turn with its test suites still running as background tasks
 * (`run_in_background`, auto-backgrounding): the turn closed, the adapter booked it, and the
 * suite's result never reached the attempt record — 3 of 7 attempts on run ad5a4ca7 after an
 * explicit "foreground runs only" instruction. The bridge has no view of the worker's pending
 * tasks, so the reliable fix is that there are none: Claude Code's documented
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns off `run_in_background` on Bash and subagent
 * tools, auto-backgrounding and Ctrl+B. A governed turn then cannot end before the commands it
 * started have finished, and their exit codes are in the transcript the reviewer reads.
 *
 * An operator's own value always wins (`0` opts out); the daemon never overwrites it.
 */

/** Claude Code's switch for all background-task functionality. */
export const DISABLE_BACKGROUND_TASKS_ENV = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

/**
 * Default `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for every worker (idempotent). Returns the
 * value in force and whether the daemon set it (`false` = the operator's own value).
 */
export function ensureForegroundOnlyWorkers(env: NodeJS.ProcessEnv = process.env): { value: string; defaulted: boolean } {
  const current = env[DISABLE_BACKGROUND_TASKS_ENV];
  if (current !== undefined && current !== '') return { value: current, defaulted: false };
  env[DISABLE_BACKGROUND_TASKS_ENV] = '1';
  return { value: '1', defaulted: true };
}
