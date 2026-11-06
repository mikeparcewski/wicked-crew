/**
 * The working document's EVENT-DERIVED lines, written by crew (operator 2026-10-30: "the plugin should fill it from
 * events"; rig run ea73afc0: the lines were written only by whichever studio tab had the run open, so a run nobody
 * viewed got no Decisions, Open questions or Next). Pure: a fold of the run's own CoreEvents.
 *
 *  - Decisions: each decision answered (a gate, a checkpoint pause: who and what). Kept, never taken back.
 *  - Open questions: what waits on a person now (an open gate, a pause). Gone once answered.
 *  - Next and trailing work: what the newest hand-off round left (a step that failed or was skipped). Gone once a
 *    later round passes it.
 *
 * The words are the Phase report plugin's own (wicked-studio `plugins/wicked-phase-report/workingDoc.ts`), line for
 * line, so a document the plugin wrote before and one crew writes now read the same, and the plugin's "mine" patterns
 * match crew's lines. They are written as the plugin's actor (`plugin:wicked-phase-report@…`), and like every plugin
 * line they never steer: only a person's edit does (`WorkingDocService.record`).
 */

import type { CoreEvent } from '../core/types.js';

/** The actor crew writes these lines as: the Phase report plugin's id, at the version of these words. */
export const PHASE_REPORT_WRITER = { id: 'wicked-phase-report', version: '0.14.0' } as const;
export const PHASE_REPORT_AUTHOR = `plugin:${PHASE_REPORT_WRITER.id}@${PHASE_REPORT_WRITER.version}`;

export type PauseChoice = 'continue_high' | 'continue' | 'switch_phased' | 'stop';
interface GateInfo {
  ord: number; kind: string; openedAt: number; answeredAt: number | null; reviewingOrd: number | null;
  /** A plan gate only: when the plan it held started (a step at or after the gate's ord ran). A plan sent back re-runs
   *  the step that wrote it (an earlier ord), so it is answered but never approved (xreview r2). */
  approvedAt: number | null;
}
interface PauseInfo { n: number; at: number; kinds: string[]; choice: PauseChoice | null; byPerson: boolean; answeredAt: number | null }
export interface LinesModel {
  gates: GateInfo[];
  pauses: PauseInfo[];
  checkpoints: number[];
  handoff: { round: number; steps: Map<string, string> } | null;
  finished: number | null;
  power: boolean;
  /** The units that started (`unitExecuting`), distinct ords in order: a plan with a second step started is settled. */
  started: number[];
  /** How many units the engine announced (`unitPlanned`): a replan announces its fresh units. */
  planned: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const word = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(v) ? v.slice(0, 40) : null);

/** A checkpoint pause's free-text reasons as closed kinds (the plugin's `pauseKinds`). */
export function pauseKinds(reason: string): string[] {
  const t = reason.replace(/^struggling:\s*/i, '');
  const out: string[] = [];
  for (const part of t.split(/;\s*/)) {
    if (part.trim() === '') continue;
    if (/min against an estimate of/i.test(part)) out.push('longer_than_estimated');
    else if (/failed test runs?/i.test(part)) out.push('tests_failing');
    else if (/reverts?/i.test(part)) out.push('changes_undone');
    else if (/rigor jumped/i.test(part)) out.push('rigor_jumped');
    else if (/spread into another product|spans? \d+ (products|packages)/i.test(part)) out.push('spread');
    else out.push('other');
  }
  return out;
}

const byKind = (by: unknown): 'engine' | 'plugin' | 'person' | null => {
  const s = typeof by === 'string' ? by : '';
  return s === 'engine' ? 'engine' : s.startsWith('plugin:') ? 'plugin' : s === '' ? null : 'person';
};

/** The newest pause takes this answer; a plain "it went on" is refined by a specific answer, never the reverse. */
function answerPause(m: LinesModel, choice: PauseChoice, byPerson: boolean, at: number): void {
  const open = m.pauses.at(-1);
  if (open === undefined || at < open.at) return;
  const refine = open.choice === 'continue' && !open.byPerson && choice !== 'continue' && (m.checkpoints.at(-1) ?? open.n) === open.n;
  if (open.choice !== null && !refine) return;
  open.choice = choice;
  open.byPerson = byPerson;
  open.answeredAt = at;
}

/** Fold a run's events (its recorded log, in `seq` order) into what the lines need. */
export function foldLines(events: readonly CoreEvent[]): LinesModel {
  const m: LinesModel = { gates: [], pauses: [], checkpoints: [], handoff: null, finished: null, power: false, started: [], planned: 0 };
  const sorted = [...events].sort((a, b) => (num((a as unknown as Record<string, unknown>)['seq']) ?? 0) - (num((b as unknown as Record<string, unknown>)['seq']) ?? 0));
  for (const e of sorted) {
    const ev = e as unknown as Record<string, unknown>;
    const at = num(ev['ts']) ?? 0;
    const ord = num(ev['ord']);
    switch (e.type as string) {
      case 'sessionCompleted': case 'sessionFailed': case 'runCancelled':
        m.finished = at;
        answerPause(m, e.type === 'runCancelled' ? 'stop' : 'continue', false, at);
        break;
      // Any resume or unit start after a gate opened answers it, whatever its ord (ea73afc0: the ord-4 escalation
      // resumed at ord 3 in the same second and read "Waiting on you" for the rest of the run). The same rule as the
      // studio plugin (lane ui-gaps).
      case 'resumed':
      case 'unitExecuting':
        if (m.finished !== null && at >= m.finished) m.finished = null;
        for (const g of m.gates) if (g.answeredAt === null && g.openedAt <= at) g.answeredAt = at;
        if (e.type === 'unitExecuting' && ord !== null) {
          if (!m.started.includes(ord)) m.started.push(ord);
          for (const g of m.gates) if (g.kind === 'plan_approval' && g.approvedAt === null && g.openedAt <= at && ord >= g.ord) g.approvedAt = at;
        }
        break;
      case 'awaitingHuman':
        if (ord !== null) m.gates.push({ ord, kind: word(ev['gateKind']) ?? 'question', openedAt: at, answeredAt: null, reviewingOrd: num(ev['reviewingOrd']), approvedAt: null });
        break;
      case 'powerIntakePlanned':
        m.power = true;
        break;
      case 'unitPlanned':
        m.planned += 1;
        break;
      case 'rigorRescored': {
        m.power = true;
        const c = obj(ev['change']);
        if (byKind(c['by']) === 'person' && c['direction'] === 'up') answerPause(m, 'continue_high', true, num(c['at']) ?? at);
        break;
      }
      case 'powerCheckpointReached': {
        m.power = true;
        const n = num(ev['checkpoint']);
        if (n === null || m.checkpoints.includes(n)) break;
        m.checkpoints.push(n);
        m.checkpoints.sort((a, b) => a - b);
        if (ev['paused'] === true) {
          const reasons = obj(ev['pause'])['reasons'];
          const kinds = Array.isArray(reasons) ? [...new Set(reasons.filter((x): x is string => typeof x === 'string').flatMap(pauseKinds))] : [];
          m.pauses.push({ n, at, kinds, choice: null, byPerson: false, answeredAt: null });
        }
        break;
      }
      case 'powerTurnStarted':
        m.power = true;
        answerPause(m, 'continue', false, at);
        break;
      case 'powerHandoffStepped': {
        m.power = true;
        const st = obj(ev['step']);
        const step = word(st['step']);
        const round = num(ev['round']) ?? 1;
        const stepAt = num(st['at']) ?? at;
        if (step === null) break;
        answerPause(m, 'continue', false, stepAt);
        if (m.handoff === null || round > m.handoff.round) m.handoff = { round, steps: new Map() };
        if (round === m.handoff.round) m.handoff.steps.set(step, word(st['status']) ?? 'pending');
        break;
      }
      case 'powerToggled': {
        m.power = true;
        const t = obj(ev['toggle']);
        if (t['on'] !== true) answerPause(m, 'switch_phased', byKind(t['by']) === 'person', num(t['at']) ?? at);
        break;
      }
      default: break;
    }
  }
  return m;
}

/** "14:05", in the daemon's local time (the studio it serves runs on the same machine). */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const GATE_WORDS: Record<string, string> = {
  plan_approval: 'Approve the plan', escalation: 'A failed check or review', deliver: 'Deliver', consent: 'Install consent', repeat: 'Keep going?',
  phase_review: 'Review a step', question: 'A question',
  // (workdoc-all-runs) A phased run's gates: rig run W12 9dd4f6d1 read "Def" and "Review adjudication".
  def: 'Approve a step', team_dispute: 'A team dispute', review_adjudication: 'Settle a failed review',
};
export function gateWord(kind: string): string {
  return GATE_WORDS[kind] ?? kind.replace(/[_-]+/g, ' ').replace(/^./u, (c) => c.toUpperCase());
}

const PAUSE_KIND_WORDS: Readonly<Record<string, string>> = {
  longer_than_estimated: 'taking much longer than estimated', tests_failing: 'the tests kept failing',
  changes_undone: 'changes were undone', rigor_jumped: 'rigor jumped two levels at once', spread: 'the change spread into another product',
  other: 'it grew more complex than planned',
};
const CHOICE_WORDS: Readonly<Record<PauseChoice, string>> = {
  continue_high: 'continue at high rigor', continue: 'continue as planned', switch_phased: 'switch to phased steps', stop: 'stop the job',
};
const HANDOFF_WORDS: Readonly<Record<string, { failed: string; skipped: string }>> = {
  checks: { failed: 'the checks failed: fix them and hand off again', skipped: 'the checks were skipped' },
  review: { failed: 'the review asked for changes: make them and hand off again', skipped: 'the review was skipped' },
  security: { failed: 'the security check found problems: fix them and hand off again', skipped: 'the security check was skipped' },
  qe: { failed: 'QE acceptance did not pass: fix it and hand off again', skipped: 'QE acceptance was skipped' },
  compliance: { failed: 'the compliance check did not pass', skipped: 'the compliance check was skipped' },
};
const why = (kinds: readonly string[]): string => (kinds.length > 0 ? ` (${kinds.map((k) => PAUSE_KIND_WORDS[k] ?? k).join('; ')})` : '');

/**
 * (workdoc-all-runs, rig run W12 9dd4f6d1) A PERSON's answer with their own words, from crew's audit trail: a gate
 * answered with a note, a rule or QE check skipped with a reason, a job stopped with one, guidance set. The engine's
 * log says THAT a gate was answered; only crew's trail says who and why (`gate.decided` is recorded by the HTTP layer,
 * routes.ts). People only: a standing order, a seat or a plugin never writes a line as a person.
 */
export interface PersonNote { at: number; who: string; verb: NoteVerb; subject: string | null; words: string }

/** The closed set of what a person did, as the line says it. */
export const NOTE_VERBS = [
  'approved', 'sent it back', 'overrode a failed check', 'rejected', 'answered', 'edited the plan', 'changed the goal',
  'skipped rule', 'skipped QE acceptance', 'stopped the job', 'set guidance',
] as const;
export type NoteVerb = (typeof NOTE_VERBS)[number];

/** Most characters of a person's words a line keeps. */
export const NOTE_WORDS_MAX = 280;

/** An audit entry, as far as these lines read it (`api/audit.ts` `AuditEntry`). */
export interface AuditLike { ts: number; action: string; runId?: string; actor?: { id?: unknown; kind?: unknown } | null; detail?: Record<string, unknown> | null }

/** The audit actions a person's words may come from ({@link personNotes}). */
export const NOTE_ACTIONS: ReadonlySet<string> = new Set(['gate.decided', 'gate.rules_skipped', 'gate.qe_skipped', 'run.cancelled', 'guidance.set']);

/** A person's words on one line: whitespace collapsed, cut at a word boundary with an ellipsis. */
function oneLine(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/gu, ' ').trim();
  if (t.length <= NOTE_WORDS_MAX) return t;
  const cut = t.slice(0, NOTE_WORDS_MAX - 1);
  const space = cut.lastIndexOf(' ');
  let end = space > NOTE_WORDS_MAX / 2 ? space : cut.length;
  const last = cut.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${cut.slice(0, end).trimEnd()}…`;
}

/** Who, as the line names them: the local operator is "You"; another person by their id (a closed pattern). */
function whoOf(id: unknown): string {
  if (id === 'local') return 'You';
  return typeof id === 'string' && /^[A-Za-z0-9_.@-]{1,40}$/u.test(id) ? id : 'A person';
}

function gateVerb(d: Record<string, unknown>): NoteVerb {
  switch (d['action']) {
    case 'operator_judgment': return 'overrode a failed check';
    case 'request_changes': return 'sent it back';
    case 'edit_plan': return 'edited the plan';
    case 'amend_intent': return 'changed the goal';
    case undefined: case 'approve': case 'reject': return d['approve'] === false ? 'rejected' : 'approved';
    default: return 'answered';
  }
}

/** The person's answers with words, oldest first, from the run's audit entries in APPEND order (oldest first: two
 *  entries of the same millisecond keep the order they were recorded in). */
export function personNotes(entries: readonly AuditLike[]): PersonNote[] {
  const out: PersonNote[] = [];
  for (const e of entries) {
    if (e.actor?.kind !== 'human' || typeof e.ts !== 'number') continue;
    const d = obj(e.detail);
    const who = whoOf(e.actor.id);
    const push = (verb: NoteVerb, words: unknown, subject: string | null = null): void => {
      const w = oneLine(words);
      if (w !== '') out.push({ at: e.ts, who, verb, subject, words: w });
    };
    switch (e.action) {
      case 'gate.decided':
        // A skip's reasons are their own audit lines (below): not twice.
        if (d['action'] === 'skip_rules' || d['action'] === 'skip_qe') break;
        push(gateVerb(d), d['amend']);
        break;
      case 'gate.rules_skipped':
        for (const k of Array.isArray(d['skips']) ? d['skips'] : []) {
          const skip = obj(k);
          push('skipped rule', skip['reason'], typeof skip['id'] === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/u.test(skip['id']) ? skip['id'] : null);
        }
        break;
      case 'gate.qe_skipped': push('skipped QE acceptance', d['reason']); break;
      case 'run.cancelled': push('stopped the job', d['reason']); break;
      case 'guidance.set': push('set guidance', d['text']); break;
      default: break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** "You · 11:46 · overrode a failed check: “The failing tests are …”". */
export function noteLine(n: PersonNote): string {
  const what = n.verb === 'skipped rule' && n.subject !== null ? `skipped rule ${n.subject}` : n.verb;
  return `${n.who} · ${clock(n.at)} · ${what}: “${n.words}”`;
}

/**
 * (workdoc-all-runs) When a phased run's plan is SETTLED, from its events: the newest plan-approval gate was APPROVED
 * (the work it held started: when, and which step wrote the plan), or no plan gate ever opened and a step after the
 * first has started (a plan no gate held). `null` while a plan gate is open or its plan was sent back (the step that
 * wrote it runs again), or before any work started: the Approach then keeps the last approved plan. What the plan
 * IS comes from the run's own unit list, not from these events: on a replan the engine announces only FRESH units
 * (`UnitPlanned`, core `src/actor/team_gate.rs:3757`), never the kept or removed ones.
 */
export function planSettled(m: LinesModel): { approvedAt: number | null; authorOrd: number | null } | null {
  const last = m.gates.filter((g) => g.kind === 'plan_approval').at(-1);
  if (last !== undefined) return last.approvedAt === null ? null : { approvedAt: last.approvedAt, authorOrd: last.reviewingOrd };
  return m.started.length >= 2 ? { approvedAt: null, authorOrd: null } : null;
}

/** A step's name as the Approach says it: a closed pattern of at most four plain words ("test_plan" → "test plan"),
 *  or nothing. */
export function stepWord(name: string | null | undefined): string | null {
  if (typeof name !== 'string' || name.length > 40 || !/^[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+){0,3}$/u.test(name)) return null;
  return name.replace(/[_-]+/gu, ' ').trim() || null;
}

/** The Approach crew writes for a phased run: the settled plan's steps in one or two plain sentences. Every step
 *  counts; a step whose name is not a plain word is counted, not named. */
export function planApproach(steps: ReadonlyArray<string | null>, approvedAt: number | null): string | null {
  const words = steps.map(stepWord).filter((w): w is string => w !== null);
  if (words.length === 0) return null;
  const unnamed = steps.length - words.length;
  const head = `${approvedAt !== null ? 'The approved plan' : 'The plan'}, ${steps.length} step${steps.length === 1 ? '' : 's'}: ${words.join(', ')}${unnamed > 0 ? ` and ${unnamed} more` : ''}.`;
  return approvedAt !== null ? `${head} Approved ${clock(approvedAt)}.` : head;
}

/** What the lines say now, per section (the plugin's `docLines`). */
export function docLines(m: LinesModel, notes: readonly PersonNote[] = []): { decisions: string[]; questions: string[]; next: string[] } {
  const made: Array<{ at: number; line: string }> = [];
  const questions: string[] = [];
  const next: string[] = [];
  for (const g of m.gates) if (g.answeredAt !== null) made.push({ at: g.answeredAt, line: `${gateWord(g.kind)} · answered ${clock(g.answeredAt)}` });
  for (const pz of m.pauses) {
    if (pz.choice !== null && pz.answeredAt !== null) {
      made.push({ at: pz.answeredAt, line: `Checkpoint ${pz.n} pause${why(pz.kinds)} · ${pz.byPerson ? 'you chose' : 'answered'}: ${CHOICE_WORDS[pz.choice]} · ${clock(pz.answeredAt)}` });
    } else if (m.finished === null) {
      questions.push(`Waiting on you · checkpoint ${pz.n} paused${why(pz.kinds)}: split it, switch to phased steps, continue at high rigor, or stop? · since ${clock(pz.at)}`);
    }
  }
  // A person's answer with words, after the gate line it explains when they share a time (a stable sort).
  for (const n of notes) made.push({ at: n.at, line: noteLine(n) });
  if (m.finished === null) for (const g of m.gates) if (g.answeredAt === null) questions.push(`Waiting on you · ${gateWord(g.kind)} · since ${clock(g.openedAt)}`);
  if (m.handoff !== null) {
    for (const [step, status] of m.handoff.steps) {
      const w = HANDOFF_WORDS[step];
      if (w === undefined) continue;
      if (status === 'failed') next.push(`After hand-off round ${m.handoff.round} · ${w.failed}`);
      else if (status === 'skipped') next.push(`After hand-off round ${m.handoff.round} · ${w.skipped}`);
    }
  }
  return { decisions: made.sort((a, b) => a.at - b.at).map((d) => d.line), questions, next };
}

/** The lines these sections take back (the plugin's `MINE`): an open question, a hand-off follow-up. */
const MINE: Readonly<Record<'questions' | 'next', RegExp>> = { questions: /^Waiting on you · /u, next: /^After hand-off round \d+ · /u };
/** A generated decision line (an answered gate, an answered pause, a person's recorded answer): only these are ever
 *  trimmed. */
const GENERATED_DECISION = new RegExp(
  `^(?:.+ · answered \\d{2}:\\d{2}|Checkpoint \\d+ pause.* · \\d{2}:\\d{2}|[^·\\n]{1,40} · \\d{2}:\\d{2} · (?:${NOTE_VERBS.join('|')})(?: [A-Za-z0-9_.:-]{1,40})?: “.*”)$`,
  'u',
);

/** Is `line` one this module writes in `section`? */
export function isGenerated(section: 'decisions' | 'questions' | 'next', line: string): boolean {
  return section === 'decisions' ? GENERATED_DECISION.test(line) : MINE[section].test(line);
}

/**
 * A section's new text with the generated lines brought up to date, or null when nothing changes. A person's lines
 * stay as they are, in place, and are never trimmed. Decisions only ever gain lines; in Open questions and Next,
 * generated lines that no longer hold are taken out (the plugin's `reconcileSection`). When everything would not fit
 * in `max` characters, only the NEWEST generated lines that fit beside the person's are kept, so the same log always
 * gives the same text (xreview on wicked-crew#1224: trimming from the top deleted a person's line, and a long history
 * re-added what it had trimmed on every sync).
 */
export function reconcileSection(section: 'decisions' | 'questions' | 'next', current: string, wanted: readonly string[], max = Infinity): string | null {
  const lines = current.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  // A Decisions line that only LOOKS generated but is not one crew writes now is a person's (one they edited, or
  // typed in that shape): text shape is no proof of authorship, and Decisions never takes a line back (xreview r1).
  const mine = (l: string): boolean => isGenerated(section, l) && (section !== 'decisions' || wanted.includes(l));
  const human = lines.filter((l) => !mine(l));
  let room = max - human.join('\n').length - (human.length > 0 ? 1 : 0);
  const fits: string[] = [];
  for (let i = wanted.length - 1; i >= 0; i -= 1) {
    const w = wanted[i]!;
    if (w.length + (fits.length > 0 ? 1 : 0) > room) break;
    room -= w.length + (fits.length > 0 ? 1 : 0);
    fits.unshift(w);
  }
  const capped = fits.length === wanted.length;
  const kept = section === 'decisions' && capped
    ? lines
    : lines.filter((l) => !mine(l) || fits.includes(l));
  const add = fits.filter((w) => !kept.includes(w));
  const out = [...kept, ...add];
  return out.join('\n') === lines.join('\n') ? null : out.join('\n');
}

/** The event types after which the lines may read differently. */
export const LINE_EVENTS: ReadonlySet<string> = new Set([
  'awaitingHuman', 'resumed', 'unitExecuting', 'sessionCompleted', 'sessionFailed', 'runCancelled',
  'powerIntakePlanned', 'rigorRescored', 'powerCheckpointReached', 'powerTurnStarted', 'powerHandoffStepped', 'powerToggled',
]);
