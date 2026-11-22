/**
 * Run learnings, part 1: what a run's own record says it learned (the operator's 2026-10-30 ask:
 * "with all the run activity, no memories or learnings are being saved").
 *
 * Pure. A run's `SessionView` (its units, as `GET /runs/:id` serves them) and its recorded events in,
 * a list of {@link LearningCandidate}s out. Nothing is written here; {@link ./service.ts} decides
 * what is filed, and everything filed is a PROPOSAL a person approves (never a direct memory write).
 *
 * `material` candidates are raw evidence a person or a seat wrote: the operator's rulings at a
 * gate (a floor override, a QE skip, each with its reason), standing steers from the working
 * document (and, with the engine's context block, the person's Goal, Approach and Constraints read from it), the orchestrator's recorded decisions and their reasons, a QE reviewer that could
 * not run its checks, a reviewer that asked for changes, a check that was red on the base too
 * or ran out of time. They are long and run-specific, so at the end of the run ONE distinct,
 * cheap seat distils them into durable learnings (the builder never grades itself). When no
 * such seat can run they are not filed: raw evidence is the run's record, not a learning.
 */

import { createHash } from 'node:crypto';
import type { SessionView } from 'wicked-crew-api-types';
import type { LooseEvent } from '../insights/run-facts.js';
import { SECTION_LABELS } from '../working-doc/sections.js';

/** What a learning is (the payload's `capture`). */
export type LearningKind = 'gotcha' | 'decision' | 'pattern' | 'steering';

/** Where a candidate came from in the run's record. */
export type LearningSource =
  | 'repo_checks'
  | 'operator_ruling'
  | 'steer'
  | 'working_notes'
  | 'qe_review'
  | 'review';

export interface LearningCandidate {
  /** Stable identity across sweeps of the same run (and across runs for a template). */
  key: string;
  kind: LearningKind;
  source: LearningSource;
  /** `template`: worded here, filed as is. `material`: evidence for the distil seat. */
  form: 'template' | 'material';
  content: string;
  /** The unit it came from, when one did. */
  ord: number | null;
  /** The seat whose work it is about, when one is. */
  cli: string | null;
}

/** The longest material text kept per candidate (a ruling, a steer, a review). */
export const MATERIAL_MAX_CHARS = 1500;
/** The most test names one material candidate names. */
const MAX_TESTS_NAMED = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);

/** Whitespace-folded, lower-cased text: the dedupe form of a learning. */
export function normalizeLearning(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function keyOf(kind: LearningKind, text: string): string {
  return `${kind}:${createHash('sha256').update(normalizeLearning(text)).digest('hex').slice(0, 16)}`;
}

function clip(text: string, max = MATERIAL_MAX_CHARS): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** A test id as the runner printed it, without the runner's own prefix. */
function testName(id: string): string {
  return id.replace(/^(FAIL|test)\s+/u, '').replace(/\s+\[[^\]]*\]$/u, '').trim();
}

function namesList(ids: readonly string[]): string {
  const names = [...new Set(ids.map(testName))].filter((n) => n !== '');
  const shown = names.slice(0, MAX_TESTS_NAMED).map((n) => `\`${n}\``);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** The run's repository name, as the run names it. */
export function repoOf(view: SessionView): string | null {
  return str((view.session as unknown as Record<string, unknown>)['repo_ref']);
}

/** The project the run is filed in, when it is. */
export function projectOf(view: SessionView): string | null {
  return str((view.session as unknown as Record<string, unknown>)['project_id']);
}

/** Every seat that worked on this run: the power-mode lead, each non-reviewing unit's seat and every earlier author of it. */
export function creatorSeats(view: SessionView): string[] {
  const out = new Set<string>();
  const team = (view.session as unknown as Record<string, unknown>)['team'];
  const primary = isRecord(team) && isRecord(team['primary']) ? str(team['primary']['cli']) : null;
  if (primary !== null) out.add(primary);
  for (const u of view.units as unknown as Record<string, unknown>[]) {
    // Every seat that did the run's work: a creator, and a neutral step's seat (triage, recon, plan). Only a
    // reviewing seat (an evaluator) may distil, since it judged the work rather than producing it.
    if (u['role'] === 'evaluator') continue;
    const cli = str(u['assigned_cli']);
    if (cli !== null) out.add(cli);
    // A reassigned or failed-over unit: every seat that authored it built this run too.
    for (const author of strings(u['authored_by'])) out.add(author);
  }
  return [...out];
}

function unitsOf(view: SessionView): Record<string, unknown>[] {
  return (view.units as unknown as Record<string, unknown>[]).filter(isRecord);
}

/** The floor's per-check records of a unit, flattened (head run first, then its reruns). */
function checksOf(unit: Record<string, unknown>): Record<string, unknown>[] {
  const rc = unit['repo_checks'];
  if (!isRecord(rc) || !Array.isArray(rc['checks'])) return [];
  return rc['checks'].filter(isRecord);
}

function fromRepoChecks(view: SessionView, repo: string): LearningCandidate[] {
  const out: LearningCandidate[] = [];
  for (const unit of unitsOf(view)) {
    const ord = typeof unit['ord'] === 'number' ? unit['ord'] : null;
    for (const check of checksOf(unit)) {
      const name = str(check['name']) ?? 'a check';
      const decision = isRecord(check['decision']) ? check['decision'] : {};
      const outcome = str(decision['outcome']);
      if (outcome === 'base_red_unseparated' || outcome === 'timed_out' || outcome === 'flaky_twice') {
        const base = isRecord(check['base']) && isRecord(check['base']['run']) ? check['base']['run'] : null;
        const baseFailed = base !== null ? strings(base['failure_ids']) : [];
        const headFailed = strings(check['failure_ids']);
        const lines = [
          `Repo check \`${name}\` in ${repo}: ${outcome.replace(/_/gu, ' ')}${str(decision['reason']) !== null ? ` (${str(decision['reason'])})` : ''}.`,
          str(check['bound_note']) !== null ? `Bound: ${str(check['bound_note'])}.` : '',
          headFailed.length > 0 ? `Failed on the change: ${namesList(headFailed)}.` : '',
          baseFailed.length > 0 ? `Failed on the base commit too: ${namesList(baseFailed)}.` : '',
        ].filter((l) => l !== '');
        const content = lines.join(' ');
        out.push({ key: keyOf('gotcha', content), kind: 'gotcha', source: 'repo_checks', form: 'material', content, ord, cli: null });
      }
    }
  }
  return out;
}

/** "floor overridden by operator (local (human)): <reason>" → "<reason>" with the action named. */
function rulingText(ruling: Record<string, unknown>): string | null {
  const text = str(ruling['text']);
  if (text === null) return null;
  const action = str(ruling['action']) ?? 'ruling';
  const reason = text.replace(/^[^:]{0,120}\((?:[^()]|\([^()]*\))*\):\s*/u, '').trim();
  const label = action === 'operator_judgment' ? 'The operator overrode a failed check' : action === 'skip_qe' ? 'The operator skipped QE acceptance' : `The operator ruled (${action})`;
  return `${label}: ${reason}`;
}

function fromOperatorRulings(view: SessionView): LearningCandidate[] {
  const out: LearningCandidate[] = [];
  const seen = new Set<string>();
  for (const unit of unitsOf(view)) {
    const ord = typeof unit['ord'] === 'number' ? unit['ord'] : null;
    for (const ruling of Array.isArray(unit['operator_rulings']) ? unit['operator_rulings'].filter(isRecord) : []) {
      const text = rulingText(ruling);
      if (text === null) continue;
      const content = clip(text);
      const key = keyOf('steering', content);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, kind: 'steering', source: 'operator_ruling', form: 'material', content, ord, cli: null });
    }
  }
  return out;
}

/** The QE reviewer could not run its checks: what it said it lacked is a sandbox fact, handed to the distil seat as evidence (which drops sandbox limits as seat-image facts). */
function fromQeReview(view: SessionView): LearningCandidate[] {
  const out: LearningCandidate[] = [];
  for (const unit of unitsOf(view)) {
    const qe = unit['qe_review'];
    if (!isRecord(qe) || qe['outcome'] !== 'inconclusive') continue;
    const reason = str(qe['reason']);
    if (reason === null) continue;
    const content = clip(`The QE reviewer could not run its checks: ${reason}`);
    const attempts = Array.isArray(qe['attempts']) ? qe['attempts'].filter(isRecord) : [];
    const seat = attempts.length > 0 ? str(attempts[attempts.length - 1]?.['seat']) : null;
    out.push({ key: keyOf('gotcha', content), kind: 'gotcha', source: 'qe_review', form: 'material', content, ord: typeof unit['ord'] === 'number' ? unit['ord'] : null, cli: seat });
  }
  return out;
}

/** A standing steer the operator wrote (the working document's Constraints, a typed message). */
function steerText(message: string): string | null {
  const body = message
    .replace(/\[working-doc [^\]]*\]\s*$/u, '')
    .split('\n')
    .filter((l) => !/^(Operator steering from|It adds to your brief|It replaces any standing)/u.test(l.trim()))
    .join('\n')
    .trim();
  return body === '' ? null : body;
}

function fromEvents(events: readonly LooseEvent[]): LearningCandidate[] {
  const out: LearningCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: LearningCandidate): void => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    out.push(c);
  };
  for (const e of events) {
    const ord = typeof e.ord === 'number' ? e.ord : null;
    if (e.type === 'workerMessageQueued') {
      const message = str(e['message']);
      // Only a person's steer: the engine's own queued messages do not say they are the operator's.
      if (message === null || !/operator/iu.test(message.slice(0, 200))) continue;
      const body = steerText(message);
      if (body === null) continue;
      const content = clip(`The operator steered the work: ${body}`);
      push({ key: keyOf('steering', content), kind: 'steering', source: 'steer', form: 'material', content, ord, cli: null });
    } else if (e.type === 'powerWorkingNotes') {
      const seat = str(e['seat']);
      for (const d of Array.isArray(e['decisions']) ? e['decisions'].filter(isRecord) : []) {
        const text = str(d['text']);
        if (text === null) continue;
        const why = str(d['why']);
        const content = clip(why !== null ? `Decision: ${text.trim()} Because: ${why.trim()}` : `Decision: ${text.trim()}`);
        push({ key: keyOf('decision', content), kind: 'decision', source: 'working_notes', form: 'material', content, ord, cli: seat });
      }
    } else if (e.type === 'gateEvaluated') {
      // A distinct reviewer or judge that did NOT pass the work: what it flagged is a pattern candidate.
      const verdict = (str(e['agentVerdict']) ?? str(e['evaluatorVerdict']) ?? '').toLowerCase();
      const reasoning = str(e['agentReasoning']);
      if (reasoning === null || verdict === '' || verdict === 'pass' || verdict === 'none') continue;
      const content = clip(`A reviewer flagged (${verdict}): ${reasoning}`);
      push({ key: keyOf('pattern', content), kind: 'pattern', source: 'review', form: 'material', content, ord, cli: str(e['judgeCli']) });
    }
  }
  return out;
}

/** A section of a person's context, as the run's context document holds it (`WorkingDocService.personContextOf`). */
export interface PersonContextSection { id: string; text: string }

const CONTEXT_LABELS: Readonly<Record<string, string>> = { goal: 'Goal', approach: 'Approach', constraints: 'Constraints' };
/** A section's label in a context document note → its id (the writer's own labels, `working-doc/sections.ts`). */
const LABEL_IDS: ReadonlyMap<string, string> = new Map(Object.entries(SECTION_LABELS).map(([id, label]) => [label, id]));
/** A note's section line, as crew writes it (`working-doc/service.ts` `contextLines`, `steerNote`): "- Goal: …",
 *  "- Next and trailing work (this step): …". */
const LABEL_ALTERNATION = [...LABEL_IDS.keys()].map((l) => l.replace(/[.*+?^$()|[\]\\{}]/gu, '\\$&')).join('|');
const NOTE_SECTION = new RegExp(`^- (${LABEL_ALTERNATION})(?: \\(this step\\))?:(?: (.*))?$`, 'u');
const STEER_PREFIX = 'The operator steered the work: ';
/** A section's value as compared: line breaks as LF, the ends trimmed; case and inner whitespace kept. */
const sectionValue = (t: string): string => t.replace(/\r\n?/gu, '\n').trim();

/** The section values the run's queued steers carried INTO THE EVIDENCE ("id\0value"): what the steer candidates
 *  kept after their clip, never what the raw note held beyond it (review r2). Only the SAME value counts. */
function carriedSections(steers: readonly LearningCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const c of steers) {
    if (c.source !== 'steer' || !c.content.startsWith(STEER_PREFIX)) continue;
    let id: string | null = null;
    let lines: string[] = [];
    const flush = (): void => { if (id !== null) out.add(`${id}\u0000${sectionValue(lines.join('\n'))}`); id = null; lines = []; };
    for (const line of c.content.slice(STEER_PREFIX.length).split('\n')) {
      const m = NOTE_SECTION.exec(line);
      if (m !== null) { flush(); id = LABEL_IDS.get(m[1]!) ?? null; lines = [m[2] ?? '']; continue; }
      if (id !== null) lines.push(line);
    }
    flush();
  }
  return out;
}

/**
 * (crew#1408) The person's Goal, Approach and Constraints from the run's context document. With the engine's context
 * block they no longer travel as queued notes ({@link fromEvents}), so they are read here. A section whose words a
 * queued steer already carried (the bridge's standing note) is not handed over twice.
 */
function fromPersonContext(context: readonly PersonContextSection[], carried: ReadonlySet<string>): LearningCandidate[] {
  const out: LearningCandidate[] = [];
  for (const section of context) {
    const label = CONTEXT_LABELS[section.id];
    const text = str(section.text);
    if (label === undefined || text === null) continue;
    if (carried.has(`${section.id}\u0000${sectionValue(text)}`)) continue;
    const content = clip(`The operator's ${label} for this run: ${text.trim()}`);
    out.push({ key: keyOf('steering', content), kind: 'steering', source: 'steer', form: 'material', content, ord: null, cli: null });
  }
  return out;
}

/**
 * Every learning candidate in a run's record so far. Safe to call at any point of a run (a checkpoint)
 * and again at its end: the same evidence yields the same keys. `context`: the person's current Goal, Approach and
 * Constraints from the run's context document (crew#1408).
 */
export function extractLearnings(view: SessionView, events: readonly LooseEvent[], context: readonly PersonContextSection[] = []): LearningCandidate[] {
  const repo = repoOf(view) ?? 'this repository';
  const steered = fromEvents(events);
  const all = [...fromRepoChecks(view, repo), ...fromOperatorRulings(view), ...fromQeReview(view), ...steered, ...fromPersonContext(context, carriedSections(steered))];
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}
