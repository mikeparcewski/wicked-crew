// S17 — cross-release comparability, OFFLINE and deterministic (docs/testing/evals-test-plan.md).
//
// Two EvalRunDetails RECORDED through the real EvalRunStore (record → get, so the fixtures are the
// persisted shape, not hand-typed objects) over the same corpus name, judged by two rule stores
// (release N vs N+1). `compareEvalRuns` must: diff `results[].sample.id → verdict`; classify every
// flip by the S17 table (gap→caught and false_positive→caught permitted; caught→gap and
// caught→false_positive flagged; anything a kind cannot take flagged as inconsistent); report ids
// present on one side only and ids whose kind changed (the corpus changed under the name); reconcile
// the two stored summaries to the per-sample accounting; and diff `rule_coverage` when both carry
// it — never fabricating a delta from one side.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunStore, type RecordEvalRunInput } from '../src/api/eval-store.js';
import { classifyFlip, compareEvalRuns } from '../src/api/eval-compare.js';
import { removeScratch } from './setup/scratch.js';
import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSummary, SteeringType } from '../src/core/types.js';

let dir: string;
let store: EvalRunStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-compare-'));
  clock = 1_757_400_000;
  store = new EvalRunStore(dir, () => undefined, () => clock++, () => `run-${clock}`);
});
afterEach(() => {
  removeScratch(dir);
});

/** The pinned internal corpus name (plan §3 convention) — the SAME on both sides of a series. */
const CORPUS = 'evals:wicked-internal@aaf2dd56367978ec';

/** One result row. `nearest_rules` rides gaps only (evals.rs `SampleResult`). */
function row(
  id: string,
  kind: 'good' | 'bad',
  steering_type: SteeringType,
  verdict: GovernanceEvalResult['verdict'],
  fired: string[] = [],
): GovernanceEvalResult {
  const r: GovernanceEvalResult = {
    sample: { id, description: `sample ${id}`, kind, steering_type },
    expected: kind === 'bad' ? 'deny' : 'allow',
    fired,
    verdict,
  };
  if (verdict === 'gap') r.nearest_rules = [];
  return r;
}

/** The summary a results array implies (the engine computes it the same way). */
function tally(results: GovernanceEvalResult[]): GovernanceEvalSummary {
  return {
    total: results.length,
    caught: results.filter((r) => r.verdict === 'caught').length,
    gaps: results.filter((r) => r.verdict === 'gap').length,
    false_positives: results.filter((r) => r.verdict === 'false_positive').length,
  };
}

/** Record a run and read it back — the fixture IS the persisted drilldown. */
async function recorded(over: Partial<RecordEvalRunInput> & { results: GovernanceEvalResult[] }): Promise<EvalRunDetail> {
  const { id } = await store.record({
    actor: 'evals-compare-test',
    corpus: CORPUS,
    type_filter: null,
    rule_store: '/tmp/release-n/core.db',
    summary: tally(over.results),
    per_type: {},
    degraded: null,
    ...over,
  });
  const detail = await store.get(id);
  expect(detail).not.toBeNull();
  return detail!;
}

// Sample ids in the corpus's `<repo>@<sha12>` shape.
const CREW_A = 'wicked-crew@0392c36eca6b';
const ESTATE_A = 'wicked-estate@1771e5f36461';
const GARDEN_A = 'wicked-garden@fe5e38f9cc9a';
const INTERACTIVE_A = 'wicked-interactive@10b774f2811a';
const STUDIO_A = 'wicked-studio@811690f6e571';
const CREW_B = 'wicked-crew@7f363c9c02d5';
const ESTATE_B = 'wicked-estate@bf6cebf5829d';
const GARDEN_B = 'wicked-garden@452d3c557567';

/** Release N: an effect-less-leaning store — most bad samples gap. */
const RELEASE_N: GovernanceEvalResult[] = [
  row(CREW_A, 'bad', 'development', 'gap'), // → caught in N+1: permitted
  row(ESTATE_A, 'bad', 'architecture', 'caught', ['POL-1301']), // → gap in N+1: flagged
  row(GARDEN_A, 'good', 'development', 'caught'), // → false_positive in N+1: flagged
  row(INTERACTIVE_A, 'good', 'testing', 'false_positive', ['PAT-014']), // → caught in N+1: permitted
  row(STUDIO_A, 'bad', 'design-ux', 'gap'), // unchanged
  row(CREW_B, 'good', 'operations', 'caught'), // same verdict, kind flips to bad in N+1
  row(ESTATE_B, 'bad', 'security', 'caught', ['POL-007']), // only in N
];

/** Release N+1: a tightened store — and a corpus that drifted under the same name. */
const RELEASE_N1: GovernanceEvalResult[] = [
  row(CREW_A, 'bad', 'development', 'caught', ['POL-1301']),
  row(ESTATE_A, 'bad', 'architecture', 'gap'),
  row(GARDEN_A, 'good', 'development', 'false_positive', ['POL-1301']),
  row(INTERACTIVE_A, 'good', 'testing', 'caught'),
  row(STUDIO_A, 'bad', 'design-ux', 'gap'),
  row(CREW_B, 'bad', 'operations', 'caught', ['POL-007']),
  row(GARDEN_B, 'good', 'development', 'caught'), // only in N+1
];

describe('compareEvalRuns — S17 over two recorded EvalRunDetails', () => {
  it('diffs per-sample verdicts, classifies every flip, reports one-sided ids + kind changes, and reconciles the summaries', async () => {
    const a = await recorded({
      results: RELEASE_N,
      degraded: 'facet-only',
      rule_coverage: {
        exercised: 2,
        unexercised: [
          { rule_id: 'PAT-9', steering_type: 'architecture' },
          { rule_id: 'POL-1801', steering_type: 'development' },
        ],
      },
    });
    const b = await recorded({
      results: RELEASE_N1,
      rule_store: '/tmp/release-n+1/core.db',
      rule_coverage: {
        exercised: 3,
        unexercised: [
          { rule_id: 'POL-1801', steering_type: 'development' },
          { rule_id: 'POL-2000', steering_type: 'security' },
        ],
      },
    });
    const c = compareEvalRuns(a, b);

    expect(c.a).toBe(a.id);
    expect(c.b).toBe(b.id);
    // The identities the records carry, side by side.
    expect(c.identity.corpus).toEqual({ a: CORPUS, b: CORPUS, same: true });
    expect(c.identity.rule_store).toEqual({ a: '/tmp/release-n/core.db', b: '/tmp/release-n+1/core.db', same: false });
    expect(c.identity.degraded).toEqual({ a: 'facet-only', b: null, same: false });
    expect(c.identity.type_filter).toEqual({ a: null, b: null, same: true });

    // Flips: codepoint-sorted by id, each classified by the S17 table.
    expect(c.flips).toEqual([
      { sample_id: CREW_A, kind: 'bad', from: 'gap', to: 'caught', classification: 'permitted', reason: 'a rule tightened: a bad behavior is now caught' },
      { sample_id: ESTATE_A, kind: 'bad', from: 'caught', to: 'gap', classification: 'flagged', reason: 'regression: a bad behavior is no longer caught' },
      { sample_id: GARDEN_A, kind: 'good', from: 'caught', to: 'false_positive', classification: 'flagged', reason: 'a good sample is newly denied' },
      { sample_id: INTERACTIVE_A, kind: 'good', from: 'false_positive', to: 'caught', classification: 'permitted', reason: 'a good sample is no longer denied' },
    ]);
    expect(c.unchanged).toBe(1); // STUDIO_A — CREW_B kept its verdict but not its kind
    expect(c.only_in_a).toEqual([ESTATE_B]);
    expect(c.only_in_b).toEqual([GARDEN_B]);
    expect(c.kind_changed).toEqual([CREW_B]);
    // The corpus changed under the name ⇒ NOT comparable release over release, even though the
    // corpus name matches on both sides.
    expect(c.comparable).toBe(false);

    // Summaries: both stores hold 4/2/1 of 7, so every delta is 0 — and the per-sample accounting
    // (+2 to caught, −2 from caught, +1 caught only-in-B, −1 caught only-in-A; ±1 gaps; ±1 fps)
    // reconciles to exactly that.
    expect(a.summary).toEqual({ total: 7, caught: 4, gaps: 2, false_positives: 1 });
    expect(b.summary).toEqual({ total: 7, caught: 4, gaps: 2, false_positives: 1 });
    expect(c.summary_delta).toEqual({ total: 0, caught: 0, gaps: 0, false_positives: 0 });
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);

    // Coverage: PAT-9 gained exercise, POL-2000 lost it, POL-1801 still unexercised on both sides.
    expect(c.rule_coverage_delta).toEqual({ exercised_delta: 1, gained: ['PAT-9'], lost: ['POL-2000'] });
  });

  it('a comparable pair (same corpus, same ids, same kinds) with a non-zero delta reconciles to its flips', async () => {
    const baseline = [row(CREW_A, 'bad', 'development', 'gap'), row(ESTATE_A, 'bad', 'architecture', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')];
    const tightened = [
      row(CREW_A, 'bad', 'development', 'caught', ['POL-1301']),
      row(ESTATE_A, 'bad', 'architecture', 'caught', ['POL-1301']),
      row(GARDEN_A, 'good', 'development', 'false_positive', ['POL-1301']),
    ];
    const c = compareEvalRuns(await recorded({ results: baseline }), await recorded({ results: tightened }));
    expect(c.comparable).toBe(true);
    expect(c.only_in_a).toEqual([]);
    expect(c.only_in_b).toEqual([]);
    expect(c.kind_changed).toEqual([]);
    expect(c.flips.map((f) => [f.sample_id, f.classification])).toEqual([
      [CREW_A, 'permitted'],
      [ESTATE_A, 'permitted'],
      [GARDEN_A, 'flagged'],
    ]);
    expect(c.summary_delta).toEqual({ total: 0, caught: 1, gaps: -2, false_positives: 1 });
    expect(c.reconciles).toBe(true);
    // Neither record measured coverage ⇒ no delta is invented.
    expect('rule_coverage_delta' in c).toBe(false);
  });

  it('identical runs: no flips, everything unchanged, zero delta, comparable', async () => {
    const a = await recorded({ results: RELEASE_N });
    const b = await recorded({ results: RELEASE_N });
    const c = compareEvalRuns(a, b);
    expect(c.flips).toEqual([]);
    expect(c.unchanged).toBe(RELEASE_N.length);
    expect(c.comparable).toBe(true);
    expect(c.summary_delta).toEqual({ total: 0, caught: 0, gaps: 0, false_positives: 0 });
    expect(c.reconciles).toBe(true);
  });

  it('a stored summary that disagrees with its own results is a reconciliation error naming the run, never a flip', async () => {
    const a = await recorded({ results: RELEASE_N });
    // Tamper the persisted rollup of B: the results say 4 caught, the summary claims 5.
    const b = await recorded({ results: RELEASE_N, summary: { total: 7, caught: 5, gaps: 1, false_positives: 1 } });
    const c = compareEvalRuns(a, b);
    expect(c.flips).toEqual([]);
    expect(c.reconciles).toBe(false);
    expect(c.reconciliation_errors).toHaveLength(2);
    expect(c.reconciliation_errors[0]).toMatch(new RegExp(`^run b \\(${b.id}\\): stored summary \\{total 7, caught 5, gaps 1, false_positives 1\\} does not match its own results \\{total 7, caught 4, gaps 2, false_positives 1\\}$`));
    expect(c.reconciliation_errors[1]).toMatch(/^summary delta \{total 0, caught 1, gaps -1, false_positives 0\} does not reconcile to the per-sample accounting \{total 0, caught 0, gaps 0, false_positives 0\}$/);
  });

  it('a different corpus name is not comparable even when the sample sets agree; coverage on ONE side yields no delta', async () => {
    const a = await recorded({ results: RELEASE_N, rule_coverage: { exercised: 1, unexercised: [] } });
    const b = await recorded({ results: RELEASE_N, corpus: 'evals:wicked-internal@0000000000000000' });
    const c = compareEvalRuns(a, b);
    expect(c.identity.corpus.same).toBe(false);
    expect(c.comparable).toBe(false);
    expect(c.flips).toEqual([]);
    expect(c.rule_coverage_delta).toBeUndefined();
  });

  it('a duplicate sample id inside one recorded run is a reconciliation error (the engine rejects duplicates at import)', async () => {
    const dup = [...RELEASE_N, row(CREW_A, 'bad', 'development', 'caught', ['POL-1301'])];
    const a = await recorded({ results: RELEASE_N });
    const b = await recorded({ results: dup });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(false);
    expect(c.reconciliation_errors.some((e) => e.includes(`duplicate sample id ${CREW_A}`))).toBe(true);
  });
});

describe('classifyFlip — the S17 rule table', () => {
  it('permits the two tightening directions and flags the two regressions', () => {
    expect(classifyFlip('bad', 'gap', 'caught').classification).toBe('permitted');
    expect(classifyFlip('good', 'false_positive', 'caught').classification).toBe('permitted');
    expect(classifyFlip('bad', 'caught', 'gap').classification).toBe('flagged');
    expect(classifyFlip('good', 'caught', 'false_positive').classification).toBe('flagged');
  });

  it('flags any pair a kind cannot take as inconsistent (a bad sample is never false_positive; a good one never gaps)', () => {
    for (const [kind, from, to] of [
      ['bad', 'gap', 'false_positive'],
      ['bad', 'false_positive', 'caught'],
      ['good', 'caught', 'gap'],
      ['good', 'gap', 'caught'],
    ] as const) {
      const verdict = classifyFlip(kind, from, to);
      expect(verdict.classification, `${kind} ${from}→${to}`).toBe('flagged');
      expect(verdict.reason).toMatch(/^inconsistent: /);
    }
  });
});
