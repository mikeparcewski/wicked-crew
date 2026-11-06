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
import { ownWords, personAskedSkip, qeSkipBound } from '../src/api/chat-jobs.js';
import { removeScratch } from './setup/scratch.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const dir = mkdtempSync(join(tmpdir(), 'chat-jobs-'));
let served: ServedState & { rev: string };

beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs: WorkflowDef[] = adapter.listWorkflows();
  const presets: Preset[] = await adapter.listPresets();
  const entries: CatalogEntry[] = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
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
    served: async () => served,
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
    const out = await swap(r, job.pid, { option: 'presentation' }, 'deck');
    expect(out.body).toMatchObject({ code: 'operation_unavailable' });
    expect(CATALOG_V2_CARDS.find((c) => c.id === 'document')).toBeDefined();
  });
});
