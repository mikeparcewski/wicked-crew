// Seat sign-in on GET /roster — every seat gains `signed_in`, and the engine's
// `login_invocation` (wicked-core PR#278) rides through the route VERBATIM.
//
// Fastify inject() with a spied static roster (no NAPI, no operator clis.toml) and an injected
// `signedIn` probe (RuntimeDeps seam), so the suite never reads the developer's real dotfiles.
// The route must not whitelist seat fields: the `...seat` spread is the passthrough contract.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { RosterSeat } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

// One seat WITH the engine's login_invocation, one WITHOUT (an engine predating core PR#278
// serde-omits the None) — both must ride through exactly as the engine served them.
const SEATS: RosterSeat[] = [
  {
    key: 'claude',
    display_name: 'Claude Code',
    binary: 'claude',
    enabled_for_council: true,
    category: 'agentic-coder',
    version_probe: ['claude', '--version'],
    login_invocation: 'CLAUDE_CONFIG_DIR="$HOME/.wicked-worker/claude" claude',
  },
  {
    key: 'codex',
    display_name: 'Codex',
    binary: 'codex',
    enabled_for_council: true,
    category: 'agentic-coder',
    version_probe: ['codex', '--version'],
  },
];

function buildApp(signedIn: (seatKey: string, workerConfigRoot?: string) => boolean | null): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    // The roster route reads no adapter method — the static roster is spied below.
    {} as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    undefined,
    undefined,
    undefined,
    { seatHealth: new SeatHealthTracker(), signedIn },
  );
  return app;
}

describe('GET /roster with seat sign-in (seat sign-in)', () => {
  let app: FastifyInstance | undefined;
  const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

  beforeEach(() => {
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue(SEATS.map((s) => ({ ...s })));
  });

  afterEach(async () => {
    // Guarded: a test that throws before assigning `app` must not have its real failure
    // masked by a cleanup TypeError (Copilot, PR#281).
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
    if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
    else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
  });

  it('every seat carries signed_in from the probe; login_invocation rides through verbatim', async () => {
    app = buildApp((seatKey) => (seatKey === 'claude' ? true : null));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    expect(res.statusCode).toBe(200);
    const { roster } = res.json() as { roster: RosterSeat[] };
    expect(roster).toHaveLength(2);

    const claude = roster.find((s) => s.key === 'claude');
    const codex = roster.find((s) => s.key === 'codex');
    expect(claude?.signed_in).toBe(true);
    expect(codex?.signed_in).toBeNull();
    // The engine's login_invocation is NOT stripped (the route has no field whitelist)…
    expect(claude?.login_invocation).toBe('CLAUDE_CONFIG_DIR="$HOME/.wicked-worker/claude" claude');
    // …and the daemon never synthesizes one for a seat the engine served without it.
    expect('login_invocation' in (codex ?? {})).toBe(false);
    // Health (crew#274) still present alongside the new fields.
    expect(claude?.health).toMatchObject({ status: 'active' });
  });

  it('passes the LIVE WICKED_WORKER_HOME env to the probe (the value the engine reads per-spawn)', async () => {
    const seen: Array<string | undefined> = [];
    process.env['WICKED_WORKER_HOME'] = '/srv/worker-homes';
    app = buildApp((_seat, workerConfigRoot) => {
      seen.push(workerConfigRoot);
      return false;
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/v1/roster' });
    expect(seen).toEqual(['/srv/worker-homes', '/srv/worker-homes']);
  });

  it('an unset (or empty) env reaches the probe as undefined — the engine-default worker home', async () => {
    const seen: Array<string | undefined> = [];
    delete process.env['WICKED_WORKER_HOME'];
    app = buildApp((_seat, workerConfigRoot) => {
      seen.push(workerConfigRoot);
      return false;
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/v1/roster' });
    expect(seen).toEqual([undefined, undefined]);
  });

  it('every seat carries its STANDING — auth re-reads signed_in for what it means, council_eligible says what a council would do (F-2R2-009)', async () => {
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true },
      { key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true },
      { key: 'opencode', display_name: 'opencode', binary: 'opencode', enabled_for_council: true },
      { key: 'agy', display_name: 'Antigravity', binary: 'agy', enabled_for_council: false },
    ]);
    // The fresh rig: claude signed in; codex / opencode / agy not observable as signed in.
    app = buildApp((seatKey) => (seatKey === 'claude' ? true : seatKey === 'agy' ? null : false));
    await app.ready();

    const { roster } = (await app.inject({ method: 'GET', url: '/api/v1/roster' })).json() as { roster: RosterSeat[] };
    const by = new Map(roster.map((s) => [s.key, s]));
    expect(by.get('claude')).toMatchObject({ signed_in: true, auth: 'signed_in', council_eligible: true });
    expect(by.get('claude')?.council_ineligible_reason).toBeUndefined();
    // codex needs a credential: "signed out" means a council benches it.
    expect(by.get('codex')).toMatchObject({ signed_in: false, auth: 'signed_out', council_eligible: false });
    expect(by.get('codex')?.council_ineligible_reason).toMatch(/signed out.*bench/);
    // opencode answers on its free tier: the SAME signed_in:false reads not_required, and it is eligible.
    expect(by.get('opencode')).toMatchObject({ signed_in: false, auth: 'not_required', council_eligible: true });
    expect(by.get('opencode')?.free_tier).toMatch(/OpenCode Zen/);
    // unknown auth is eligible; a seat disabled for council is not, and says so.
    expect(by.get('agy')).toMatchObject({ signed_in: null, auth: 'unknown', council_eligible: false, council_ineligible_reason: 'not enabled for council' });
  });

  it('existing seat fields stay untouched (the seat still round-trips into clisJson on launch)', async () => {
    app = buildApp(() => null);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    const { roster } = res.json() as { roster: RosterSeat[] };
    expect(roster[0]).toMatchObject({
      key: 'claude',
      display_name: 'Claude Code',
      binary: 'claude',
      enabled_for_council: true,
      category: 'agentic-coder',
      version_probe: ['claude', '--version'],
    });
  });
});
