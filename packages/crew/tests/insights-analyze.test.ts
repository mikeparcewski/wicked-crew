/**
 * DES-RUNS-REVIEW-001 §4-§5: the run review's numbers, on a fixture run store. A real shift is flagged; noise at
 * small n is not; improvements are reported; recommendations are ranked by impact, capped at five, the rest watched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RECOMMENDATIONS, analyze, type Snapshot } from '../src/insights/analyze.js';
import { FACTS_FILE, SNAPSHOT_FILE, runAnalyze, runDirFrom } from '../src/insights/analyze-cli.js';
import { runFactOf, type LooseEvent, type RunFact } from '../src/insights/run-facts.js';
import { MIN_SAMPLE, bootstrapMedianCI, compare, wilson } from '../src/insights/stats.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});

const H = 3_600_000;
const NOW = Date.parse('2026-10-27T00:00:00Z');
const LEN = 48 * H;
const WINDOW = { startMs: NOW - LEN, endMs: NOW };
const BASELINES = [1, 2, 3, 4].map((i) => ({ startMs: NOW - (i + 1) * LEN, endMs: NOW - i * LEN }));

let seq = 0;
/** One fixture run. `at` = hours before NOW. */
function run(at: number, over: Partial<RunFact> = {}): RunFact {
  seq += 1;
  const createdAtMs = NOW - at * H;
  return {
    id: `run-${seq}`,
    title: `fixture run ${seq}`,
    workflow: 'bug',
    repo: 'core',
    projectId: null,
    agents: ['claude'],
    createdAtMs,
    endedAtMs: createdAtMs + H,
    status: 'completed',
    outcome: 'passed',
    deliverRequested: true,
    delivered: true,
    archived: false,
    timeToPrMs: 60 * 60_000,
    floorMs: 10 * 60_000,
    waitHumanMs: 5 * 60_000,
    overrides: [],
    spendUsd: 2,
    spendReported: true,
    tokens: 1000,
    retries: 0,
    stalls: 0,
    benched: [],
    failureSignature: null,
    unresolved: false,
    ...over,
  };
}
const failed = (at: number, over: Partial<RunFact> = {}): RunFact =>
  run(at, { status: 'failed', outcome: 'failed', delivered: false, timeToPrMs: null, failureSignature: 'floor_failed (repo_checks)', unresolved: false, ...over });

function snapshot(runs: RunFact[]): Snapshot {
  return { version: 1, generatedAtMs: NOW, window: WINDOW, baselineWindows: BASELINES, projectIds: [], runs };
}
const cell = (facts: ReturnType<typeof analyze>, metric: string, segment = 'all') =>
  facts.metrics.find((m) => m.metric === metric && m.segment === segment);
/** n runs spread over the baseline windows. */
const baseline = (n: number, make: (at: number) => RunFact): RunFact[] => Array.from({ length: n }, (_, i) => make(50 + (i * 140) / n));
/** n runs spread over the review window. */
const recent = (n: number, make: (at: number) => RunFact): RunFact[] => Array.from({ length: n }, (_, i) => make(1 + (i * 46) / n));

describe('the statistics', () => {
  it('Wilson matches the textbook interval and stays inside [0, 1]', () => {
    const i = wilson(8, 10) as { lo: number; hi: number };
    expect(i.lo).toBeCloseTo(0.4902, 3);
    expect(i.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 3)?.lo).toBe(0);
    expect(wilson(3, 3)?.hi).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
  it('the bootstrap of the median is deterministic for a seed and brackets the median', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    expect(bootstrapMedianCI(xs, 7)).toEqual(bootstrapMedianCI(xs, 7));
    const ci = bootstrapMedianCI(xs, 7) as { lo: number; hi: number };
    expect(ci.lo).toBeLessThanOrEqual(4);
    expect(ci.hi).toBeGreaterThanOrEqual(4);
  });
  it('below the minimum sample no trend is called', () => {
    expect(compare(MIN_SAMPLE - 1, { lo: 0.9, hi: 1 }, 50, 0.2, true)).toBe('too-few');
    expect(compare(50, { lo: 0.9, hi: 1 }, MIN_SAMPLE - 1, 0.2, true)).toBe('too-few');
    expect(compare(50, { lo: 0.9, hi: 1 }, 50, 0.2, true)).toBe('improved');
    expect(compare(50, { lo: 0.1, hi: 0.3 }, 50, 0.2, true)).toBe('no-change');
  });
});

describe('the analysis on a fixture run store', () => {
  it('flags a real shift: the pass rate fell from 90% to 40% on 20 runs each', () => {
    const runs = [
      ...baseline(20, (at) => (at < 60 ? failed(at) : run(at))), // 2 of 20 failed
      ...recent(20, (at) => (at < 28 ? failed(at) : run(at))), // 12 of 20 failed
    ];
    const facts = analyze(snapshot(runs));
    const pass = cell(facts, 'pass_rate');
    expect(pass?.window.n).toBe(20);
    expect(pass?.baseline.n).toBe(20);
    expect(pass?.verdict).toBe('regressed');
    expect(facts.regressions.some((r) => r.metric === 'pass_rate' && r.segment === 'all')).toBe(true);
    // The finding names its n and interval: a number with its uncertainty, never alone.
    const line = facts.regressions.find((r) => r.metric === 'pass_rate' && r.segment === 'all')?.line ?? '';
    expect(line).toMatch(/n=20/u);
    expect(line).toMatch(/95% CI/u);
  });

  it('does not call noise at small n a trend: 1 of 3 recent runs failing is "too few runs to tell"', () => {
    const runs = [...baseline(20, (at) => run(at)), failed(10), run(20), run(30)];
    const facts = analyze(snapshot(runs));
    expect(cell(facts, 'pass_rate')?.verdict).toBe('too-few');
    expect(facts.regressions).toEqual([]);
    expect(facts.candidates.filter((c) => c.basis === 'notable')).toEqual([]);
  });

  it('does not flag a change whose interval still contains the baseline', () => {
    // 90% → 80% on 10 runs: Wilson [0.49, 0.94] contains 0.9.
    const runs = [...baseline(20, (at) => (at < 58 ? failed(at) : run(at))), ...recent(10, (at) => (at < 10 ? failed(at) : run(at)))];
    const facts = analyze(snapshot(runs));
    expect(cell(facts, 'pass_rate')?.verdict).toBe('no-change');
  });

  it('reports what improved and what is working, not only problems', () => {
    // Spend per run fell from $8 to $2 (medians, long tail kept), and every run passes.
    const runs = [
      ...baseline(20, (at) => run(at, { spendUsd: at % 3 === 0 ? 30 : 8 })),
      ...recent(20, (at) => run(at, { spendUsd: at < 3 ? 25 : 2 })),
    ];
    const facts = analyze(snapshot(runs));
    expect(cell(facts, 'spend')?.verdict).toBe('improved');
    expect(cell(facts, 'spend')?.window.value).toBe(2);
    expect(facts.improvements.some((f) => f.metric === 'spend' && f.segment === 'all')).toBe(true);
    expect(facts.improvements.some((f) => f.line.startsWith('Working well: all runs passed 100%'))).toBe(true);
    expect(facts.regressions).toEqual([]);
  });

  it('turns a single cause behind several runs into a recommendation, ranks by impact and caps at five', () => {
    const runs: RunFact[] = [
      ...baseline(20, (at) => run(at)),
      // 6 unresolved failures (resolve-stale), each overriding a red floor on core (an issue), and copilot benched.
      ...recent(6, (at) => failed(at, { unresolved: true, overrides: [{ ord: 5, condition: 'floor_failed', source: 'repo_checks' }], benched: [{ cli: 'copilot', reason: 'quota_exhausted (no success)' }] })),
      // 4 runs on garden where a "scope_drift" escalation was overridden (a steering rule).
      ...recent(4, (at) => run(at, { repo: 'garden', overrides: [{ ord: 3, condition: 'scope_drift', source: null }], benched: [{ cli: 'copilot', reason: 'quota_exhausted' }] })),
      // judge_unavailable overridden on 3 more (a setting), and pi signed out on 3 (a setting).
      ...recent(3, (at) => run(at, { repo: 'web', overrides: [{ ord: 6, condition: 'judge_unavailable', source: 'judge_unavailable' }], benched: [{ cli: 'pi', reason: 'not_logged_in' }] })),
    ];
    const facts = analyze(snapshot(runs));
    const ids = facts.candidates.map((c) => c.id);
    expect(ids).toContain('resolve-stale');
    expect(ids).toContain('issue-floor-core');
    expect(ids).toContain('steering-override-garden-scope-drift');
    expect(ids).toContain('setting-judge-web');
    expect(ids).toContain('setting-bench-copilot-quota-exhausted');
    expect(ids).toContain('setting-bench-pi-not-logged-in');
    // Ranked by impact, highest first; at most five recommended; the rest watched.
    const impacts = facts.candidates.map((c) => c.impact);
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts);
    expect(facts.recommended.length).toBe(MAX_RECOMMENDATIONS);
    expect(facts.recommended).toEqual(ids.slice(0, MAX_RECOMMENDATIONS));
    expect(facts.watching).toEqual(ids.slice(MAX_RECOMMENDATIONS));
    // Each carries its evidence (run ids and n), its expected effect, a confidence and what would change our mind.
    const stale = facts.candidates.find((c) => c.id === 'resolve-stale');
    expect(stale?.evidence.n).toBe(6);
    expect(stale?.evidence.runs).toHaveLength(6);
    expect(stale?.action.runs).toHaveLength(6);
    for (const c of facts.candidates) {
      expect(c.expectedEffect).not.toBe('');
      expect(c.changeMind).not.toBe('');
      expect(['high', 'medium', 'low']).toContain(c.confidence);
    }
    expect(facts.candidates.find((c) => c.id === 'steering-override-garden-scope-drift')?.action.proposal?.kindType).toBe('policy:operations');
  });

  it('makes one recommendation per regressed metric (the broadest segment), and never counts a Tool unit as an agent', () => {
    const runs = [
      ...baseline(20, (at) => run(at, { agents: ['claude'], waitHumanMs: 60_000 })),
      ...recent(20, (at) => run(at, { agents: ['claude'], waitHumanMs: 6 * 3_600_000 })),
    ];
    const facts = analyze(snapshot(runs));
    expect(facts.regressions.filter((r) => r.metric === 'wait_on_people').length).toBeGreaterThan(0);
    expect(facts.candidates.filter((c) => c.evidence.metric === 'wait_on_people').map((c) => c.evidence.segment)).toEqual(['all']);
    const view = { session: { id: 't', status: 'completed', created_at: 1, archived_at: null }, units: [{ assigned_cli: 'bash', routing: { method: 'tool' } }, { assigned_cli: 'codex', routing: { method: 'teamed' } }] };
    expect(runFactOf(view as never, [], NOW).agents).toEqual(['codex']);
  });

  it('never makes a pattern recommendation from fewer than three runs', () => {
    const runs = [...baseline(20, (at) => run(at)), ...recent(2, (at) => failed(at, { unresolved: true }))];
    expect(analyze(snapshot(runs)).candidates).toEqual([]);
  });

  it('is deterministic: the same snapshot gives byte-identical facts', () => {
    const runs = [...baseline(12, (at) => run(at, { spendUsd: at / 10 })), ...recent(9, (at) => run(at, { spendUsd: at / 3 }))];
    expect(JSON.stringify(analyze(snapshot(runs)))).toBe(JSON.stringify(analyze(snapshot(runs))));
  });
});

describe('the analyze Tool step', () => {
  it('finds its run directory by WICKED_RUN_ID, refuses a path-like id, and writes facts.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-analyze-'));
    dirs.push(root);
    expect(() => runDirFrom(['--reviews-dir', root], { WICKED_RUN_ID: '../etc' })).toThrow(/not a run id/u);
    const dir = runDirFrom(['--reviews-dir', root], { WICKED_RUN_ID: 'abc-123' });
    expect(dir).toBe(join(root, 'abc-123'));
    expect(() => runAnalyze(dir)).toThrow(/no snapshot\.json/u);
    const runDir = join(root, 'abc-123');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, SNAPSHOT_FILE), JSON.stringify(snapshot([...baseline(6, (at) => run(at)), ...recent(6, (at) => run(at))])));
    const facts = runAnalyze(runDir);
    expect(JSON.parse(readFileSync(join(runDir, FACTS_FILE), 'utf8'))).toEqual(JSON.parse(JSON.stringify(facts)));
  });
});

describe('a run folded into its facts', () => {
  it('counts overrides, waits on people, the floor, spend and retries from the events', () => {
    const t = NOW - 10 * H;
    const view = {
      session: { id: 'r1', status: 'completed', created_at: Math.floor(t / 1000), deliver_requested: true, delivery: 'delivered', archived_at: null, workflow_id: 'bug', repo_ref: 'core', title: 'Fix it', project_id: null },
      units: [{ assigned_cli: 'claude' }, { assigned_cli: 'codex' }, { assigned_cli: null }],
    };
    const events: LooseEvent[] = [
      { type: 'cliUsage', ts: t + 1000, ord: 1, costUsd: 0.5, inputTokens: 100, outputTokens: 10 },
      { type: 'awaitingHuman', ts: t + 2000, ord: 2 },
      { type: 'gateDecided', ts: t + 62_000, ord: 2, allow: true },
      { type: 'repoChecksEvaluated', ts: t + 70_000, ord: 5, checks: [{ durationMs: 30_000 }, { durationMs: 15_000 }] },
      { type: 'gateDecided', ts: t + 80_000, ord: 5, allow: false },
      { type: 'gateEscalated', ts: t + 80_000, ord: 5, condition: 'floor_failed', denialSource: 'repo_checks' },
      { type: 'gateDecided', ts: t + 200_000, ord: 5, allow: true },
      { type: 'unitReassigned', ts: t + 210_000, ord: 6 },
      { type: 'stepFailed', ts: t + 220_000, ord: 6, failureKind: 'workerError' },
      { type: 'seatBenched', ts: t + 220_000, ord: 6, cli: 'copilot', reason: 'quota_exhausted' },
      { type: 'cliUsage', ts: t + 230_000, ord: 6, costUsd: 0.25, inputTokens: 50, outputTokens: 5 },
      { type: 'sessionCompleted', ts: t + 300_000 },
    ];
    const f = runFactOf(view as never, events, NOW);
    expect(f.outcome).toBe('passed');
    expect(f.agents).toEqual(['claude', 'codex']);
    expect(f.overrides).toEqual([{ ord: 5, condition: 'floor_failed', source: 'repo_checks' }]);
    expect(f.waitHumanMs).toBe(60_000 + 120_000);
    expect(f.floorMs).toBe(45_000);
    expect(f.spendUsd).toBeCloseTo(0.75);
    expect(f.tokens).toBe(165);
    expect(f.retries).toBe(2);
    expect(f.benched).toEqual([{ cli: 'copilot', reason: 'quota_exhausted' }]);
    expect(f.timeToPrMs).toBe(300_000 + (t % 1000));
    expect(f.unresolved).toBe(false);
  });

  it('a failure nobody archived, and a run open over a day, are unresolved; an archived one is not', () => {
    const base = { deliver_requested: false, delivery: 'none', workflow_id: 'bug', repo_ref: 'core', title: 'x', project_id: null };
    const old = Math.floor((NOW - 30 * H) / 1000);
    const at = (status: string, archived: number | null) => runFactOf({ session: { id: status, status, created_at: old, archived_at: archived, ...base }, units: [] } as never, [], NOW);
    expect(at('failed', null).unresolved).toBe(true);
    expect(at('failed', NOW).unresolved).toBe(false);
    expect(at('awaiting_human', null).unresolved).toBe(true);
    expect(at('cancelled', null).unresolved).toBe(false);
    expect(at('completed', null).outcome).toBe('passed');
  });
});
