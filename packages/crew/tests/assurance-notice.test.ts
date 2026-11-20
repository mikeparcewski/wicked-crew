import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { coverageNote, launchAssuranceNotice, readJudgeCoverage, type JudgeCoverage } from '../src/core/assurance.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';

const uncovered: JudgeCoverage = {
  covered: false, singleIdentity: false,
  authors: [{ seat: 'claude', judges: [{ seat: 'codex', seenSharing: 'anthropic' }], notJudges: [{ seat: 'claude', reason: 'same_identity' }, { seat: 'pi', reason: 'benched', detail: 'Pi cannot work in this checkout' }] }],
  benched: [{ seat: 'pi', reason: 'worktree', detail: 'Pi cannot work in this checkout' }],
};
const notice = (coverage: JudgeCoverage | null, reducedAssurance?: boolean) =>
  launchAssuranceNotice({ runId: 'r1', reducedAssurance, coverage });

describe('engine judge coverage', () => {
  it('two CLIs without an independent judge are named with the bench and shared provider', () => {
    const n = notice(uncovered);
    expect(n).toMatchObject({ code: 'no_independent_judge', seats: ['claude'], retryWith: { retryOf: 'r1', reducedAssurance: true } });
    expect(n?.message).toContain('same CLI');
    expect(n?.message).toContain('Pi cannot work in this checkout');
    expect(n?.message).toContain('anthropic');
    expect(n?.message).toContain('"reducedAssurance": true');
  });

  it('covered, unknown, empty and opted-in launches have no notice', () => {
    expect(notice({ ...uncovered, covered: true })).toBeNull();
    expect(notice(null)).toBeNull();
    expect(notice({ ...uncovered, authors: [] })).toBeNull();
    expect(notice(uncovered, true)).toBeNull();
  });

  it('launch coverage notes keep seat keys and mention a benched seat once', () => {
    const note = coverageNote(uncovered);
    expect(note).toContain('claude runs the same CLI as claude');
    expect(note).toContain('pi cannot check it: Pi cannot work in this checkout');
    expect(note?.match(/\bpi\b/g)).toHaveLength(1);
  });

  it('a single identity names work seats without mistaking a seat key for a CLI', () => {
    const n = notice({ covered: false, singleIdentity: true, authors: ['a', 'b'].map((seat) => ({ seat, judges: [], notJudges: [] })), benched: [] });
    expect(n).toMatchObject({ code: 'single_cli_roster', seats: ['a', 'b'] });
    expect(n?.message).toContain("Every seat that can work (a, b) runs the same CLI, so no other CLI can evaluate or judge this run's work.");
    expect(n?.message).toContain('relaunch with "reducedAssurance": true to let it evaluate its own work, disclosed on every receipt.');
  });

  it('reads only the engine answer, with the roster and binding unchanged', () => {
    const calls: unknown[] = [];
    expect(readJudgeCoverage('roster', true, (json, bound) => { calls.push([json, bound]); return JSON.stringify(uncovered); })).toEqual(uncovered);
    expect(calls).toEqual([['roster', true]]);
    expect(readJudgeCoverage('[]', false, () => null)).toBeNull();
    expect(readJudgeCoverage('[]', false, () => { throw new Error('unavailable'); })).toBeNull();
    for (const value of ['{', '{}', '{"covered":true}', JSON.stringify({ ...uncovered, authors: [{ seat: 'x', judges: [{}], notJudges: [] }] }), JSON.stringify({ ...uncovered, benched: [{ seat: 'x' }] })]) {
      expect(readJudgeCoverage('[]', false, () => value)).toBeNull();
    }
  });

  it('POST /runs defaults to the adapter static coverage predicate', async () => {
    const app = Fastify();
    const predicate = vi.spyOn(CoreAdapter, 'judgeCoverage').mockReturnValue(JSON.stringify(uncovered));
    try {
      registerRoutes(app, {
        getSettings: async () => ({}), sessions: async () => [], sessionsDetail: async () => [],
        listRepos: async () => [], listWorkflows: () => [], getWorkflow: () => null,
        launchRun: async () => 'r1',
      } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
        rosterWithStanding: () => [],
      });
      const out = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]' } });
      expect(out.statusCode, out.body).toBe(201);
      expect(out.json().assuranceNotice?.code).toBe('no_independent_judge');
      expect(predicate).toHaveBeenCalledWith('[]', false);
    } finally { predicate.mockRestore(); await app.close(); }
  });

  it('POST /runs uses the injected coverage of its engine roster', async () => {
    const app = Fastify();
    const calls: unknown[] = [];
    registerRoutes(app, {
      getSettings: async () => ({}), sessions: async () => [], sessionsDetail: async () => [],
      listRepos: async () => [], listWorkflows: () => [], getWorkflow: () => null,
      launchRun: async () => 'r1',
    } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
      rosterWithStanding: () => [],
      judgeCoverage: (json, bound) => { calls.push([JSON.parse(json), bound]); return JSON.stringify(uncovered); },
    });
    try {
      const out = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]' } });
      expect(out.statusCode, out.body).toBe(201);
      expect(out.json().assuranceNotice?.code).toBe('no_independent_judge');
      expect(calls).toEqual([[[], false]]);
    } finally { await app.close(); }
  });
});
