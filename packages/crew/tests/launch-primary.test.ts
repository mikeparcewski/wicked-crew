// DES-TEAMING-002 §8.1: a launch may name the seat that LEADS the run (`LaunchRunBody.primary`,
// api-types 0.128.0). Crew owns eligibility, the engine owns the pick:
//   - a key in the launch roster is forwarded to the engine as `LaunchRunInput.primary`;
//   - a key not in the roster, or a seat the roster marks signed out, is a 400 that names it, and
//     nothing launches;
//   - omitted, nothing is forwarded (the engine picks at random, `path.started.selection`);
//   - `/health.capabilities.launchPrimary` says the field is accepted;
//   - naming an opt-in seat (absent from the default roster) as the lead adds it to that roster.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { launchRosterNaming, primaryRefusal, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';

const roster = (seats: Array<Record<string, unknown>>) => JSON.stringify(seats);

describe('POST /runs takes the lead agent (primary)', () => {
  let app: FastifyInstance;
  let launchRun: Mock;

  beforeEach(async () => {
    launchRun = vi.fn(async (input: LaunchRunInput) => input.sessionId);
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        launchRun,
        ping: async () => 'ok',
        getSettings: async () => ({}),
        sessionsDetail: vi.fn().mockResolvedValue([]),
        sessions: vi.fn().mockResolvedValue([]),
        listWorkflows: () => [],
        listRepos: vi.fn().mockResolvedValue([]),
        projectMembers: vi.fn().mockResolvedValue([]),
        projectMemberAttach: vi.fn(),
        projectMemberDetach: vi.fn(),
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const clisJson = roster([{ key: 'claude' }, { key: 'codex' }, { key: 'pi', council_eligible: false }]);

  it('forwards a roster seat to the engine', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson, primary: 'codex' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(launchRun).toHaveBeenCalledTimes(1);
    expect((launchRun.mock.calls[0]![0] as LaunchRunInput).primary).toBe('codex');
  });

  it('forwards nothing when the launch names no lead (the engine picks at random)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson } });
    expect(res.statusCode, res.body).toBe(201);
    expect((launchRun.mock.calls[0]![0] as LaunchRunInput).primary).toBeUndefined();
  });

  it('refuses a seat that is not in the roster, by name, and launches nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson, primary: 'copilot' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not in this launch's roster: copilot \(roster: claude, codex, pi\)/);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('refuses a signed-out seat as the lead', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson, primary: 'pi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/signed out or disabled: pi/);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('refuses an empty primary at parse time', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson, primary: '' } });
    expect(res.statusCode).toBe(400);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('says so on /health.capabilities.launchPrimary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.json().capabilities.launchPrimary).toBe(true);
  });
});

describe('primaryRefusal / launchRosterNaming', () => {
  it('leaves an unparseable roster to the engine', () => {
    expect(primaryRefusal('claude', 'not json')).toBeNull();
    expect(primaryRefusal('claude', '{}')).toBeNull();
  });

  it('adds the opt-in seat the launch names as its lead, and only that one', () => {
    const full = [{ key: 'claude' }, { key: 'opencode' }];
    expect(launchRosterNaming(full, undefined).map((s) => s.key)).toEqual(['claude']);
    expect(launchRosterNaming(full, 'claude').map((s) => s.key)).toEqual(['claude']);
    expect(launchRosterNaming(full, 'opencode').map((s) => s.key)).toEqual(['claude', 'opencode']);
    expect(launchRosterNaming(full, 'nope').map((s) => s.key)).toEqual(['claude']);
  });
});
