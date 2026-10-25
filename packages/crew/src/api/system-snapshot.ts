/**
 * `GET /api/v1/system` — the Nerve Center snapshot (DES-SYSTEM-VIEW, api-types 0.136.0).
 *
 * One derived, READ-ONLY answer to "is anything stopping work, why, and what fixes it?": the CLIs
 * with their 7-day record, every unfinished run with a COMPUTED liveness, the infrastructure as
 * real probes, the governance instruments, and `attention[]`, the union of every item that needs a
 * look. The honesty rules this module keeps:
 *
 * - every infra row is a probe run for THIS request under a bounded timeout. A probe that does not
 *   answer reads `unknown` with its timeout — never `ok`, and never a cached flag;
 * - `working` needs evidence (an event on the relay or in the durable log, or a busy child process)
 *   inside the quiet threshold; past the stall threshold the run is `stalled`;
 * - a number the daemon cannot count is `null` (or the field is absent where the wire says so);
 * - the whole snapshot answers inside {@link SYSTEM_BUDGET_MS} even when a probe hangs.
 *
 * Everything here is a pure function of injected readers, so the tests drive each state and each
 * liveness verdict from fixtures; `routes.ts` wires the daemon's real readers.
 */

import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { statfs, stat } from 'node:fs/promises';
import { cpus, homedir, loadavg } from 'node:os';
import { delimiter, join } from 'node:path';

import type {
  AcpCliDiagnostics,
  DiagnosticsSeatGovernanceEntry,
  RecordedEvent,
  SeatHealth,
  SessionView,
  SystemAttentionItem,
  SystemCli,
  SystemCliState,
  SystemCliStats,
  SystemGovernanceCard,
  SystemInfraKey,
  SystemInfraRow,
  SystemLevel,
  SystemRun,
  SystemRunLiveness,
  SystemSnapshot,
  SystemState,
  SystemTarget,
} from '../core/types.js';
import { runTouchesWindow } from './seat-record.js';

// ── Bounds ──────────────────────────────────────────────────────────────────

/** The whole snapshot answers within this, even when probes hang. */
export const SYSTEM_BUDGET_MS = 8_000;
/** Each infra probe's own bound. */
export const PROBE_TIMEOUT_MS = 4_000;
/** The 7-day folds are real IO over every recent run's log; they are kept this long (`asOf`). */
export const SYSTEM_STATS_TTL_MS = 30_000;
/** The window the CLI stats and governance cards fold. */
export const SYSTEM_STATS_DAYS = 7;
/** Runs read for the folds at most (newest first), as `GET /roster/record` caps. */
export const SYSTEM_STATS_RUN_CAP = 200;
const DAY_MS = 86_400_000;

export type Settled<T> =
  | { kind: 'ok'; value: T; ms: number }
  | { kind: 'timeout'; ms: number }
  | { kind: 'error'; error: string; ms: number };

/** Run `fn` against `timeoutMs`. A hang settles as `timeout` (the work may continue; nothing waits). */
export async function settleWithin<T>(fn: () => Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout', ms: Date.now() - started }), Math.max(0, timeoutMs));
  });
  const work = Promise.resolve()
    .then(fn)
    .then(
      (value): Settled<T> => ({ kind: 'ok', value, ms: Date.now() - started }),
      (err: unknown): Settled<T> => ({ kind: 'error', error: errText(err), ms: Date.now() - started }),
    );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

function secondsWord(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

function minutesWord(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 6) / 10} h`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ── Infra rows ──────────────────────────────────────────────────────────────

export type ExecLike = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const LABELS: Record<SystemInfraKey, string> = {
  daemon: 'Daemon',
  gateway: 'Model gateway',
  broker: 'Credential broker',
  interactive: 'Interactive bridge',
  estate: 'Estate (memory)',
  bus: 'Event bus',
  vault: 'Vault',
  skills: 'Skills snapshot',
  state_home: 'State home',
  stores: 'Stores',
  seat_floor: 'Seat floor',
  disk: 'Free disk',
  load: 'Host load',
};

export function infraRow(
  key: SystemInfraKey,
  state: SystemState,
  reason: string,
  remedy: string | null,
  startedAt: number,
  details: Record<string, unknown> = {},
  timeoutMs?: number,
): SystemInfraRow {
  const now = Date.now();
  return {
    key,
    label: LABELS[key],
    state,
    reason,
    remedy: state === 'ok' || state === 'off' ? null : remedy,
    checkedAt: iso(now),
    durationMs: Math.max(0, now - startedAt),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    details,
  };
}

/** The engine's gateway container name: `wicked-agw-` + the first 6 bytes (hex) of the SHA-256 of the
 *  gateway directory, exactly `seat_gateway.rs` `gateway_name`. */
export function gatewayName(gatewayDir: string): string {
  return `wicked-agw-${createHash('sha256').update(gatewayDir).digest('hex').slice(0, 12)}`;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The container runtime CLI the engine would use (`container_floor.rs` `runtime_candidates`):
 *  `WICKED_CONTAINER_RUNTIME` (the only candidate when set), else docker / podman / nerdctl on PATH,
 *  else the desktop install dirs. `null` when none is found. */
export function resolveContainerRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = (name: string): string | null => {
    for (const dir of (env['PATH'] ?? '').split(delimiter)) {
      if (dir !== '' && isExecutableFile(join(dir, name))) return join(dir, name);
    }
    return null;
  };
  const choice = (env['WICKED_CONTAINER_RUNTIME'] ?? '').trim();
  if (choice !== '') {
    if (choice.startsWith('/')) return isExecutableFile(choice) ? choice : null;
    return onPath(choice);
  }
  for (const name of ['docker', 'podman', 'nerdctl']) {
    const found = onPath(name);
    if (found !== null) return found;
  }
  const home = env['HOME'] ?? homedir();
  for (const p of [
    join(home, '.rd/bin/docker'),
    join(home, '.orbstack/bin/docker'),
    join(home, '.colima/bin/docker'),
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/opt/homebrew/bin/podman',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ]) {
    if (isExecutableFile(p)) return p;
  }
  return null;
}

export interface GatewayProbeInput {
  /** Whether the container seat floor is on (only then does a gateway exist). */
  containerFloor: boolean;
  /** The engine's gateway dir (canonical state home + `gateway`); `null` without a store. */
  gatewayDir: string | null;
  runtime: string | null;
  exec: ExecLike;
  timeoutMs?: number;
}

/** The model gateway, as the container runtime reports it: `container inspect` of the engine's own
 *  gateway name. Running → ok; stopped → down; absent → degraded (the engine starts it before the
 *  next container seat); the runtime unreachable → down; no answer inside the bound → unknown. */
export async function probeGateway(input: GatewayProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!input.containerFloor) {
    return infraRow('gateway', 'off', 'not used: seats run on the host floor, not in containers', null, started, { floor: 'host' });
  }
  if (input.gatewayDir === null) {
    return infraRow('gateway', 'unknown', 'this daemon has no state home to derive its gateway from', null, started);
  }
  const name = gatewayName(input.gatewayDir);
  if (input.runtime === null) {
    return infraRow(
      'gateway',
      'down',
      'no container runtime (docker, podman or nerdctl) was found, so container seats cannot start',
      'Install or start Docker (or set WICKED_CONTAINER_RUNTIME), then re-check.',
      started,
      { name },
    );
  }
  const details: Record<string, unknown> = { name, runtime: input.runtime };
  const settled = await settleWithin(
    () => input.exec(input.runtime as string, ['container', 'inspect', '--format', '{{.State.Running}}', name], { timeout: timeoutMs }),
    timeoutMs,
  );
  if (settled.kind === 'timeout') {
    return infraRow('gateway', 'unknown', `the container runtime did not answer within ${secondsWord(timeoutMs)}`, 'Check that Docker is responsive, then re-check.', started, details, timeoutMs);
  }
  if (settled.kind === 'ok') {
    const out = settled.value.stdout.trim();
    if (out === 'true') return infraRow('gateway', 'ok', `running (${name})`, null, started, { ...details, running: true }, timeoutMs);
    if (out === 'false') {
      return infraRow(
        'gateway',
        'down',
        `stopped: container ${name} exists but is not running, so container seats have no route to their models`,
        `Start it (\`docker start ${name}\`), or launch a run: the engine restarts its gateway before a seat runs. Then re-check.`,
        started,
        { ...details, running: false },
        timeoutMs,
      );
    }
    return infraRow('gateway', 'unknown', `the runtime answered something unexpected: ${JSON.stringify(out.slice(0, 80))}`, 'Re-check; if it persists, inspect the container by hand.', started, details, timeoutMs);
  }
  const e = settled.error;
  const stderr = e.toLowerCase();
  if (stderr.includes('no such')) {
    return infraRow(
      'gateway',
      'degraded',
      `not started: no container ${name} yet. The engine starts it before the first container seat runs`,
      'Nothing to do unless a run is waiting on it; a run that cannot start its gateway says why on its gate.',
      started,
      { ...details, exists: false },
      timeoutMs,
    );
  }
  if (stderr.includes('enoent')) {
    return infraRow('gateway', 'down', `the container runtime ${input.runtime} could not be run`, 'Install or start Docker (or set WICKED_CONTAINER_RUNTIME), then re-check.', started, details, timeoutMs);
  }
  return infraRow(
    'gateway',
    'down',
    `the container runtime refused: ${e}`,
    'Start Docker (or your container runtime), then re-check. The engine restarts the gateway before the next seat runs.',
    started,
    { ...details, error: e },
    timeoutMs,
  );
}

/** One CLI's credential-broker reading (`seat-login status`, `SeatContainerStatus`). */
export interface BrokerReadingLike {
  state: 'signed_in' | 'signed_out' | 'expired' | 'refresh_failing' | 'unknown';
  reason?: string;
  expires_at?: number;
}

export interface BrokerProbeInput {
  containerFloor: boolean;
  /** The container-login CLIs on the roster. */
  clis: string[];
  /** A FRESH status read for one CLI (never the cache). */
  status: (cli: string) => Promise<BrokerReadingLike>;
  timeoutMs?: number;
}

/** The credential broker, read fresh per CLI. Any refresh failing → degraded; no CLI signed in →
 *  degraded; no CLI answered inside the bound → unknown. */
export async function probeBroker(input: BrokerProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!input.containerFloor) {
    return infraRow('broker', 'off', 'not used: seats sign in on the host floor', null, started);
  }
  if (input.clis.length === 0) {
    return infraRow('broker', 'off', 'no container-login CLI on the roster', null, started);
  }
  const readings = await Promise.all(
    input.clis.map(async (cli) => ({ cli, settled: await settleWithin(() => input.status(cli), timeoutMs) })),
  );
  const byCli: Record<string, unknown> = {};
  const failing: string[] = [];
  const signedIn: string[] = [];
  const answered: string[] = [];
  const silent: string[] = [];
  const unknownWhy: string[] = [];
  for (const { cli, settled } of readings) {
    if (settled.kind === 'timeout') {
      byCli[cli] = { state: 'unknown', reason: `no answer within ${secondsWord(timeoutMs)}` };
      silent.push(cli);
      continue;
    }
    if (settled.kind === 'error') {
      byCli[cli] = { state: 'unknown', reason: settled.error };
      unknownWhy.push(`${cli}: ${settled.error}`);
      continue;
    }
    const r = settled.value;
    byCli[cli] = r;
    if (r.state === 'unknown') {
      unknownWhy.push(`${cli}: ${r.reason ?? 'unknown'}`);
      continue;
    }
    answered.push(cli);
    if (r.state === 'refresh_failing') failing.push(`${cli} (${r.reason ?? 'the last refresh failed'})`);
    if (r.state === 'signed_in' || r.state === 'refresh_failing') signedIn.push(cli);
  }
  const details = { byCli };
  if (answered.length === 0) {
    const why = silent.length > 0 ? `no CLI's broker status answered within ${secondsWord(timeoutMs)}` : `no CLI's broker status could be read (${unknownWhy.join('; ')})`;
    return infraRow('broker', 'unknown', why, 'Re-check; if it persists, the engine binary (WICKED_CORE_EXE) may be missing.', started, details, timeoutMs);
  }
  if (failing.length > 0) {
    return infraRow('broker', 'degraded', `credential refresh failing: ${failing.join(', ')}; the credential is served until it expires`, 'Sign the CLI in again before its credential expires.', started, details, timeoutMs);
  }
  if (signedIn.length === 0) {
    return infraRow('broker', 'degraded', `no CLI is signed in to the broker (${answered.join(', ')} answered signed out)`, 'Sign a CLI in on the Agents page.', started, details, timeoutMs);
  }
  return infraRow('broker', 'ok', `signed in: ${signedIn.join(', ')}${silent.length > 0 ? `; no answer from ${silent.join(', ')}` : ''}`, null, started, details, timeoutMs);
}

export interface InteractiveProbeInput {
  /** The bridge roots this daemon knows (its default root and every pooled one). */
  roots: string[];
  /** `<root>/.wi-serve.json`, or null (`bridge-pool.ts` `readLock`). */
  readLock: (root: string) => { host: string; port: number; pid: number } | null;
  /** GET the bridge's `/api/health`; resolves the HTTP status. */
  health: (url: string, timeoutMs: number) => Promise<number>;
  timeoutMs?: number;
}

/** The interactive bridge: started on demand, so no lockfile is `off`; a recorded bridge must answer
 *  its `/api/health` inside the bound. */
export async function probeInteractive(input: InteractiveProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const bridges = input.roots
    .map((root) => ({ root, lock: input.readLock(root) }))
    .filter((b): b is { root: string; lock: { host: string; port: number; pid: number } } => b.lock !== null);
  if (bridges.length === 0) {
    return infraRow('interactive', 'off', 'not running: crew starts the bridge when a document opens', null, started, { roots: input.roots.length });
  }
  const results = await Promise.all(
    bridges.map(async ({ root, lock }) => {
      const url = `http://${lock.host.includes(':') ? `[${lock.host}]` : lock.host}:${lock.port}/api/health`;
      const settled = await settleWithin(() => input.health(url, timeoutMs), timeoutMs);
      return { root, port: lock.port, pid: lock.pid, settled };
    }),
  );
  const details = {
    bridges: results.map((r) => ({
      port: r.port,
      pid: r.pid,
      result: r.settled.kind === 'ok' ? `HTTP ${r.settled.value}` : r.settled.kind === 'timeout' ? 'timeout' : r.settled.error,
    })),
  };
  const down = results.filter((r) => r.settled.kind === 'error' || (r.settled.kind === 'ok' && (r.settled.value < 200 || r.settled.value >= 300)));
  const hung = results.filter((r) => r.settled.kind === 'timeout');
  if (down.length > 0) {
    const r = down[0]!;
    const why = r.settled.kind === 'ok' ? `answered HTTP ${r.settled.value}` : r.settled.kind === 'error' ? r.settled.error : '';
    return infraRow('interactive', 'down', `the bridge recorded on port ${r.port} does not answer its health check (${why})`, 'Open a document: crew restarts a dead bridge. Then re-check.', started, details, timeoutMs);
  }
  if (hung.length > 0) {
    return infraRow('interactive', 'unknown', `the bridge on port ${hung[0]!.port} did not answer within ${secondsWord(timeoutMs)}`, 'Re-check; a bridge busy rendering may answer late.', started, details, timeoutMs);
  }
  return infraRow('interactive', 'ok', `answering on ${results.map((r) => `port ${r.port}`).join(', ')}`, null, started, details, timeoutMs);
}

export interface EstateProbeInput {
  exe: string;
  /** The memory store the daemon reads and writes (`memoryStoreInfo`). */
  memoryStore: { path: string; source: string; notice: string | null };
  exec: ExecLike;
  /** Whether the store file exists (injectable for tests). */
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

/** Estate, through one read-only call: `wicked-estate stats --db <memory store>`. */
export async function probeEstate(input: EstateProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const details: Record<string, unknown> = { memoryStore: input.memoryStore, exe: input.exe };
  const exists = input.exists ?? ((p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (input.memoryStore.path !== ':memory:' && !exists(input.memoryStore.path)) {
    return infraRow('estate', 'degraded', 'the memory store has not been created yet: nothing has been remembered on this daemon', 'Nothing to fix; it is created on the first memory write.', started, details);
  }
  const settled = await settleWithin(() => input.exec(input.exe, ['stats', '--db', input.memoryStore.path], { timeout: timeoutMs }), timeoutMs);
  if (settled.kind === 'timeout') {
    return infraRow('estate', 'unknown', `wicked-estate did not answer within ${secondsWord(timeoutMs)}`, 'Re-check; a store under a long write answers late.', started, details, timeoutMs);
  }
  if (settled.kind === 'error') {
    const missing = settled.error.toLowerCase().includes('enoent');
    return infraRow(
      'estate',
      'down',
      missing ? `${input.exe} is not installed or not on PATH` : `wicked-estate stats failed: ${settled.error}`,
      missing ? 'Install wicked-estate (npx wicked-installer) or set WICKED_ESTATE_EXE, then re-check.' : 'Check the memory store with `wicked-estate stats`, then re-check.',
      started,
      { ...details, error: settled.error },
      timeoutMs,
    );
  }
  const out = settled.value.stdout;
  const nodes = /(\d+)\s+nodes?/i.exec(out)?.[1];
  return infraRow('estate', 'ok', `answered${nodes !== undefined ? ` (${nodes} nodes)` : ''}`, null, started, { ...details, stats: out.slice(0, 400) }, timeoutMs);
}

export interface BusProbeInput {
  /** Why the boot handed the engine no bus, if it did not. */
  unavailable: { reason?: unknown } | null;
  /** The engine has the bus but not the calls crew reaches it through. */
  seamsOff: unknown;
  /** The bus db file (`WICKED_BUS_DB`), or null when none was exported. */
  dbPath: string | null;
  /** The watch registry's bus source, when it is armed. */
  watchBus: 'up' | 'down' | 'degraded' | null;
  tailLagMs: number | null;
}

/** The event bus: the boot's own verdict, then the file (stat, never opened: one SQLite library per
 *  file per process), then the watch registry's live tail. */
export async function probeBus(input: BusProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const details: Record<string, unknown> = { dbPath: input.dbPath, watch: input.watchBus, tailLagMs: input.tailLagMs };
  if (input.unavailable !== null) {
    const why = typeof input.unavailable.reason === 'string' ? input.unavailable.reason : 'the boot could not open it';
    return infraRow('bus', 'down', `the engine runs without a bus: ${why}`, 'Fix the bus file named in the reason and restart the daemon.', started, { ...details, unavailable: input.unavailable });
  }
  if (input.dbPath === null) {
    return infraRow('bus', 'off', 'no bus was handed to the engine on this daemon', null, started, details);
  }
  const st = await settleWithin(() => stat(input.dbPath as string), PROBE_TIMEOUT_MS);
  if (st.kind !== 'ok') {
    return infraRow('bus', 'down', `the bus file cannot be read (${st.kind === 'timeout' ? 'timed out' : st.error})`, 'Restart the daemon so it re-creates its bus.', started, details, PROBE_TIMEOUT_MS);
  }
  details['bytes'] = st.value.size;
  if (input.seamsOff !== null && input.seamsOff !== undefined && input.seamsOff !== false) {
    return infraRow('bus', 'degraded', 'the engine has the bus but not the calls crew reaches it through (teaming is off)', 'Upgrade wicked-core-ts to a build with the bus seams.', started, { ...details, seamsOff: input.seamsOff });
  }
  if (input.watchBus === 'down') {
    return infraRow('bus', 'degraded', 'the watch registry is not tailing the bus', 'Restart the daemon; check /api/v1/watch/health.', started, details);
  }
  return infraRow('bus', 'ok', `bus file present${input.tailLagMs !== null ? `; watch tail lag ${secondsWord(input.tailLagMs)}` : ''}`, null, started, details);
}

export interface VaultProbeInput {
  /** `DiagnosticsVault`, or null on a route set without the engine adapter. */
  vault: { bin: string | null; source: string; finding: { message: string; remedy: string } | null } | null;
  exec: ExecLike;
  timeoutMs?: number;
}

export async function probeVault(input: VaultProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const v = input.vault;
  if (v === null) return infraRow('vault', 'unknown', 'this route set has no engine adapter to report the vault', null, started, { vault: null });
  if (v.source === 'off') return infraRow('vault', 'off', v.finding?.message ?? 'switched off by the operator', null, started, { vault: v });
  if (v.bin === null) {
    return infraRow('vault', 'degraded', v.finding?.message ?? 'no wicked-vault CLI could be resolved', v.finding?.remedy ?? 'Reinstall wicked-crew.', started, { vault: v });
  }
  const settled = await settleWithin(() => input.exec(v.bin as string, ['--version'], { timeout: timeoutMs }), timeoutMs);
  if (settled.kind === 'timeout') return infraRow('vault', 'unknown', `wicked-vault did not answer within ${secondsWord(timeoutMs)}`, 'Re-check.', started, { vault: v }, timeoutMs);
  if (settled.kind === 'error') {
    return infraRow('vault', 'down', `wicked-vault cannot run: ${settled.error}`, 'Reinstall wicked-crew (it ships wicked-vault), then re-check.', started, { vault: v, error: settled.error }, timeoutMs);
  }
  return infraRow('vault', 'ok', `answers (${settled.value.stdout.split('\n', 1)[0]?.trim() || 'no version text'})`, null, started, { vault: v }, timeoutMs);
}

/** `DiagnosticsSkills` → a row. */
export function skillsRow(skills: { state: string; findings: Array<{ severity?: string; message?: string; kind?: string }> } & Record<string, unknown>): SystemInfraRow {
  const started = Date.now();
  const errors = skills.findings.filter((f) => f.severity === 'error');
  const first = (errors[0] ?? skills.findings[0])?.message;
  switch (skills.state) {
    case 'published':
      return errors.length > 0
        ? infraRow('skills', 'down', first ?? 'a skills finding refuses launches', 'Fix the skills root named in the finding.', started, { skills })
        : skills.findings.length > 0
          ? infraRow('skills', 'degraded', first ?? 'a skills warning', 'See the finding.', started, { skills })
          : infraRow('skills', 'ok', 'a published snapshot is current', null, started, { skills });
    case 'fallback':
      return infraRow('skills', 'degraded', first ?? 'no wicked-garden is installed: the engine resolves its own skills cache', 'Install wicked-garden (npx wicked-installer).', started, { skills });
    case 'blocked':
    case 'config-error':
      return infraRow('skills', 'down', first ?? `skills ${skills.state}: launches are refused`, 'Fix the skills root named in the finding, then re-check.', started, { skills });
    case 'disabled':
      return infraRow('skills', 'off', 'the skills seam is disabled on this daemon', null, started, { skills });
    default:
      return infraRow('skills', 'unknown', `skills state ${JSON.stringify(skills.state)}`, null, started, { skills });
  }
}

/** `DiagnosticsStateHome` → a row. */
export function stateHomeRow(home: { refusesLaunches: boolean; findings: Array<{ severity?: string; message?: string }>; remedy?: string; error?: string | null } | null): SystemInfraRow {
  const started = Date.now();
  if (home === null) return infraRow('state_home', 'unknown', 'this daemon booted without the state-home watch', null, started, { stateHome: null });
  if (home.refusesLaunches) {
    return infraRow('state_home', 'down', home.findings[0]?.message ?? 'the state home holds an entry the worker fence cannot classify: launches are refused', home.remedy ?? 'Remove the unregistered entry.', started, { stateHome: home });
  }
  if (home.error !== null && home.error !== undefined) {
    return infraRow('state_home', 'unknown', `the state home could not be surveyed: ${home.error}`, 'Re-check.', started, { stateHome: home });
  }
  if (home.findings.length > 0) {
    return infraRow('state_home', 'degraded', home.findings[0]?.message ?? 'a state-home warning', home.remedy ?? 'See the finding.', started, { stateHome: home });
  }
  return infraRow('state_home', 'ok', 'every entry is classified', null, started, { stateHome: home });
}

export async function diskRow(
  path: string | null,
  statfsFn: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }> = statfs,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SystemInfraRow> {
  const started = Date.now();
  if (path === null) return infraRow('disk', 'unknown', 'no state home to measure', null, started);
  const settled = await settleWithin(() => statfsFn(path), timeoutMs);
  if (settled.kind === 'timeout') return infraRow('disk', 'unknown', `the filesystem did not answer within ${secondsWord(timeoutMs)}`, 'Re-check.', started, { path }, timeoutMs);
  if (settled.kind === 'error') return infraRow('disk', 'unknown', `could not read free space: ${settled.error}`, 'Re-check.', started, { path });
  const free = Number(settled.value.bavail) * Number(settled.value.bsize);
  const total = Number(settled.value.blocks) * Number(settled.value.bsize);
  const gib = (n: number): string => `${Math.round((n / 2 ** 30) * 10) / 10} GiB`;
  const details = { path, freeBytes: free, totalBytes: total };
  if (free < 2 * 2 ** 30) {
    return infraRow('disk', 'down', `${gib(free)} free on the state-home volume: worktrees, installs and builds will fail`, 'Free disk space (old worktrees, cargo target dirs), then re-check.', started, details);
  }
  if (free < 10 * 2 ** 30 || (total > 0 && free / total < 0.05)) {
    return infraRow('disk', 'degraded', `${gib(free)} free on the state-home volume`, 'Free disk space before the next large run.', started, details);
  }
  return infraRow('disk', 'ok', `${gib(free)} free of ${gib(total)}`, null, started, details);
}

export function loadRow(read: () => { load1: number; cores: number } = () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length }), platform: NodeJS.Platform = process.platform): SystemInfraRow {
  const started = Date.now();
  if (platform === 'win32') return infraRow('load', 'unknown', 'Windows reports no load average', null, started);
  const { load1, cores } = read();
  const ratio = cores > 0 ? load1 / cores : 0;
  const details = { load1: Math.round(load1 * 100) / 100, cores, perCore: Math.round(ratio * 100) / 100 };
  const words = `load ${details.load1} on ${cores} cores`;
  if (ratio >= 5) return infraRow('load', 'down', `${words}: the host is saturated; seats and checks will time out`, 'Pause new runs or stop heavy jobs until the load falls.', started, details);
  if (ratio >= 1.5) return infraRow('load', 'degraded', `${words}: work will run slowly`, 'Avoid starting more parallel runs until the load falls.', started, details);
  return infraRow('load', 'ok', words, null, started, details);
}

// ── CLI 7-day stats + governance week (one fold over the run store) ────────

type Frame = RecordedEvent & Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** A rate / quota bench: the 429 class. */
const RATE_LIMIT = /quota|rate[ _-]?limit|usage[ _-]?limit|429|too many requests/i;

export interface WeekFold {
  since: number;
  until: number;
  runsRead: number;
  truncated: boolean;
  clis: Map<string, SystemCliStats>;
  floors: Record<string, number>;
  qe: { passed: number; failed: number };
  judgedGates: number;
}

function emptyStats(days: number, since: number, asOf: number): SystemCliStats {
  return {
    days,
    since,
    asOf,
    units: 0,
    gated: 0,
    firstPass: 0,
    passPct: null,
    medianUnitMs: null,
    rateLimited: 0,
    benches: 0,
    fallbacks: 0,
    perDay: new Array<number>(days).fill(0),
    runsRead: 0,
    truncated: false,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Fold the window's runs into per-CLI stats and the governance week. Ownership follows
 *  `seat-record.ts` (`unitDistributed.cli`, moved by `unitReassigned.newCli`, else `assigned_cli`). */
export function foldWeek(
  runs: ReadonlyArray<{ view: SessionView; events: readonly RecordedEvent[] }>,
  opts: { days: number; now: number; truncated: boolean },
): WeekFold {
  const since = opts.now - opts.days * DAY_MS;
  const clis = new Map<string, SystemCliStats>();
  const durations = new Map<string, number[]>();
  const tokens = new Map<string, { input: number; output: number; reported: boolean }>();
  const cost = new Map<string, number>();
  const stat = (cli: string): SystemCliStats => {
    let s = clis.get(cli);
    if (s === undefined) {
      s = emptyStats(opts.days, since, opts.now);
      clis.set(cli, s);
    }
    return s;
  };
  const floors: Record<string, number> = {};
  const qe = { passed: 0, failed: 0 };
  let judgedGates = 0;

  for (const { view, events } of runs) {
    const unitRow = new Map(view.units.map((u) => [u.ord, u]));
    const owner = new Map<number, string>();
    const ownerOf = (ord: number): string | undefined => owner.get(ord) ?? str(unitRow.get(ord)?.assigned_cli) ?? undefined;
    const ranBy = new Set<string>();
    const gatedOnce = new Set<number>();
    const dispatchAt = new Map<string, { at: number; cli: string }>();
    const timed = new Set<string>();
    const qeLast = new Map<number, boolean>();
    const sorted = [...events].sort((a, b) => a.ts - b.ts || (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
    for (const raw of sorted) {
      const e = raw as Frame;
      const ord = num(e['ord']);
      if (e.type === 'unitDistributed' && ord !== undefined && str(e['cli']) !== undefined) {
        owner.set(ord, e['cli'] as string);
        continue;
      }
      if (e.type === 'unitReassigned' && ord !== undefined) {
        const next = str(e['newCli']);
        if (next !== undefined) owner.set(ord, next);
        continue;
      }
      if (e.ts < since || e.ts > opts.now) continue;
      // Seat-level frames carry their CLI themselves.
      if (e.type === 'seatBenched') {
        const cli = str(e['cli']);
        if (cli === undefined) continue;
        const s = stat(cli);
        s.benches += 1;
        if (RATE_LIMIT.test(String(e['reason'] ?? ''))) s.rateLimited += 1;
        continue;
      }
      if (e.type === 'acpFallback') {
        const cli = str(e['cliKey']) ?? str(e['cli']);
        if (cli !== undefined) stat(cli).fallbacks += 1;
        continue;
      }
      if (e.type === 'repoChecksEvaluated') {
        const outcome = str(e['outcome']) ?? (e['passed'] === true ? 'passed' : 'failed');
        floors[outcome] = (floors[outcome] ?? 0) + 1;
        continue;
      }
      if (ord === undefined) continue;
      const cli = ownerOf(ord);
      const attempt = num(e['attempt']) ?? 0;
      switch (e.type) {
        case 'unitDispatched': {
          if (cli === undefined) break;
          dispatchAt.set(`${ord}:${attempt}`, { at: e.ts, cli });
          const key = `${cli}\u0000${ord}`;
          if (!ranBy.has(key)) {
            ranBy.add(key);
            const s = stat(cli);
            s.units += 1;
            const bucket = Math.min(opts.days - 1, Math.max(0, Math.floor((e.ts - since) / DAY_MS)));
            s.perDay[bucket] = (s.perDay[bucket] ?? 0) + 1;
          }
          break;
        }
        case 'unitOutputCaptured': {
          const key = `${ord}:${attempt}`;
          const d = dispatchAt.get(key);
          if (d === undefined || timed.has(key)) break;
          timed.add(key);
          const list = durations.get(d.cli) ?? [];
          list.push(Math.max(0, e.ts - d.at));
          durations.set(d.cli, list);
          break;
        }
        case 'gateEvaluated': {
          const passed = e['combined'] === true && (e['denial'] ?? null) === null;
          if (typeof e['agentVerdict'] === 'string' && e['agentVerdict'] !== '') judgedGates += 1;
          if ((unitRow.get(ord) as { qe_acceptance?: unknown } | undefined)?.qe_acceptance != null) qeLast.set(ord, passed);
          if (cli === undefined || gatedOnce.has(ord)) break;
          gatedOnce.add(ord);
          const s = stat(cli);
          s.gated += 1;
          if (passed) s.firstPass += 1;
          break;
        }
        case 'cliUsage': {
          if (cli === undefined) break;
          const inT = num(e['inputTokens']);
          const outT = num(e['outputTokens']);
          if (inT !== undefined || outT !== undefined) {
            const t = tokens.get(cli) ?? { input: 0, output: 0, reported: false };
            t.input += inT ?? 0;
            t.output += outT ?? 0;
            t.reported = true;
            tokens.set(cli, t);
          }
          const c = num(e['costUsd']);
          if (c !== undefined) cost.set(cli, (cost.get(cli) ?? 0) + c);
          break;
        }
        default:
          break;
      }
    }
    for (const passed of qeLast.values()) {
      if (passed) qe.passed += 1;
      else qe.failed += 1;
    }
  }
  for (const [cli, s] of clis) {
    s.passPct = s.gated > 0 ? Math.round((s.firstPass / s.gated) * 100) : null;
    s.medianUnitMs = median(durations.get(cli) ?? []);
    const t = tokens.get(cli);
    if (t?.reported === true) s.tokens = { input: t.input, output: t.output };
    const c = cost.get(cli);
    if (c !== undefined) s.costUsd = Math.round(c * 10_000) / 10_000;
    s.runsRead = runs.length;
    s.truncated = opts.truncated;
  }
  return { since, until: opts.now, runsRead: runs.length, truncated: opts.truncated, clis, floors, qe, judgedGates };
}

/** Pick the runs that can touch the window (newest first, capped), read each log, fold. `null` when
 *  the engine has no event-log read binding. */
export async function readWeek(
  views: readonly SessionView[],
  readEvents: (runId: string) => Promise<readonly RecordedEvent[] | null>,
  opts: { days: number; now: number },
): Promise<WeekFold | null> {
  const since = opts.now - opts.days * DAY_MS;
  const candidates = views
    .filter((v) => runTouchesWindow(v, since))
    .sort((a, b) => (num(b.session.created_at) ?? -Infinity) - (num(a.session.created_at) ?? -Infinity) || a.session.id.localeCompare(b.session.id));
  const read = candidates.slice(0, SYSTEM_STATS_RUN_CAP);
  const runs: Array<{ view: SessionView; events: readonly RecordedEvent[] }> = [];
  for (const view of read) {
    const events = await readEvents(view.session.id);
    if (events === null) return null;
    runs.push({ view, events });
  }
  return foldWeek(runs, { days: opts.days, now: opts.now, truncated: candidates.length > read.length });
}

/** A short-TTL, in-flight-deduplicated holder for the week fold: the snapshot never waits past its
 *  bound for it, and a fold that finishes late lands for the next read. */
export class WeekFoldCache {
  private value: { at: number; fold: WeekFold | null } | null = null;
  private inFlight: Promise<WeekFold | null> | null = null;

  constructor(private readonly ttlMs: number = SYSTEM_STATS_TTL_MS, private readonly now: () => number = Date.now) {}

  get(compute: () => Promise<WeekFold | null>): Promise<WeekFold | null> {
    if (this.value !== null && this.now() - this.value.at < this.ttlMs) return Promise.resolve(this.value.fold);
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = compute()
      .then((fold) => {
        this.value = { at: this.now(), fold };
        return fold;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// ── clis[] ──────────────────────────────────────────────────────────────────

/** The roster fields the snapshot reads (`RosterSeat`). */
export interface RosterSeatLike {
  key: string;
  display_name?: string;
  auth?: string;
  signed_in?: boolean | null;
  health?: SeatHealth;
  council_eligible?: boolean;
  council_ineligible_reason?: string;
  work_eligible?: boolean;
  work_ineligible_reason?: string;
  login_note?: string;
  auth_evidence?: string;
  login_invocation?: string;
  sign_in?: string;
  version?: { installed?: string | null; version?: string | null; observed?: string | null } | null;
  version_pin?: { pinned: string; observed: string | null; matched: boolean } | null;
  governance_class?: unknown;
  governance_mode?: Record<string, string> | null;
  recent_bench?: { kind: string; reason: string; lifts_at: string; last_at: string; runs: number; source: string } | null;
}

function cliState(seat: RosterSeatLike): { state: SystemCliState; reason: string | null; until?: string } {
  const bench = seat.recent_bench;
  if (bench !== undefined && bench !== null) {
    const kind = bench.kind === 'quota_exhausted' ? 'quota (429)' : bench.kind.replace(/_/g, ' ');
    return { state: 'benched', reason: `benched: ${kind} until ${bench.lifts_at.slice(11, 16)} UTC (${bench.reason})`, until: bench.lifts_at };
  }
  if (seat.auth === 'signed_out' || (seat.auth === undefined && seat.signed_in === false)) {
    return { state: 'signed_out', reason: seat.council_ineligible_reason ?? seat.work_ineligible_reason ?? seat.auth_evidence ?? 'signed out' };
  }
  if (seat.auth === 'unknown' || (seat.auth === undefined && (seat.signed_in === null || seat.signed_in === undefined))) {
    return { state: 'unknown', reason: seat.login_note ?? 'the sign-in check has not answered' };
  }
  return { state: 'signed_in', reason: null };
}

function versionOf(seat: RosterSeatLike): string | null {
  const v = seat.version;
  if (v === undefined || v === null) return null;
  return str(v.installed) ?? str(v.version) ?? str(v.observed) ?? null;
}

export function buildClis(input: {
  roster: RosterSeatLike[];
  acp: Record<string, AcpCliDiagnostics>;
  seatGovernance: DiagnosticsSeatGovernanceEntry[];
  containerFloor: boolean;
  hostBoundary: string | null;
  week: WeekFold | null;
  weekNote?: string;
}): SystemCli[] {
  return input.roster.map((seat) => {
    const { state, reason, until } = cliState(seat);
    const gov = input.seatGovernance.find((g) => g.cli === seat.key) ?? null;
    const sandbox = input.containerFloor ? 'container' : gov?.os_sandbox === true ? 'os_sandbox' : input.hostBoundary !== null ? `host:${input.hostBoundary}` : 'none';
    const health = seat.health ?? null;
    const lastError =
      health !== null && typeof health.lastErrorAt === 'string'
        ? { at: health.lastErrorAt, message: health.message ?? 'a seat-level error (no excerpt kept)' }
        : null;
    const stats = input.week === null ? null : (input.week.clis.get(seat.key) ?? { ...emptyStats(SYSTEM_STATS_DAYS, input.week.since, input.week.until), runsRead: input.week.runsRead, truncated: input.week.truncated });
    const cli: SystemCli = {
      cli: seat.key,
      label: seat.display_name ?? seat.key,
      state,
      stateReason: reason,
      ...(until !== undefined ? { benchedUntil: until } : {}),
      canSignIn: seat.sign_in === 'container' || typeof seat.login_invocation === 'string',
      councilEligible: seat.council_eligible === true,
      workEligible: seat.work_eligible !== false,
      version: versionOf(seat),
      versionPin: seat.version_pin != null ? { pinned: seat.version_pin.pinned, observed: seat.version_pin.observed, matched: seat.version_pin.matched } : null,
      governanceClass: typeof seat.governance_class === 'string' ? seat.governance_class : seat.governance_class != null ? JSON.stringify(seat.governance_class) : null,
      governanceMode: seat.governance_mode ?? null,
      transport: gov?.transport ?? null,
      sandbox,
      lastError,
      stats,
      ...(stats === null ? { statsNote: input.weekNote ?? 'the run store has no event-log read binding on this engine' } : {}),
      details: { acp: input.acp[seat.key] ?? null, seatGovernance: gov, health },
    };
    return cli;
  });
}

// ── runs[] ──────────────────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const LIVENESS_RANK: Record<SystemRunLiveness, number> = { waiting_on_you: 0, held: 1, stalled: 2, quiet: 3, working: 4 };

/** The open gate or question a paused run waits on (`InteractionRequest`, or the gate cache). */
export interface OpenGateLike {
  interactionId: string | null;
  ord: number | null;
  kind: string | null;
  prompt: string | null;
}

export interface RunEvidence {
  at: number;
  source: 'event_log' | 'relay' | 'process';
}

/** The liveness thresholds from `workerStallMinutes`: stalled at the stall threshold, quiet at a
 *  third of it (at most 5 min). */
export function livenessThresholds(stallMinutes: number | undefined): { quietAfterMs: number; stallAfterMs: number } {
  const m = typeof stallMinutes === 'number' && Number.isFinite(stallMinutes) && stallMinutes > 0 ? stallMinutes : 15;
  const stallAfterMs = m * 60_000;
  return { stallAfterMs, quietAfterMs: Math.min(5 * 60_000, Math.floor(stallAfterMs / 3)) };
}

/** One run's computed liveness. Pure: every input is a reading. */
export function runLiveness(input: {
  view: SessionView;
  now: number;
  evidence: RunEvidence | null;
  gate: OpenGateLike | null;
  quietAfterMs: number;
  stallAfterMs: number;
}): SystemRun {
  const { view, now, evidence, gate } = input;
  const s = view.session as SessionView['session'] & { title?: string; created_at?: number };
  const cursor =
    view.units.find((u) => u.status === 'distributed') ?? (gate?.ord != null ? view.units.find((u) => u.ord === gate.ord) : undefined) ?? view.units.find((u) => u.status === 'pending');
  const phase = cursor === undefined ? null : (str((cursor as { phase_ref?: unknown }).phase_ref) ?? str((cursor as { stage?: unknown }).stage) ?? null);
  const quietForMs = evidence === null ? null : Math.max(0, now - evidence.at);
  const createdMs = num(s.created_at) !== undefined ? (s.created_at as number) * 1000 : null;
  let liveness: SystemRunLiveness;
  let reason: string;
  if (s.status === 'awaiting_human') {
    if (gate === null) {
      liveness = 'held';
      reason = 'paused for a human, but no open gate is on record: open the run to see what it waits on';
    } else if (gate.kind === 'escalation') {
      liveness = 'held';
      reason = `held at an escalation gate${gate.ord !== null ? ` (unit ${gate.ord})` : ''}: the work failed a check or could not be judged`;
    } else {
      liveness = 'waiting_on_you';
      reason = `waiting on you: ${(gate.kind ?? 'a decision').replace(/_/g, ' ')}${gate.ord !== null ? ` (unit ${gate.ord})` : ''}`;
    }
  } else if (evidence === null) {
    const age = createdMs !== null ? now - createdMs : null;
    if (age !== null && age < input.stallAfterMs) {
      liveness = 'quiet';
      reason = `no event on record yet (launched ${minutesWord(age)} ago)`;
    } else {
      liveness = 'stalled';
      reason = 'no event on record for this run: nothing shows it is working';
    }
  } else if ((quietForMs as number) >= input.stallAfterMs) {
    liveness = 'stalled';
    reason = `no event for ${minutesWord(quietForMs as number)} (stalled after ${minutesWord(input.stallAfterMs)})`;
  } else if ((quietForMs as number) >= input.quietAfterMs) {
    liveness = 'quiet';
    reason = `quiet for ${minutesWord(quietForMs as number)}`;
  } else {
    liveness = 'working';
    reason = evidence.source === 'process' ? 'working: its processes are busy' : `working: last event ${minutesWord(quietForMs as number)} ago`;
  }
  return {
    runId: s.id,
    title: str(s.title) ?? s.problem.slice(0, 60),
    status: s.status,
    liveness,
    reason,
    phase,
    unitOrd: cursor?.ord ?? null,
    seat: str(cursor?.assigned_cli) ?? null,
    lastEventAt: evidence === null ? null : iso(evidence.at),
    evidence: evidence?.source ?? null,
    quietForMs,
    quietAfterMs: input.quietAfterMs,
    stallAfterMs: input.stallAfterMs,
    ...(gate !== null ? { gate } : {}),
    createdAt: createdMs !== null ? iso(createdMs) : null,
  };
}

export function unfinished(views: readonly SessionView[]): SessionView[] {
  return views.filter((v) => !TERMINAL.has(v.session.status));
}

export function sortRuns(runs: SystemRun[]): SystemRun[] {
  return [...runs].sort((a, b) => LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness] || (b.quietForMs ?? Infinity) - (a.quietForMs ?? Infinity) || a.runId.localeCompare(b.runId));
}

// ── Judges ──────────────────────────────────────────────────────────────────

const cliKeyOf = (seat: string): string => seat.split('#', 1)[0] ?? seat;

/** For each unfinished run: the seats that could judge its next gate distinct from its creator, and,
 *  when there are none, the seats in its pool that cannot (with why). */
export function judgeGaps(
  runs: Array<{ view: SessionView; run: SystemRun }>,
  clis: SystemCli[],
): Array<{ run: SystemRun; creator: string | null; blockedBy: SystemCli[] }> {
  const byKey = new Map(clis.map((c) => [c.cli, c]));
  const out: Array<{ run: SystemRun; creator: string | null; blockedBy: SystemCli[] }> = [];
  for (const { view, run } of runs) {
    // A run launched in explicit reduced-assurance mode accepts its creator's seat as reviewer.
    if ((view.session as { assurance?: { mode?: unknown } }).assurance?.mode === 'reduced') continue;
    const gatedOrd = run.gate?.ord ?? run.unitOrd;
    const gatedUnit = gatedOrd !== null ? view.units.find((u) => u.ord === gatedOrd) : undefined;
    const creatorSeat = str(gatedUnit?.assigned_cli) ?? run.seat;
    const creator = creatorSeat !== null ? cliKeyOf(creatorSeat) : null;
    const poolKeys = (view.session.clis ?? []).map(cliKeyOf);
    const pool = poolKeys.length > 0 ? [...new Set(poolKeys)] : clis.map((c) => c.cli);
    const candidates = pool.filter((k) => k !== creator && byKey.get(k)?.councilEligible === true);
    if (candidates.length > 0) continue;
    const blockedBy = pool.filter((k) => k !== creator).map((k) => byKey.get(k)).filter((c): c is SystemCli => c !== undefined && c.state !== 'signed_in');
    out.push({ run, creator, blockedBy });
  }
  return out;
}

// ── governance[] ────────────────────────────────────────────────────────────

export interface GovernanceInput {
  /** `DiagnosticsGovernance`. */
  governance: {
    store: { path: string; source: string } | null;
    records: { total: number | null; sinceBoot: number | null };
    deadletters: { count: number } & Record<string, unknown>;
    findings: Array<{ kind: string; severity: string; message: string }>;
  };
  skillsFindings: Array<{ kind?: string; severity?: string; message?: string }>;
  decisions: unknown;
  clis: SystemCli[];
  judgeGapCount: number;
  week: WeekFold | null;
  weekNote?: string;
  /** Gate decisions by a human operator in the window (audit `gate.decided`); `null` unreadable. */
  gatesByYou: number | null;
  /** Steering rules loaded (not retired); `null` when unreadable. */
  steeringRules: number | null;
  steeringNote?: string;
}

export function buildGovernance(g: GovernanceInput): SystemGovernanceCard[] {
  const cards: SystemGovernanceCard[] = [];
  const judges = g.clis.filter((c) => c.councilEligible).map((c) => c.cli);
  cards.push({
    key: 'judges',
    label: 'Judges available',
    state: judges.length >= 2 && g.judgeGapCount === 0 ? 'ok' : 'down',
    value: judges.length,
    reason:
      judges.length === 0
        ? 'no seat can judge: every gate holds for want of a judge'
        : judges.length === 1
          ? `only ${judges[0]} can judge, so it cannot judge its own work`
          : g.judgeGapCount > 0
            ? `${g.judgeGapCount} run(s) have no judge distinct from their creator in their pool (${judges.join(', ')} eligible)`
            : `a distinct judge can be seated: ${judges.join(', ')}`,
    remedy: judges.length >= 2 && g.judgeGapCount === 0 ? null : 'Sign in a second CLI (or wait for a bench to lift) so a judge distinct from the creator can be seated.',
  });
  const week = g.week;
  const weekReason = g.weekNote ?? 'the run store has no event-log read binding on this engine';
  if (week === null) {
    for (const [key, label] of [
      ['floor_outcomes', 'Floor outcomes (7 days)'],
      ['qe_acceptance', 'QE acceptance (7 days)'],
    ] as const) {
      cards.push({ key, label, state: 'unknown', value: null, reason: weekReason, remedy: null });
    }
  } else {
    const total = Object.values(week.floors).reduce((a, b) => a + b, 0);
    cards.push({
      key: 'floor_outcomes',
      label: 'Floor outcomes (7 days)',
      state: 'ok',
      value: total,
      breakdown: { ...week.floors },
      reason: total === 0 ? 'no repo-checks floor ran in the window' : `${week.floors['passed'] ?? 0} of ${total} repo-checks floors passed`,
      remedy: null,
      since: week.since,
    });
    const judged = week.qe.passed + week.qe.failed;
    cards.push({
      key: 'qe_acceptance',
      label: 'QE acceptance (7 days)',
      state: 'ok',
      value: judged > 0 ? Math.round((week.qe.passed / judged) * 100) : null,
      breakdown: { passed: week.qe.passed, failed: week.qe.failed },
      reason: judged === 0 ? 'no QE acceptance unit was gated in the window' : `${week.qe.passed} of ${judged} QE acceptance gates passed (the QE unit's last gate per run)`,
      remedy: null,
      since: week.since,
    });
  }
  const byJudges = week?.judgedGates ?? null;
  cards.push({
    key: 'gates_answered',
    label: 'Gates answered (7 days)',
    state: g.gatesByYou === null || byJudges === null ? 'unknown' : 'ok',
    value: g.gatesByYou === null || byJudges === null ? null : g.gatesByYou + byJudges,
    breakdown: { ...(g.gatesByYou !== null ? { byYou: g.gatesByYou } : {}), ...(byJudges !== null ? { byJudges } : {}) },
    reason:
      g.gatesByYou === null || byJudges === null
        ? `${g.gatesByYou === null ? 'the audit trail could not be read' : weekReason}`
        : `${g.gatesByYou} answered by you, ${byJudges} ruled by a judge`,
    remedy: null,
    ...(week !== null ? { since: week.since } : {}),
  });
  const dl = g.governance.deadletters.count;
  cards.push({
    key: 'dead_letters',
    label: 'Dead letters',
    state: dl > 0 ? 'degraded' : 'ok',
    value: dl,
    reason: dl > 0 ? `${dl} governance event(s) could not land on the store and wait in the outbox` : 'none: every governance event landed',
    remedy: dl > 0 ? 'Replay them (`wicked-crew governance replay`, or POST /api/v1/governance/deadletters/replay).' : null,
    details: { deadletters: g.governance.deadletters },
  });
  cards.push({
    key: 'steering_rules',
    label: 'Steering rules loaded',
    state: g.steeringRules === null ? 'unknown' : g.steeringRules === 0 ? 'degraded' : 'ok',
    value: g.steeringRules,
    reason: g.steeringRules === null ? (g.steeringNote ?? 'the rule store could not be read') : g.steeringRules === 0 ? 'no steering rules are loaded: gates check no doctrine' : `${g.steeringRules} active rule(s)`,
    remedy: g.steeringRules === 0 ? 'Ingest the steering rules (`wicked-core rules ingest`) or import them in Steering.' : null,
  });
  const findings = [...g.governance.findings, ...g.skillsFindings.map((f) => ({ kind: f.kind ?? 'skills', severity: f.severity ?? 'warning', message: f.message ?? '' }))];
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  cards.push({
    key: 'findings',
    label: 'Open findings',
    state: errors > 0 ? 'down' : warnings > 0 ? 'degraded' : 'ok',
    value: findings.length,
    breakdown: { error: errors, warning: warnings, info: findings.length - errors - warnings },
    reason: findings.length === 0 ? 'none' : (findings.find((f) => f.severity === 'error') ?? findings[0])!.message,
    remedy: errors + warnings > 0 ? 'Open the finding for its remedy.' : null,
    details: { governance: g.governance.findings, skills: g.skillsFindings, decisions: g.decisions },
  });
  const store = g.governance.store;
  cards.push({
    key: 'store',
    label: 'Governance store',
    state: store === null ? 'down' : 'ok',
    value: g.governance.records.total,
    reason: store === null ? 'no governance store: evidence has nowhere to land' : `${g.governance.records.total ?? 'uncounted'} record(s); ${g.governance.records.sinceBoot ?? 'unknown'} since boot`,
    remedy: store === null ? 'Start the daemon with a governance store (`--governance-db`).' : null,
    details: { store, records: g.governance.records },
  });
  return cards;
}

// ── attention[] ─────────────────────────────────────────────────────────────

const SOURCE_RANK = { infra: 0, cli: 1, run: 2, governance: 3 } as const;
/** What `down` means in words for the rows where "down" reads oddly. */
const DOWN_WORD: Partial<Record<SystemInfraKey, string>> = { load: 'saturated', disk: 'nearly full', state_home: 'refusing launches', skills: 'refusing launches' };

export function buildAttention(input: {
  infra: SystemInfraRow[];
  clis: SystemCli[];
  runs: SystemRun[];
  governance: SystemGovernanceCard[];
  gaps: Array<{ run: SystemRun; creator: string | null; blockedBy: SystemCli[] }>;
  /** Runs a down infra row blocks (the container floor's runs for the gateway, …). */
  blockedByInfra: (key: SystemInfraKey) => number;
}): SystemAttentionItem[] {
  const items: SystemAttentionItem[] = [];
  for (const r of input.infra) {
    if (r.state === 'ok' || r.state === 'off') continue;
    const red = r.state === 'down';
    items.push({
      id: `infra:${r.key}`,
      severity: red ? 'red' : 'yellow',
      source: 'infra',
      title: `${r.label}: ${r.state === 'unknown' ? 'not answering' : r.state === 'down' ? (DOWN_WORD[r.key] ?? 'down') : 'degraded'}`,
      reason: r.reason,
      remedy: r.remedy ?? 'Re-check.',
      blocks: red ? input.blockedByInfra(r.key) : 0,
      target: { kind: 'infra', key: r.key },
      action: { kind: 'recheck', label: 'Re-check' },
    });
  }
  const gapBlockers = new Map<string, number>();
  for (const gap of input.gaps) for (const c of gap.blockedBy) gapBlockers.set(c.cli, (gapBlockers.get(c.cli) ?? 0) + 1);
  for (const c of input.clis) {
    const blocks = gapBlockers.get(c.cli) ?? 0;
    if (c.state === 'benched' || (c.state === 'signed_out' && blocks > 0)) {
      items.push({
        id: `cli:${c.cli}`,
        severity: blocks > 0 ? 'red' : 'yellow',
        source: 'cli',
        title: `${c.label} ${c.state === 'benched' ? 'benched' : 'signed out'}`,
        reason: `${c.stateReason ?? c.state}${blocks > 0 ? `; it leaves ${blocks} run(s) without a distinct judge` : '; another distinct judge is still available'}`,
        remedy: c.state === 'benched' ? 'Wait for the bench to lift, or sign the CLI in again if its account changed.' : 'Sign the CLI in.',
        blocks,
        target: { kind: 'cli', cli: c.cli },
        action: c.canSignIn ? { kind: 'sign_in', label: 'Sign in' } : null,
      });
    }
  }
  for (const gap of input.gaps) {
    const who = gap.blockedBy.map((c) => `${c.cli} ${c.state === 'benched' ? 'benched' : c.state.replace('_', ' ')}`);
    items.push({
      id: `judge:${gap.run.runId}`,
      severity: 'red',
      source: 'run',
      title: `run ${gap.run.runId.slice(0, 8)}: no distinct judge`,
      reason: `no seat in the run's pool can judge ${gap.creator ?? 'its creator'}'s work${who.length > 0 ? ` (${who.join(', ')})` : ''}`,
      remedy: 'Sign in another CLI in the run’s pool, or reassign the unit to a seat whose work another seat can judge.',
      blocks: 1,
      target: { kind: 'run', runId: gap.run.runId, ...(gap.run.gate?.ord != null ? { gateOrd: gap.run.gate.ord } : {}) },
      action: gap.run.gate !== undefined ? { kind: 'open_gate', label: 'Open the gate' } : { kind: 'open_run', label: 'Open the run' },
    });
  }
  for (const r of input.runs) {
    if (r.liveness === 'working') continue;
    const red = r.liveness === 'stalled' || r.liveness === 'held';
    const target: SystemTarget = {
      kind: 'run',
      runId: r.runId,
      ...(r.gate?.ord != null ? { gateOrd: r.gate.ord } : {}),
      ...(r.gate?.interactionId != null ? { interactionId: r.gate.interactionId } : {}),
    };
    items.push({
      id: `run:${r.runId}`,
      severity: red ? 'red' : 'yellow',
      source: 'run',
      title: `run ${r.runId.slice(0, 8)} ${r.liveness.replace(/_/g, ' ')}`,
      reason: r.reason,
      remedy:
        r.liveness === 'waiting_on_you'
          ? 'Answer the gate.'
          : r.liveness === 'held'
            ? 'Open the gate and decide: retry with a note, reassign, or stop.'
            : r.liveness === 'stalled'
              ? 'Open the run: reassign the unit or stop the run. The watchdog re-dispatches a silent unit on its own after its escalation threshold.'
              : 'Nothing yet; it turns stalled if it stays silent.',
      blocks: red || r.liveness === 'waiting_on_you' ? 1 : 0,
      target,
      action: r.gate !== undefined ? { kind: 'open_gate', label: 'Open the gate' } : { kind: 'open_run', label: 'Open the run' },
    });
  }
  for (const c of input.governance) {
    if (c.state !== 'down' && c.state !== 'degraded') continue;
    if (c.key === 'judges' && input.gaps.length > 0) continue; // each gap is already its own item
    items.push({
      id: `governance:${c.key}`,
      severity: c.state === 'down' ? 'red' : 'yellow',
      source: 'governance',
      title: `${c.label}: ${c.state}`,
      reason: c.reason,
      remedy: c.remedy ?? 'Open the card.',
      blocks: 0,
      target: { kind: 'governance', key: c.key },
      action: null,
    });
  }
  return items.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1) ||
      b.blocks - a.blocks ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      a.id.localeCompare(b.id),
  );
}

export function levelOf(attention: SystemAttentionItem[]): SystemLevel {
  if (attention.some((a) => a.severity === 'red')) return 'red';
  return attention.length > 0 ? 'yellow' : 'green';
}

/** Assemble the wire answer from its parts. */
export function assembleSnapshot(parts: {
  startedAt: number;
  clis: SystemCli[];
  runs: SystemRun[];
  infra: SystemInfraRow[];
  governance: SystemGovernanceCard[];
  attention: SystemAttentionItem[];
}): SystemSnapshot {
  const now = Date.now();
  return {
    checkedAt: iso(now),
    budgetMs: SYSTEM_BUDGET_MS,
    tookMs: now - parts.startedAt,
    level: levelOf(parts.attention),
    attention: parts.attention,
    clis: parts.clis,
    runs: parts.runs,
    infra: parts.infra,
    governance: parts.governance,
  };
}
