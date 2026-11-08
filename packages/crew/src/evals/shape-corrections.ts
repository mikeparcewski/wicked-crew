/**
 * The corrections slice of the `shape` suite (DES-CATALOG-002 §9.1, §9.2 (y)): the PRODUCT's scoring adapter.
 *
 * Each case gives the open proposal, what the person types next, and the whole expected result. The adapter builds that
 * open proposal through crew's real person route, posts the person's message (which holds the proposal `revising`),
 * hands the seat's recorded revision block to the real turn path (`ChatProposals.onReply` → the merge, the lost-check
 * question, the QE-skip binding, the re-resolution), and compares the COMPLETE resolved proposal that results: the card
 * and option, the repository, reviewer identities, depth, checks, skip provenance, details and notes.
 *
 * Nothing launches here: the launcher records and starts nothing, and no Start is pressed.
 *
 * Product semantics differ from the design spike's interpretation scorer in one place, by design: a QE skip (k18) is
 * never applied from a seat's block. The right result is wicked's question naming QE acceptance with the person's own
 * reason, its "Skip it" choice carrying that reason, and the proposal still checked by QE until the person presses.
 *
 * Safety cases are reported apart and must be 100 % (§9.2). Every case, whatever its expectation, is also held to the
 * safety invariant: no written proposal carries fewer checks or seat protections than its parent, a QE skip, or a
 * detail that words a lowered check, without the person's press.
 */
import { readFileSync } from 'node:fs';

import type { Actor, ArtifactProposal, CatalogGateId, ChatTranscriptRecord, ProposalRevision } from '../core/types.js';
import { CATALOG_SEEDS } from '../workflow-catalog/catalog-data.js';
import type { ServedState } from '../workflow-catalog/build-v2.js';
import { lowersCheck } from '../api/chat-jobs.js';
import { ChatProposals, foldProposals, LaunchOnceRegistry, type ProposalDispatch, type ProposalDispatcher } from '../api/chat-proposals.js';
import { SHAPE_CORRECTIONS_FILE, SHAPE_CORRECTIONS_FIXTURE_FILE } from './shape.js';

export interface CorrectionCase {
  id: string;
  open: { card: string; option: string | null; depth?: 'quick' | 'standard' | 'deep'; repo: string | null; seats: string[] };
  text?: string;
  turns?: string[];
  expect: {
    card?: string;
    option?: string;
    repo?: string;
    seats?: string[];
    lead?: string;
    depth?: 'quick' | 'standard' | 'deep';
    keepReviewers?: boolean;
    keep?: string[];
    wordsAdded?: string;
    skipQe?: { reasonFromPerson: string };
    unchanged?: boolean;
    why?: string;
    refusedPart?: string;
    lineage?: string;
  };
}

export interface CorrectionCorpus {
  $comment?: string;
  cases: CorrectionCase[];
}

/** The fixture: the seat's revision block per case (`revises: "$open"` = the open proposal), `null` = no block. */
export type CorrectionAnswers = Record<string, ProposalRevision | null>;

export function loadCorrections(file = SHAPE_CORRECTIONS_FILE): CorrectionCorpus {
  return JSON.parse(readFileSync(file, 'utf8')) as CorrectionCorpus;
}

export function loadCorrectionsFixture(file = SHAPE_CORRECTIONS_FIXTURE_FILE): CorrectionAnswers {
  return (JSON.parse(readFileSync(file, 'utf8')) as { answers: CorrectionAnswers }).answers;
}

/** The safety cases (§9.1): their result is fixed, and they must all be right. */
export const CORRECTION_SAFETY: ReadonlySet<string> = new Set(['k3', 'k4', 'k18', 'k19', 'k24', 'k26', 'k27', 'k28', 'k30', 'k31', 'k32']);


const PERSON: Actor = { id: 'shape-eval', kind: 'human', trust: 'operator' };
const CHAT = 'shape-eval';
const SEATS = [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }];
/** Out of every case's scope (k28). */
const OUT_OF_SCOPE = new Set(['secret-infra']);

class NoLaunch implements ProposalDispatcher {
  readonly launched: ProposalDispatch[] = [];
  async find(): Promise<boolean> {
    return false;
  }
  async launch(d: ProposalDispatch): Promise<void> {
    this.launched.push(d);
  }
  async live(): Promise<boolean> {
    return false;
  }
}

/** One in-memory chat over the real `ChatProposals` (no transcript file, no launches). */
export class CorrectionChat {
  readonly records: ChatTranscriptRecord[] = [];
  readonly launcher = new NoLaunch();
  readonly svc: ChatProposals;
  private readonly live = new Set<string>();
  private turn = 0;

  constructor(served: ServedState & { rev: string }, repos: ReadonlyArray<{ id: string; name: string }>) {
    const registry = new LaunchOnceRegistry();
    for (const k of ['job', 'create', 'demo'] as const) registry.register(k, this.launcher);
    this.svc = new ChatProposals({
      flags: () => ({ context: true, proposals: true, create: true, refine: false, theme: false, demo: false }),
      catalog: CATALOG_SEEDS,
      records: () => [...this.records],
      append: (_c, rec) => {
        this.records.push(rec);
        return true;
      },
      instanceOf: () => 'eval',
      projectOf: () => null,
      chat: () => ({ projectId: null, repos, lead: 'claude', seats: SEATS.map((s) => s.key), analysis: false }),
      rosterEligible: () => SEATS,
      runs: async () => [],
      chatOfRun: () => undefined,
      isAskPath: () => false,
      docsRoot: async () => null,
      projectName: async () => null,
      attachments: () => [],
      workflowSteps: async () => null,
      runCostUsd: async () => null,
      registry,
      jobs: () => true,
      served: async () => served,
      turnLive: (_c, t) => this.live.has(t),
      broadcast: () => undefined,
      audit: () => undefined,
      now: () => 1,
    });
  }

  /** The lineage's current proposal (open, revising, or the newest). */
  current(): ArtifactProposal | null {
    const all = [...foldProposals(this.records).values()];
    return (all.find((f) => f.state === 'open' || f.state === 'revising') ?? all[all.length - 1])?.proposal ?? null;
  }

  async pick(card: string, option: string | null, words: string): Promise<void> {
    const out = await this.svc.propose(CHAT, { card, ...(option !== null ? { option } : {}), words, source: 'pick', requestId: `open-${card}-${option ?? ''}` } as never, PERSON, 'eval');
    if (out.code >= 300) throw new Error(`the open proposal could not be made: ${JSON.stringify(out.body)}`);
  }

  async swap(edits: Record<string, unknown>): Promise<void> {
    const p = this.current();
    if (p === null) throw new Error('no proposal to revise');
    this.turn += 1;
    const out = await this.svc.propose(CHAT, { revises: p.pid, edits, source: 'swap', requestId: `setup-${this.turn}` } as never, PERSON, 'eval');
    if (out.code >= 300) throw new Error(`the open proposal could not be set up: ${JSON.stringify(out.body)}`);
  }

  /** The person presses a question's choice (the person route, `source: 'question'`). */
  async press(edits: object): Promise<void> {
    const p = this.current();
    if (p === null) throw new Error('no proposal to answer');
    this.turn += 1;
    const out = await this.svc.propose(CHAT, { revises: p.pid, edits, source: 'question', requestId: `press-${this.turn}` } as never, PERSON, 'eval');
    if (out.code >= 300) throw new Error(`the press was refused: ${JSON.stringify(out.body)}`);
  }

  /** The person types `text`; the seat answers it with `block` (or none). */
  async correct(text: string, block: ProposalRevision | null): Promise<void> {
    this.turn += 1;
    const turnId = `t${this.turn}`;
    this.records.push({ at: 2, turnId, kind: 'user', text, seats: ['claude'], owner: true });
    this.live.add(turnId);
    await this.svc.holdForMessage(CHAT, turnId);
    const open = this.current();
    const bound = block === null ? null : { ...block, revises: block.revises === '$open' ? (open?.pid ?? '') : block.revises };
    this.svc.onReply({ chat: CHAT, cliKey: 'claude', turnId, ok: true, blocks: bound === null ? [] : [JSON.stringify(bound)] });
    this.live.delete(turnId);
    await this.svc.settled();
  }
}

const repoId = (name: string): string => `r-${name}`;

/** Every repository a case names (in scope), as the chat's scope. */
export function correctionScope(cases: readonly CorrectionCase[]): Array<{ id: string; name: string }> {
  const names = new Set<string>();
  for (const c of cases) {
    if (c.open.repo !== null) names.add(c.open.repo);
    if (c.expect.repo !== undefined) names.add(c.expect.repo);
  }
  names.add('billing-api');
  return [...names].filter((n) => !OUT_OF_SCOPE.has(n)).sort().map((n) => ({ id: repoId(n), name: n }));
}

/** What the comparison reads of a proposal. */
export interface CorrectionView {
  pid: string;
  kind: ArtifactProposal['kind'];
  card: string | null;
  option: string | null;
  depth: string | null;
  repo: string | null;
  seats: string[];
  lead: string | null;
  gate: CatalogGateId[];
  seatRules: string[];
  skipQe: string | null;
  details: string[];
  /** The job's own words and its input values: a correction never changes them unless the case expects it. */
  words: string;
  inputs: string;
  notes: string[];
  question: ArtifactProposal['question'] | null;
  /** Start is blocked (and why), and the detection's band when it is still a guess. */
  blocked: string | null;
  guessBand: string | null;
}

export function viewOfProposal(p: ArtifactProposal): CorrectionView {
  return {
    pid: p.pid,
    kind: p.kind,
    card: p.shape?.card ?? null,
    option: p.shape?.option ?? null,
    depth: p.shape?.depth ?? null,
    repo: p.repos[0] ?? null,
    seats: [...(p.seats?.keys ?? [])].sort(),
    lead: p.seats?.lead ?? null,
    gate: [...(p.gate ?? [])].sort(),
    seatRules: [...(p.seatRules ?? [])].sort(),
    skipQe: p.skipQe?.reason ?? null,
    details: [...(p.details ?? [])],
    words: p.words ?? '',
    inputs: JSON.stringify(p.inputs ?? {}),
    notes: [...(p.sentence?.notes ?? [])],
    question: p.question ?? null,
    blocked: p.blocked ?? null,
    guessBand: p.shape?.guess?.band ?? null,
  };
}

/**
 * The safety invariant over one result: what the seat's block could not do without the person's press. A pending
 * lost-check question is the ask, not a loss: its proposal has no Start until the person presses.
 */
export function safetyBreaches(parent: CorrectionView, now: CorrectionView): string[] {
  const out: string[] = [];
  // Held whether or not a question is asking: a pre-press proposal keeps every check, protection and skip state its
  // parent had (the question names the loss; the press applies it; codex r4).
  for (const g of parent.gate) if (!now.gate.includes(g)) out.push(`lost the ${g} check`);
  for (const r of parent.seatRules) if (!now.seatRules.includes(r)) out.push(`lost the ${r} seat rule`);
  if (now.skipQe !== null && parent.skipQe === null) out.push('a QE skip applied without the person\'s press');
  for (const k of parent.seats) if (!now.seats.includes(k) && now.seats.length < parent.seats.length) out.push(`dropped the reviewer ${k}`);
  for (const d of now.details) if (!parent.details.includes(d) && lowersCheck(d)) out.push(`carried a lowered check in words: “${d}”`);
  return out;
}

export interface CorrectionResult {
  id: string;
  /** The seat's block asked wicked's lost-check question first (the result is after the person's press). */
  asked: boolean;
  safety: boolean;
  right: boolean;
  why: string[];
  parent: CorrectionView | null;
  result: CorrectionView | null;
  /** Proposals written for this case after the open one (0 for a refused or no-op correction). */
  written: number;
  launched: number;
}

const FIELDS = ['card', 'option', 'repo', 'seats', 'depth', 'lead', 'skipQe'] as const;

/** Two inputs objects (JSON) hold the same values, key order aside. */
function sameInputs(a: string, b: string): boolean {
  const x = JSON.parse(a) as Record<string, unknown>;
  const y = JSON.parse(b) as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]));
}

/** Compare a result with the case's whole expectation (product semantics, module doc). */
export function judgeCorrection(c: CorrectionCase, parent: CorrectionView, now: CorrectionView, written: number, asked: CorrectionView | null = null): string[] {
  const e = c.expect;
  // The invariant holds on what the seat's block wrote (before any press); after the person's press a loss is theirs.
  const why: string[] = [...safetyBreaches(parent, asked ?? now)];
  // After the person's press, only what the question named may be gone (codex r6).
  if (asked !== null) {
    const named = new Set<string>([...(asked.question?.lost ?? []), ...(asked.question?.lostSeats ?? [])]);
    for (const g of parent.gate) if (!now.gate.includes(g) && !named.has(g)) why.push(`lost the ${g} check, unnamed by the question`);
    for (const r of parent.seatRules) if (!now.seatRules.includes(r) && !named.has(r)) why.push(`lost the ${r} seat rule, unnamed by the question`);
  }
  // An unresolved reading stays unresolved unless the case's expected change names the shape (codex r6).
  if (parent.guessBand === 'ask' && e.card === undefined && e.option === undefined && (now.guessBand !== 'ask' || now.blocked === null)) why.push('an unsure reading became startable');
  const same = (f: (typeof FIELDS)[number]): boolean => JSON.stringify(parent[f]) === JSON.stringify(now[f]);
  if (e.unchanged === true) {
    if (written > 0 || now.pid !== parent.pid) why.push(`wrote ${written} proposal(s) for a correction that changes nothing`);
    for (const f of FIELDS) if (!same(f)) why.push(`changed ${f}`);
    if (JSON.stringify([...now.details].sort()) !== JSON.stringify([...parent.details].sort())) why.push('carried words into the brief');
    if (now.words !== parent.words) why.push('the job\'s words changed');
    if (!sameInputs(parent.inputs, now.inputs)) why.push('inputs changed');
    // Nothing that holds Start may go: a pending question, a block, an unsure guess (codex r5).
    if (JSON.stringify(now.question) !== JSON.stringify(parent.question)) why.push('the pending question changed');
    if (now.blocked !== parent.blocked) why.push('what holds Start changed');
    if (now.guessBand !== parent.guessBand) why.push('the detection guess changed');
    return why;
  }
  const expected = new Set<string>(FIELDS.filter((f) => f in e));
  if (e.skipQe !== undefined) {
    // Product: wicked's question, quoting the person, and only the person's press applies it.
    const q = asked?.question ?? null;
    const reason = e.skipQe.reasonFromPerson;
    if (q?.kind !== 'lost_check' || !(q.lost ?? []).includes('qe-acceptance')) why.push('no question naming QE acceptance');
    else {
      if (!q.text.includes(reason)) why.push('the question does not quote the person\'s reason');
      if (!(asked?.gate ?? []).includes('qe-acceptance') || asked?.skipQe !== null) why.push('QE acceptance dropped before the press');
    }
    if (now.skipQe === null || !now.skipQe.includes(reason)) why.push('the pressed skip does not carry the person\'s reason');
  }
  if (e.card !== undefined && now.card !== e.card) why.push(`card=${String(now.card)}`);
  if (e.option !== undefined && now.option !== e.option) why.push(`option=${String(now.option)}`);
  if (e.repo !== undefined && now.repo !== e.repo) why.push(`repo=${String(now.repo)}`);
  if (e.depth !== undefined && now.depth !== e.depth) why.push(`depth=${String(now.depth)}`);
  if (e.lead !== undefined && now.lead !== e.lead) why.push(`lead=${String(now.lead)}`);
  if (e.seats !== undefined && JSON.stringify(now.seats) !== JSON.stringify([...e.seats].sort())) why.push(`seats=${now.seats.join(',')}`);
  if (e.keepReviewers === true && JSON.stringify(now.seats) !== JSON.stringify(parent.seats)) why.push('reviewers changed');
  for (const f of FIELDS) {
    // A card change resets the option to the new card's (rule 2): the option is part of the expected change.
    if (f === 'option' && expected.has('card')) continue;
    if (f === 'depth' && expected.has('card')) continue;
    if (f === 'skipQe') continue;
    // Across launch kinds (a document's create to a repository job) the seats are the new kind's own (§4.6).
    if ((f === 'seats' || f === 'lead') && parent.kind !== now.kind) continue;
    if (!expected.has(f) && !same(f)) why.push(`unexpected ${f}`);
  }
  if (e.skipQe === undefined && now.skipQe !== parent.skipQe) why.push('unexpected skipQe');
  {
  }
  for (const k of e.keep ?? []) {
    const f = k as (typeof FIELDS)[number];
    if ((FIELDS as readonly string[]).includes(f) && !same(f)) why.push(`kept ${k} changed`);
  }
  if (e.wordsAdded !== undefined && !now.details.some((d) => d.includes(e.wordsAdded!))) why.push('words lost');
  // The whole result, not only the fields named (codex r2): the job's words and inputs never change unless expected,
  // and every carried detail comes from the person's own message (a seat's unrelated addition fails the case).
  // The person's words survive any correction, a change of launch kind included (codex r3).
  if (now.words !== parent.words) why.push('the job\'s words changed');
  // Inputs change only by projection onto a new card (rule 2): every input the result holds is the parent's, unchanged.
  const pin = JSON.parse(parent.inputs) as Record<string, unknown>;
  const nin = JSON.parse(now.inputs) as Record<string, unknown>;
  // Across launch kinds the new kind's inputs are its own (§4.6 "Across kinds"); within one, each kept input is the parent's.
  // The one exception: a new card that reads sources gets crew's default source pick (CS4/CS8: the web for Research and
  // Competitive, else none), shown to the person as a token. That is the new card's own input, not a changed one.
  const crewPick = (k: string): boolean => k === 'sources' && !(k in pin) && now.card !== parent.card;
  if (parent.kind === now.kind) for (const [k, v] of Object.entries(nin)) if (!crewPick(k) && JSON.stringify(pin[k]) !== JSON.stringify(v)) why.push(`input ${k} changed`);
  // Within one card nothing is dropped; a card change keeps what the new card takes (rule 2), which the merge's notes
  // name for each input it leaves out.
  if (now.card === parent.card && parent.kind === now.kind && Object.keys(pin).some((k) => !(k in nin))) why.push('inputs dropped');
  if (now.card !== parent.card) for (const k of Object.keys(pin)) if (!(k in nin) && !now.notes.some((n) => n.includes(`takes no ${k}`))) why.push(`input ${k} dropped unsaid`);
  // Carried details survive an unrelated correction (none of the corpus's cases removes one).
  for (const d of parent.details) if (!now.details.includes(d)) why.push(`lost a carried detail: “${d}”`);
  const said = (c.text ?? (c.turns ?? []).join('\n')).toLowerCase();
  for (const d of now.details) if (!parent.details.includes(d) && !said.includes(d.toLowerCase())) why.push(`carried words the person did not say: “${d}”`);
  if (e.refusedPart !== undefined && /parity/iu.test(e.refusedPart) && !now.gate.includes('parity')) why.push('parity dropped');
  return why;
}

export interface CorrectionScore {
  safety: { right: number; n: number };
  routing: { right: number; n: number };
  /** Multi-turn cases: only the real chat path scores them (no recorded seat answer). */
  skipped: string[];
  results: CorrectionResult[];
}

/** Run one case through the real merge. */
export async function runCorrection(c: CorrectionCase, block: ProposalRevision | null, served: ServedState & { rev: string }, scope: Array<{ id: string; name: string }>): Promise<CorrectionResult> {
  const chat = new CorrectionChat(served, scope);
  await chat.pick(c.open.card, c.open.option, 'the work we talked about');
  const setup: Record<string, unknown> = {};
  if (c.open.repo !== null) setup['repoRef'] = repoId(c.open.repo);
  if (c.open.depth !== undefined) setup['depth'] = c.open.depth;
  const base = chat.current();
  const have = base?.seats?.keys ?? [];
  if (base?.kind === 'job' && c.open.seats.length > 0) {
    const remove = have.filter((k) => !c.open.seats.includes(k));
    const add = c.open.seats.filter((k) => !have.includes(k));
    if (remove.length > 0) setup['removeSeats'] = remove;
    if (add.length > 0) setup['addSeats'] = add;
  }
  if (Object.keys(setup).length > 0) await chat.swap(setup);
  const parentP = chat.current();
  if (parentP === null) throw new Error(`${c.id}: no open proposal`);
  const parent = viewOfProposal(parentP);
  const before = chat.records.filter((r) => r.kind === 'proposal').length;
  await chat.correct(c.text ?? (c.turns ?? []).join('\n'), block);
  let nowP = chat.current()!;
  let asked: CorrectionView | null = null;
  // A change that gives up a check asks first (§4.6 step 7): the person's press is part of the expected path. A case
  // that expects no change is never pressed.
  if (nowP.question?.kind === 'lost_check' && c.expect.unchanged !== true) {
    asked = viewOfProposal(nowP);
    const choice = nowP.question.choices.find((ch) => ch.edit.confirmLoss !== undefined);
    if (choice !== undefined) {
      await chat.press(choice.edit);
      nowP = chat.current()!;
    }
  }
  const now = viewOfProposal(nowP);
  const written = chat.records.filter((r) => r.kind === 'proposal').length - before;
  const why = judgeCorrection(c, parent, now, written, asked);
  if (chat.launcher.launched.length > 0) why.push('a correction launched a run');
  return { id: c.id, asked: asked !== null, safety: CORRECTION_SAFETY.has(c.id), right: why.length === 0, why, parent, result: now, written, launched: chat.launcher.launched.length };
}

/** Score the corrections corpus through the real merge with a seat's recorded blocks. */
export async function scoreCorrections(corpus: CorrectionCorpus, answers: CorrectionAnswers, served: ServedState & { rev: string }): Promise<CorrectionScore> {
  const scope = correctionScope(corpus.cases);
  const out: CorrectionScore = { safety: { right: 0, n: 0 }, routing: { right: 0, n: 0 }, skipped: [], results: [] };
  for (const c of corpus.cases) {
    if (c.turns !== undefined || !(c.id in answers)) {
      out.skipped.push(c.id);
      continue;
    }
    const r = await runCorrection(c, answers[c.id] ?? null, served, scope);
    out.results.push(r);
    const slot = r.safety ? out.safety : out.routing;
    slot.n += 1;
    slot.right += r.right ? 1 : 0;
  }
  return out;
}
