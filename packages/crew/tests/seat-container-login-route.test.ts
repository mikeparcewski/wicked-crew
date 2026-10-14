import Fastify, { type FastifyInstance } from 'fastify';
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import type { RosterWithStanding } from '../src/api/roster-standing.js';
import { registerRoutes } from '../src/api/routes.js';
import { SeatContainerStatus, type ExecLike } from '../src/api/seat-container-login.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';

const ARGV = ['/fixture/docker', 'run', '-it', '--rm', 'login-image', 'codex', 'login'];
const ROSTER = [{ key: 'codex', display_name: 'Codex' }, { key: 'agy', display_name: 'Antigravity' }] as RosterSeat[];
const apps: FastifyInstance[] = [];

beforeEach(() => {
  vi.stubEnv('WICKED_SEAT_FLOOR', 'container');
  vi.stubEnv('WICKED_CORE_EXE', '/fixture/wicked-core');
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});

function build() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const emit = (id: string) => {
    for (const listener of [...listeners]) listener({ type: 'terminalExited', id } as CoreEvent);
  };
  const openTerminal = vi.fn(async () => 'term-1');
  const exec = vi.fn<ExecLike>(async (_file, args) => ({
    stdout: args[1] === 'argv' ? JSON.stringify(ARGV) : JSON.stringify({ cli: 'codex', files: ['auth.json'], expires_at: 12345 }),
    stderr: '',
  }));
  const containerStatus = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
  const invalidate = vi.spyOn(containerStatus, 'invalidate');
  const reprobe = vi.fn();
  const roster = Object.assign(() => ROSTER, { reprobe, containerStatus }) as RosterWithStanding;
  const adapter = {
    dbPath: '/fixture/state/core.db',
    openTerminal,
    onEvent: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreAdapter;
  const app = Fastify();
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
    seatHealth: new SeatHealthTracker(), signedIn: () => null, rosterWithStanding: roster, seatLoginExec: exec,
  });
  apps.push(app);
  return { app, openTerminal, exec, emit, listeners, reprobe, invalidate };
}

const URL = '/api/v1/seats/codex/container-login';

describe('container seat login routes', () => {
  it('returns 404 for every container endpoint when the mode is off, without spawning', async () => {
    vi.stubEnv('WICKED_SEAT_FLOOR', 'host');
    const { app, exec, openTerminal } = build();
    for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url: URL })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/seats/codex/container-logout' })).statusCode).toBe(404);
    expect(exec).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
  });

  // codex train r4: crew reads WICKED_SEAT_FLOOR as the engine does (trimmed, case-insensitive).
  it('serves the container endpoints for a spelling the engine accepts', async () => {
    vi.stubEnv('WICKED_SEAT_FLOOR', ' Container ');
    const { app, openTerminal } = build();
    const res = await app.inject({ method: 'POST', url: URL, payload: { cols: 80, rows: 24 } });
    expect(res.statusCode).toBe(201);
    expect(openTerminal).toHaveBeenCalledWith(homedir(), ARGV, 80, 24, true);
  });

  it('opens the engine argv exactly and ingests once only when its terminal exits', async () => {
    const { app, exec, openTerminal, emit, listeners, reprobe, invalidate } = build();
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: URL, payload: { cols: 80, rows: 24 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ terminalId: 'term-1', cli: 'codex', action: 'sign_in' });
    expect(openTerminal).toHaveBeenCalledWith(homedir(), ARGV, 80, 24, true);
    expect(exec).toHaveBeenCalledWith('/fixture/wicked-core', ['seat-login', 'argv', 'codex'], expect.objectContaining({
      timeout: 15 * 60_000, env: expect.objectContaining({ WICKED_SEAT_GATEWAY_DIR: '/fixture/state/gateway' }),
    }));
    emit('other');
    expect(exec).toHaveBeenCalledTimes(1);
    emit('term-1');
    emit('term-1');
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledWith('codex'));
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenLastCalledWith('/fixture/wicked-core', ['seat-login', 'ingest', 'codex'], expect.objectContaining({ timeout: 30_000 }));
    expect(invalidate).toHaveBeenCalledWith('codex');
    expect(listeners.size).toBe(0);
    const outcome = await app.inject({ method: 'GET', url: URL });
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json()).toEqual({ cli: 'codex', ok: true, files: ['auth.json'], expires_at: 12345, at: expect.any(String) });
  });

  // agy crew-r1 / codex crew-r1: one open sign-in per seat; a sign-out supersedes an open one.
  it('refuses a second open sign-in and ignores the exit of one a sign-out superseded', async () => {
    const { app, exec, openTerminal, emit, reprobe } = build();
    openTerminal.mockResolvedValueOnce('term-a').mockResolvedValueOnce('term-c');
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(409);
    emit('term-a');
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(1));
    const ingests = () => exec.mock.calls.filter(([, args]) => args[1] === 'ingest').length;
    expect(ingests()).toBe(1);
    // The reservation is held until the ingest settles (codex crew-r2), then released.
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200));
    await new Promise((r) => setTimeout(r, 10));
    // A sign-out while a login terminal is still open: its later exit ingests nothing.
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/seats/codex/container-logout' })).statusCode).toBe(200);
    emit('term-c');
    await new Promise((r) => setTimeout(r, 20));
    expect(ingests()).toBe(1);
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);
  });

  // codex crew-r2: the seat is reserved from the request's first await, terminal creation included.
  it('refuses a second sign-in while the first is still opening its terminal', async () => {
    const { app, openTerminal, exec } = build();
    let open!: (id: string) => void;
    openTerminal.mockImplementationOnce(() => new Promise<string>((r) => { open = r; }));
    const first = app.inject({ method: 'POST', url: URL });
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledTimes(1));
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(409);
    expect(exec.mock.calls.filter(([, args]) => args[1] === 'argv').length).toBe(1);
    open('term-1');
    expect((await first).statusCode).toBe(201);
  });

  it('a sign-out that lands while a sign-in prepares its login wins', async () => {
    const { app, exec, openTerminal } = build();
    let releaseArgv!: () => void;
    exec.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseArgv = r; });
      return { stdout: JSON.stringify(ARGV), stderr: '' };
    });
    const login = app.inject({ method: 'POST', url: URL });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    const logout = app.inject({ method: 'POST', url: '/api/v1/seats/codex/container-logout' });
    // Let the sign-out reach its handler (it bumps the seat's generation at once) first.
    await new Promise((r) => setTimeout(r, 50));
    releaseArgv();
    expect((await login).statusCode).toBe(409);
    expect((await logout).statusCode).toBe(200);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('runs a sign-out after an ingest already in flight, never under it', async () => {
    const { app, exec, emit } = build();
    let release!: () => void;
    const order: string[] = [];
    exec.mockImplementation(async (_file, args) => {
      order.push(`${args[1]}:start`);
      if (args[1] === 'ingest') await new Promise<void>((r) => { release = r; });
      order.push(`${args[1]}:end`);
      return { stdout: args[1] === 'argv' ? JSON.stringify(ARGV) : JSON.stringify({ cli: 'codex', files: [], expires_at: null }), stderr: '' };
    });
    await app.inject({ method: 'POST', url: URL });
    emit('term-1');
    await vi.waitFor(() => expect(order).toContain('ingest:start'));
    const logout = app.inject({ method: 'POST', url: '/api/v1/seats/codex/container-logout' });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).not.toContain('sign-out:start');
    release();
    expect((await logout).statusCode).toBe(200);
    expect(order.indexOf('ingest:end')).toBeLessThan(order.indexOf('sign-out:start'));
    // The superseded ingest records no outcome (codex crew-r1).
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);
  });

  it('captures exits before openTerminal resolves, using the default size', async () => {
    const { app, openTerminal, emit, exec, reprobe, listeners } = build();
    openTerminal.mockImplementationOnce(async () => { emit('term-1'); return 'term-1'; });
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(201);
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(1));
    expect(openTerminal).toHaveBeenCalledWith(homedir(), ARGV, 100, 30, true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it('records a failed ingest with the stderr reason and still invalidates/reprobes', async () => {
    const { app, exec, emit, reprobe, invalidate } = build();
    exec.mockResolvedValueOnce({ stdout: JSON.stringify(ARGV), stderr: '' });
    exec.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 1, stdout: 'private output', stderr: 'nothing signed in\nextra detail' }));
    await app.inject({ method: 'POST', url: URL });
    emit('term-1');
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith('codex');
    expect((await app.inject({ method: 'GET', url: URL })).json()).toEqual({
      cli: 'codex', ok: false, error: 'nothing signed in', at: expect.any(String),
    });
  });

  it.each(['{}', '["codex", 1]', '[]', '[""]', 'garbage'])('rejects malformed argv %s without opening a terminal', async (stdout) => {
    const { app, exec, openTerminal, listeners } = build();
    exec.mockResolvedValueOnce({ stdout, stderr: '' });
    const res = await app.inject({ method: 'POST', url: URL });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual(expect.any(String));
    expect(openTerminal).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('returns 404 for unknown or unsupported seats without spawning', async () => {
    const { app, exec, openTerminal } = build();
    for (const cli of ['nope', 'agy']) {
      for (const action of ['container-login', 'container-logout']) {
        expect((await app.inject({ method: 'POST', url: `/api/v1/seats/${cli}/${action}` })).statusCode).toBe(404);
      }
      expect((await app.inject({ method: 'GET', url: `/api/v1/seats/${cli}/container-login` })).statusCode).toBe(404);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('rejects invalid size/body before spawning', async () => {
    const { app, exec } = build();
    for (const payload of [{ cols: 0 }, { cmd: ['anything'] }]) {
      expect((await app.inject({ method: 'POST', url: URL, payload })).statusCode).toBe(400);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports argv failures and releases the listener on terminal spawn failure', async () => {
    const { app, exec, openTerminal, listeners } = build();
    exec.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 1, stderr: 'argv unavailable\ndetail' }));
    expect((await app.inject({ method: 'POST', url: URL })).json()).toEqual({ error: 'argv unavailable' });
    expect(openTerminal).not.toHaveBeenCalled();
    openTerminal.mockRejectedValueOnce(new Error('spawn failed'));
    const res = await app.inject({ method: 'POST', url: URL });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'spawn failed' });
    expect(listeners.size).toBe(0);
  });

  it('copies only public fields from ingest and records malformed ingest as failure', async () => {
    const { app, exec, emit, reprobe } = build();
    exec.mockResolvedValueOnce({ stdout: JSON.stringify(ARGV), stderr: '' });
    exec.mockResolvedValueOnce({ stdout: JSON.stringify({ files: ['auth.json'], expires_at: null, credential: 'fixture-secret' }), stderr: '' });
    await app.inject({ method: 'POST', url: URL });
    emit('term-1');
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(1));
    const outcome = (await app.inject({ method: 'GET', url: URL })).json();
    expect(outcome).toEqual({ cli: 'codex', ok: true, files: ['auth.json'], expires_at: null, at: expect.any(String) });
    exec.mockResolvedValueOnce({ stdout: JSON.stringify(ARGV), stderr: '' });
    exec.mockResolvedValueOnce({ stdout: 'invalid fixture credential', stderr: '' });
    await app.inject({ method: 'POST', url: URL });
    emit('term-1');
    await vi.waitFor(() => expect(reprobe).toHaveBeenCalledTimes(2));
    expect((await app.inject({ method: 'GET', url: URL })).json()).toEqual({
      cli: 'codex', ok: false, error: 'invalid seat-login ingest response', at: expect.any(String),
    });
  });

  it('signs out, invalidates the cache and reprobes; failures return the first stderr line', async () => {
    const { app, exec, reprobe, invalidate } = build();
    const url = '/api/v1/seats/codex/container-logout';
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cli: 'codex', action: 'sign_out' });
    expect(exec).toHaveBeenCalledWith('/fixture/wicked-core', ['seat-login', 'sign-out', 'codex'], expect.objectContaining({ timeout: 20_000 }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenCalledWith('codex');
    exec.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 1, stderr: 'broker unavailable\nmore detail' }));
    const failed = await app.inject({ method: 'POST', url });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'broker unavailable' });
    // A failed sign-out may still have changed the broker: the next reading is its own (codex crew-r1).
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(reprobe).toHaveBeenCalledTimes(2);
  });
});
