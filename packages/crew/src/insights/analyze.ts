/**
 * The review's numbers (DES-RUNS-REVIEW-001 §4-§5): a snapshot of {@link RunFact}s in, `facts.json` out. Pure and
 * deterministic. The workflow's `analyze` Tool phase runs it (`analyze-cli.ts`), so every metric, interval and
 * candidate recommendation is computed by code, never by the model. The `interpret` seat only reads the result.
 */

import type { RunFact } from './run-facts.js';
import { MIN_SAMPLE, bootstrapMedianCI, compare, percentileSorted, round, seedOf, sortedCopy, wilson, type Interval, type Verdict } from './stats.js';

export const FACTS_VERSION = 1;
/** The most recommendations one review makes; the rest are watched. */
export const MAX_RECOMMENDATIONS = 5;
/** A single-cause pattern needs this many runs behind it. */
export const PATTERN_MIN_RUNS = 3;
/** "Working well": a segment's pass rate at or above this, on at least MIN_SAMPLE runs. */
export const WORKING_WELL_RATE = 0.8;

export interface Window {
  startMs: number;
  endMs: number;
}

export interface Snapshot {
  version: 1;
  generatedAtMs: number;
  window: Window;
  /** The previous windows (same length), newest first. Their runs together are the baseline. */
  baselineWindows: Window[];
  projectIds: string[];
  runs: RunFact[];
}

export type MetricId =
  | 'pass_rate'
  | 'override_rate'
  | 'unresolved_rate'
  | 'time_to_pr'
  | 'floor_minutes'
  | 'wait_on_people'
  | 'spend'
  | 'retries'
  | 'rigor_raised';
export type MetricKind = 'rate' | 'median';

export interface MetricDef {
  id: MetricId;
  label: string;
  kind: MetricKind;
  unit: 'ratio' | 'minutes' | 'usd' | 'count';
  higherIsBetter: boolean;
}

export const METRICS: readonly MetricDef[] = [
  { id: 'pass_rate', label: 'Pass rate', kind: 'rate', unit: 'ratio', higherIsBetter: true },
  { id: 'override_rate', label: 'Runs with an override', kind: 'rate', unit: 'ratio', higherIsBetter: false },
  { id: 'unresolved_rate', label: 'Runs left unresolved', kind: 'rate', unit: 'ratio', higherIsBetter: false },
  { id: 'time_to_pr', label: 'Time to PR', kind: 'median', unit: 'minutes', higherIsBetter: false },
  { id: 'floor_minutes', label: 'Time in checks', kind: 'median', unit: 'minutes', higherIsBetter: false },
  { id: 'wait_on_people', label: 'Time waiting on people', kind: 'median', unit: 'minutes', higherIsBetter: false },
  { id: 'spend', label: 'Spend per run', kind: 'median', unit: 'usd', higherIsBetter: false },
  { id: 'retries', label: 'Retries per run', kind: 'median', unit: 'count', higherIsBetter: false },
  // (program DES-POWER-MODE) Planned vs actual: how often a power run's rigor rose after its intake QE
  // plan sized it — a repo where this keeps rising is one the planner under-sizes.
  { id: 'rigor_raised', label: 'Power runs whose rigor rose after intake', kind: 'rate', unit: 'ratio', higherIsBetter: false },
];

export interface SampleStat {
  n: number;
  /** The rate, or the median. `null` with no sample. */
  value: number | null;
  interval: Interval | null;
  p75?: number | null;
  p90?: number | null;
}

export interface MetricResult {
  metric: MetricId;
  /** `all`, `repo:<id>`, `agent:<cli>`, `workflow:<id>`. */
  segment: string;
  window: SampleStat;
  baseline: SampleStat;
  verdict: Verdict;
  /** The run ids the window sample counted (evidence). */
  runs: string[];
}

export type RecommendationKind = 'steering-rule' | 'memory' | 'setting' | 'issue' | 'resolve-stale';
export type Confidence = 'high' | 'medium' | 'low';

export interface EvidenceRun {
  id: string;
  title: string;
}

export interface Candidate {
  /** Stable for the same cause: re-derived reviews name the same id. */
  id: string;
  kind: RecommendationKind;
  title: string;
  evidence: {
    line: string;
    runs: EvidenceRun[];
    metric?: MetricId;
    segment?: string;
    n: number;
    value?: number | null;
    baseline?: number | null;
    interval?: Interval | null;
  };
  expectedEffect: string;
  confidence: Confidence;
  changeMind: string;
  /** runs affected + hours at stake + dollars at stake: the ranking key. */
  impact: number;
  /** Why it qualified: a notable change, or a single-cause pattern. */
  basis: 'notable' | 'pattern';
  action: {
    setting?: string;
    issue?: { repoRef: string | null; title: string; body: string };
    runs?: string[];
    proposal?: { kindType: string; content: string; severity?: string };
  };
}

export interface Finding {
  metric: MetricId;
  segment: string;
  line: string;
  window: SampleStat;
  baseline: SampleStat;
}

export interface Facts {
  version: typeof FACTS_VERSION;
  generatedAtMs: number;
  window: Window;
  baselineWindows: Window[];
  projectIds: string[];
  totals: { runs: number; baselineRuns: number; passed: number; failed: number; cancelled: number; open: number; spendUsd: number; tokens: number };
  minSample: number;
  metrics: MetricResult[];
  /** What got better (a notable improvement) and what is working (a high pass rate on enough runs). */
  improvements: Finding[];
  regressions: Finding[];
  /** Every candidate, ranked by impact (highest first). */
  candidates: Candidate[];
  /** The candidate ids recommended (≤ MAX_RECOMMENDATIONS) and the ones watched. */
  recommended: string[];
  watching: string[];
}

// ── values per metric ───────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const terminalOf = (r: RunFact): boolean => r.outcome !== 'open';

/** The runs a metric samples, and each run's value (a rate's value is 1 or 0). */
function sampleOf(metric: MetricId, runs: readonly RunFact[]): { ids: string[]; values: number[] } {
  const pick = (keep: (r: RunFact) => boolean, value: (r: RunFact) => number): { ids: string[]; values: number[] } => {
    const kept = runs.filter(keep);
    return { ids: kept.map((r) => r.id), values: kept.map(value) };
  };
  switch (metric) {
    case 'pass_rate':
      // Cancelled is a person's decision, not a failure: the rate is passed / (passed + failed).
      return pick((r) => r.outcome === 'passed' || r.outcome === 'failed', (r) => (r.outcome === 'passed' ? 1 : 0));
    case 'override_rate':
      return pick(terminalOf, (r) => (r.overrides.length > 0 ? 1 : 0));
    case 'unresolved_rate':
      return pick(() => true, (r) => (r.unresolved ? 1 : 0));
    case 'time_to_pr':
      return pick((r) => r.timeToPrMs !== null, (r) => (r.timeToPrMs as number) / MIN);
    case 'floor_minutes':
      return pick((r) => terminalOf(r) && r.floorMs > 0, (r) => r.floorMs / MIN);
    case 'wait_on_people':
      return pick(terminalOf, (r) => r.waitHumanMs / MIN);
    case 'spend':
      return pick((r) => r.spendReported, (r) => r.spendUsd);
    case 'retries':
      return pick(terminalOf, (r) => r.retries);
    case 'rigor_raised':
      return pick((r) => terminalOf(r) && r.power != null, (r) => (r.power?.raised === true ? 1 : 0));
  }
}

function statOf(def: MetricDef, values: readonly number[], seedLabel: string): SampleStat {
  const n = values.length;
  if (def.kind === 'rate') {
    const successes = values.reduce((a, b) => a + b, 0);
    return { n, value: n === 0 ? null : round(successes / n), interval: roundInterval(wilson(successes, n)) };
  }
  const sorted = sortedCopy(values);
  return {
    n,
    value: round(percentileSorted(sorted, 0.5)),
    interval: roundInterval(bootstrapMedianCI(values, seedOf(seedLabel))),
    p75: round(percentileSorted(sorted, 0.75)),
    p90: round(percentileSorted(sorted, 0.9)),
  };
}

function roundInterval(i: Interval | null): Interval | null {
  return i === null ? null : { lo: round(i.lo) as number, hi: round(i.hi) as number };
}

/** Segments: everything, then each repo, agent and workflow seen in the window. */
function segmentsOf(runs: readonly RunFact[]): { segment: string; keep: (r: RunFact) => boolean }[] {
  const out: { segment: string; keep: (r: RunFact) => boolean }[] = [{ segment: 'all', keep: () => true }];
  const repos = [...new Set(runs.map((r) => r.repo).filter((x): x is string => x !== null))].sort();
  const agents = [...new Set(runs.flatMap((r) => r.agents))].sort();
  const workflows = [...new Set(runs.map((r) => r.workflow))].sort();
  for (const repo of repos) out.push({ segment: `repo:${repo}`, keep: (r) => r.repo === repo });
  for (const agent of agents) out.push({ segment: `agent:${agent}`, keep: (r) => r.agents.includes(agent) });
  for (const wf of workflows) out.push({ segment: `workflow:${wf}`, keep: (r) => r.workflow === wf });
  return out;
}

const inWindow = (w: Window) => (r: RunFact): boolean => r.createdAtMs >= w.startMs && r.createdAtMs < w.endMs;

// ── words ───────────────────────────────────────────────────────────────────────────────────────────

export function formatValue(def: MetricDef, v: number | null): string {
  if (v === null) return 'none';
  switch (def.unit) {
    case 'ratio': return `${Math.round(v * 100)}%`;
    case 'minutes': return v >= 120 ? `${(v / 60).toFixed(1)} h` : `${Math.round(v)} min`;
    case 'usd': return `$${v.toFixed(2)}`;
    case 'count': return v.toFixed(v % 1 === 0 ? 0 : 1);
  }
}

export function segmentWords(segment: string): string {
  if (segment === 'all') return 'all runs';
  const [k, ...rest] = segment.split(':');
  const v = rest.join(':');
  return k === 'repo' ? `${v} runs` : k === 'agent' ? `runs ${v} worked on` : `${v} runs`;
}

function findingLine(def: MetricDef, r: MetricResult): string {
  const w = r.window;
  const ci = w.interval !== null ? ` (95% CI ${formatValue(def, w.interval.lo)}–${formatValue(def, w.interval.hi)})` : '';
  return `${def.label}, ${segmentWords(r.segment)}: ${formatValue(def, w.value)}${ci}, n=${w.n}, against ${formatValue(def, r.baseline.value)} before (n=${r.baseline.n}).`;
}

function confidenceOf(n: number, basis: 'notable' | 'pattern'): Confidence {
  if (basis === 'notable') return n >= 15 ? 'high' : n >= 8 ? 'medium' : 'low';
  return n >= 6 ? 'high' : n >= 4 ? 'medium' : 'low';
}

const hours = (ms: number): number => ms / 3_600_000;
const ev = (runs: readonly RunFact[]): EvidenceRun[] => runs.map((r) => ({ id: r.id, title: r.title }));
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ── candidates ──────────────────────────────────────────────────────────────────────────────────────

function patternCandidates(runs: readonly RunFact[], nowMs: number): Candidate[] {
  const out: Candidate[] = [];

  // 1. Unresolved runs: "resolve these N stale runs".
  const stale = runs.filter((r) => r.unresolved);
  if (stale.length >= PATTERN_MIN_RUNS) {
    const openHours = stale.reduce((a, r) => a + hours(Math.max(0, (r.endedAtMs ?? nowMs) - r.createdAtMs)), 0);
    out.push({
      id: 'resolve-stale',
      kind: 'resolve-stale',
      title: `Resolve ${stale.length} runs nobody closed`,
      evidence: { line: `${stale.length} runs failed or sat open over a day and were neither retried nor archived.`, runs: ev(stale), n: stale.length },
      expectedEffect: 'The run list shows only live work, and the work these runs held is either finished or written off.',
      confidence: confidenceOf(stale.length, 'pattern'),
      changeMind: 'If these runs are deliberately parked (waiting on an outside answer), archive them with a note instead.',
      impact: round(stale.length + Math.min(openHours, 72), 2) as number,
      basis: 'pattern',
      action: { runs: stale.map((r) => r.id) },
    });
  }

  // 2. The same override, again and again, on one repo.
  const overrideGroups = new Map<string, RunFact[]>();
  for (const r of runs) {
    for (const cond of new Set(r.overrides.map((o) => o.condition))) {
      const key = `${r.repo ?? '-'}\u0000${cond}`;
      overrideGroups.set(key, [...(overrideGroups.get(key) ?? []), r]);
    }
  }
  for (const [key, group] of [...overrideGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < PATTERN_MIN_RUNS) continue;
    const [repoKey, condition] = key.split('\u0000') as [string, string];
    const repo = repoKey === '-' ? null : repoKey;
    const where = repo ?? 'repo-less runs';
    const waited = group.reduce((a, r) => a + hours(r.waitHumanMs), 0);
    const base = {
      evidence: { line: `A "${condition}" escalation was overridden by a person in ${group.length} runs on ${where}.`, runs: ev(group), n: group.length },
      confidence: confidenceOf(group.length, 'pattern'),
      impact: round(group.length + waited, 2) as number,
      basis: 'pattern' as const,
    };
    if (condition === 'judge_unavailable') {
      out.push({
        ...base,
        id: `setting-judge-${slug(where)}`,
        kind: 'setting',
        title: 'Sign in a second agent so a distinct judge can review',
        expectedEffect: 'Reviews run on a seat other than the creator\'s, so a person stops overriding "no judge" by hand.',
        changeMind: 'If a second agent is signed in and still benched, the cause is its quota or sign-in, not the roster.',
        action: { setting: 'seats' },
      });
    } else if (condition === 'floor_failed') {
      const title = `Checks on ${where} fail before the change: ${group.length} runs overrode them`;
      out.push({
        ...base,
        id: `issue-floor-${slug(where)}`,
        kind: 'issue',
        title: `Fix the checks that fail on ${where}`,
        expectedEffect: 'Runs pass their checks on merit, and overrides stop hiding real failures.',
        changeMind: 'If the failing checks pass on CI, the cause is this machine\'s environment: file that instead.',
        action: { issue: { repoRef: repo, title, body: `${base.evidence.line}\n\nRuns: ${group.map((r) => r.id).join(', ')}` } },
      });
    } else {
      const statement = `On ${where}, a "${condition}" escalation was overridden in ${group.length} runs. Plans for ${where} should state how they meet "${condition}" before the gate runs.`;
      out.push({
        ...base,
        id: `steering-override-${slug(where)}-${slug(condition)}`,
        kind: 'steering-rule',
        title: `Make plans on ${where} answer "${condition}" up front`,
        expectedEffect: 'Fewer gates escalate on this condition, so fewer runs wait on a person to override them.',
        changeMind: 'If the overrides were each for a different reason, a rule would not help: dismiss with that reason.',
        action: { proposal: { kindType: 'policy:operations', content: statement, severity: 'warn' } },
      });
    }
  }

  // 3. A seat benched for the same reason across runs.
  const benchGroups = new Map<string, RunFact[]>();
  for (const r of runs) for (const b of r.benched) {
    // The reason without its parenthetical detail ("quota_exhausted (no success in the run)" → "quota_exhausted").
    const key = `${b.cli}\u0000${(b.reason.split(' (')[0] ?? b.reason).trim().slice(0, 60)}`;
    benchGroups.set(key, [...(benchGroups.get(key) ?? []), r]);
  }
  for (const [key, group] of [...benchGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < PATTERN_MIN_RUNS) continue;
    const [cli, reason] = key.split('\u0000') as [string, string];
    const signin = /not_logged_in|signed/u.test(reason);
    out.push({
      id: `setting-bench-${slug(cli)}-${slug(reason)}`,
      kind: 'setting',
      title: signin ? `Sign ${cli} back in` : `Check why ${cli} is benched: ${reason.replace(/_/g, ' ')}`,
      evidence: { line: `${cli} was benched (${reason.replace(/_/g, ' ')}) in ${group.length} runs.`, runs: ev(group), n: group.length },
      expectedEffect: `${cli} takes work again, so runs have more distinct seats and fewer fallbacks.`,
      confidence: confidenceOf(group.length, 'pattern'),
      changeMind: `If ${cli} is benched on purpose, remove it from the roster so runs stop trying it.`,
      impact: group.length,
      basis: 'pattern',
      action: { setting: 'seats' },
    });
  }

  // 4. The same failure, again and again.
  const failGroups = new Map<string, RunFact[]>();
  for (const r of runs) if (r.failureSignature !== null) {
    const key = `${r.repo ?? '-'}\u0000${r.failureSignature}`;
    failGroups.set(key, [...(failGroups.get(key) ?? []), r]);
  }
  for (const [key, group] of [...failGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < PATTERN_MIN_RUNS) continue;
    const [repoKey, signature] = key.split('\u0000') as [string, string];
    const repo = repoKey === '-' ? null : repoKey;
    const spent = group.reduce((a, r) => a + r.spendUsd, 0);
    const title = `${group.length} runs on ${repo ?? 'repo-less work'} failed the same way: ${signature}`;
    out.push({
      id: `issue-failure-${slug(repo ?? 'none')}-${slug(signature)}`,
      kind: 'issue',
      title: `File the failure behind ${group.length} runs on ${repo ?? 'repo-less work'}`,
      evidence: { line: `${title}.`, runs: ev(group), n: group.length },
      expectedEffect: 'One fix stops a whole class of failed runs and the spend they burn.',
      confidence: confidenceOf(group.length, 'pattern'),
      changeMind: 'If the runs share the words but not the cause, split the issue per cause.',
      impact: round(group.length + spent, 2) as number,
      basis: 'pattern',
      action: { issue: { repoRef: repo, title, body: `Runs: ${group.map((r) => r.id).join(', ')}\nSpend: $${spent.toFixed(2)}` } },
    });
  }
  return out;
}

function regressionCandidates(regressions: readonly MetricResult[], runs: readonly RunFact[]): Candidate[] {
  const out: Candidate[] = [];
  // A segment that counted exactly the runs a broader segment did says the same thing twice: keep the first
  // (`all` comes first, then repo, agent, workflow).
  // One recommendation per regressed metric: the broadest segment that regressed (`all`, then repo, agent,
  // workflow). The narrower ones stay listed as regressions; three cards for one cause would crowd out others.
  const seen = new Set<string>();
  for (const r of regressions) {
    if (seen.has(r.metric)) continue;
    seen.add(r.metric);
    const def = METRICS.find((m) => m.id === r.metric) as MetricDef;
    const members = runs.filter((x) => r.runs.includes(x.id));
    const n = r.window.n;
    const gap = Math.abs((r.window.value ?? 0) - (r.baseline.value ?? 0));
    const stakeHours = def.unit === 'minutes' ? (gap * n) / 60 : 0;
    const stakeUsd = def.unit === 'usd' ? gap * n : 0;
    const repo = r.segment.startsWith('repo:') ? r.segment.slice(5) : null;
    const line = findingLine(def, r);
    const setting = r.metric === 'wait_on_people' ? 'gates' : r.segment.startsWith('agent:') ? 'seats' : null;
    const title = `${def.label} got worse for ${segmentWords(r.segment)}`;
    out.push({
      id: `regression-${r.metric}-${slug(r.segment)}`,
      kind: setting !== null ? 'setting' : 'issue',
      title,
      evidence: { line, runs: ev(members), metric: r.metric, segment: r.segment, n, value: r.window.value, baseline: r.baseline.value, interval: r.window.interval },
      expectedEffect: `${def.label} returns toward ${formatValue(def, r.baseline.value)} for ${segmentWords(r.segment)}.`,
      confidence: confidenceOf(n, 'notable'),
      changeMind: 'If the work itself changed (bigger tasks in this window), the baseline is not comparable: watch one more window.',
      impact: round(n + stakeHours + stakeUsd, 2) as number,
      basis: 'notable',
      action: setting !== null ? { setting } : { issue: { repoRef: repo, title, body: line } },
    });
  }
  return out;
}

// ── the analysis ────────────────────────────────────────────────────────────────────────────────────

export function analyze(snapshot: Snapshot): Facts {
  const windowRuns = snapshot.runs.filter(inWindow(snapshot.window));
  const baselineRuns = snapshot.runs.filter((r) => snapshot.baselineWindows.some((w) => inWindow(w)(r)));
  const metrics: MetricResult[] = [];
  for (const seg of segmentsOf(windowRuns)) {
    const w = windowRuns.filter(seg.keep);
    const b = baselineRuns.filter(seg.keep);
    for (const def of METRICS) {
      const ws = sampleOf(def.id, w);
      const bs = sampleOf(def.id, b);
      if (ws.values.length === 0 && bs.values.length === 0) continue;
      const window = statOf(def, ws.values, `${def.id}|${seg.segment}|window`);
      const baseline = statOf(def, bs.values, `${def.id}|${seg.segment}|baseline`);
      metrics.push({
        metric: def.id,
        segment: seg.segment,
        window,
        baseline,
        verdict: compare(window.n, window.interval, baseline.n, baseline.value, def.higherIsBetter),
        runs: ws.ids,
      });
    }
  }
  const defOf = (id: MetricId): MetricDef => METRICS.find((m) => m.id === id) as MetricDef;
  const finding = (r: MetricResult): Finding => ({ metric: r.metric, segment: r.segment, line: findingLine(defOf(r.metric), r), window: r.window, baseline: r.baseline });
  // A segment that counted exactly the runs a broader one did says the same thing twice: keep the broader one.
  const distinct = (ms: MetricResult[]): MetricResult[] => {
    const seen = new Set<string>();
    return ms.filter((m) => {
      const key = `${m.metric}\u0000${[...m.runs].sort().join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const improved = distinct(metrics.filter((m) => m.verdict === 'improved'));
  const regressed = distinct(metrics.filter((m) => m.verdict === 'regressed'));
  const working = distinct(metrics.filter(
    (m) => m.metric === 'pass_rate' && m.verdict !== 'improved' && m.window.n >= MIN_SAMPLE && (m.window.value ?? 0) >= WORKING_WELL_RATE,
  ));
  const improvements = [
    ...improved.map(finding),
    ...working.map((m) => ({ ...finding(m), line: `Working well: ${segmentWords(m.segment)} passed ${formatValue(defOf('pass_rate'), m.window.value)} of the time (n=${m.window.n}).` })),
  ];
  const candidates = [...patternCandidates(windowRuns, snapshot.generatedAtMs), ...regressionCandidates(regressed, windowRuns)]
    .sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id));
  const sum = (f: (r: RunFact) => number): number => windowRuns.reduce((a, r) => a + f(r), 0);
  return {
    version: FACTS_VERSION,
    generatedAtMs: snapshot.generatedAtMs,
    window: snapshot.window,
    baselineWindows: snapshot.baselineWindows,
    projectIds: snapshot.projectIds,
    totals: {
      runs: windowRuns.length,
      baselineRuns: baselineRuns.length,
      passed: windowRuns.filter((r) => r.outcome === 'passed').length,
      failed: windowRuns.filter((r) => r.outcome === 'failed').length,
      cancelled: windowRuns.filter((r) => r.outcome === 'cancelled').length,
      open: windowRuns.filter((r) => r.outcome === 'open').length,
      spendUsd: round(sum((r) => r.spendUsd), 2) as number,
      tokens: sum((r) => r.tokens),
    },
    minSample: MIN_SAMPLE,
    metrics,
    improvements,
    regressions: regressed.map(finding),
    candidates,
    recommended: candidates.slice(0, MAX_RECOMMENDATIONS).map((c) => c.id),
    watching: candidates.slice(MAX_RECOMMENDATIONS).map((c) => c.id),
  };
}
