import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSeatContainerLoginRoutes, SeatContainerStatus, SIGNIN_MAX_AGE_MS, type ExecLike } from '../src/api/seat-container-login.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import type { RosterWithStanding } from '../src/api/roster-standing.js';
import type { CoreEvent } from '../src/core/types.js';
import { SeatSessionSchema } from '../src/api/routes.js';

const URL = '/api/v1/seats/codex/container-login';
const NAME = 'wicked-agw-fixture-login-codex-deadbeef';
const ARGV = ['/fixture/runtime', 'run', '--rm', '--name', NAME, 'image'];
let home: string;
const apps: FastifyInstance[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-signin-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('WICKED_SEAT_FLOOR', 'container');
  vi.stubEnv('WICKED_CORE_EXE', '/fixture/core');
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
});
function build() {
  const events = new Set<(event: CoreEvent) => void>();
  const emit = (id: string) => { for (const listener of [...events]) listener({ type: 'terminalExited', id } as CoreEvent); };
  let id = 0;
  const openTerminal = vi.fn(async () => `term-${++id}`);
  const closeTerminal = vi.fn(async (terminalId: string) => { emit(terminalId); return 'ok'; });
  const exec = vi.fn<ExecLike>(async (_file, args) => ({ stdout: args[1] === 'argv' ? JSON.stringify(ARGV) : JSON.stringify({ files: [], expires_at: null }), stderr: '' }));
  const app = Fastify(); apps.push(app);
  const rosterWithStanding = Object.assign(() => [{ key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true }], { reprobe: vi.fn() }) as RosterWithStanding;
  registerSeatContainerLoginRoutes(app, {
    adapter: { openTerminal, closeTerminal, onEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; } },
    rosterWithStanding, seatHealth: new SeatHealthTracker(), containerStatus: new SeatContainerStatus({ exec, gatewayDir: join(home, 'gateway') }),
    seatLoginDeps: { exec, gatewayDir: join(home, 'gateway') }, parseSession: (body) => SeatSessionSchema.safeParse(body),
  });
  return { app, exec, openTerminal, closeTerminal, emit, events };
}

describe('sign-in refusal and abandonment routes', () => {
  it.each([
    ['container_runtime_down: raw runtime diagnostic', 'container_runtime_down'],
    ["codex is not installed on this host: its sign-in runs this host's own codex. Install it, then sign in again", 'cli_not_installed'],
    ['cannot open /Users/fixture/auth\nraw extra line', 'signin_failed'],
  ])('answers 502 with %s classified as %s', async (stderr, code) => {
    const { app, exec } = build();
    exec.mockRejectedValueOnce({ code: 1, stderr });
    const res = await app.inject({ method: 'POST', url: URL });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code, error: expect.any(String) });
    if (code === 'cli_not_installed') expect(res.json().cli).toBe('codex');
    expect(res.json().error).not.toContain('/Users/');
  });
  it('reports the open terminal for reattachment and releases on exact-name DELETE without a late ingest', async () => {
    const { app, exec, closeTerminal, emit } = build();
    await app.inject({ method: 'POST', url: URL });
    const conflict = await app.inject({ method: 'POST', url: URL });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: 'signin_already_open', error: 'A Codex sign-in is already open. Finish it, or close it and start again.', terminalId: 'term-1' });
    expect((await app.inject({ method: 'DELETE', url: URL })).json()).toEqual({ closed: true });
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
    expect(exec).toHaveBeenCalledWith('/fixture/runtime', ['rm', '-f', NAME], expect.objectContaining({ timeout: 3_000 }));
    emit('term-1');
    expect(exec.mock.calls.some(([, args]) => args[1] === 'ingest')).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: URL })).json()).toEqual({ closed: false });
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(201);
  });
  it('allows a POST after terminal exit while its ingest is still pending, and removes its exact container', async () => {
    const { app, exec, emit, closeTerminal } = build();
    let finish!: () => void;
    exec.mockImplementation(async (_file, args) => {
      if (args[1] === 'ingest') await new Promise<void>((resolve) => { finish = resolve; });
      return { stdout: args[1] === 'argv' ? JSON.stringify(ARGV) : JSON.stringify({ files: [], expires_at: null }), stderr: '' };
    });
    await app.inject({ method: 'POST', url: URL });
    emit('term-1');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const next = app.inject({ method: 'POST', url: URL });
    // Dispatch the request before allowing ingest to release the old reservation naturally.
    const early = await Promise.race([next.then((res) => res.statusCode), new Promise<null>((resolve) => setTimeout(() => resolve(null), 20))]);
    finish();
    expect(early).toBeNull();
    expect((await next).statusCode).toBe(201);
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
    expect(exec.mock.calls).toContainEqual(['/fixture/runtime', ['rm', '-f', NAME], expect.objectContaining({ timeout: 3_000 })]);
  });
  it('expires a session after fifteen minutes and ignores its later exit', async () => {
    const { app, exec, emit, closeTerminal } = build();
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await app.inject({ method: 'POST', url: URL });
    clock.mockReturnValue(now + SIGNIN_MAX_AGE_MS);
    expect((await app.inject({ method: 'POST', url: URL })).statusCode).toBe(201);
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
    emit('term-1');
    expect(exec.mock.calls.some(([, args]) => args[1] === 'ingest')).toBe(false);
  });
  it('closes the terminal if DELETE supersedes a terminal spawn still in flight', async () => {
    const { app, openTerminal, closeTerminal, exec } = build();
    let resolve!: (id: string) => void;
    openTerminal.mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
    const opening = app.inject({ method: 'POST', url: URL });
    await vi.waitFor(() => expect(openTerminal).toHaveBeenCalledTimes(1));
    expect((await app.inject({ method: 'DELETE', url: URL })).json()).toEqual({ closed: true });
    resolve('late-terminal');
    const result = await opening;
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe('signin_superseded');
    expect(closeTerminal).toHaveBeenCalledWith('late-terminal');
    expect(exec.mock.calls.some(([, args]) => args[1] === 'ingest')).toBe(false);
  });
  it('cleans up open sign-ins when the daemon closes', async () => {
    const { app, closeTerminal, exec } = build();
    await app.inject({ method: 'POST', url: URL });
    await app.close();
    expect(closeTerminal).toHaveBeenCalledWith('term-1');
    expect(exec.mock.calls.some(([, args]) => args[0] === 'rm' && args[2] === NAME)).toBe(true);
    expect(exec.mock.calls.some(([, args]) => args[1] === 'ingest')).toBe(false);
  });
  it('codes parser and terminal-spawn failures and scrubs the spawn diagnostic', async () => {
    const { app, openTerminal } = build();
    const malformed = await app.inject({ method: 'POST', url: URL, headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('signin_failed');
    openTerminal.mockRejectedValueOnce(new Error('cannot spawn /Users/fixture/cli'));
    const spawn = await app.inject({ method: 'POST', url: URL });
    expect(spawn.statusCode).toBe(400);
    expect(spawn.json()).toEqual({ code: 'signin_failed', error: 'cannot spawn ~/cli' });
  });
  it('gives coded validation and unknown-seat failures, without opening a terminal', async () => {
    const { app, openTerminal } = build();
    const invalid = await app.inject({ method: 'POST', url: URL, payload: { cols: 0 } });
    expect(invalid.statusCode).toBe(400); expect(invalid.json().code).toBe('signin_failed');
    const absent = await app.inject({ method: 'POST', url: URL.replace('codex', 'missing') });
    expect(absent.statusCode).toBe(404); expect(absent.json().code).toBe('signin_failed');
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
