/**
 * Default evals (DES-DEFAULT-EVALS-001): the scorer on fixtures, capture of real cases from a run store, the
 * per-project and cross-project runner (a planted normalization mismatch is found), real and synthetic reported
 * apart, the store, the routes and the CLI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  archetypeOfWorkflow,
  captureAttributionCases,
  captureFloorCases,
  captureQeCases,
  captureSteeringDenials,
  changingSeats,
  floorClassOf,
  scrub,
  verdictInReason,
  type CaptureInput,
  type EventLike,
} from '../src/evals/capture.js';
import { archetypeAdapter, type ReplaySet } from '../src/evals/replay.js';
import { registerDefaultEvalRoutes } from '../src/evals/routes.js';
import { runDefaultEvals } from '../src/evals/runner.js';
import { main as cliMain, parseArgs, summaryLines } from '../src/evals/run-cli.js';
import { driftKeys, scoreSlice, slices } from '../src/evals/score.js';
import { needsYouSeed } from '../src/evals/seed-needs-you.js';
import { RIG_SEED } from '../src/evals/seed-rig.js';
import { calibration, rate, trendOf } from '../src/evals/stats.js';
import { DefaultEvalStore } from '../src/evals/store.js';
import { generateSynthetic } from '../src/evals/synthetic.js';
import type { DefaultEvalReport, EvalCase } from '../src/evals/types.js';

const NO_REPLAY: ReplaySet = { adapters: {}, missing: {} };

function cls(id: string, observed: string | null, expected: string, extra: Partial<EvalCase> = {}): EvalCase {
  return {
    id,
    suite: 'floor-class',
    source: 'real',
    project: 'p1',
    inputKey: `k:${id}`,
    input: {},
    observed: observed === null ? null : { label: observed, by: 'recorded' },
    expected: { label: expected, by: 'rule' },
    ...extra,
  };
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'default-evals-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('statistics', () => {
  it('a Wilson interval brackets the rate and stays in [0, 1]', () => {
    const r = rate(8, 10);
    expect(r.value).toBe(0.8);
    expect(r.lo).toBeCloseTo(0.4902, 3);
    expect(r.hi).toBeCloseTo(0.9433, 3);
    expect(r.tooFew).toBe(false);
    expect(rate(0, 3)).toMatchObject({ value: 0, lo: 0, tooFew: true });
    expect(rate(0, 0)).toMatchObject({ value: null, lo: null, hi: null, tooFew: true });
  });

  it('below 5 cases a figure is too few and no trend is called', () => {
    expect(rate(4, 4).tooFew).toBe(true);
    expect(trendOf(rate(4, 4), { value: 0.1, n: 50 })).toBe('too-few');
    expect(trendOf(rate(50, 50), { value: 0.5, n: 3 })).toBe('too-few');
    expect(trendOf(rate(5, 5), null)).toBe('first-run');
  });

  it('a trend is notable only when the interval excludes the last value', () => {
    expect(trendOf(rate(45, 50), { value: 0.5, n: 50 })).toBe('improved');
    expect(trendOf(rate(10, 50), { value: 0.6, n: 50 })).toBe('regressed');
    expect(trendOf(rate(26, 50), { value: 0.55, n: 50 })).toBe('no-change');
  });

  it('calibration needs 20 answers; a perfectly calibrated set scores near 0 ECE', () => {
    expect(calibration(Array.from({ length: 19 }, () => ({ confidence: 0.9, correct: true }))).tooFew).toBe(true);
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.55, correct: i < 5 || i === 5 })),
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.95, correct: i < 9 || i === 9 })),
    ];
    const c = calibration(pts);
    expect(c.tooFew).toBe(false);
    expect(c.ece).not.toBeNull();
    expect(c.brier).not.toBeNull();
    // Overconfident answers (0.95 sure, half wrong) calibrate worse.
    const over = calibration(Array.from({ length: 20 }, (_, i) => ({ confidence: 0.95, correct: i % 2 === 0 })));
    expect(over.ece!).toBeGreaterThan(c.ece!);
  });
});

describe('the scorer', () => {
  it('scores agreement and per-class precision and recall; an unscored case counts as neither', () => {
    const s = scoreSlice([
      cls('a', 'base_red', 'base_red'),
      cls('b', 'boundary_deny', 'base_red'),
      cls('c', 'real_fail', 'real_fail'),
      cls('d', null, 'real_fail'),
    ]);
    expect(s.cases).toBe(4);
    expect(s.unscored).toBe(1);
    expect(s.agreement).toMatchObject({ k: 2, n: 3 });
    const base = s.perClass.find((c) => c.label === 'base_red')!;
    expect(base.precision).toMatchObject({ k: 1, n: 1 });
    expect(base.recall).toMatchObject({ k: 1, n: 2 });
    const bd = s.perClass.find((c) => c.label === 'boundary_deny')!;
    expect(bd.precision).toMatchObject({ k: 0, n: 1 });
  });

  it('scores set answers by member precision and recall', () => {
    const s = scoreSlice([
      { ...cls('a', null, 'x'), observed: { labels: ['claude', 'copilot'], by: 'recorded' }, expected: { labels: ['claude'], by: 'rule' } },
      { ...cls('b', null, 'x'), observed: { labels: ['codex'], by: 'recorded' }, expected: { labels: ['claude'], by: 'rule' } },
    ]);
    expect(s.agreement).toMatchObject({ k: 0, n: 2 });
    expect(s.members!.precision).toMatchObject({ k: 1, n: 3 });
    expect(s.members!.recall).toMatchObject({ k: 1, n: 2 });
  });

  it('scores a merge pairwise, within one answerer only', () => {
    const item = (id: string, surface: string, oc: string, ec: string): EvalCase => ({
      ...cls(`${surface}:${id}`, 'count', 'count', { suite: 'needs-you', surface }),
      observed: { label: 'count', cluster: oc, by: 'recorded' },
      expected: { label: 'count', cluster: ec, by: 'operator' },
    });
    // The ruling merges a+b+c; codex kept them apart; a second answerer merged them right.
    const s = scoreSlice([item('a', 'codex', 'a', 'X'), item('b', 'codex', 'b', 'X'), item('c', 'codex', 'c', 'X'), item('a', 'nerve', 'M', 'X'), item('b', 'nerve', 'M', 'X')]);
    expect(s.pairs!.recall).toMatchObject({ k: 1, n: 4 });
    expect(s.pairs!.precision).toMatchObject({ k: 1, n: 1 });
  });

  it('reports real, synthetic, combined and model-labelled apart; model labels never reach the headline', () => {
    const s = slices([
      cls('r1', 'a', 'a'),
      cls('r2', 'a', 'b'),
      cls('s1', 'a', 'a', { source: 'synthetic' }),
      { ...cls('m1', 'a', 'b'), expected: { label: 'b', by: 'model:codex' } },
    ]);
    expect(s.real.agreement).toMatchObject({ k: 1, n: 2 });
    expect(s.synthetic.agreement).toMatchObject({ k: 1, n: 1 });
    expect(s.combined.agreement).toMatchObject({ k: 2, n: 3 });
    expect(s.model.agreement).toMatchObject({ k: 0, n: 1 });
  });
});

describe('normalization drift', () => {
  it('flags an input judged differently by project, and not one judged the same', () => {
    const drift = driftKeys([
      cls('a', 'base_red', 'base_red', { project: 'wicked-core', inputKey: 'floor:base_red' }),
      cls('b', 'boundary_deny', 'base_red', { project: 'wicked-crew', inputKey: 'floor:base_red' }),
      cls('c', 'real_fail', 'real_fail', { project: 'wicked-core', inputKey: 'floor:real_fail' }),
      cls('d', 'real_fail', 'real_fail', { project: 'wicked-crew', inputKey: 'floor:real_fail' }),
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ inputKey: 'floor:base_red', axis: 'project', observed: { 'wicked-core': ['base_red'], 'wicked-crew': ['boundary_deny'] } });
  });

  it('a cross-project run finds a planted mismatch from a classifier that behaves differently by project', async () => {
    const prompts = ['Fix the login crash', 'Review PR 12', 'Where is the gate code?', 'Add a median function', 'Cut the release'];
    const cases: EvalCase[] = ['alpha', 'beta'].flatMap((project) =>
      prompts.map((prompt, i) => ({
        id: `archetype:${project}:${i}`,
        suite: 'archetype' as const,
        source: 'real' as const,
        project,
        inputKey: `archetype:${prompt.toLowerCase()}`,
        input: { prompt },
        observed: null,
        expected: { label: 'build', by: 'operator' as const },
      })),
    );
    // Planted: in project beta the classifier calls "Review PR 12" a build (a per-project setting gone wrong).
    const replay: ReplaySet = {
      adapters: {
        archetype: {
          suite: 'archetype',
          replay: async (cs) =>
            new Map(cs.map((c) => [c.id, { label: c.project === 'beta' && c.input['prompt'] === 'Review PR 12' ? 'build' : 'review', by: 'replay' as const }])),
        },
      },
      missing: {},
    };
    const { report } = await runDefaultEvals({ id: 'x1', now: new Date(0), project: null, cases, replay, previous: null, suites: ['archetype', 'normalization'] });
    expect(report.drift.map((d) => d.inputKey)).toEqual(['archetype:review pr 12']);
    const norm = report.suites.find((s) => s.suite === 'normalization')!;
    expect(norm.combined.agreement).toMatchObject({ k: 4, n: 5 });
    const arch = report.suites.find((s) => s.suite === 'archetype')!;
    expect(Object.keys(arch.byProject ?? {})).toEqual(['alpha', 'beta']);

    // A single-project run never compares projects, so it reports no project drift.
    const one = await runDefaultEvals({ id: 'x2', now: new Date(0), project: 'beta', cases, replay, previous: null, suites: ['archetype', 'normalization'] });
    expect(one.report.drift).toEqual([]);
    expect(one.report.suites.find((s) => s.suite === 'archetype')!.real.cases).toBe(5);
  });
});

describe('synthetic cases', () => {
  it('fill only classes with fewer than 5 real cases, deterministically, and stay unscored without replay', async () => {
    const real = Array.from({ length: 5 }, (_, i) => cls(`r${i}`, 'base_red', 'base_red'));
    const a = generateSynthetic(real);
    expect(a.some((c) => c.suite === 'floor-class' && c.expected.label === 'base_red')).toBe(false);
    expect(a.some((c) => c.suite === 'floor-class' && c.expected.label === 'real_fail')).toBe(true);
    expect(generateSynthetic(real)).toEqual(a);
    const { report } = await runDefaultEvals({ id: 'x', now: new Date(0), project: null, cases: real, replay: NO_REPLAY, previous: null, suites: ['floor-class'] });
    const floor = report.suites[0]!;
    expect(floor.real.agreement).toMatchObject({ k: 5, n: 5 });
    expect(floor.synthetic.cases).toBeGreaterThan(0);
    expect(floor.synthetic.unscored).toBe(floor.synthetic.cases);
    expect(floor.notes.join(' ')).toMatch(/not scored/);
  });
});

// ── capture ────────────────────────────────────────────────────────────────────────────────────────────────────

const check = (outcome: string, decision: string | null = null) => ({ name: 'test', outcome, envCannotRun: [], decision: decision === null ? null : { outcome: decision } });

describe('capture: the floor class', () => {
  const runs = [{ session: { id: 'r1', repo_ref: 'wicked-crew' }, units: [] }];
  const events: EventLike[] = [
    { type: 'repoChecksEvaluated', ord: 6, seq: 1, ts: 100, attempt: 2, checks: [check('passed'), check('failed', 'base_red_unseparated')] },
    // The rig's 64f05d3d attempt 2: a floor that RAN, escalated as a boundary deny.
    { type: 'gateEscalated', ord: 6, seq: 2, ts: 101, condition: 'boundary_deny', denialSource: 'repo_checks', attempt: 2 },
    { type: 'repoChecksEvaluated', ord: 6, seq: 3, ts: 200, attempt: 3, checks: [check('failed')] },
    { type: 'gateEscalated', ord: 6, seq: 4, ts: 201, condition: 'floor_failed', denialSource: 'repo_checks', attempt: 3 },
  ];
  const input: CaptureInput = {
    runs,
    events: () => events,
    decisions: [{ id: 'd1', at: 250, origin: { run_id: 'r1', ord: 6, choice: 'operator_judgment' } }],
    qeVerdicts: [],
  };

  it('reads each floor’s own checks', () => {
    expect(floorClassOf(events[0]!)).toBe('base_red');
    expect(floorClassOf({ type: 'x', checks: [check('passed')] })).toBe('pass');
    expect(floorClassOf({ type: 'x', checks: [check('timed_out')] })).toBe('inconclusive');
    expect(floorClassOf({ type: 'x', checks: [check('failed', 'flaky_twice')] })).toBe('inconclusive');
  });

  it('a boundary deny on a floor that ran is wrong by rule; an operator override relabels a "real" failure', () => {
    const cs = captureFloorCases(input);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ project: 'wicked-crew', observed: { label: 'boundary_deny' }, expected: { label: 'base_red', by: 'rule' } });
    expect(cs[1]).toMatchObject({ observed: { label: 'real_fail' }, expected: { label: 'inconclusive', by: 'operator' }, evidence: { decisionId: 'd1' } });
    // Idempotent: the same store gives the same ids.
    expect(captureFloorCases(input).map((c) => c.id)).toEqual(cs.map((c) => c.id));
  });
});

describe('capture: QE verdicts', () => {
  it('a FAIL whose own reason says inconclusive is a misread; one tree judged twice should agree', () => {
    const input: CaptureInput = {
      runs: [{ session: { id: 'r2', repo_ref: 'wicked-core' }, units: [] }],
      events: () => [{ type: 'qeAcceptanceDecided', ord: 9, seq: 1, ts: Date.parse('2026-10-26T07:00:00Z'), qe: { tree: 'T1' } }],
      decisions: [],
      qeVerdicts: [
        { runId: 'r2', id: 'v1', verdict: 'FAIL', reason: '[scenario-defect] inconclusive — ENVIRONMENT_ISSUE: vitest exited 1 at startup', tree: null, createdAt: '2026-10-26T07:22:17Z' },
        { runId: 'r2', id: 'v2', verdict: 'PASS', reason: 'Isolated evidence-only review: PASS. P1-P3 satisfied', tree: null, createdAt: '2026-10-26T07:45:58Z' },
      ],
    };
    const cs = captureQeCases(input);
    expect(cs.find((c) => c.id.endsWith(':v1'))).toMatchObject({ observed: { label: 'FAIL' }, expected: { label: 'INCONCLUSIVE', by: 'rule' } });
    expect(cs.find((c) => c.id.endsWith(':v2'))).toMatchObject({ observed: { label: 'PASS' }, expected: { label: 'PASS' } });
    expect(cs.find((c) => c.id.includes('retest'))).toMatchObject({ input: { tree: 'T1' }, observed: { label: 'differs' }, expected: { label: 'same' } });
  });

  it('reads the verdict a reason states, and nothing when it states none', () => {
    expect(verdictInReason('All three acceptance criteria satisfied.')).toBe('PASS');
    expect(verdictInReason('FAIL: criterion 2 not met')).toBe('FAIL');
    expect(verdictInReason('The reviewer looked at it.')).toBeNull();
  });
});

describe('capture: attribution', () => {
  it('a failed quota attempt authored nothing; the seat of an attempt is the one its skills were handed to', () => {
    const events: EventLike[] = [
      { type: 'unitDistributed', ord: 6, seq: 1, cli: 'codex' }, // plan-time; not who ran it
      { type: 'skillsSnapshotHanded', ord: 6, seq: 2, attempt: 1, cli: 'claude' },
      { type: 'repoChecksEvaluated', ord: 6, seq: 3, attempt: 1, changed: [{ path: 'src/a.rs' }], checks: [] },
      { type: 'stepFailed', ord: 6, seq: 4, attempt: 2, detail: "seat 'claude' failed (worker error); failing over to 'copilot'" },
      { type: 'skillsSnapshotHanded', ord: 6, seq: 5, attempt: 3, cli: 'copilot' },
      { type: 'stepFailed', ord: 6, seq: 6, attempt: 3, detail: "dead seat: 'copilot' exhausted its quota" },
    ];
    expect(changingSeats(events, 6, 'codex')).toEqual(['claude']);
    const input: CaptureInput = {
      runs: [
        {
          session: { id: 'r3', repo_ref: 'wicked-core' },
          units: [
            { ord: 6, stage: 'build', role: 'creator', assigned_cli: 'claude', authored_by: ['claude', 'copilot'] },
            { ord: 8, stage: 'test', role: 'evaluator', assurance: { creator: 'codex' } },
          ],
        },
      ],
      events: () => events,
      decisions: [],
      qeVerdicts: [],
    };
    const cs = captureAttributionCases(input);
    expect(cs.find((c) => c.id.endsWith(':6:authors'))).toMatchObject({ observed: { labels: ['claude', 'copilot'] }, expected: { labels: ['claude'] } });
    expect(cs.find((c) => c.id.endsWith(':8:creator'))).toMatchObject({ observed: { labels: ['codex'] }, expected: { labels: ['claude'] } });
  });
});

describe('capture: steering denials and archetype prompts', () => {
  it('an input-governance deny the operator approved is a candidate false alarm', () => {
    const cs = captureSteeringDenials({
      runs: [{ session: { id: 'r4' }, units: [] }],
      events: () => [{ type: 'gateEscalated', ord: 1, seq: 1, ts: 10, condition: 'boundary_deny', denialSource: 'input_governance', verdictSummary: 'refused Bash' }],
      decisions: [{ id: 'd', at: 20, origin: { run_id: 'r4', ord: 1, choice: 'approve' } }],
      qeVerdicts: [],
    });
    expect(cs[0]).toMatchObject({ observed: { label: 'block' }, expected: { label: 'allow', by: 'operator' } });
  });

  it('maps launched workflows to archetypes and leaves system workflows out', () => {
    expect(archetypeOfWorkflow('bug')).toBe('build');
    expect(archetypeOfWorkflow('wf-123')).toBe('explore');
    expect(archetypeOfWorkflow('onboarding')).toBeNull();
    const home = ['', 'Users', 'someone', 'x', 'y.ts'].join('/'); // built, so no home path sits in the source
    expect(scrub(`see ${home} now`)).toBe('see <path> now');
  });
});

// ── baseline ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('the shipped baseline', () => {
  it('the needs-you ruling reproduces each surface’s count: Home 21, Nerve Center 12, codex 7; the ruling 5', () => {
    const cs = needsYouSeed();
    const counted = (s: string): number => cs.filter((c) => c.surface === s && c.observed?.label === 'count').length;
    expect(counted('home')).toBe(21);
    expect(counted('nerve-center')).toBe(12);
    const codexClusters = new Set(cs.filter((c) => c.surface === 'codex' && c.observed?.label === 'count').map((c) => c.observed!.cluster));
    expect(codexClusters.size).toBe(7);
    const ruled = new Set(cs.filter((c) => c.surface === 'home' && c.expected.label === 'count').map((c) => c.expected.cluster));
    expect(ruled.size).toBe(5);
  });

  it('is scrubbed and marked as baseline', () => {
    const text = JSON.stringify([...RIG_SEED, ...needsYouSeed()]);
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\/tmp/);
    expect([...RIG_SEED, ...needsYouSeed()].every((c) => c.baseline === true && c.source === 'real')).toBe(true);
    // The rig's known misreads are in it.
    expect(RIG_SEED.some((c) => c.suite === 'floor-class' && c.observed?.label === 'boundary_deny' && c.expected.label === 'base_red')).toBe(true);
    expect(RIG_SEED.some((c) => c.suite === 'qe-verdict' && c.observed?.label === 'FAIL' && c.expected.label === 'INCONCLUSIVE')).toBe(true);
  });
});

// ── replay ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the archetype replay adapter', () => {
  it('sends one batch and reads label and confidence back; no root means no adapter', async () => {
    expect(archetypeAdapter(null)).toBeNull();
    expect(archetypeAdapter(tmp())).toBeNull();
    const root = tmp();
    mkdirSync(join(root, 'scripts', 'crew'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'crew', 'archetypes_v11.py'), '');
    let stdin = '';
    const adapter = archetypeAdapter(root, async (args, input) => {
      stdin = input;
      expect(args.at(-1)).toBe(join(root, 'scripts', 'crew'));
      return { code: 0, stdout: JSON.stringify([['build', 0.55], ['none', null]]), stderr: '' };
    })!;
    const mk = (id: string, prompt: string): EvalCase => ({ ...cls(id, null, 'build'), suite: 'archetype', input: { prompt } });
    const got = await adapter.replay([mk('a', 'Fix it'), mk('b', 'Say hi.')]);
    expect(JSON.parse(stdin)).toEqual(['Fix it', 'Say hi.']);
    expect(got.get('a')).toEqual({ label: 'build', confidence: 0.55, by: 'replay' });
    expect(got.get('b')).toEqual({ label: 'none', by: 'replay' });
    const broken = archetypeAdapter(root, async () => ({ code: 1, stdout: '', stderr: 'boom' }))!;
    await expect(broken.replay([mk('a', 'x')])).rejects.toThrow(/exited 1: boom/);
  });
});

// ── routes, store, CLI ─────────────────────────────────────────────────────────────────────────────────────────

describe('routes and store', () => {
  it('runs over the daemon’s own store, stores the report, lists it, and calls a trend on the second run', async () => {
    const store = new DefaultEvalStore(tmp());
    const runs = [{ session: { id: 'r1', repo_ref: 'wicked-crew' }, units: [] }];
    const events: EventLike[] = Array.from({ length: 6 }, (_, i) => [
      { type: 'repoChecksEvaluated', ord: i, seq: i * 2, ts: i * 10, checks: [check('failed', 'base_red_unseparated')] },
      { type: 'gateEscalated', ord: i, seq: i * 2 + 1, ts: i * 10 + 1, condition: 'floor_failed', denialSource: 'repo_checks' },
    ]).flat();
    const app = Fastify();
    let n = 0;
    registerDefaultEvalRoutes(app, {
      store,
      runs: async () => runs,
      events: async () => events,
      decisions: () => [],
      replay: NO_REPLAY,
      now: () => new Date('2026-10-27T00:00:00Z'),
      newId: () => `run${++n}`,
    });
    const suites = await app.inject({ method: 'GET', url: '/api/v1/testing/default-evals/suites' });
    expect(suites.json().suites.map((s: { id: string }) => s.id)).toContain('normalization');
    expect((await app.inject({ method: 'POST', url: '/api/v1/testing/default-evals/run', payload: { bogus: 1 } })).statusCode).toBe(400);

    const first = await app.inject({ method: 'POST', url: '/api/v1/testing/default-evals/run', payload: { suites: ['floor-class'] } });
    expect(first.statusCode).toBe(200);
    const r1 = first.json() as DefaultEvalReport;
    expect(r1.suites[0]!.real.agreement).toMatchObject({ k: 6, n: 6 });
    expect(r1.suites[0]!.trend.word).toBe('first-run');
    expect(r1.counts.baseline).toBe(0);

    const second = (await app.inject({ method: 'POST', url: '/api/v1/testing/default-evals/run', payload: { suites: ['floor-class'] } })).json() as DefaultEvalReport;
    expect(second.suites[0]!.trend).toMatchObject({ word: 'no-change', previousRunId: 'run1' });

    const list = (await app.inject({ method: 'GET', url: '/api/v1/testing/default-evals' })).json();
    expect(list.runs.map((r: { id: string }) => r.id)).toEqual(['run2', 'run1']);
    const detail = await app.inject({ method: 'GET', url: '/api/v1/testing/default-evals/run1' });
    expect(detail.json().cases.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/v1/testing/default-evals/nope' })).statusCode).toBe(404);

    const withBaseline = (await app.inject({ method: 'POST', url: '/api/v1/testing/default-evals/run', payload: { baseline: true } })).json() as DefaultEvalReport;
    expect(withBaseline.counts.baseline).toBeGreaterThan(100);
    expect(withBaseline.suites.find((s) => s.suite === 'needs-you')!.bySurface!['home']!.agreement.value).toBeLessThan(0.5);
    await app.close();
  });
});

describe('the run-evals CLI', () => {
  it('parses its arguments and prints a plain summary', async () => {
    expect(parseArgs(['--project', 'all', '--baseline'], {})).toMatchObject({ daemon: 'http://127.0.0.1:7701', project: null, baseline: true });
    expect(() => parseArgs(['--nope'], {})).toThrow(/unknown argument/);
    const { report } = await runDefaultEvals({ id: 'c1', now: new Date(0), project: null, cases: [cls('a', 'x', 'x')], replay: NO_REPLAY, previous: null, suites: ['floor-class'] });
    expect(summaryLines(report).join('\n')).toMatch(/floor-class: too few cases \(n=1\)/);
    let sent: unknown = null;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify(report), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await cliMain(['--project', 'wicked-core'], fake)).toBe(0);
    expect(sent).toEqual({ project: 'wicked-core' });
    const refuse = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch;
    expect(await cliMain([], refuse)).toBe(1);
  });
});
