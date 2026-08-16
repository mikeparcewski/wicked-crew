// crew#274 — GET /roster carries per-seat runtime health.
//
// Fastify inject() with a mock adapter and a spied static roster (no NAPI, no operator
// clis.toml dependency). Existing seat fields must ride through verbatim — the wire contract
// is additive: `health` is a NEW field, everything else is untouched.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const SEATS: RosterSeat[] = [
  {
    key: 'claude',
    display_name: 'Claude Code',
    binary: 'claude',
    enabled_for_council: true,
    category: 'agentic-coder',
    version_probe: ['claude', '--version'],
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

function buildApp(tracker: SeatHealthTracker): FastifyInstance {
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
    // signedIn stubbed to "unknown" so this suite stays about HEALTH and never reads the
    // developer's real dotfiles (the sign-in surface has its own suites).
    { seatHealth: tracker, signedIn: () => null },
  );
  return app;
}

describe('GET /roster with seat health (crew#274)', () => {
  let tracker: SeatHealthTracker;
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue(SEATS.map((s) => ({ ...s })));
    tracker = new SeatHealthTracker();
    app = buildApp(tracker);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('every seat defaults to active health with no message, existing fields untouched', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    expect(res.statusCode).toBe(200);
    const { roster } = res.json() as { roster: RosterSeat[] };
    expect(roster).toHaveLength(2);
    for (const seat of roster) {
      expect(seat.health).toMatchObject({ status: 'active' });
      expect(seat.health?.message).toBeUndefined();
      expect(typeof seat.health?.since).toBe('string');
    }
    // The seat itself rides through verbatim (it round-trips into clisJson on launch).
    expect(roster[0]).toMatchObject({
      key: 'claude',
      display_name: 'Claude Code',
      binary: 'claude',
      enabled_for_council: true,
      category: 'agentic-coder',
      version_probe: ['claude', '--version'],
    });
  });

  it('a folded seat-level failure surfaces as inactive + message on exactly that seat', async () => {
    tracker.ingest({
      type: 'stepFailed',
      session: 'r1',
      ord: 2,
      attempt: 0,
      detail: '(cli `codex` exited 1) 401 Unauthorized (run codex login)',
      failureKind: 'workerError',
    } as unknown as CoreEvent);

    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    const { roster } = res.json() as { roster: RosterSeat[] };
    const codex = roster.find((s) => s.key === 'codex');
    const claude = roster.find((s) => s.key === 'claude');
    expect(codex?.health?.status).toBe('inactive');
    expect(codex?.health?.message).toContain('401 Unauthorized');
    expect(codex?.health?.lastErrorAt).toBeDefined();
    expect(claude?.health?.status).toBe('active');
    expect(claude?.health?.message).toBeUndefined();
  });

  it('recovery (ok output for the seat) reads back as active again', async () => {
    tracker.ingest({
      type: 'stepFailed', session: 'r2', ord: 1, attempt: 0,
      detail: '(cli `codex` exited 1) transient', failureKind: 'workerError',
    } as unknown as CoreEvent);
    tracker.ingest({
      type: 'unitDistributed', session: 'r3', ord: 1, cli: 'codex', routing_method: 'council',
    } as unknown as CoreEvent);
    tracker.ingest({
      type: 'unitOutputCaptured', session: 'r3', ord: 1, attempt: 0,
      outputBytes: 42, stepStatus: 'ok', governed: true,
    } as unknown as CoreEvent);

    const res = await app.inject({ method: 'GET', url: '/api/v1/roster' });
    const { roster } = res.json() as { roster: RosterSeat[] };
    const codex = roster.find((s) => s.key === 'codex');
    expect(codex?.health?.status).toBe('active');
    expect(codex?.health?.message).toBeUndefined();
  });
});
