/**
 * crew#1779: the one-run reads an engine frame's listeners start, kept behind the reads a request makes.
 *
 * Every one-run read (`CoreAdapter.runView`, the engine's `sessionDetail`) is served one at a time on the
 * engine's single read connection, and each one holds a libuv worker while it waits. A run end hands its
 * frame to about eight listeners (the archive, the project pointer, considerations, learnings, test sets,
 * delivery...), and each used to read that run on its own, so under steady run churn those reads queued
 * ahead of a person's gate read and starved `/health` of workers.
 *
 * So a read started inside a frame listener (anything that runs in {@link RunReadLane.inFrame}'s async
 * context) goes through a lane: at most {@link FRAME_READ_WIDTH} in flight, never two of the same run at
 * once, and every queued read of a run id shares the ONE read the lane starts next for it (on the next turn of
 * the loop, so the listeners of one frame have all queued by then). Each of those
 * callers queued before that read started, so the read is never older than the frame (or the change)
 * that caller saw. A request's read never waits in the lane. A bounded FIFO for every read was measured
 * and dropped in crew#1777: there, gate reads queued behind run-end reads.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** How many frame-started one-run reads may be in flight at once. */
export const FRAME_READ_WIDTH = 2;

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export class RunReadLane<T> {
  private readonly frameScope = new AsyncLocalStorage<true>();
  /** Run id -> the callers waiting for the next read of it (insertion order = the lane's order). */
  private readonly queued = new Map<string, Array<Waiter<T>>>();
  private readonly running = new Set<string>();

  constructor(
    private readonly read: (runId: string) => Promise<T>,
    private readonly width: number = FRAME_READ_WIDTH,
  ) {}

  /** Run `fn` (a frame's listeners) so every one-run read it starts, now or later in its async chain, takes the lane. */
  inFrame<R>(fn: () => R): R {
    return this.frameScope.run(true, fn);
  }

  /** One run's read: straight through for a request, through the lane for a frame listener. */
  get(runId: string): Promise<T> {
    if (this.frameScope.getStore() !== true) return this.read(runId);
    return new Promise<T>((resolve, reject) => {
      const waiters = this.queued.get(runId);
      if (waiters !== undefined) waiters.push({ resolve, reject });
      else this.queued.set(runId, [{ resolve, reject }]);
      this.schedule();
    });
  }

  /** The lane starts its next reads on the next turn of the loop, so every listener of a frame has queued first. */
  private scheduled = false;
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  /** Reads queued or in flight now (for tests and diagnostics). */
  get pending(): { queued: number; running: number } {
    return { queued: this.queued.size, running: this.running.size };
  }

  private pump(): void {
    for (const [runId, waiters] of this.queued) {
      if (this.running.size >= this.width) return;
      if (this.running.has(runId)) continue;
      this.queued.delete(runId);
      this.running.add(runId);
      // Out of the frame's scope: the read itself is not a listener's.
      this.frameScope.exit(() => {
        void Promise.resolve()
          .then(() => this.read(runId))
          .then(
            (value) => {
              for (const w of waiters) w.resolve(value);
            },
            (err: unknown) => {
              for (const w of waiters) w.reject(err);
            },
          )
          .finally(() => {
            this.running.delete(runId);
            this.schedule();
          });
      });
    }
  }
}
