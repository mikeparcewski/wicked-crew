/**
 * Cross-run eval comparison (docs/testing/evals-test-plan.md S17) — the OFFLINE, deterministic diff
 * of two recorded {@link EvalRunDetail}s over the same corpus: which per-sample verdicts flipped,
 * whether each flip is the kind a tightened store is allowed to produce (`permitted`) or the kind a
 * release has to explain (`flagged`), whether the two stored summaries reconcile to the per-sample
 * accounting, and which rules gained or lost exercise (core #394 `rule_coverage`).
 *
 * Pure over the two records: no store, no engine, no clock, no I/O — two persisted drilldowns in,
 * one report out, byte-stable for the same inputs (every list is codepoint-sorted by sample id).
 *
 * # What "comparable" means here
 *
 * Plan §3 keys a comparison by five identities. The records carry three of them today (`corpus`,
 * `rule_store`, `degraded`; `samples_hash`, the rule snapshot and the engine build are §5 follow-
 * ups), so `comparable` is derived from CONTENT, never from a name alone: the same corpus name AND
 * the same sample ids AND the same `kind` per id. A sample present on one side only, or one whose
 * kind changed, means the corpus changed under the same name — reported, and the pair is not
 * comparable release over release.
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
 */

import type { EvalRunDetail, GovernanceEvalResult, GovernanceEvalSummary, SteeringType } from '../core/types.js';

export type EvalVerdict = GovernanceEvalResult['verdict'];
export type EvalSampleKind = GovernanceEvalResult['sample']['kind'];
export type FlipClass = 'permitted' | 'flagged';

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
  /** Unexercised in A, exercised in B — the corpus or the store grew a sample/rule pairing. */
  gained: string[];
  /** Exercised in A, unexercised in B — a rule nothing exercises any more. */
  lost: string[];
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
  /** Same corpus name, same sample ids, same kinds — the same actions were judged. */
  comparable: boolean;
  /** Every per-sample verdict change, codepoint-sorted by sample id, each classified. */
  flips: EvalVerdictFlip[];
  /** Shared samples with the same kind AND the same verdict on both sides. */
  unchanged: number;
  only_in_a: string[];
  only_in_b: string[];
  /** Shared ids whose `kind` differs — the corpus changed under this name (always flagged). */
  kind_changed: string[];
  /** `b.summary − a.summary`, field by field. */
  summary_delta: GovernanceEvalSummary;
  /** Each run's summary equals its own results' tally AND the delta equals the flip/add/remove
   *  accounting — a stored summary that disagrees with its results is a defect, not a flip. */
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
  let unchanged = 0;
  for (const id of shared) {
    const ra = mapA.get(id)!;
    const rb = mapB.get(id)!;
    const kindChanged = ra.sample.kind !== rb.sample.kind;
    if (kindChanged) kind_changed.push(id);
    if (ra.verdict !== rb.verdict) {
      const verdictClass = kindChanged
        ? {
            classification: 'flagged' as const,
            reason: `the sample's kind changed between runs (${ra.sample.kind} → ${rb.sample.kind}): the corpus changed under this name`,
          }
        : classifyFlip(rb.sample.kind, ra.verdict, rb.verdict);
      flips.push({ sample_id: id, kind: rb.sample.kind, from: ra.verdict, to: rb.verdict, ...verdictClass });
    } else if (!kindChanged) {
      unchanged += 1;
    }
  }

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

  const comparison: EvalRunComparison = {
    a: a.id,
    b: b.id,
    identity,
    comparable: identity.corpus.same && only_in_a.length === 0 && only_in_b.length === 0 && kind_changed.length === 0,
    flips,
    unchanged,
    only_in_a,
    only_in_b,
    kind_changed,
    summary_delta,
    reconciles: errors.length === 0,
    reconciliation_errors: errors,
  };
  // Coverage is OPTIONAL on a record (a pre-#394 engine emits none): the delta exists only when
  // both sides measured it — never fabricated from one side.
  if (a.rule_coverage !== undefined && b.rule_coverage !== undefined) {
    const unexA = new Set(a.rule_coverage.unexercised.map((u) => u.rule_id));
    const unexB = new Set(b.rule_coverage.unexercised.map((u) => u.rule_id));
    comparison.rule_coverage_delta = {
      exercised_delta: b.rule_coverage.exercised - a.rule_coverage.exercised,
      gained: [...unexA].filter((id) => !unexB.has(id)).sort(codepoint),
      lost: [...unexB].filter((id) => !unexA.has(id)).sort(codepoint),
    };
  }
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
