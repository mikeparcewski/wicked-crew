/**
 * The default-evals runner (DES-DEFAULT-EVALS-001 §5): one project, or every project, scored suite by suite, with
 * synthetic cases filling the gaps and the normalization drift a cross-project run surfaces. Deterministic given its
 * inputs: the clock and the run id are passed in, and the only side effect is the replay adapters' subprocesses.
 */

import { driftKeys, normalizationRate, scoreSlice, slices } from './score.js';
import { rate, trendOf, MIN_CALIBRATION, MIN_CASES } from './stats.js';
import { generateSynthetic } from './synthetic.js';
import type { ReplaySet } from './replay.js';
import { SUITE_IDS, type DefaultEvalReport, type DefaultEvalSummary, type EvalCase, type SliceScore, type SuiteId, type SuiteScore } from './types.js';

export const SUITE_TITLES: Record<SuiteId, string> = {
  'needs-you': 'What needs you: what counts, and what is one item',
  'floor-class': 'Floor decisions: pass, real failure, base red, inconclusive, boundary deny',
  'qe-verdict': 'QE verdicts: pass, fail, inconclusive, and one answer per tree',
  attribution: 'Who built it: authors and the creator a review checks',
  steering: 'Steering rules: block the bad, leave the good alone',
  recall: 'Memory recall: the memories a step needs surface',
  archetype: 'Prompt routing: which kind of work a prompt asks for',
  normalization: 'Normalizing: the same input judged the same in every project and surface',
};

export type PreviousScores = Partial<Record<SuiteId, { runId: string; score: SuiteScore }>>;

/** The most recent score of each suite across stored reports, newest first. */
export function previousScores(reports: readonly DefaultEvalReport[]): PreviousScores {
  const out: PreviousScores = {};
  for (const r of reports) for (const sc of r.suites) if (out[sc.suite] === undefined) out[sc.suite] = { runId: r.id, score: sc };
  return out;
}

export interface RunInput {
  id: string;
  now: Date;
  /** `null` = every project. */
  project: string | null;
  /** Real cases (captured and seeded) and the steering eval's cases. Synthetic ones are generated here. */
  cases: EvalCase[];
  replay: ReplaySet;
  /** Per suite, the most recent stored score of the same scope and its run id (a run that skipped the suite is
   *  passed over), for the trend. */
  previous: PreviousScores;
  /** Limit to these suites (all when absent). */
  suites?: SuiteId[];
}

function dedupe(cases: readonly EvalCase[]): EvalCase[] {
  const by = new Map<string, EvalCase>();
  for (const c of cases) by.set(c.id, c);
  return [...by.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function inScope(c: EvalCase, project: string | null): boolean {
  return project === null || c.project === project || (c.source === 'synthetic' && c.project === null);
}

function group<K extends string>(cases: readonly EvalCase[], keyOf: (c: EvalCase) => K | null): Record<string, SliceScore> | undefined {
  const by = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const k = keyOf(c);
    if (k === null) continue;
    by.set(k, [...(by.get(k) ?? []), c]);
  }
  if (by.size === 0) return undefined;
  const out: Record<string, SliceScore> = {};
  for (const [k, cs] of [...by.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = scoreSlice(cs);
  return out;
}

export async function runDefaultEvals(input: RunInput): Promise<{ report: DefaultEvalReport; cases: EvalCase[] }> {
  const wanted = new Set<SuiteId>(input.suites ?? SUITE_IDS);
  // Normalization is computed over every other suite's cases, so asking for it keeps them all (codex/agy r1);
  // otherwise only the asked-for suites' cases are read.
  const reads = (c: EvalCase): boolean => wanted.has('normalization') || wanted.has(c.suite);
  const given = dedupe(input.cases).filter((c) => inScope(c, input.project) && reads(c));
  const givenIds = new Set(given.map((c) => c.id));
  const synthetic = generateSynthetic(given).filter((c) => reads(c) && !givenIds.has(c.id));
  let cases = [...given, ...synthetic];

  // Replay: the current classifier answers every case that has no recorded answer.
  const notes = new Map<SuiteId, string[]>();
  const note = (s: SuiteId, line: string): void => {
    notes.set(s, [...(notes.get(s) ?? []), line]);
  };
  for (const suite of SUITE_IDS) {
    const waiting = cases.filter((c) => c.suite === suite && c.observed === null);
    if (waiting.length === 0) continue;
    const adapter = input.replay.adapters[suite];
    if (adapter === undefined) {
      note(suite, `${waiting.length} case(s) not scored: ${input.replay.missing[suite] ?? 'no replay adapter'}`);
      continue;
    }
    try {
      const answers = await adapter.replay(waiting);
      cases = cases.map((c) => (c.observed === null && answers.has(c.id) ? { ...c, observed: answers.get(c.id)! } : c));
      const left = waiting.length - answers.size;
      if (left > 0) note(suite, `${left} case(s) the replay adapter could not answer`);
    } catch (err) {
      note(suite, `replay failed, ${waiting.length} case(s) not scored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const drift = driftKeys(cases);
  const suites: SuiteScore[] = [];
  for (const suite of SUITE_IDS) {
    if (!wanted.has(suite)) continue;
    const prevEntry = input.previous[suite];
    const prev = prevEntry?.score ?? null;
    const prevId = prevEntry?.runId ?? null;
    if (suite === 'normalization') {
      const { compared, consistent } = normalizationRate(cases, drift);
      const real = scoreSlice([]);
      real.cases = compared;
      real.agreement = rate(consistent, compared);
      const empty = scoreSlice([]);
      suites.push({
        suite,
        title: SUITE_TITLES[suite],
        real,
        synthetic: empty,
        combined: real,
        model: empty,
        trend: { word: trendOf(real.agreement, prev ? { value: prev.combined.agreement.value, n: prev.combined.agreement.n } : null), previous: prev?.combined.agreement.value ?? null, previousRunId: prevId },
        notes: [
          `${compared} input(s) were judged in two or more places; ${drift.length} were judged differently`,
          ...(input.project !== null ? ['a single-project run compares nothing across places; run every project to compare projects and surfaces'] : []),
        ],
      });
      continue;
    }
    const mine = cases.filter((c) => c.suite === suite);
    const s = slices(mine);
    const extra = notes.get(suite) ?? [];
    if (mine.length === 0) extra.push('no cases yet');
    if (suite === 'needs-you' && input.project !== null) extra.push('what needs you is daemon-wide: run every project to score it');
    if (suite === 'recall' && mine.length === 0) {
      extra.push('no labelled recall cases: run the steering eval with a memory store and samples that name expected_memories');
    }
    const score: SuiteScore = {
      suite,
      title: SUITE_TITLES[suite],
      ...s,
      trend: {
        word: trendOf(s.combined.agreement, prev ? { value: prev.combined.agreement.value, n: prev.combined.agreement.n } : null),
        previous: prev?.combined.agreement.value ?? null,
        previousRunId: prevId,
      },
      notes: extra,
    };
    if (input.project === null) {
      const byProject = group(mine.filter((c) => !c.expected.by.startsWith('model:')), (c) => c.project);
      if (byProject !== undefined && Object.keys(byProject).length > 1) score.byProject = byProject;
    }
    const bySurface = group(mine.filter((c) => !c.expected.by.startsWith('model:')), (c) => c.surface ?? null);
    if (bySurface !== undefined) score.bySurface = bySurface;
    suites.push(score);
  }

  const people = cases.filter((c) => !c.expected.by.startsWith('model:'));
  const report: DefaultEvalReport = {
    id: input.id,
    createdAt: input.now.toISOString(),
    project: input.project,
    suites,
    drift,
    counts: {
      real: people.filter((c) => c.source === 'real').length,
      synthetic: people.filter((c) => c.source === 'synthetic').length,
      modelLabelled: cases.length - people.length,
      unscored: cases.filter((c) => c.observed === null).length,
      baseline: cases.filter((c) => c.baseline === true).length,
    },
    minimums: { rate: MIN_CASES, calibration: MIN_CALIBRATION },
  };
  return { report, cases };
}

export function summarize(report: DefaultEvalReport): DefaultEvalSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    project: report.project,
    suites: report.suites.map((s) => ({
      suite: s.suite,
      agreement: s.combined.agreement.value,
      n: s.combined.agreement.n,
      tooFew: s.combined.agreement.tooFew,
      trend: s.trend.word,
    })),
    drift: report.drift.length,
    counts: report.counts,
  };
}
