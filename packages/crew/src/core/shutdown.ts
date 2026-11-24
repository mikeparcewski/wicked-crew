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

/** The engine's static stop for install-time editor conformance (wicked-core#1830, `Core.shutdownEditorConformance`):
 *  absent on an addon that predates it. */
export interface ConformanceStopper {
  shutdownEditorConformance?: () => string;
}

export interface DaemonShutdownDeps {
  /** Where the signal and exit handlers are registered (`process.on`). */
  on: (event: 'SIGTERM' | 'SIGINT' | 'exit', fn: () => void) => void;
  core: ConformanceStopper;
  /** Reap the bridge children (`bridgeReaper.shutdown`). */
  reap: () => Promise<void>;
  /** The synchronous reap an `exit` handler can still do (`bridgeReaper.sweepSync`). */
  sweepSync: () => void;
  /** Close the engine subscription. */
  close: () => void;
  exit: (code: number) => void;
  /** Called on each signal before anything else (the signal log, the exit reason). */
  onSignal?: (signal: 'SIGTERM' | 'SIGINT') => void;
  deadlineMs?: number;
}

/**
 * (crew#1835) Stop the engine's install-time conformance runs. The harness runs in its own process group, so nothing else
 * the daemon does on its way out reaches it: without this its jailed browser runs on to its deadline (up to 900 s). The
 * call is synchronous and waits at most 5 s; a later install call is refused. Best-effort: it never blocks the exit.
 */
function stopConformance(core: ConformanceStopper): void {
  try {
    core.shutdownEditorConformance?.();
  } catch {
    /* best-effort: a failed stop never blocks the exit */
  }
}

/**
 * The daemon's SIGTERM / SIGINT / exit handlers (`serve`). A signal runs the graceful steps once, under
 * {@link shutdownWithDeadline}: the conformance harness is stopped first (it is the longest-lived child and the call is
 * quick when nothing is in flight), then the bridge children are reaped and the engine subscription closed. A plain
 * exit stops the harness too, beside the synchronous bridge sweep.
 */
export function installDaemonShutdown(deps: DaemonShutdownDeps): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownWithDeadline(async () => {
      stopConformance(deps.core);
      // Reap bridge children BEFORE this process goes away — the last actor that can still find them. Best-effort.
      try {
        await deps.reap();
      } catch {
        /* reaping is best-effort */
      }
      // Close the single subscription so the pump thread + tsfn release and the process can exit on its own.
      try {
        deps.close();
      } catch {
        /* already closed */
      }
    }, deps.exit, deps.deadlineMs);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    deps.on(signal, () => {
      deps.onSignal?.(signal);
      shutdown();
    });
  }
  // Normal exit (`process.exit` anywhere, main() falling off): an 'exit' handler cannot await, so this is the synchronous
  // sweep. After the graceful path above it is a no-op re-scan; on a plain exit it is the only reaping that happens.
  deps.on('exit', () => {
    stopConformance(deps.core);
    deps.sweepSync();
  });
}
