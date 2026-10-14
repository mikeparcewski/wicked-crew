import { basename, dirname, join, resolve } from 'node:path';

import { execCapped } from '../core/exec.js';
import { canonicalize } from '../projects/state-home-preflight.js';
import { crewStateHome, stateHomeOfDb } from '../projects/state-home.js';
import { homeless } from './seat-standing.js';

export type SeatLoginVerb = 'argv' | 'ingest' | 'status' | 'sign-out';
export type ExecLike = (
  file: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface SeatLoginDeps {
  exec?: ExecLike;
  gatewayDir?: string;
}

/** First-use `seat-login argv` builds the seat image (codex crew-r2). */
export const ARGV_TIMEOUT_MS = 15 * 60_000;

/** The container seat floor is on, read exactly as the engine reads `WICKED_SEAT_FLOOR`
 *  (wicked-core `container_floor.rs`: trimmed, ASCII case-insensitive `container`), so crew's
 *  sign-in routes and roster never disagree with the engine about which floor is running. */
export function isContainerSeatFloor(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WICKED_SEAT_FLOOR'] ?? '').trim().toLowerCase() === 'container';
}

export function isContainerLoginCli(cli: string): boolean {
  return ['claude', 'codex', 'pi', 'opencode', 'copilot'].includes(cli);
}

/** The gateway dir spelled as the ENGINE spells it: the canonical state home (its `--db` parent,
 *  canonicalized) + `gateway`. The gateway's name hashes this path, so a symlinked spelling
 *  (macOS `/tmp` vs `/private/tmp`) would address a different gateway and broker. */
export function gatewayDirOf(dir: string): string {
  const abs = resolve(dir);
  // The deepest existing ancestor is resolved (agy crew-r1: a state home not created yet under a
  // symlinked `/tmp` still spells as the engine will once it exists).
  return join(canonicalize(dirname(abs)), basename(abs));
}

/** The engine's gateway dir for the daemon whose store is `dbPath` (`<canonical db parent>/gateway`,
 *  as `execute_wrapped` arms it), shared by the roster's status cache and the sign-in routes
 *  (agy crew-r1: two derivations could address two gateways). */
export function seatLoginDepsFor(dbPath: unknown, exec?: ExecLike): SeatLoginDeps {
  return {
    ...(exec !== undefined ? { exec } : {}),
    ...(typeof dbPath === 'string' && dbPath !== '' && dbPath !== ':memory:'
      ? { gatewayDir: join(stateHomeOfDb(dbPath), 'gateway') } : {}),
  };
}

const DETAIL_MAX = 240;

/** A seat-login diagnostic as it may cross the wire: its first line, the operator's home spelled
 *  `~`, bounded (agy crew-r1). The engine never prints a credential in one. */
export function loginDetail(text: string): string {
  const line = homeless(text.split('\n', 1)[0]?.trim() ?? '');
  return line.length <= DETAIL_MAX ? line : `${line.slice(0, DETAIL_MAX - 1)}…`;
}

export async function runSeatLogin(
  verb: SeatLoginVerb,
  cli: string,
  deps: SeatLoginDeps = {},
): Promise<{ rc: number; stdout: string; stderr: string }> {
  if (!isContainerLoginCli(cli)) return { rc: 2, stdout: '', stderr: `unknown seat: ${cli}` };
  const exe = process.env['WICKED_CORE_EXE'];
  if (!exe) return { rc: 1, stdout: '', stderr: 'WICKED_CORE_EXE is not set' };
  try {
    const out = await (deps.exec ?? execCapped)(exe, ['seat-login', verb, cli], {
      // `argv` builds the seat image on first use (minutes); the others are quick.
      timeout: verb === 'argv' ? ARGV_TIMEOUT_MS : verb === 'ingest' ? 30_000 : 20_000,
      env: { ...process.env, WICKED_SEAT_GATEWAY_DIR: gatewayDirOf(deps.gatewayDir ?? join(crewStateHome(), 'gateway')) },
    });
    return { rc: 0, ...out };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      rc: typeof e.code === 'number' && e.code !== 0 ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' && e.stderr !== '' ? e.stderr : e.message ?? 'seat-login failed',
    };
  }
}

export interface BrokerStatus {
  signed_in: boolean | null;
  /** `refresh_failing`: still signed in, but the broker's last refresh failed (DES §6). */
  state: 'signed_in' | 'signed_out' | 'expired' | 'refresh_failing' | 'unknown';
  expires_at?: number;
  reason?: string;
}

export function parseBrokerStatus(stdout: string): BrokerStatus {
  try {
    const value = JSON.parse(stdout) as { status?: unknown; detail?: unknown } | null;
    if (value?.status === 'signed_in') {
      const detail = value.detail as { expires_at?: unknown } | null;
      if (detail !== null && typeof detail === 'object' &&
          (detail.expires_at === null || (typeof detail.expires_at === 'number' && Number.isFinite(detail.expires_at)))) {
        return {
          signed_in: true,
          state: 'signed_in',
          ...(typeof detail.expires_at === 'number' ? { expires_at: detail.expires_at } : {}),
        };
      }
    }
    if (value?.status === 'refresh_failing') {
      const detail = value.detail as { expires_at?: unknown; reason?: unknown } | null;
      return {
        signed_in: true,
        state: 'refresh_failing',
        ...(typeof detail?.expires_at === 'number' && Number.isFinite(detail.expires_at) ? { expires_at: detail.expires_at } : {}),
        reason: typeof detail?.reason === 'string' ? loginDetail(detail.reason) : 'the last refresh failed',
      };
    }
    if (value?.status === 'signed_out' || value?.status === 'expired') return { signed_in: false, state: value.status };
    if (value?.status === 'unknown') {
      return { signed_in: null, state: 'unknown', ...(typeof value.detail === 'string' ? { reason: loginDetail(value.detail) } : {}) };
    }
  } catch {
    // Malformed output cannot establish whether a credential exists.
  }
  return { signed_in: null, state: 'unknown', reason: 'invalid broker status' };
}

export type BrokerReading = BrokerStatus & { probedAt: string };

/** Broker credentials belong to the gateway; roster reads must never inspect worker homes. */
export class SeatContainerStatus {
  private readonly cache = new Map<string, BrokerReading & { atMs: number }>();
  private readonly inflight = new Map<string, Promise<BrokerReading>>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: SeatLoginDeps = {}, private readonly now: () => number = Date.now) {}

  read(cli: string): BrokerReading | undefined {
    if (!isContainerLoginCli(cli)) return undefined;
    const hit = this.cache.get(cli);
    const ttl = hit?.signed_in === true ? 5 * 60_000 : 30_000;
    if (hit === undefined || this.now() - hit.atMs >= ttl) void this.refresh(cli);
    return hit;
  }

  invalidate(cli: string): void {
    this.cache.delete(cli);
    this.generations.set(cli, (this.generations.get(cli) ?? 0) + 1);
  }

  async refreshFresh(cli: string): Promise<BrokerReading> {
    const running = this.inflight.get(cli);
    if (running !== undefined) await running;
    return this.refresh(cli);
  }

  refresh(cli: string): Promise<BrokerReading> {
    const running = this.inflight.get(cli);
    if (running !== undefined) return running;
    const generation = this.generations.get(cli) ?? 0;
    // Defer the spawn until after the synchronous roster request path has returned.
    const job = Promise.resolve().then(async () => {
      const out = await runSeatLogin('status', cli, this.deps);
      const status = parseBrokerStatus(out.stdout);
      const reading = {
        ...(out.rc !== 0 && (status.state !== 'unknown' || status.reason === 'invalid broker status')
          ? { signed_in: null, state: 'unknown', reason: loginDetail(out.stderr) || 'status failed' } as BrokerStatus
          : status),
        probedAt: new Date(this.now()).toISOString(),
      };
      if ((this.generations.get(cli) ?? 0) === generation) this.cache.set(cli, { ...reading, atMs: this.now() });
      return reading;
    }).finally(() => {
      this.inflight.delete(cli);
      // A status started before ingest/sign-out cannot repopulate the invalidated cache.
      if ((this.generations.get(cli) ?? 0) !== generation) void this.refresh(cli);
    });
    this.inflight.set(cli, job);
    return job;
  }
}
