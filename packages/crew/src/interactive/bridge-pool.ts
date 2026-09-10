/**
 * The wicked-interactive bridge pool — discovery, health, reuse-or-start (DES-MERGE-001 §5.3/§5.6).
 *
 * A bridge is a local `wicked-interactive serve` process that records itself in
 * `<root>/.wi-serve.json` = `{ port, host, pid, startedAt, version }` (ADR-0022). Its port is
 * DYNAMIC — the first free port above its base — which is precisely why crew, a server process
 * that can read that lockfile, proxies it instead of the browser dialling a port literal.
 *
 * LOCAL-ONLY BY DESIGN. Every mechanism here (a pid, a file in a directory, spawning a child)
 * is single-host. That is the slice-1 posture, not an oversight: when the execution seam goes
 * remote, this module is the seam that gets a remote implementation, and the proxy above it
 * does not change.
 *
 * Pooling is keyed by the RESOLVED root (see `bridge-root.ts`), so two projects that share the
 * default root share one bridge and one port; projects bound to different roots get their own.
 *
 * Health follows ADR-0025's hardened reuse check, and the ORDER matters: a recorded pid that is
 * alive but slow (cold first hit, busy materializing) must be REUSED, not duplicated — so a
 * live pid earns three 1.5 s attempts before the bridge is declared dead. Identity is checked
 * too: `/api/health` must report THIS root, or a recycled port belonging to some other service
 * would be proxied as if it were ours.
 *
 * On start/adopt the pool also records the daemon's own origin with the bridge (crew#298,
 * `POST /api/studio-origin`, interactive ≥ 0.8.0) so the bridge's `GET /` redirects a direct
 * visitor into studio instead of its API-only fallback page. Fire-and-forget, once per pooled
 * bridge: recording can never fail — or slow down — a proxied request.
 *
 * THE SPAWN ENV (acceptance findings F-042 + F-043). The bridge validates and registers a doc's
 * project against `WICKED_CREW_API` — defaulting to `http://127.0.0.1:7701` when unset — and emits
 * onto the wicked-bus at `WICKED_BUS_DATA_DIR` — defaulting to `~/.something-wicked/wicked-bus`.
 * A bridge spawned with the daemon's bare env therefore talked to whatever daemon owned :7701 (a
 * daemon on any other port could not create a single project-bound document) and shared ONE bus
 * with every other daemon on the host (two daemons' durable cursors racing for one `doc.created`).
 * So the spawn now exports BOTH: `WICKED_CREW_API` = this daemon's own bound origin, and
 * `WICKED_BUS_DATA_DIR` = the directory of the bus this daemon's interactive seams read. The pair
 * is written beside the lockfile (`.wi-serve.crew.json`) so an ADOPTED bridge can be checked: one
 * this daemon (or a sibling) started with a DIFFERENT pair is recycled — restarted with the right
 * env — and one nobody recorded (an operator-run `wicked-interactive serve`, a pre-upgrade bridge)
 * is adopted with a warning that names the fix. A bridge is only useful to the daemon whose bus it
 * emits to; sharing one across daemons is exactly the isolation break F-043 recorded.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

export const LOCK_NAME = '.wi-serve.json';
/** Crew's sidecar beside the bridge's lockfile: which pid crew started, and with which env (F-042/F-043). */
export const CREW_SIDECAR_NAME = '.wi-serve.crew.json';
/** How long a recycled bridge gets to exit on SIGTERM before SIGKILL. */
export const RECYCLE_GRACE_MS = 3000;

/**
 * The wicked-interactive range crew will start, as an npm spec.
 *
 * The spawn used to be a bare `npx --yes wicked-interactive`, which resolves whatever the public
 * registry calls `latest` AT RUNTIME — no lockfile entry, no integrity hash, no floor. Three things
 * follow from that, and none of them are theoretical:
 *
 *  - a breaking wicked-interactive release changes crew's behaviour with no crew change, no review,
 *    and nothing in crew's history to point at during the incident;
 *  - crew has no way to REQUIRE a route it depends on. The learned-theme readback
 *    (`GET /d/:docId/api/theme/learned`, interactive#181) shipped in 0.8.1; against 0.8.0 the
 *    brand-learn surface polls forever and degrades silently. A floor turns that into a resolvable
 *    version, not a mystery;
 *  - the resolution is a network fetch from a public registry into a long-lived daemon.
 *
 * A caret floor is the smallest fix that closes the first two: it pins the MAJOR-compatible range so
 * a 0.9.0 cannot arrive unannounced, and it states the minimum crew actually needs. It does NOT make
 * the fetch reproducible — that needs a real dependency with a lockfile entry, which is the
 * follow-up this comment exists to keep visible.
 *
 * Bump this when crew starts depending on a newer interactive route, and say which route in the
 * commit.
 */
export const INTERACTIVE_SPEC = 'wicked-interactive@^0.8.1';
/** ADR-0025: 1.5 s × 3 while the pid lives. */
export const HEALTH_TIMEOUT_MS = 1500;
export const HEALTH_ATTEMPTS = 3;
/** A cold `npx wicked-interactive serve` may have to resolve and fetch the package first. */
export const START_TIMEOUT_MS = 60_000;

/** A bridge that answered `/api/health` for its root. */
export interface LiveBridge {
  host: string;
  port: number;
  pid: number;
}

/** The 503 the proxy renders as `{"code":"bridge_unavailable","hint":...}` (§5.6). */
export class BridgeUnavailableError extends Error {
  /** An ACTIONABLE command an operator can actually run — never a bare "try again". */
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'BridgeUnavailableError';
    this.hint = hint;
  }
}

/** The one command that reproduces a failed start in a terminal, where its output is visible. */
function serveCommand(root: string): string {
  return `npx ${INTERACTIVE_SPEC} serve --root ${root}`;
}

/** The two variables crew hands the bridge it spawns (F-042/F-043). Absent = not set — the bridge
 *  falls back to its own defaults, which is exactly the pre-fix behavior this exists to end. */
export interface BridgeEnv {
  /** The daemon's own origin — where the bridge validates/registers project bindings. */
  WICKED_CREW_API?: string;
  /** The directory holding the `bus.db` this daemon's interactive seams read. */
  WICKED_BUS_DATA_DIR?: string;
}

/** What crew writes beside the lockfile after IT starts a bridge. */
export interface CrewSidecar {
  /** The bridge's pid (the lockfile's). */
  pid: number;
  env: BridgeEnv;
  startedBy: 'wicked-crew';
  startedAt: string;
  /** The DAEMON that spawned it. A bridge whose owner is still alive is that daemon's to stop —
   *  never this one's (codex on crew#506). */
  ownerPid?: number;
}

/** Injectable IO — the integration suite substitutes a fake bridge for the real `npx` spawn. */
export interface BridgePoolIo {
  /** The spawn; the second argument is the FULL child env (the daemon's, plus {@link BridgeEnv}). */
  spawn?: (root: string, env: NodeJS.ProcessEnv) => ChildProcess;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Lower-severity channel for EXPECTED skips (a pre-0.8.0 bridge without the endpoint, #298). */
  debug?: (msg: string) => void;
  /**
   * The daemon's own origin (`http://<bound host>:<bound port>`), resolved LAZILY — the pool is
   * built before `listen`, but only consulted while serving a request, i.e. after the address is
   * bound. Null (or absent) means "nothing to record" and the pool never POSTs (#298). It is also
   * the `WICKED_CREW_API` the spawned bridge gets (F-042) — the bridge must talk to THIS daemon.
   */
  studioOrigin?: () => string | null;
  /**
   * The directory of the bus db this daemon's interactive seams read — exported to the spawned
   * bridge as `WICKED_BUS_DATA_DIR` so both meet on one bus (F-043), and recorded in the sidecar so
   * an adopted bridge can be checked against it. Null/absent = not exported (the bridge keeps
   * wicked-bus's own default): the CLI passes null only when `--bus-db` names a file wicked-bus
   * cannot be pointed at through a data dir, or wicked-bus is not importable at all.
   */
  busDataDir?: string | null;
}

/** The {@link BridgeEnv} this pool hands a bridge it starts, from its io. Only DEFINED values ride. */
export function bridgeEnvFor(io: Pick<BridgePoolIo, 'studioOrigin' | 'busDataDir'>): BridgeEnv {
  const origin = io.studioOrigin?.() ?? null;
  const busDir = io.busDataDir ?? null;
  return {
    ...(origin !== null ? { WICKED_CREW_API: origin } : {}),
    ...(busDir !== null ? { WICKED_BUS_DATA_DIR: busDir } : {}),
  };
}

export { busDataDirOf } from './bus-location.js';

/** `true` when two bridge envs agree on every variable either one sets. */
export function bridgeEnvMatches(a: BridgeEnv, b: BridgeEnv): boolean {
  return a.WICKED_CREW_API === b.WICKED_CREW_API && a.WICKED_BUS_DATA_DIR === b.WICKED_BUS_DATA_DIR;
}

/** `<root>/.wi-serve.crew.json`, or null when absent/unparseable/incomplete. */
export function readCrewSidecar(root: string): CrewSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, CREW_SIDECAR_NAME), 'utf8')) as Partial<CrewSidecar>;
    if (typeof raw.pid !== 'number' || typeof raw.env !== 'object' || raw.env === null) return null;
    const env: BridgeEnv = {
      ...(typeof raw.env.WICKED_CREW_API === 'string' ? { WICKED_CREW_API: raw.env.WICKED_CREW_API } : {}),
      ...(typeof raw.env.WICKED_BUS_DATA_DIR === 'string' ? { WICKED_BUS_DATA_DIR: raw.env.WICKED_BUS_DATA_DIR } : {}),
    };
    return {
      pid: raw.pid,
      env,
      startedBy: 'wicked-crew',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      ...(typeof raw.ownerPid === 'number' ? { ownerPid: raw.ownerPid } : {}),
    };
  } catch {
    return null;
  }
}

function describeEnv(env: BridgeEnv): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? parts.join(' ') : '(no env)';
}

/**
 * The daemon's own http origin from its bound server address, or null before `listen`. Wildcard
 * binds (`0.0.0.0` / `::`) are not dialable from a browser, so they normalize to loopback — the
 * bridge is local-only anyway, so whoever hits its port can reach the daemon at 127.0.0.1 too.
 */
export function boundOrigin(addr: AddressInfo | string | null): string | null {
  if (addr === null || typeof addr === 'string') return null;
  const host =
    addr.address === '' || addr.address === '0.0.0.0' || addr.address === '::'
      ? '127.0.0.1'
      : addr.address.includes(':')
        ? `[${addr.address}]`
        : addr.address;
  return `http://${host}:${addr.port}`;
}

/** `<root>/.wi-serve.json`, or null when absent/unparseable/incomplete. */
export function readLock(root: string): LiveBridge | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, LOCK_NAME), 'utf8')) as Partial<LiveBridge>;
    if (typeof raw.port !== 'number' || typeof raw.pid !== 'number') return null;
    return { host: typeof raw.host === 'string' && raw.host !== '' ? raw.host : '127.0.0.1', port: raw.port, pid: raw.pid };
  } catch {
    return null;
  }
}

/** Signal 0 probes existence without delivering: EPERM means alive-but-not-ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `GET /api/health` → the root that bridge is serving, or null (timeout, refusal, non-200). */
async function bridgeIdentity(bridge: LiveBridge, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`http://${bridge.host}:${bridge.port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { root?: unknown };
    return typeof body.root === 'string' ? body.root : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A pool entry: the live bridge plus per-entry bookkeeping that dies with it. */
interface PooledBridge {
  bridge: LiveBridge;
  /** #298: the studio origin has been POSTed to this pooled bridge (at most once per entry). */
  originRecorded: boolean;
}

export class InteractiveBridgePool {
  private readonly io: BridgePoolIo;
  /** Last bridge known good per root — the fast path that keeps the proxy off `fetch` per request. */
  private readonly live = new Map<string, PooledBridge>();
  /** In-flight resolutions per root, so a burst of first requests starts ONE bridge, not N. */
  private readonly inflight = new Map<string, Promise<LiveBridge>>();

  constructor(io: BridgePoolIo = {}) {
    this.io = io;
  }

  /** Reuse-or-start, idempotent per root. Throws `BridgeUnavailableError` when start is impossible. */
  async ensure(root: string): Promise<LiveBridge> {
    // Fast path: we started/adopted it and its pid is still alive. A full health round-trip on
    // every proxied request would put a 1.5 s timeout budget in front of every asset fetch.
    const cached = this.live.get(root);
    if (cached && pidAlive(cached.bridge.pid)) return cached.bridge;
    this.live.delete(root);

    const pending = this.inflight.get(root);
    if (pending) return pending;
    const started = this.resolveOrStart(root).finally(() => this.inflight.delete(root));
    this.inflight.set(root, started);
    return started;
  }

  /** Drop the cached bridge for a root — called when a proxied connection is refused. */
  invalidate(root: string): void {
    this.live.delete(root);
  }

  /** Live bridges, for tests and future operator introspection. */
  keys(): string[] {
    return [...this.live.keys()];
  }

  private async resolveOrStart(root: string): Promise<LiveBridge> {
    // Adopt-or-start; either way the bridge just answered `/api/health` for this root, which is
    // exactly the moment #298 wants the studio origin recorded — fire-and-forget, so recording
    // can never delay (let alone fail) the proxied request that triggered the resolution.
    const adopted = await this.healthy(root);
    const bridge = adopted !== null ? await this.adoptOrRecycle(root, adopted) : await this.start(root);
    const entry: PooledBridge = { bridge, originRecorded: false };
    this.live.set(root, entry);
    this.recordStudioOrigin(entry);
    return bridge;
  }

  /**
   * A live bridge was found through the lockfile. Is it one THIS daemon can use (F-042/F-043)?
   *  - crew's sidecar names this pid and its env matches ours → adopt silently;
   *  - the sidecar names this pid with a DIFFERENT env: if the daemon that spawned it (`ownerPid`)
   *    is STILL ALIVE, the bridge is that daemon's — two daemons sharing one docs root — and this
   *    one must not kill it mid-create (codex on crew#506): refuse with a `BridgeUnavailableError`
   *    naming the owner and the fix (give this daemon its own interactive root). Only a bridge
   *    whose owner is gone (a previous daemon that exited, or this very process after a
   *    reconfiguration) is recycled — SIGTERM, grace, SIGKILL — and restarted with the right env;
   *  - no sidecar (or another pid) → nobody recorded how it was started (an operator's terminal
   *    `wicked-interactive serve`, a pre-upgrade bridge): adopt it, but say what it may be missing
   *    and how to fix it. Killing a process crew did not start is not crew's call.
   */
  private async adoptOrRecycle(root: string, live: LiveBridge): Promise<LiveBridge> {
    const expected = bridgeEnvFor(this.io);
    const sidecar = readCrewSidecar(root);
    if (sidecar !== null && sidecar.pid === live.pid) {
      if (bridgeEnvMatches(sidecar.env, expected)) return live;
      const owner = sidecar.ownerPid;
      const ownerOrigin = sidecar.env.WICKED_CREW_API ?? '(unknown origin)';
      if (owner === undefined || !Number.isInteger(owner) || owner <= 0) {
        // No PROVEN owner (a pre-upgrade sidecar): not this daemon's to kill, and not adoptable
        // either — its events go elsewhere. Refuse and name the fix (codex on crew#506).
        this.io.log?.(
          `interactive bridge pid ${live.pid} for ${root} was recorded without an owning daemon and with ` +
            `${describeEnv(sidecar.env)}; this daemon needs ${describeEnv(expected)} — NOT recycling a bridge of unproven ownership`,
        );
        throw new BridgeUnavailableError(
          `the interactive bridge for ${root} (pid ${live.pid}) was started for a different bus or crew API ` +
            `(${ownerOrigin}) by a daemon this one cannot identify`,
          `stop it yourself (kill ${live.pid}) if no other crew daemon is using it, or give this daemon its own ` +
            `interactive root (WICKED_INTERACTIVE_ROOT, or the project's interactiveRoot setting); the next request starts a bridge for this one`,
        );
      }
      if (owner !== process.pid && pidAlive(owner)) {
        this.io.log?.(
          `interactive bridge pid ${live.pid} for ${root} belongs to another live crew daemon (pid ${owner}, ` +
            `${ownerOrigin}) with ${describeEnv(sidecar.env)}; this daemon needs ${describeEnv(expected)} — NOT ` +
            `recycling a bridge another daemon owns`,
        );
        throw new BridgeUnavailableError(
          `the interactive bridge for ${root} is owned by another running crew daemon (pid ${owner}, ${ownerOrigin}) ` +
            `on a different bus or crew API — two daemons cannot share one interactive docs root`,
          `give this daemon its own interactive root (WICKED_INTERACTIVE_ROOT, or the project's interactiveRoot ` +
            `setting) or stop the other daemon (pid ${owner}); the next request starts a bridge for this one`,
        );
      }
      this.io.log?.(
        `interactive bridge pid ${live.pid} for ${root} was started by crew${owner !== undefined ? ` (daemon pid ${owner}, gone)` : ''} ` +
          `with ${describeEnv(sidecar.env)}, but this daemon needs ${describeEnv(expected)} — recycling it so its events reach this daemon`,
      );
      await this.terminate(live.pid);
      return this.start(root);
    }
    if (Object.keys(expected).length > 0) {
      this.io.log?.(
        `adopting interactive bridge pid ${live.pid} for ${root}, which this daemon did not start: it may not ` +
          `share this daemon's bus or crew API (expected ${describeEnv(expected)}). If documents created ` +
          `through this project stay on their placeholder, stop it (kill ${live.pid}) — the next request ` +
          `restarts it with this daemon's env.`,
      );
    }
    return live;
  }

  /** SIGTERM, wait up to {@link RECYCLE_GRACE_MS} for exit, SIGKILL whatever ignored it. */
  private async terminate(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // already gone (or not ours to signal — the start below will surface a stale lock)
    }
    const deadline = Date.now() + RECYCLE_GRACE_MS;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await sleep(50);
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* exited between the check and the kill */
    }
    const hardDeadline = Date.now() + 1000;
    while (pidAlive(pid) && Date.now() < hardDeadline) await sleep(25);
  }

  /**
   * POST the daemon's own origin to the bridge's `/api/studio-origin` (#298), so the bridge's
   * `GET /` redirects a direct visitor into studio instead of the API-only fallback page.
   * At most one attempt per pooled bridge per process; 404/405 means the bridge predates the
   * endpoint (interactive < 0.8.0) and is an expected skip, any other failure is a warn — never
   * an error, because origin recording must never fail a proxy request.
   */
  private recordStudioOrigin(entry: PooledBridge): void {
    if (entry.originRecorded) return;
    entry.originRecorded = true;
    const origin = this.io.studioOrigin?.() ?? null;
    if (origin === null) return; // no origin to record (pool not bootstrapped from a listening daemon)
    const { host, port } = entry.bridge;
    const timeout = this.io.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    void (async () => {
      try {
        const res = await fetch(`http://${host}:${port}/api/studio-origin`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ origin }),
          signal: AbortSignal.timeout(timeout),
        });
        await res.arrayBuffer().catch(() => undefined); // drain, so the connection is released
        if (res.status === 404 || res.status === 405) {
          this.io.debug?.(
            `bridge at ${host}:${port} has no /api/studio-origin (interactive < 0.8.0) — skipping origin record`,
          );
        } else if (!res.ok) {
          this.io.log?.(`recording studio origin ${origin} with the bridge at ${host}:${port} failed: HTTP ${res.status}`);
        }
      } catch (err) {
        this.io.log?.(
          `recording studio origin ${origin} with the bridge at ${host}:${port} failed: ${(err as Error).message}`,
        );
      }
    })();
  }

  /** The lockfile points at a bridge that is alive, answering, and serving THIS root. */
  private async healthy(root: string): Promise<LiveBridge | null> {
    const lock = readLock(root);
    if (lock === null || !pidAlive(lock.pid)) return null;
    const timeout = this.io.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
      const identity = await bridgeIdentity(lock, timeout);
      if (identity !== null && resolve(identity) === root) return lock;
      // Only keep retrying while the pid still lives — a bridge that exited mid-probe is dead,
      // not slow, and burning the remaining attempts on it just delays the restart.
      if (!pidAlive(lock.pid)) return null;
      if (attempt < HEALTH_ATTEMPTS - 1) await sleep(300);
    }
    return null;
  }

  private async start(root: string): Promise<LiveBridge> {
    try {
      // `npx` runs with cwd=root; a missing directory fails the spawn with an opaque error.
      mkdirSync(root, { recursive: true });
    } catch (err) {
      throw new BridgeUnavailableError(
        `interactive root ${root} is not usable: ${(err as Error).message}`,
        `create the docs root and retry: mkdir -p ${root} && ${serveCommand(root)}`,
      );
    }

    let spawnFailure: string | null = null;
    // F-042/F-043: the bridge gets THIS daemon's crew API and bus location on top of the daemon's
    // own env. The daemon's bound origin wins over an inherited WICKED_CREW_API — the bridge
    // validates project bindings against whatever it is told, and only this daemon has them.
    const bridgeEnv = bridgeEnvFor(this.io);
    const env: NodeJS.ProcessEnv = { ...process.env, ...bridgeEnv };
    const child = (this.io.spawn ?? defaultSpawn)(root, env);
    // Detached + unref: the bridge is a SHARED instance keyed by root, so it must outlive the
    // daemon that happened to start it (and be adoptable by the next one via the lockfile).
    child.on('error', (err) => {
      spawnFailure = err.message;
    });
    child.unref?.();

    const deadline = Date.now() + (this.io.startTimeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (spawnFailure !== null) {
        throw new BridgeUnavailableError(
          `could not spawn the interactive bridge in ${root}: ${spawnFailure}`,
          `install Node 22+ so \`npx\` is on PATH, then run: ${serveCommand(root)}`,
        );
      }
      const healthy = await this.healthy(root);
      if (healthy) {
        this.writeSidecar(root, healthy.pid, bridgeEnv);
        return healthy;
      }
      await sleep(150);
    }
    this.io.log?.(`interactive bridge for ${root} did not come up within the start budget`);
    throw new BridgeUnavailableError(
      `the interactive bridge for ${root} did not become healthy in time`,
      `run \`${serveCommand(root)}\` in a terminal to see the failure (or check ${join(root, '.wi-serve.log')})`,
    );
  }

  /** Record which pid crew started and with which env, so a later adopt can tell ours from a
   *  sibling daemon's (see {@link adoptOrRecycle}). Best-effort: an unwritable sidecar only costs
   *  the adopt-time check, never the start. */
  private writeSidecar(root: string, pid: number, env: BridgeEnv): void {
    const sidecar: CrewSidecar = { pid, env, startedBy: 'wicked-crew', startedAt: new Date().toISOString(), ownerPid: process.pid };
    try {
      writeFileSync(join(root, CREW_SIDECAR_NAME), JSON.stringify(sidecar, null, 2), 'utf8');
    } catch (err) {
      this.io.debug?.(`could not write ${CREW_SIDECAR_NAME} in ${root}: ${(err as Error).message}`);
    }
  }
}

/** `npx wicked-interactive serve` in `<root>`, detached, output to the bridge's own log, with the
 *  env the pool computed (the daemon's own plus {@link BridgeEnv}). */
function defaultSpawn(root: string, env: NodeJS.ProcessEnv): ChildProcess {
  // `--yes` is load-bearing: without it npx PROMPTS when the package is not installed, and a
  // daemon has no tty to answer with — the request would hang instead of failing to a 503.
  return nodeSpawn('npx', ['--yes', INTERACTIVE_SPEC, 'serve', '--root', root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env,
  });
}
