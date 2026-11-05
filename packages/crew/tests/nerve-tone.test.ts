// NERVE CENTER'S TONE (operator 2026-11-05): "people aren't going to have all the cli's — having every
// cli except one or two logged in shouldn't make things yellow for nerve center". Yellow is for a fix the
// person can make and that matters:
//  - fewer than two distinct seats can take part, so a different agent can't review (the seat-pool rule);
//  - a signed-out seat that a job still running was given in its pool;
// and a CLI nobody set up is never an item, nor a degraded seat-image row.

import { describe, expect, it } from 'vitest';
import type { SessionView, SystemCli, SystemRun } from 'wicked-crew-api-types';

import { buildNeeds, needsLevel, SECOND_AGENT_TITLE } from '../src/api/needs.js';
import { idleClis, probeSeatImages, type SeatImageStatus } from '../src/api/seat-images.js';
import { buildGovernance, judgeGaps } from '../src/api/system-snapshot.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');

const cli = (key: string, state: SystemCli['state'] = 'signed_in', extra: Partial<SystemCli> = {}): SystemCli =>
  ({
    cli: key,
    label: key,
    state,
    stateReason: state === 'signed_in' ? null : 'signed out',
    canSignIn: true,
    councilEligible: state === 'signed_in',
    workEligible: state === 'signed_in',
    ...extra,
  }) as SystemCli;

/** Four of five signed in; opencode never set up. */
const FOUR_OF_FIVE = [cli('claude'), cli('codex'), cli('pi'), cli('copilot'), cli('opencode', 'signed_out')];

/** A job: unit 1 (done) built on claude; unit 2 (not done yet) is on `next`. */
const view = (id: string, clis: string[], status = 'executing', next = 'claude'): SessionView =>
  ({
    session: { id, title: `job ${id}`, problem: `job ${id}`, status, workflow_id: 'feature', repo_ref: 'repo-a', clis, archived_at: null, created_at: Math.floor((NOW - 3_600_000) / 1000), delivery: 'none' },
    units: [
      { id: `${id}:u1`, session_id: id, ord: 1, status: 'done', assigned_cli: 'claude', phase_ref: null, stage: 'build' },
      { id: `${id}:u2`, session_id: id, ord: 2, status: 'pending', assigned_cli: next, phase_ref: null, stage: 'review' },
    ],
  }) as unknown as SessionView;

const run = (id: string, liveness: SystemRun['liveness'] = 'working', gate: SystemRun['gate'] = undefined, seat = 'claude'): SystemRun =>
  ({ runId: id, title: `job ${id}`, status: 'executing', liveness, reason: '', phase: null, unitOrd: 2, seat, lastEventAt: null, evidence: 'relay', quietForMs: 0, quietAfterMs: 300_000, stallAfterMs: 900_000, ...(gate !== undefined ? { gate } : {}) }) as SystemRun;

/** The production path: the judge gaps are derived by `judgeGaps`, as the route derives them. */
const needs = (clis: SystemCli[], views: SessionView[] = [], runs: SystemRun[] = []) => {
  const pairs = runs.map((run) => ({ view: views.find((v) => v.session.id === run.runId)!, run }));
  return buildNeeds({ now: NOW, views, runs, infra: [], clis, gaps: judgeGaps(pairs, clis), infraHoldsLive: () => false });
};

describe('signed-out CLIs nobody uses are not yellow', () => {
  it('4 of 5 signed in, no job: nothing needs a look (green)', () => {
    const n = needs(FOUR_OF_FIVE);
    expect(n.attention).toEqual([]);
    expect(needsLevel(n.attention, n.unresolved)).toBe('green');
  });

  it('an optional CLI that never signed in is no item, even with jobs running on the default pool', () => {
    const v = view('a', ['claude', 'codex', 'pi', 'copilot']);
    const n = needs(FOUR_OF_FIVE, [v], [run('a')]);
    expect(n.attention).toEqual([]);
  });
});

describe('too few seats to review: yellow, with the fix in words', () => {
  it('one seat signed in: one yellow item, "Sign in a second agent so a different one can review"', () => {
    const one = [cli('claude'), cli('codex', 'signed_out'), cli('pi', 'signed_out'), cli('opencode', 'signed_out')];
    const n = needs(one);
    expect(n.attention.map((a) => a.id)).toEqual(['cli:one-reviewer']);
    expect(n.attention[0]).toMatchObject({ severity: 'yellow', kind: 'slows', source: 'cli', title: SECOND_AGENT_TITLE, action: { kind: 'sign_in' } });
    expect(n.attention[0]!.reason).toMatch(/^Only claude is signed in, so no different agent can review its work/);
    expect(SECOND_AGENT_TITLE).toBe('Sign in a second agent so a different one can review');
    expect(needsLevel(n.attention)).toBe('yellow');
  });

  it('a second seat of the same CLI (claude#2) is not a second agent', () => {
    const n = needs([cli('claude'), cli('claude#2'), cli('codex', 'signed_out')]);
    expect(n.attention.map((a) => a.id)).toEqual(['cli:one-reviewer']);
  });

  it('a benched second agent is still signed in (its bench lifts by itself): no item', () => {
    expect(needs([cli('claude'), cli('codex', 'benched', { workEligible: false, councilEligible: false })]).attention).toEqual([]);
  });

  it('a job already held for want of a reviewer carries it in its own item: one cause, one item', () => {
    const one = [cli('claude'), cli('codex', 'signed_out')];
    const v = view('g', ['claude', 'codex'], 'awaiting_human');
    const r = run('g', 'held', { interactionId: 'i', ord: 1, kind: 'escalation', prompt: 'p', receivedAt: new Date(NOW - 60_000).toISOString() } as SystemRun['gate']);
    const n = buildNeeds({ now: NOW, views: [v], runs: [r], infra: [], clis: one, gaps: [{ run: r, creator: 'claude', blockedBy: [one[1]!] }], infraHoldsLive: () => false });
    expect(n.attention.map((a) => a.id)).toEqual(['run:g']);
  });

  it('no seat at all stays red (cli:none), never the yellow item', () => {
    const n = needs([cli('claude', 'signed_out'), cli('codex', 'signed_out')]);
    expect(n.attention.map((a) => [a.id, a.severity])).toEqual([['cli:none', 'red']]);
  });

  it('the judges card is ok when the only other agent is benched (the bench lifts by itself)', () => {
    const card = buildGovernance({ governance: null, skillsFindings: [], decisions: null, clis: [cli('claude'), cli('codex', 'benched', { workEligible: false, councilEligible: false })], judgeGapCount: 0, week: null, gatesByYou: 0, steeringRules: 1 }).find((c) => c.key === 'judges')!;
    expect(card.state).toBe('ok');
    expect(card.reason).toMatch(/once codex is back from the bench/);
  });

  it('the judges card says it as degraded while nothing is held, down once a job is', () => {
    const base = { governance: null, skillsFindings: [], decisions: null, clis: [cli('claude'), cli('codex', 'signed_out')], week: null, gatesByYou: 0, steeringRules: 1 };
    expect(buildGovernance({ ...base, judgeGapCount: 0 }).find((c) => c.key === 'judges')!.state).toBe('degraded');
    expect(buildGovernance({ ...base, judgeGapCount: 2 }).find((c) => c.key === 'judges')!.state).toBe('down');
  });
});

describe('a seat that dropped while a job needs it: yellow', () => {
  const dropped = [cli('claude'), cli('codex'), cli('pi', 'signed_out'), cli('opencode', 'signed_out')];

  it('a running job whose next step is on pi, now signed out: one yellow item for pi', () => {
    const n = needs(dropped, [view('a', ['claude', 'codex', 'pi'], 'executing', 'pi')], [run('a')]);
    expect(n.attention.map((a) => a.id)).toEqual(['cli:out:pi']);
    expect(n.attention[0]).toMatchObject({ severity: 'yellow', kind: 'slows', source: 'cli', blockedRunIds: ['a'], target: { kind: 'cli', cli: 'pi' }, action: { kind: 'sign_in' } });
    expect(n.attention[0]!.title).toBe('pi is signed out');
    expect(needsLevel(n.attention)).toBe('yellow');
  });

  it('the seat the current step runs on counts too, with a default (empty) pool', () => {
    const n = needs(dropped, [view('b', [])], [run('b', 'working', undefined, 'pi')]);
    expect(n.attention.map((a) => a.id)).toEqual(['cli:out:pi']);
  });

  it('being in a default pool is not need: a launch that lists pi but has no work on it stays green', () => {
    const n = needs(dropped, [view('c', ['claude', 'codex', 'pi'])], [run('c')]);
    expect(n.attention).toEqual([]);
  });

  it('exact seat keys: work on pi is not work on pi#2', () => {
    const n = needs([cli('claude'), cli('codex'), cli('pi'), cli('pi#2', 'signed_out')], [view('d', ['claude', 'pi'], 'executing', 'pi')], [run('d')]);
    expect(n.attention).toEqual([]);
  });

  it('a job at its terminal gate (its work is done) needs no seat; a finished job is not listed at all', () => {
    const v = view('t', ['claude', 'codex', 'pi'], 'awaiting_human', 'pi');
    const t = run('t', 'waiting_on_you', { interactionId: 'i', ord: 1, kind: 'terminal', prompt: 'p', receivedAt: new Date(NOW - 60_000).toISOString() } as SystemRun['gate']);
    expect(needs(dropped, [v], [t]).attention.map((a) => a.id)).not.toContain('cli:out:pi');
    expect(needs(dropped, [view('e', ['claude', 'pi'], 'completed', 'pi')], []).attention).toEqual([]);
  });

  it('opencode, signed out and with no work on it, stays out of it', () => {
    const n = needs(dropped, [view('a', ['claude', 'codex', 'pi'], 'executing', 'pi')], [run('a')]);
    expect(n.attention.some((a) => a.id.includes('opencode'))).toBe(false);
  });
});

describe('seat images: a CLI nobody signed in needs no image yet', () => {
  const st = (missing: string[]): SeatImageStatus => ({
    runtime: 'docker',
    base: { image: 'wicked-seat-base:rust', present: true, held: true },
    baseRecipe: false,
    holdSupported: true,
    floor: { image: 'wicked-floor:1', present: true, held: true },
    seats: ['claude', 'codex', 'opencode'].map((c) => ({ cli: c, image: `wicked-seat-${c}:1`, present: !missing.includes(c), held: !missing.includes(c), operatorImage: false })),
    disk: { totalBytes: 100 * 2 ** 30, availBytes: 60 * 2 ** 30, usedPct: 40 },
    imageGcHighPct: 85,
  });
  const probe = (missing: string[], idle: string[]) =>
    probeSeatImages({ containerFloor: true, clis: ['claude', 'codex', 'opencode'], idle: () => idle, status: async () => st(missing), rebuild: () => null });

  it('opencode signed out with its image missing: ok, and the reason says it is built on sign-in', async () => {
    const row = await probe(['opencode'], ['opencode']);
    expect(row.state).toBe('ok');
    expect(row.reason).toMatch(/not needed until signed in: opencode/);
  });

  it('a CLI is idle only when none of its seats is signed in (claude#2 keeps claude\'s image)', () => {
    expect(idleClis([{ key: 'claude', auth: 'signed_out' }, { key: 'claude#2', auth: 'signed_in' }, { key: 'opencode', auth: 'signed_out' }, { key: 'pi', signed_in: false }])).toEqual(['opencode', 'pi']);
  });

  it('a signed-in seat whose image is missing still reads degraded', async () => {
    const row = await probe(['codex', 'opencode'], ['opencode']);
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/seat images missing: codex/);
    expect(row.reason).not.toMatch(/missing: codex, opencode/);
  });
});
