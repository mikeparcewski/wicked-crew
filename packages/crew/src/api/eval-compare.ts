/**
 * Cross-run eval comparison (docs/testing/evals-test-plan.md S17) — the OFFLINE, deterministic diff
 * of two recorded {@link EvalRunDetail}s over the same corpus: which per-sample verdicts flipped,
 * whether each flip is the kind a tightened store is allowed to produce (`permitted`) or the kind a
 * release has to explain (`flagged`), whether the two stored summaries reconcile to the per-sample
 * accounting, and which rules gained or lost exercise (core #394 `rule_coverage`).
 *
 * Pure over the two records: no store, no engine, no clock, no I/O — two persisted drilldowns in,
 * one report out, byte-stable for the same inputs (every list is codepoint-sorted by id).
 *
 * # What "comparable" means here
 *
 * Plan §3 keys a comparison by five identities. The records carry four of them today (`corpus`,
 * `rule_store`, `type_filter`, `degraded`; the rule snapshot and the engine build are §5 follow-ups),
 * so `comparable` is derived from CONTENT, never from a name alone: the same corpus name AND the same
 * type filter AND the same sample ids AND, per id, the same `kind` AND the same sample PAYLOAD
 * identity — the `sample.payload_hash` a producer stamped on each result row (`eval-sample.js`
 * `samplePayloadHash`: sha256 over the canonical JSON of id, description, kind, steering_type,
 * signals). The engine echoes only id/description/kind/steering_type per row, never the input
 * `signals`, so a row WITHOUT a payload hash cannot be proven to be the same action as its
 * namesake in the other run: such a pair is `comparable: false` with `comparable_reason` starting
 * `unverified: no sample identity` — unverified, which is not the same as "different". A sample
 * present on one side only, one whose kind changed, or one whose payload hash changed means the
 * corpus changed under the same name — reported, and the pair is not comparable release over
 * release. Two runs under DIFFERENT type filters judged different slices of the corpus over
 * different coverage denominators — not comparable either (`differing-type-filter`, see below).
 * `comparable_reason` is `null` exactly when `comparable` is true.
 *
 * # Flip classification (the S17 rule table)
 *
 *   bad   gap → caught                permitted   a rule tightened: a bad behavior is now caught
 *   bad   caught → gap                flagged     regression: a bad behavior is no longer caught
 *   good  false_positive → caught     permitted   a good sample is no longer denied
 *   good  caught → false_positive     flagged     a good sample is newly denied
 *   anything else                     flagged     not a verdict pair that kind can take (evals.rs
 *                                                 `evaluate_sample`: a bad sample is caught|gap, a
 *                                                 good sample is caught|false_positive)
 *
 * `good` is a sample KIND, not a verdict — the draft plan's `good → false_positive` spelling was
 * corrected in revision 3; this module is the executable form of that correction.
 *
 * # Coverage transitions vs. rule-set changes — what a record CANNOT tell (codex rounds 6 and 8)
 *
 * The wire carries `rule_coverage.exercised` as a COUNT and `unexercised` as a LIST of ids
 * (api-types `GovernanceEvalRuleCoverage`; wicked-core `crates/wicked-governance/src/evals.rs` on
 * branch `feat/evals-effect-and-coverage` (core #394/#395, PR #398) at `a87e461` — `RuleCoverage`
 * lines 323-328: `exercised: usize`, `unexercised: Vec<UnexercisedRule>`, `recall_only: usize`,
 * `per_type: BTreeMap<String, TypeCoverage>`). The partition is over the ELIGIBLE rules — the
 * active, effect-bearing rules of the slice (`decide_lane_rules` lines 816-843: `effect.is_some()
 * && !retired && in_slice`); `recall_only` counts the effect-less active rules OUTSIDE it (docs
 * lines 317-319, computed at 875-878). A rule is EXERCISED when it appeared in ANY evaluated claim's
 * `policy_ids`, whatever its effect (`RuleCoverage` docs lines 312-314; `rule_coverage()` lines
 * 849-880 partitions the eligible rules by `triggered`, the union `run_evals` collects of every
 * claim's `policy_ids`). A result row's `fired`, however, is the BLOCKING subset only:
 * `evaluate_sample` lines 906-916 keep the ids whose effect is `Deny`. Hence, for an UNFILTERED run,
 *
 *   fired(run) ⊆ exercised(run), and `exercised − |fired|` rules were exercised by a non-blocking
 *   (`warn`) effect ALONE — counted, but NEVER named anywhere in the record.
 *
 * NO field of the wire lists a run's rule set: `exercised` and `recall_only` are counts,
 * `unexercised` names only the rules nothing exercised, `fired` only the blocking firings. The rule
 * identities a record enumerates are therefore exactly `unexercised ∪ fired`, and an id one record
 * enumerates and the other does not is NOT thereby absent from the other's store: it may be one of
 * that side's unnamed warn-exercised rules, an effect-less (recall-only) or retired rule outside the
 * eligible partition, under a type filter a rule of another type outside the denominator — or a rule
 * the store really gained or lost. Round 6 replaced a reconstruction of "the inventory" as
 * `unexercised ∪ fired` with a completeness inference: `exercised === |fired|` ⇒ every exercised rule
 * is named ⇒ the silent side's absence was asserted as `added_rules`/`removed_rules`. Round 8 deleted
 * that inference too — under a type filter a fired id is typed into the slice only by the OTHER run's
 * `unexercised` row, and a rule's type in run A does not establish its type in run B (codex's
 * reproduction: A lists R and Q unexercised under `development`; B moves R to `security`, fires R
 * blocking and exercises Q by `warn`; the cross-run intersection named R, declared B complete and
 * reported Q — still present and exercised — as `removed_rules`). The delta asserts ONLY what the
 * records state:
 *
 *   gained         unexercised in A (listed) AND blocking-fired in B (listed): a sample now exercises
 *                  the rule — a statement about the RULE, both ends named, certain
 *   lost           blocking-fired in A AND unexercised in B (listed): certain
 *   unidentified   PER RECORD, how many exercised rules of its denominator it does not name:
 *                  unfiltered `exercised − |fired|`; under a type filter the whole `exercised` (a
 *                  fired id carries no steering_type, so a record types none of its own firings into
 *                  the slice) — never reduced by what the OTHER run lists
 *   added_rules /  asserted only from an explicit rule inventory on BOTH records — the wire carries
 *   removed_rules  none, so both are EMPTY for every daemon-recorded run and `inventory` is `partial`
 *   transitions_withheld
 *                  every id enumerated by one record and not the other, one reason per id saying what
 *                  it may be besides a rule-set change — WITHHELD, never guessed
 *
 * `exercised_delta` is always the difference of the two counts. Reconciliation errors on coverage are
 * the record contradicting ITSELF (or being malformed — below); two valid reports always `reconcile`.
 *
 * # Type filters (codex round 7) — the denominator is the SLICE; the firings are not
 *
 * A run recorded under `type_filter: T` was produced by `rules eval --type T`. In the engine that
 * filter slices the SAMPLES (`run_evals` lines 974-977: only samples of type T are judged) and the
 * COVERAGE DENOMINATOR (`decide_lane_rules` lines 816-844, `in_slice` at 820: only type-T rules are
 * eligible; `rule_coverage` 849-880 partitions exactly those; `recall_only` 875-878 is sliced too)
 * but NOT the gate: `evaluate_sample` runs `select_any` over every active rule whatever its type
 * (line 901) and a row's `fired` keeps every blocking id it produced (906-916). So under a filter a
 * row may fire a rule OUTSIDE the denominator — codex's reproduction: a development-filtered run
 * with `fired: ["SECURITY-DENY"]` and `exercised: 0` is a VALID record (the security rule is not a
 * development rule), and the unfiltered invariant `exercised ≥ |fired|` does not hold. Hence, per
 * record ({@link EvalCoverageReconciliation}, reported per side in `coverage_reconciliation`):
 *
 *   type_filter null          `'rows'` — every active rule is in the denominator, so the rows'
 *                             blocking-fired ids are exercised rules: `exercised ≥ |fired|`, and
 *                             the exercised set is complete iff `exercised === |fired|`.
 *   type_filter T, per_type   `'per_type'` — reconciled against the engine's OWN row for the slice
 *   present                   (`rule_coverage.per_type[T]`, `TypeCoverage` lines 300-303):
 *                             `per_type[T].exercised === exercised`; the rows' fired ids carry no
 *                             steering type and are NOT a denominator check.
 *   type_filter T, no         `'n/a (engine reports no per-type coverage)'` — the record carries
 *   per_type                  nothing to check its slice against; nothing fired-based is asserted.
 *
 * Whatever the filter: `per_type`, when present, must sum to `exercised` and agree per type with the
 * listed `unexercised` rows; under a filter every listed row is of the filter's type; no id is
 * listed twice; and no listed-unexercised id fired — that row TYPES the rule into the slice, and a
 * blocking firing is a firing, which makes an eligible rule exercised (862-873) — so this last check
 * is sound under a filter too (the fix brief's floor was "unfiltered only"; the engine's definition
 * makes it general).
 *
 * Two runs under DIFFERENT filters get NO `rule_coverage_delta` (an inventory diff across
 * denominators would report the other slice's rules as changes) and are not comparable. Under the
 * SAME filter T the delta is computed exactly as unfiltered — `gained`/`lost` from ids listed on both
 * ends (the unexercised row carries `steering_type: T`, the firing is a firing), every one-sided id
 * withheld — except that `unidentified` is the whole `exercised` count (see above) and each withheld
 * reason adds that the id may be a rule of another type outside the denominator.
 *
 * # Malformed persisted coverage (codex round 8)
 *
 * The daemon persists a run's `rule_coverage` verbatim and validates none of it (the script's
 * `verifyEngineReport` gates only its own reports). A recorded `rule_coverage` that is not the wire
 * shape — `null`; `unexercised` not an array; `per_type: null`, a row that is not `{ exercised,
 * unexercised }` of non-negative integers, a key that is no steering type … — cannot be reconciled:
 * that side is `coverage_reconciliation: 'unverified (malformed rule_coverage)'`
 * ({@link MALFORMED_RULE_COVERAGE}), a reconciliation error names the run and the defect, no
 * `rule_coverage_delta` is computed, and the comparison never throws over persisted data.
 *
 * # Malformed persisted result rows (Copilot on #475)
 *
 * The same store validates a detail's `results` only as "an array" (`EvalRunStore.get()`), so a row
 * that is not the wire shape (`GovernanceEvalResult` — no `sample`, `sample.id` not a non-empty
 * string, a `kind` or `verdict` outside its union, `fired` not an array of strings, a row that is no
 * object at all) can reach the comparison from a corrupted or hand-edited file. Every row is checked
 * ({@link resultRowProblem}) BEFORE it is indexed, tallied or iterated: a malformed one is ONE
 * reconciliation error naming the run, the index and the defect, and is EXCLUDED from everything —
 * the id index, the identity counts, the tally, the coverage `fired` set. The pair is then not
 * comparable ({@link MALFORMED_RESULT_ROWS}), and that side's stored summary is NOT checked against a
 * results list the comparison could not fully read (the shortfall is the excluded rows, not a summary
 * defect — reporting it as one would misattribute it). Never a throw.
 */

import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSummary, GovernanceEvalTypeCoverage, SteeringType } from '../core/types.js';
import { PAYLOAD_HASH_RE } from './eval-sample.js';
import { STEERING_TYPE_VALUES, STEERING_TYPES } from './governance-steering.js';

export type EvalVerdict = GovernanceEvalResult['verdict'];
export type EvalSampleKind = GovernanceEvalResult['sample']['kind'];
export type FlipClass = 'permitted' | 'flagged';

/** The exact prefix of `comparable_reason` when a side carries result rows without a payload hash. */
export const UNVERIFIED_NO_SAMPLE_IDENTITY = 'unverified: no sample identity';

/** The exact prefix of `comparable_reason` when the two runs were produced under different type filters. */
export const DIFFERING_TYPE_FILTER = 'differing-type-filter';

/** One identity dimension, side by side. */
export interface IdentityPair<T> {
  a: T;
  b: T;
  same: boolean;
}

/** One sample whose verdict differs between the two runs. */
export interface EvalVerdictFlip {
  sample_id: string;
  /** The sample's kind in run B (equal to run A's unless the id is also in `kind_changed`). */
  kind: EvalSampleKind;
  from: EvalVerdict;
  to: EvalVerdict;
  classification: FlipClass;
  reason: string;
}

/** Whether the two records LIST their rule sets. `complete` requires an explicit rule inventory on
 *  BOTH records; no field of `GovernanceEvalRuleCoverage` (api-types 0.27.0) carries one — `exercised`
 *  and `recall_only` are counts, `unexercised` names only the unexercised rules, a row's `fired` only
 *  the blocking firings — so every comparison of daemon-recorded runs is `partial` and the rule-set
 *  transitions are withheld by name. See the module doc. */
export type EvalRuleInventory = 'complete' | 'partial';

/** The exact `coverage_reconciliation` value of a side whose persisted `rule_coverage` is not the wire
 *  shape — unverified, not reconciled, no delta computed over it (module doc, "Malformed persisted
 *  coverage"). */
export const MALFORMED_RULE_COVERAGE = 'unverified (malformed rule_coverage)';

/** The `comparable_reason` prefix of a pair one side of which persisted result rows that are not the
 *  wire shape (api-types `GovernanceEvalResult`, module doc "Malformed persisted result rows"): each
 *  is named in `reconciliation_errors` and EXCLUDED, never thrown over — and a comparison over a
 *  record it could not fully read asserts nothing (Copilot on #475). */
export const MALFORMED_RESULT_ROWS = 'unverified: malformed result row(s)';

/**
 * How one record's `rule_coverage` was reconciled — which denominator its numbers were checked
 * against (module doc, "Type filters"):
 *   - `'rows'` — `type_filter` null: every active rule is in the denominator, so the rows' distinct
 *     blocking-fired ids are exercised rules and `exercised ≥ |fired|` is checked;
 *   - `'per_type'` — `type_filter` set and `per_type` present: checked against the engine's own row
 *     for that type, `per_type[<filter>]`; the rows' fired ids may belong to other types;
 *   - `'n/a (engine reports no per-type coverage)'` — `type_filter` set and no `per_type`: the
 *     denominator is the filter's slice and the record carries no number to check it against;
 *   - {@link MALFORMED_RULE_COVERAGE} — the persisted value is not the wire shape: nothing was
 *     checked, a reconciliation error names the defect, no delta is computed over this side.
 */
export type EvalCoverageReconciliation = 'rows' | 'per_type' | 'n/a (engine reports no per-type coverage)' | typeof MALFORMED_RULE_COVERAGE;

/** Which rules gained or lost exercise between the runs (present only when BOTH carry WELL-FORMED
 *  coverage AND both were produced under the same `type_filter`). */
export interface EvalRuleCoverageDelta {
  /** `b.rule_coverage.exercised − a.rule_coverage.exercised` — the counts, always. */
  exercised_delta: number;
  /** `partial` for every comparison of daemon-recorded runs: the wire carries no rule inventory, so
   *  `added_rules`/`removed_rules` are never asserted and every one-sided id is in
   *  `transitions_withheld`. `complete` is reserved for two records that LIST their rule sets. */
  inventory: EvalRuleInventory;
  /** Per side, how many exercised rules of its denominator the record counts but does not name —
   *  a fact about THAT record alone, never reduced by what the other run lists. Unfiltered:
   *  `rule_coverage.exercised − |distinct blocking-fired ids|` (the rules exercised by a `warn`
   *  effect alone). Under a type filter: `rule_coverage.exercised` — a fired id carries no
   *  steering_type, so the record types none of its own firings into the slice. */
  unidentified: { a: number; b: number };
  /** Unexercised in A (listed) AND blocking-fired in B (listed) — a sample now exercises the rule.
   *  A statement about the RULE, certain on both ends whatever the filter (under one, the id is typed
   *  into the slice by A's row alone — B's `unidentified` does not subtract it). */
  gained: string[];
  /** Blocking-fired in A AND unexercised in B (listed) — a rule nothing exercises any more. Certain. */
  lost: string[];
  /** Enumerated by B and not by A AND absent from A's explicit rule inventory — the wire carries no
   *  inventory, so this is EMPTY for every daemon-recorded run (the candidates are in
   *  `transitions_withheld`). */
  added_rules: string[];
  /** Enumerated by A and not by B AND absent from B's explicit rule inventory — EMPTY for the same
   *  reason. */
  removed_rules: string[];
  /** Every id enumerated (unexercised or blocking-fired) by one record and not the other, one reason
   *  per id, codepoint-sorted — what the id may be besides a rule-set change: an exercised rule the
   *  silent side never names (a `warn`-only firing; under a type filter any of its firings), an
   *  effect-less (recall-only) or retired rule outside the eligible partition, under a type filter a
   *  rule of another type outside the denominator. WITHHELD, never guessed. */
  transitions_withheld: string[];
}

export interface EvalRunComparison {
  /** The two run ids, in the order given (A = the baseline, B = the candidate). */
  a: string;
  b: string;
  identity: {
    corpus: IdentityPair<string | null>;
    rule_store: IdentityPair<string>;
    type_filter: IdentityPair<SteeringType | null>;
    degraded: IdentityPair<'facet-only' | null>;
  };
  /** Same corpus name, same type filter, same sample ids, same kinds, same payload identities on
   *  every row — the same actions were judged over the same slice, provably. */
  comparable: boolean;
  /** Why `comparable` is false (`;`-joined when several apply; starts with
   *  {@link UNVERIFIED_NO_SAMPLE_IDENTITY} when a side carries rows without a payload hash, contains
   *  {@link DIFFERING_TYPE_FILTER} when the filters differ), or `null` when it is true. */
  comparable_reason: string | null;
  /** Every per-sample verdict change, codepoint-sorted by sample id, each classified. */
  flips: EvalVerdictFlip[];
  /** Shared samples with the same kind AND the same verdict on both sides, minus those whose payload
   *  identity is VERIFIED to differ (`payload_changed`). A row unverified on either side (no
   *  well-formed `payload_hash`) still counts when kind and verdict agree — `unchanged` is a verdict
   *  statement, not proof of payload identity; `comparable` / `unverified_rows` carry that claim. */
  unchanged: number;
  only_in_a: string[];
  only_in_b: string[];
  /** Shared ids whose `kind` differs — the corpus changed under this name (always flagged). */
  kind_changed: string[];
  /** Shared ids whose `payload_hash` differs on the two sides (both present) — the description,
   *  steering type or signals changed under the same id and kind: the corpus changed under this
   *  name (a flip on such an id is always flagged). */
  payload_changed: string[];
  /** Result rows WITHOUT a `sample.payload_hash`, per side — the rows whose identity is unverified. */
  unverified_rows: { a: number; b: number };
  /** `b.summary − a.summary`, field by field. */
  summary_delta: GovernanceEvalSummary;
  /** Each run's summary equals its own results' tally AND the delta equals the flip/add/remove
   *  accounting AND each run's coverage is well-formed and does not contradict itself (see
   *  `coverage_reconciliation` for what it was checked against) — a stored record that disagrees
   *  with ITSELF, or carries a `rule_coverage` that is not the wire shape, is a defect, not a flip.
   *  Two valid records always reconcile; an exercised count ABOVE the fired ids is valid (warn-only
   *  exercise), and so is a fired id outside a filtered run's denominator. */
  reconciles: boolean;
  reconciliation_errors: string[];
  /** Per side, how the record's `rule_coverage` was reconciled ({@link EvalCoverageReconciliation};
   *  {@link MALFORMED_RULE_COVERAGE} when the persisted value is not the wire shape), or `null` when
   *  that side carries no coverage (a pre-#394 engine). */
  coverage_reconciliation: { a: EvalCoverageReconciliation | null; b: EvalCoverageReconciliation | null };
  /** Present only when BOTH sides carry WELL-FORMED coverage AND `identity.type_filter.same`. */
  rule_coverage_delta?: EvalRuleCoverageDelta;
}

/** The S17 rule table, as a function. Exported so a caller can classify a single flip. */
export function classifyFlip(kind: EvalSampleKind, from: EvalVerdict, to: EvalVerdict): { classification: FlipClass; reason: string } {
  if (kind === 'bad') {
    if (from === 'gap' && to === 'caught') return { classification: 'permitted', reason: 'a rule tightened: a bad behavior is now caught' };
    if (from === 'caught' && to === 'gap') return { classification: 'flagged', reason: 'regression: a bad behavior is no longer caught' };
  } else {
    if (from === 'false_positive' && to === 'caught') return { classification: 'permitted', reason: 'a good sample is no longer denied' };
    if (from === 'caught' && to === 'false_positive') return { classification: 'flagged', reason: 'a good sample is newly denied' };
  }
  return {
    classification: 'flagged',
    reason: `inconsistent: ${from} → ${to} is not a verdict pair a ${kind} sample can take (a bad sample is caught|gap, a good sample is caught|false_positive)`,
  };
}

/** Compare two recorded runs — A is the baseline, B the candidate. See the module doc. */
export function compareEvalRuns(a: EvalRunDetail, b: EvalRunDetail): EvalRunComparison {
  const errors: string[] = [];
  // Only WELL-FORMED rows take part (module doc, "Malformed persisted result rows"): the store
  // validated `results` as an array and nothing more, so every row is checked here BEFORE it is
  // indexed, tallied or iterated — a malformed one is named in `errors` and excluded, never thrown over.
  const rowsA = wellFormedRows(a, 'a', errors);
  const rowsB = wellFormedRows(b, 'b', errors);
  const malformed_rows = { a: a.results.length - rowsA.length, b: b.results.length - rowsB.length };
  const mapA = indexById(rowsA, a, 'a', errors);
  const mapB = indexById(rowsB, b, 'b', errors);

  const only_in_a = [...mapA.keys()].filter((id) => !mapB.has(id)).sort(codepoint);
  const only_in_b = [...mapB.keys()].filter((id) => !mapA.has(id)).sort(codepoint);
  const shared = [...mapA.keys()].filter((id) => mapB.has(id)).sort(codepoint);

  const flips: EvalVerdictFlip[] = [];
  const kind_changed: string[] = [];
  const payload_changed: string[] = [];
  let unchanged = 0;
  for (const id of shared) {
    const ra = mapA.get(id)!;
    const rb = mapB.get(id)!;
    const kindChanged = ra.sample.kind !== rb.sample.kind;
    const ha = identityOf(ra);
    const hb = identityOf(rb);
    const payloadChanged = ha !== null && hb !== null && ha !== hb;
    if (kindChanged) kind_changed.push(id);
    if (payloadChanged) payload_changed.push(id);
    if (ra.verdict !== rb.verdict) {
      let verdictClass: { classification: FlipClass; reason: string };
      if (kindChanged) {
        verdictClass = {
          classification: 'flagged',
          reason: `the sample's kind changed between runs (${ra.sample.kind} → ${rb.sample.kind}): the corpus changed under this name`,
        };
      } else if (payloadChanged) {
        verdictClass = {
          classification: 'flagged',
          reason: "the sample's payload changed between runs (description, steering_type or signals): the corpus changed under this name",
        };
      } else {
        verdictClass = classifyFlip(rb.sample.kind, ra.verdict, rb.verdict);
      }
      flips.push({ sample_id: id, kind: rb.sample.kind, from: ra.verdict, to: rb.verdict, ...verdictClass });
    } else if (!kindChanged && !payloadChanged) {
      unchanged += 1;
    }
  }
  const unverified_rows = {
    a: rowsA.filter((r) => identityOf(r) === null).length,
    b: rowsB.filter((r) => identityOf(r) === null).length,
  };

  // Each run's summary must be its own results' tally — a disagreement is a stored defect, and a
  // delta over a defective summary would attribute it to a flip.
  // A side whose results could not be FULLY read is not checked here: its tally over the well-formed
  // rows is short by exactly the excluded (already named) rows, and reporting that shortfall as a
  // summary defect would misattribute it. The record is already `reconciles: false`.
  for (const [run, rows, label] of [
    [a, rowsA, 'a'],
    [b, rowsB, 'b'],
  ] as const) {
    if (rows.length !== run.results.length) continue;
    const own = tally(rows);
    if (!sameSummary(own, run.summary)) {
      errors.push(`run ${label} (${run.id}): stored summary ${fmt(run.summary)} does not match its own results ${fmt(own)}`);
    }
  }
  const summary_delta: GovernanceEvalSummary = {
    total: b.summary.total - a.summary.total,
    caught: b.summary.caught - a.summary.caught,
    gaps: b.summary.gaps - a.summary.gaps,
    false_positives: b.summary.false_positives - a.summary.false_positives,
  };
  // The per-sample accounting the delta must equal: every flip moves one count from `from` to
  // `to`; a sample only in B adds its verdict, one only in A removes it.
  const expected: GovernanceEvalSummary = { total: only_in_b.length - only_in_a.length, caught: 0, gaps: 0, false_positives: 0 };
  for (const f of flips) {
    expected[field(f.to)] += 1;
    expected[field(f.from)] -= 1;
  }
  for (const id of only_in_b) expected[field(mapB.get(id)!.verdict)] += 1;
  for (const id of only_in_a) expected[field(mapA.get(id)!.verdict)] -= 1;
  // Withheld, for the same reason, when either side carries excluded rows: the stored summaries count
  // rows the per-sample accounting could not read.
  if (malformed_rows.a === 0 && malformed_rows.b === 0 && !sameSummary(expected, summary_delta)) {
    errors.push(`summary delta ${fmt(summary_delta)} does not reconcile to the per-sample accounting ${fmt(expected)}`);
  }

  const identity = {
    corpus: pair(a.corpus, b.corpus),
    rule_store: pair(a.rule_store, b.rule_store),
    type_filter: pair(a.type_filter, b.type_filter),
    degraded: pair(a.degraded, b.degraded),
  };

  // Why the pair is not comparable, in verification order: a side with excluded (malformed) rows,
  // then an unverified side, first (nothing below can be asserted about actions whose identity is
  // unknown), then the identity and content differences.
  const reasons: string[] = [];
  if (malformed_rows.a > 0 || malformed_rows.b > 0) {
    reasons.push(`${MALFORMED_RESULT_ROWS} (${malformed_rows.a} result row(s) in a and ${malformed_rows.b} in b are not the wire shape — each named in reconciliation_errors and excluded)`);
  }
  if (unverified_rows.a > 0 || unverified_rows.b > 0) {
    reasons.push(`${UNVERIFIED_NO_SAMPLE_IDENTITY} (${unverified_rows.a} result row(s) in a and ${unverified_rows.b} in b carry no well-formed sample.payload_hash)`);
  }
  if (!identity.corpus.same) reasons.push(`corpus name differs (${JSON.stringify(a.corpus)} vs ${JSON.stringify(b.corpus)})`);
  if (!identity.type_filter.same) {
    reasons.push(
      `${DIFFERING_TYPE_FILTER} (a: ${JSON.stringify(a.type_filter)}, b: ${JSON.stringify(b.type_filter)}): the runs judged different slices of the corpus over different coverage denominators`,
    );
  }
  if (only_in_a.length > 0 || only_in_b.length > 0) {
    reasons.push(`sample set differs (${only_in_a.length} id(s) only in a, ${only_in_b.length} only in b)`);
  }
  if (kind_changed.length > 0) reasons.push(`kind changed for ${kind_changed.length} shared sample(s)`);
  if (payload_changed.length > 0) reasons.push(`payload changed for ${payload_changed.length} shared sample(s) (description, steering_type or signals)`);

  // Each record's coverage is reconciled ON ITS OWN whenever it carries one — a record that
  // contradicts itself is a defect whether or not the other side measured coverage. Coverage is
  // OPTIONAL on a record (a pre-#394 engine emits none: `undefined` here); a PRESENT value that is
  // not the wire shape is named as a defect and never thrown over (`null` here).
  const covA = a.rule_coverage === undefined ? undefined : reconcileCoverage(a, rowsA, 'a', errors);
  const covB = b.rule_coverage === undefined ? undefined : reconcileCoverage(b, rowsB, 'b', errors);
  const modeOf = (cov: CoverageFacts | null | undefined): EvalCoverageReconciliation | null => (cov === undefined ? null : cov === null ? MALFORMED_RULE_COVERAGE : cov.mode);

  const comparison: EvalRunComparison = {
    a: a.id,
    b: b.id,
    identity,
    comparable: reasons.length === 0,
    comparable_reason: reasons.length === 0 ? null : reasons.join('; '),
    flips,
    unchanged,
    only_in_a,
    only_in_b,
    kind_changed,
    payload_changed,
    unverified_rows,
    summary_delta,
    reconciles: true,
    reconciliation_errors: errors,
    coverage_reconciliation: { a: modeOf(covA), b: modeOf(covB) },
  };
  // The delta exists only when both sides measured WELL-FORMED coverage over the SAME denominator —
  // never fabricated from one side, never over a malformed record, never across two different slices.
  if (covA && covB && identity.type_filter.same) {
    comparison.rule_coverage_delta = coverageDelta(covA, covB, a.type_filter);
  }
  comparison.reconciles = errors.length === 0;
  return comparison;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Codepoint order — deterministic on every machine (`localeCompare` is locale-bound). */
function codepoint(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function pair<T>(a: T, b: T): IdentityPair<T> {
  return { a, b, same: a === b };
}

/** The row's stamped payload identity — only when it is WELL-FORMED (`PAYLOAD_HASH_RE`: `sha256:`
 *  + 64 lowercase hex, the one spelling `samplePayloadHash` produces). Anything else — none, an
 *  empty string, another algorithm, uppercase, a truncated digest — is null: the row is UNVERIFIED,
 *  never treated as an authoritative identity that could mark a pair comparable or "changed"
 *  (the value comes from persisted run data; Copilot on #475). */
function identityOf(r: GovernanceEvalResult): string | null {
  const h = r.sample.payload_hash;
  return typeof h === 'string' && PAYLOAD_HASH_RE.test(h) ? h : null;
}

const RESULT_KINDS: ReadonlySet<string> = new Set(['good', 'bad']);
const RESULT_VERDICTS: ReadonlySet<string> = new Set(['caught', 'gap', 'false_positive']);

/**
 * Why a persisted result row is not the wire shape (api-types `GovernanceEvalResult`) in the fields
 * this comparison READS — `sample.id` (a non-empty string), `sample.kind` (`good|bad`), `verdict`
 * (`caught|gap|false_positive`), `fired` (an array of rule ids) — or null when it is. Checked BEFORE
 * any row is indexed, tallied or iterated: `EvalRunStore.get()` validates only that `results` is an
 * array, so a corrupted or hand-edited detail file can carry a row without a `sample`, with
 * `fired: null`, or with a verdict `field()` maps nowhere (Copilot on #475: `identityOf` / `indexById`
 * threw, `tally` would count into an undefined field). `payload_hash` is not checked here —
 * `identityOf` already treats anything malformed as no identity.
 */
function resultRowProblem(r: unknown): string | null {
  if (!isPlainObject(r)) return `expected an object { sample, verdict, fired }, got ${JSON.stringify(r)}`;
  const sample: unknown = r['sample'];
  if (!isPlainObject(sample)) return `sample ${JSON.stringify(sample)} is not an object { id, kind }`;
  if (typeof sample['id'] !== 'string' || sample['id'] === '') return `sample.id ${JSON.stringify(sample['id'])} is not a non-empty string`;
  if (typeof sample['kind'] !== 'string' || !RESULT_KINDS.has(sample['kind'])) return `sample.kind ${JSON.stringify(sample['kind'])} is not good|bad`;
  if (typeof r['verdict'] !== 'string' || !RESULT_VERDICTS.has(r['verdict'])) return `verdict ${JSON.stringify(r['verdict'])} is not caught|gap|false_positive`;
  const fired: unknown = r['fired'];
  if (!Array.isArray(fired) || !fired.every((id: unknown) => typeof id === 'string')) return `fired ${JSON.stringify(fired)} is not an array of rule ids`;
  return null;
}

/** The run's WELL-FORMED result rows ({@link resultRowProblem}). Every other row is ONE reconciliation
 *  error naming the run, the row's index and the defect, and takes no part in the comparison. */
function wellFormedRows(run: EvalRunDetail, label: 'a' | 'b', errors: string[]): GovernanceEvalResult[] {
  const rows: GovernanceEvalResult[] = [];
  for (const [i, r] of run.results.entries()) {
    const problem = resultRowProblem(r);
    if (problem === null) rows.push(r);
    else {
      errors.push(
        `run ${label} (${run.id}): results[${i}] is malformed — ${problem} — not the wire shape (api-types GovernanceEvalResult), so it is excluded from the per-sample comparison, the identity counts, the tally and the coverage reconciliation`,
      );
    }
  }
  return rows;
}

/** The run's well-formed results by sample id. A duplicate id inside ONE run (the engine rejects them
 *  at import — an edited record could still carry one) is a reconciliation error, and the last row wins. */
function indexById(rows: GovernanceEvalResult[], run: EvalRunDetail, label: 'a' | 'b', errors: string[]): Map<string, GovernanceEvalResult> {
  const map = new Map<string, GovernanceEvalResult>();
  for (const r of rows) {
    if (map.has(r.sample.id)) errors.push(`run ${label} (${run.id}): duplicate sample id ${r.sample.id} in results`);
    map.set(r.sample.id, r);
  }
  return map;
}

/** What one record's coverage lets us KNOW about its rule set, and what it was reconciled against
 *  (`mode`). `fired` is every distinct rule id in `results[].fired` — the BLOCKING firings (evals.rs
 *  `evaluate_sample`, `Effect::Deny` only) — in the denominator only when `type_filter` is null
 *  (module doc, "Type filters"). */
interface CoverageFacts {
  mode: Exclude<EvalCoverageReconciliation, typeof MALFORMED_RULE_COVERAGE>;
  exercised: number;
  unexercised: Set<string>;
  fired: Set<string>;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isCount(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0;
}

/**
 * Why a persisted `rule_coverage` is not the wire shape (api-types `GovernanceEvalRuleCoverage`
 * 0.27.0), or null when it is — checked BEFORE any field is read, because the store writes the
 * engine's value verbatim and the comparison must name a malformed record, never throw over it
 * (codex round 8: `per_type: null` made `Object.values` throw). The shape: `exercised` a non-negative
 * integer; `unexercised` an array of `{ rule_id: non-empty string, steering_type: one of the seven }`;
 * `recall_only`, when present, a non-negative integer; `per_type`, when present, a plain object whose
 * keys are steering types and whose values are `{ exercised, unexercised }` of non-negative integers.
 */
function coverageShapeProblem(rc: unknown): string | null {
  if (!isPlainObject(rc)) return `expected an object { exercised, unexercised[] }, got ${JSON.stringify(rc)}`;
  if (!isCount(rc['exercised'])) return `exercised ${JSON.stringify(rc['exercised'])} is not a non-negative integer`;
  const unexercised: unknown = rc['unexercised'];
  if (!Array.isArray(unexercised)) return `unexercised ${JSON.stringify(unexercised)} is not an array`;
  for (const [i, u] of unexercised.entries()) {
    if (!isPlainObject(u) || typeof u['rule_id'] !== 'string' || u['rule_id'] === '') return `unexercised[${i}] carries no string rule_id (got ${JSON.stringify(u)})`;
    if (typeof u['steering_type'] !== 'string' || !STEERING_TYPES.has(u['steering_type'])) {
      return `unexercised[${i}] (${u['rule_id']}) steering_type ${JSON.stringify(u['steering_type'])} is not one of ${STEERING_TYPE_VALUES.join('|')}`;
    }
  }
  if (rc['recall_only'] !== undefined && !isCount(rc['recall_only'])) return `recall_only ${JSON.stringify(rc['recall_only'])} is not a non-negative integer`;
  const perType: unknown = rc['per_type'];
  if (perType !== undefined) {
    if (!isPlainObject(perType)) return `per_type ${JSON.stringify(perType)} is not an object keyed by steering type`;
    for (const [t, row] of Object.entries(perType)) {
      if (!STEERING_TYPES.has(t)) return `per_type key ${JSON.stringify(t)} is not one of ${STEERING_TYPE_VALUES.join('|')}`;
      if (!isPlainObject(row)) return `per_type.${t} ${JSON.stringify(row)} is not an object { exercised, unexercised }`;
      for (const k of ['exercised', 'unexercised']) {
        if (!isCount(row[k])) return `per_type.${t}.${k} ${JSON.stringify(row[k])} is not a non-negative integer`;
      }
    }
  }
  return null;
}

/**
 * Reconcile one record's `rule_coverage` with ITSELF and with its rows, pushing every contradiction
 * to `errors` (naming the run), and say what it was checked against (`mode`). A value that is not
 * the wire shape (`coverageShapeProblem`) is ONE error naming the defect and `null` — nothing else is
 * read from it. Whatever the filter: no duplicate unexercised id; `per_type`, when present, sums to
 * `exercised` and agrees per type with the listed rows; no listed-unexercised id fired (the row types
 * the rule into the slice; a firing makes an eligible rule exercised — evals.rs 862-873). Unfiltered
 * (`'rows'`): `exercised` is at least the distinct blocking-fired ids. Filtered: every listed row is
 * of the filter's type, and with `per_type` present (`'per_type'`) the slice's own row equals the
 * total — the rows' fired ids may name rules of other types and are NOT a denominator check; without
 * `per_type` (`'n/a …'`) nothing more can be checked.
 */
function reconcileCoverage(run: EvalRunDetail, rows: GovernanceEvalResult[], label: 'a' | 'b', errors: string[]): CoverageFacts | null {
  const who = `run ${label} (${run.id})`;
  const malformed = coverageShapeProblem(run.rule_coverage);
  if (malformed !== null) {
    errors.push(`${who}: rule_coverage is malformed — ${malformed} — not the wire shape (api-types GovernanceEvalRuleCoverage), so it is not reconciled and no coverage delta is computed over it`);
    return null;
  }
  const rc = run.rule_coverage!;
  const filter = run.type_filter;
  const fired = new Set<string>();
  for (const r of rows) for (const id of r.fired) fired.add(id);
  const unexercised = new Set<string>();
  const listedByType = new Map<string, number>();
  for (const u of rc.unexercised) {
    if (unexercised.has(u.rule_id)) errors.push(`${who}: rule_coverage.unexercised lists ${u.rule_id} twice — a rule is unexercised once or not at all`);
    unexercised.add(u.rule_id);
    listedByType.set(u.steering_type, (listedByType.get(u.steering_type) ?? 0) + 1);
    if (filter !== null && u.steering_type !== filter) {
      errors.push(
        `${who}: rule_coverage.unexercised lists ${u.rule_id} (${u.steering_type}) under type filter ${filter} — the slice's eligible rules are all of the filter's type (evals.rs decide_lane_rules in_slice)`,
      );
    }
    if (fired.has(u.rule_id)) {
      errors.push(`${who}: rule_coverage.unexercised lists ${u.rule_id}, which fired (blocking) in its results — a rule that fired for any sample is exercised, never unexercised`);
    }
  }
  // `per_type` is read as possibly incomplete: a persisted record is verbatim, and a row missing
  // for a type is a contradiction to NAME, not an index to crash on.
  const perType = rc.per_type as Partial<Record<string, GovernanceEvalTypeCoverage>> | undefined;
  if (perType !== undefined) {
    let sumExercised = 0;
    for (const row of Object.values(perType)) if (row !== undefined) sumExercised += row.exercised;
    if (sumExercised !== rc.exercised) {
      errors.push(`${who}: rule_coverage.per_type sums to ${sumExercised} exercised but rule_coverage.exercised is ${rc.exercised} — the per-type rows partition the same eligible rules`);
    }
    for (const t of [...new Set([...Object.keys(perType), ...listedByType.keys()])].sort(codepoint)) {
      const counted = perType[t]?.unexercised;
      const listed = listedByType.get(t) ?? 0;
      if (counted === undefined) errors.push(`${who}: rule_coverage.unexercised lists ${listed} ${t} rule(s) but rule_coverage.per_type carries no ${t} row`);
      else if (counted !== listed) errors.push(`${who}: rule_coverage.per_type.${t}.unexercised is ${counted} but rule_coverage.unexercised lists ${listed} ${t} rule(s)`);
    }
  }
  const facts = { exercised: rc.exercised, unexercised, fired };
  if (filter === null) {
    if (rc.exercised < fired.size) {
      errors.push(
        `${who}: rule_coverage.exercised ${rc.exercised} is below the ${fired.size} distinct rule id(s) fired (blocking) across its results (${[...fired].sort(codepoint).join(', ')}) — every blocking firing is an exercised rule`,
      );
    }
    return { mode: 'rows', ...facts };
  }
  if (perType === undefined) return { mode: 'n/a (engine reports no per-type coverage)', ...facts };
  const slice = perType[filter];
  if (slice === undefined) {
    errors.push(`${who}: rule_coverage.per_type carries no ${filter} row although the run was filtered to ${filter} — the slice's own numbers are missing`);
  } else if (slice.exercised !== rc.exercised) {
    errors.push(
      `${who}: rule_coverage.per_type.${filter}.exercised is ${slice.exercised} but rule_coverage.exercised is ${rc.exercised} — under type filter ${filter} the eligible rules are exactly the ${filter} slice (evals.rs decide_lane_rules), so the slice's row IS the total`,
    );
  }
  return { mode: 'per_type', ...facts };
}

/**
 * The delta of two records produced under the SAME `type_filter` (`filter`), over what they ENUMERATE
 * (module doc, "Coverage transitions vs. rule-set changes"): `gained`/`lost` from ids listed on both
 * ends, `unidentified` per record, and EVERY one-sided id withheld with its reason — the wire carries
 * no rule inventory, so `added_rules`/`removed_rules` are never asserted and `inventory` is `partial`.
 */
function coverageDelta(covA: CoverageFacts, covB: CoverageFacts, filter: SteeringType | null): EvalRuleCoverageDelta {
  // Certain, both ends listed: the unexercised row names the id on one side, the blocking firing on
  // the other (under a filter the row carries the filter's steering_type; a firing is a firing).
  const gained = [...covA.unexercised].filter((id) => covB.fired.has(id)).sort(codepoint);
  const lost = [...covA.fired].filter((id) => covB.unexercised.has(id)).sort(codepoint);
  const unidentified = { a: unidentifiedOf(covA, filter), b: unidentifiedOf(covB, filter) };
  // The identities each record ENUMERATES — its unexercised list plus its blocking-fired ids.
  // Nothing else about a run's rule set is on the wire, so an id the other side does not enumerate
  // is a candidate for a rule-set change and NOTHING more: withheld, with what else it may be.
  const knownA = new Set([...covA.unexercised, ...covA.fired]);
  const knownB = new Set([...covB.unexercised, ...covB.fired]);
  const withheld = [
    ...[...knownB].filter((id) => !knownA.has(id)).map((id) => withheldReason('added_rules', id, covB, unidentified.a, filter)),
    ...[...knownA].filter((id) => !knownB.has(id)).map((id) => withheldReason('removed_rules', id, covA, unidentified.b, filter)),
  ].sort(codepoint);
  return {
    exercised_delta: covB.exercised - covA.exercised,
    inventory: 'partial',
    unidentified,
    gained,
    lost,
    added_rules: [],
    removed_rules: [],
    transitions_withheld: withheld,
  };
}

/** How many exercised rules of its denominator ONE record does not name. Unfiltered, every
 *  blocking-fired id is an exercised rule of the (universal) denominator, so `exercised − |fired|`
 *  (floored at 0: an undercut was already reported as a reconciliation error). Under a type filter a
 *  fired id carries no steering_type — the record types none of its own firings into the slice — so
 *  the whole count; what the OTHER run lists never reduces it (codex round 8). */
function unidentifiedOf(cov: CoverageFacts, filter: SteeringType | null): number {
  return filter === null ? Math.max(0, cov.exercised - cov.fired.size) : cov.exercised;
}

/** Why an id enumerated by one record (`lister`: b for `added_rules`, a for `removed_rules`) and not
 *  by the other is withheld instead of asserted as a rule-set change — one sentence naming what the
 *  id may be instead. `silentUnidentified` is the silent side's `unidentified` count. */
function withheldReason(kind: 'added_rules' | 'removed_rules', id: string, lister: CoverageFacts, silentUnidentified: number, filter: SteeringType | null): string {
  const [listerLabel, silent] = kind === 'added_rules' ? ['b', 'a'] : ['a', 'b'];
  const listedAs = lister.unexercised.has(id) ? 'unexercised' : 'blocking-fired';
  const maybe: string[] = [];
  if (silentUnidentified > 0) {
    maybe.push(
      `one of ${silent}'s ${silentUnidentified} exercised rule(s) named nowhere (${filter === null ? 'fired by a non-blocking effect alone' : `under type filter ${filter} no fired id is typed into the slice`})`,
    );
  }
  maybe.push('an effect-less (recall-only) or retired rule outside the eligible partition');
  if (filter !== null) maybe.push(`a rule of another type outside the ${filter} denominator (a row's fired ids carry no steering_type)`);
  const change = `a rule the store ${kind === 'added_rules' ? 'gained' : 'lost'}`;
  return (
    `${kind} ${id}: enumerated by ${listerLabel} (${listedAs}) and not by ${silent} — the wire lists no rule inventory (rule_coverage.exercised and recall_only are counts; only unexercised and blocking-fired ids are named), ` +
    `so ${silent}'s silence is not absence: ${id} may be ${maybe.join(', ')} or ${change}: not asserted`
  );
}

function field(v: EvalVerdict): 'caught' | 'gaps' | 'false_positives' {
  return v === 'caught' ? 'caught' : v === 'gap' ? 'gaps' : 'false_positives';
}

function tally(results: GovernanceEvalResult[]): GovernanceEvalSummary {
  const t: GovernanceEvalSummary = { total: results.length, caught: 0, gaps: 0, false_positives: 0 };
  for (const r of results) t[field(r.verdict)] += 1;
  return t;
}

function sameSummary(x: GovernanceEvalSummary, y: GovernanceEvalSummary): boolean {
  return x.total === y.total && x.caught === y.caught && x.gaps === y.gaps && x.false_positives === y.false_positives;
}

function fmt(s: GovernanceEvalSummary): string {
  return `{total ${s.total}, caught ${s.caught}, gaps ${s.gaps}, false_positives ${s.false_positives}}`;
}
