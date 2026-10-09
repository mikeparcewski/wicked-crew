// crew#615: `POST /seats/:cli/login` and `/logout` run the ENGINE's own `login_invocation` /
// `logout_invocation` for the seat (wicked-core#807 ships the logout field) in a governed PTY and
// answer the terminal id. The daemon never composes a command: a seat with no invocation is a 404.
// The seat's credential probe is re-run when that terminal exits.

import Fastify from 'fastify';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import type { RosterWithStanding } from '../src/api/roster-standing.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const ROSTER = [
  { key: 'codex', display_name: 'Codex', login_invocation: 'CODEX_HOME="/w/codex" codex login', logout_invocation: 'CODEX_HOME="/w/codex" codex logout' },
  { key: 'pi', display_name: 'Pi', login_invocation: 'pi' },
] as unknown as RosterSeat[];

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

function build(opts: { openFails?: boolean } = {}) {
  const listeners = new Set<(e: CoreEvent) => void>();
  const openTerminal = vi.fn(async () => {
    if (opts.openFails === true) throw new Error('spawn failed');
    return 'term-1';
  });
  const adapter = {
    openTerminal,
    onEvent: (l: (e: CoreEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as CoreAdapter;
  const reprobe = vi.fn();
  const roster = Object.assign(() => ROSTER, { reprobe }) as RosterWithStanding;
  const app = Fastify();
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
    seatHealth: new SeatHealthTracker(),
    signedIn: () => null,
    rosterWithStanding: roster,
  });
  apps.push(app);
  const emit = (e: CoreEvent) => {
    for (const l of [...listeners]) l(e);
  };
  return { app, openTerminal, reprobe, emit, listeners };
}

describe('POST /seats/:cli/login|logout (crew#615)', () => {
  it('logout runs the engine\'s logout_invocation verbatim in a governed PTY and answers the terminal id', async () => {
    const { app, openTerminal } = build();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/seats/codex/logout', payload: { cols: 80, rows: 24 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ terminalId: 'term-1', cli: 'codex', action: 'logout' });
    expect(openTerminal).toHaveBeenCalledWith(homedir(), ['sh', '-lc', 'CODEX_HOME="/w/codex" codex logout'], 80, 24, true);
  });

  it('login runs the login_invocation; the size defaults to 100 x 30 with no body', async () => {
    const { app, openTerminal } = build();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/seats/codex/login' });
    expect(res.statusCode).toBe(201);
    expect(openTerminal).toHaveBeenCalledWith(homedir(), ['sh', '-lc', 'CODEX_HOME="/w/codex" codex login'], 100, 30, true);
  });

  it('404s a seat whose CLI documents no logout, and an unknown seat — never a made-up command', async () => {
    const { app, openTerminal } = build();
    await app.ready();
    const none = await app.inject({ method: 'POST', url: '/api/v1/seats/pi/logout', payload: {} });
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toMatch(/no logout command/);
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/seats/nope/login', payload: {} });
    expect(unknown.statusCode).toBe(404);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('400s an unknown body key or a bad size', async () => {
    const { app } = build();
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/v1/seats/codex/logout', payload: { cmd: ['rm'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/seats/codex/logout', payload: { cols: 0 } })).statusCode).toBe(400);
  });

  it('re-probes the seat when ITS terminal exits (not another terminal), once', async () => {
    const { app, reprobe, emit, listeners } = build();
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/v1/seats/codex/logout', payload: {} });
    expect(reprobe).not.toHaveBeenCalled();
    emit({ type: 'terminalExited', id: 'other' } as CoreEvent);
    expect(reprobe).not.toHaveBeenCalled();
    emit({ type: 'terminalExited', id: 'term-1' } as CoreEvent);
    expect(reprobe).toHaveBeenCalledWith('codex');
    expect(listeners.size).toBe(0);
  });

  it('a spawn failure is a 400 naming it', async () => {
    const { app } = build({ openFails: true });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/api/v1/seats/codex/logout', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('spawn failed');
  });
});
