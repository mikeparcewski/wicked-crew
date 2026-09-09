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
// and diff `rule_coverage` when both carry it over what the records ENUMERATE (codex round 6):
// `exercised` is a COUNT of every rule any claim fired, blocking or not, while `results[].fired` is
// the blocking subset — so a record names only `unexercised ∪ fired`, and its rule set is fully
// identified only when `exercised === |fired|`. `gained`/`lost` are asserted from listed ids on both
// ends (always sound); `added_rules`/`removed_rules` only when the silent side's inventory is
// complete, else WITHHELD by name (`inventory: 'partial'`, `transitions_withheld`); a count above
// the fired ids is valid warn-only exercise, never a reconciliation error; a delta is never
// fabricated from one side.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalRunStore, type RecordEvalRunInput } from '../src/api/eval-store.js';
import { classifyFlip, compareEvalRuns, UNVERIFIED_NO_SAMPLE_IDENTITY, type EvalRuleCoverageDelta } from '../src/api/eval-compare.js';
import { PAYLOAD_HASH_RE, samplePayloadHash } from '../src/api/eval-sample.js';
import { removeScratch } from './setup/scratch.js';
import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSignals, GovernanceEvalSummary, SteeringType } from '../src/core/types.js';

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

    // Coverage. Both sides: exercised 3 = 3 distinct blocking-fired ids ⇒ every exercised rule is
    // named, the inventory is COMPLETE. Rule sets: A = {POL-1301, PAT-014, POL-007} ∪ {PAT-9, POL-1801};
    // B = {POL-1301, PAT-9, POL-007} ∪ {PAT-014, POL-1801, POL-2000}.
    //   PAT-9    unexercised in A, blocking-fired in B           → gained
    //   PAT-014  blocking-fired in A, unexercised in B           → lost
    //   POL-2000 enumerated by B only, A complete (the store grew) → added_rules, NOT lost
    //   POL-1801 unexercised on both sides                       → nothing
    expect(c.rule_coverage_delta).toEqual({
      exercised_delta: 0,
      inventory: 'complete',
      unidentified: { a: 0, b: 0 },
      gained: ['PAT-9'],
      lost: ['PAT-014'],
      added_rules: ['POL-2000'],
      removed_rules: [],
      transitions_withheld: [],
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

describe('rule_coverage delta — exercise transitions vs. rule-set changes, over what the records ENUMERATE', () => {
  const R = { rule_id: 'POL-9000', steering_type: 'security' as const };
  const WARN = { rule_id: 'WARN-1', steering_type: 'development' as const };
  const quiet = [row(CREW_A, 'bad', 'development', 'gap'), row(GARDEN_A, 'good', 'development', 'caught')];
  const firing = [row(CREW_A, 'bad', 'development', 'caught', ['POL-9000']), row(GARDEN_A, 'good', 'development', 'caught')];
  /** The delta of two COMPLETE inventories (every exercised rule named on both sides), nothing withheld. */
  const complete = (over: Partial<EvalRuleCoverageDelta> = {}): EvalRuleCoverageDelta => ({
    exercised_delta: 0,
    inventory: 'complete',
    unidentified: { a: 0, b: 0 },
    gained: [],
    lost: [],
    added_rules: [],
    removed_rules: [],
    transitions_withheld: [],
    ...over,
  });
  /** The reason `compareEvalRuns` gives for withholding a rule-set transition on a partial side. */
  const withheld = (kind: 'added_rules' | 'removed_rules', id: string, listedAs: 'unexercised' | 'blocking-fired', side: 'a' | 'b', exercised: number, fired: number) =>
    `${kind} ${id}: enumerated by ${side === 'a' ? 'b' : 'a'} (${listedAs}) and not by ${side}, whose exercised set is only partially identified — ${exercised - fired} exercised rule id(s) fired by a non-blocking effect alone are unknown (rule_coverage.exercised ${exercised} vs ${fired} distinct blocking-fired id(s)) — so it may be one of those${kind === 'removed_rules' ? ' (exercised now, id unknown) or a rule removed from the store' : ' or a rule the store gained'}: not asserted`;

  it('a rule that VANISHES from the unexercised list because it left the store is removed, never gained — asserted because B names every exercised rule (exercised 0 = 0 blocking-fired)', async () => {
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R] } });
    const b = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.rule_coverage_delta).toEqual(complete({ removed_rules: ['POL-9000'] }));
    expect(c.reconciles).toBe(true);
  });

  it('a rule that APPEARS unexercised because the store grew it is added, never lost — asserted because A names every exercised rule', async () => {
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    const b = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R] } });
    expect(compareEvalRuns(a, b).rule_coverage_delta).toEqual(complete({ added_rules: ['POL-9000'] }));
  });

  it('a rule that stops being unexercised because a sample now fires it BLOCKING is gained; the mirror image is lost — both ends listed, certain', async () => {
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [R] } });
    const b = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [] } });
    expect(compareEvalRuns(a, b).rule_coverage_delta).toEqual(complete({ exercised_delta: 1, gained: ['POL-9000'] }));
    expect(compareEvalRuns(b, a).rule_coverage_delta).toEqual(complete({ exercised_delta: -1, lost: ['POL-9000'] }));
  });

  it("codex round 6: a rule that leaves A's unexercised list and is exercised in B by a NON-BLOCKING effect alone (counted in `exercised`, never in any row's `fired`) is NOT `removed_rules` — B's inventory is partial, the transition is withheld by name, the delta says exercised +1 with the id unknown, and two valid records reconcile; the mirror withholds `added_rules`", async () => {
    // A: WARN-1 unexercised. B: WARN-1 fired with effect `warn` on some sample — evals.rs counts it
    // exercised (rule_coverage 815-827 over every claim's policy_ids) but `fired` is deny-only
    // (evaluate_sample 857-869), so NO row names it and it simply vanishes from the unexercised list.
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [WARN] } });
    const b = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(true);
    expect(c.reconciliation_errors).toEqual([]);
    expect(c.rule_coverage_delta).toEqual({
      exercised_delta: 1,
      inventory: 'partial',
      unidentified: { a: 0, b: 1 },
      gained: [],
      lost: [],
      added_rules: [],
      removed_rules: [], // the round-6 finding: this used to say ['WARN-1'] with reconciles false
      transitions_withheld: [withheld('removed_rules', 'WARN-1', 'unexercised', 'b', 1, 0)],
    });
    // The mirror: exercised-by-warn in A (unnamed), unexercised in B — A is partial, so a rule that
    // "appears" in B's unexercised list is neither `added_rules` nor `lost`: withheld.
    const rev = compareEvalRuns(b, a);
    expect(rev.reconciles).toBe(true);
    expect(rev.rule_coverage_delta).toEqual({
      exercised_delta: -1,
      inventory: 'partial',
      unidentified: { a: 1, b: 0 },
      gained: [],
      lost: [],
      added_rules: [],
      removed_rules: [],
      transitions_withheld: [withheld('added_rules', 'WARN-1', 'unexercised', 'a', 1, 0)],
    });
  });

  it('under a PARTIAL inventory the certain transitions are still asserted — gained/lost need only the listed ids on both ends — while a blocking-fired id the partial side never enumerated is withheld, and asserted as added once that side is complete', async () => {
    // A: POL-9000 unexercised plus one warn-only exercised rule (unnamed). B: POL-9000 fired blocking.
    const a = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [R] } });
    const b = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [] } });
    const c = compareEvalRuns(a, b);
    expect(c.reconciles).toBe(true);
    expect(c.rule_coverage_delta).toEqual({ exercised_delta: 0, inventory: 'partial', unidentified: { a: 1, b: 0 }, gained: ['POL-9000'], lost: [], added_rules: [], removed_rules: [], transitions_withheld: [] });
    expect(compareEvalRuns(b, a).rule_coverage_delta).toEqual({ exercised_delta: 0, inventory: 'partial', unidentified: { a: 0, b: 1 }, gained: [], lost: ['POL-9000'], added_rules: [], removed_rules: [], transitions_withheld: [] });
    // A names nothing but counts one exercised rule; B fires POL-9000 blocking: was POL-9000 A's
    // unnamed warn-exercised rule, or did the store gain it? Withheld — until A is complete.
    const unnamed = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    expect(compareEvalRuns(unnamed, b).rule_coverage_delta).toEqual({
      exercised_delta: 0,
      inventory: 'partial',
      unidentified: { a: 1, b: 0 },
      gained: [],
      lost: [],
      added_rules: [],
      removed_rules: [],
      transitions_withheld: [withheld('added_rules', 'POL-9000', 'blocking-fired', 'a', 1, 0)],
    });
    const none = await recorded({ results: quiet, rule_coverage: { exercised: 0, unexercised: [] } });
    expect(compareEvalRuns(none, b).rule_coverage_delta).toEqual(complete({ exercised_delta: 1, added_rules: ['POL-9000'] }));
    // Several withheld ids come back codepoint-sorted.
    const two = await recorded({ results: quiet, rule_coverage: { exercised: 1, unexercised: [] } });
    const grew = await recorded({ results: firing, rule_coverage: { exercised: 1, unexercised: [{ rule_id: 'PAT-1', steering_type: 'testing' }] } });
    expect(compareEvalRuns(two, grew).rule_coverage_delta?.transitions_withheld).toEqual([
      withheld('added_rules', 'PAT-1', 'unexercised', 'a', 1, 0),
      withheld('added_rules', 'POL-9000', 'blocking-fired', 'a', 1, 0),
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
    expect(c4.rule_coverage_delta).toEqual({ exercised_delta: -2, inventory: 'partial', unidentified: { a: 2, b: 0 }, gained: [], lost: [], added_rules: [], removed_rules: [], transitions_withheld: [] });
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
