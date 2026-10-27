/**
 * Real cases, captured from the run store (DES-DEFAULT-EVALS-001 §4). Pure: runs, their events, the operator's
 * gate decisions and the QE ledger's verdicts in; cases out. Idempotent: a case id is derived from the run, unit and
 * event it came from, so capturing twice yields the same cases.
 *
 * `observed` is always what the system recorded THEN (`by: 'recorded'`). `expected` comes from the operator's answer
 * at the gate when it says something about the class, else from a deterministic rule over the case's own evidence.
 * A case is only made when such a label exists: a label that merely repeats the observation would inflate agreement.
 */

import type { EvalCase, Expected } from './types.js';

/** The slice of a run (`GET /runs` row: `{session, units}`) capture reads. */
export interface RunLike {
  session: Record<string, unknown>;
  units: Array<Record<string, unknown>>;
}

/** One engine event (`GET /runs/:id/events`). */
export interface EventLike {
  type: string;
  ord?: number;
  seq?: number;
  ts?: number;
  [k: string]: unknown;
}

/** One operator decision (`GET /decisions` row). */
export interface DecisionLike {
  id: string;
  at: number;
  host?: string;
  origin: { run_id?: string | null; ord?: number | null; choice?: string | null };
}

/** One QE ledger verdict of a run. */
export interface QeVerdictLike {
  runId: string;
  id: string;
  verdict: string;
  reason: string;
  tree: string | null;
  createdAt: string;
}

export interface CaptureInput {
  runs: RunLike[];
  events: (runId: string) => EventLike[];
  decisions: DecisionLike[];
  qeVerdicts: QeVerdictLike[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The place a run belongs to: its project, else its repo. */
export function placeOf(session: Record<string, unknown>): string | null {
  return str(session['project_id']) ?? str(session['repo_ref']);
}

/** Short, path-free text for a case input: home paths and absolute paths are cut, length capped. */
export function scrub(text: string, max = 160): string {
  const cut = text
    .replace(/(?:\/Users|\/home|\/private\/tmp|\/var\/folders)\/[^\s'"`)]*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s'"`)]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

function sortedEvents(events: EventLike[]): EventLike[] {
  return [...events].sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
}

/** The operator's first decision on a run's unit at or after `ts` (and before `until`, when given). */
function decisionAfter(decisions: readonly DecisionLike[], runId: string, ord: number, ts: number, until: number | null): DecisionLike | null {
  let best: DecisionLike | null = null;
  for (const d of decisions) {
    if (d.origin.run_id !== runId || d.origin.ord !== ord || d.at < ts) continue;
    if (until !== null && d.at >= until) continue;
    if (best === null || d.at < best.at) best = d;
  }
  return best;
}

// ── S2: the floor decision class ───────────────────────────────────────────────────────────────────────────────

export const FLOOR_CLASSES = ['pass', 'real_fail', 'base_red', 'inconclusive', 'boundary_deny'] as const;
export type FloorClass = (typeof FLOOR_CLASSES)[number];

interface CheckLike {
  name?: unknown;
  outcome?: unknown;
  envCannotRun?: unknown;
  decision?: { outcome?: unknown } | null;
}

/** What a floor's own check outcomes say it is (the rule the escalation class must agree with). */
export function floorClassOf(ev: EventLike): FloorClass {
  const checks = (Array.isArray(ev['checks']) ? ev['checks'] : []) as CheckLike[];
  // A floor that produced no result (detection failed, no sandbox, not run) is inconclusive, never a pass.
  if (ev['outcome'] === 'not_run' || ev['outcome'] === 'timed_out' || str(ev['detectError']) !== null || str(ev['sandboxError']) !== null) return 'inconclusive';
  const failing = checks.filter((c) => c.outcome !== 'passed' && c.outcome !== 'skipped');
  if (failing.length === 0) {
    if (checks.length === 0) return 'inconclusive';
    return ev['passed'] === false ? 'inconclusive' : 'pass';
  }
  if (failing.some((c) => c.outcome === 'timed_out')) return 'inconclusive';
  if (failing.some((c) => Array.isArray(c.envCannotRun) && c.envCannotRun.length > 0)) return 'inconclusive';
  if (failing.some((c) => c.decision?.outcome === 'flaky_twice')) return 'inconclusive';
  if (failing.every((c) => c.decision?.outcome === 'base_red_unseparated')) return 'base_red';
  return 'real_fail';
}

/** What the engine TOLD the operator: the escalation's condition, read with the floor it sits on. */
export function engineFloorClass(esc: EventLike, floor: EventLike | null): FloorClass {
  if (esc['condition'] === 'boundary_deny') return 'boundary_deny';
  return ruleFloorClass(esc, floor);
}

/** What the floor's own evidence says an escalation on it is. An escalation is never a pass: a floor with no
 *  failing row behind a denial could not say what failed (inconclusive). */
export function ruleFloorClass(esc: EventLike, floor: EventLike | null): FloorClass {
  if (esc['denialSource'] === 'repo_checks_timeout') return 'inconclusive';
  if (floor === null) return 'inconclusive';
  const c = floorClassOf(floor);
  return c === 'pass' ? 'inconclusive' : c;
}

export function captureFloorCases(input: CaptureInput): EvalCase[] {
  const out: EvalCase[] = [];
  for (const run of input.runs) {
    const runId = str(run.session['id']);
    if (runId === null) continue;
    const events = sortedEvents(input.events(runId));
    const escalations = events.filter(
      (e) => e.type === 'gateEscalated' && typeof e['denialSource'] === 'string' && (e['denialSource'] as string).startsWith('repo_checks'),
    );
    for (const esc of escalations) {
      const ord = num(esc.ord);
      const ts = num(esc.ts);
      if (ord === null || ts === null) continue;
      // The floor of the SAME attempt (agy r1): an attempt that escalated without its own floor reads none.
      const attempt = num(esc['attempt']);
      const floor =
        [...events]
          .reverse()
          .find((e) => e.type === 'repoChecksEvaluated' && e.ord === ord && (num(e.ts) ?? 0) <= ts && (attempt === null || num(e['attempt']) === null || num(e['attempt']) === attempt)) ?? null;
      const ruleClass = ruleFloorClass(esc, floor);
      const observed = engineFloorClass(esc, floor);
      const nextEsc = events.find((e) => e.type === 'gateEscalated' && e.ord === ord && (num(e.ts) ?? 0) > ts);
      const decision = decisionAfter(input.decisions, runId, ord, ts, nextEsc !== undefined ? (num(nextEsc.ts) ?? null) : null);
      let expected: Expected = {
        label: ruleClass,
        by: 'rule',
        why: `a floor that ran (denial source ${String(esc['denialSource'])}) is judged by its own checks, never as a boundary deny`,
      };
      if (decision?.origin.choice === 'operator_judgment' && ruleClass === 'real_fail') {
        expected = { label: 'inconclusive', by: 'operator', why: 'the operator overrode the floor: not a real failure of the change' };
      } else if (decision?.origin.choice === 'request_changes') {
        expected = { label: 'real_fail', by: 'operator', why: 'the operator sent the work back: the failure was real' };
      }
      // A case only when something other than the observation labels it: a disagreement with the rule, or the
      // operator's answer. Agreeing rule-only cases are still evidence (the engine got it right) and are kept.
      const failing = ((Array.isArray(floor?.['checks']) ? floor['checks'] : []) as CheckLike[])
        .filter((c) => c.outcome !== 'passed' && c.outcome !== 'skipped')
        .map((c) => String(c.name ?? '?'))
        .sort();
      out.push({
        id: `floor-class:${runId}:${ord}:${num(esc.seq) ?? ts}`,
        suite: 'floor-class',
        source: 'real',
        project: placeOf(run.session),
        inputKey: `floor:${ruleClass}:${String(esc['denialSource'])}`,
        input: { condition: esc['condition'], denialSource: esc['denialSource'], attempt: esc['attempt'] ?? null, failing },
        observed: { label: observed, by: 'recorded' },
        expected,
        evidence: { runId, ord, ...(num(esc.seq) !== null ? { seq: num(esc.seq)! } : {}), ...(decision !== null ? { decisionId: decision.id } : {}) },
      });
    }
  }
  return out;
}

// ── S3: the QE verdict ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The verdict a QE reason states in its own words, read conservatively: only an explicit verdict token counts, at
 * the very start of the reason (after an optional `[tag]`), or after `verdict:` or a colon (`review: PASS.`).
 * Prose that merely mentions passing or failing ("no tests failed", "cannot pass") states no verdict: `null`,
 * and the case is left unlabelled rather than labelled wrong.
 */
export function verdictInReason(reason: string): 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null {
  const head = reason.slice(0, 160);
  const word = (w: string): 'PASS' | 'FAIL' | 'INCONCLUSIVE' => (/^inc/i.test(w) ? 'INCONCLUSIVE' : /^pass/i.test(w) ? 'PASS' : 'FAIL');
  const lead = /^\s*(?:\[[^\]]*\]\s*)?(inconclusive|pass|fail)\b(?!\s+(?:to|if|when|because)\b)/i.exec(head);
  if (lead !== null) return word(lead[1]!);
  const declared = /(?:\bverdict\s*[:=]|:)\s*(PASS|FAIL|INCONCLUSIVE)\b/.exec(head);
  if (declared !== null) return word(declared[1]!);
  return null;
}

/** The tree the run's QE decision named last at or before `at` (ms); `null` when none did. */
export function qeTreeAt(events: readonly EventLike[], at: number): string | null {
  let tree: string | null = null;
  for (const e of sortedEvents([...events])) {
    if (e.type !== 'qeAcceptanceDecided' || (num(e.ts) ?? Infinity) > at) continue;
    tree = str((e['qe'] as Record<string, unknown> | undefined)?.['tree']) ?? tree;
  }
  return tree;
}

export function captureQeCases(input: CaptureInput): EvalCase[] {
  const out: EvalCase[] = [];
  const place = new Map(input.runs.map((r) => [str(r.session['id']), placeOf(r.session)] as const));
  for (const v of input.qeVerdicts) {
    const said = verdictInReason(v.reason);
    if (said === null) continue;
    out.push({
      id: `qe-verdict:${v.runId}:${v.id}`,
      suite: 'qe-verdict',
      source: 'real',
      project: place.get(v.runId) ?? null,
      inputKey: `qe:${said}`,
      input: { reason: scrub(v.reason), tree: v.tree },
      observed: { label: v.verdict.toUpperCase(), by: 'recorded' },
      expected: { label: said, by: 'rule', why: 'the reviewer’s own reason states this verdict' },
      evidence: { runId: v.runId },
    });
  }
  // Test-retest: one tree judged twice should get one answer. A verdict that carries no tree stamp judged the tree
  // the run's QE decision named last before the verdict was written.
  const byTree = new Map<string, QeVerdictLike[]>();
  for (const raw of input.qeVerdicts) {
    const v = raw.tree !== null ? raw : { ...raw, tree: qeTreeAt(input.events(raw.runId), Date.parse(raw.createdAt)) };
    if (v.tree === null) continue;
    const k = `${v.runId}\u0000${v.tree}`;
    byTree.set(k, [...(byTree.get(k) ?? []), v]);
  }
  for (const vs of byTree.values()) {
    if (vs.length < 2) continue;
    const words = new Set(vs.map((v) => v.verdict.toUpperCase()));
    const first = vs[0]!;
    out.push({
      id: `qe-verdict:retest:${first.runId}:${first.tree}`,
      suite: 'qe-verdict',
      source: 'real',
      project: place.get(first.runId) ?? null,
      inputKey: 'qe:retest',
      input: { tree: first.tree, verdicts: vs.map((v) => v.verdict.toUpperCase()).sort() },
      observed: { label: words.size === 1 ? 'same' : 'differs', by: 'recorded' },
      expected: { label: 'same', by: 'rule', why: 'one tree, one verdict' },
      evidence: { runId: first.runId },
    });
  }
  return out;
}

// ── S4: builder attribution ────────────────────────────────────────────────────────────────────────────────────

/**
 * The seats whose attempts on a unit changed the tree, and the last of them. One chronological pass: the seat in
 * force is the latest of the engine's own seat events for the unit (`skillsSnapshotHanded {cli}` for an attempt,
 * `unitReassigned.newCli`, a `stepFailed` "failing over to"); the plan-time `unitDistributed.cli` is only the
 * starting point (it can name a seat the unit never ran on). An attempt is an author only when its floor recorded
 * changed paths. `null` when the unit ran no floor (nothing to read).
 */
export function changingSeats(events: readonly EventLike[], ord: number, firstCli: string | null): { authors: string[]; last: string | null } | null {
  let cli = firstCli;
  let last: string | null = null;
  const authors = new Set<string>();
  let sawFloor = false;
  for (const e of events) {
    if (e.ord !== ord) continue;
    if (e.type === 'skillsSnapshotHanded' && str(e['cli']) !== null) cli = str(e['cli']);
    if (e.type === 'unitReassigned' && str(e['newCli']) !== null) cli = str(e['newCli']);
    if (e.type === 'stepFailed') {
      const m = /failing over to '([^']+)'/.exec(String(e['detail'] ?? ''));
      if (m !== null) cli = m[1]!;
    }
    if (e.type === 'repoChecksEvaluated') {
      sawFloor = true;
      const changed = Array.isArray(e['changed']) ? e['changed'] : [];
      if (changed.length > 0 && cli !== null) {
        authors.add(cli);
        last = cli;
      }
    }
  }
  return sawFloor ? { authors: [...authors].sort(), last } : null;
}

const NOT_A_SEAT = new Set(['bash', 'tool']);

export function captureAttributionCases(input: CaptureInput): EvalCase[] {
  const out: EvalCase[] = [];
  for (const run of input.runs) {
    const runId = str(run.session['id']);
    if (runId === null) continue;
    const events = sortedEvents(input.events(runId));
    const firstCli = new Map<number, string>();
    for (const e of events) if (e.type === 'unitDistributed' && num(e.ord) !== null && str(e['cli']) !== null && !firstCli.has(e.ord!)) firstCli.set(e.ord!, String(e['cli']));
    const builders = new Map<number, { authors: string[]; last: string | null }>();
    for (const u of run.units) {
      const ord = num(u['ord']);
      if (ord === null || u['stage'] !== 'build' || u['role'] !== 'creator') continue;
      const seats = changingSeats(events, ord, firstCli.get(ord) ?? str(u['assigned_cli']));
      if (seats === null || seats.authors.length === 0) continue;
      builders.set(ord, seats);
      const authored = (Array.isArray(u['authored_by']) ? u['authored_by'] : []).filter((x): x is string => typeof x === 'string');
      if (authored.length > 0) {
        out.push({
          id: `attribution:${runId}:${ord}:authors`,
          suite: 'attribution',
          source: 'real',
          project: placeOf(run.session),
          // Each unit's authorship is its own question (different runs have different builders), so no cross-place key.
          inputKey: `attribution:${runId}:${ord}:authors`,
          input: { unit: ord, kind: 'build unit authors' },
          observed: { labels: [...authored].sort(), by: 'recorded' },
          expected: { labels: seats.authors, by: 'rule', why: 'an author is a seat whose attempt changed the tree' },
          evidence: { runId, ord },
        });
      }
    }
    if (builders.size === 0) continue;
    for (const u of run.units) {
      const ord = num(u['ord']);
      if (ord === null || u['role'] !== 'evaluator') continue;
      const creator = str((u['assurance'] as Record<string, unknown> | undefined)?.['creator']);
      if (creator === null || NOT_A_SEAT.has(creator)) continue;
      // The receipt's creator is ONE seat: the latest builder's (codex r1). The full author set is scored on the
      // build unit itself, above.
      const latest = [...builders.entries()].filter(([o]) => o < ord).sort(([a], [b]) => b - a)[0];
      if (latest === undefined || latest[1].last === null) continue;
      out.push({
        id: `attribution:${runId}:${ord}:creator`,
        suite: 'attribution',
        source: 'real',
        project: placeOf(run.session),
        inputKey: `attribution:${runId}:${ord}:creator`,
        input: { unit: ord, kind: 'creator named on a reviewing unit' },
        observed: { labels: creator.split(/,\s*/).sort(), by: 'recorded' },
        expected: { labels: [latest[1].last], by: 'rule', why: 'the creator of reviewed work is the seat that last changed the tree' },
        evidence: { runId, ord },
      });
    }
  }
  return out;
}

// ── S5: steering firing, from real denials ─────────────────────────────────────────────────────────────────────

/** An input-governance deny the operator then let through is a candidate false alarm; one they stopped stood. */
export function captureSteeringDenials(input: CaptureInput): EvalCase[] {
  const out: EvalCase[] = [];
  for (const run of input.runs) {
    const runId = str(run.session['id']);
    if (runId === null) continue;
    const events = sortedEvents(input.events(runId));
    for (const esc of events) {
      if (esc.type !== 'gateEscalated' || esc['denialSource'] !== 'input_governance') continue;
      const ord = num(esc.ord);
      const ts = num(esc.ts);
      if (ord === null || ts === null) continue;
      const next = events.find((e) => e.type === 'gateEscalated' && e.ord === ord && (num(e.ts) ?? 0) > ts);
      const d = decisionAfter(input.decisions, runId, ord, ts, next !== undefined ? (num(next.ts) ?? null) : null);
      const choice = d?.origin.choice ?? null;
      if (choice === null) continue;
      const letThrough = choice === 'approve' || choice === 'operator_judgment' || choice === 'rejudge';
      const stood = choice === 'reject' || choice === 'request_changes';
      if (!letThrough && !stood) continue;
      out.push({
        id: `steering:${runId}:${ord}:${num(esc.seq) ?? ts}`,
        suite: 'steering',
        source: 'real',
        project: placeOf(run.session),
        inputKey: 'steering:input-governance-deny',
        input: { condition: esc['condition'], summary: scrub(String(esc['verdictSummary'] ?? '')) },
        observed: { label: 'block', by: 'recorded' },
        expected: {
          label: letThrough ? 'allow' : 'block',
          by: 'operator',
          why: letThrough ? 'the operator approved the refused work' : 'the operator stopped or sent back the refused work',
        },
        evidence: { runId, ord, ...(num(esc.seq) !== null ? { seq: num(esc.seq)! } : {}), ...(d !== null ? { decisionId: d.id } : {}) },
      });
    }
  }
  return out;
}

// ── S7: archetype routing, real prompts with the workflow the operator chose ───────────────────────────────────

/** The workflow a person launched → the garden archetype it is. System workflows are not a routing choice. */
export function archetypeOfWorkflow(workflowId: string): string | null {
  if (workflowId.startsWith('wf-')) return 'explore'; // an ask / chat turn: a question about the code
  switch (workflowId) {
    case 'bug':
    case 'feature':
    case 'mcp-server':
    case 'editor-plugin':
      return 'build';
    case 'learn':
      return 'explore';
    case 'review':
      return 'review';
    default:
      return null; // onboarding, capture-learnings and other system workflows
  }
}

export function captureArchetypeCases(input: CaptureInput): EvalCase[] {
  const seen = new Set<string>();
  const out: EvalCase[] = [];
  for (const run of input.runs) {
    const s = run.session;
    const wf = str(s['workflow_id']);
    const title = str(s['title']);
    if (wf === null || title === null) continue;
    const label = archetypeOfWorkflow(wf);
    if (label === null) continue;
    const prompt = scrub(title, 200);
    // One prompt asked twice in one place is one case (repeats are not evidence); the same prompt in another
    // project is that project's evidence, and the cross-project comparison needs it (codex r1).
    const key = `${placeOf(s) ?? ''}\u0000${label}\u0000${prompt.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `archetype:${String(s['id'])}`,
      suite: 'archetype',
      source: 'real',
      project: placeOf(s),
      inputKey: `archetype:${prompt.toLowerCase()}`,
      input: { prompt },
      observed: null, // replayed through the current classifier at run time
      expected: { label, by: 'operator', why: `the operator launched it as ${wf.startsWith('wf-') ? 'an ask' : wf}` },
      evidence: { runId: String(s['id']) },
    });
  }
  return out;
}

/** Every real case the run store yields. */
export function captureAll(input: CaptureInput): EvalCase[] {
  return [
    ...captureFloorCases(input),
    ...captureQeCases(input),
    ...captureAttributionCases(input),
    ...captureSteeringDenials(input),
    ...captureArchetypeCases(input),
  ];
}
