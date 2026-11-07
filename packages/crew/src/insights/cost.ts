/**
 * Model run cost (DES-CATALOG-002 CS6): the facts a cost model rests on. Pure and deterministic: crew's run facts
 * ({@link RunFact}, the review's preparer) in, {@link CostFacts} out, and {@link renderCostFacts} the one text the
 * `run-cost` workflow's `facts` Tool prints. That text is the record the model step cites and the check step re-checks:
 * no number in a cost report may come from anywhere else.
 *
 * Population (said in the facts, so the report can state it):
 *  - comparable runs are the TERMINAL runs (completed, failed, cancelled) launched in the window, grouped by the
 *    workflow or preset they ran; failed, cancelled and retried runs count, because they cost money;
 *  - wall time is launch to the recorded terminal time, for every run that has one (not `time_to_pr`, which covers
 *    delivered runs only);
 *  - spend rests on FULLY priced runs (every usage frame carried a cost); a partly priced run's sum is a lower bound,
 *    given apart; an unpriced run has no spend.
 */

import type { RunFact, RunOutcome } from './run-facts.js';
import { percentileSorted, sortedCopy } from './stats.js';
import { isSystemWorkflow } from '../core/run-identity.js';

export const COST_FACTS_VERSION = 1;
/** The window the facts look back over. */
export const COST_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
/** The workflow whose `facts` step may read these facts (crew's route checks it). */
export const RUN_COST_WORKFLOW = 'run-cost';
/** The step, and its exact command, that may read them (`src/presets/run-cost.json` in wicked-core). */
export const RUN_COST_FACTS_STEP = 'facts';
export const RUN_COST_FACTS_CMD: readonly string[] = ['wicked-crew', 'insights-facts'];
/**
 * The most bytes the printed facts may take: the engine hands a prior output to the next steps clipped to a share of
 * 96 KB (48 KB at most, its middle removed). The WHOLE block is budgeted: the header, then the groups largest first
 * (each group's lines whole, a group that does not fit is named on one omitted line), then the runs newest first, each
 * omission counted.
 */
export const COST_TEXT_BUDGET = 36 * 1024;

/** `full`: every usage frame priced; `partial`: some; `unpriced`: frames, none priced; `none`: no usage frame;
 *  `unknown`: the run's events could not be read. */
export type Pricing = 'full' | 'partial' | 'unpriced' | 'none' | 'unknown';
export const PRICING: readonly Pricing[] = ['full', 'partial', 'unpriced', 'none', 'unknown'];

export interface Dist {
  n: number;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface CostGroup {
  /** `G1`.. in order (most runs first, then by name). */
  id: string;
  workflow: string;
  runs: number;
  outcomes: { passed: number; failed: number; cancelled: number };
  /** Minutes, over the runs with a recorded terminal time; `unmeasured` = the runs without one. */
  wall: Dist & { unmeasured: number };
  pricing: Record<Pricing, number>;
  /** USD over the fully priced runs only. */
  spend: Dist & { total: number };
  /** Σ USD of the partly priced runs: a lower bound of what they cost. */
  partialTotal: number;
}

export interface CostRow {
  /** `R1`.. newest first. */
  id: string;
  group: string;
  run: string;
  workflow: string;
  outcome: Exclude<RunOutcome, 'open'>;
  launchedAtMs: number;
  /** Minutes, launch to the recorded terminal time; `null` when none was recorded. */
  wallMinutes: number | null;
  /** USD as recorded: the run's spend when fully priced, the lower bound when partly priced; `null` when no spend
   *  was measured (unpriced, none, unknown), never a measured zero. */
  spendUsd: number | null;
  pricing: Pricing;
  pricedFrames: number;
  unpricedFrames: number;
  retries: number;
}

export interface CostFacts {
  version: typeof COST_FACTS_VERSION;
  generatedAtMs: number;
  window: { startMs: number; endMs: number; days: number };
  scope: string;
  /** What the population leaves out, counted. */
  excluded: { open: number; system: number; unnamed: number; self: number };
  rules: string[];
  groups: CostGroup[];
  rows: CostRow[];
}

export const COST_RULES: readonly string[] = [
  'population: the terminal runs (completed, failed, cancelled) launched in the window, grouped by the workflow or preset they ran (a saved preset under a built-in name counts with it); failed, cancelled and retried runs count, because they cost money',
  'left out: open runs, system runs (chat, onboarding, document seams and the like), unnamed runs (free text or a user plan) and this run',
  'wall time: launch to the recorded terminal time (the terminal event, else the engine record), in minutes; a run with neither is counted as unmeasured',
  'spend: the USD the agent CLIs reported on their usage frames. pricing full = every frame priced; partial = some; unpriced = frames, none priced; none = no usage frame; unknown = the run events could not be read',
  'spend percentiles and total rest on the fully priced runs only; partial_total is a lower bound over the partly priced runs; unpriced, none and unknown runs have no spend',
  'percentiles: linear interpolation over the sorted values; p50 is the median',
  'the values as printed are the record: cite them by id and do arithmetic on them as printed',
];

/** Unnamed: the resolved identity has no name; only a fact with no identity falls back to the id's shape. */
const unnamed = (r: RunFact): boolean =>
  r.runName !== undefined ? r.runName === null : r.workflow === 'free-text' || r.workflow.startsWith('wf-') || r.workflow.includes(':plan-');
const system = (r: RunFact): boolean => r.system === true || isSystemWorkflow(r.runName ?? r.workflow);
/** The group a run counts in: its resolved name, else its workflow id. */
const nameOf = (r: RunFact): string => r.runName ?? r.workflow;
const TERMINAL: ReadonlySet<string> = new Set(['passed', 'failed', 'cancelled']);

export function pricingOf(r: Pick<RunFact, 'pricedFrames' | 'unpricedFrames' | 'eventsUnreadable'>): Pricing {
  if (r.eventsUnreadable === true) return 'unknown';
  if (r.pricedFrames > 0) return r.unpricedFrames > 0 ? 'partial' : 'full';
  return r.unpricedFrames > 0 ? 'unpriced' : 'none';
}

function dist(values: readonly number[]): Dist {
  const sorted = sortedCopy(values);
  return { n: sorted.length, p50: percentileSorted(sorted, 0.5), p75: percentileSorted(sorted, 0.75), p90: percentileSorted(sorted, 0.9) };
}

/** The window ending at `nowMs`. */
export function costWindow(nowMs: number, days = COST_WINDOW_DAYS): CostFacts['window'] {
  return { startMs: nowMs - days * DAY_MS, endMs: nowMs, days };
}

/**
 * The cost facts of `runs` (already limited to launches in `window` by the preparer). `excludeRunId` is the asking
 * run, left out of its own population.
 */
export function costFacts(
  runs: readonly RunFact[],
  opts: { window: CostFacts['window']; generatedAtMs: number; excludeRunId?: string | null; scope?: string },
): CostFacts {
  const excluded = { open: 0, system: 0, unnamed: 0, self: 0 };
  const kept: RunFact[] = [];
  for (const r of runs) {
    if (r.createdAtMs < opts.window.startMs || r.createdAtMs >= opts.window.endMs) continue;
    if (opts.excludeRunId != null && r.id === opts.excludeRunId) excluded.self += 1;
    else if (!TERMINAL.has(r.outcome)) excluded.open += 1;
    else if (unnamed(r)) excluded.unnamed += 1;
    else if (system(r)) excluded.system += 1;
    else kept.push(r);
  }
  const byWorkflow = new Map<string, RunFact[]>();
  for (const r of kept) byWorkflow.set(nameOf(r), [...(byWorkflow.get(nameOf(r)) ?? []), r]);
  const order = [...byWorkflow.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const groupOf = new Map<string, string>();
  const wallOf = (r: RunFact): number | null => (r.terminalAtMs === null ? null : Math.max(0, r.terminalAtMs - r.createdAtMs) / MIN_MS);
  const groups: CostGroup[] = order.map(([workflow, rs], i) => {
    const id = `G${i + 1}`;
    groupOf.set(workflow, id);
    const pricing = Object.fromEntries(PRICING.map((p) => [p, 0])) as Record<Pricing, number>;
    for (const r of rs) pricing[pricingOf(r)] += 1;
    const walls = rs.map(wallOf).filter((w): w is number => w !== null);
    const full = rs.filter((r) => pricingOf(r) === 'full').map((r) => r.spendUsd);
    return {
      id,
      workflow,
      runs: rs.length,
      outcomes: {
        passed: rs.filter((r) => r.outcome === 'passed').length,
        failed: rs.filter((r) => r.outcome === 'failed').length,
        cancelled: rs.filter((r) => r.outcome === 'cancelled').length,
      },
      wall: { ...dist(walls), unmeasured: rs.length - walls.length },
      pricing,
      spend: { ...dist(full), total: full.reduce((a, b) => a + b, 0) },
      partialTotal: rs.filter((r) => pricingOf(r) === 'partial').reduce((a, r) => a + r.spendUsd, 0),
    };
  });
  const rows: CostRow[] = [...kept]
    .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : 1))
    .map((r, i) => ({
      id: `R${i + 1}`,
      group: groupOf.get(nameOf(r)) as string,
      run: r.id,
      workflow: nameOf(r),
      outcome: r.outcome as CostRow['outcome'],
      launchedAtMs: r.createdAtMs,
      wallMinutes: wallOf(r),
      spendUsd: pricingOf(r) === 'full' || pricingOf(r) === 'partial' ? r.spendUsd : null,
      pricing: pricingOf(r),
      pricedFrames: r.pricedFrames,
      unpricedFrames: r.unpricedFrames,
      retries: r.retries,
    }));
  return {
    version: COST_FACTS_VERSION,
    generatedAtMs: opts.generatedAtMs,
    window: opts.window,
    scope: opts.scope ?? 'every run on this daemon, all projects and repositories',
    excluded,
    rules: [...COST_RULES],
    groups,
    rows,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const minutes = (v: number | null): string => (v === null ? 'none' : v.toFixed(2));
const usd = (v: number | null): string => (v === null ? 'none' : v.toFixed(6));

/** One group's lines; each value is cited as `<group>.<line>.<key>` (`G1.wall.p75`, `G1.spend.p50`, `G1.pricing.full`). */
function groupLines(g: CostGroup): string[] {
  return [
    `${g.id} workflow=${g.workflow} runs=${g.runs} passed=${g.outcomes.passed} failed=${g.outcomes.failed} cancelled=${g.outcomes.cancelled}`,
    `${g.id}.wall (minutes): n=${g.wall.n} unmeasured=${g.wall.unmeasured} p50=${minutes(g.wall.p50)} p75=${minutes(g.wall.p75)} p90=${minutes(g.wall.p90)}`,
    `${g.id}.pricing (runs): ${PRICING.map((p) => `${p}=${g.pricing[p]}`).join(' ')}`,
    `${g.id}.spend (USD, fully priced runs only): n=${g.spend.n} p50=${usd(g.spend.p50)} p75=${usd(g.spend.p75)} p90=${usd(g.spend.p90)} total=${usd(g.spend.n === 0 ? null : g.spend.total)} partial_total=${usd(g.partialTotal)}`,
  ];
}

function rowLine(r: CostRow): string {
  // A partly priced run's sum is a lower bound, and says so; a run with no measured spend reads `none`, never 0.
  const spend = r.pricing === 'partial' ? `spend_at_least=${usd(r.spendUsd)}` : `spend=${usd(r.spendUsd)}`;
  return `${r.id} ${r.group} run=${r.run} outcome=${r.outcome} launched=${iso(r.launchedAtMs)} wall=${minutes(r.wallMinutes)} ${spend} pricing=${r.pricing} frames=${r.pricedFrames}/${r.unpricedFrames} retries=${r.retries}`;
}

/**
 * The facts as the `facts` step prints them, the whole block within `budget` bytes: a header (window, scope, what is left
 * out, the rules, the citation grammar), the groups largest first (a group's lines whole; groups that do not fit are
 * named on one line, as far as it fits, and counted), then the runs newest first, the omitted count said. Every
 * statistic is over every run of its group, shown or not.
 */
export function renderCostFacts(f: CostFacts, budget = COST_TEXT_BUDGET): string {
  const bytes = (t: string): number => Buffer.byteLength(t);
  const head = [
    `RUN-COST FACTS v${f.version} (crew's run record, read by wicked-crew insights-facts; read-only)`,
    `taken: ${iso(f.generatedAtMs)}`,
    `window: ${iso(f.window.startMs)} to ${iso(f.window.endMs)} (${f.window.days} days)`,
    `scope: ${f.scope}`,
    `left out: ${f.excluded.open} open, ${f.excluded.system} system, ${f.excluded.unnamed} unnamed, ${f.excluded.self} this run`,
    'rules:',
    ...f.rules.map((r) => `- ${r}`),
    'cite: a group value as <group>.<line>.<key> (G1.wall.p75, G1.spend.p50, G1.spend.total, G1.pricing.full, G1.runs, G1.failed); a run as its R id',
  ].join('\n') + '\n';
  // Room kept for the closing lines (the omitted-groups line is cut to fit what is left of it).
  const RESERVE = 600;
  let text = head;
  const shown: string[] = [];
  const omitted: CostFacts['groups'] = [];
  for (const g of f.groups) {
    const block = `${groupLines(g).join('\n')}\n`;
    if (omitted.length === 0 && bytes(text) + bytes(block) + RESERVE <= budget) {
      shown.push(block);
      text += block;
    } else omitted.push(g);
  }
  let out = `${head}groups (${shown.length} of ${f.groups.length} shown, largest first):\n`;
  if (f.groups.length === 0) out += '(none: no terminal named run in the window)\n';
  out += shown.join('');
  if (omitted.length > 0) {
    let line = `(${omitted.length} smaller groups omitted to fit the step's context:`;
    for (const g of omitted) {
      const part = ` ${g.id}:${g.workflow}=${g.runs}`;
      if (bytes(out) + bytes(line) + bytes(part) + 2 > budget - 200) {
        line += ' ...';
        break;
      }
      line += part;
    }
    out += `${line})\n`;
  }
  const rowsHead = (n: number): string => `runs (newest first; ${n} of ${f.rows.length} shown; every statistic above is over all ${f.rows.length}):\n`;
  const tail = (n: number): string => (n < f.rows.length ? `(${f.rows.length - n} older runs omitted to fit the step's context)\n` : '');
  const lines: string[] = [];
  let size = bytes(out) + bytes(rowsHead(f.rows.length)) + bytes(tail(0));
  for (const r of f.rows) {
    const line = `${rowLine(r)}\n`;
    if (size + bytes(line) > budget) break;
    size += bytes(line);
    lines.push(line);
  }
  return out + rowsHead(lines.length) + lines.join('') + tail(lines.length);
}
