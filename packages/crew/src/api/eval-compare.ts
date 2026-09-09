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
 * # Coverage transitions vs. rule-set changes — and what a record CANNOT tell (codex round 6)
 *
 * The wire carries `rule_coverage.exercised` as a COUNT and `unexercised` as a LIST of ids
 * (api-types `GovernanceEvalRuleCoverage`; wicked-core `crates/wicked-governance/src/evals.rs` on
 * branch `feat/evals-effect-and-coverage` (core #394/#395, PR #398) at `a87e461` — `RuleCoverage`
 * lines 323-328: `exercised: usize`, `unexercised: Vec<UnexercisedRule>`, `recall_only: usize`,
 * `per_type: BTreeMap<String, TypeCoverage>`). A rule is EXERCISED when it appeared in ANY evaluated
 * claim's `policy_ids`, whatever its effect (`RuleCoverage` docs lines 312-314; `rule_coverage()`
 * lines 849-880 partitions the eligible rules by `triggered`, the union `run_evals` collects at
 * lines 987-991 of every claim's `policy_ids`). A result row's `fired`, however, is the BLOCKING
 * subset only: `evaluate_sample` lines 906-916 keep the ids whose effect is `Deny` and hand the full
 * `policy_ids` back separately (line 950). Hence, for an UNFILTERED run,
 *
 *   fired(run) ⊆ exercised(run), and `exercised − |fired|` rules were exercised by a non-blocking
 *   (`warn`) effect ALONE — counted, but NEVER named anywhere in the record.
 *
 * So the rule identities a record enumerates are exactly `unexercised ∪ fired`, and a run's rule
 * set is fully identified ("complete") only when `exercised === |fired|` — then the exercised set
 * IS the fired set. When `exercised > |fired|` the record has `unidentified` exercised rules and
 * its rule set is only partially known (`inventory: "partial"`). Reconstructing "the inventory"
 * as `unexercised ∪ fired` and diffing it was therefore unsound (codex round 6: a rule that went
 * from unexercised to exercised-by-warn vanished from the reconstruction and was reported as
 * `removed_rules`, with `reconciles: false` over two valid records). The delta asserts ONLY what
 * the records prove:
 *
 *   gained         unexercised in A (listed) AND blocking-fired in B (listed): certain, always
 *   lost           blocking-fired in A AND unexercised in B: certain, always
 *   added_rules    enumerated by B, not by A — asserted only when A's inventory is complete (A's
 *                  rule set is fully known, so "not enumerated by A" means "not in A")
 *   removed_rules  enumerated by A, not by B — asserted only when B's inventory is complete
 *   transitions_withheld
 *                  every added/removed candidate the partial side cannot settle (the id may be
 *                  one of that side's unidentified warn-exercised rules, or absent from its store),
 *                  one reason per id — WITHHELD, never guessed
 *
 * `exercised_delta` is always the difference of the two counts (a warn-only gain shows up there
 * with `unidentified` saying how many exercised ids the record does not carry). Reconciliation
 * errors on coverage are the record contradicting ITSELF; two valid reports always `reconcile`.
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
 * SAME filter T the delta's certainty changes, because a fired id is typed into the slice only when
 * the OTHER side lists it unexercised (that row carries `steering_type: T`):
 *
 *   gained / lost     unchanged — both ends listed; the unexercised row types the id
 *   unidentified      `exercised − |fired ids the other side lists unexercised|` (a: `− |lost|`,
 *                     b: `− |gained|`): how many exercised type-T rules the record cannot name
 *   added / removed   only ids LISTED unexercised on one side and not typed on the other, asserted
 *                     when the silent side is complete; a fired-only id (listed unexercised on
 *                     neither side) is ALWAYS withheld under a filter — it may be a rule of another
 *                     type outside the denominator — so `transitions_withheld` can be non-empty on a
 *                     `complete` inventory here (never when unfiltered).
 */

import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSummary, GovernanceEvalTypeCoverage, SteeringType } from '../core/types.js';
import { PAYLOAD_HASH_RE } from './eval-sample.js';

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

/** Whether both records identify EVERY exercised rule of their rule set (`unidentified` 0/0) or at
 *  least one counts exercised rules it does not name. See the module doc. */
export type EvalRuleInventory = 'complete' | 'partial';

/**
 * How one record's `rule_coverage` was reconciled — which denominator its numbers were checked
 * against (module doc, "Type filters"):
 *   - `'rows'` — `type_filter` null: every active rule is in the denominator, so the rows' distinct
 *     blocking-fired ids are exercised rules and `exercised ≥ |fired|` is checked;
 *   - `'per_type'` — `type_filter` set and `per_type` present: checked against the engine's own row
 *     for that type, `per_type[<filter>]`; the rows' fired ids may belong to other types;
 *   - `'n/a (engine reports no per-type coverage)'` — `type_filter` set and no `per_type`: the
 *     denominator is the filter's slice and the record carries no number to check it against.
 */
export type EvalCoverageReconciliation = 'rows' | 'per_type' | 'n/a (engine reports no per-type coverage)';

/** Which rules gained or lost exercise between the runs (present only when BOTH carry coverage AND
 *  both were produced under the same `type_filter`). */
export interface EvalRuleCoverageDelta {
  /** `b.rule_coverage.exercised − a.rule_coverage.exercised` — the counts, always. */
  exercised_delta: number;
  /** `complete` when both sides identify every exercised rule (so `added_rules`/`removed_rules`
   *  are asserted); `partial` when a side counts exercised rules it never names (then the
   *  unsettled transitions are in `transitions_withheld`). */
  inventory: EvalRuleInventory;
  /** Per side, how many exercised rules the record counts but does not identify. Unfiltered:
   *  `rule_coverage.exercised − |distinct blocking-fired ids|` (exercised by a `warn` effect alone).
   *  Under a type filter: `exercised − |fired ids the OTHER side lists unexercised|` — the only fired
   *  ids typed into the slice (a: `− |lost|`, b: `− |gained|`). 0/0 ⇔ complete. */
  unidentified: { a: number; b: number };
  /** Unexercised in A (listed) AND blocking-fired in B (listed) — a sample now exercises the rule.
   *  Certain on both sides, whatever the inventory or the filter. */
  gained: string[];
  /** Blocking-fired in A AND unexercised in B (listed) — a rule nothing exercises any more. Certain. */
  lost: string[];
  /** Enumerated by B and not by A, when A's inventory is COMPLETE — a rule the store gained between
   *  the runs (not a coverage change). Unfiltered, "enumerated" is unexercised-or-fired; under a
   *  type filter only a LISTED unexercised id qualifies (a fired id carries no type). Empty when A is
   *  partial. */
  added_rules: string[];
  /** Enumerated by A and not by B, when B's inventory is COMPLETE — a rule that vanished
   *  (deleted/retired) between the runs; NOT `gained`. Same enumeration rule. Empty when B is partial. */
  removed_rules: string[];
  /** The added/removed candidates a side cannot settle — one reason per id, codepoint-sorted by id:
   *  unfiltered, the candidates a PARTIAL side may hold among its unnamed warn-exercised rules
   *  (empty when `inventory` is `complete`); under a type filter also every blocking-fired id listed
   *  unexercised on neither side, whatever the inventory (it may be a rule of another type, outside
   *  the denominator). */
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
   *  accounting AND each run's coverage does not contradict itself (see `coverage_reconciliation`
   *  for what it was checked against) — a stored record that disagrees with ITSELF is a defect, not a
   *  flip. Two valid records always reconcile; an exercised count ABOVE the fired ids is valid
   *  (warn-only exercise), and so is a fired id outside a filtered run's denominator. */
  reconciles: boolean;
  reconciliation_errors: string[];
  /** Per side, how the record's `rule_coverage` was reconciled ({@link EvalCoverageReconciliation}),
   *  or `null` when that side carries no coverage (a pre-#394 engine). */
  coverage_reconciliation: { a: EvalCoverageReconciliation | null; b: EvalCoverageReconciliation | null };
  /** Present only when BOTH sides carry coverage AND `identity.type_filter.same`. */
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
  const mapA = indexById(a, 'a', errors);
  const mapB = indexById(b, 'b', errors);

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
    a: a.results.filter((r) => identityOf(r) === null).length,
    b: b.results.filter((r) => identityOf(r) === null).length,
  };

  // Each run's summary must be its own results' tally — a disagreement is a stored defect, and a
  // delta over a defective summary would attribute it to a flip.
  for (const [run, label] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    const own = tally(run.results);
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
  if (!sameSummary(expected, summary_delta)) {
    errors.push(`summary delta ${fmt(summary_delta)} does not reconcile to the per-sample accounting ${fmt(expected)}`);
  }

  const identity = {
    corpus: pair(a.corpus, b.corpus),
    rule_store: pair(a.rule_store, b.rule_store),
    type_filter: pair(a.type_filter, b.type_filter),
    degraded: pair(a.degraded, b.degraded),
  };

  // Why the pair is not comparable, in verification order: an unverified side first (nothing
  // below can be asserted about actions whose identity is unknown), then the identity and content
  // differences.
  const reasons: string[] = [];
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
  // OPTIONAL on a record (a pre-#394 engine emits none).
  const covA = a.rule_coverage === undefined ? null : reconcileCoverage(a, 'a', errors);
  const covB = b.rule_coverage === undefined ? null : reconcileCoverage(b, 'b', errors);

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
    coverage_reconciliation: { a: covA === null ? null : covA.mode, b: covB === null ? null : covB.mode },
  };
  // The delta exists only when both sides measured coverage over the SAME denominator — never
  // fabricated from one side, never diffed across two different slices.
  if (covA !== null && covB !== null && identity.type_filter.same) {
    comparison.rule_coverage_delta = a.type_filter === null ? unfilteredDelta(covA, covB) : filteredDelta(covA, covB, a.type_filter);
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

/** Results by sample id. A duplicate id inside ONE run (the engine rejects them at import — an
 *  edited record could still carry one) is a reconciliation error, and the last row wins. */
function indexById(run: EvalRunDetail, label: 'a' | 'b', errors: string[]): Map<string, GovernanceEvalResult> {
  const map = new Map<string, GovernanceEvalResult>();
  for (const r of run.results) {
    if (map.has(r.sample.id)) errors.push(`run ${label} (${run.id}): duplicate sample id ${r.sample.id} in results`);
    map.set(r.sample.id, r);
  }
  return map;
}

/** What one record's coverage lets us KNOW about its rule set. `fired` is every distinct rule id in
 *  `results[].fired` — the BLOCKING firings (evals.rs `evaluate_sample`, `Effect::Deny` only) —
 *  typed into the denominator only when `type_filter` is null (module doc, "Type filters"). */
interface CoverageFacts {
  mode: EvalCoverageReconciliation;
  exercised: number;
  unexercised: Set<string>;
  fired: Set<string>;
}

/**
 * Reconcile one record's `rule_coverage` with ITSELF and with its rows, pushing every contradiction
 * to `errors` (naming the run), and say what it was checked against (`mode`). Whatever the filter:
 * no duplicate unexercised id; `per_type`, when present, sums to `exercised` and agrees per type with
 * the listed rows; no listed-unexercised id fired (the row types the rule into the slice; a firing
 * makes an eligible rule exercised — evals.rs 862-873). Unfiltered (`'rows'`): `exercised` is at
 * least the distinct blocking-fired ids. Filtered: every listed row is of the filter's type, and
 * with `per_type` present (`'per_type'`) the slice's own row equals the total — the rows' fired
 * ids may name rules of other types and are NOT a denominator check; without `per_type`
 * (`'n/a …'`) nothing more can be checked.
 */
function reconcileCoverage(run: EvalRunDetail, label: 'a' | 'b', errors: string[]): CoverageFacts {
  const rc = run.rule_coverage!;
  const who = `run ${label} (${run.id})`;
  const filter = run.type_filter;
  const fired = new Set<string>();
  for (const r of run.results) for (const id of r.fired) fired.add(id);
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

/** The delta of two UNFILTERED records — every fired id is an exercised rule of the denominator, so
 *  a record enumerates `unexercised ∪ fired` and is complete iff `exercised === |fired|`. */
function unfilteredDelta(covA: CoverageFacts, covB: CoverageFacts): EvalRuleCoverageDelta {
  // `unidentified` is floored at 0: an undercut was already reported as a reconciliation error.
  const unidentifiedA = Math.max(0, covA.exercised - covA.fired.size);
  const unidentifiedB = Math.max(0, covB.exercised - covB.fired.size);
  // The identities each record ENUMERATES — its unexercised list plus its blocking-fired ids.
  // Nothing else about a run's rule set is on the wire (module doc: `exercised` is a count).
  const knownA = new Set([...covA.unexercised, ...covA.fired]);
  const knownB = new Set([...covB.unexercised, ...covB.fired]);
  const withheld: string[] = [];
  // Certain transitions: both ends are LISTED identities (unexercised on one side, blocking-fired
  // on the other) — sound whatever the inventory.
  const gained = [...covA.unexercised].filter((id) => covB.fired.has(id)).sort(codepoint);
  const lost = [...covA.fired].filter((id) => covB.unexercised.has(id)).sort(codepoint);
  // Rule-set changes: an id one side enumerates and the other does not. Asserted ONLY when the
  // silent side's inventory is complete (its rule set is fully known); a partial side may hold
  // the id among its unidentified warn-exercised rules — withheld, never guessed.
  const added_rules: string[] = [];
  const removed_rules: string[] = [];
  for (const id of [...knownB].filter((id) => !knownA.has(id)).sort(codepoint)) {
    if (unidentifiedA === 0) added_rules.push(id);
    else withheld.push(`added_rules ${id}: enumerated by b (${covB.unexercised.has(id) ? 'unexercised' : 'blocking-fired'}) and not by a, whose exercised set is only partially identified — ${unidentifiedA} exercised rule id(s) fired by a non-blocking effect alone are unknown (rule_coverage.exercised ${covA.exercised} vs ${covA.fired.size} distinct blocking-fired id(s)) — so it may be one of those or a rule the store gained: not asserted`);
  }
  for (const id of [...knownA].filter((id) => !knownB.has(id)).sort(codepoint)) {
    if (unidentifiedB === 0) removed_rules.push(id);
    else withheld.push(`removed_rules ${id}: enumerated by a (${covA.unexercised.has(id) ? 'unexercised' : 'blocking-fired'}) and not by b, whose exercised set is only partially identified — ${unidentifiedB} exercised rule id(s) fired by a non-blocking effect alone are unknown (rule_coverage.exercised ${covB.exercised} vs ${covB.fired.size} distinct blocking-fired id(s)) — so it may be one of those (exercised now, id unknown) or a rule removed from the store: not asserted`);
  }
  return {
    exercised_delta: covB.exercised - covA.exercised,
    inventory: unidentifiedA === 0 && unidentifiedB === 0 ? 'complete' : 'partial',
    unidentified: { a: unidentifiedA, b: unidentifiedB },
    gained,
    lost,
    added_rules,
    removed_rules,
    transitions_withheld: withheld.sort(codepoint),
  };
}

/** The delta of two records produced under the SAME type filter — a fired id carries no steering
 *  type, so it is typed into the slice only when the OTHER side lists it unexercised (module doc,
 *  "Type filters"). */
function filteredDelta(covA: CoverageFacts, covB: CoverageFacts, filter: SteeringType): EvalRuleCoverageDelta {
  // Certain, both ends listed: the unexercised row types the id into the slice, the firing exercises it.
  const gained = [...covA.unexercised].filter((id) => covB.fired.has(id)).sort(codepoint);
  const lost = [...covA.fired].filter((id) => covB.unexercised.has(id)).sort(codepoint);
  // The fired ids PROVABLY in the slice are exactly those the other side lists unexercised; every
  // other exercised rule of the slice is unnamed. Floored at 0 (a rule's type may have changed
  // between the runs — not a contradiction the records can prove).
  const unidentifiedA = Math.max(0, covA.exercised - lost.length);
  const unidentifiedB = Math.max(0, covB.exercised - gained.length);
  const typedA = new Set([...covA.unexercised, ...lost]);
  const typedB = new Set([...covB.unexercised, ...gained]);
  const added_rules: string[] = [];
  const removed_rules: string[] = [];
  const withheld: string[] = [];
  // Listed unexercised on one side (typed into the slice) and not typed on the other: a rule-set
  // change — asserted only when the silent side names every exercised rule of the slice.
  for (const id of [...covB.unexercised].filter((id) => !typedA.has(id)).sort(codepoint)) {
    if (unidentifiedA === 0) added_rules.push(id);
    else withheld.push(`added_rules ${id}: listed unexercised (${filter}) by b and not enumerated by a, whose exercised ${filter} rules are only partially identified — under type filter ${filter} the rows' fired ids carry no steering_type, so of a's ${covA.exercised} exercised rule(s) only the ${lost.length} b lists unexercised are known to be ${filter} rules (${unidentifiedA} unknown) — it may be one of those or a rule the store gained: not asserted`);
  }
  for (const id of [...covA.unexercised].filter((id) => !typedB.has(id)).sort(codepoint)) {
    if (unidentifiedB === 0) removed_rules.push(id);
    else withheld.push(`removed_rules ${id}: listed unexercised (${filter}) by a and not enumerated by b, whose exercised ${filter} rules are only partially identified — under type filter ${filter} the rows' fired ids carry no steering_type, so of b's ${covB.exercised} exercised rule(s) only the ${gained.length} a lists unexercised are known to be ${filter} rules (${unidentifiedB} unknown) — it may be one of those (exercised now, id unknown) or a rule removed from the store: not asserted`);
  }
  // Fired on one side only and listed unexercised by neither: untyped — it may be a rule of another
  // type that denied a sample of this slice (outside the denominator) — ALWAYS withheld.
  const firedOnly = (own: CoverageFacts, other: CoverageFacts) =>
    [...own.fired].filter((id) => !other.fired.has(id) && !other.unexercised.has(id) && !own.unexercised.has(id)).sort(codepoint);
  for (const id of firedOnly(covB, covA)) {
    withheld.push(`added_rules ${id}: blocking-fired by b for ${filter} sample(s) and listed unexercised by neither side — under type filter ${filter} a row's fired ids carry no steering_type (evals.rs evaluate_sample fires every active rule whatever its type; rule_coverage counts the ${filter} slice only), so it may be a rule of another type outside this denominator, a ${filter} rule the store gained, or one a warn effect exercised in a: not asserted`);
  }
  for (const id of firedOnly(covA, covB)) {
    withheld.push(`removed_rules ${id}: blocking-fired by a for ${filter} sample(s) and listed unexercised by neither side — under type filter ${filter} a row's fired ids carry no steering_type (evals.rs evaluate_sample fires every active rule whatever its type; rule_coverage counts the ${filter} slice only), so it may be a rule of another type outside this denominator, a ${filter} rule removed from the store, or one a warn effect exercised in b: not asserted`);
  }
  return {
    exercised_delta: covB.exercised - covA.exercised,
    inventory: unidentifiedA === 0 && unidentifiedB === 0 ? 'complete' : 'partial',
    unidentified: { a: unidentifiedA, b: unidentifiedB },
    gained,
    lost,
    added_rules,
    removed_rules,
    transitions_withheld: withheld.sort(codepoint),
  };
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
