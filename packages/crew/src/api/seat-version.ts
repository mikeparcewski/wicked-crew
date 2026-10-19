/**
 * Every seat's installed version (DES-seats-page A1): `RosterSeat.version`.
 *
 * `version_pin` (core#581, `diagnostics.ts`) exists only for a seat whose ACP config pins a build
 * (opencode). Every other seat read "Not reported" on the Agents page, although the registry record
 * already carries the argv that answers it (`version_probe`, e.g. `["claude", "--version"]`).
 *
 * The reading, per seat:
 *  - `installed`: the first non-empty line the seat's `version_probe` prints (stdout, then stderr),
 *    bounded and with the home directory written `~`; `null` when it did not answer;
 *  - `proven` / `status`: from the pin reading when the seat pins a build (`proven` = the pinned
 *    build; `status` = `proven` when the pin holds, else `unproven`), `no_pin` otherwise. A pinned
 *    seat whose pin has not been probed yet carries no `version` at all, never a guessed status;
 *  - `why` (crew#1004, `unproven` only): `no_answer` when the pin's own `--version` probe got no
 *    answer, `different_build` when it answered with another build;
 *  - `install_source`: how the binary on PATH was installed, read off its resolved path (no
 *    spawn): under `node_modules` = `npm`, under a Homebrew prefix = `brew`, else `other`; `null`
 *    when the binary is not on PATH. It lets the Agents page offer a real update command instead of
 *    guessing one. The path itself never reaches the wire.
 *
 * crew#1004, a deliberate choice: `status` comes from the pin reading alone, never from `installed`.
 * The pin reading mirrors the engine's spawn-time check (`probe_resolved_binary_version`: the pin's
 * own binary, its first line byte for byte), and the engine switches the seat's safety checks off
 * when that check gets no answer. So a pin probe with no answer stays `unproven` (fail closed) even
 * when `installed` reads exactly the pinned build: `why: 'no_answer'` says the build was not shown
 * to differ, only not confirmed. `installed` equal to `proven` with an unexplained `unproven` is
 * never served.
 *
 * Cost: one bounded `--version` per seat per {@link SEAT_VERSION_TTL_MS}, in the background; the
 * roster read never waits on it. A test-built server spawns nothing (no source under a runner).
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { CoreAdapter } from '../core/adapter.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import type { SeatVersionPin } from './diagnostics.js';
import { scrubEvidence } from './seat-scrub.js';
import { homeless } from './seat-standing.js';

/** How long a version reading is trusted before a background refresh. */
export const SEAT_VERSION_TTL_MS = 10 * 60 * 1000;
/** A read where some seat's `--version` did not answer (a slow start on a loaded host) is retried
 *  this soon, not after the full TTL. */
export const SEAT_VERSION_RETRY_MS = 2 * 60 * 1000;
/** How long a seat's last answered version outlives later probes that did not answer. */
export const SEAT_VERSION_KEEP_MS = 60 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10 * 1000;
const VERSION_MAX = 80;

export type SeatInstallSource = 'npm' | 'brew' | 'other';

/** One seat's probed version (what the cache keeps). */
export interface SeatVersionReading {
  cli: string;
  installed: string | null;
  checked_at: string;
  install_source: SeatInstallSource | null;
}

/** Why a pinned seat reads `unproven` (crew#1004; see the module doc). */
export type SeatVersionUnprovenWhy = 'no_answer' | 'different_build';

/** `RosterSeat.version` (api-types 0.115.0; `why` 0.129.0): `why` exactly when `unproven`. */
export type SeatVersion = {
  installed: string | null;
  proven: string | null;
  checked_at: string;
  install_source: SeatInstallSource | null;
} & ({ status: 'proven' | 'no_pin' } | { status: 'unproven'; why: SeatVersionUnprovenWhy });

/** Runs one version probe; resolves to its combined output, or `null` when it did not answer. */
export type VersionExec = (cmd: string, args: string[]) => Promise<string | null>;

/** Resolves a binary name to its real path on PATH, or `null`. */
export type BinaryResolver = (binary: string) => string | null;

const execVersion: VersionExec = (cmd, args) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { env: childEnvWithBootEstateDb(process.env), cwd: tmpdir(), timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => resolve(err === null ? `${String(stdout ?? '')}\n${String(stderr ?? '')}` : null),
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });

/** The binary's real path on PATH (`which` + realpath), or `null` when it is not there. */
export function resolveOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (binary.includes('/') || binary.includes('\\')) return null;
  const exts = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** How a binary was installed, from its resolved path (see the module doc). */
export function installSourceOf(realPath: string | null): SeatInstallSource | null {
  if (realPath === null) return null;
  const p = realPath.replace(/\\/g, '/');
  if (p.includes('/node_modules/')) return 'npm';
  if (/\/(?:Cellar|Caskroom)\/|^\/opt\/homebrew\/|\/\.?linuxbrew\//.test(p)) return 'brew';
  return 'other';
}

/** The first non-empty line of a probe's output, bounded and home-free; `null` for none. */
export function firstVersionLine(output: string | null): string | null {
  if (output === null) return null;
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return null;
  // A `--version` line is a CLI's own output: the home is written `~`, and the A8 mask is the guard.
  const safe = scrubEvidence(homeless(line));
  return safe.length <= VERSION_MAX ? safe : `${safe.slice(0, VERSION_MAX - 1)}…`;
}

interface VersionSeat {
  key?: unknown;
  binary?: unknown;
  version_probe?: unknown;
}

/** Probe every seat's version (in parallel, each bounded). */
export async function probeSeatVersions(
  roster: unknown[],
  exec: VersionExec = execVersion,
  resolve: BinaryResolver = resolveOnPath,
  now: () => number = Date.now,
): Promise<SeatVersionReading[]> {
  return Promise.all(
    (roster as VersionSeat[])
      .filter((s) => typeof s.key === 'string' && typeof s.binary === 'string')
      .map(async (s) => {
        const binary = String(s.binary);
        const argv =
          Array.isArray(s.version_probe) && s.version_probe.length > 0 && s.version_probe.every((a) => typeof a === 'string')
            ? (s.version_probe as string[])
            : [binary, '--version'];
        const out = await exec(argv[0]!, argv.slice(1)).catch(() => null);
        return {
          cli: String(s.key),
          installed: firstVersionLine(out),
          checked_at: new Date(now()).toISOString(),
          install_source: installSourceOf(resolve(argv[0]!)),
        };
      }),
  );
}

/** A TTL cache of {@link probeSeatVersions}: read synchronously, refreshed in the background. */
export class SeatVersionCache {
  /** `missing` — some installed seat's probe did not answer: the read is retried after
   *  {@link SEAT_VERSION_RETRY_MS}. `silent` — per seat whose last answer was kept, what this probe
   *  said, served once the kept answer is older than {@link SEAT_VERSION_KEEP_MS}. */
  private value: { at: number; readings: SeatVersionReading[]; missing: boolean; silent: Map<string, SeatVersionReading> } | null = null;
  private inFlight: Promise<void> | null = null;
  private failedAt: number | null = null;

  constructor(
    private readonly source: (() => Promise<SeatVersionReading[]>) | null = defaultSeatVersionSource(),
    private readonly ttlMs: number = SEAT_VERSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private stale(): boolean {
    const t = this.now();
    if (this.failedAt !== null && t - this.failedAt < this.ttlMs) return false;
    if (this.value === null) return true;
    return t - this.value.at >= (this.value.missing ? Math.min(this.ttlMs, SEAT_VERSION_RETRY_MS) : this.ttlMs);
  }

  /** Probe now unless a probe is running; resolves when the answer is in. */
  refresh(): Promise<void> {
    if (this.source === null) return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.source()
      .then((fresh) => {
        // A seat whose binary is on PATH but whose `--version` did not answer this time keeps its last
        // answered reading (bounded by SEAT_VERSION_KEEP_MS): a timed-out probe is not news that the
        // CLI changed, and the Agents page would otherwise read "Not reported" for a whole TTL. A
        // binary that is no longer on PATH (`install_source: null`) is news: it is never papered over.
        const at = this.now();
        const prev = this.value?.readings ?? [];
        const silent = new Map<string, SeatVersionReading>();
        const didNotAnswer = (r: SeatVersionReading): boolean => r.installed === null && r.install_source !== null;
        const readings = fresh.map((r) => {
          if (!didNotAnswer(r)) return r;
          const kept = prev.find((p) => p.cli === r.cli && p.installed !== null && at - Date.parse(p.checked_at) < SEAT_VERSION_KEEP_MS);
          if (kept === undefined) return r;
          silent.set(r.cli, r);
          return kept;
        });
        this.value = { at, readings, missing: fresh.some(didNotAnswer), silent };
        this.failedAt = null;
      })
      .catch(() => {
        this.failedAt = this.now();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The last reading for `cli`, without waiting; a stale or empty cache starts a refresh. */
  read(cli: string): SeatVersionReading | undefined {
    if (this.source !== null && this.stale()) void this.refresh();
    const r = this.value?.readings.find((x) => x.cli === cli);
    const silent = this.value?.silent.get(cli);
    // A kept answer past its window is not served, whether or not a refresh has landed since.
    if (r !== undefined && silent !== undefined && this.now() - Date.parse(r.checked_at) >= SEAT_VERSION_KEEP_MS) return silent;
    return r;
  }
}

/** The daemon's source: the engine's production roster. `null` under a test runner (no spawns). */
export function defaultSeatVersionSource(): (() => Promise<SeatVersionReading[]>) | null {
  if (process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test') return null;
  return async () => probeSeatVersions(CoreAdapter.roster());
}

/** The daemon's one version cache. */
export const seatVersions = new SeatVersionCache();

/**
 * `RosterSeat.version` from a seat's reading and its pin reading (see the module doc). `undefined`
 * when there is no reading yet, or when the seat pins a build whose pin has not been probed.
 */
export function seatVersion(
  seat: { acp?: { verified_version?: unknown } | null },
  reading: SeatVersionReading | undefined,
  pin: SeatVersionPin | undefined,
): SeatVersion | undefined {
  if (reading === undefined) return undefined;
  const pinned = typeof seat.acp?.verified_version === 'string' ? seat.acp.verified_version : null;
  if (pinned !== null && pin === undefined) return undefined;
  const base = { installed: reading.installed, proven: pinned, checked_at: reading.checked_at, install_source: reading.install_source };
  if (pinned === null) return { ...base, status: 'no_pin' };
  if (pin?.matched === true) return { ...base, status: 'proven' };
  return { ...base, status: 'unproven', why: pin?.observed === null ? 'no_answer' : 'different_build' };
}
