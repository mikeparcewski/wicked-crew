/**
 * The scorer (DES-DEFAULT-EVALS-001 §3, §6): cases in, figures out. Deterministic code only: no model, no clock, no
 * I/O. A case with no observation is `unscored` and is never counted as right or wrong.
 */

import { calibration, rate } from './stats.js';
import type { ClassScore, DriftKey, EvalCase, SliceScore, SuiteId } from './types.js';

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Did the system get this case right? `null` when it gave no answer. */
export function isCorrect(c: EvalCase): boolean | null {
  const o = c.observed;
  if (o === null) return null;
  const e = c.expected;
  if (e.labels !== undefined) return o.labels !== undefined && sameSet(o.labels, e.labels);
  return o.label !== undefined && o.label === e.label;
}

export function isModelLabelled(c: EvalCase): boolean {
  return c.expected.by.startsWith('model:');
}

function perClass(scored: readonly EvalCase[]): ClassScore[] {
  const labels = new Set<string>();
  for (const c of scored) {
    if (c.expected.label !== undefined) labels.add(c.expected.label);
    if (c.observed?.label !== undefined) labels.add(c.observed.label);
  }
  return [...labels].sort().map((label) => {
    const said = scored.filter((c) => c.observed?.label === label);
    const truth = scored.filter((c) => c.expected.label === label);
    const both = scored.filter((c) => c.observed?.label === label && c.expected.label === label).length;
    return { label, precision: rate(both, said.length), recall: rate(both, truth.length) };
  });
}

function members(scored: readonly EvalCase[]): NonNullable<SliceScore['members']> {
  let hit = 0;
  let said = 0;
  let truth = 0;
  for (const c of scored) {
    const o = new Set(c.observed?.labels ?? []);
    const e = new Set(c.expected.labels ?? []);
    said += o.size;
    truth += e.size;
    for (const x of o) if (e.has(x)) hit += 1;
  }
  return { precision: rate(hit, said), recall: rate(hit, truth) };
}

/** Pairwise merge agreement: over every pair of cases from the same answerer (surface), "these two are one item" in the observation vs the label. */
function pairs(scored: readonly EvalCase[]): NonNullable<SliceScore['pairs']> {
  let both = 0;
  let said = 0;
  let truth = 0;
  for (let i = 0; i < scored.length; i += 1) {
    for (let j = i + 1; j < scored.length; j += 1) {
      const a = scored[i]!;
      const b = scored[j]!;
      if ((a.surface ?? '') !== (b.surface ?? '')) continue; // each answerer's merge is judged on its own
      const o = a.observed?.cluster !== undefined && a.observed.cluster === b.observed?.cluster;
      const e = a.expected.cluster !== undefined && a.expected.cluster === b.expected.cluster;
      if (o) said += 1;
      if (e) truth += 1;
      if (o && e) both += 1;
    }
  }
  return { precision: rate(both, said), recall: rate(both, truth) };
}

export function scoreSlice(cases: readonly EvalCase[]): SliceScore {
  const scored = cases.filter((c) => c.observed !== null);
  const right = scored.filter((c) => isCorrect(c) === true).length;
  const out: SliceScore = {
    cases: cases.length,
    unscored: cases.length - scored.length,
    agreement: rate(right, scored.length),
    perClass: perClass(scored),
  };
  if (scored.some((c) => c.expected.labels !== undefined)) out.members = members(scored);
  if (scored.some((c) => c.expected.cluster !== undefined || c.observed?.cluster !== undefined)) out.pairs = pairs(scored);
  const confident = scored.filter((c) => typeof c.observed?.confidence === 'number');
  if (confident.length > 0) {
    out.calibration = calibration(confident.map((c) => ({ confidence: c.observed!.confidence!, correct: isCorrect(c) === true })));
  }
  return out;
}

/** The four slices every suite reports (DES §4): real, synthetic, combined (both, no model labels), model. */
export function slices(cases: readonly EvalCase[]): { real: SliceScore; synthetic: SliceScore; combined: SliceScore; model: SliceScore } {
  const people = cases.filter((c) => !isModelLabelled(c));
  return {
    real: scoreSlice(people.filter((c) => c.source === 'real')),
    synthetic: scoreSlice(people.filter((c) => c.source === 'synthetic')),
    combined: scoreSlice(people),
    model: scoreSlice(cases.filter(isModelLabelled)),
  };
}

/**
 * The normalization figure (S8): of the inputs observed in two or more places (projects, or surfaces), the share
 * judged the same everywhere. Computed from the same grouping as {@link driftKeys}.
 */
export function normalizationRate(cases: readonly EvalCase[], drift: readonly DriftKey[]): { compared: number; consistent: number } {
  const places = new Map<string, { surfaces: Set<string>; projects: Set<string> }>();
  for (const c of cases) {
    if (c.observed === null) continue;
    const k = `${c.suite}\u0000${c.inputKey}`;
    const p = places.get(k) ?? { surfaces: new Set<string>(), projects: new Set<string>() };
    if (c.surface !== undefined) p.surfaces.add(c.surface);
    if (c.project !== null) p.projects.add(c.project);
    places.set(k, p);
  }
  let compared = 0;
  for (const p of places.values()) if (p.surfaces.size >= 2 || p.projects.size >= 2) compared += 1;
  return { compared, consistent: compared - drift.length };
}

function answerWord(c: EvalCase): string | null {
  const o = c.observed;
  if (o === null) return null;
  if (o.labels !== undefined) return [...new Set(o.labels)].sort().join('+') || '(none)';
  return o.label ?? null;
}

/**
 * Normalization drift (DES §5): the same input judged differently by place. Cases are grouped by suite and
 * `inputKey`; a key whose observed answers differ across projects (or across surfaces, when the cases carry one)
 * is drift. A place where the answers already differ among themselves still counts once per distinct answer.
 */
export function driftKeys(cases: readonly EvalCase[]): DriftKey[] {
  const groups = new Map<string, EvalCase[]>();
  for (const c of cases) {
    if (c.observed === null) continue;
    const k = `${c.suite}\u0000${c.inputKey}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [c]);
    else g.push(c);
  }
  const out: DriftKey[] = [];
  for (const g of groups.values()) {
    const axes: Array<['surface' | 'project', (c: EvalCase) => string | null]> = [
      ['surface', (c) => c.surface ?? null],
      ['project', (c) => c.project],
    ];
    for (const [axis, placeOf] of axes) {
      const by = new Map<string, Set<string>>();
      for (const c of g) {
        const place = placeOf(c);
        const word = answerWord(c);
        if (place === null || word === null) continue;
        const s = by.get(place) ?? new Set<string>();
        s.add(word);
        by.set(place, s);
      }
      if (by.size < 2) continue;
      const distinct = new Set([...by.values()].map((s) => [...s].sort().join('|')));
      if (distinct.size < 2) continue;
      const observed: Record<string, string[]> = {};
      for (const [place, s] of [...by.entries()].sort(([a], [b]) => a.localeCompare(b))) observed[place] = [...s].sort();
      out.push({
        inputKey: g[0]!.inputKey,
        suite: g[0]!.suite as SuiteId,
        axis,
        observed,
        caseIds: g.map((c) => c.id).sort(),
      });
      break; // one drift row per key: the surface axis, when present, already names the disagreement
    }
  }
  return out.sort((a, b) => a.suite.localeCompare(b.suite) || a.inputKey.localeCompare(b.inputKey));
}
