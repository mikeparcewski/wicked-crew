/**
 * JOB PROPOSALS: the conversation's facts (DES-CATALOG-002 §2.4, §4.6).
 *
 * A job proposal is work in a chat: a v2 card (and option) whose resolved launch is a run, a compose or a demo. Every
 * fact on it is crew's, computed here from crew's own resolution (`workflow-catalog/build-v2.ts`), never from a seat's
 * words: the card and option, the repository and project from the chat's scope, the seats from the roster, the checks
 * from the composed plan, the time, the sentence wicked says ("what Start runs"), its tokens and their swaps, at most two
 * suggestions, the one question when something is missing, and the starting shape.
 *
 * A correction is a {@link ProposalRevision} merged by fixed rules ({@link mergeRevision}). The one rule that guards
 * assurance is step 7: a result with fewer checks than its parent is never written from a seat's block — it becomes a
 * question naming what is lost, whose lossy choice only a person's press applies (`confirmLoss`, person route only).
 * A QE skip from a seat counts only when its reason appears, unquoted and not reported, in the person's own message
 * that turn answers.
 */
import { createHash } from 'node:crypto';

import type {
  ArtifactProposal,
  CatalogGateId,
  ProposalComing,
  ProposalInputValue,
  ProposalNeed,
  ProposalQuestion,
  ProposalRevisionEdits,
  ProposalSeats,
  ProposalSentence,
  ProposalShape,
  ProposalSketch,
  ProposalSuggestion,
  ProposalTime,
  ProposalToken,
} from '../core/types.js';
import { CATALOG_V2_CARDS } from '../workflow-catalog/catalog-data-v2.js';
import { resolveOption, type ResolvedOption, type ServedState } from '../workflow-catalog/build-v2.js';
import type { CardSeedV2 } from '../workflow-catalog/seeds-v2.js';
import { DEPTH_LINES } from '../workflow-catalog/shape.js';

// ── words ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How the sentence names each card and option ("I'll run this as **an upgrade** of …"): one entry per card. */
const NOUNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'plan-it': { _: 'a plan' },
  feature: { _: 'a feature' },
  bug: { _: 'a bug fix' },
  migrate: { move: 'a move', 'in-place': 'an in-place migration', upgrade: 'an upgrade' },
  refactor: { refactor: 'a refactor', polish: 'a polish' },
  release: { _: 'a release' },
  'start-new': { cli: 'a new CLI', service: 'a new service', library: 'a new library', 'mcp-server': 'a new MCP server' },
  'studio-plugin': { editor: 'an editor plugin', phase: 'a phase plugin' },
  'plan-tests': { _: 'a test plan' },
  'test-analysis': { _: 'a test analysis' },
  'write-tests': { _: 'new tests' },
  'suite-health': { flaky: 'a flaky-test cleanup', weak: 'a weak-test cleanup', snapshots: 'a snapshot cleanup', slow: 'a slow-test cleanup' },
  incident: { _: 'an incident investigation' },
  reconstruct: { _: 'a reconstruction of what happened' },
  'analyze-codebase': { overview: 'an overview of how it works', domain: 'a domain map', docs: 'a docs-versus-code check' },
  'map-requirements': { _: 'a requirements map' },
  'review-change': { _: 'a review of the change' },
  risk: { _: 'a risk analysis' },
  security: { security: 'a security review', privacy: 'a privacy review', compliance: 'a compliance review' },
  decide: { _: 'a decision record' },
  document: { document: 'a document', presentation: 'a presentation', 'repo-docs': 'docs in the repo' },
  'interactive-page': { _: 'an interactive page' },
  'demo-video': { _: 'a demo video' },
  communicate: { narrative: 'a narrative', 'meeting-prep': 'meeting prep', 'demo-script': 'a demo script', 'status-update': 'a status update', message: 'a message' },
  backlog: { epics: 'epics', stories: 'stories', tasks: 'tasks' },
  'operating-model': { _: 'roles and an operating model' },
  'analyze-runs': { _: 'an analysis of your runs' },
  'review-recent-work': { _: 'a review of recent work' },
  propose: { rules: 'proposed rules', memories: 'proposed memories', knowledge: 'proposed knowledge' },
  'evaluate-rules': { _: 'a rules evaluation' },
  retro: { _: 'a retro' },
};

/** "an upgrade", or the card's title in lower case for a card the table does not name. */
export function nounOf(card: CardSeedV2, option: string | null): string {
  const n = NOUNS[card.id];
  const hit = n?.[option ?? '_'] ?? n?.['_'];
  if (hit !== undefined) return hit;
  const opt = card.variant?.options.find((o) => o.id === option);
  return `${card.title.toLowerCase()}${opt !== undefined ? ` (${opt.title.toLowerCase()})` : ''}`;
}

const GATE_WORDS: Readonly<Record<CatalogGateId, string>> = {
  'qe-acceptance': 'QE acceptance',
  parity: 'a parity check',
  'cited-findings': 'cited findings, each re-checked',
  'fidelity-to-source': 'a check against its sources',
  'proposal-only': 'your approval of everything it proposes',
  'evidence-floor': 'the evidence floor',
  'install-consent': 'your consent before it installs',
  walkthrough: 'a walkthrough review',
  pick: 'your pick',
  'draft-floor': 'the draft floor',
  'traces-to-requirements': 'a trace to each requirement',
  review: 'a review on another seat',
};

const list = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export const checksLabel = (gate: readonly CatalogGateId[]): string => (gate.length === 0 ? 'its own steps' : list(gate.map((g) => GATE_WORDS[g])));

const humanStep = (id: string): string => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words === '' ? id : `${words[0]!.toUpperCase()}${words.slice(1)}`;
};

// ── the inputs of a resolution ─────────────────────────────────────────────────────────────────────────────────────

/** The chat as a job's resolution sees it. */
export interface JobChat {
  projectId: string | null;
  repos: ReadonlyArray<{ id: string; name: string }>;
  lead: string | null;
  seats: readonly string[];
}

/** Everything a job proposal is resolved from (a fresh proposal, a merged revision, a reshape). */
export interface JobFacts {
  card: string;
  /** `undefined`: the card's default option. */
  option: string | null | undefined;
  depth: 'quick' | 'standard' | 'deep' | null;
  /** The person's first words: the job's intent. */
  words: string;
  details: string[];
  repoRef: string | null;
  projectId: string | null;
  lead: string | null;
  seats: string[] | null;
  inputs: Record<string, ProposalInputValue>;
  skipQe: { reason: string } | null;
  by: ProposalShape['by'];
  source: ProposalShape['source'];
  guess?: ProposalShape['guess'];
}

export interface JobContext {
  chatId: string;
  pid: string;
  turnId: string | null;
  /** The seat that wrote the block, or `person`. */
  seat: string;
  chat: JobChat;
  served: ServedState & { rev: string };
  roster: ReadonlyArray<{ key: string; name: string }>;
  projectLabel: string;
  revises: string | null;
  lineage: string | null;
  notes: string[];
  answers?: string;
  request?: { id: string; digest: string };
}

export class JobRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

/** The kind a resolved option proposes as: a run, a compose or a demo is a job; a document is an artifact create. */
export function proposalKindOf(r: ResolvedOption): 'job' | 'create' | 'none' {
  const k = r.resolved.launch.kind;
  if (k === 'run' || k === 'compose' || k === 'demo') return 'job';
  if (k === 'document') return 'create';
  return r.resolved.status === 'coming_soon' ? 'job' : 'none';
}

/** The seats a card needs to check its own work (Q31: words name who builds; the reviewer and judge stay). */
export function seatsNeeded(r: ResolvedOption): number {
  return 1 + (r.resolved.seats.distinctEvaluator ? 1 : 0) + (r.resolved.seats.distinctJudge ? 1 : 0);
}

function seatsOf(facts: JobFacts, ctx: JobContext, r: ResolvedOption): { seats: ProposalSeats; short: boolean } {
  const can = new Set(ctx.roster.map((s) => s.key));
  const name = (k: string): string => ctx.roster.find((s) => s.key === k)?.name ?? k;
  const ordered = [...new Set([facts.lead, ctx.chat.lead, ...ctx.chat.seats, ...ctx.roster.map((s) => s.key)].filter((k): k is string => k !== null && can.has(k)))];
  const keys = facts.seats !== null ? facts.seats.filter((k) => can.has(k)) : ordered;
  const lead = facts.lead !== null && keys.includes(facts.lead) ? facts.lead : (keys[0] ?? null);
  const rest = keys.filter((k) => k !== lead);
  const others = rest.map(name);
  const label = lead === null
    ? 'no seat that can work now'
    : others.length === 0
      ? name(lead)
      : facts.lead !== null && facts.seats === null
        ? `${name(lead)}, with ${list(others)} checking it`
        : list([name(lead), ...others]);
  return { seats: { lead, keys: lead === null ? [] : [lead, ...rest], label }, short: (lead === null ? 0 : 1 + rest.length) < seatsNeeded(r) };
}

function inputValueLabel(v: ProposalInputValue): string {
  if (v.kind === 'requirements') return `${v.refs.length} requirement${v.refs.length === 1 ? '' : 's'}`;
  return v.value;
}

function needsOf(facts: JobFacts, ctx: JobContext, r: ResolvedOption): ProposalNeed[] {
  const out: ProposalNeed[] = [];
  for (const i of r.resolved.inputs) {
    if (i.id === 'seats') continue;
    if (i.id === 'intent') {
      out.push({ id: i.id, label: i.label, kind: i.kind, required: i.required, status: facts.words.trim() !== '' ? 'met' : 'missing', ...(facts.words.trim() !== '' ? { value: facts.words.trim().slice(0, 200) } : {}) });
      continue;
    }
    if (i.id === 'repo') {
      const hit = ctx.chat.repos.find((x) => x.id === facts.repoRef);
      const choices = ctx.chat.repos.slice(0, 8).map((x) => ({ label: x.name, value: x.id }));
      out.push({ id: i.id, label: i.label, kind: i.kind, required: i.required, status: hit !== undefined ? 'met' : 'missing', ...(hit !== undefined ? { value: hit.id } : {}), ...(choices.length > 0 ? { choices } : {}) });
      continue;
    }
    if (i.id === 'project') {
      out.push({ id: i.id, label: i.label, kind: i.kind, required: i.required, status: facts.projectId !== null ? 'met' : 'missing', ...(facts.projectId !== null ? { value: facts.projectId } : {}) });
      continue;
    }
    const v = facts.inputs[i.id];
    out.push({ id: i.id, label: i.label, kind: i.kind, required: i.required, status: v !== undefined ? 'met' : 'missing', ...(v !== undefined ? { value: inputValueLabel(v).slice(0, 200) } : {}) });
  }
  return out;
}

/** The repository a job runs on: the one named, else the chat's only one. */
export function repoOf(facts: Pick<JobFacts, 'repoRef'>, chat: JobChat): { id: string; name: string } | null {
  if (facts.repoRef !== null) return chat.repos.find((r) => r.id === facts.repoRef) ?? null;
  return chat.repos.length === 1 ? chat.repos[0]! : null;
}

/** The checks a resolution carries, the QE skip taken off. */
export function checksOf(r: ResolvedOption, skipQe: JobFacts['skipQe']): CatalogGateId[] {
  return r.resolved.gate.filter((g) => !(g === 'qe-acceptance' && skipQe !== null));
}

function sketchOf(r: ResolvedOption): ProposalSketch {
  const launch = r.resolved.launch.kind;
  if (launch === 'compose') return { steps: [{ label: 'Draft', asks: false }, { label: 'Review', asks: true }] };
  const steps = r.steps.map((s) => {
    const gate = s['gate'];
    const asks = gate === 'consent_before' || (gate !== null && typeof gate === 'object' && ((gate as Record<string, unknown>)['human_confirm'] !== undefined || (gate as Record<string, unknown>)['human_confirm_if'] !== undefined));
    return { label: humanStep(s.id), asks };
  });
  return { steps };
}

const minutesLabel = (m: [number, number] | null): string | null => {
  if (m === null) return null;
  const fmt = (x: number): string => (x >= 60 ? `${Math.round((x / 60) * 10) / 10} h` : `${x} min`);
  return `About ${fmt(m[0])}–${fmt(m[1])}`;
};

const STOPS: Readonly<Record<'run' | 'compose' | 'demo', string>> = {
  run: 'Asks you to approve the plan first.',
  compose: 'Stops for you at the review.',
  demo: 'Stops for you after the script and after the review.',
};

// ── the resolution ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The option a card proposes when none is named (Q23 asks for the most used; the default stands in until usage is read). */
export function optionFor(card: CardSeedV2, option: string | null | undefined): string | null {
  if (option !== undefined) return option;
  return card.variant?.default ?? null;
}

/**
 * Resolve a job proposal from its facts. Refuses (a {@link JobRefusal}) an unknown card or option and a hidden card
 * reached by anything but its alias; everything else resolves, with what cannot run yet as `blocked` or the question.
 */
export function resolveJob(facts: JobFacts, ctx: JobContext, opts: { allowHidden?: boolean } = {}): ArtifactProposal {
  const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card);
  if (card === undefined) throw new JobRefusal('card_unknown', `there is no job called “${facts.card.slice(0, 80)}”`);
  if (card.hidden === true && opts.allowHidden !== true) throw new JobRefusal('card_hidden', `${card.title} is reached only by its own command`);
  const optionId = optionFor(card, facts.option);
  const r = resolveOption(card.id, optionId, ctx.served);
  if (r === null) throw new JobRefusal('card_unknown', `${card.title} has no option “${String(optionId).slice(0, 80)}”`);
  if (facts.depth !== null && card.depth !== true) throw new JobRefusal('edits_invalid', `${card.title} takes no depth`);
  const kind = proposalKindOf(r);
  if (kind !== 'job') throw new JobRefusal('not_a_job', `${card.title} makes a document: it is proposed as one`);
  const notes = [...ctx.notes];
  const repo = repoOf(facts, ctx.chat);
  const { seats, short } = seatsOf(facts, ctx, r);
  const needs = needsOf({ ...facts, repoRef: repo?.id ?? null }, ctx, r);
  const gate = checksOf(r, facts.skipQe);
  const launch = r.resolved.launch.kind as 'run' | 'compose' | 'demo' | 'none';
  const shape: ProposalShape = {
    card: card.id,
    option: r.option?.id ?? null,
    depth: facts.depth,
    by: facts.by,
    source: facts.source,
    ...(facts.guess !== undefined ? { guess: facts.guess } : {}),
  };
  const optTitle = r.option?.title ?? null;
  const label = `${card.title}${optTitle !== null ? ` · ${optTitle}` : ''}`;
  const command = r.option?.command ?? card.command;
  const blockedBy: string[] = [];
  let coming: ProposalComing | undefined;
  if (r.resolved.status === 'coming_soon') {
    coming = { release: card.release, note: r.resolved.statusNote ?? card.statusNote ?? null, nearest: card.nearest ?? null };
    blockedBy.push(`${label} comes in ${card.release}`);
  } else if (r.resolved.status === 'unavailable') {
    blockedBy.push(r.resolved.statusNote ?? `${label} can't start on this daemon`);
  }
  if (short && coming === undefined) blockedBy.push(`Needs ${seatsNeeded(r)} seats that can work now (one builds, the others check it); sign another seat in`);
  // The one question: the first required need that is missing.
  let question: ProposalQuestion | null = null;
  const missing = needs.find((n) => n.required && n.status === 'missing');
  if (coming === undefined && missing !== undefined) {
    if (missing.id === 'repo') {
      question = {
        kind: 'missing',
        text: ctx.chat.repos.length === 0 ? 'Which repository? This chat has none in its scope: start a thread on one.' : 'Which repository?',
        choices: ctx.chat.repos.slice(0, 4).map((x) => ({ label: x.name, edit: { repoRef: x.id } })),
      };
    } else if (missing.kind === 'text' || missing.kind === 'url') {
      question = { kind: 'missing', text: `${missing.label}?`, choices: [], input: { kind: 'text', label: missing.label, edit: `inputs.${missing.id}` } };
      if (missing.id === 'intent') question.input = { kind: 'text', label: missing.label, edit: 'inputs.intent' };
    } else {
      question = { kind: 'missing', text: `${missing.label}?`, choices: [] };
    }
  }
  // The sentence: one template per card (its noun), the facts as tokens.
  const tokens: ProposalToken[] = [];
  const t = (tok: ProposalToken): string => {
    tokens.push(tok);
    return `{${tok.id}}`;
  };
  const visibleCards = CATALOG_V2_CARDS.filter((c) => c.hidden !== true && c.category === card.category && c.id !== card.id && c.release === '1.0');
  const kindSwap = (card.variant?.options ?? [])
    .filter((o) => o.id !== r.option?.id && o.status !== 'coming_soon')
    .slice(0, 4)
    .map((o) => swapChoice(nounOf(card, o.id), { option: o.id }, gate, card.id, o.id, ctx.served, facts.skipQe));
  const cardTok = t({
    id: 'kind',
    kind: card.variant !== undefined ? 'option' : 'card',
    label: nounOf(card, r.option?.id ?? null),
    swap: kindSwap.length > 0 ? { choices: kindSwap } : visibleCards.length > 0 ? { choices: visibleCards.slice(0, 4).map((c) => swapChoice(nounOf(c, optionFor(c, undefined)), { card: c.id }, gate, c.id, optionFor(c, undefined), ctx.served, facts.skipQe)) } : null,
  });
  const parts: string[] = [];
  const delivers = r.resolved.delivers;
  const repoTok = repo === null ? null : t({
    id: 'repo',
    kind: 'repo',
    label: repo.name,
    swap: ctx.chat.repos.length > 1 ? { choices: ctx.chat.repos.filter((x) => x.id !== repo.id).slice(0, 4).map((x) => ({ label: x.name, edit: { repoRef: x.id } })) } : null,
  });
  const seatsTok = t({
    id: 'seats',
    kind: 'seats',
    label: seats.label,
    swap: ctx.roster.length > 1 ? { choices: ctx.roster.filter((s) => s.key !== seats.lead).slice(0, 4).map((s) => ({ label: `${s.name} leads`, edit: { lead: s.key } })) } : null,
  });
  const checksTok = t({ id: 'checks', kind: 'checks', label: checksLabel(gate), swap: null });
  if (launch === 'compose') {
    const projectTok = t({ id: 'project', kind: 'project', label: ctx.projectLabel, swap: null });
    parts.push(`I'll draft ${cardTok} from the requirements you pick in ${projectTok}, checked by ${checksTok}.`);
  } else if (launch === 'demo') {
    const url = facts.inputs['url'];
    parts.push(`I'll record ${cardTok}${url !== undefined ? ` of ${inputValueLabel(url)}` : ''} with ${seatsTok}, checked by ${checksTok}.`);
  } else if (delivers === 'report' || delivers === 'answer' || delivers === 'proposals') {
    parts.push(`I'll do this as ${cardTok}${repoTok !== null ? ` of ${repoTok}` : ''}, read-only, with ${seatsTok}, checked by ${checksTok}.`);
  } else {
    parts.push(`I'll run this as ${cardTok}${repoTok !== null ? ` of ${repoTok}` : ''}, with ${seatsTok}, checked by ${checksTok}.`);
  }
  if (card.depth === true) {
    const d = facts.depth ?? 'standard';
    const depthTok = t({ id: 'depth', kind: 'depth', label: d, swap: { choices: (['quick', 'standard', 'deep'] as const).filter((x) => x !== d).map((x) => ({ label: x, edit: { depth: x } })) } });
    parts.push(`Depth: ${depthTok}.`);
  }
  if (facts.details.length > 0) {
    const ds = facts.details.map((d, i) => t({ id: `detail-${i}`, kind: 'detail', label: d, swap: { choices: [{ label: 'Remove', edit: { detail: { remove: [d] } } }] } }));
    parts.push(`Carrying: ${ds.join(', ')}.`);
  }
  if (facts.skipQe !== null) parts.push(`Without QE acceptance (you said: “${facts.skipQe.reason}”), labelled on the job.`);
  const time = minutesLabel(r.resolved.typicalMinutes);
  const stops = launch === 'none' ? null : STOPS[launch];
  if (coming === undefined) parts.push(`${time !== null ? `${time}, and ` : ''}${launch === 'run' ? "I'll show you the plan before anything changes." : (stops ?? '')}`.trim());
  const ask = coming !== undefined ? null : question !== null ? question.text : blockedBy.length > 0 ? null : 'Start?';
  const comingText = coming !== undefined
    ? `${label} comes in ${card.release}.${coming.nearest !== null ? ` Today, the closest is ${nounOf(CATALOG_V2_CARDS.find((c) => c.id === coming!.nearest!.card) ?? card, coming.nearest.option)}.` : ''}`
    : null;
  const sentence: ProposalSentence = { text: comingText ?? parts.filter((p) => p !== '').join(' '), tokens: comingText !== null ? [] : tokens, notes, ask };
  // At most two suggestions: another option that runs a different plan, and another repository in scope.
  const suggestions: ProposalSuggestion[] = [];
  if (coming !== undefined && coming.nearest !== null) {
    const near = CATALOG_V2_CARDS.find((c) => c.id === coming!.nearest!.card);
    if (near !== undefined) suggestions.push({ label: `Do ${nounOf(near, coming.nearest.option)} instead`, edit: { card: near.id, ...(coming.nearest.option !== null ? { option: coming.nearest.option } : {}) } });
  } else if (question === null) {
    const alt = (card.variant?.options ?? []).find((o) => o.id !== r.option?.id && o.status !== 'coming_soon' && JSON.stringify(o.launch) !== JSON.stringify(r.resolved.launch));
    if (alt !== undefined) {
      const c = swapChoice(nounOf(card, alt.id), { option: alt.id }, gate, card.id, alt.id, ctx.served, facts.skipQe);
      suggestions.push({ label: `Make it ${c.label}`, edit: c.edit });
    }
    const other = ctx.chat.repos.find((x) => x.id !== repo?.id);
    if (other !== undefined && r.resolved.inputs.some((i) => i.id === 'repo')) suggestions.push({ label: `Use ${other.name}`, edit: { repoRef: other.id } });
  }
  const brief = briefOf(facts, r);
  return {
    pid: ctx.pid,
    chatId: ctx.chatId,
    turnId: ctx.turnId,
    kind: 'job',
    seat: ctx.seat,
    what: { entry: card.id, title: card.title, label, outcome: card.outcome ?? null },
    brief,
    reason: facts.guess?.reason ?? null,
    sources: [],
    repos: repo !== null ? [repo.name] : [],
    ...(repo !== null ? { repoRefs: [repo.id] } : {}),
    helpers: null,
    time: { minutes: r.resolved.typicalMinutes, cost: r.resolved.cost, steps: r.steps.length > 0 ? r.steps.length : null, median: null, label: time ?? '' } satisfies ProposalTime,
    stops,
    filedIn: { projectId: facts.projectId, label: ctx.projectLabel },
    blocked: blockedBy[0] ?? (question !== null ? question.text : null),
    shape,
    catalogRev: ctx.served.rev,
    resolution: r.resolved.resolution,
    launch: launch === 'none' ? 'run' : launch,
    command: command ?? null,
    needs,
    gate,
    seats,
    words: facts.words,
    details: [...facts.details],
    inputs: { ...facts.inputs },
    skipQe: facts.skipQe,
    ...(coming !== undefined ? { coming } : {}),
    sentence,
    suggestions: suggestions.slice(0, 2),
    question,
    sketch: sketchOf(r),
    revises: ctx.revises,
    lineage: ctx.lineage ?? ctx.pid,
    ...(ctx.answers !== undefined ? { answers: ctx.answers } : {}),
    ...(ctx.request !== undefined ? { request: ctx.request } : {}),
  };
}

/** A swap choice; one that drops a check names it in its own label and carries `confirmLoss` (pressing it is the
 *  person's act, §4.6 step 7). */
function swapChoice(
  label: string,
  edit: ProposalRevisionEdits,
  gate: readonly CatalogGateId[],
  card: string,
  option: string | null,
  served: ServedState,
  skipQe: JobFacts['skipQe'],
): { label: string; edit: ProposalRevisionEdits } {
  const r = resolveOption(card, option, served);
  if (r === null) return { label, edit };
  const lost = gate.filter((g) => !checksOf(r, skipQe).includes(g));
  if (lost.length === 0) return { label, edit };
  return { label: `${label}, without ${list(lost.map((g) => GATE_WORDS[g]))}`, edit: { ...edit, confirmLoss: true } };
}

/**
 * The brief a launch runs on (§4.6 rule 6): the person's first words plus the current details, so removing a detail
 * removes it from the brief. Crew's framing line and depth line are put first by the launch itself (shape.ts).
 */
export function briefOf(facts: Pick<JobFacts, 'words' | 'details'>, _r?: ResolvedOption): string {
  const words = facts.words.trim();
  if (facts.details.length === 0) return words;
  return `${words}\n\nAlso: ${facts.details.join('; ')}.`;
}

/** The facts a job proposal was resolved from (a revision starts from them: rule 1). */
export function factsOf(p: ArtifactProposal): JobFacts {
  const shape = p.shape!;
  return {
    card: shape.card,
    option: shape.option,
    depth: shape.depth,
    words: p.words ?? p.brief ?? '',
    details: [...(p.details ?? [])],
    repoRef: p.repoRefs?.[0] ?? null,
    projectId: p.filedIn.projectId,
    lead: p.seats?.lead ?? null,
    seats: p.seats !== undefined ? [...p.seats.keys] : null,
    inputs: inputsOfProposal(p),
    skipQe: p.skipQe ?? null,
    by: shape.by,
    source: shape.source,
    ...(shape.guess !== undefined ? { guess: shape.guess } : {}),
  };
}

/** The input values a proposal holds (a revision carries them; Go launches with them). */
export function inputsOfProposal(p: ArtifactProposal): Record<string, ProposalInputValue> {
  return { ...(p.inputs ?? {}) };
}

// ── the merge (§4.6) ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a merge produced: the facts to resolve, the notes, and the checks it would lose. */
export interface MergeResult {
  facts: JobFacts;
  notes: string[];
  /** Checks the result has that the parent had not, never; checks the parent had that the result lacks. */
  lost: CatalogGateId[];
  /** The result keeps its parent's shape whole (the revision changed nothing). */
  unchanged: boolean;
}

const KNOWN_EDITS: ReadonlySet<string> = new Set(['card', 'option', 'depth', 'repoRef', 'project', 'lead', 'addSeats', 'removeSeats', 'inputs', 'detail', 'skipQe', 'confirmLoss']);

/**
 * Merge a revision into its parent by the rules of §4.6, in order. Pure over its inputs: the caller decides what a
 * lost check does (a question, or, with the person's `confirmLoss`, the write).
 */
export function mergeRevision(
  parent: ArtifactProposal,
  edits: ProposalRevisionEdits,
  ctx: { chat: JobChat; served: ServedState; roster: ReadonlyArray<{ key: string; name: string }> },
): MergeResult {
  const notes: string[] = [];
  // 1. The parent whole; a field the revision does not name keeps its value.
  const facts = factsOf(parent);
  const before = JSON.stringify(facts);
  for (const k of Object.keys(edits)) if (!KNOWN_EDITS.has(k)) notes.push(`Not changed: “${k.slice(0, 40)}” isn't something a job can change`);
  // 2. A card change: the new card's default option and depth; what the new card takes is kept, the rest dropped.
  if (edits.card !== undefined && edits.card !== facts.card) {
    const target = CATALOG_V2_CARDS.find((c) => c.id === edits.card);
    if (target === undefined || target.hidden === true) {
      notes.push(`Not changed: there is no job called “${String(edits.card).slice(0, 60)}” to switch to`);
    } else {
      facts.card = target.id;
      facts.option = target.variant?.default ?? null;
      facts.depth = null;
      const r = resolveOption(target.id, facts.option, ctx.served);
      const takes = new Set((r?.resolved.inputs ?? []).map((i) => i.id));
      if (!takes.has('repo') && facts.repoRef !== null) {
        facts.repoRef = null;
        notes.push(`${target.title} takes no repository: left out`);
      }
      for (const id of Object.keys(facts.inputs)) {
        if (!takes.has(id)) {
          delete facts.inputs[id];
          notes.push(`${target.title} takes no ${id}: left out`);
        }
      }
    }
  }
  // 3. An option or depth change keeps everything else.
  if (edits.option !== undefined) {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card)!;
    if (edits.option === null ? card.variant !== undefined : card.variant?.options.some((o) => o.id === edits.option) !== true) {
      notes.push(`Not changed: ${card.title} has no option “${String(edits.option).slice(0, 60)}”`);
    } else {
      facts.option = edits.option;
    }
  }
  if (edits.depth !== undefined) {
    const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card)!;
    if (edits.depth !== null && card.depth !== true) notes.push(`Not changed: ${card.title} takes no depth`);
    else facts.depth = edits.depth;
  }
  if (edits.repoRef !== undefined) {
    const hit = ctx.chat.repos.find((r) => r.id === edits.repoRef || r.name === edits.repoRef);
    if (hit === undefined) notes.push(`Not changed: ${String(edits.repoRef).slice(0, 80)} isn't in this chat's scope (start a thread on it)`);
    else facts.repoRef = hit.id;
  }
  if (edits.project !== undefined && edits.project !== facts.projectId) notes.push("Not changed: the project is the chat's own");
  // 4. Seats: the lead, added seats; removing the card's only distinct reviewer or judge is refused.
  const can = new Set(ctx.roster.map((s) => s.key));
  const nameOf = (k: string): string => ctx.roster.find((s) => s.key === k)?.name ?? k;
  if (edits.lead !== undefined) {
    if (!can.has(edits.lead)) notes.push(`Not changed: ${nameOf(edits.lead)} can't work now`);
    else {
      facts.lead = edits.lead;
      if (facts.seats !== null && !facts.seats.includes(edits.lead)) facts.seats = [edits.lead, ...facts.seats];
    }
  }
  if (edits.addSeats !== undefined) {
    const add = edits.addSeats.filter((k) => can.has(k));
    for (const k of edits.addSeats) if (!can.has(k)) notes.push(`Not changed: ${nameOf(k)} can't work now`);
    if (add.length > 0) facts.seats = [...new Set([...(facts.seats ?? []), ...add])];
  }
  if (edits.removeSeats !== undefined && edits.removeSeats.length > 0) {
    const r = resolveOption(facts.card, optionFor(CATALOG_V2_CARDS.find((c) => c.id === facts.card)!, facts.option), ctx.served);
    const need = r === null ? 1 : seatsNeeded(r);
    const current = facts.seats ?? [...new Set([facts.lead, ...ctx.chat.seats, ...ctx.roster.map((s) => s.key)].filter((k): k is string => k !== null && can.has(k)))];
    const kept = current.filter((k) => !edits.removeSeats!.includes(k));
    if (kept.length < need) {
      notes.push(`Not changed: ${list(edits.removeSeats.map(nameOf))} ${edits.removeSeats.length === 1 ? 'stays' : 'stay'}; this job needs ${need} seats, so another seat checks the one that builds`);
    } else {
      facts.seats = kept;
      if (facts.lead !== null && !kept.includes(facts.lead)) facts.lead = kept[0] ?? null;
    }
  }
  // 5. Inputs fill or replace the needs they name (validated as Go validates them).
  if (edits.inputs !== undefined) {
    for (const [id, v] of Object.entries(edits.inputs)) {
      if (id === 'intent' && v.kind === 'text') {
        facts.words = v.value.slice(0, 8000);
        continue;
      }
      if ((v.kind === 'text' || v.kind === 'url') && (typeof v.value !== 'string' || v.value.length > 4000)) {
        notes.push(`Not changed: ${id} is too long`);
        continue;
      }
      if (v.kind === 'url') {
        try {
          const u = new URL(v.value);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
        } catch {
          notes.push(`Not changed: ${v.value.slice(0, 80)} isn't an http(s) address`);
          continue;
        }
      }
      facts.inputs[id] = v;
    }
  }
  // 6. Details: facts carried from corrections; the brief is rebuilt from the first words plus these.
  if (edits.detail !== undefined) {
    for (const d of edits.detail.remove ?? []) facts.details = facts.details.filter((x) => x !== d);
    for (const d of edits.detail.add ?? []) {
      const t = d.trim().slice(0, 200);
      if (t !== '' && !facts.details.includes(t) && !facts.words.includes(t)) facts.details.push(t);
    }
    facts.details = facts.details.slice(0, 12);
  }
  if (edits.skipQe !== undefined) facts.skipQe = { reason: edits.skipQe.reason.trim().slice(0, 600) };
  // 7. The checks compared with the parent's: what the result lacks is lost (the caller asks before writing it).
  const card = CATALOG_V2_CARDS.find((c) => c.id === facts.card)!;
  const r = resolveOption(facts.card, optionFor(card, facts.option), ctx.served);
  const after = r === null ? [] : checksOf(r, facts.skipQe);
  const lost = (parent.gate ?? []).filter((g) => !after.includes(g));
  return { facts, notes, lost, unchanged: JSON.stringify(facts) === before };
}

// ── the QE skip, bound to the person's own words (§2.4, §9.2 (ac)) ─────────────────────────────────────────────────

/** The text outside quotes and reported speech ("the PM said: …"): only that is the person's own ask. */
export function ownWords(message: string): string {
  let t = message.replace(/“[^”]*”|"[^"]*"|«[^»]*»|(^|[\s(])'[^']*'(?=$|[\s).,;:!?])/gu, (_m, lead?: string) => `${lead ?? ''} `);
  // Reported speech: whatever follows "X said:" / "they asked" / "told me to" is someone else's.
  t = t.replace(/\b(said|says|asked|asks|told (me|us)( to)?|wrote|wants (me|us) to)\b[\s\S]*$/iu, ' ');
  return t;
}

const SKIP_ASK = /\b(skip(ping)?|drop(ping)?|without|no)\s+(the\s+)?qe(\s+acceptance)?\b/iu;
const NEGATED = /\b(don'?t|do not|never|not|no need to|shouldn'?t)\s+(\w+\s+){0,2}$/iu;

/** Whether the person's own words (not quoted, not reported, not negated) ask to skip QE acceptance. */
export function personAskedSkip(message: string | null): boolean {
  if (message === null) return false;
  const own = ownWords(message);
  const m = SKIP_ASK.exec(own);
  return m !== null && !NEGATED.test(own.slice(0, m.index));
}

/**
 * Whether a seat's QE skip is the person's own: their message that this turn answers asks for it in their own words
 * (not quoted, not reported, not negated), and the reason appears there too, unquoted. A reason that is only "QE" is
 * none.
 */
export function qeSkipBound(reason: string, message: string | null): boolean {
  if (message === null) return false;
  const own = ownWords(message);
  const m = SKIP_ASK.exec(own);
  if (m === null) return false;
  if (NEGATED.test(own.slice(0, m.index))) return false;
  const r = reason.trim().toLowerCase().replace(/[.!?,;:]+$/u, '');
  const bare = r.replace(/\b(qe|acceptance|skip|the|it|because|since)\b/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
  if (r.length < 3 || bare.length < 3) return false;
  return own.toLowerCase().includes(r);
}

// ── ids ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A digest of a request body (a repeated `requestId` with another body is refused). */
export function requestDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24);
}

/** A person-made proposal's pid, derived from the person and their request id (a retry names the same one). */
export function personPid(chatId: string, actorId: string, requestId: string): string {
  const tag = createHash('sha256').update(`${actorId}\u0000${requestId}`, 'utf8').digest('hex').slice(0, 20);
  return `${chatId}:p:${tag}`;
}

export const depthLine = (d: 'quick' | 'standard' | 'deep'): string => DEPTH_LINES[d];
