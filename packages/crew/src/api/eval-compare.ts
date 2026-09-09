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
 * Plan §3 keys a comparison by five identities. The records carry three of them today (`corpus`,
 * `rule_store`, `degraded`; the rule snapshot and the engine build are §5 follow-ups), so
 * `comparable` is derived from CONTENT, never from a name alone: the same corpus name AND the same
 * sample ids AND, per id, the same `kind` AND the same sample PAYLOAD identity — the
 * `sample.payload_hash` a producer stamped on each result row (`eval-sample.js`
 * `samplePayloadHash`: sha256 over the canonical JSON of id, description, kind, steering_type,
 * signals). The engine echoes only id/description/kind/steering_type per row, never the input
 * `signals`, so a row WITHOUT a payload hash cannot be proven to be the same action as its
 * namesake in the other run: such a pair is `comparable: false` with `comparable_reason` starting
 * `unverified: no sample identity` — unverified, which is not the same as "different". A sample
 * present on one side only, one whose kind changed, or one whose payload hash changed means the
 * corpus changed under the same name — reported, and the pair is not comparable release over
 * release. `comparable_reason` is `null` exactly when `comparable` is true.
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
 * # Coverage transitions vs. rule-set changes
 *
 * A rule leaving B's `unexercised` list is NOT evidence it became exercised — it may have been
 * deleted or retired. So `gained` / `lost` are computed only over rules present in BOTH runs' rule
 * sets, where a run's rule set is reconstructed from its record as `unexercised ∪ (every rule id
 * in results[].fired)` (the wire contract: `exercised` counts the rules that fired on at least one
 * sample, `unexercised` lists the ones that fired on none); rules in one set only are reported as
 * `added_rules` / `removed_rules`. When a run's `rule_coverage.exercised` count disagrees with the
 * number of distinct rule ids that fired across its results, the exercised set cannot be
 * reconstructed from the record and that is a reconciliation error (the delta is still reported,
 * over what the record shows, and `reconciles` is false).
 */

import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSummary, SteeringType } from '../core/types.js';
import { PAYLOAD_HASH_RE } from './eval-sample.js';

export type EvalVerdict = GovernanceEvalResult['verdict'];
export type EvalSampleKind = GovernanceEvalResult['sample']['kind'];
export type FlipClass = 'permitted' | 'flagged';

/** The exact prefix of `comparable_reason` when a side carries result rows without a payload hash. */
export const UNVERIFIED_NO_SAMPLE_IDENTITY = 'unverified: no sample identity';

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

/** Which rules gained or lost exercise between the runs (present only when BOTH carry coverage). */
export interface EvalRuleCoverageDelta {
  exercised_delta: number;
  /** In BOTH rule sets: unexercised in A, exercised in B — a sample now exercises the rule. */
  gained: string[];
  /** In BOTH rule sets: exercised in A, unexercised in B — a rule nothing exercises any more. */
  lost: string[];
  /** In B's rule set only — a rule the store gained between the runs (not a coverage change). */
  added_rules: string[];
  /** In A's rule set only — a rule that vanished (deleted/retired) between the runs; NOT `gained`. */
  removed_rules: string[];
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
  /** Same corpus name, same sample ids, same kinds, same payload identities on every row — the
   *  same actions were judged, provably. */
  comparable: boolean;
  /** Why `comparable` is false (`;`-joined when several apply; starts with
   *  {@link UNVERIFIED_NO_SAMPLE_IDENTITY} when a side carries rows without a payload hash), or
   *  `null` when it is true. */
  comparable_reason: string | null;
  /** Every per-sample verdict change, codepoint-sorted by sample id, each classified. */
  flips: EvalVerdictFlip[];
  /** Shared samples with the same kind, the same payload identity (where both carry one) AND the
   *  same verdict on both sides. */
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
   *  accounting AND each run's exercised count equals its distinct fired rule ids — a stored
   *  record that disagrees with itself is a defect, not a flip. */
  reconciles: boolean;
  reconciliation_errors: string[];
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
  // below can be asserted about actions whose identity is unknown), then the content differences.
  const reasons: string[] = [];
  if (unverified_rows.a > 0 || unverified_rows.b > 0) {
    reasons.push(`${UNVERIFIED_NO_SAMPLE_IDENTITY} (${unverified_rows.a} result row(s) in a and ${unverified_rows.b} in b carry no well-formed sample.payload_hash)`);
  }
  if (!identity.corpus.same) reasons.push(`corpus name differs (${JSON.stringify(a.corpus)} vs ${JSON.stringify(b.corpus)})`);
  if (only_in_a.length > 0 || only_in_b.length > 0) {
    reasons.push(`sample set differs (${only_in_a.length} id(s) only in a, ${only_in_b.length} only in b)`);
  }
  if (kind_changed.length > 0) reasons.push(`kind changed for ${kind_changed.length} shared sample(s)`);
  if (payload_changed.length > 0) reasons.push(`payload changed for ${payload_changed.length} shared sample(s) (description, steering_type or signals)`);

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
  };
  // Coverage is OPTIONAL on a record (a pre-#394 engine emits none): the delta exists only when
  // both sides measured it — never fabricated from one side.
  if (a.rule_coverage !== undefined && b.rule_coverage !== undefined) {
    const unexA = new Set(a.rule_coverage.unexercised.map((u) => u.rule_id));
    const unexB = new Set(b.rule_coverage.unexercised.map((u) => u.rule_id));
    const firedA = firedRules(a.results);
    const firedB = firedRules(b.results);
    for (const [label, run, fired] of [
      ['a', a, firedA],
      ['b', b, firedB],
    ] as const) {
      if (fired.size !== run.rule_coverage!.exercised) {
        errors.push(
          `run ${label} (${run.id}): rule_coverage.exercised ${run.rule_coverage!.exercised} does not match the ${fired.size} distinct rule id(s) fired across its results — the exercised rule set cannot be reconstructed from the record`,
        );
      }
    }
    const setA = new Set([...unexA, ...firedA]);
    const setB = new Set([...unexB, ...firedB]);
    const both = [...setA].filter((id) => setB.has(id));
    comparison.rule_coverage_delta = {
      exercised_delta: b.rule_coverage.exercised - a.rule_coverage.exercised,
      gained: both.filter((id) => unexA.has(id) && !unexB.has(id)).sort(codepoint),
      lost: both.filter((id) => !unexA.has(id) && unexB.has(id)).sort(codepoint),
      added_rules: [...setB].filter((id) => !setA.has(id)).sort(codepoint),
      removed_rules: [...setA].filter((id) => !setB.has(id)).sort(codepoint),
    };
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

/** Every distinct rule id that fired on at least one result row — the record's exercised set. */
function firedRules(results: GovernanceEvalResult[]): Set<string> {
  const s = new Set<string>();
  for (const r of results) for (const id of r.fired) s.add(id);
  return s;
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
