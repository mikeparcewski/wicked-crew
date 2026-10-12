// DES-seats-page A3b: `GET /roster?refresh=<key>` re-runs that seat's sign-in check and waits for
// it (bounded), so "I've signed in: check again" reads the fresh answer instead of the probe cache's
// 30-second-old signed-out one. Over an injected sign-in probe runner: no CLI is spawned.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { registerRoutes } from '../src/api/routes.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { SeatProbe, type ProbeOutput } from '../src/api/seat-probe.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RosterSeat } from '../src/core/types.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const SIGNED_OUT: ProbeOutput = { code: 1, stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', stderr: '' };
const SIGNED_IN: ProbeOutput = { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: '' };

function build(answer: { status: ProbeOutput; delayMs?: number }) {
  let now = Date.parse('2026-10-12T20:00:00.000Z');
  const probe = new SeatProbe({
    run: async (_cmd, args) => {
      if (answer.delayMs !== undefined) await new Promise((r) => setTimeout(r, answer.delayMs));
      return args[0] === 'auth' ? answer.status : { code: 0, stdout: 'OK', stderr: '' };
    },
    now: () => now,
    env: {},
    home: '/home/fabricated',
  });
  const roster = rosterWithStandingFactory({
    seatHealth: new SeatHealthTracker(),
    registry: () => [
      { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true },
      { key: 'pi', display_name: 'Pi', binary: 'pi', enabled_for_council: true },
    ],
    signedIn: () => false,
    env: { WICKED_WORKER_HOME: '' },
    probe,
    worktreeBench: null,
  });
  const app = Fastify();
  registerRoutes(app, {} as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
    seatHealth: new SeatHealthTracker(),
    signedIn: () => null,
    rosterWithStanding: roster,
  });
  apps.push(app);
  return { app, tick: (ms: number) => (now += ms) };
}

type Body = { roster: RosterSeat[]; refresh?: { key: string; outcome: string } };

describe('GET /roster?refresh=<key> (A3b)', () => {
  it('re-checks NOW, past the 30 s signed-out cache: the operator signed in, the read says so', async () => {
    const answer = { status: SIGNED_OUT };
    const { app, tick } = build(answer);
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/v1/roster' }); // warms the cache: signed out
    await new Promise((r) => setTimeout(r, 10));
    const before = (await app.inject({ method: 'GET', url: '/api/v1/roster' })).json() as Body;
    expect(before.roster.find((s) => s.key === 'claude')!.auth).toBe('signed_out');
    answer.status = SIGNED_IN; // signed in from their own terminal, 5 s later
    tick(5000);
    const plain = (await app.inject({ method: 'GET', url: '/api/v1/roster' })).json() as Body;
    expect(plain.roster.find((s) => s.key === 'claude')!.auth).toBe('signed_out'); // the cache still holds
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster?refresh=claude' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.refresh).toEqual({ key: 'claude', outcome: 'probed' });
    const claude = body.roster.find((s) => s.key === 'claude')!;
    expect(claude.auth).toBe('signed_in');
    expect(claude.login_check).toBe('live');
  });

  it('a seat with no sign-in check answers not_probed with the roster', async () => {
    const { app } = build({ status: SIGNED_OUT });
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/api/v1/roster?refresh=pi' })).json() as Body;
    expect(body.refresh).toEqual({ key: 'pi', outcome: 'not_probed' });
    expect(body.roster).toHaveLength(2);
  });

  it('400s an unknown key, an empty one, or two', async () => {
    const { app } = build({ status: SIGNED_OUT });
    await app.ready();
    for (const q of ['refresh=nope', 'refresh=', 'refresh=claude&refresh=pi']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/roster?${q}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid \?refresh/);
    }
  });

  it('a plain read never waits on a probe', async () => {
    const { app } = build({ status: SIGNED_IN, delayMs: 2000 });
    await app.ready();
    const t = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t).toBeLessThan(1000);
    expect((res.json() as Body).refresh).toBeUndefined();
  });
});

describe('recheck (the bound)', () => {
  it('a worker home changed while the check ran: the new home is checked too before probed', async () => {
    const env: NodeJS.ProcessEnv = { WICKED_WORKER_HOME: '/h/a' };
    const homes: string[] = [];
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [{ key: 'claude', display_name: 'Claude Code', binary: 'claude' }],
      signedIn: () => false,
      env,
      probe: new SeatProbe({
        run: async (_cmd, args, childEnv) => {
          if (args[0] === 'auth') {
            homes.push(String(childEnv['CLAUDE_CONFIG_DIR']));
            if (homes.length === 1) env['WICKED_WORKER_HOME'] = '/h/b'; // switched mid-check
          }
          return args[0] === 'auth' ? SIGNED_IN : { code: 0, stdout: 'OK', stderr: '' };
        },
        env: {},
        home: '/h',
      }),
      worktreeBench: null,
    });
    expect(await roster.recheck!('claude', 2000)).toBe('probed');
    expect(homes).toEqual(['/h/a/claude', '/h/b/claude']);
  });

  it('a check slower than the wait answers timed_out and keeps running', async () => {
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [{ key: 'claude', display_name: 'Claude Code', binary: 'claude' }],
      signedIn: () => false,
      env: { WICKED_WORKER_HOME: '' },
      probe: new SeatProbe({ run: () => new Promise((r) => setTimeout(() => r(SIGNED_IN), 300)), env: {}, home: '/h' }),
      worktreeBench: null,
    });
    expect(await roster.recheck!('claude', 20)).toBe('timed_out');
    expect(await roster.recheck!('claude', 2000)).toBe('probed');
  });
});
