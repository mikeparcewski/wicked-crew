/**
 * The daemon's Kubernetes cluster, as the engine reads it (wicked-core `cluster status --json`, k8s
 * runner B-5): the `cluster` row of the Nerve Center (`GET /system`), the gateway row (the model
 * gateway is a Deployment in the daemon's namespace now, not a container), `GET /diagnostics.cluster`
 * and the roster's reachability check (`runtime-state.ts`).
 *
 * The engine owns the reading: it uses its own scoped account (`<state home>/k8s/kubeconfig`),
 * never the operator's current context, so crew runs the engine's CLI with `--home <state home>`
 * rather than spelling kubectl itself. Reads are single-flight (each is several kubectl calls, and a
 * studio poll can read `/system` and `/diagnostics` at once), never cached: a Re-check is fresh.
 */
import type { SystemInfraRow } from '../core/types.js';
import { homeless } from './seat-standing.js';
import { infraRow, settleWithin, type Settled } from './system-snapshot.js';

/** One read's bound: `cluster status` is a `kubectl version` plus a few list calls (inside the
 *  snapshot's 8 s budget). */
export const CLUSTER_TIMEOUT_MS = 6_000;

export type ClusterGateway = 'serving' | 'starting' | 'stopped' | 'absent';

/** `wicked-core cluster status --json`, only the fields crew reads (picked one by one). */
export interface ClusterStatus {
  configured: boolean;
  reachable: boolean;
  /** Why it is not configured or not reachable: `no_cluster`, `cluster_unreachable`, … */
  kind: string | null;
  context: string | null;
  controller: { ready: boolean; detail: string | null } | null;
  controllerVersion: string | null;
  gateway: ClusterGateway | null;
  runNamespaces: number | null;
  pendingPods: number | null;
  /** The engine's own words when a read failed part-way (home paths spelled `~`). */
  detail: string | null;
}

type ClusterExec = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;

const DETAIL_MAX = 240;
const words = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const line = homeless(v.split(/[\r\n]/, 1)[0]?.trim() ?? '');
  return line.length <= DETAIL_MAX ? line : `${line.slice(0, DETAIL_MAX - 1)}…`;
};
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Parse the engine's status document; `null` when stdout is not one. */
export function parseClusterStatus(stdout: string): ClusterStatus | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch { return null; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['configured'] !== 'boolean' || typeof o['reachable'] !== 'boolean') return null;
  const c = o['controller'] as Record<string, unknown> | null | undefined;
  const gw = o['gateway'];
  return {
    configured: o['configured'],
    reachable: o['reachable'],
    kind: typeof o['kind'] === 'string' && /^[a-z_]{1,40}$/.test(o['kind']) ? o['kind'] : null,
    context: words(o['context']),
    controller: c !== null && typeof c === 'object' && typeof c['ready'] === 'boolean' ? { ready: c['ready'], detail: words(c['detail']) } : null,
    controllerVersion: words(o['controllerVersion']),
    gateway: gw === 'serving' || gw === 'starting' || gw === 'stopped' || gw === 'absent' ? gw : null,
    runNamespaces: count(o['runNamespaces']),
    pendingPods: count(o['pendingPods']),
    detail: words(o['detail']),
  };
}

export interface ClusterReadInput {
  /** The engine CLI (`WICKED_CORE_EXE`); `null` when crew was started without one. */
  exe: string | null;
  /** The daemon's state home (the `--db` parent); `null` on a route set without a store. */
  home: string | null;
  exec: ClusterExec;
  timeoutMs?: number;
}

/** Run `cluster status --json` once. It exits 1 with a document when the cluster is not configured
 *  or does not answer, so a failed exit's stdout is read too; no document at all throws. */
export async function readClusterStatus(input: ClusterReadInput): Promise<ClusterStatus> {
  if (input.exe === null) throw new Error('the engine CLI (WICKED_CORE_EXE) is not set, so the cluster cannot be read');
  if (input.home === null) throw new Error('this daemon has no state home to read its cluster from');
  const args = ['cluster', 'status', '--json', '--home', input.home];
  let stdout: string;
  try {
    stdout = (await input.exec(input.exe, args, { timeout: input.timeoutMs ?? CLUSTER_TIMEOUT_MS })).stdout;
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    const doc = typeof out === 'string' ? parseClusterStatus(out) : null;
    if (doc !== null) return doc;
    throw err;
  }
  const doc = parseClusterStatus(stdout);
  if (doc === null) throw new Error('the engine answered `cluster status` with something that is not a status document');
  return doc;
}

/** Single-flight reader shared by `/system` and `/diagnostics`: concurrent callers share one read. */
export class ClusterStatusReader {
  private inflight: Promise<Settled<ClusterStatus>> | null = null;

  constructor(private readonly input: () => ClusterReadInput) {}

  read(): Promise<Settled<ClusterStatus>> {
    if (this.inflight !== null) return this.inflight;
    const input = this.input();
    this.inflight = settleWithin(() => readClusterStatus(input), input.timeoutMs ?? CLUSTER_TIMEOUT_MS)
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** `/diagnostics.cluster`: the document, or why there is none. */
export function clusterDiagnostics(read: Settled<ClusterStatus>): (ClusterStatus & { read: 'ok' }) | { read: 'timeout' | 'error'; detail: string } {
  if (read.kind === 'ok') return { ...read.value, read: 'ok' };
  if (read.kind === 'timeout') return { read: 'timeout', detail: `no answer within ${Math.round(CLUSTER_TIMEOUT_MS / 1000)} s` };
  return { read: 'error', detail: read.error };
}

const INSTALL = 'Run `wicked-core cluster install --admin-context <your cluster context> --home <this daemon\'s state home>`, then re-check.';
const START = 'Start Rancher Desktop (or Docker Desktop) with Kubernetes on, then re-check.';

function detailsOf(s: ClusterStatus): Record<string, unknown> {
  return {
    configured: s.configured, reachable: s.reachable, kind: s.kind, context: s.context,
    controllerReady: s.controller?.ready ?? null, controllerVersion: s.controllerVersion,
    gateway: s.gateway, runNamespaces: s.runNamespaces, pendingPods: s.pendingPods,
  };
}

/** The `cluster` and `gateway` rows from one read. Off the container floor both are `off`. */
export function clusterRows(read: Settled<ClusterStatus> | null, containerFloor: boolean, startedAt: number): { cluster: SystemInfraRow; gateway: SystemInfraRow } {
  if (!containerFloor || read === null) {
    const why = 'not used: seats run on the host floor, not in pods';
    return {
      cluster: infraRow('cluster', 'off', why, null, startedAt, { floor: 'host' }),
      gateway: infraRow('gateway', 'off', 'not used: seats run on the host floor, not in containers', null, startedAt, { floor: 'host' }),
    };
  }
  if (read.kind === 'timeout') {
    const why = `the cluster did not answer within ${Math.round(CLUSTER_TIMEOUT_MS / 1000)} s`;
    return {
      cluster: infraRow('cluster', 'unknown', why, 'Re-check; a loaded host can slow kubectl down.', startedAt, {}, CLUSTER_TIMEOUT_MS),
      gateway: infraRow('gateway', 'unknown', `${why}, so the gateway could not be read`, 'Re-check.', startedAt, {}, CLUSTER_TIMEOUT_MS),
    };
  }
  if (read.kind === 'error') {
    return {
      cluster: infraRow('cluster', 'unknown', `the cluster could not be read: ${read.error}`, 'Re-check; if it persists, run `wicked-core cluster status` by hand.', startedAt, { error: read.error }),
      gateway: infraRow('gateway', 'unknown', 'the cluster could not be read, so neither could the gateway', 'Re-check.', startedAt),
    };
  }
  const s = read.value;
  const d = detailsOf(s);
  const gatewayDown = (why: string, fix: string) => infraRow('gateway', 'down', why, fix, startedAt, d);
  if (!s.configured) {
    return {
      cluster: infraRow('cluster', 'down', 'no Kubernetes cluster is configured for this daemon, so governed seats cannot start', INSTALL, startedAt, d),
      gateway: gatewayDown('no cluster is configured, so there is no gateway', INSTALL),
    };
  }
  const ctx = s.context !== null ? ` (context ${s.context})` : '';
  if (!s.reachable) {
    return {
      cluster: infraRow('cluster', 'down', `Kubernetes isn't answering${ctx}, so governed seats cannot start`, START, startedAt, d),
      gateway: gatewayDown("the cluster isn't answering, so the gateway can't serve", START),
    };
  }
  if (s.controller === null || s.gateway === null) {
    const why = s.detail ?? 'the engine could not read its objects';
    return {
      cluster: infraRow('cluster', 'degraded', `answers${ctx}, but its objects could not be read: ${why}`, 'Re-check; if it persists, run `wicked-core cluster status` by hand.', startedAt, d),
      gateway: infraRow('gateway', 'unknown', 'the cluster answered, but the gateway could not be read', 'Re-check.', startedAt, d),
    };
  }
  const pending = s.pendingPods ?? 0;
  const runs = s.runNamespaces ?? 0;
  const load = `${runs} run namespace${runs === 1 ? '' : 's'}${pending > 0 ? `, ${pending} pod${pending === 1 ? '' : 's'} waiting to start` : ''}`;
  const cluster = s.controller.ready
    ? infraRow('cluster', 'ok', `ready${ctx}: ${load}`, null, startedAt, d)
    : infraRow('cluster', 'down', `the agent-sandbox controller isn't ready${s.controller.detail !== null ? ` (${s.controller.detail})` : ''}, so seats cannot be created`, INSTALL, startedAt, d);
  const gateway = s.gateway === 'serving'
    ? infraRow('gateway', 'ok', 'serving (in the cluster)', null, startedAt, d)
    : s.gateway === 'starting'
      ? infraRow('gateway', 'degraded', 'starting: its pod is not serving yet', 'Re-check in a minute; a run waits for it.', startedAt, d)
      : s.gateway === 'stopped'
        ? gatewayDown('stopped: scaled to no replicas (a quarantine), so seats have no route to their models', 'The engine starts it again before the next seat runs; a run that cannot says why on its gate.')
        : infraRow('gateway', 'degraded', 'not started yet: the engine starts it before the first seat runs', 'Nothing to do unless a run is waiting on it; a run that cannot start its gateway says why on its gate.', startedAt, d);
  return { cluster, gateway };
}
