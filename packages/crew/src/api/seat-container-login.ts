import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SeatSignInFailure, SeatSignInFailureCode } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../core/adapter.js';
import type { SeatContainerLoginOutcome } from '../core/types.js';
import type { RosterWithStanding } from './roster-standing.js';
import type { SeatHealthTracker } from './seat-health.js';
import { execCapped } from '../core/exec.js';
import { canonicalize } from '../projects/state-home-preflight.js';
import { crewStateHome, stateHomeOfDb } from '../projects/state-home.js';
import { gatewayName, resolveContainerRuntime } from './system-snapshot.js';
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

/** Whether the interim HOST floor is chosen — the engine's own rule (`host_floor_chosen`,
 *  wicked-core#976): `WICKED_SEAT_FLOOR` set to anything but `container`, a typo included. Unset is
 *  neither floor (a daemon always sets one, {@link defaultSeatFloor}). */
export function isHostSeatFloor(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['WICKED_SEAT_FLOOR'] ?? '').trim();
  return v !== '' && v.toLowerCase() !== 'container';
}

/** The default seat floor of a crew daemon (C5): governed seats run in containers. Sets
 *  `WICKED_SEAT_FLOOR=container` in `env` unless the operator chose a floor — the engine (in this
 *  process) and crew's sign-in routes and roster then read the same value. `WICKED_SEAT_FLOOR=host`
 *  keeps the interim host floor (macOS Seatbelt / Linux bwrap), labelled as such. Returns the floor. */
export function defaultSeatFloor(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = (env['WICKED_SEAT_FLOOR'] ?? '').trim();
  if (chosen !== '') return chosen;
  env['WICKED_SEAT_FLOOR'] = 'container';
  return 'container';
}

export function isContainerLoginCli(cli: string): boolean {
  return ['claude', 'codex', 'pi', 'opencode', 'copilot'].includes(cli);
}

/** Where a container seat's one-time sign-in runs (the engine's `seat_login::host_login`): codex, pi and
 *  opencode run THIS host's own CLI (their browser logins call back on a host loopback port), so they need
 *  it installed here; claude and copilot sign in inside a login container and need nothing on the host. */
export function containerSignInOn(cli: string): 'host' | 'container' {
  return ['codex', 'pi', 'opencode'].includes(cli) ? 'host' : 'container';
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
  const line = homeless(text.split(/[\r\n]/, 1)[0]?.trim() ?? '')
    .replace(/\/(?:Users|home)\/[^/\\\s"'),;:]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\/\s"'),;:]+/g, '~');
  return line.length <= DETAIL_MAX ? line : `${line.slice(0, DETAIL_MAX - 1)}…`;
}

/** Stable refusal codes keep runtime repair, missing host CLIs and reattachment distinct. */
export function signInFailure(stderr: string, cli: string): { code: SeatSignInFailureCode; error: string } {
  const label = ({ claude: 'Claude', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode', copilot: 'Copilot', agy: 'Antigravity' } as Record<string, string>)[cli] ?? loginDetail(cli);
  if (stderr.includes('container_runtime_down')) return {
    code: 'container_runtime_down',
    error: "Docker isn't running, so the sign-in container can't start. Start Docker Desktop or Rancher Desktop, then try again.",
  };
  if (/is not installed on this host/i.test(stderr)) {
    const command = stderr.match(/\b(?:npm (?:install|i) (?:-g |--global )?[@a-z0-9_./-]+|brew install [a-z0-9_./-]+|uv tool install [a-z0-9_./-]+)/i)?.[0];
    return { code: 'cli_not_installed', error: `${label} isn't installed on this computer. Its sign-in runs your own ${cli}: install it (${command === undefined ? 'see its install guide' : loginDetail(command)}), then try again.` };
  }
  if (/sign-in is already open/i.test(stderr)) return { code: 'signin_already_open', error: `A ${label} sign-in is already open. Finish it, or close it and start again.` };
  if (/sign-in.*superseded/i.test(stderr)) return { code: 'signin_superseded', error: `The ${label} sign-in was superseded. Start again.` };
  return { code: 'signin_failed', error: loginDetail(stderr) || 'Sign-in failed. Try again.' };
}

/** Fifteen minutes allows browser/device approval but bounds an abandoned dialog's reservation. */
export const SIGNIN_MAX_AGE_MS = 15 * 60_000;
export type LoginContainer = { runtime: string; name: string };

/** Only the engine's explicit run --name is a removal target; host sign-ins have none. */
export function loginContainerFromArgv(argv: string[]): LoginContainer | null {
  if (argv[1] !== 'run' || !argv[0]) return null;
  const index = argv.indexOf('--name');
  const name = index < 0 ? argv.find((arg) => arg.startsWith('--name='))?.slice(7) : argv[index + 1];
  return name && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ? { runtime: argv[0], name } : null;
}

export async function removeLoginContainer(container: LoginContainer | null, deps: SeatLoginDeps = {}): Promise<void> {
  if (container === null) return;
  await (deps.exec ?? execCapped)(container.runtime, ['rm', '-f', container.name], { timeout: 3_000, env: process.env });
}

/** A restart owns only this gateway's exact session names, never a name-prefix deletion. */
export interface LoginContainerSweepDeps {
  gatewayDir: string;
  exec?: ExecLike;
  runtime?: () => string | null;
  log: (line: string) => void;
}

export async function sweepLoginContainers(input: LoginContainerSweepDeps): Promise<void> {
  try {
    const runtime = (input.runtime ?? resolveContainerRuntime)();
    if (runtime === null) { input.log('Sign-in cleanup skipped: container runtime unavailable.'); return; }
    const prefix = `${gatewayName(gatewayDirOf(input.gatewayDir))}-login-`;
    const pattern = new RegExp(`^${prefix}(claude|codex|pi|opencode|copilot|agy)-[0-9a-f]{8}$`);
    const exec = input.exec ?? execCapped;
    const out = await exec(runtime, ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'], { timeout: 3_000, env: process.env });
    const names = [...new Set(out.stdout.split(/\r?\n/).filter((name) => pattern.test(name)))];
    // One bounded removal also bounds shutdown when many abandoned sessions exist.
    if (names.length > 0) await exec(runtime, ['rm', '-f', ...names], { timeout: 3_000, env: process.env });
  } catch {
    input.log('Sign-in cleanup skipped: container runtime unavailable.');
  }
}

export function registerLoginCleanup(app: FastifyInstance, deps: SeatLoginDeps): void {
  const sweep = async (): Promise<void> => {
    if (!isContainerSeatFloor() || deps.gatewayDir === undefined) return;
    await sweepLoginContainers({ ...deps, gatewayDir: deps.gatewayDir, log: (line) => app.log.info(line) });
  };
  app.addHook('onReady', sweep);
  app.addHook('onClose', sweep);
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

export interface SeatContainerLoginRouteDeps {
  adapter: Pick<CoreAdapter, 'openTerminal' | 'closeTerminal' | 'onEvent'>;
  rosterWithStanding: RosterWithStanding;
  containerStatus: SeatContainerStatus;
  seatHealth: SeatHealthTracker;
  seatLoginDeps: SeatLoginDeps;
  parseSession: (body: unknown) => { success: true; data: { cols?: number | undefined; rows?: number | undefined } } | { success: false };
}

/** Sign-in reservations belong to the daemon, not a browser socket: explicit close and expiry
 *  invalidate their generation before any terminal exit can ingest into a newer session. */
export function registerSeatContainerLoginRoutes(app: FastifyInstance, input: SeatContainerLoginRouteDeps): void {
  const { adapter, rosterWithStanding, containerStatus, seatHealth, seatLoginDeps, parseSession } = input;
  const V = '/api/v1';
  const message = (err: unknown): string => err instanceof Error ? err.message : String(err);
  const failureBody = (stderr: string, cli: string): SeatSignInFailure => {
    const failure = signInFailure(stderr, cli);
    return { ...failure, ...(failure.code === 'cli_not_installed' ? { cli } : {}) };
  };
  const containerLoginOutcomes = new Map<string, SeatContainerLoginOutcome>();
  const containerSeat = (cli: string): boolean =>
    isContainerSeatFloor() && isContainerLoginCli(cli) && rosterWithStanding().some((seat) => seat.key === cli);
  const loginError = (stderr: string): string => loginDetail(stderr) || 'seat-login failed';
  // One sign-in/sign-out at a time per seat, and a generation every new sign-in and every sign-out
  // bumps (agy crew-r1): an abandoned login terminal that exits later never ingests over a newer
  // sign-in or a sign-out, and an ingest in flight finishes before a sign-out runs.
  const loginGeneration = new Map<string, number>();
  const seatOps = new Map<string, Promise<unknown>>();
  const serial = <T>(cli: string, op: () => Promise<T>): Promise<T> => {
    const next = (seatOps.get(cli) ?? Promise.resolve()).then(op, op);
    seatOps.set(cli, next.catch(() => undefined));
    return next;
  };
  const bump = (cli: string): number => {
    const g = (loginGeneration.get(cli) ?? 0) + 1;
    loginGeneration.set(cli, g);
    return g;
  };
  // The one sign-in per seat, reserved synchronously from the request's first await until its
  // ingest settles (codex crew-r1/r2: two sessions would share the engine's login session), and
  // released only by its owner (the generation that reserved it).
  const openLogins = new Map<string, {
    generation: number; openedAt: number; terminalId: string | null; exited: boolean;
    container: LoginContainer | null; stop?: () => void;
  }>();
  const release = (cli: string, generation: number): void => {
    if (openLogins.get(cli)?.generation === generation) openLogins.delete(cli);
  };

  const abandonLogin = (cli: string): Promise<boolean> => {
    const session = openLogins.get(cli);
    if (session === undefined) return Promise.resolve(false);
    // Invalidate before closing: closeTerminal itself emits terminalExited.
    bump(cli);
    openLogins.delete(cli);
    session.stop?.();
    containerLoginOutcomes.delete(cli);
    return serial(cli, async () => {
      if (session.terminalId !== null) {
        try { await adapter.closeTerminal(session.terminalId); } catch { /* already exited */ }
      }
      try { await removeLoginContainer(session.container, seatLoginDeps); }
      catch { app.log.info('Sign-in cleanup skipped: container runtime unavailable.'); }
      return true;
    });
  };
  app.addHook('onClose', async () => {
    rosterWithStanding.close?.();
    await Promise.all([...openLogins.keys()].map(abandonLogin));
  });

  app.delete(
    `${V}/seats/:cli/container-login`,
    { config: { manifest: { responseType: '{ closed: boolean }', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      if (!containerSeat(cli)) return reply.code(404).send(failureBody(`container login unavailable for seat: ${cli}`, cli));
      return reply.send({ closed: await abandonLogin(cli) });
    },
  );

  app.post(
    `${V}/seats/:cli/container-login`,
    {
      config: { manifest: { requestType: 'SeatSessionBody', responseType: 'SeatContainerLoginResponse', statusCodes: [201, 400, 404, 409, 500, 502] } },
      errorHandler: (error, req, reply) => {
        const { cli } = req.params as { cli: string };
        const status = error.statusCode ?? 500;
        return reply.code(status >= 400 && status <= 599 ? status : 500).send(failureBody(error.message, cli));
      },
    },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      if (!containerSeat(cli)) return reply.code(404).send(failureBody(`container login unavailable for seat: ${cli}`, cli));
      const parsed = parseSession(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(failureBody('Invalid request body', cli));
      for (let open = openLogins.get(cli); open !== undefined; open = openLogins.get(cli)) {
        if (!open.exited && Date.now() - open.openedAt < SIGNIN_MAX_AGE_MS) {
          return reply.code(409).send({ ...signInFailure('sign-in is already open', cli), ...(open.terminalId !== null ? { terminalId: open.terminalId } : {}) });
        }
        await abandonLogin(cli);
      }
      // Reserved BEFORE the first await: a sign-out that lands meanwhile wins.
      const generation = bump(cli);
      const session = { generation, openedAt: Date.now(), terminalId: null as string | null, exited: false, container: null as LoginContainer | null, stop: () => {} };
      openLogins.set(cli, session);
      containerLoginOutcomes.delete(cli);
      const out = await serial(cli, () => runSeatLogin('argv', cli, seatLoginDeps));
      if (out.rc !== 0) {
        release(cli, generation);
        return reply.code(502).send(failureBody(out.stderr, cli));
      }
      let argv: string[];
      try {
        const value: unknown = JSON.parse(out.stdout);
        if (!Array.isArray(value) || value.length === 0 || !value.every((arg: unknown) => typeof arg === 'string' && arg.length > 0)) {
          throw new Error('seat-login argv must be a non-empty array of non-empty strings');
        }
        argv = value as string[];
      } catch (err) {
        release(cli, generation);
        return reply.code(502).send(failureBody(message(err), cli));
      }
      session.container = loginContainerFromArgv(argv);
      if (loginGeneration.get(cli) !== generation) {
        release(cli, generation);
        try { await removeLoginContainer(session.container, seatLoginDeps); } catch { /* runtime down */ }
        return reply.code(409).send(signInFailure('sign-in was superseded', cli));
      }
      let termId: string | null = null;
      let completed = false;
      const exitedEarly = new Set<string>();
      const ingest = (): Promise<void> => serial(cli, async () => {
        // A newer sign-in or a sign-out superseded this terminal: nothing to ingest or record.
        if (loginGeneration.get(cli) !== generation) return;
        // Refusals the OLD credential earned up to now are superseded by this sign-in (codex
        // crew-r2: a 401 during the interactive login must not outlive it).
        const cutoff = Date.now();
        const result = await runSeatLogin('ingest', cli, seatLoginDeps);
        // The broker may have changed whatever happens next: the next reading is its own.
        containerStatus.invalidate(cli);
        rosterWithStanding.reprobe?.(cli);
        const outcome: SeatContainerLoginOutcome = { cli, ok: result.rc === 0, at: new Date().toISOString() };
        if (result.rc !== 0) outcome.error = loginError(result.stderr);
        else {
          try {
            const value = JSON.parse(result.stdout) as { files?: unknown; expires_at?: unknown } | null;
            if (value === null || !Array.isArray(value.files) || !value.files.every((file: unknown) => typeof file === 'string') ||
                !(value.expires_at === null || (typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)))) {
              throw new Error('invalid seat-login ingest response');
            }
            // Only the public ingest fields cross the wire; raw stdout may contain credentials.
            outcome.files = value.files as string[];
            outcome.expires_at = value.expires_at;
          } catch {
            outcome.ok = false;
            outcome.error = 'invalid seat-login ingest response';
          }
        }
        if (outcome.ok) {
          seatHealth.clearAuthFailureBefore(cli, cutoff);
          seatHealth.clearRecentBench(cli);
        }
        // A sign-out (or a newer sign-in) while this ingest ran owns the outcome now.
        if (loginGeneration.get(cli) === generation) containerLoginOutcomes.set(cli, outcome);
      }).finally(async () => {
        try { await removeLoginContainer(session.container, seatLoginDeps); }
        catch { app.log.info('Sign-in cleanup skipped: container runtime unavailable.'); }
        release(cli, generation);
      });
      const done = (): void => {
        if (completed) return;
        completed = true;
        session.exited = true;
        stop();
        void ingest();
      };
      // Subscribe before spawn: an immediate exit still needs exactly one ingest.
      const stop = adapter.onEvent((event) => {
        if (event.type !== 'terminalExited' || typeof event.id !== 'string') return;
        if (termId === null) exitedEarly.add(event.id);
        else if (event.id === termId) done();
      });
      session.stop = stop;
      try {
        termId = await adapter.openTerminal(homedir(), argv, parsed.data.cols ?? 100, parsed.data.rows ?? 30, true);
      } catch (err) {
        stop();
        release(cli, generation);
        try { await removeLoginContainer(session.container, seatLoginDeps); } catch { /* runtime down */ }
        return reply.code(400).send(failureBody(message(err), cli));
      }
      session.terminalId = termId;
      if (loginGeneration.get(cli) !== generation) {
        stop();
        try { await adapter.closeTerminal(termId); } catch { /* already closed */ }
        try { await removeLoginContainer(session.container, seatLoginDeps); } catch { /* runtime down */ }
        release(cli, generation);
        return reply.code(409).send(signInFailure('sign-in was superseded', cli));
      }
      if (exitedEarly.has(termId)) done();
      return reply.code(201).send({ terminalId: termId, cli, action: 'sign_in' });
    },
  );

  app.get(
    `${V}/seats/:cli/container-login`,
    { config: { manifest: { responseType: 'SeatContainerLoginOutcome', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      const outcome = containerSeat(cli) ? containerLoginOutcomes.get(cli) : undefined;
      if (outcome === undefined) return reply.code(404).send({ error: `no container login outcome for seat: ${cli}` });
      return reply.send(outcome);
    },
  );

  app.post(
    `${V}/seats/:cli/container-logout`,
    { config: { manifest: { responseType: 'SeatContainerLogoutResponse', statusCodes: [200, 404, 502] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      if (!containerSeat(cli)) return reply.code(404).send({ error: `container logout unavailable for seat: ${cli}` });
      bump(cli);
      await abandonLogin(cli);
      const out = await serial(cli, async () => {
        containerLoginOutcomes.delete(cli);
        return runSeatLogin('sign-out', cli, seatLoginDeps);
      });
      // Whatever the engine managed before failing, the next reading is the broker's (codex crew-r1).
      containerStatus.invalidate(cli);
      rosterWithStanding.reprobe?.(cli);
      if (out.rc !== 0) return reply.code(502).send({ error: loginError(out.stderr) });
      return reply.send({ cli, action: 'sign_out' });
    },
  );

}
