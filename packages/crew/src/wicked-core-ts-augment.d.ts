// Augments the published wicked-core-ts 0.1.0 with fields added after that release
// but not yet published to npm. Remove this file once wicked-core-ts >= 0.1.1 is on npm.
export {};
declare module 'wicked-core-ts' {
  interface LaunchOptions {
    workflow?: string;
    /** (program DES-POWER-MODE) Launch in power mode; only on an addon with `Core.supportsPowerMode`. */
    power?: boolean;
    /** DES-PROJECT-001 §2.2 — file the run into a project (attached atomically with the launch). */
    projectId?: string;
  }
  interface Core {
    /**
     * Inject an operator message into active PTY worker(s) for `runId`.
     * `target` is `"all"` (broadcast) or a CLI key (single session).
     * Resolves to `"ok"` when the command has been queued.
     */
    injectWorkerMessage(runId: string, message: string, target: string): Promise<string>;
    /** (program DES-POWER-MODE) Flip a run's power switch; resolves to its PowerState JSON. */
    setPowerMode?(runId: string, on: boolean, actor: string, reason?: string | null): Promise<string>;
    /** (program DES-POWER-MODE) Raise a power run's rigor; resolves to its PowerState JSON. */
    raiseRigor?(runId: string, atLeast: string, actor: string, reason: string): Promise<string>;
    /** (program DES-POWER-MODE) Answer a checkpoint pause; resolves to its PowerState JSON. */
    answerPowerPause?(runId: string, decision: string, note: string | null | undefined, actor: string): Promise<string>;
  }
}
