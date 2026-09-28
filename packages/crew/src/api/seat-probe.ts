/**
 * Seat credential PROBE (crew#630, crew#645): ask the seat's own CLI whether it can authenticate,
 * under the seat's own configuration home, instead of inferring it from a file.
 *
 * # The defect
 *
 * `seat-signin.ts` reads presence: claude's `<worker home>/claude/.claude.json` with an
 * `oauthAccount` reads signed in. Claude Code keeps the OAuth token itself in the OS keychain, under
 * a service name keyed by a hash of `CLAUDE_CONFIG_DIR` — so a moved or renamed worker home keeps
 * the file and loses the token, and an expired login keeps both. The roster said `signed_in`,
 * launch trusted it, and every ballot / unit on the seat failed "Not logged in" (crew#630) or "OAuth
 * session expired" (crew#645) after the run was already planned.
 *
 * # The probe
 *
 * The CLI's own auth-status command, where one exists, run with the SAME configuration-home variable
 * the engine sets on that seat's workers (`wicked_apps_core::spawn::seat_config_for`):
 *
 *   claude — `claude auth status --json` with `CLAUDE_CONFIG_DIR=<root>/claude` → `loggedIn`.
 *            It resolves the keychain entry for THAT config dir, so the moved-home case reads false.
 *   codex  — `codex login status` with `CODEX_HOME=<root>/codex` → exit 0 = signed in.
 *
 * Seats with no status command (pi, copilot, opencode, agy) are not probed: their reading stays the
 * credential-file heuristic plus the seat's own refusal (`seat-health.ts`).
 *
 * # Cost
 *
 * The roster route is read on every studio poll, so the probe NEVER runs on the request path:
 * `read()` answers from a cache synchronously and, when the entry is older than its TTL, starts
 * one refresh in the background (deduplicated per seat, one probe process at a time host-wide
 * for this daemon). A signed-in answer is kept for 5 minutes; a signed-out or unknown one for 30 s,
 * so a seat signed in from the System page turns green on the next poll or two. The cache is keyed
 * by (seat, worker home): changing `worker_config_root` discards every answer at once.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { childEnvWithBootEstateDb } from '../core/governance-store.js';

/** A probe process's outcome, as the runner reports it. `error` is set when it never ran to exit
 *  (not installed, timed out, killed). */
export interface ProbeOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs one probe command — injectable so tests never spawn a CLI. */
export type ProbeRunner = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<ProbeOutput>;

/** One seat's probe answer. */
export interface SeatProbeReading {
  /** `true` the seat authenticates, `false` it does not, `null` the probe could not tell. */
  signedIn: boolean | null;
  /** ISO-8601 of the probe. */
  probedAt: string;
  /** A bounded excerpt of what the CLI said (its own words for a `false`). */
  detail: string;
}

/** How long an answer is trusted before a background refresh (the stale answer is served meanwhile). */
export const PROBE_TTL_SIGNED_IN_MS = 5 * 60 * 1000;
export const PROBE_TTL_OTHER_MS = 30 * 1000;
/** A status command is local and fast (~1 s); past this it is not answering. */
export const PROBE_TIMEOUT_MS = 15 * 1000;

const DETAIL_MAX = 240;

function excerpt(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= DETAIL_MAX ? flat : `${flat.slice(0, DETAIL_MAX - 1)}…`;
}

/** The probe command for a seat, or `null` when the seat's CLI has no auth-status command. */
export function probeCommand(
  seatKey: string,
  workerRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  // The engine's one hatch: set, every seat runs on the operator's own CLI homes (no override).
  const inherit = env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG'] !== undefined;
  const root = workerRoot !== undefined && workerRoot !== '' ? workerRoot : join(home, '.wicked-worker');
  const withHome = (name: string, dir: string): NodeJS.ProcessEnv =>
    inherit ? { ...env } : { ...env, [name]: dir };
  switch (seatKey) {
    case 'claude':
      return { cmd: 'claude', args: ['auth', 'status', '--json'], env: withHome('CLAUDE_CONFIG_DIR', join(root, 'claude')) };
    case 'codex':
      return { cmd: 'codex', args: ['login', 'status'], env: withHome('CODEX_HOME', join(root, 'codex')) };
    default:
      return null;
  }
}

/** Read a probe's outcome: `null` when it did not run to an answer (missing CLI, timeout). */
export function classifyProbe(seatKey: string, out: ProbeOutput): boolean | null {
  if (out.error !== undefined || out.code === null) return null;
  if (seatKey === 'claude') {
    try {
      const parsed = JSON.parse(out.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
    } catch {
      /* not JSON: fall through to the exit code */
    }
  }
  if (out.code === 0) return true;
  return /not logged in|logged out|not authenticated/i.test(`${out.stdout}\n${out.stderr}`) ? false : null;
}

/** The production runner: `execFile` with a timeout, never a shell. */
export const execProbe: ProbeRunner = (cmd, args, env, timeoutMs) =>
  new Promise((resolve) => {
    // The engine-only store variables go back to their BOOT values, as for every crew child (crew#495).
    execFile(cmd, args, { env: childEnvWithBootEstateDb(env), timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      // A non-zero exit carries its exit code as a NUMBER `code`; a spawn failure (ENOENT) a
      // string one; a timeout kills the child (`killed`, no code).
      const e = err as { code?: unknown; killed?: boolean; message: string } | null;
      const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      if (e === null) resolve({ code: 0, ...out });
      else if (typeof e.code === 'number' && e.killed !== true) resolve({ code: e.code, ...out });
      else resolve({ code: null, ...out, error: e.message });
    });
  });

export interface SeatProbeOptions {
  run?: ProbeRunner;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** The per-daemon probe cache (see the module doc). */
export class SeatProbe {
  private readonly cache = new Map<string, SeatProbeReading & { atMs: number }>();
  private readonly inflight = new Map<string, Promise<SeatProbeReading | undefined>>();
  /** One probe process at a time: each refresh chains onto this. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly run: ProbeRunner;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly home: string | undefined;

  constructor(opts: SeatProbeOptions = {}) {
    this.run = opts.run ?? execProbe;
    this.now = opts.now ?? Date.now;
    this.env = opts.env;
    this.home = opts.home;
  }

  /** Whether this seat has a probe at all. */
  probes(seatKey: string): boolean {
    return probeCommand(seatKey, undefined, this.env ?? process.env, this.home) !== null;
  }

  /**
   * The cached answer for `seatKey` under `workerRoot` (`undefined` before the first probe
   * finishes, or for a seat with no probe). Never waits: a missing or stale answer starts one
   * background refresh.
   */
  read(seatKey: string, workerRoot: string | undefined): SeatProbeReading | undefined {
    if (!this.probes(seatKey)) return undefined;
    const hit = this.cache.get(cacheKey(seatKey, workerRoot));
    const ttl = hit?.signedIn === true ? PROBE_TTL_SIGNED_IN_MS : PROBE_TTL_OTHER_MS;
    if (hit === undefined || this.now() - hit.atMs >= ttl) void this.refresh(seatKey, workerRoot);
    if (hit === undefined) return undefined;
    return { signedIn: hit.signedIn, probedAt: hit.probedAt, detail: hit.detail };
  }

  /** Probe now (deduplicated per seat and worker home); resolves to the fresh answer. */
  refresh(seatKey: string, workerRoot: string | undefined): Promise<SeatProbeReading | undefined> {
    const key = cacheKey(seatKey, workerRoot);
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const env = this.env ?? process.env;
    const command = probeCommand(seatKey, workerRoot, env, this.home);
    if (command === null) return Promise.resolve(undefined);
    const job = this.queue
      .catch(() => undefined)
      .then(() => this.run(command.cmd, command.args, command.env, PROBE_TIMEOUT_MS))
      .then((out) => {
        const atMs = this.now();
        const reading: SeatProbeReading = {
          signedIn: classifyProbe(seatKey, out),
          probedAt: new Date(atMs).toISOString(),
          detail: excerpt(out.error ?? `${out.stdout}\n${out.stderr}`),
        };
        this.cache.set(key, { ...reading, atMs });
        return reading;
      })
      .catch(() => undefined)
      .finally(() => this.inflight.delete(key));
    this.queue = job;
    this.inflight.set(key, job);
    return job;
  }
}

function cacheKey(seatKey: string, workerRoot: string | undefined): string {
  return `${seatKey}\u0000${workerRoot ?? ''}`;
}
