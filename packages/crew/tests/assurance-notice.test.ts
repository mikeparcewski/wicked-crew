import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { coverageNote, launchAssuranceNotice, readJudgeCoverage, sharingNotes, type JudgeCoverage } from '../src/core/assurance.js';
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

// crew#1673 / core#1594: a COVERED launch the engine saw sharing a provider, exactly as `Core.judgeCoverage` serializes
// it (wicked-core src/judge_coverage.rs: `Judge.seenSharing` omitted when none, `soleJudge` null when not exactly one,
// `notes` the engine's own sentence in seat keys).
const ENGINE_SHARING = JSON.stringify({
  covered: true, singleIdentity: false,
  authors: [
    { seat: 'claude', judges: [{ seat: 'codex' }, { seat: 'pi', seenSharing: 'api.anthropic.com:443' }], soleJudge: 'codex', notJudges: [] },
    { seat: 'codex', judges: [{ seat: 'claude' }, { seat: 'pi' }], soleJudge: null, notJudges: [] },
  ],
  benched: [],
  notes: ['pi was seen calling api.anthropic.com:443, the provider claude calls, so only codex can judge claude\'s work.'],
});

describe('provider sharing on a covered launch (crew#1673)', () => {
  it('reads the engine\'s soleJudge, and words its note with display names', () => {
    const coverage = readJudgeCoverage('[]', true, () => ENGINE_SHARING);
    expect(coverage?.authors[0]?.soleJudge).toBe('codex');
    const names: Record<string, string> = { claude: 'Builder', codex: 'Reviewer', pi: 'Helper' };
    expect(sharingNotes(coverage, (k) => names[k] ?? k)).toEqual([
      'Helper was seen calling api.anthropic.com:443, as was Builder, so only Reviewer can check Builder\'s work independently.',
    ]);
    // Covered, so no launch notice and no uncovered sentence: the note is the only disclosure.
    expect(coverageNote(coverage)).toBeNull();
    expect(notice(coverage)).toBeNull();
  });

  it('says nothing on a cold daemon (nothing seen yet) or for an uncovered or unknown launch', () => {
    const cold = readJudgeCoverage('[]', true, () => JSON.stringify({ ...JSON.parse(ENGINE_SHARING), authors: [{ seat: 'claude', judges: [{ seat: 'codex' }, { seat: 'pi' }], soleJudge: null, notJudges: [] }], notes: [] }));
    expect(sharingNotes(cold)).toEqual([]);
    expect(sharingNotes(uncovered)).toEqual([]);
    expect(sharingNotes(null)).toEqual([]);
  });

  it('every judge seen sharing, or several left: the sentence says so', () => {
    const all: JudgeCoverage = { covered: true, singleIdentity: false, benched: [], authors: [
      { seat: 'a', judges: [{ seat: 'b', seenSharing: 'p' }], soleJudge: null, notJudges: [] },
      { seat: 'b', judges: [{ seat: 'c' }, { seat: 'd' }, { seat: 'a', seenSharing: 'q' }], soleJudge: null, notJudges: [] },
    ] };
    expect(sharingNotes(all)).toEqual([
      'b was seen calling p, as was a, so no seat can check a\'s work independently.',
      'a was seen calling q, as was b, so c and d can check b\'s work independently.',
    ]);
  });

  it('refuses a malformed soleJudge as unknown coverage', () => {
    const badSole = JSON.parse(ENGINE_SHARING); badSole.authors[0].soleJudge = 3;
    expect(readJudgeCoverage('[]', true, () => JSON.stringify(badSole))).toBeNull();
  });
});

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
