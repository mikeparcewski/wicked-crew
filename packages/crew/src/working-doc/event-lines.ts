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
interface GateInfo { ord: number; kind: string; openedAt: number; answeredAt: number | null }
interface PauseInfo { n: number; at: number; kinds: string[]; choice: PauseChoice | null; byPerson: boolean; answeredAt: number | null }
export interface LinesModel {
  gates: GateInfo[];
  pauses: PauseInfo[];
  checkpoints: number[];
  handoff: { round: number; steps: Map<string, string> } | null;
  finished: number | null;
  power: boolean;
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
  const m: LinesModel = { gates: [], pauses: [], checkpoints: [], handoff: null, finished: null, power: false };
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
        break;
      case 'awaitingHuman':
        if (ord !== null) m.gates.push({ ord, kind: word(ev['gateKind']) ?? 'question', openedAt: at, answeredAt: null });
        break;
      case 'powerIntakePlanned':
        m.power = true;
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

/** What the lines say now, per section (the plugin's `docLines`). */
export function docLines(m: LinesModel): { decisions: string[]; questions: string[]; next: string[] } {
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
/** A generated decision line (an answered gate, an answered pause): only these are ever trimmed. */
const GENERATED_DECISION = /^(?:.+ · answered \d{2}:\d{2}|Checkpoint \d+ pause.* · \d{2}:\d{2})$/u;

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
  const human = lines.filter((l) => !isGenerated(section, l));
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
    : lines.filter((l) => !isGenerated(section, l) || fits.includes(l));
  const add = fits.filter((w) => !kept.includes(w));
  const out = [...kept, ...add];
  return out.join('\n') === lines.join('\n') ? null : out.join('\n');
}

/** The event types after which the lines may read differently. */
export const LINE_EVENTS: ReadonlySet<string> = new Set([
  'awaitingHuman', 'resumed', 'unitExecuting', 'sessionCompleted', 'sessionFailed', 'runCancelled',
  'powerIntakePlanned', 'rigorRescored', 'powerCheckpointReached', 'powerTurnStarted', 'powerHandoffStepped', 'powerToggled',
]);
