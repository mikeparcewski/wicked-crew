/**
 * The wicked-interactive bridge pool — discovery, health, reuse-or-start (DES-MERGE-001 §5.3/§5.6).
 *
 * A bridge is a local `wicked-interactive serve` process that records itself in
 * `<root>/.wi-serve.json` = `{ port, host, pid, startedAt, version }` (ADR-0022). Its port is
 * DYNAMIC — first free from 4400 up — which is precisely why crew, a server process that can
 * read that lockfile, proxies it instead of the browser dialling a port literal.
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
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LOCK_NAME = '.wi-serve.json';
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
  return `npx wicked-interactive serve --root ${root}`;
}

/** Injectable IO — the integration suite substitutes a fake bridge for the real `npx` spawn. */
export interface BridgePoolIo {
  spawn?: (root: string) => ChildProcess;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  log?: (msg: string) => void;
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

export class InteractiveBridgePool {
  private readonly io: BridgePoolIo;
  /** Last bridge known good per root — the fast path that keeps the proxy off `fetch` per request. */
  private readonly live = new Map<string, LiveBridge>();
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
    if (cached && pidAlive(cached.pid)) return cached;
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
    const adopted = await this.healthy(root);
    if (adopted) {
      this.live.set(root, adopted);
      return adopted;
    }
    const started = await this.start(root);
    this.live.set(root, started);
    return started;
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
    const child = (this.io.spawn ?? defaultSpawn)(root);
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
      if (healthy) return healthy;
      await sleep(150);
    }
    this.io.log?.(`interactive bridge for ${root} did not come up within the start budget`);
    throw new BridgeUnavailableError(
      `the interactive bridge for ${root} did not become healthy in time`,
      `run \`${serveCommand(root)}\` in a terminal to see the failure (or check ${join(root, '.wi-serve.log')})`,
    );
  }
}

/** `npx wicked-interactive serve` in `<root>`, detached, output to the bridge's own log. */
function defaultSpawn(root: string): ChildProcess {
  // `--yes` is load-bearing: without it npx PROMPTS when the package is not installed, and a
  // daemon has no tty to answer with — the request would hang instead of failing to a 503.
  return nodeSpawn('npx', ['--yes', 'wicked-interactive', 'serve', '--root', root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
}
