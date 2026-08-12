// Augments the published wicked-core-ts 0.1.0 with fields added after that release
// but not yet published to npm. Remove this file once wicked-core-ts >= 0.1.1 is on npm.
export {};
declare module 'wicked-core-ts' {
  interface LaunchOptions {
    workflow?: string;
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
  }
}
