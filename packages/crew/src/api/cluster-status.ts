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
import { redactString } from '../mcp/redact.js';
import { homeless } from './seat-standing.js';
import { scrubHomePaths } from './ui-text.js';
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
/** Credential spellings an upstream diagnostic (kubectl, a webhook, the engine) can carry beyond the
 *  shapes `redactString` knows: an Authorization header of any scheme, a credential-named field in
 *  JSON or YAML spelling, and URL userinfo. */
const CREDENTIAL_SPELLINGS: ReadonlyArray<[RegExp, string]> = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z]+\s+[^\s,;"']+|[^\s,;"']+)/gi, '$1: [REDACTED]'],
  [/(["']?)\b(token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|api[_-]?key|private[_-]?key)\1(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi, '$1$2$1$3[REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
];

/** Engine (or kubectl) words as they may cross the wire, whole text: credentials redacted and every
 *  home path (this user's, a foreign or a JSON-escaped one) spelled `~`, before anything is cut. */
export function publicText(raw: string): string {
  let out = redactString(raw);
  for (const [re, to] of CREDENTIAL_SPELLINGS) out = out.replace(re, to);
  return homeless(scrubHomePaths(out.replace(/\\\\/g, '\\')));
}

/** One line of {@link publicText}, bounded (sanitized BEFORE the cut, so a cut never exposes a prefix). */
export function publicLine(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const line = publicText(v).split(/[\r\n]/, 1)[0]?.trim() ?? '';
  if (line === '') return null;
  return line.length <= DETAIL_MAX ? line : `${line.slice(0, DETAIL_MAX - 1)}…`;
}
const words = publicLine;
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

/** Single-flight reader shared by `/system` and `/diagnostics`. The flight is the engine process
 *  itself, not a caller's wait: a caller that gives up (its own, shorter bound) leaves the one process
 *  running, and the next caller joins it rather than starting another. The process is bounded by the
 *  exec's own timeout ({@link CLUSTER_TIMEOUT_MS}), which kills it. */
export class ClusterStatusReader {
  private running: Promise<ClusterStatus> | null = null;

  constructor(private readonly input: () => ClusterReadInput) {}

  /** Settle within `boundMs` (default and maximum: {@link CLUSTER_TIMEOUT_MS}). */
  read(boundMs: number = CLUSTER_TIMEOUT_MS): Promise<Settled<ClusterStatus>> {
    if (this.running === null) {
      const run = readClusterStatus(this.input());
      this.running = run;
      // Cleared only when the process has really ended (a timed-out wait does not end it).
      run.then(() => undefined, () => undefined).finally(() => { if (this.running === run) this.running = null; });
    }
    const run = this.running;
    return settleWithin(() => run, Math.max(0, Math.min(boundMs, CLUSTER_TIMEOUT_MS)));
  }
}

/** `/diagnostics.cluster`: the document, or why there is none. */
export function clusterDiagnostics(read: Settled<ClusterStatus>): (ClusterStatus & { read: 'ok' }) | { read: 'timeout' | 'error'; detail: string } {
  if (read.kind === 'ok') return { ...read.value, read: 'ok' };
  if (read.kind === 'timeout') return { read: 'timeout', detail: `no answer within ${Math.max(1, Math.round(read.ms / 1000))} s` };
  return { read: 'error', detail: publicLine(read.full ?? read.error) ?? 'the cluster could not be read' };
}

const INSTALL = 'Run `wicked-core cluster install --admin-context <your cluster context> --home <this daemon\'s state home>`, then re-check.';
const BY_HAND = 'Re-check; if it persists, run `wicked-core cluster status --home <this daemon\'s state home>` by hand.';
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
    // The wait this caller gave it (the snapshot's remaining budget can be shorter than the engine's bound).
    const waited = Math.max(1, Math.round(read.ms / 1000));
    const why = `the cluster did not answer within ${waited} s`;
    return {
      cluster: infraRow('cluster', 'unknown', why, 'Re-check; a loaded host can slow kubectl down.', startedAt, {}, read.ms),
      gateway: infraRow('gateway', 'unknown', `${why}, so the gateway could not be read`, 'Re-check.', startedAt, {}, read.ms),
    };
  }
  if (read.kind === 'error') {
    const why = publicLine(read.full ?? read.error) ?? 'no answer';
    return {
      cluster: infraRow('cluster', 'unknown', `the cluster could not be read: ${why}`, BY_HAND, startedAt, { error: why }),
      gateway: infraRow('gateway', 'unknown', 'the cluster could not be read, so neither could the gateway', 'Re-check.', startedAt),
    };
  }
  const s = read.value;
  const d = detailsOf(s);
  if (!s.configured) {
    return {
      cluster: infraRow('cluster', 'down', 'no Kubernetes cluster is configured for this daemon, so governed seats cannot start', INSTALL, startedAt, d),
      gateway: infraRow('gateway', 'down', 'no cluster is configured, so there is no gateway', INSTALL, startedAt, d),
    };
  }
  const ctx = s.context !== null ? ` (context ${s.context})` : '';
  if (!s.reachable) {
    // The API did not answer: pods already running (the gateway among them) may still serve, so the
    // gateway is unobserved, not stopped.
    return {
      cluster: infraRow('cluster', 'down', `Kubernetes isn't answering${ctx}, so no seat can start`, START, startedAt, d),
      gateway: infraRow('gateway', 'unknown', "the cluster isn't answering, so the gateway could not be read", START, startedAt, d),
    };
  }
  // Each row from its own evidence: a known controller failure is never hidden by an unread gateway,
  // nor a serving gateway by an unread controller.
  const counted = (n: number | null, one: string, many: string): string | null => (n === null ? null : `${n} ${n === 1 ? one : many}`);
  const load = [
    counted(s.runNamespaces, 'run namespace', 'run namespaces') ?? 'run namespaces not counted',
    s.pendingPods === null ? 'pending pods not counted' : s.pendingPods > 0 ? counted(s.pendingPods, 'pod waiting to start', 'pods waiting to start') : null,
  ].filter((x): x is string => x !== null).join(', ');
  const cluster = s.controller === null
    ? infraRow('cluster', 'degraded', `answers${ctx}, but its sandbox controller could not be read${s.detail !== null ? `: ${s.detail}` : ''}`, BY_HAND, startedAt, d)
    : !s.controller.ready
      ? infraRow('cluster', 'down', `answers${ctx}, but its sandbox controller isn't ready${s.controller.detail !== null ? ` (${s.controller.detail})` : ''}: missing, still starting or not the pinned version, so no seat can be created`, `If it stays so, ${INSTALL.charAt(0).toLowerCase()}${INSTALL.slice(1)}`, startedAt, d)
      : s.detail !== null
        ? infraRow('cluster', 'degraded', `ready${ctx}, but part of it could not be read: ${s.detail}`, BY_HAND, startedAt, d)
        : infraRow('cluster', 'ok', `ready${ctx}: ${load}`, null, startedAt, d);
  const gateway = s.gateway === null
    ? infraRow('gateway', 'unknown', 'the cluster answered, but the gateway could not be read', BY_HAND, startedAt, d)
    : s.gateway === 'serving'
      ? infraRow('gateway', 'ok', 'serving (in the cluster)', null, startedAt, d)
      : s.gateway === 'starting'
        ? infraRow('gateway', 'degraded', 'starting: its pod is not serving yet', 'Re-check in a minute; a run waits for it.', startedAt, d)
        : s.gateway === 'stopped'
          ? infraRow('gateway', 'down', 'stopped: scaled to no replicas (a quarantine), so seats have no route to their models', 'The engine starts it again before the next seat runs; a run that cannot says why on its gate.', startedAt, d)
          : infraRow('gateway', 'degraded', 'not started yet: the engine starts it before the first seat runs', 'Nothing to do unless a run is waiting on it; a run that cannot start its gateway says why on its gate.', startedAt, d);
  return { cluster, gateway };
}
