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
 * # Coverage transitions vs. rule-set changes — and what a record CANNOT tell (codex round 6)
 *
 * The wire carries `rule_coverage.exercised` as a COUNT and `unexercised` as a LIST of ids
 * (api-types `GovernanceEvalRuleCoverage`; wicked-core `crates/wicked-governance/src/evals.rs` at
 * `1704d1a` — core #394, branch `feat/evals-effect-and-coverage` — `RuleCoverage` lines 323-328:
 * `exercised: usize`, `unexercised: Vec<UnexercisedRule>`). A rule is EXERCISED when it appeared in
 * ANY evaluated claim's `policy_ids`, whatever its effect (`RuleCoverage` docs lines 312-314;
 * `rule_coverage()` lines 815-827 partitions the eligible rules by `triggered`, the union
 * `run_evals` collects at lines 940-944 of every claim's `policy_ids`). A result row's `fired`,
 * however, is the BLOCKING subset only: `evaluate_sample` lines 857-869 keep the ids whose effect
 * is `Deny` (line 861) and hand the full `policy_ids` back separately (line 903). Hence
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
 * `removed_rules`, with `reconciles: false` over two valid records). The delta now asserts ONLY
 * what the records prove:
 *
 *   gained         unexercised in A (listed) AND blocking-fired in B (listed): certain, always
 *   lost           blocking-fired in A AND unexercised in B: certain, always
 *   added_rules    enumerated by B, not by A — asserted only when A's inventory is complete (A's
 *                  rule set is fully known, so "not enumerated by A" means "not in A")
 *   removed_rules  enumerated by A, not by B — asserted only when B's inventory is complete
 *   transitions_withheld
 *                  every added/removed candidate the partial side cannot settle (the id may be
 *                  one of that side's unidentified warn-exercised rules, or absent from its store),
 *                  one reason per id — WITHHELD, never guessed; empty when the inventory is complete
 *
 * `exercised_delta` is always the difference of the two counts (a warn-only gain shows up there
 * with `unidentified` saying how many exercised ids the record does not carry). Reconciliation
 * errors on coverage are the record contradicting ITSELF: `exercised` BELOW the distinct
 * blocking-fired ids (every blocking firing is an exercised rule), an id both blocking-fired and
 * listed unexercised, or an id listed unexercised twice. A larger `exercised` is NOT an error —
 * it is the wire's honest count of warn-only exercise. Two valid reports always `reconcile`.
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

/** Whether both records enumerate EVERY rule of their rule set (`exercised === |fired|` on each
 *  side: no rule was exercised by a non-blocking effect alone) or at least one carries exercised
 *  rules it does not name. See the module doc. */
export type EvalRuleInventory = 'complete' | 'partial';

/** Which rules gained or lost exercise between the runs (present only when BOTH carry coverage). */
export interface EvalRuleCoverageDelta {
  /** `b.rule_coverage.exercised − a.rule_coverage.exercised` — the counts, always. */
  exercised_delta: number;
  /** `complete` when both sides identify every exercised rule (so `added_rules`/`removed_rules`
   *  are asserted); `partial` when a side counts exercised rules it never names (then the
   *  unsettled transitions are in `transitions_withheld`). */
  inventory: EvalRuleInventory;
  /** Per side, `rule_coverage.exercised − |distinct blocking-fired ids|`: how many exercised rules
   *  the record counts but does not identify (exercised by a `warn` effect alone). 0/0 ⇔ complete. */
  unidentified: { a: number; b: number };
  /** Unexercised in A (listed) AND blocking-fired in B (listed) — a sample now exercises the rule.
   *  Certain on both sides, whatever the inventory. */
  gained: string[];
  /** Blocking-fired in A AND unexercised in B (listed) — a rule nothing exercises any more. Certain. */
  lost: string[];
  /** Enumerated by B (unexercised or fired) and not by A, when A's inventory is COMPLETE — a rule
   *  the store gained between the runs (not a coverage change). Empty when A is partial. */
  added_rules: string[];
  /** Enumerated by A and not by B, when B's inventory is COMPLETE — a rule that vanished
   *  (deleted/retired) between the runs; NOT `gained`. Empty when B is partial. */
  removed_rules: string[];
  /** The added/removed candidates a PARTIAL side cannot settle — the id may be one of that side's
   *  unidentified warn-exercised rules or absent from its store — one reason per id, codepoint-
   *  sorted by id. Empty when `inventory` is `complete`. */
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
   *  accounting AND each run's coverage does not contradict its rows (`exercised` at least its
   *  distinct blocking-fired ids, no id both fired and unexercised, no duplicate unexercised id) —
   *  a stored record that disagrees with ITSELF is a defect, not a flip. Two valid records always
   *  reconcile; an exercised count ABOVE the fired ids is valid (warn-only exercise). */
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
    const covA = coverageOf(a, 'a', errors);
    const covB = coverageOf(b, 'b', errors);
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
      if (covA.unidentified === 0) added_rules.push(id);
      else withheld.push(`added_rules ${id}: enumerated by b (${covB.unexercised.has(id) ? 'unexercised' : 'blocking-fired'}) and not by a, whose exercised set is only partially identified — ${covA.unidentified} exercised rule id(s) fired by a non-blocking effect alone are unknown (rule_coverage.exercised ${a.rule_coverage.exercised} vs ${covA.fired.size} distinct blocking-fired id(s)) — so it may be one of those or a rule the store gained: not asserted`);
    }
    for (const id of [...knownA].filter((id) => !knownB.has(id)).sort(codepoint)) {
      if (covB.unidentified === 0) removed_rules.push(id);
      else withheld.push(`removed_rules ${id}: enumerated by a (${covA.unexercised.has(id) ? 'unexercised' : 'blocking-fired'}) and not by b, whose exercised set is only partially identified — ${covB.unidentified} exercised rule id(s) fired by a non-blocking effect alone are unknown (rule_coverage.exercised ${b.rule_coverage.exercised} vs ${covB.fired.size} distinct blocking-fired id(s)) — so it may be one of those (exercised now, id unknown) or a rule removed from the store: not asserted`);
    }
    comparison.rule_coverage_delta = {
      exercised_delta: b.rule_coverage.exercised - a.rule_coverage.exercised,
      inventory: covA.unidentified === 0 && covB.unidentified === 0 ? 'complete' : 'partial',
      unidentified: { a: covA.unidentified, b: covB.unidentified },
      gained,
      lost,
      added_rules,
      removed_rules,
      transitions_withheld: withheld.sort(codepoint),
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

/** What one record's coverage lets us KNOW about its rule set, plus the ways it can contradict
 *  itself (pushed to `errors`, naming the run). `fired` is every distinct rule id in
 *  `results[].fired` — the BLOCKING firings (evals.rs `evaluate_sample`, `Effect::Deny` only), a
 *  subset of the exercised rules; `unidentified` is how many exercised rules the record counts but
 *  never names (`exercised − |fired|`, floored at 0 once the undercut is reported). */
function coverageOf(run: EvalRunDetail, label: 'a' | 'b', errors: string[]): { unexercised: Set<string>; fired: Set<string>; unidentified: number } {
  const rc = run.rule_coverage!;
  const fired = new Set<string>();
  for (const r of run.results) for (const id of r.fired) fired.add(id);
  const unexercised = new Set<string>();
  for (const u of rc.unexercised) {
    if (unexercised.has(u.rule_id)) errors.push(`run ${label} (${run.id}): rule_coverage.unexercised lists ${u.rule_id} twice — a rule is unexercised once or not at all`);
    unexercised.add(u.rule_id);
    if (fired.has(u.rule_id)) {
      errors.push(`run ${label} (${run.id}): rule_coverage.unexercised lists ${u.rule_id}, which fired (blocking) in its results — a rule that fired for any sample is exercised, never unexercised`);
    }
  }
  if (rc.exercised < fired.size) {
    errors.push(
      `run ${label} (${run.id}): rule_coverage.exercised ${rc.exercised} is below the ${fired.size} distinct rule id(s) fired (blocking) across its results (${[...fired].sort(codepoint).join(', ')}) — every blocking firing is an exercised rule`,
    );
  }
  return { unexercised, fired, unidentified: Math.max(0, rc.exercised - fired.size) };
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
