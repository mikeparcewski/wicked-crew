// S17 — cross-release comparability, OFFLINE and deterministic (docs/testing/evals-test-plan.md).
//
// Two EvalRunDetails RECORDED through the real EvalRunStore (record → get, so the fixtures are the
// persisted shape, not hand-typed objects) over the same corpus name, judged by two rule stores
// (release N vs N+1). `compareEvalRuns` must: diff `results[].sample.id → verdict`; classify every
// flip by the S17 table (gap→caught and false_positive→caught permitted; caught→gap and
// caught→false_positive flagged; anything a kind cannot take flagged as inconsistent); report ids
// present on one side only, ids whose kind changed and ids whose PAYLOAD identity changed (the
// corpus changed under the name); treat a row without a `sample.payload_hash` as UNVERIFIED (never
// comparable, never "different"); reconcile the two stored summaries to the per-sample accounting;
// and diff `rule_coverage` when both carry it over what the records ENUMERATE (codex rounds 6 and
// 8): `exercised` is a COUNT of every rule any claim fired, blocking or not, while `results[].fired`
// is the blocking subset — so a record names only `unexercised ∪ fired`, and NO field of the wire
// lists its rule set. `gained`/`lost` are asserted from listed ids on both ends (always sound);
// `added_rules`/`removed_rules` NEVER (they need an explicit inventory on both records, which no
// daemon-recorded run carries): every one-sided id is WITHHELD by name (`inventory: 'partial'`,
// `transitions_withheld`) — round 8 deleted round 6's `exercised === |fired|` ⇒ complete inference,
// which under a type filter typed a fired id into the slice through the OTHER run's row and reported
// a present, exercised rule as removed; `unidentified` is per record (unfiltered `exercised −
// |fired|`, filtered the whole `exercised`). A count above the fired ids is valid warn-only exercise,
// never a reconciliation error; a delta is never fabricated from one side; a malformed persisted
// coverage (`per_type: null`) is `unverified (malformed rule_coverage)` on that side, never a throw.
// Type filters (codex round 7): the engine's `--type` slices the samples and the coverage
// DENOMINATOR but not the gate (evals.rs `run_evals` 974-977 / `decide_lane_rules` 816-844 vs
// `evaluate_sample` 901), so a filtered run's rows may fire rules OUTSIDE the denominator — `fired:
// ['SECURITY-DENY']` beside `exercised: 0` is a valid development-filtered record. Its coverage is
// reconciled against the engine's own `per_type[<filter>]` row (`'per_type'`), or not at all when
// the record has none (`'n/a …'`); the fired-based denominator check runs only unfiltered (`'rows'`);
// two runs under different filters are not comparable and get no coverage delta.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunStore, type RecordEvalRunInput } from '../src/api/eval-store.js';
import { classifyFlip, compareEvalRuns, DIFFERING_TYPE_FILTER, MALFORMED_RESULT_ROWS, MALFORMED_RULE_COVERAGE, UNVERIFIED_NO_SAMPLE_IDENTITY, type EvalRuleCoverageDelta } from '../src/api/eval-compare.js';
import { PAYLOAD_HASH_RE, samplePayloadHash } from '../src/api/eval-sample.js';
import { removeScratch } from './setup/scratch.js';
import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalRuleCoverage, GovernanceEvalSignals, GovernanceEvalSummary, GovernanceEvalTypeCoverage, SteeringType } from '../src/core/types.js';

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

/** The signals every fixture sample carries unless a test varies them — part of the payload identity. */
const SIGNALS: GovernanceEvalSignals = { files: ['src/index.ts'], content: 'feat: fixture' };

interface RowOptions {
  /** The sample's description (defaults to `sample <id>`) — part of the payload identity. */
  description?: string;
  /** The sample's signals — part of the payload identity (the engine never echoes them; the
   *  PRODUCER hashes them into `payload_hash`). */
  signals?: GovernanceEvalSignals;
  /** `false` ⇒ the row carries NO payload_hash (what the engine alone emits) — unverified. */
  identity?: boolean;
}

/** One result row, as a producer that held the samples would stamp it (`payload_hash` over the
 *  full payload). `nearest_rules` rides gaps only (evals.rs `SampleResult`). */
function row(
  id: string,
  kind: 'good' | 'bad',
  steering_type: SteeringType,
  verdict: GovernanceEvalResult['verdict'],
  fired: string[] = [],
  opts: RowOptions = {},
): GovernanceEvalResult {
  const description = opts.description ?? `sample ${id}`;
  const signals = opts.signals ?? SIGNALS;
  const r: GovernanceEvalResult = {
    sample: { id, description, kind, steering_type },
    expected: kind === 'bad' ? 'deny' : 'allow',
    fired,
    verdict,
  };
  if (opts.identity !== false) r.sample.payload_hash = samplePayloadHash({ id, description, kind, steering_type, signals });
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

/** A coverage delta with nothing gained, lost or withheld. `inventory` is ALWAYS `partial` and the
 *  rule-set lists ALWAYS empty — the wire carries no rule inventory (codex round 8). */
function delta(over: Partial<EvalRuleCoverageDelta> = {}): EvalRuleCoverageDelta {
  return {
    exercised_delta: 0,
    inventory: 'partial',
    unidentified: { a: 0, b: 0 },
    gained: [],
    lost: [],
    added_rules: [],
    removed_rules: [],
    transitions_withheld: [],
    ...over,
  };
}

/** The reason `compareEvalRuns` gives for withholding a rule-set transition: `id` enumerated by one
 *  side (b for `added_rules`, a for `removed_rules`) as `listedAs` and not by the other, whose
 *  `unidentified` count is `silentUnidentified`; under a type `filter` the other-type possibility is
 *  named too. The codex round-8 test below pins one of these as a literal string. */
function withheld(kind: 'added_rules' | 'removed_rules', id: string, listedAs: 'unexercised' | 'blocking-fired', silentUnidentified: number, filter: SteeringType | null = null): string {
  const [lister, silent] = kind === 'added_rules' ? ['b', 'a'] : ['a', 'b'];
  const maybe: string[] = [];
  if (silentUnidentified > 0) {
    maybe.push(`one of ${silent}'s ${silentUnidentified} exercised rule(s) named nowhere (${filter === null ? 'fired by a non-blocking effect alone' : `under type filter ${filter} no fired id is typed into the slice`})`);
  }
  maybe.push('an effect-less (recall-only) or retired rule outside the eligible partition');
  if (filter !== null) maybe.push(`a rule of another type outside the ${filter} denominator (a row's fired ids carry no steering_type)`);
  return (
    `${kind} ${id}: enumerated by ${lister} (${listedAs}) and not by ${silent} — the wire lists no rule inventory (rule_coverage.exercised and recall_only are counts; only unexercised and blocking-fired ids are named), ` +
    `so ${silent}'s silence is not absence: ${id} may be ${maybe.join(', ')} or a rule the store ${kind === 'added_rules' ? 'gained' : 'lost'}: not asserted`
  );
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

/** Release N: an effect-less-leaning store — most bad samples gap. Distinct fired rules: 3. */
const RELEASE_N: GovernanceEvalResult[] = [
  row(CREW_A, 'bad', 'development', 'gap'), // → caught in N+1: permitted
  row(ESTATE_A, 'bad', 'architecture', 'caught', ['POL-1301']), // → gap in N+1: flagged
  row(GARDEN_A, 'good', 'development', 'caught'), // → false_positive in N+1: flagged
  row(INTERACTIVE_A, 'good', 'testing', 'false_positive', ['PAT-014']), // → caught in N+1: permitted
  row(STUDIO_A, 'bad', 'design-ux', 'gap'), // unchanged
  row(CREW_B, 'good', 'operations', 'caught'), // same verdict, kind flips to bad in N+1
  row(ESTATE_B, 'bad', 'security', 'caught', ['POL-007']), // only in N
];

/** Release N+1: a tightened store — and a corpus that drifted under the same name. Distinct fired
 *  rules: 3 (POL-1301, PAT-9, POL-007). */
const RELEASE_N1: GovernanceEvalResult[] = [
  row(CREW_A, 'bad', 'development', 'caught', ['POL-1301', 'PAT-9']),
  row(ESTATE_A, 'bad', 'architecture', 'gap'),
  row(GARDEN_A, 'good', 'development', 'false_positive', ['POL-1301']),
  row(INTERACTIVE_A, 'good', 'testing', 'caught'),
  row(STUDIO_A, 'bad', 'design-ux', 'gap'),
  row(CREW_B, 'bad', 'operations', 'caught', ['POL-007']),
  row(GARDEN_B, 'good', 'development', 'caught'), // only in N+1
];

describe('compareEvalRuns — S17 over two recorded EvalRunDetails', () => {
  it('diffs per-sample verdicts, classifies every flip, reports one-sided ids + kind/payload changes, reconciles the summaries, and separates coverage transitions from rule-set changes', async () => {
    const a = await recorded({
      results: RELEASE_N,
      degraded: 'facet-only',
      rule_coverage: {
        exercised: 3, // POL-1301, PAT-014, POL-007 fired
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
        exercised: 3, // POL-1301, PAT-9, POL-007 fired
        unexercised: [
          { rule_id: 'PAT-014', steering_type: 'testing' },
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
    // A kind change IS a payload change (kind is part of the payload) — reported in both lists.
    expect(c.payload_changed).toEqual([CREW_B]);
    expect(c.unverified_rows).toEqual({ a: 0, b: 0 }); // every row stamped
    // The corpus changed under the name ⇒ NOT comparable release over release, even though the
    // corpus name matches on both sides — and the reason says exactly what changed.
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toBe(
      'sample set differs (1 id(s) only in a, 1 only in b); kind changed for 1 shared sample(s); payload changed for 1 shared sample(s) (description, steering_type or signals)',
    );

    // Summaries: both stores hold 4/2/1 of 7, so every delta is 0 — and the per-sample accounting
    // (+2 to caught, −2 from caught, +1 caught only-in-B, −1 caught only-in-A; ±1 gaps; ±1 fps)
    // reconciles to exactly that.
    expect(a.summary).toEqual({ total: 7, caught: 4, gaps: 2, false_positives: 1 });
    expect(b.summary).toEqual({ total: 7, caught: 4, gaps: 2, false_positives: 1 });
    expect(c.summary_delta).toEqual({ total: 0, caught: 0, gaps: 0, false_positives: 0 });
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    // Unfiltered on both sides: each coverage was reconciled against its rows' blocking-fired ids.
    expect(c.coverage_reconciliation).toEqual({ a: 'rows', b: 'rows' });

    // Coverage. Both sides: exercised 3 = 3 distinct blocking-fired ids ⇒ every exercised rule is
    // named (`unidentified` 0/0) — yet neither record LISTS its rule set, so the inventory is
    // `partial` and no rule-set change is asserted. Enumerated: A = {POL-1301, PAT-014, POL-007} ∪
    // {PAT-9, POL-1801}; B = {POL-1301, PAT-9, POL-007} ∪ {PAT-014, POL-1801, POL-2000}.
    //   PAT-9    unexercised in A, blocking-fired in B  → gained (both ends listed)
    //   PAT-014  blocking-fired in A, unexercised in B  → lost
    //   POL-2000 enumerated by B only                    → NOT lost, NOT added_rules: withheld by name
    //                                                      (it may be recall-only or retired in A)
    //   POL-1801 unexercised on both sides              → nothing
    expect(c.rule_coverage_delta).toEqual({
      exercised_delta: 0,
      inventory: 'partial',
      unidentified: { a: 0, b: 0 },
      gained: ['PAT-9'],
      lost: ['PAT-014'],
      added_rules: [],
      removed_rules: [],
      transitions_withheld: [withheld('added_rules', 'POL-2000', 'unexercised', 0)],
    });
  });

  it('a comparable pair (same corpus, same ids, same kinds, same payload identities) with a non-zero delta reconciles to its flips', async () => {
    const baseline = [row(CREW_A, 'bad', 'development', 'gap'), row(ESTATE_A, 'bad', 'architecture', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')];
    const tightened = [
      row(CREW_A, 'bad', 'development', 'caught', ['POL-1301']),
      row(ESTATE_A, 'bad', 'architecture', 'caught', ['POL-1301']),
      row(GARDEN_A, 'good', 'development', 'false_positive', ['POL-1301']),
    ];
    const c = compareEvalRuns(await recorded({ results: baseline }), await recorded({ results: tightened }));
    expect(c.comparable).toBe(true);
    expect(c.comparable_reason).toBeNull();
    expect(c.only_in_a).toEqual([]);
    expect(c.only_in_b).toEqual([]);
    expect(c.kind_changed).toEqual([]);
    expect(c.payload_changed).toEqual([]);
    expect(c.flips.map((f) => [f.sample_id, f.classification])).toEqual([
      [CREW_A, 'permitted'],
      [ESTATE_A, 'permitted'],
      [GARDEN_A, 'flagged'],
    ]);
    expect(c.summary_delta).toEqual({ total: 0, caught: 1, gaps: -2, false_positives: 1 });
    expect(c.reconciles).toBe(true);
    // Neither record measured coverage ⇒ no delta is invented, and nothing was reconciled.
    expect('rule_coverage_delta' in c).toBe(false);
    expect(c.coverage_reconciliation).toEqual({ a: null, b: null });
  });

  it('identical runs: no flips, everything unchanged, zero delta, comparable', async () => {
    const a = await recorded({ results: RELEASE_N });
    const b = await recorded({ results: RELEASE_N });
    const c = compareEvalRuns(a, b);
    expect(c.flips).toEqual([]);
    expect(c.unchanged).toBe(RELEASE_N.length);
    expect(c.comparable).toBe(true);
    expect(c.comparable_reason).toBeNull();
    expect(c.summary_delta).toEqual({ total: 0, caught: 0, gaps: 0, false_positives: 0 });
    expect(c.reconciles).toBe(true);
  });

  it('a shared sample whose description, steering type or signals changed under the SAME id and kind is payload_changed — not comparable, its flip flagged, never "unchanged"', async () => {
    const a = await recorded({
      results: [row(CREW_A, 'bad', 'development', 'gap'), row(ESTATE_A, 'bad', 'architecture', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')],
    });
    const b = await recorded({
      results: [
        // description changed AND verdict flipped: the flip is flagged with the payload reason, not
        // classified as a permitted tightening.
        row(CREW_A, 'bad', 'development', 'caught', ['POL-1301'], { description: 'a different action' }),
        // steering type changed, verdict same: not comparable, and NOT counted as unchanged.
        row(ESTATE_A, 'bad', 'security', 'gap'),
        // signals changed, verdict same.
        row(GARDEN_A, 'good', 'development', 'caught', [], { signals: { files: ['src/other.ts'] } }),
      ],
    });
    const c = compareEvalRuns(a, b);
    expect(c.payload_changed).toEqual([CREW_A, ESTATE_A, GARDEN_A]);
    expect(c.kind_changed).toEqual([]);
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toBe('payload changed for 3 shared sample(s) (description, steering_type or signals)');
    expect(c.flips).toEqual([
      {
        sample_id: CREW_A,
        kind: 'bad',
        from: 'gap',
        to: 'caught',
        classification: 'flagged',
        reason: "the sample's payload changed between runs (description, steering_type or signals): the corpus changed under this name",
      },
    ]);
    expect(c.unchanged).toBe(0);
    expect(c.reconciles).toBe(true);
  });

  it('rows without a payload_hash (what the engine alone emits) are UNVERIFIED: not comparable even when ids and kinds agree, with the exact reason prefix', async () => {
    const bare = (verdicts: [string, 'good' | 'bad', GovernanceEvalResult['verdict']][]) =>
      verdicts.map(([id, kind, v]) => row(id, kind, 'development', v, [], { identity: false }));
    const a = await recorded({ results: bare([[CREW_A, 'bad', 'gap'], [GARDEN_A, 'good', 'caught']]) });
    const b = await recorded({ results: bare([[CREW_A, 'bad', 'caught'], [GARDEN_A, 'good', 'caught']]) });
    const c = compareEvalRuns(a, b);
    expect(c.only_in_a).toEqual([]);
    expect(c.only_in_b).toEqual([]);
    expect(c.kind_changed).toEqual([]);
    expect(c.payload_changed).toEqual([]); // nothing can be said to have changed — or not
    expect(c.unverified_rows).toEqual({ a: 2, b: 2 });
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toMatch(new RegExp(`^${UNVERIFIED_NO_SAMPLE_IDENTITY} \\(2 result row\\(s\\) in a and 2 in b carry no well-formed sample\\.payload_hash\\)$`));
    // The verdict diff is still reported — as a flip — it is the COMPARABILITY claim that is withheld.
    expect(c.flips.map((f) => [f.sample_id, f.classification])).toEqual([[CREW_A, 'permitted']]);
    expect(c.unchanged).toBe(1);

    // One unverified side is enough: a stamped A against a bare B.
    const stamped = await recorded({ results: [row(CREW_A, 'bad', 'development', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')] });
    const mixed = compareEvalRuns(stamped, b);
    expect(mixed.unverified_rows).toEqual({ a: 0, b: 2 });
    expect(mixed.comparable).toBe(false);
    expect(mixed.comparable_reason?.startsWith(UNVERIFIED_NO_SAMPLE_IDENTITY)).toBe(true);
  });

  it('a MALFORMED payload_hash (not `sha256:` + 64 lowercase hex) is UNVERIFIED — never an authoritative identity that marks a pair comparable or "changed" (Copilot)', async () => {
    // The one well-formed spelling is what the producer stamps.
    expect(PAYLOAD_HASH_RE.test(samplePayloadHash({ id: 'x@000000000000', description: 'd', kind: 'good', steering_type: 'development', signals: {} }))).toBe(true);
    const a = await recorded({ results: [row(CREW_A, 'bad', 'development', 'gap'), row(GARDEN_A, 'good', 'development', 'caught'), row(ESTATE_A, 'good', 'development', 'caught')] });
    const malformed = [row(CREW_A, 'bad', 'development', 'caught'), row(GARDEN_A, 'good', 'development', 'caught'), row(ESTATE_A, 'good', 'development', 'caught')];
    malformed[0]!.sample.payload_hash = 'sha256:DEADBEEF'; // uppercase and truncated
    malformed[1]!.sample.payload_hash = `md5:${'0'.repeat(32)}`; // another algorithm
    malformed[2]!.sample.payload_hash = ' '; // non-empty, still no identity
    const b = await recorded({ results: malformed });
    const c = compareEvalRuns(a, b);
    expect(c.payload_changed).toEqual([]); // a malformed hash is not "different from A's" — it is no identity at all
    expect(c.unverified_rows).toEqual({ a: 0, b: 3 });
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toBe(`${UNVERIFIED_NO_SAMPLE_IDENTITY} (0 result row(s) in a and 3 in b carry no well-formed sample.payload_hash)`);
    // The verdict flip is still reported and classified by the S17 table (bad gap→caught permitted) — not flagged as a payload change.
    expect(c.flips.map((f) => [f.sample_id, f.classification])).toEqual([[CREW_A, 'permitted']]);
    expect(c.unchanged).toBe(2);
    // Control: well-formed on BOTH sides and different — that IS a payload change, and verified.
    const changed = await recorded({
      results: [row(CREW_A, 'bad', 'development', 'gap', [], { description: 'edited' }), row(GARDEN_A, 'good', 'development', 'caught'), row(ESTATE_A, 'good', 'development', 'caught')],
    });
    const d = compareEvalRuns(a, changed);
    expect(d.payload_changed).toEqual([CREW_A]);
    expect(d.unverified_rows).toEqual({ a: 0, b: 0 });
  });

  it('malformed persisted result rows (Copilot on #475) — a row without a `sample`, one with `fired: null`, one whose verdict is outside its union and one that is no object at all — are each ONE reconciliation error naming the run, the index and the defect; they are EXCLUDED (the well-formed rows are still compared, the summary and delta checks are withheld for that side), the pair is not comparable, and nothing throws', async () => {
    const a = await recorded({ results: [row(CREW_A, 'bad', 'development', 'caught'), row(GARDEN_A, 'good', 'development', 'caught')] });
    // Persist B as a corrupted / hand-edited detail file reads back: the store writes `results` verbatim
    // and `get()` checks only that it is an array (the summary is written as given, too).
    const corrupt = [
      row(CREW_A, 'bad', 'development', 'caught'),
      { expected: 'deny', fired: [], verdict: 'caught' }, // [1] no sample at all
      { sample: { id: 'x@000000000000', description: 'd', kind: 'bad', steering_type: 'development' }, expected: 'deny', fired: null, verdict: 'caught' }, // [2] fired is not an array
      { ...row(GARDEN_A, 'good', 'development', 'caught'), verdict: 'maybe' }, // [3] a verdict field() maps nowhere
      'not a row', // [4] not an object
    ] as unknown as GovernanceEvalResult[];
    const b = await recorded({ results: corrupt, summary: { total: 5, caught: 4, gaps: 0, false_positives: 0 }, rule_coverage: { exercised: 0, unexercised: [] } });

    expect(() => compareEvalRuns(a, b)).not.toThrow();
    expect(() => compareEvalRuns(b, a)).not.toThrow();
    const c = compareEvalRuns(a, b);
    const tail = 'not the wire shape (api-types GovernanceEvalResult), so it is excluded from the per-sample comparison, the identity counts, the tally and the coverage reconciliation';
    expect(c.reconciliation_errors).toEqual([
      `run b (${b.id}): results[1] is malformed — sample undefined is not an object { id, kind } — ${tail}`,
      `run b (${b.id}): results[2] is malformed — fired null is not an array of rule ids — ${tail}`,
      `run b (${b.id}): results[3] is malformed — verdict "maybe" is not caught|gap|false_positive — ${tail}`,
      `run b (${b.id}): results[4] is malformed — expected an object { sample, verdict, fired }, got "not a row" — ${tail}`,
    ]); // and NOTHING else: B's summary counts rows the comparison could not read, so the summary-vs-results
    //    and delta-accounting checks are withheld rather than misattributed to a summary defect
    expect(c.reconciles).toBe(false);
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason?.startsWith(`${MALFORMED_RESULT_ROWS} (0 result row(s) in a and 4 in b are not the wire shape`)).toBe(true);
    // The well-formed rows ARE compared: CREW_A is shared and unchanged; GARDEN_A's corrupted B row is
    // excluded, so the id is only in A. Nothing malformed is counted as "unverified" — that is a
    // well-formed row without a payload_hash, a different finding.
    expect(c.unchanged).toBe(1);
    expect(c.only_in_a).toEqual([GARDEN_A]);
    expect(c.only_in_b).toEqual([]);
    expect(c.unverified_rows).toEqual({ a: 0, b: 0 });
    // B's coverage is reconciled over its well-formed rows — the `fired: null` row never reaches the loop.
    expect(c.coverage_reconciliation).toEqual({ a: null, b: 'rows' });
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
    const a = await recorded({ results: RELEASE_N, rule_coverage: { exercised: 3, unexercised: [] } });
    const b = await recorded({ results: RELEASE_N, corpus: 'evals:wicked-internal@0000000000000000' });
    const c = compareEvalRuns(a, b);
    expect(c.identity.corpus.same).toBe(false);
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toBe(`corpus name differs ("${CORPUS}" vs "evals:wicked-internal@0000000000000000")`);
    expect(c.flips).toEqual([]);
    expect(c.rule_coverage_delta).toBeUndefined();
    // The one side that carries coverage is still reconciled on its own.
    expect(c.coverage_reconciliation).toEqual({ a: 'rows', b: null });
    expect(c.reconciles).toBe(true);
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

describe('rule_coverage delta — exercise transitions over what the records ENUMERATE; every rule-set transition withheld (no inventory is on the wire)', () => {
  const R = { rule_id: 'POL-9000', steering_type: 'security' as const };
  const WARN = { rule_id: 'WARN-1', steering_type: 'development' as const };
  const quiet = [row(CREW_A, 'bad', 'development', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')];
  const firing = [row(CREW_A, 'bad', 'development', 'caught', ['POL-9000']), row(GARDEN_A, 'good', 'development', 'caught')];

  it('a rule that VANISHES from the unexercised list is NOT `removed_rules` even when B counts 0 exercised and fires nothing — no record lists its rule set, so it is withheld by name (it may have lost its effect or been retired: outside the eligible partition, still in the store); the mirror withholds `added_rules` (codex round 8 deleted the `exercised === |fired|` ⇒ complete inference)', async () => {
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R] } });
    const b = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(true);
    expect(c.rule_coverage_delta).toEqual(delta({ transitions_withheld: [withheld('removed_rules', 'POL-9000', 'unexercised', 0)] }));
    expect(compareEvalRuns(b, a).rule_coverage_delta).toEqual(delta({ transitions_withheld: [withheld('added_rules', 'POL-9000', 'unexercised', 0)] }));
  });

  it('a rule that stops being unexercised because a sample now fires it BLOCKING is gained; the mirror image is lost — both ends listed, certain, nothing withheld', async () => {
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R] } });
    const b = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [] } });
    expect(compareEvalRuns(a, b).rule_coverage_delta).toEqual(delta({ exercised_delta: 1, gained: ['POL-9000'] }));
    expect(compareEvalRuns(b, a).rule_coverage_delta).toEqual(delta({ exercised_delta: -1, lost: ['POL-9000'] }));
  });

  it("codex round 6: a rule that leaves A's unexercised list and is exercised in B by a NON-BLOCKING effect alone (counted in `exercised`, never in any row's `fired`) is NOT `removed_rules` — withheld by name with B's unnamed count in the reason, the delta says exercised +1 with the id unknown, and two valid records reconcile; the mirror withholds `added_rules`", async () => {
    // A: WARN-1 unexercised. B: WARN-1 fired with effect `warn` on some sample — evals.rs counts it
    // exercised (rule_coverage over every claim's policy_ids) but `fired` is deny-only
    // (evaluate_sample), so NO row names it and it simply vanishes from the unexercised list.
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [WARN] } });
    const b = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    // the round-6 finding: removed_rules used to say ['WARN-1'] with reconciles false
    expect(c.rule_coverage_delta).toEqual(delta({ exercised_delta: 1, unidentified: { a: 0, b: 1 }, transitions_withheld: [withheld('removed_rules', 'WARN-1', 'unexercised', 1)] }));
    // The mirror: exercised-by-warn in A (unnamed), unexercised in B — a rule that "appears" in B's
    // unexercised list is neither `added_rules` nor `lost`: withheld.
    const rev = compareEvalRuns(b, a);
    expect(rev.reconciles).toBe(true);
    expect(rev.rule_coverage_delta).toEqual(delta({ exercised_delta: -1, unidentified: { a: 1, b: 0 }, transitions_withheld: [withheld('added_rules', 'WARN-1', 'unexercised', 1)] }));
  });

  it("the certain transitions are asserted whatever the counts — gained/lost need only the listed ids on both ends — while a blocking-fired id the other side never enumerated is withheld with that side's unnamed count in the reason (none when it names every exercised rule), and several withheld ids come back codepoint-sorted", async () => {
    // A: POL-9000 unexercised plus one warn-only exercised rule (unnamed). B: POL-9000 fired blocking.
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [R] } });
    const b = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(true);
    expect(c.rule_coverage_delta).toEqual(delta({ unidentified: { a: 1, b: 0 }, gained: ['POL-9000'] }));
    expect(compareEvalRuns(b, a).rule_coverage_delta).toEqual(delta({ unidentified: { a: 0, b: 1 }, lost: ['POL-9000'] }));
    // A names nothing but counts one exercised rule; B fires POL-9000 blocking: was POL-9000 A's
    // unnamed warn-exercised rule, or did the store gain it? Withheld — the reason says A has 1 unnamed.
    const unnamed = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    expect(compareEvalRuns(unnamed, b).rule_coverage_delta).toEqual(delta({ unidentified: { a: 1, b: 0 }, transitions_withheld: [withheld('added_rules', 'POL-9000', 'blocking-fired', 1)] }));
    // A counts NOTHING exercised and fires nothing — round 6 called that "complete" and asserted
    // `added_rules: ['POL-9000']`. The wire still lists no inventory (POL-9000 may be recall-only or
    // retired in A), so it is withheld — without the "unnamed" clause, because A has none.
    const none = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    expect(compareEvalRuns(none, b).rule_coverage_delta).toEqual(delta({ exercised_delta: 1, transitions_withheld: [withheld('added_rules', 'POL-9000', 'blocking-fired', 0)] }));
    // Several withheld ids come back codepoint-sorted.
    const two = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    const grew = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [{ rule_id: 'PAT-1', steering_type: 'testing' }] } });
    expect(compareEvalRuns(two, grew).rule_coverage_delta?.transitions_withheld).toEqual([
      withheld('added_rules', 'PAT-1', 'unexercised', 1),
      withheld('added_rules', 'POL-9000', 'blocking-fired', 1),
    ]);
  });

  it('a record that contradicts ITSELF is a reconciliation error naming the run — `exercised` BELOW its distinct blocking-fired ids, an id both fired and unexercised, a duplicate unexercised id — while a count ABOVE the fired ids is valid warn-only exercise (partial inventory, not an error)', async () => {
    const ok = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    const below = await recorded({ results: firing, rule_coverage: { exercised: 0, unexercised: [] } }); // POL-9000 fired blocking, yet 0 "exercised"
    const c = compareEvalRuns(below, ok);
    expect(c.reconciles).toBe(false);
    expect(c.reconciliation_errors).toEqual([
      `run a (${below.id}): rule_coverage.exercised 0 is below the 1 distinct rule id(s) fired (blocking) across its results (POL-9000) — every blocking firing is an exercised rule`,
    ]);
    expect(c.rule_coverage_delta?.exercised_delta).toBe(0);
    const both = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [R] } });
    const c2 = compareEvalRuns(ok, both);
    expect(c2.reconciles).toBe(false);
    expect(c2.reconciliation_errors).toEqual([
      `run b (${both.id}): rule_coverage.unexercised lists POL-9000, which fired (blocking) in its results — a rule that fired for any sample is exercised, never unexercised`,
    ]);
    const dup = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R, R] } });
    const c3 = compareEvalRuns(ok, dup);
    expect(c3.reconciles).toBe(false);
    expect(c3.reconciliation_errors).toEqual([`run b (${dup.id}): rule_coverage.unexercised lists POL-9000 twice — a rule is unexercised once or not at all`]);
    // ABOVE the fired ids: two rules exercised by a non-blocking effect alone — the wire's honest
    // count, not a defect (the round-2 check called this "cannot be reconstructed" and failed it).
    const above = await recorded({ results: quiet, rule_coverage: { exercised: 2, unexercised: [] } });
    const c4 = compareEvalRuns(above, ok);
    expect(c4.reconciles).toBe(true);
    expect(c4.reconciliation_errors).toEqual([]);
    expect(c4.rule_coverage_delta).toEqual(delta({ exercised_delta: -2, unidentified: { a: 2, b: 0 } }));
  });
});

describe('type-filtered runs (codex round 7) — the coverage denominator is the SLICE; a row may fire a rule outside it', () => {
  /** A SECURITY rule that denies a development sample: fired, yet not in the development denominator. */
  const SEC = 'SECURITY-DENY';
  const DEV = { rule_id: 'DEV-1', steering_type: 'development' as const };
  const NA = 'n/a (engine reports no per-type coverage)';
  const ZERO: GovernanceEvalTypeCoverage = { exercised: 0, unexercised: 0 };
  /** The engine's pinned `per_type` shape: all seven types, zeros unless overridden (evals.rs 856-859). */
  const perType = (over: Partial<Record<SteeringType, GovernanceEvalTypeCoverage>> = {}): Record<SteeringType, GovernanceEvalTypeCoverage> => ({
    architecture: ZERO,
    development: ZERO,
    security: ZERO,
    testing: ZERO,
    operations: ZERO,
    compliance: ZERO,
    'design-ux': ZERO,
    ...over,
  });
  /** Development samples only — what `rules eval --type development` judges. */
  const devQuiet = [row(CREW_A, 'bad', 'development', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')];
  /** codex's reproduction: the security rule denies the development sample. */
  const crossType = [row(CREW_A, 'bad', 'development', 'caught', [SEC]), row(GARDEN_A, 'good', 'development', 'caught')];
  const devFired = [row(CREW_A, 'bad', 'development', 'caught', ['DEV-1']), row(GARDEN_A, 'good', 'development', 'caught')];

  it("codex round 7: a development-filtered run with fired: ['SECURITY-DENY'] and exercised: 0 is VALID — compared with itself it reconciles and is comparable; its coverage is reconciled against per_type.development, never against the rows' fired ids. The SAME numbers under type_filter null contradict the rows", async () => {
    const run = await recorded({ results: crossType, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: perType() } });
    const c = compareEvalRuns(run, run);
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    expect(c.comparable).toBe(true);
    expect(c.comparable_reason).toBeNull();
    expect(c.identity.type_filter).toEqual({ a: 'development', b: 'development', same: true });
    expect(c.coverage_reconciliation).toEqual({ a: 'per_type', b: 'per_type' });
    // SECURITY-DENY fired on BOTH sides: not one-sided, so nothing is withheld either; exercised 0 on
    // both sides ⇒ nothing unidentified.
    expect(c.rule_coverage_delta).toEqual(delta());
    expect(c.unchanged).toBe(2);
    expect(c.flips).toEqual([]);
    // Control: UNFILTERED, every active rule is in the denominator — the same numbers contradict the rows.
    const unfiltered = await recorded({ results: crossType, type_filter: null, rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: perType() } });
    const u = compareEvalRuns(unfiltered, unfiltered);
    expect(u.coverage_reconciliation).toEqual({ a: 'rows', b: 'rows' });
    expect(u.reconciles).toBe(false);
    expect(u.reconciliation_errors).toEqual([
      `run a (${unfiltered.id}): rule_coverage.exercised 0 is below the 1 distinct rule id(s) fired (blocking) across its results (SECURITY-DENY) — every blocking firing is an exercised rule`,
      `run b (${unfiltered.id}): rule_coverage.exercised 0 is below the 1 distinct rule id(s) fired (blocking) across its results (SECURITY-DENY) — every blocking firing is an exercised rule`,
    ]);
  });

  it('two runs under DIFFERENT type filters are not comparable (`differing-type-filter`) and get NO coverage delta even when both carry coverage — each record is still reconciled on its own, and the per-sample flips are still reported', async () => {
    const dev = await recorded({ results: crossType, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: perType() } });
    const all = await recorded({ results: crossType, type_filter: null, rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ security: { exercised: 1, unexercised: 0 } }) } });
    const c = compareEvalRuns(dev, all);
    expect(c.identity.type_filter).toEqual({ a: 'development', b: null, same: false });
    expect(c.comparable).toBe(false);
    expect(c.comparable_reason).toBe(`${DIFFERING_TYPE_FILTER} (a: "development", b: null): the runs judged different slices of the corpus over different coverage denominators`);
    expect(c.comparable_reason?.startsWith(DIFFERING_TYPE_FILTER)).toBe(true);
    expect(c.coverage_reconciliation).toEqual({ a: 'per_type', b: 'rows' });
    expect(c.reconciles).toBe(true);
    expect('rule_coverage_delta' in c).toBe(false);
    expect(c.flips).toEqual([]);
    expect(compareEvalRuns(all, dev).comparable_reason).toBe(`${DIFFERING_TYPE_FILTER} (a: null, b: "development"): the runs judged different slices of the corpus over different coverage denominators`);
    // A verdict change on a shared sample is still a flip (same id, same payload — a per-sample fact);
    // only the COMPARABILITY claim and the inventory diff are withheld across filters.
    const flipped = await recorded({ results: devQuiet, type_filter: 'security', rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: perType() } });
    const f = compareEvalRuns(dev, flipped);
    expect(f.flips.map((x) => [x.sample_id, x.from, x.to, x.classification])).toEqual([[CREW_A, 'caught', 'gap', 'flagged']]);
    expect(f.comparable).toBe(false);
    expect(f.comparable_reason).toContain(DIFFERING_TYPE_FILTER);
    expect('rule_coverage_delta' in f).toBe(false);
  });

  it('under a filter WITHOUT per_type the denominator cannot be checked: coverage_reconciliation says so, nothing fired-based is asserted, and the delta still uses the engine counts', async () => {
    const a = await recorded({ results: crossType, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV] } });
    const b = await recorded({ results: crossType, type_filter: 'development', rule_coverage: { exercised: 1, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.coverage_reconciliation).toEqual({ a: NA, b: NA });
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    expect(c.comparable).toBe(true);
    // DEV-1 left A's unexercised list and B counts one exercised development rule — but B's rows fire
    // only SECURITY-DENY, which carries no type: DEV-1 is withheld as a removed_rules candidate and
    // the +1 is reported with its id unknown.
    expect(c.rule_coverage_delta).toEqual(delta({ exercised_delta: 1, unidentified: { a: 0, b: 1 }, transitions_withheld: [withheld('removed_rules', 'DEV-1', 'unexercised', 1, 'development')] }));
  });

  it("per_type is the slice's own number and must agree with the totals and the listed rows — a per_type that does not sum to exercised, a filtered record whose per_type.<filter>.exercised differs from exercised, an unexercised row of ANOTHER type under the filter, a per-type unexercised count off the listed rows, or a fired id listed unexercised (a contradiction under a filter too) is the record contradicting itself; unfiltered records carry per_type as well and get the same sum checks beside the fired-based one", async () => {
    const ok = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 } }) } });
    expect(compareEvalRuns(ok, ok).reconciles).toBe(true);
    expect(compareEvalRuns(ok, ok).coverage_reconciliation).toEqual({ a: 'per_type', b: 'per_type' });
    // (a) The slice's row says 1 exercised, the total says 0 — the sum is off too.
    const sliceOff = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 1 } }) } });
    let c = compareEvalRuns(ok, sliceOff);
    expect(c.reconciles).toBe(false);
    expect(c.reconciliation_errors).toEqual([
      `run b (${sliceOff.id}): rule_coverage.per_type sums to 1 exercised but rule_coverage.exercised is 0 — the per-type rows partition the same eligible rules`,
      `run b (${sliceOff.id}): rule_coverage.per_type.development.exercised is 1 but rule_coverage.exercised is 0 — under type filter development the eligible rules are exactly the development slice (evals.rs decide_lane_rules), so the slice's row IS the total`,
    ]);
    // (b) The sum matches the total but the exercise is booked under ANOTHER type: under a filter the
    // slice's row IS the total.
    const booked = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 1, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 }, security: { exercised: 1, unexercised: 0 } }) } });
    c = compareEvalRuns(ok, booked);
    expect(c.reconciliation_errors).toEqual([
      `run b (${booked.id}): rule_coverage.per_type.development.exercised is 0 but rule_coverage.exercised is 1 — under type filter development the eligible rules are exactly the development slice (evals.rs decide_lane_rules), so the slice's row IS the total`,
    ]);
    // (c) An unexercised row of another type under the filter — and per_type disagreeing with the rows.
    const foreign = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV, { rule_id: 'POL-9000', steering_type: 'security' }], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 } }) } });
    c = compareEvalRuns(ok, foreign);
    expect(c.reconciliation_errors).toEqual([
      `run b (${foreign.id}): rule_coverage.unexercised lists POL-9000 (security) under type filter development — the slice's eligible rules are all of the filter's type (evals.rs decide_lane_rules in_slice)`,
      `run b (${foreign.id}): rule_coverage.per_type.security.unexercised is 0 but rule_coverage.unexercised lists 1 security rule(s)`,
    ]);
    // (d) A fired id listed unexercised: the row types DEV-1 into the slice and the firing exercises it.
    const firedListed = await recorded({ results: devFired, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 } }) } });
    c = compareEvalRuns(ok, firedListed);
    expect(c.reconciliation_errors).toEqual([
      `run b (${firedListed.id}): rule_coverage.unexercised lists DEV-1, which fired (blocking) in its results — a rule that fired for any sample is exercised, never unexercised`,
    ]);
    // (e) Unfiltered records carry per_type too: the sums are checked, the fired-based check still runs.
    const unfilteredOk = await recorded({ results: crossType, type_filter: null, rule_coverage: { exercised: 1, unexercised: [DEV], recall_only: 2, per_type: perType({ security: { exercised: 1, unexercised: 0 }, development: { exercised: 0, unexercised: 1 } }) } });
    c = compareEvalRuns(unfilteredOk, unfilteredOk);
    expect(c.reconciles).toBe(true);
    expect(c.coverage_reconciliation).toEqual({ a: 'rows', b: 'rows' });
    const sumOff = await recorded({ results: crossType, type_filter: null, rule_coverage: { exercised: 1, unexercised: [DEV], recall_only: 2, per_type: perType({ security: { exercised: 2, unexercised: 0 }, development: { exercised: 0, unexercised: 0 } }) } });
    c = compareEvalRuns(unfilteredOk, sumOff);
    expect(c.reconciliation_errors).toEqual([
      `run b (${sumOff.id}): rule_coverage.per_type sums to 2 exercised but rule_coverage.exercised is 1 — the per-type rows partition the same eligible rules`,
      `run b (${sumOff.id}): rule_coverage.per_type.development.unexercised is 0 but rule_coverage.unexercised lists 1 development rule(s)`,
    ]);
    // (f) A filtered record whose per_type lacks the filter's own row names that, never indexes into undefined.
    const sixTypes = Object.fromEntries(Object.entries(perType()).filter(([t]) => t !== 'development')) as Record<SteeringType, GovernanceEvalTypeCoverage>;
    const noRow = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: sixTypes } });
    c = compareEvalRuns(ok, noRow);
    expect(c.coverage_reconciliation).toEqual({ a: 'per_type', b: 'per_type' });
    expect(c.reconciliation_errors).toEqual([`run b (${noRow.id}): rule_coverage.per_type carries no development row although the run was filtered to development — the slice's own numbers are missing`]);
  });

  it("under the SAME filter: gained/lost stay certain (both ends listed), `unidentified` is each record's WHOLE exercised count — no fired id is typed into the slice by the OTHER run's row (codex round 8) — and every one-sided id is withheld, listed or fired-only, the reason naming the other-type possibility", async () => {
    const unex = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 } }) } });
    const fires = await recorded({ results: devFired, type_filter: 'development', rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 0 } }) } });
    // gained: DEV-1 unexercised in A (A's row types it development) and blocking-fired in B. B counts
    // one exercised development rule — DEV-1? B's own record cannot say (a fired id carries no type,
    // and DEV-1 may have moved type), so `unidentified.b` stays 1; round 7 subtracted the gained id
    // here and called B complete. The mirror is lost.
    expect(compareEvalRuns(unex, fires).rule_coverage_delta).toEqual(delta({ exercised_delta: 1, unidentified: { a: 0, b: 1 }, gained: ['DEV-1'] }));
    expect(compareEvalRuns(fires, unex).rule_coverage_delta).toEqual(delta({ exercised_delta: -1, unidentified: { a: 1, b: 0 }, lost: ['DEV-1'] }));
    // A cross-type firing joins in B: SECURITY-DENY denies the development sample too, enumerated by
    // B alone — withheld, the reason naming that it may be a rule of another type outside the denominator.
    const both = await recorded({
      results: [row(CREW_A, 'bad', 'development', 'caught', ['DEV-1', SEC]), row(GARDEN_A, 'good', 'development', 'caught')],
      type_filter: 'development',
      rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 0 } }) },
    });
    const c = compareEvalRuns(unex, both);
    expect(c.reconciles).toBe(true);
    expect(c.rule_coverage_delta).toEqual(delta({ exercised_delta: 1, unidentified: { a: 0, b: 1 }, gained: ['DEV-1'], transitions_withheld: [withheld('added_rules', SEC, 'blocking-fired', 0, 'development')] }));
    expect(compareEvalRuns(both, unex).rule_coverage_delta).toEqual(delta({ exercised_delta: -1, unidentified: { a: 1, b: 0 }, lost: ['DEV-1'], transitions_withheld: [withheld('removed_rules', SEC, 'blocking-fired', 0, 'development')] }));
    // A LISTED candidate: DEV-1 appears unexercised in B; A names nothing but counts one exercised
    // development rule (a warn-only firing, or a deny rule whose id A's rows carry untyped) — withheld
    // with A's 1 unnamed in the reason; the mirror likewise.
    const unnamed = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 0 } }) } });
    expect(compareEvalRuns(unnamed, unex).rule_coverage_delta).toEqual(delta({ exercised_delta: -1, unidentified: { a: 1, b: 0 }, transitions_withheld: [withheld('added_rules', 'DEV-1', 'unexercised', 1, 'development')] }));
    expect(compareEvalRuns(unex, unnamed).rule_coverage_delta).toEqual(delta({ exercised_delta: 1, unidentified: { a: 0, b: 1 }, transitions_withheld: [withheld('removed_rules', 'DEV-1', 'unexercised', 1, 'development')] }));
    // A counts NOTHING exercised: round 7 asserted `added_rules: ['DEV-1']` here. Still withheld — a
    // record with no exercised rules has no inventory either (DEV-1 may be recall-only, retired, or of
    // another type in A); the mirror withholds `removed_rules`.
    const none = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [], recall_only: 0, per_type: perType() } });
    expect(compareEvalRuns(none, unex).rule_coverage_delta).toEqual(delta({ transitions_withheld: [withheld('added_rules', 'DEV-1', 'unexercised', 0, 'development')] }));
    expect(compareEvalRuns(unex, none).rule_coverage_delta).toEqual(delta({ transitions_withheld: [withheld('removed_rules', 'DEV-1', 'unexercised', 0, 'development')] }));
    // A fires SECURITY-DENY and counts 1 exercised development rule; B lists DEV-1 unexercised: two
    // one-sided ids, both withheld, codepoint-sorted.
    const firesSec = await recorded({ results: crossType, type_filter: 'development', rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 0 } }) } });
    expect(compareEvalRuns(firesSec, unex).rule_coverage_delta).toEqual(
      delta({
        exercised_delta: -1,
        unidentified: { a: 1, b: 0 },
        transitions_withheld: [withheld('added_rules', 'DEV-1', 'unexercised', 1, 'development'), withheld('removed_rules', SEC, 'blocking-fired', 0, 'development')],
      }),
    );
  });

  it("codex round 8: A lists R and Q unexercised (development); B moves R to security, fires R blocking for a development sample and exercises Q by warn — two VALID development-filtered records. Round 7 typed R into B's slice through A's row, called B's inventory complete and reported `removed_rules: ['Q']` although Q is present and exercised. Now: no removed_rules, inventory partial, Q withheld by name, unidentified.b = 1 (Q, named nowhere), reconciles — both directions", async () => {
    const Q = { rule_id: 'DEV-Q', steering_type: 'development' as const };
    const RR = { rule_id: 'DEV-R', steering_type: 'development' as const };
    const before = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [RR, Q], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 2 } }) } });
    // B: R is a security rule now — it denies the development sample (fired, OUTSIDE the development
    // denominator); Q fired with effect warn (exercised: 1, named in no row). The development slice:
    // 1 exercised (Q), 0 unexercised. A valid record.
    const after = await recorded({
      results: [row(CREW_A, 'bad', 'development', 'caught', ['DEV-R']), row(GARDEN_A, 'good', 'development', 'caught')],
      type_filter: 'development',
      rule_coverage: { exercised: 1, unexercised: [], recall_only: 0, per_type: perType({ development: { exercised: 1, unexercised: 0 } }) },
    });
    const c = compareEvalRuns(before, after);
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    expect(c.comparable).toBe(true);
    expect(c.coverage_reconciliation).toEqual({ a: 'per_type', b: 'per_type' });
    expect(c.rule_coverage_delta).toEqual({
      exercised_delta: 1,
      inventory: 'partial',
      unidentified: { a: 0, b: 1 },
      gained: ['DEV-R'], // listed unexercised by A, blocking-fired by B: R IS exercised in B (whatever its type there)
      lost: [],
      added_rules: [],
      removed_rules: [], // the round-8 finding: this said ['DEV-Q'] beside inventory 'complete'
      transitions_withheld: [
        "removed_rules DEV-Q: enumerated by a (unexercised) and not by b — the wire lists no rule inventory (rule_coverage.exercised and recall_only are counts; only unexercised and blocking-fired ids are named), so b's silence is not absence: DEV-Q may be one of b's 1 exercised rule(s) named nowhere (under type filter development no fired id is typed into the slice), an effect-less (recall-only) or retired rule outside the eligible partition, a rule of another type outside the development denominator (a row's fired ids carry no steering_type) or a rule the store lost: not asserted",
      ],
    });
    // The other direction: R lost (blocking-fired in A, unexercised in B), Q withheld as an
    // added_rules candidate with A's 1 unnamed in the reason.
    const rev = compareEvalRuns(after, before);
    expect(rev.reconciles).toBe(true);
    expect(rev.rule_coverage_delta).toEqual(delta({ exercised_delta: -1, unidentified: { a: 1, b: 0 }, lost: ['DEV-R'], transitions_withheld: [withheld('added_rules', 'DEV-Q', 'unexercised', 1, 'development')] }));
  });

  it('a persisted rule_coverage that is not the wire shape — `per_type: null` (codex round 8: `Object.values(null)` threw), `rule_coverage: null`, `unexercised` not an array, a per_type row that is null or negative, a key that is no steering type — is `unverified (malformed rule_coverage)` on THAT side: one reconciliation error naming the run and the defect, no coverage delta, the other side still reconciled, the per-sample comparison intact, and never a throw', async () => {
    const ok = await recorded({ results: devQuiet, type_filter: 'development', rule_coverage: { exercised: 0, unexercised: [DEV], recall_only: 0, per_type: perType({ development: { exercised: 0, unexercised: 1 } }) } });
    /** Record a run with an ARBITRARY persisted coverage value — the store writes the engine's value verbatim. */
    const persisted = (rule_coverage: unknown) => recorded({ results: devQuiet, type_filter: 'development', rule_coverage: rule_coverage as GovernanceEvalRuleCoverage });
    const TYPES = 'architecture|development|security|testing|operations|compliance|design-ux';
    const cases: [unknown, string][] = [
      [{ exercised: 0, unexercised: [], per_type: null }, 'per_type null is not an object keyed by steering type'],
      [null, 'expected an object { exercised, unexercised[] }, got null'],
      [[], 'expected an object { exercised, unexercised[] }, got []'],
      [{ exercised: '0', unexercised: [] }, 'exercised "0" is not a non-negative integer'],
      [{ exercised: 0, unexercised: null }, 'unexercised null is not an array'],
      [{ exercised: 0, unexercised: [{ steering_type: 'development' }] }, 'unexercised[0] carries no string rule_id (got {"steering_type":"development"})'],
      [{ exercised: 0, unexercised: [{ rule_id: 'X', steering_type: 'vibes' }] }, `unexercised[0] (X) steering_type "vibes" is not one of ${TYPES}`],
      [{ exercised: 0, unexercised: [], recall_only: -1 }, 'recall_only -1 is not a non-negative integer'],
      [{ exercised: 0, unexercised: [], per_type: [] }, 'per_type [] is not an object keyed by steering type'],
      [{ exercised: 0, unexercised: [], per_type: { vibes: { exercised: 0, unexercised: 0 } } }, `per_type key "vibes" is not one of ${TYPES}`],
      [{ exercised: 0, unexercised: [], per_type: { development: null } }, 'per_type.development null is not an object { exercised, unexercised }'],
      [{ exercised: 0, unexercised: [], per_type: { development: { exercised: -1, unexercised: 0 } } }, 'per_type.development.exercised -1 is not a non-negative integer'],
      [{ exercised: 0, unexercised: [], per_type: { development: { exercised: 0 } } }, 'per_type.development.unexercised undefined is not a non-negative integer'],
    ];
    for (const [rc, defect] of cases) {
      const bad = await persisted(rc);
      const c = compareEvalRuns(ok, bad); // a throw here fails the test — the round-8 crash
      expect(c.coverage_reconciliation, JSON.stringify(rc)).toEqual({ a: 'per_type', b: MALFORMED_RULE_COVERAGE });
      expect(c.reconciles, JSON.stringify(rc)).toBe(false);
      expect(c.reconciliation_errors, JSON.stringify(rc)).toEqual([
        `run b (${bad.id}): rule_coverage is malformed — ${defect} — not the wire shape (api-types GovernanceEvalRuleCoverage), so it is not reconciled and no coverage delta is computed over it`,
      ]);
      expect('rule_coverage_delta' in c, JSON.stringify(rc)).toBe(false);
      // Malformed on the baseline side: the same, per side.
      const rev = compareEvalRuns(bad, ok);
      expect(rev.coverage_reconciliation, JSON.stringify(rc)).toEqual({ a: MALFORMED_RULE_COVERAGE, b: 'per_type' });
      expect('rule_coverage_delta' in rev, JSON.stringify(rc)).toBe(false);
    }
    expect(MALFORMED_RULE_COVERAGE).toBe('unverified (malformed rule_coverage)');
    // Malformed on BOTH sides: two errors, two marks, no delta — and the per-sample comparison
    // (flips, comparability, summaries) is untouched by any of it.
    const bad = await persisted({ exercised: 0, unexercised: [], per_type: null });
    const c = compareEvalRuns(bad, bad);
    expect(c.coverage_reconciliation).toEqual({ a: MALFORMED_RULE_COVERAGE, b: MALFORMED_RULE_COVERAGE });
    expect(c.reconciliation_errors).toHaveLength(2);
    expect('rule_coverage_delta' in c).toBe(false);
    expect(c.comparable).toBe(true);
    expect(c.flips).toEqual([]);
    expect(c.unchanged).toBe(2);
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

describe('samplePayloadHash — the identity the comparison keys on', () => {
  it('covers exactly the five payload fields, is key-order independent, and changes with any of them', () => {
    const base = { id: 'x@000000000000', description: 'd', kind: 'good' as const, steering_type: 'development', signals: { files: ['a.ts'], content: 'c' } };
    const h = samplePayloadHash(base);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same payload, keys in another order (and an already-stamped hash riding along) ⇒ same identity.
    expect(samplePayloadHash({ signals: { content: 'c', files: ['a.ts'] }, steering_type: 'development', kind: 'good', description: 'd', id: base.id })).toBe(h);
    expect(samplePayloadHash({ ...base, payload_hash: h } as typeof base)).toBe(h);
    for (const variant of [
      { ...base, id: 'y@000000000000' },
      { ...base, description: 'e' },
      { ...base, kind: 'bad' as const },
      { ...base, steering_type: 'security' },
      { ...base, signals: { files: ['b.ts'], content: 'c' } },
      { ...base, signals: { files: ['a.ts'], content: 'c', phase: 'build' } },
    ]) {
      expect(samplePayloadHash(variant)).not.toBe(h);
    }
  });
});
