import { execCapped } from '../core/exec.js';
import { resolveContainerRuntime } from './system-snapshot.js';
import type { ExecLike } from './seat-container-login.js';

/** Consecutive failed checks before an `up` runtime reads `down`. */
export const DOWN_AFTER_MISSES = 2;

export type ContainerRuntimeState = 'up' | 'down' | 'unknown';
export interface RuntimeStateReader {
  state(): ContainerRuntimeState;
  onChange(cb: (next: ContainerRuntimeState, previous: ContainerRuntimeState) => void): () => void;
}

export interface RuntimeStateDeps {
  exec?: ExecLike;
  env?: NodeJS.ProcessEnv;
  runtime?: () => string | null;
  intervalMs?: number;
}

/** Runtime reachability is independent of broker credentials. Probe off the request path every
 *  ten seconds, including without roster traffic, so recovery also refreshes seat standing. */
export class RuntimeState implements RuntimeStateReader {
  private current: ContainerRuntimeState = 'unknown';
  private readonly listeners = new Set<(next: ContainerRuntimeState, previous: ContainerRuntimeState) => void>();
  private readonly timer: NodeJS.Timeout;
  private readonly initial: NodeJS.Immediate;
  private pending: Promise<void> | undefined;
  private closed = false;
  /** Consecutive failed checks: a busy host can miss one bounded check while Docker is fine. */
  private misses = 0;

  constructor(private readonly deps: RuntimeStateDeps = {}) {
    this.initial = setImmediate(() => { void this.refresh(); });
    this.initial.unref();
    this.timer = setInterval(() => { void this.refresh(); }, deps.intervalMs ?? 10_000);
    this.timer.unref();
  }

  state(): ContainerRuntimeState { return this.current; }

  onChange(cb: (next: ContainerRuntimeState, previous: ContainerRuntimeState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending !== undefined) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      let next: ContainerRuntimeState = 'down';
      try {
        const env = this.deps.env ?? process.env;
        const runtime = this.deps.runtime !== undefined ? this.deps.runtime() : resolveContainerRuntime(env);
        if (runtime !== null) {
          const out = await (this.deps.exec ?? execCapped)(runtime, ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000, env });
          if (out.stdout.trim() !== '') next = 'up';
        }
      } catch { /* A missing CLI, timeout or unreachable server is unavailable. */ }
      // Down takes two misses in a row (one check on a loaded laptop can time out with Docker up, and
      // a false "down" benches every container seat); up takes one answer.
      this.misses = next === 'down' ? this.misses + 1 : 0;
      if (next === 'down' && this.misses < DOWN_AFTER_MISSES && this.current === 'up') return;
      if (this.closed || next === this.current) return;
      const previous = this.current;
      this.current = next;
      for (const cb of this.listeners) cb(next, previous);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  close(): void {
    this.closed = true;
    clearImmediate(this.initial);
    clearInterval(this.timer);
    this.listeners.clear();
  }
}
