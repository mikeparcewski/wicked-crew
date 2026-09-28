/**
 * The daemon's shutdown sequence with a DEADLINE (crew#471).
 *
 * `wicked-crew serve` answered SIGTERM by reaping its bridge children and closing the engine
 * subscription, then exiting. While the engine's actor was busy planning a large launch those
 * steps never finished, so the daemon ignored `pkill` and needed SIGKILL. The steps still run
 * first, best-effort; when they have not finished within the deadline the process exits anyway.
 */

/** How long the graceful half of a shutdown may take before the process exits regardless. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Run `steps`, then `exit(0)`, and `exit(0)` at `deadlineMs` if the steps are still running.
 * A step that throws never blocks the exit. `exit` is called exactly once.
 */
export function shutdownWithDeadline(
  steps: () => Promise<void>,
  exit: (code: number) => void,
  deadlineMs: number = SHUTDOWN_DEADLINE_MS,
  warn: (message: string) => void = (m) => console.warn(m),
): void {
  let exited = false;
  const done = (): void => {
    if (exited) return;
    exited = true;
    exit(0);
  };
  const timer = setTimeout(() => {
    warn(`[daemon] shutdown steps still running after ${deadlineMs} ms — exiting anyway (crew#471)`);
    done();
  }, deadlineMs);
  timer.unref?.();
  void (async () => {
    try {
      await steps();
    } catch {
      /* best-effort: a failed step never blocks the exit */
    }
    clearTimeout(timer);
    done();
  })();
}
