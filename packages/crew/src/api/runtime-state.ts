import { execCapped } from '../core/exec.js';
import { crewStateHome } from '../projects/state-home.js';
import { readClusterStatus } from './cluster-status.js';
import type { ExecLike } from './seat-container-login.js';

/**
 * Consecutive failed checks before the runtime reads `down`, from any state (e2e-1105 09:02Z: under
 * host load 50-80 one `version` check missed its bound while `docker version` answered by hand, and
 * a false `down` benches every container seat). A runtime that is really down fails each check at
 * once, so `down` lands within about three intervals; a HUNG runtime takes the full bound per check,
 * so about a minute. Later is accepted: a false outage is worse than an honest wait.
 */
export const DOWN_AFTER_MISSES = 3;
/** One check's bound. `cluster status` is the engine's own reachability probe (bounded at 20 s in
 *  wicked-core `k8s::PROBE_TIMEOUT`) plus its inventory list calls, so the bound sits above that probe:
 *  a slow inventory on a loaded laptop is not an outage. A check that overruns even this is a miss. */
export const CHECK_TIMEOUT_MS = 45_000;

/** The words a bench carries for each reason the seats cannot run. */
export const RUNTIME_DOWN_REASON = "Kubernetes isn't running";
export const CONTROLLER_DOWN_REASON = "The cluster's sandbox controller isn't ready";

export type ContainerRuntimeState = 'up' | 'down' | 'unknown';
export interface RuntimeStateReader {
  state(): ContainerRuntimeState;
  /** Why it is down, in the words a bench carries (absent: {@link RUNTIME_DOWN_REASON}). */
  reason?(): string;
  onChange(cb: (next: ContainerRuntimeState, previous: ContainerRuntimeState) => void): () => void;
}

export interface RuntimeStateDeps {
  exec?: ExecLike;
  env?: NodeJS.ProcessEnv;
  /** The engine CLI (default `WICKED_CORE_EXE` from `env`). */
  exe?: () => string | null;
  /** The daemon's state home (default crew's own): the engine reads its cluster credential there. */
  home?: () => string | null;
  intervalMs?: number;
}

/** The seats' runtime is the daemon's Kubernetes cluster (k8s runner): `up` while the engine's
 *  `cluster status` says it is configured and answers. Reachability is independent of broker
 *  credentials. Probe off the request path every ten seconds, including without roster traffic, so
 *  recovery also refreshes seat standing. */
export class RuntimeState implements RuntimeStateReader {
  private current: ContainerRuntimeState = 'unknown';
  private readonly listeners = new Set<(next: ContainerRuntimeState, previous: ContainerRuntimeState) => void>();
  private readonly timer: NodeJS.Timeout;
  private readonly initial: NodeJS.Immediate;
  private pending: Promise<void> | undefined;
  private closed = false;
  /** Consecutive failed checks: a busy host can miss one bounded check while the cluster is fine. */
  private misses = 0;
  private why = RUNTIME_DOWN_REASON;

  constructor(private readonly deps: RuntimeStateDeps = {}) {
    this.initial = setImmediate(() => { void this.refresh(); });
    this.initial.unref();
    this.timer = setInterval(() => { void this.refresh(); }, deps.intervalMs ?? 10_000);
    this.timer.unref();
  }

  state(): ContainerRuntimeState { return this.current; }

  reason(): string { return this.why; }

  onChange(cb: (next: ContainerRuntimeState, previous: ContainerRuntimeState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending !== undefined) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      let next: ContainerRuntimeState = 'down';
      let why = RUNTIME_DOWN_REASON;
      try {
        const env = this.deps.env ?? process.env;
        const exe = this.deps.exe !== undefined ? this.deps.exe() : (env['WICKED_CORE_EXE'] ?? '').trim() || null;
        const home = this.deps.home !== undefined ? this.deps.home() : crewStateHome();
        const exec = this.deps.exec ?? execCapped;
        const doc = await readClusterStatus({ exe, home, exec: (file, args, opts) => exec(file, args, { ...opts, env }), timeoutMs: CHECK_TIMEOUT_MS });
        // A reachable cluster whose controller is known not ready cannot create a seat either; one whose
        // controller could not be read proves neither (it never clears a known controller outage).
        if (doc.configured && doc.reachable && doc.controller === null) return;
        if (doc.configured && doc.reachable && !doc.controller?.ready) why = CONTROLLER_DOWN_REASON;
        else if (doc.configured && doc.reachable) next = 'up';
      } catch { /* No engine CLI, a timeout or no status document is unavailable. */ }
      // Down takes three misses in a row (a check on a loaded laptop can time out with Docker up, and
      // a false "down" benches every container seat); up takes one answer.
      this.misses = next === 'down' ? this.misses + 1 : 0;
      if (next === 'down' && this.misses < DOWN_AFTER_MISSES) return;
      if (this.closed) return;
      if (next === 'down') this.why = why;
      if (next === this.current) return;
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
