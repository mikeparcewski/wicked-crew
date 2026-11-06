// DES-CATALOG-002 §2.4, §2.6, §4.6, §9.2 (aa) (ac) (ad) (ag) (Lane C): job proposals over in-memory deps and the real
// engine's catalog. A person-made proposal never launches; Go is idempotent and launches what is on screen, held at its
// plan; a correction in flight holds Start; a stale parent is refused; a check is never lost by a seat's block (only
// the person's press on wicked's question gives it up); a QE skip stands only on the person's own unquoted reason.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, CatalogEntry, ChatTranscriptRecord, Preset, ProposalRevisionEdits, WorkflowDef } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import {
  ChatProposals,
  foldProposals,
  LaunchOnceRegistry,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { jobLaunchCommon, ownWords, personAskedSkip, qeSkipBound } from '../src/api/chat-jobs.js';
import { removeScratch } from './setup/scratch.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const dir = mkdtempSync(join(tmpdir(), 'chat-jobs-'));
let served: ServedState & { rev: string };
let defsAll: WorkflowDef[];
let presetsAll: Preset[];
let entriesAll: CatalogEntry[];

beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs: WorkflowDef[] = adapter.listWorkflows();
  const presets: Preset[] = await adapter.listPresets();
  const entries: CatalogEntry[] = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
  defsAll = defs;
  presetsAll = presets;
  entriesAll = entries;
  adapter.close();
});
afterAll(() => removeScratch(dir));

class FakeLauncher implements ProposalDispatcher {
  launched: ProposalDispatch[] = [];
  async find(identity: { runId: string }): Promise<boolean> { return this.launched.some((d) => d.identity.runId === identity.runId); }
  async launch(d: ProposalDispatch): Promise<void> { this.launched.push(d); }
  async live(): Promise<boolean> { return false; }
}

interface Rig {
  svc: ChatProposals;
  records: ChatTranscriptRecord[];
  launcher: FakeLauncher;
  live: Set<string>;
  roster: Array<{ key: string; name: string }>;
  chat: ProposalChat;
  served: ServedState & { rev: string };
  qeOff: boolean;
}

const CHAT = 'c1';

function rig(o: { roster?: Array<{ key: string; name: string }>; repos?: Array<{ id: string; name: string }> } = {}): Rig {
  const r: Rig = {
    svc: null as unknown as ChatProposals,
    records: [],
    launcher: new FakeLauncher(),
    live: new Set(),
    roster: o.roster ?? [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }],
    chat: { projectId: null, repos: o.repos ?? [{ id: 'r-pay', name: 'payments-service' }, { id: 'r-bill', name: 'billing-api' }], lead: 'claude', seats: ['claude'], analysis: false },
    served,
    qeOff: false,
  };
  const registry = new LaunchOnceRegistry();
  registry.register('job', r.launcher);
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: false, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: () => [...r.records],
    append: (_c, rec) => {
      r.records.push(rec);
      return true;
    },
    instanceOf: () => 'i1',
    projectOf: () => null,
    chat: () => r.chat,
    rosterEligible: () => r.roster,
    runs: async () => [],
    chatOfRun: () => undefined,
    isAskPath: () => false,
    docsRoot: async () => null,
    projectName: async () => null,
    attachments: () => [],
    workflowSteps: async () => 3,
    runCostUsd: async () => null,
    registry,
    jobs: () => true,
    served: async () => r.served,
    qeOff: async () => r.qeOff,
    turnLive: (_c, turnId) => r.live.has(turnId),
    broadcast: () => undefined,
    audit: () => undefined,
    now: () => 1_000,
  };
  r.svc = new ChatProposals(deps);
  return r;
}

const open = (r: Rig): ArtifactProposal => {
  const f = [...foldProposals(r.records).values()].find((x) => x.state === 'open' || x.state === 'revising');
  return f!.proposal;
};

/** The person's message `turnId` (as the message route writes it), and the hold it takes. */
async function say(r: Rig, turnId: string, text: string): Promise<void> {
  r.records.push({ at: 2, turnId, kind: 'user', text, seats: ['claude'], owner: true });
  r.live.add(turnId);
  await r.svc.holdForMessage(CHAT, turnId);
}

/** The seat's reply to `turnId`, with its revision block. */
async function reply(r: Rig, turnId: string, block: unknown | null, ok = true): Promise<void> {
  r.svc.onReply({ chat: CHAT, cliKey: 'claude', turnId, ok, blocks: block === null ? [] : [JSON.stringify(block)] });
  r.live.delete(turnId);
  await r.svc.settled();
}

const pick = (r: Rig, card: string, extra: Record<string, unknown> = {}) =>
  r.svc.propose(CHAT, { card, source: 'pick', requestId: `req-${card}-${String(extra['option'] ?? '')}`, words: 'move the service to node 22', ...extra } as never, ME, 'i1');
const swap = (r: Rig, revises: string, edits: ProposalRevisionEdits, requestId: string) =>
  r.svc.propose(CHAT, { revises, edits, source: 'swap', requestId } as never, ME, 'i1');

describe('a person-made job proposal', () => {
  it('is crew-resolved (sentence, tokens, checks, sketch, lineage) and launches nothing', async () => {
    const r = rig();
    const out = await pick(r, 'migrate', { option: 'upgrade', words: 'bump to node 22' });
    expect(out.code).toBe(201);
    const p = open(r);
    expect(p).toMatchObject({ kind: 'job', launch: 'run', command: '/migrate upgrade', shape: { card: 'migrate', option: 'upgrade', by: 'person', source: 'pick' }, revises: null, lineage: p.pid, catalogRev: served.rev });
    expect(p.gate).toEqual(expect.arrayContaining(['qe-acceptance', 'parity']));
    expect(p.sentence!.ask).toBe('Which repository?');
    expect(p.sentence!.text).not.toMatch(/Start\?$/);
    expect(p.question).toMatchObject({ kind: 'missing', choices: [{ label: 'payments-service', edit: { repoRef: 'r-pay' } }, { label: 'billing-api', edit: { repoRef: 'r-bill' } }] });
    // The sketch is the composed preset's step projection.
    expect(p.sketch!.steps.map((s) => s.label)).toEqual(resolveOption('migrate', 'upgrade', served)!.steps.map((s) => s.id.replace(/-/g, ' ')).map((w) => `${w[0]!.toUpperCase()}${w.slice(1)}`));
    expect(r.launcher.launched).toEqual([]);
    // The checks token cannot be swapped.
    expect(p.sentence!.tokens.find((t) => t.kind === 'checks')!.swap).toBeNull();
    // A repeated request answers the same proposal; another body under it is refused.
    expect((await pick(r, 'migrate', { option: 'upgrade', words: 'bump to node 22' })).code).toBe(201);
    expect(r.records.filter((x) => x.kind === 'proposal')).toHaveLength(1);
    expect((await pick(r, 'migrate', { option: 'upgrade', words: 'other words' })).body).toMatchObject({ code: 'request_reused' });
  });

  it('a hidden card is refused by id and reached by its alias', async () => {
    const r = rig();
    expect((await pick(r, 'test-analysis')).body).toMatchObject({ code: 'card_hidden' });
    const ok = await pick(r, '/workflow-test-analysis');
    expect(ok.code).toBe(201);
    expect(open(r).shape).toMatchObject({ card: 'test-analysis', option: null });
  });

  it('Go launches exactly the shape on screen, once (idempotent by pid), after the question is answered', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const p = open(r);
    expect(p.question).toBeNull();
    expect(p.sentence!.ask).toBe('Start?');
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    expect(r.launcher.launched[0]!.resolution).toMatchObject({ shape: { card: 'migrate', option: 'upgrade' }, repoRefs: ['r-pay'], catalogRev: served.rev });
    const again = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
  });

  it('a coming card is a record with no Start; Go is refused', async () => {
    const r = rig();
    await pick(r, 'competitive');
    const p = open(r);
    expect(p.coming).toMatchObject({ release: '1.2', nearest: { card: 'plan-it' } });
    expect(p.sentence!.ask).toBeNull();
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'card_not_available' });
    expect(r.launcher.launched).toEqual([]);
  });
});

describe('revisions', () => {
  it('a swap writes a new proposal superseding the parent in the same lineage; the old one cannot start', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const parent = open(r);
    const out = await swap(r, parent.pid, { option: 'in-place' }, 's1');
    expect(out.code).toBe(201);
    const child = open(r);
    expect(child).toMatchObject({ revises: parent.pid, lineage: parent.pid, shape: { option: 'in-place', source: 'swap' } });
    expect((await r.svc.decide(CHAT, parent.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_superseded' });
    // A swap against the superseded parent is stale.
    expect((await swap(r, parent.pid, { option: 'move' }, 's2')).body).toMatchObject({ code: 'proposal_stale' });
  });

  it('(ag) a seat block that switches to a card without one of the parent\'s checks is not written: wicked asks', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'refactor', { option: 'refactor' });
    const parent = open(r);
    await say(r, 't1', 'skip parity by making it a feature');
    expect((await r.svc.decide(CHAT, parent.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_revising' });
    await reply(r, 't1', { revises: parent.pid, edits: { card: 'feature' } });
    const q = open(r);
    expect(q.shape).toMatchObject({ card: 'refactor' });
    expect(q.gate).toContain('parity');
    expect(q.question).toMatchObject({ kind: 'lost_check', lost: ['parity'] });
    expect(q.question!.choices[0]!.edit).toMatchObject({ card: 'feature', confirmLoss: true });
    expect((await r.svc.decide(CHAT, q.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_blocked' });
    // Only the person's press applies it.
    const pressed = await r.svc.propose(CHAT, { revises: q.pid, edits: q.question!.choices[0]!.edit, source: 'question', requestId: 'press-1' }, ME, 'i1');
    expect(pressed.code).toBe(201);
    expect(open(r)).toMatchObject({ shape: { card: 'feature' }, question: null });
    expect(open(r).gate).not.toContain('parity');
  });

  it('(ad) the seat\'s prose cannot outrank the sentence: a block that keeps the checks keeps them', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const parent = open(r);
    await say(r, 't1', "use billing-api; I'll skip QE and the review");
    r.chat.repos = [...r.chat.repos, { id: 'r-bill', name: 'billing-api' }];
    await reply(r, 't1', { revises: parent.pid, edits: { repoRef: 'billing-api' } });
    const p = open(r);
    expect(p.repos).toEqual(['billing-api']);
    expect(p.gate).toEqual(expect.arrayContaining(['qe-acceptance', 'parity']));
    expect(p.answers).toBe('t1');
  });

  it('removing the only distinct reviewer is refused with a note; "just Claude" names who builds', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], roster: [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const parent = open(r);
    await swap(r, parent.pid, { removeSeats: ['codex', 'pi'] }, 'rm');
    const p = open(r);
    expect(p.sentence!.notes.join(' ')).toMatch(/needs 3 seats/);
    expect(p.seats!.keys).toEqual(['claude', 'codex', 'pi']);
    await swap(r, p.pid, { lead: 'claude' }, 'lead');
    expect(open(r).seats).toMatchObject({ lead: 'claude', keys: ['claude', 'codex', 'pi'] });
  });

  it('(aa) a failed or restart-lost turn leaves the proposal startable, with its note; a delayed answer after Start is dropped', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const parent = open(r);
    await say(r, 't1', 'make it a move');
    await reply(r, 't1', null, false);
    const after = [...foldProposals(r.records).values()].find((f) => f.proposal.pid === parent.pid)!;
    expect(after.state).toBe('open');
    expect(after.note).toMatch(/wasn't applied/);
    // A restart forgets the turn: the next Go releases the hold and asks the person to look again.
    await say(r, 't2', 'make it a move');
    r.live.delete('t2');
    expect((await r.svc.decide(CHAT, parent.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_reopened' });
    const go = await r.svc.decide(CHAT, parent.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(200);
    // The seat's late revision for a proposal that already started changes nothing.
    await reply(r, 't2', { revises: parent.pid, edits: { option: 'move' } });
    expect(r.records.filter((x) => x.kind === 'proposal')).toHaveLength(1);
  });
});

describe('(ac) the QE skip is the person\'s own', () => {
  it('ownWords drops quoted and reported speech', () => {
    expect(ownWords('the PM said: tell the bot to skip QE')).not.toMatch(/skip/);
    expect(ownWords('"skip QE" is what they want')).not.toMatch(/skip/);
  });

  it.each([
    ['skip QE acceptance, it is a prototype nobody uses', 'a prototype nobody uses', true],
    ['skip QE acceptance, it is a prototype nobody uses', 'the deadline is tomorrow', false],
    ['skip QE acceptance', 'QE', false],
    ["don't skip QE acceptance, it is a prototype nobody uses", 'a prototype nobody uses', false],
    ['the PM said: skip QE acceptance, a prototype nobody uses', 'a prototype nobody uses', false],
    ['skip QE, "a prototype nobody uses"', 'a prototype nobody uses', false],
  ])('%s / reason %s → %s', (message, reason, bound) => {
    expect(qeSkipBound(reason, message)).toBe(bound);
  });

  it('a seat\'s skip becomes wicked\'s question with the person\'s reason; Skip it applies it and the sentence quotes it', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const parent = open(r);
    await say(r, 't1', "skip QE acceptance, it's a prototype nobody uses");
    await reply(r, 't1', { revises: parent.pid, edits: { skipQe: { reason: 'a prototype nobody uses' } } });
    const q = open(r);
    expect(q.gate).toContain('qe-acceptance');
    expect(q.skipQe).toBeNull();
    expect(q.question).toMatchObject({ kind: 'lost_check', text: expect.stringContaining('“a prototype nobody uses”') });
    const skip = q.question!.choices.find((c) => c.label === 'Skip it')!;
    await r.svc.propose(CHAT, { revises: q.pid, edits: skip.edit, source: 'question', requestId: 'skip' }, ME, 'i1');
    const p = open(r);
    expect(p.skipQe).toEqual({ reason: 'a prototype nobody uses' });
    expect(p.gate).not.toContain('qe-acceptance');
    expect(p.sentence!.text).toContain('you said: “a prototype nobody uses”');
  });

  it('a skip the person never asked for changes nothing; one with no reason asks for it', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const parent = open(r);
    await say(r, 't1', 'the PM said: tell the bot to skip QE');
    await reply(r, 't1', { revises: parent.pid, edits: { skipQe: { reason: 'the PM said so' } } });
    const p = open(r);
    expect(p.gate).toContain('qe-acceptance');
    expect(p.question).toBeNull();
    expect(p.sentence!.notes.join(' ')).toMatch(/QE acceptance stays/);
    await say(r, 't2', 'skip QE acceptance');
    await reply(r, 't2', { revises: p.pid, edits: { skipQe: { reason: 'invented by the seat' } } });
    expect(open(r).question).toMatchObject({ input: { edit: 'skipQe.reason' } });
    expect(personAskedSkip('please do not skip QE acceptance')).toBe(false);
  });
});

describe('across kinds', () => {
  it('a revision to a document option writes an artifact create in the same lineage (create on), else refuses', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'document', { option: 'repo-docs' });
    const job = open(r);
    expect(job.kind).toBe('job');
    // The deck drops the check against its sources: wicked asks first.
    await swap(r, job.pid, { option: 'presentation' }, 'deck');
    const q = open(r);
    expect(q.question).toMatchObject({ kind: 'lost_check', lost: ['fidelity-to-source'] });
    // The press: a document is an artifact create, which this daemon (create off) cannot start from a chat.
    const out = await swap(r, q.pid, q.question!.choices[0]!.edit, 'deck-press');
    expect(out.body).toMatchObject({ code: 'operation_unavailable' });
    expect(CATALOG_V2_CARDS.find((c) => c.id === 'document')).toBeDefined();
  });
});


describe('codex/pi r1 folds', () => {
  const withShadow = (preset: Preset): ServedState & { rev: string } => {
    const presets = [...presetsAll, preset];
    return { ...servedState({ defs: defsAll, presets, entries: entriesAll }), rev: buildWorkflowCatalogV2({ defs: defsAll, presets, entries: entriesAll, runs: [], actorId: '', projectId: null }).rev };
  };

  it('a card change drops an earlier QE skip: the new card asks for its own (pi P2)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    await swap(r, open(r).pid, { skipQe: { reason: 'a prototype' }, confirmLoss: true }, 'skip');
    expect(open(r).skipQe).toEqual({ reason: 'a prototype' });
    await swap(r, open(r).pid, { card: 'bug' }, 'to-bug');
    expect(open(r)).toMatchObject({ shape: { card: 'bug' }, skipQe: null });
    expect(open(r).gate).toContain('qe-acceptance');
    // And a skip can be taken back.
    await swap(r, open(r).pid, { skipQe: { reason: 'again' }, confirmLoss: true }, 'skip2');
    await swap(r, open(r).pid, { restoreQe: true }, 'restore');
    expect(open(r).skipQe).toBeNull();
  });

  it("a lost-check choice carries only the edits crew kept, never a seat's refused QE skip (codex 8)", async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'refactor', { option: 'refactor' });
    const parent = open(r);
    await say(r, 't1', 'make it a feature');
    await reply(r, 't1', { revises: parent.pid, edits: { card: 'feature', skipQe: { reason: 'invented reason' } } });
    const q = open(r);
    expect(q.question?.lost).toEqual(['parity']);
    expect(q.question!.choices[0]!.edit).not.toHaveProperty('skipQe');
  });

  it('a seat root block never replaces an open job; it changes only through a revision (codex 9)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const job = open(r);
    await say(r, 't1', 'actually write it up');
    await reply(r, 't1', { entry: 'document-static', title: 'x', sources: ['chat'] });
    expect(open(r).pid).toBe(job.pid);
  });

  it('a catalog refresh that would drop a check is a question, not a startable proposal (codex 10)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'in-place' });
    const p = open(r);
    expect(p.gate).toContain('parity');
    // A saved migration with the built-in's instruments and no parity rubric.
    r.served = withShadow({ name: 'migration', steps: [{ catalog: 'build', id: 'execute' }, { catalog: 'test', id: 'verify' }], created_by: 'me', scope: 'global', required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] } as unknown as Preset);
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.body).toMatchObject({ code: 'catalog_changed' });
    const fresh = open(r);
    expect(fresh.question).toMatchObject({ kind: 'lost_check', lost: ['parity'] });
    expect((await r.svc.decide(CHAT, fresh.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_blocked' });
    expect(r.launcher.launched).toEqual([]);
    // An unrelated correction cannot clear the question (codex r2): the loss still needs the press.
    await swap(r, fresh.pid, { detail: { add: ['on Linux'] } }, 'detail');
    expect(open(r).question).toMatchObject({ kind: 'lost_check', lost: ['parity'] });
    // The press: a startable proposal without parity, and one launch; the old pid stays unlaunchable.
    await swap(r, open(r).pid, { confirmLoss: true }, 'accept');
    const accepted = open(r);
    expect(accepted.question).toBeNull();
    expect(accepted.gate).not.toContain('parity');
    expect((await r.svc.decide(CHAT, accepted.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_superseded' });
  });

  it('a self-seated card shows no seat choice and refuses seat edits (codex r2)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'review-recent-work');
    const p = open(r);
    expect(p.sentence!.tokens.find((t) => t.kind === 'seats')).toMatchObject({ label: 'a seat the review picks itself', swap: null });
    await swap(r, p.pid, { lead: 'codex' }, 'lead');
    expect(open(r).sentence!.notes.join(' ')).toMatch(/picks its own seat/);
  });

  it('a change that gives up a seat protection asks first, like a check (codex 13)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'retro');
    const p = open(r);
    await say(r, 't1', 'make it a risk analysis');
    await reply(r, 't1', { revises: p.pid, edits: { card: 'risk' } });
    expect(open(r).question).toMatchObject({ kind: 'lost_check', lostSeats: expect.arrayContaining(['notRunSeat']) });
  });

  it.each([
    ['> skip QE acceptance, a prototype nobody uses', 'a prototype nobody uses'],
    ['`skip QE acceptance` a prototype nobody uses', 'a prototype nobody uses'],
    ['the lead requested we skip QE acceptance, a prototype nobody uses', 'a prototype nobody uses'],
    ['do not ever, under any circumstances, skip QE acceptance for a prototype nobody uses', 'a prototype nobody uses'],
  ])('(codex 14) "%s" is not the person\'s own skip', (message, reason) => {
    expect(qeSkipBound(reason, message)).toBe(false);
  });

  it('a hidden card reached by its alias can be started with edits, never a server error (codex 23)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, '/workflow-test-analysis');
    const p = open(r);
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go', edits: {} }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
  });

  it('an answered turn whose revision is still queued is not released by a read (codex 28)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const p = open(r);
    await say(r, 't1', 'make it a move');
    r.svc.onReply({ chat: CHAT, cliKey: 'claude', turnId: 't1', ok: true, blocks: [JSON.stringify({ revises: p.pid, edits: { option: 'move' } })] });
    r.live.delete('t1');
    expect(await r.svc.reopenStale(CHAT, 'i1')).toBe(false);
    await r.svc.settled();
    expect(open(r).shape?.option).toBe('move');
  });

  it('an input is checked against the card (kind, non-blank); a long backlog steer blocks Start', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    await swap(r, open(r).pid, { inputs: { requirements: { kind: 'text', value: 'x' } } }, 'bad-input');
    expect(open(r).sentence!.notes.join(' ')).toMatch(/takes no/);
    r.chat.projectId = 'p1';
    await pick(r, 'backlog', { option: 'tasks', words: 'x'.repeat(600) });
    expect(open(r).blocked).toMatch(/500 characters/);
  });

  it('with QE acceptance off on the daemon, the proposal says so instead of promising it', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    r.qeOff = true;
    await pick(r, 'feature');
    expect(open(r).gate).not.toContain('qe-acceptance');
    expect(open(r).sentence!.notes.join(' ')).toMatch(/off on this daemon/);
  });
});

describe('reshape (§2.5)', () => {
  const facts = (card: string): Parameters<ChatProposals['reshape']>[1]['facts'] => ({
    card, option: undefined, depth: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });

  it('a replacement with fewer checks is refused until the person confirms; then the held plan is rejected and it launches once', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'in-place' });
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    let rejected = 0;
    const rejectHeld = async () => { rejected += 1; return null; };
    const base = { pid: `${CHAT}:reshape:run1:a`, oldRunId: 'run1', parentPid: held.pid, facts: facts('feature'), edits: { card: 'feature' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'a', digest: 'd1' } };
    const refused = await r.svc.reshape(CHAT, { ...base, confirmLoss: false }, ME, 'i1', rejectHeld);
    expect(refused.body).toMatchObject({ code: 'reshape_loses_check', lost: ['parity'] });
    expect(rejected).toBe(0);
    const ok = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:b`, request: { id: 'b', digest: 'd2' }, confirmLoss: true }, ME, 'i1', rejectHeld);
    expect(ok.code, JSON.stringify(ok.body)).toBe(200);
    expect(rejected).toBe(1);
    const launched = r.launcher.launched.at(-1)!;
    expect(launched.resolution).toMatchObject({ reshapes: 'run1', shape: { card: 'feature', source: 'reshape' }, revises: held.pid, lineage: held.lineage });
    // Idempotent by its request: the same reshape answers its decision and launches nothing more.
    const again = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:b`, request: { id: 'b', digest: 'd2' }, confirmLoss: true }, ME, 'i1', rejectHeld);
    expect(again.code).toBe(200);
    expect(r.launcher.launched.filter((d) => d.resolution.reshapes === 'run1')).toHaveLength(1);
  });
});

describe('what Go sends (codex 4, 7, 12)', () => {
  it('carries the derived identity, the chat, the shape, the seats shown, QE as shown and a reshape\'s lineage', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const p = { ...open(r), reshapes: 'old-run', reducedAssurance: true as const };
    const body = jobLaunchCommon(p, { runId: 'rid', chatId: CHAT }, { clisJson: '[]', selfSeated: false });
    expect(body).toMatchObject({ sessionId: 'rid', chatId: CHAT, primary: 'claude', clisJson: '[]', forceQeAcceptance: true, retryOf: 'old-run', reducedAssurance: true, shape: { card: 'feature', catalogRev: served.rev } });
    const skipped = jobLaunchCommon({ ...p, skipQe: { reason: 'r' } }, { runId: 'rid', chatId: CHAT }, { selfSeated: true });
    expect(skipped).toMatchObject({ skipQeAcceptance: { reason: 'r' } });
    expect(skipped).not.toHaveProperty('forceQeAcceptance');
    expect(skipped).not.toHaveProperty('primary');
    // QE as shown: a proposal without QE acceptance sends no force.
    expect(jobLaunchCommon({ ...p, gate: ['parity'] }, { runId: 'rid', chatId: CHAT }, { selfSeated: false })).not.toHaveProperty('forceQeAcceptance');
  });
});
