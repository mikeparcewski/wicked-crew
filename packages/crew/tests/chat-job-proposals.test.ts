// DES-CATALOG-002 §2.4, §2.6, §4.6, §9.2 (aa) (ac) (ad) (ag) (Lane C): job proposals over in-memory deps and the real
// engine's catalog. A person-made proposal never launches; Go is idempotent and launches what is on screen, held at its
// plan; a correction in flight holds Start; a stale parent is refused; a check is never lost by a seat's block (only
// the person's press on wicked's question gives it up); a QE skip stands only on the person's own unquoted reason.
import { parseReviewTarget } from '../src/api/review-change.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, CatalogEntry, ChatProposalView, ChatTranscriptRecord, Preset, ProposalRevisionEdits, WorkflowDef } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import {
  ChatProposals,
  foldProposals,
  LaunchOnceRegistry,
  LaunchRefusal,
  type ChatProposalDeps,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { jobLaunchCommon, jobLaunchRoster, seatsShortLine, ownWords, personAskedSkip, qeSkipBound } from '../src/api/chat-jobs.js';
import { launchRosterNaming, primaryRefusal } from '../src/api/routes.js';
import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { engineRosterJson } from '../src/core/engine-roster.js';
import { NewWorkSeatsRefusal } from '../src/core/job-seats.js';
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
  failure: Error | null = null;
  async find(identity: { runId: string }): Promise<boolean> { return this.launched.some((d) => d.identity.runId === identity.runId); }
  async launch(d: ProposalDispatch): Promise<void> { if (this.failure !== null) throw this.failure; this.launched.push(d); }
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
  /** The held-plan Reject a reshape asks for: counted, answered with `rejectAnswer`. */
  rejects: number;
  /** What the preflight says a launch would refuse (`null`: nothing). */
  preflightAnswer: string | null;
  rejectAnswer: { code: number; body: Record<string, unknown> } | null;
  /** (Lane D) The plan version the last Reject was bound to. */
  rejectExpect?: { ord: number; planRev: number } | null;
  /** (api-types 0.196.0) Why a power run is refused (`null`: it can run as one). */
  powerAnswer: string | null;
}

const CHAT = 'c1';

function rig(o: { coverage?: ChatProposalDeps['coverage']; pickFirstRepo?: ChatProposalDeps['pickFirstRepo']; roster?: Array<{ key: string; name: string }>; repos?: Array<{ id: string; name: string }>; reviewAuthors?: ChatProposalDeps['reviewAuthors']; powerPresets?: ChatProposalDeps['powerPresets'] } = {}): Rig {
  const r: Rig = {
    svc: null as unknown as ChatProposals,
    records: [],
    launcher: new FakeLauncher(),
    live: new Set(),
    roster: o.roster ?? [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }],
    chat: { projectId: null, repos: o.repos ?? [{ id: 'r-pay', name: 'payments-service' }, { id: 'r-bill', name: 'billing-api' }], lead: 'claude', seats: ['claude'], analysis: false },
    served,
    qeOff: false,
    rejects: 0,
    rejectAnswer: null,
    preflightAnswer: null,
    powerAnswer: null,
  };
  const registry = new LaunchOnceRegistry();
  registry.register('job', r.launcher);
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, instructions: true, proposals: true, create: false, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: () => [...r.records],
    append: (_c, rec) => {
      r.records.push(rec);
      return true;
    },
    instanceOf: () => 'i1',
    projectOf: () => null,
    chat: () => r.chat,
    ...(o.pickFirstRepo !== undefined ? { pickFirstRepo: o.pickFirstRepo } : {}),
    rosterEligible: () => r.roster,
    ...(o.coverage !== undefined ? { coverage: o.coverage } : {}),
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
    preflight: async () => r.preflightAnswer,
    powerRefusal: async () => r.powerAnswer,
    ...(o.reviewAuthors !== undefined ? { reviewAuthors: o.reviewAuthors } : {}),
    ...(o.powerPresets !== undefined ? { powerPresets: o.powerPresets } : {}),
    reshapeReject: async (_run, _actor, _pid, expect) => {
      r.rejects += 1;
      r.rejectExpect = expect ?? null;
      return r.rejectAnswer;
    },
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
    // CS8 flipped every shown coming card; the record stays for a future one (a deferred card exercises it).
    const r = rig();
    await pick(r, 'tune');
    const p = open(r);
    expect(p.coming).toMatchObject({ release: 'deferred', nearest: { card: 'analyze-runs' } });
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

  it('studio#1094: a seat revision naming a repo never widens a repo-less chat', async () => {
    let picks = 0;
    const r = rig({ repos: [], pickFirstRepo: async () => { picks += 1; return { ok: true, name: 'billing-api' }; } });
    await pick(r, 'migrate', { option: 'upgrade' });
    const parent = open(r);
    expect(parent.needs).toContainEqual(expect.objectContaining({ id: 'repo', status: 'missing' }));
    await say(r, 'first-repo', 'use billing-api');
    await reply(r, 'first-repo', { revises: parent.pid, edits: { repoRef: 'billing-api' } });
    expect(picks).toBe(0);
    expect(r.chat.repos).toEqual([]);
    expect(open(r).repoRefs ?? []).toEqual([]);
    expect(open(r).sentence?.notes).toContain("Not changed: billing-api isn't in this chat's scope (start a thread on it)");
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
    expect(p.sentence!.notes.join(' ')).toMatch(/needs 2 seats/);
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

describe('document title from the person (#1537)', () => {
  const make = () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    const deps = (r.svc as unknown as { deps: ChatProposalDeps }).deps;
    deps.flags = () => ({ context: true, instructions: true, proposals: true, create: true, refine: false, theme: false, demo: false });
    deps.registry.register('create', r.launcher);
    deps.docsRoot = async () => dir;
    deps.acceptsJobs = () => true;
    return r;
  };

  it('a document revision records the chosen writer and checker and launches them (#1538)', async () => {
    const r = make();
    await pick(r, 'document');
    const parent = open(r);
    const out = await swap(r, parent.pid, { lead: 'codex', addSeats: ['pi'], removeSeats: ['claude'] }, 'helpers');
    expect(out.code, JSON.stringify(out.body)).toBe(201);
    const p = open(r);
    expect(p.helpers?.seats).toEqual(['codex', 'pi']);
    expect(p.sentence?.text).toContain('written by {seats}');
    expect(p.sentence?.tokens.find((t) => t.kind === 'seats')).toMatchObject({
      label: 'Codex writes, pi checks',
      swap: { choices: expect.arrayContaining([expect.objectContaining({ label: 'Claude writes', edit: { lead: 'claude' } })]) },
    });
    expect(p.sentence?.notes.join(' ')).toContain('Claude is off');
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched[0]!.resolution.helpers?.seats).toEqual(['codex', 'pi']);
  });

  it('the first card keeps the writer and checker the person named in the same turn (crew#1737)', async () => {
    const r = make();
    await say(r, 't-named', 'Write a document titled Tiny math helper notes. Codex writes it and Pi checks it.');
    await reply(r, 't-named', { entry: 'document', option: 'document', confidence: 0.99, lead: 'codex', seats: ['pi'] });
    const p = open(r);
    expect(p.helpers?.seats).toEqual(['codex', 'pi']);
    expect(p.sentence?.tokens.find((t) => t.kind === 'seats')?.label).toBe('Codex writes, pi checks');
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched[0]!.resolution.helpers?.seats).toEqual(['codex', 'pi']);
  });

  it('a seat the person never named is not taken from the block; a named writer alone gets a drawn checker (crew#1737)', async () => {
    const r = make();
    await say(r, 't-unnamed', 'Write a one-page note about the plugin.');
    await reply(r, 't-unnamed', { entry: 'document', option: 'document', confidence: 0.99, lead: 'pi', seats: ['codex'] });
    expect(open(r).helpers?.seats).toEqual(['claude', 'codex']);
    const w = make();
    await say(w, 't-writer', 'Write a one-page note about the plugin; Codex writes it.');
    await reply(w, 't-writer', { entry: 'document', option: 'document', confidence: 0.99, lead: 'codex' });
    expect(open(w).helpers?.seats).toEqual(['codex', 'claude']);
    expect(open(w).blocked).toBeNull();
  });

  it('a removal that leaves one document helper keeps both and explains why (#1538)', async () => {
    const r = make();
    await pick(r, 'document');
    const parent = open(r);
    expect((await swap(r, parent.pid, { removeSeats: ['codex'] }, 'remove-checker')).code).toBe(201);
    expect(open(r).helpers?.seats).toEqual(parent.helpers?.seats);
    expect(open(r).sentence?.notes.join(' ')).toMatch(/Codex stays; this job needs 2 seats/u);
    expect(open(r).sentence?.notes.join(' ')).not.toContain('picked again');
  });

  it('a document names the extra helper left out, and refuses fewer than two eligible helpers (#1538)', async () => {
    const r = make();
    await pick(r, 'document');
    expect((await swap(r, open(r).pid, { addSeats: ['pi'] }, 'third-helper')).code).toBe(201);
    expect(open(r).helpers?.seats).toEqual(['claude', 'codex']);
    expect(open(r).sentence?.notes.join(' ')).toMatch(/pi.*left out/u);
    r.roster = r.roster.filter((s) => s.key === 'claude');
    expect((await swap(r, open(r).pid, { detail: { add: ['Keep it short.'] } }, 'one-helper')).code).toBe(201);
    expect(open(r).helpers).toBeNull();
    // Said once, by the block (no second note repeating it).
    expect(open(r).blocked).toMatch(/second helper/u);
  });

  it('a second-tab revision cannot land during a held Go (#1279)', async () => {
    const r = make();
    await pick(r, 'document');
    const p = open(r);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const starting = new Promise<void>((resolve) => { entered = resolve; });
    const launch = r.launcher.launch.bind(r.launcher);
    r.launcher.launch = async (d) => { entered(); await held; await launch(d); };
    const go = r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    await Promise.race([starting, go.then((out) => { throw new Error(`Go refused: ${JSON.stringify(out)}`); })]);
    let finished = false;
    const revision = swap(r, p.pid, { lead: 'pi' }, 'second-tab').then((out) => { finished = true; return out; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    expect((await go).code).toBe(200);
    expect(await revision).toMatchObject({ code: 409, body: { code: 'proposal_stale' } });
    expect(r.launcher.launched).toHaveLength(1);
  });

  it.each([
    ["a one-page note titled 'Plugin check note'", 'Plugin check note', 'Plugin check note'],
    ['a note titled “PLUGIN   CHECK NOTE”', 'Plugin check note', 'Plugin check note'],
    ['a one-page note about the plugin', 'Invented title', 'Document'],
  ])('keeps only a title present in the person’s turn: %s', async (words, title, expected) => {
    const r = make();
    await say(r, 't-title', words);
    await reply(r, 't-title', { entry: 'document', option: 'document', confidence: 0.99, title });
    const p = open(r);
    expect(p.what.title).toBe(expected);
    if (expected !== 'Document') {
      expect(p.what.label).not.toBe('Document · Document');
      expect((await swap(r, p.pid, { detail: { add: ['Include the plugin version.'] } }, 'detail')).code).toBe(201);
      expect(open(r).what.title).toBe(expected);
      expect((await r.svc.decide(CHAT, open(r).pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
      expect(r.launcher.launched[0]!.identity.artifactRef).toMatch(/\/plugin-check-note-[a-f0-9]+$/u);
    }
  });
});

describe('across kinds', () => {
  it('a revision to a document option writes an artifact create in the same lineage (create on), else refuses', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'document', { option: 'repo-docs' });
    const job = open(r);
    expect(job.kind).toBe('job');
    // A deck is an artifact create, which this daemon (create off) cannot start from a chat: said at once, never behind
    // a loss question it could not honour (codex r4).
    const out = await swap(r, job.pid, { option: 'presentation' }, 'deck');
    expect(out.body).toMatchObject({ code: 'operation_unavailable' });
    expect(open(r).pid).toBe(job.pid);
    expect(CATALOG_V2_CARDS.find((c) => c.id === 'document')).toBeDefined();
  });
});


describe('codex/pi r1 folds', () => {
  /** An engine whose built-in `name` changed under an open proposal (its steps replaced). */
  const withBuiltin = (name: string, steps: (s: Preset['steps']) => Preset['steps']): ServedState & { rev: string } => {
    const presets = presetsAll.map((p) => (p.name === name && p.created_by === 'builtin' ? { ...p, steps: steps(p.steps) } : p));
    return { ...servedState({ defs: defsAll, presets, entries: entriesAll }), rev: buildWorkflowCatalogV2({ defs: defsAll, presets, entries: entriesAll, runs: [], actorId: '', projectId: null }).rev };
  };

  it('a card change drops an earlier QE skip: the new card asks for its own (pi P2)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    await swap(r, open(r).pid, { skipQe: { reason: 'a prototype' }, confirmLoss: ['qe-acceptance'] }, 'skip');
    expect(open(r).skipQe).toEqual({ reason: 'a prototype' });
    await swap(r, open(r).pid, { card: 'bug' }, 'to-bug');
    expect(open(r)).toMatchObject({ shape: { card: 'bug' }, skipQe: null });
    expect(open(r).gate).toContain('qe-acceptance');
    // And a skip can be taken back.
    await swap(r, open(r).pid, { skipQe: { reason: 'again' }, confirmLoss: ['qe-acceptance'] }, 'skip2');
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
    // An engine whose migration no longer carries the parity rubric. (A SAVED migration without it no longer resolves the
    // card at all, crew#1445: the option is off and the shadow runs from Yours only.)
    r.served = withBuiltin('migration', (steps) => steps.map((s) => {
      const out = { ...s };
      delete out.rubric;
      return out;
    }));
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
    await pick(r, 'review-change');
    const p = open(r);
    await say(r, 't1', 'make it a risk analysis');
    await reply(r, 't1', { revises: p.pid, edits: { card: 'risk' } });
    expect(open(r).question).toMatchObject({ kind: 'lost_check', lostSeats: ['excludeChangeAuthors'] });
  });

  // CJ13 (fold 26): the builder of the PR (claude, the chat's lead) was the proposal's default lead, the launch dropped it
  // from the roster and refused primary=claude with a 502; the passage also listed it among the helpers.
  it('a review of a change is led and helped only by seats that did not write it (CJ13)', async () => {
    const asked: Array<[string, string]> = [];
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async (repoRef, words) => { asked.push([repoRef, words]); return ['claude']; } });
    await pick(r, 'review-change', { words: 'review pull request 9' });
    const p = open(r);
    expect(asked).toEqual([['r-pay', 'review pull request 9']]);
    expect(p.seats?.lead).toBe('codex');
    expect(p.seats?.keys).toEqual(['codex', 'pi']);
    const seats = p.sentence!.tokens.find((t) => t.kind === 'seats')!;
    expect(seats.label).not.toMatch(/Claude/);
    expect((seats.swap?.choices ?? []).map((c) => c.label)).toEqual(['pi leads']);
    expect(r.launcher.launched).toHaveLength(0);
    // A lead swap to the author is not taken; a swap to another reviewer is (and keeps the author out).
    await swap(r, p.pid, { lead: 'claude' }, 'lead-claude');
    expect(open(r).seats?.lead).toBe('codex');
    await swap(r, open(r).pid, { lead: 'pi' }, 'lead-pi');
    expect(open(r).seats).toMatchObject({ lead: 'pi', keys: ['pi', 'codex'] });
  });

  it('a review whose every seat wrote the change keeps the roster, so the launch decides (CJ13)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async () => ['claude', 'codex', 'pi'] });
    await pick(r, 'review-change', { words: 'review pull request 9' });
    expect(open(r).seats?.lead).toBe('claude');
  });

  it('a revision that names another change checks its seats against that change\'s authors, read once (CJ13)', async () => {
    // The mock reads the target the way the launch does (the first PR the words name).
    const asked: string[] = [];
    const authorsOf: Record<string, string[]> = { none: ['claude'], '10': ['codex'] };
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async (_repo, words) => {
      asked.push(words);
      const t = parseReviewTarget(words);
      return authorsOf[t?.kind === 'pr' ? String(t.number) : 'none'] ?? [];
    } });
    await pick(r, 'review-change', { words: 'review the latest change' });
    expect(open(r).seats).toMatchObject({ lead: 'codex', keys: ['codex', 'pi'] });
    await swap(r, open(r).pid, { detail: { add: ['it is pull request 10'] }, lead: 'claude' } as ProposalRevisionEdits, 'pr10');
    // codex wrote PR 10: it leaves the seats it held, and claude, who did not, may lead.
    expect(open(r).seats).toMatchObject({ lead: 'claude', keys: ['claude', 'pi'] });
    expect(asked.filter((w) => parseReviewTarget(w)?.kind === 'pr')).toHaveLength(1);
  });

  it('a retarget whose authors held every chosen seat picks the seats again from the reviewers left (CJ13)', async () => {
    const authorsOf: Record<string, string[]> = { none: ['claude', 'codex'], '10': ['pi', 'agy'] };
    const r = rig({
      roster: [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }, { key: 'agy', name: 'Antigravity' }],
      repos: [{ id: 'r-pay', name: 'payments-service' }],
      reviewAuthors: async (_repo, words) => { const t = parseReviewTarget(words); return authorsOf[t?.kind === 'pr' ? String(t.number) : 'none'] ?? []; },
    });
    await pick(r, 'review-change', { words: 'review the latest change' });
    expect(open(r).seats?.keys).toEqual(['pi', 'agy']);
    await swap(r, open(r).pid, { detail: { add: ['it is pull request 10'] } } as ProposalRevisionEdits, 'pr10');
    expect(open(r).seats).toMatchObject({ lead: 'claude', keys: ['claude', 'codex'] });
  });

  it('seats the person names are never replaced, even when they all wrote the change (CJ13)', async () => {
    const r = rig({
      roster: [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }, { key: 'agy', name: 'Antigravity' }],
      repos: [{ id: 'r-pay', name: 'payments-service' }],
      reviewAuthors: async () => ['claude', 'codex'],
    });
    await pick(r, 'review-change', { words: 'review pull request 9' });
    expect(open(r).seats?.keys).toEqual(['pi', 'agy']);
    await swap(r, open(r).pid, { addSeats: ['claude', 'codex'], removeSeats: ['pi', 'agy'] } as ProposalRevisionEdits, 'authors');
    expect(open(r).seats?.keys).not.toContain('claude');
    expect(open(r).seats?.keys).not.toContain('codex');
  });

  it('only carried seats that all wrote the new change are picked again; an empty or unavailable choice stays short (CJ13)', async () => {
    const roster = [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }];
    const r = rig({ roster, repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async () => ['claude'] });
    await pick(r, 'review-change', { words: 'review pull request 9' });
    expect(open(r).seats?.keys).toEqual(['codex', 'pi']);
    // codex and pi leave the roster (not authors): a detail-only revision does not swap in the author.
    r.roster = [{ key: 'claude', name: 'Claude' }];
    await swap(r, open(r).pid, { detail: { add: ['look closely'] } } as ProposalRevisionEdits, 'gone');
    expect(open(r).seats).toMatchObject({ lead: null, keys: [] });
  });

  it('an unreadable change, or another card, keeps the roster as it is (CJ13)', async () => {
    const failing = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async () => { throw new Error('gh down'); } });
    await pick(failing, 'review-change', { words: 'review pull request 9' });
    expect(open(failing).seats?.lead).toBe('claude');
    let calls = 0;
    const other = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], reviewAuthors: async () => { calls += 1; return ['claude']; } });
    await pick(other, 'migrate', { option: 'upgrade', words: 'bump to node 22' });
    expect(calls).toBe(0);
    expect(open(other).seats?.lead).toBe('claude');
  });

  // CJ13 (fold 26) reported a seats swap turning plan review off. Crew's half: every token swap keeps the job's power
  // choice (the Review plan switch itself is the browser's own setting, studio's store).
  it.each([
    ['lead', { lead: 'codex' }],
    ['repository', { repoRef: 'r-bill' }],
    ['depth', { depth: 'deep' }],
  ] as const)('a %s swap keeps the Start\'s power choice (CJ13)', async (_name, edits) => {
    const r = rig({ powerPresets: async () => new Set(['review-change']) });
    await pick(r, 'review-change', { words: 'review pull request 9 in payments-service', repoRef: 'r-pay' } as never);
    let p = open(r);
    if (p.repoRefs === undefined) { await swap(r, p.pid, { repoRef: 'r-pay' }, 'repo'); p = open(r); }
    expect(p.powerChoice).toBe(true);
    await swap(r, p.pid, edits as ProposalRevisionEdits, `swap-${_name}`);
    const v2 = open(r);
    expect(v2.pid).not.toBe(p.pid);
    expect(v2.powerChoice).toBe(true);
  });

  it.each([true, false])('the sketch promises only the stops kept with power choice %s (T11)', async (powerChoice) => {
    const r = rig({
      repos: [{ id: 'r-pay', name: 'payments-service' }],
      ...(powerChoice ? { powerPresets: async () => new Set(['editor-plugin']) } : {}),
    });
    expect((await pick(r, 'studio-plugin', { option: 'editor' })).code).toBe(201);
    const p = open(r);
    expect(p.powerChoice === true).toBe(powerChoice);
    const resolved = resolveOption('studio-plugin', 'editor', r.served)!;
    expect(resolved.workflow).toBe('editor-plugin');
    expect(p.sketch!.steps).toHaveLength(resolved.steps.length);
    const human = resolved.steps.flatMap((s, i) => {
      const gate = s['gate'];
      return gate !== null && typeof gate === 'object' && ('human_confirm' in gate || 'human_confirm_if' in gate) ? [i] : [];
    });
    expect(human.length, 'human confirmation steps are served').toBeGreaterThan(0);
    for (const i of human) expect(p.sketch!.steps[i]!.asks, resolved.steps[i]!.id).toBe(!powerChoice);
    const consent = resolved.steps.flatMap((s, i) => s['gate'] === 'consent_before' ? [i] : []);
    expect(consent.length, 'consent_before steps are served').toBeGreaterThan(0);
    for (const i of consent) expect(p.sketch!.steps[i]!.asks, resolved.steps[i]!.id).toBe(true);
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
    card, option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });

  it('a replacement with fewer checks is refused until the person confirms; then the held plan is rejected and it launches once', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'in-place' });
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const base = { pid: `${CHAT}:reshape:run1:a`, oldRunId: 'run1', parentPid: held.pid, facts: facts('feature'), edits: { card: 'feature' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'a', digest: 'd1' } };
    const refused = await r.svc.reshape(CHAT, { ...base, confirmLoss: [] }, ME, 'i1');
    expect(refused.body).toMatchObject({ code: 'reshape_loses_check', lost: ['parity'] });
    expect(r.rejects).toBe(0);
    const ok = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:b`, request: { id: 'b', digest: 'd2' }, confirmLoss: ['parity'] }, ME, 'i1');
    expect(ok.code, JSON.stringify(ok.body)).toBe(200);
    expect(r.rejects).toBe(1);
    const launched = r.launcher.launched.at(-1)!;
    expect(launched.resolution).toMatchObject({ reshapes: 'run1', shape: { card: 'feature', source: 'reshape' }, revises: held.pid, lineage: held.lineage });
    // Idempotent by its request: the same reshape answers its decision and launches nothing more.
    const again = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:b`, request: { id: 'b', digest: 'd2' }, confirmLoss: ['parity'] }, ME, 'i1');
    expect(again.code).toBe(200);
    expect(r.launcher.launched.filter((d) => d.resolution.reshapes === 'run1')).toHaveLength(1);
  });
});

describe('reshape and a bad newWorkSeats (F1/F2 round 4)', () => {
  const facts = (card: string): Parameters<ChatProposals['reshape']>[1]['facts'] => ({
    card, option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });
  /** Set what the `newWorkSeats` read answers (the production reader throws `NewWorkSeatsRefusal`). */
  const setting = (r: Rig, read: NonNullable<ChatProposalDeps['newWorkSeats']>): void => {
    (r.svc as unknown as { deps: ChatProposalDeps }).deps.newWorkSeats = read;
  };
  const invalid = async (): Promise<never> => {
    throw new NewWorkSeatsRefusal('setting_invalid', 'the newWorkSeats setting is not a list of seat keys');
  };
  const held = async (r: Rig) => {
    await pick(r, 'migrate', { option: 'in-place' });
    const p = open(r);
    await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    return { pid: `${CHAT}:reshape:run1:a`, oldRunId: 'run1', parentPid: p.pid, facts: facts('feature'), edits: { card: 'feature' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'a', digest: 'd1' }, confirmLoss: ['parity'] };
  };

  it.each([false, true])('redraws seats under the same pid after repair, even with edits=%s; only the second Start launches (crew#1603)', async (withEdits) => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    r.roster.push({ key: 'opencode', name: 'OpenCode' });
    setting(r, invalid);
    await pick(r, 'feature');
    const p = open(r);
    expect(p.seats?.keys).toContain('claude');
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'setting_invalid' });
    setting(r, async () => ['codex', 'pi', 'opencode']);
    const redrawn = await r.svc.decide(CHAT, p.pid, { decision: 'go', ...(withEdits ? { edits: { seats: ['claude', 'codex'] } } : {}) }, ME, 'i1');
    expect(redrawn.code).toBe(409);
    expect(redrawn.body).toMatchObject({ code: 'seats_redrawn', view: { proposal: { pid: p.pid, seats: { keys: ['codex', 'pi', 'opencode'] } } } });
    expect(open(r).seats?.keys).toEqual(['codex', 'pi', 'opencode']);
    expect(open(r).seatsUnread).toBeUndefined();
    expect(r.launcher.launched).toHaveLength(0);
    expect(r.records.some((rec) => rec.kind === 'proposal_accepting')).toBe(false);
    const started = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(started.code, JSON.stringify(started.body)).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    expect(r.launcher.launched[0]!.resolution.seats?.keys).toEqual(['codex', 'pi', 'opencode']);
  });

  it('a retry broadcast reads the repaired setting without a GET or redraw (crew#1603)', async () => {
    const r = rig();
    const frames: Parameters<ChatProposalDeps['broadcast']>[0][] = [];
    (r.svc as unknown as { deps: ChatProposalDeps }).deps.broadcast = (frame) => { frames.push(frame); };
    setting(r, invalid);
    await pick(r, 'feature');
    const p = open(r);
    await r.svc.settled();
    expect(frames.at(-1)).toMatchObject({ record: { proposal: { blocked: expect.stringContaining('newWorkSeats') } } });
    setting(r, async () => ['codex', 'pi']);
    const pid = await r.svc.appendRetry(CHAT, p.pid, 'failed-run', '_unfiled/draft', 'failed');
    await r.svc.settled();
    expect(frames.at(-1)).toMatchObject({ record: { proposal: { pid, blocked: null } } });
  });

  it('appends synchronously while a setting read waits, then broadcasts frames in append order', async () => {
    const r = rig();
    const frames: Parameters<ChatProposalDeps['broadcast']>[0][] = [];
    (r.svc as unknown as { deps: ChatProposalDeps }).deps.broadcast = (frame) => { frames.push(frame); };
    await pick(r, 'feature');
    const p = open(r);
    await r.svc.settled();
    const before = frames.length;
    let release!: (pick: null) => void;
    const reading = new Promise<null>((resolve) => { release = resolve; });
    setting(r, () => reading);
    const first = await r.svc.appendRetry(CHAT, p.pid, 'failed-1', '_unfiled/draft', 'failed');
    const second = await r.svc.appendRetry(CHAT, first!, 'failed-2', '_unfiled/draft', 'failed');
    expect(r.records.slice(-2)).toMatchObject([{ proposal: { pid: first } }, { proposal: { pid: second } }]);
    expect(frames).toHaveLength(before);
    release(null);
    await r.svc.settled();
    expect(frames.slice(before)).toMatchObject([{ record: { proposal: { pid: first } } }, { record: { proposal: { pid: second } } }]);
  });

  it('a fresh reshape is refused with the setting code before the held plan is answered; fixed, it rejects and launches once', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    const base = await held(r);
    const before = r.launcher.launched.length;
    setting(r, invalid);
    const refused = await r.svc.reshape(CHAT, base, ME, 'i1');
    expect(refused.code).toBe(409);
    expect(refused.body).toMatchObject({ code: 'setting_invalid' });
    expect(r.rejects).toBe(0);
    expect(r.launcher.launched).toHaveLength(before);
    setting(r, async () => null);
    const redrawn = await r.svc.reshape(CHAT, base, ME, 'i1');
    expect(redrawn.code).toBe(409);
    expect(redrawn.body).toMatchObject({ code: 'seats_redrawn' });
    expect(r.rejects).toBe(0);
    expect(r.launcher.launched).toHaveLength(before);
    expect((await r.svc.reshape(CHAT, base, ME, 'i1')).code).toBe(200);
    expect(r.rejects).toBe(1);
    expect(r.launcher.launched).toHaveLength(before + 1);
  });

  it('an interrupted reshape (held plan answered, launch failed) retried under a bad setting is refused and launches nothing', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    const base = await held(r);
    const before = r.launcher.launched.length;
    const launch = r.launcher.launch.bind(r.launcher);
    r.launcher.launch = async () => { throw new Error('engine unreachable'); };
    await r.svc.reshape(CHAT, base, ME, 'i1');
    expect(r.rejects).toBe(1);
    r.launcher.launch = launch;
    setting(r, invalid);
    const retried = await r.svc.reshape(CHAT, base, ME, 'i1');
    expect(retried.code).toBe(409);
    expect(retried.body).toMatchObject({ code: 'setting_invalid' });
    expect(r.launcher.launched).toHaveLength(before);
    setting(r, async () => null);
    expect((await r.svc.reshape(CHAT, base, ME, 'i1')).code).toBe(200);
    expect(r.rejects).toBe(1);
    expect(r.launcher.launched).toHaveLength(before + 1);
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

describe('Lane D: a reshape offered on a plan version answers only that version', () => {
  it('passes the offered ord and planRev to the held plan\'s Reject', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const facts: Parameters<ChatProposals['reshape']>[1]['facts'] = { card: 'migrate', option: 'move', depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape' };
    const out = await r.svc.reshape(CHAT, { pid: `${CHAT}:reshape:run1:o`, oldRunId: 'run1', parentPid: held.pid, facts, edits: { option: 'move' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'o', digest: 'do' }, confirmLoss: [], heldPlan: { ord: 1, planRev: 2 } }, ME, 'i1');
    expect(out.code, JSON.stringify(out.body)).toBe(200);
    expect(r.rejectExpect).toEqual({ ord: 1, planRev: 2 });
  });

  it('the binding survives a refused Reject and Go again (every reshape descendant keeps it; codex r2)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const facts: Parameters<ChatProposals['reshape']>[1]['facts'] = { card: 'migrate', option: 'move', depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape' };
    r.rejectAnswer = { code: 409, body: { code: 'gate_changed' } };
    const refused = await r.svc.reshape(CHAT, { pid: `${CHAT}:reshape:run1:p`, oldRunId: 'run1', parentPid: held.pid, facts, edits: { option: 'move' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'p', digest: 'dp' }, confirmLoss: [], heldPlan: { ord: 1, planRev: 3 } }, ME, 'i1');
    expect(refused.body).toMatchObject({ code: 'gate_changed' });
    // A refresh against a changed catalog re-resolves it: the binding stays.
    r.served = { ...r.served, rev: 'rev-x' };
    r.rejectAnswer = null;
    r.rejectExpect = null;
    await r.svc.decide(CHAT, `${CHAT}:reshape:run1:p`, { decision: 'go' }, ME, 'i1');
    const fresh = open(r);
    expect(fresh.heldPlan).toEqual({ ord: 1, planRev: 3 });
    await r.svc.decide(CHAT, fresh.pid, { decision: 'go' }, ME, 'i1');
    expect(r.rejectExpect).toEqual({ ord: 1, planRev: 3 });
  });

  it('a proposal refreshed against a changed catalog again and again keeps one refresh suffix (bounded ids; codex r2)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    for (const rev of ['rev-a', 'rev-b', 'rev-c']) {
      r.served = { ...r.served, rev };
      const go = await r.svc.decide(CHAT, open(r).pid, { decision: 'go' }, ME, 'i1');
      expect(go.body).toMatchObject({ code: 'catalog_changed' });
    }
    expect(open(r).pid.split(':c:')).toHaveLength(2);
  });
});

describe('codex r3 folds', () => {
  const facts = (card: string): Parameters<ChatProposals['reshape']>[1]['facts'] => ({
    card, option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });

  it('a reshape to a card that does not exist answers nothing; Go on a reshape answers the held plan first, never around it', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const base = { oldRunId: 'run1', parentPid: held.pid, facts: facts('nope'), reducedAssurance: false, relaunch: { deliver: 'pr' as const }, confirmLoss: [] as string[] };
    const bad = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:x`, edits: { card: 'nope' }, request: { id: 'x', digest: 'dx' } }, ME, 'i1');
    expect(bad.body).toMatchObject({ code: 'edits_invalid' });
    expect(r.rejects).toBe(0);
    // The held plan's Reject is refused: the reshape stays open, and Go on it asks again (it never launches around it).
    r.rejectAnswer = { code: 409, body: { code: 'gate_changed' } };
    const refused = await r.svc.reshape(CHAT, { ...base, pid: `${CHAT}:reshape:run1:y`, edits: { card: 'bug' }, facts: facts('bug'), request: { id: 'y', digest: 'dy' } }, ME, 'i1');
    expect(refused.body).toMatchObject({ code: 'gate_changed' });
    const go = await r.svc.decide(CHAT, `${CHAT}:reshape:run1:y`, { decision: 'go' }, ME, 'i1');
    expect(go.body).toMatchObject({ code: 'gate_changed' });
    expect(r.rejects).toBe(2);
    expect(r.launcher.launched).toHaveLength(1);
    // Once the Reject is answered, the same Go launches the replacement once, with its lineage.
    r.rejectAnswer = null;
    const ok = await r.svc.decide(CHAT, `${CHAT}:reshape:run1:y`, { decision: 'go' }, ME, 'i1');
    expect(ok.code, JSON.stringify(ok.body)).toBe(200);
    expect(r.launcher.launched.at(-1)!.resolution).toMatchObject({ reshapes: 'run1', heldRejected: true, shape: { card: 'bug' } });
  });

  it('a reshape whose requested input did not apply answers nothing (codex r4)', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const out = await r.svc.reshape(CHAT, { pid: `${CHAT}:reshape:run1:z`, oldRunId: 'run1', parentPid: held.pid, facts: facts('bug'), edits: { card: 'bug', inputs: { requirements: { kind: 'text', value: 'x' } } }, reducedAssurance: false, relaunch: { deliver: 'pr' }, request: { id: 'z', digest: 'dz' }, confirmLoss: [] }, ME, 'i1');
    expect(out.body).toMatchObject({ code: 'edits_invalid' });
    expect(r.rejects).toBe(0);
  });

  it('a press confirms only the losses it was shown: a QE loss from a setting since asks again', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'in-place' });
    await swap(r, open(r).pid, { card: 'feature' }, 'feat');
    const q = open(r);
    expect(q.question?.lost).toEqual(['parity']);
    r.qeOff = true;
    await r.svc.propose(CHAT, { revises: q.pid, edits: q.question!.choices[0]!.edit, source: 'question', requestId: 'press' }, ME, 'i1');
    expect(open(r).question).toMatchObject({ kind: 'lost_check', lost: expect.arrayContaining(['qe-acceptance']) });
  });

  it.each([
    ["Don’t skip QE acceptance because this is a prototype", 'this is a prototype'],
    ['No skipping QE acceptance, this is a prototype', 'this is a prototype'],
    ['‘skip QE acceptance because this is a prototype’', 'this is a prototype'],
  ])('"%s" is not the person\'s own skip', (message, reason) => {
    expect(qeSkipBound(reason, message)).toBe(false);
    expect(personAskedSkip(message)).toBe(false);
  });

  it('a self-seated job names no seats of its own and is not blocked for a short roster', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }], roster: [{ key: 'claude', name: 'Claude' }] });
    await pick(r, 'analyze-runs');
    const p = open(r);
    expect(p.seats).toMatchObject({ lead: null, keys: [] });
    expect(p.blocked ?? '').not.toMatch(/seats that can work/);
  });
});

describe('codex r5 folds', () => {
  const facts = (card: string): Parameters<ChatProposals['reshape']>[1]['facts'] => ({
    card, option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });

  it('a launch the preflight says would refuse never answers the held plan', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    r.preflightAnswer = "payments-service's folder is missing";
    const out = await r.svc.reshape(CHAT, { pid: `${CHAT}:reshape:run1:p`, oldRunId: 'run1', parentPid: held.pid, facts: facts('bug'), edits: { card: 'bug' }, reducedAssurance: false, relaunch: { deliver: 'pr' }, request: { id: 'p', digest: 'dp' }, confirmLoss: [] }, ME, 'i1');
    expect(out.body).toMatchObject({ code: 'proposal_blocked', error: expect.stringMatching(/folder/) });
    expect(r.rejects).toBe(0);
    expect(r.launcher.launched).toHaveLength(1);
  });

  it("a variant card's null option is its default, in a revision and a reshape", async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'migrate', { option: 'upgrade' });
    await swap(r, open(r).pid, { option: null }, 'null-opt');
    expect(open(r).shape?.option).toBe('in-place');
  });
});

describe('codex r6 folds', () => {
  it('a reshape with option null starts the default option, and an unmakeable target is said before any loss question', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const out = await r.svc.reshape(CHAT, {
      pid: `${CHAT}:reshape:run1:n`, oldRunId: 'run1', parentPid: held.pid,
      facts: { card: 'migrate', option: undefined, depth: null, title: null, words: 'w', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape' },
      edits: { card: 'migrate', option: null }, reducedAssurance: false, relaunch: { deliver: 'pr' }, request: { id: 'n', digest: 'dn' }, confirmLoss: [],
    }, ME, 'i1');
    expect(out.code, JSON.stringify(out.body)).toBe(200);
    expect(r.launcher.launched.at(-1)!.resolution.shape).toMatchObject({ card: 'migrate', option: 'in-place' });
    // A coming card never shows a loss question first.
    await pick(r, 'bug', { requestId: 'b2' } as never);
    const bug = open(r);
    const res = await swap(r, bug.pid, { card: 'tune' }, 'to-coming');
    expect(res.body).toMatchObject({ code: 'card_not_available' });
  });
});

describe('(api-types 0.196.0) a job Start chooses power', () => {
  it('absent: the dispatch carries no power; false and true are carried as chosen', async () => {
    for (const [power, want] of [[undefined, undefined], [false, false], [true, true]] as const) {
      const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
      await pick(r, 'bug');
      const out = await r.svc.decide(CHAT, open(r).pid, { decision: 'go', ...(power !== undefined ? { power } : {}) }, ME, 'i1');
      expect(out.code, JSON.stringify(out.body)).toBe(200);
      expect(r.launcher.launched).toHaveLength(1);
      expect('power' in r.launcher.launched[0]!).toBe(power !== undefined);
      expect(r.launcher.launched[0]!.power).toBe(want);
    }
  });

  it('true when it cannot run as one: 409 power_unavailable before anything is recorded or started', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    r.powerAnswer = "this daemon's engine has no power mode; press Start with Review plan on";
    const before = r.records.length;
    const out = await r.svc.decide(CHAT, open(r).pid, { decision: 'go', power: true }, ME, 'i1');
    expect(out).toMatchObject({ code: 409, body: { code: 'power_unavailable', error: expect.stringMatching(/no power mode/) } });
    expect(r.records.length).toBe(before);
    expect(r.launcher.launched).toHaveLength(0);
    // false is not checked against power mode.
    expect((await r.svc.decide(CHAT, open(r).pid, { decision: 'go', power: false }, ME, 'i1')).code).toBe(200);
  });

  it('a daemon with no power check refuses true; Not now with a power choice is a 400', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const pid = open(r).pid;
    expect(await r.svc.decide(CHAT, pid, { decision: 'not_now', power: false }, ME, 'i1')).toMatchObject({ code: 400, body: { code: 'power_not_applicable' } });
    (r.svc as unknown as { deps: { powerRefusal?: unknown } }).deps.powerRefusal = undefined;
    expect(await r.svc.decide(CHAT, pid, { decision: 'go', power: true }, ME, 'i1')).toMatchObject({ code: 409, body: { code: 'power_unavailable' } });
    expect(r.launcher.launched).toHaveLength(0);
  });

  it('an interrupted Start resumes with the choice of the press that resumes it', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const pid = open(r).pid;
    const launch = r.launcher.launch.bind(r.launcher);
    r.launcher.launch = async () => { throw new Error('engine away'); };
    expect((await r.svc.decide(CHAT, pid, { decision: 'go', power: true }, ME, 'i1')).code).toBe(502);
    r.launcher.launch = launch;
    r.powerAnswer = 'no power mode now';
    expect(await r.svc.decide(CHAT, pid, { decision: 'go', power: true }, ME, 'i1')).toMatchObject({ code: 409, body: { code: 'power_unavailable' } });
    const out = await r.svc.decide(CHAT, pid, { decision: 'go', power: false }, ME, 'i1');
    expect(out.code, JSON.stringify(out.body)).toBe(200);
    expect(r.launcher.launched.map((d) => d.power)).toEqual([false]);
  });

  it('a reshape Started again with a refused power choice never answers the held plan', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'feature');
    const held = open(r);
    await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1');
    const facts = { card: 'bug', option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape' } as unknown as Parameters<ChatProposals['reshape']>[1]['facts'];
    const pid = `${CHAT}:reshape:run1:pw`;
    r.preflightAnswer = "payments-service's folder is missing";
    const made = await r.svc.reshape(CHAT, { pid, oldRunId: 'run1', parentPid: held.pid, facts, edits: { card: 'bug' }, reducedAssurance: false, relaunch: { deliver: 'pr' }, request: { id: 'pw', digest: 'dpw' }, confirmLoss: [] }, ME, 'i1');
    expect(made.body).toMatchObject({ code: 'proposal_blocked' });
    r.preflightAnswer = null;
    r.powerAnswer = 'no power mode now';
    expect(await r.svc.decide(CHAT, pid, { decision: 'go', power: true }, ME, 'i1')).toMatchObject({ code: 409, body: { code: 'power_unavailable' } });
    expect(r.rejects).toBe(0);
    expect(r.launcher.launched).toHaveLength(1);
  });
});

describe('crew#1570: the time a proposal promises', () => {
  it('an /analyze domain proposal gives no fixed range, and says the time depends on size', async () => {
    const r = rig();
    await pick(r, 'analyze-codebase', { option: 'domain', words: 'analyze the domain of payments-service' });
    const p = open(r);
    expect(p.sentence!.text).not.toContain('About 10 min–30 min');
    expect(p.sentence!.text).not.toMatch(/About \d/);
    expect(p.sentence!.text).toContain("depends on the repository's size; the job shows the time left once its first page is done");
    expect(p.time!.minutes).toBeNull();
  });

  it('a /feature proposal keeps its range', async () => {
    const r = rig();
    await pick(r, 'feature');
    expect(open(r).sentence!.text).toMatch(/About \d+(\.\d)? (min|h)–\d/);
  });
});

/**
 * (crew#1609, after crew#1590) An opt-in seat (OpenCode) picked for new work, or named on the job, is carried through
 * every launch path: Go again after an interrupted launch, an `addSeats` revision, a reshape (and a reshape's inherited
 * roster). Un-picked, it stays out of each. The engine's roster is the production narrowing the job launcher runs
 * (`launchRosterNaming` with the card's keys, then `jobLaunchRoster`).
 */
describe('opt-in seats through the job lifecycle (crew#1609)', () => {
  // The seats work may name (`proposalRoster` keeps opt-in seats), and the standing the launcher narrows.
  const ROSTER = [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }, { key: 'opencode', name: 'OpenCode' }];
  const STANDING = ROSTER.map((s) => ({ key: s.key, display_name: s.name }));
  const PICKED = ['claude', 'codex', 'opencode'];
  const make = (pick: readonly string[] | null): Rig => {
    const r = rig({ roster: ROSTER, repos: [{ id: 'r-pay', name: 'payments-service' }] });
    (r.svc as unknown as { deps: ChatProposalDeps }).deps.newWorkSeats = async () => pick;
    return r;
  };
  const sorted = (keys: readonly string[] | undefined): string[] => [...(keys ?? [])].sort();
  const last = (r: Rig): ArtifactProposal => r.launcher.launched.at(-1)!.resolution as ArtifactProposal;
  const engine = (p: Pick<ArtifactProposal, 'seats' | 'relaunch'>, standing: ReadonlyArray<{ key?: unknown }> = STANDING): string[] =>
    jobLaunchRoster(launchRosterNaming(standing, p.seats?.lead ?? undefined, p.seats?.keys ?? []), p).roster.map((x) => String(x.key)).sort();
  const facts = (card: string): Parameters<ChatProposals['reshape']>[1]['facts'] => ({
    card, option: undefined, depth: null, title: null, words: 'move it', details: [], repoRef: 'r-pay', projectId: null, lead: null, seats: null, inputs: {}, skipQe: null, by: 'person', source: 'reshape',
  });
  const reshapeOf = async (r: Rig) => {
    await pick(r, 'migrate', { option: 'in-place' });
    const p = open(r);
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    return { pid: `${CHAT}:reshape:run1:a`, oldRunId: 'run1', parentPid: p.pid, facts: facts('feature'), edits: { card: 'feature' }, reducedAssurance: false, relaunch: { deliver: 'pr' as const }, request: { id: 'a', digest: 'd1' }, confirmLoss: ['parity'] };
  };

  it.each([
    ['picked: it is launched', PICKED, true],
    ['not picked: it stays out', null, false],
  ] as const)('Go again after an interrupted launch: an opt-in seat %s', async (_label, pickKeys, carried) => {
    const r = make(pickKeys);
    await pick(r, 'feature');
    const p = open(r);
    expect(sorted(p.seats?.keys).includes('opencode')).toBe(carried);
    const launch = r.launcher.launch.bind(r.launcher);
    r.launcher.launch = async () => { throw new Error('engine unreachable'); };
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).not.toBe(200);
    expect(r.launcher.launched).toHaveLength(0);
    r.launcher.launch = launch;
    const again = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code, JSON.stringify(again.body)).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    expect(sorted(last(r).seats?.keys)).toEqual(sorted(p.seats?.keys));
    expect(engine(last(r))).toEqual(sorted(p.seats?.keys));
    expect(engine(last(r)).includes('opencode')).toBe(carried);
  });

  it.each([
    ['picked: it stays on the card and is launched', PICKED, ['claude', 'codex', 'opencode', 'pi']],
    ['not picked: it stays out', null, ['claude', 'codex', 'pi']],
  ] as const)('an addSeats revision naming another seat: an opt-in seat %s', async (_label, pickKeys, expected) => {
    const r = make(pickKeys);
    await pick(r, 'feature');
    expect((await swap(r, open(r).pid, { addSeats: ['pi'] }, 'add-pi')).code).toBe(201);
    const p = open(r);
    expect(sorted(p.seats?.keys)).toEqual(expected);
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(sorted(last(r).seats?.keys)).toEqual(expected);
    expect(engine(last(r))).toEqual(expected);
  });

  it('nothing picked: an addSeats revision naming the opt-in seat is the opt-in, and Start hands the engine it', async () => {
    const r = make(null);
    await pick(r, 'feature');
    const before = open(r);
    expect(before.seats?.keys).not.toContain('opencode');
    expect((await swap(r, before.pid, { addSeats: ['opencode'] }, 'add-opencode')).code).toBe(201);
    const p = open(r);
    expect(p.seats?.keys).toContain('opencode');
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(last(r).seats?.keys).toContain('opencode');
    expect(engine(last(r))).toContain('opencode');
  });

  it.each([
    ['picked: it is launched', PICKED, true],
    ['not picked: it stays out', null, false],
  ] as const)('a reshape: an opt-in seat %s', async (_label, pickKeys, carried) => {
    const r = make(pickKeys);
    const base = await reshapeOf(r);
    const out = await r.svc.reshape(CHAT, base, ME, 'i1');
    expect(out.code, JSON.stringify(out.body)).toBe(200);
    expect((last(r).seats?.keys ?? []).includes('opencode')).toBe(carried);
    expect(engine(last(r)).includes('opencode')).toBe(carried);
  });

  it("a reshape carries the held run's opt-in seat (named in its facts) after the pick no longer holds it, with that seat's own inherited configuration", async () => {
    const r = make(PICKED);
    const base = await reshapeOf(r);
    // The pick changes: opencode is no longer drawn by default, but the held run named it.
    (r.svc as unknown as { deps: ChatProposalDeps }).deps.newWorkSeats = async () => null;
    const inherited = JSON.stringify([{ key: 'claude', model: 'held' }, { key: 'codex', model: 'held' }, { key: 'opencode', model: 'held-oc' }]);
    const out = await r.svc.reshape(CHAT, { ...base, facts: { ...base.facts, seats: ['claude', 'codex', 'opencode'] }, relaunch: { deliver: 'pr' as const, clisJson: inherited } }, ME, 'i1');
    expect(out.code, JSON.stringify(out.body)).toBe(200);
    const sent = last(r);
    expect(sorted(sent.seats?.keys)).toEqual(['claude', 'codex', 'opencode']);
    expect(sent.relaunch?.clisJson).toBe(inherited);
    const narrowed = jobLaunchRoster(launchRosterNaming(STANDING, sent.seats?.lead ?? undefined, sent.seats?.keys ?? []), sent);
    expect(JSON.parse(narrowed.clisJson!)).toEqual([{ key: 'claude', model: 'held' }, { key: 'codex', model: 'held' }, { key: 'opencode', model: 'held-oc' }]);
  });

  it("a reshape's inherited roster keeps the opt-in seat's own configuration; the card still decides membership", () => {
    const inherited = JSON.stringify([{ key: 'claude', model: 'held' }, { key: 'opencode', model: 'held-oc' }, { key: 'codex', model: 'held' }]);
    const p = { seats: { lead: 'claude', keys: ['claude', 'opencode'], label: '' }, relaunch: { deliver: 'pr' as const, clisJson: inherited } } as unknown as Pick<ArtifactProposal, 'seats' | 'relaunch'>;
    const out = jobLaunchRoster(launchRosterNaming(STANDING, 'claude', ['claude', 'opencode']), p);
    expect(out.roster).toEqual([{ key: 'claude', model: 'held' }, { key: 'opencode', model: 'held-oc' }]);
    expect(JSON.parse(out.clisJson!)).toEqual(out.roster);
  });
});

describe('reshape launch standing after readiness (crew#1606)', () => {
  const signedIn = {
    auth: 'signed_in', signed_in: true, council_eligible: true, work_eligible: true,
    health: { status: 'active', since: '2026-11-01T00:00:00Z' },
  };
  const signedOut = {
    auth: 'signed_out', signed_in: false, council_eligible: false, work_eligible: false,
    council_ineligible_reason: 'signed out — sign in to take a turn',
    work_ineligible_reason: 'signed out — sign in to take work',
    health: { status: 'active', since: '2026-11-20T00:00:00Z' },
  };
  const held = [
    { key: 'claude', model: 'held', ...signedIn },
    { key: 'codex', model: 'held', ...signedIn },
  ];
  // The launcher reads current AFTER ready(), then runs this composition. These fixtures represent
  // that post-readiness read, when a login may have changed since the held launch.
  const launch = (current: Array<Record<string, unknown>>, inherited = held, lead = 'claude', keys = ['claude', 'codex']) => {
    const p = {
      seats: { lead, keys, label: '' },
      relaunch: { deliver: 'pr', clisJson: JSON.stringify(inherited) },
    } as Pick<ArtifactProposal, 'seats' | 'relaunch'>;
    return jobLaunchRoster(launchRosterNaming(current, lead, keys), p);
  };

  it('refuses an inherited lead that signed out during readiness, keeping its held configuration', () => {
    const out = launch([
      { key: 'claude', model: 'current', ...signedIn },
      { key: 'codex', model: 'current', ...signedOut },
    ], held, 'codex');
    expect(out.roster.find((s) => s.key === 'codex')).toMatchObject({ model: 'held' });
    expect(primaryRefusal('codex', out.clisJson!)).toEqual(expect.stringContaining('cannot take work: codex'));
  });

  it('benches an inherited non-lead that signed out during readiness, keeping its held configuration', () => {
    const out = launch([
      { key: 'claude', model: 'current', ...signedIn },
      { key: 'codex', model: 'current', ...signedOut },
    ]);
    const engine = JSON.parse(engineRosterJson(out.clisJson!)) as Array<Record<string, unknown>>;
    expect(engine.find((s) => s['key'] === 'codex')).toMatchObject({ model: 'held', health: { usable: false, reason: 'signed out' } });
    expect(engine.find((s) => s['key'] === 'claude')).toMatchObject({ health: { usable: true } });
  });

  it('removes optional standing that is absent from the current roster', () => {
    const inherited = held.map((s) => ({
      ...s, recent_bench: { reason: 'quota_exhausted' }, host_floor_bench: 'old host bench',
      auth_source: 'probe', auth_evidence: 'old evidence', probed_at: '2026-11-01T00:00:00Z',
      login_check: 'status', login_note: 'old login note', seat_image_unavailable: 'old image',
      version_pin: { ok: false }, benchedUntil: '2026-11-01T01:00:00Z', benchReason: 'old bench',
    }));
    const out = launch(held.map((s) => ({ ...s, model: 'current', login_check: 'live' })), inherited);
    expect(JSON.parse(out.clisJson!)).toEqual(held.map((s) => ({ ...s, login_check: 'live' })));
  });

  it('makes an inherited seat usable when it signed in since the held launch', () => {
    const inherited = held.map((s) => ({ ...s, ...signedOut }));
    const out = launch(held.map((s) => ({ ...s, model: 'current' })), inherited, 'codex');
    const engine = JSON.parse(engineRosterJson(out.clisJson!)) as Array<Record<string, unknown>>;
    expect(engine.find((s) => s['key'] === 'codex')).toMatchObject({ model: 'held', health: { usable: true } });
    expect(primaryRefusal('codex', out.clisJson!)).toBeNull();
  });

  it('refuses an inherited card seat no longer on the current roster', () => {
    expect(() => launch([held[0]!])).toThrow("codex is not on this daemon's roster; change who works on it");
  });
});

describe('reshape launch with the real roster accessor after readiness (crew#1606)', () => {
  const REGISTRY = [
    { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}', login_invocation: 'claude login' },
    { key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true, headless_invocation: 'codex exec {PROMPT}', login_invocation: 'codex login' },
  ];

  function launchAfterSignOut(lead: string): string {
    const keys = ['claude', 'codex'];
    const signed = new Set(['claude', 'codex']);
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => REGISTRY.map((s) => ({ ...s })),
      signedIn: (key) => signed.has(key),
      env: {},
    });
    const fresh = jobLaunchRoster(launchRosterNaming(roster({ launch: true }), lead, keys), {
      seats: { lead, keys, label: '' },
    }).clisJson!;
    const held = JSON.stringify((JSON.parse(fresh) as Array<Record<string, unknown>>).map((s) => ({ ...s, model: 'held' })));

    // The readiness login check changes after the held Go; the next accessor read must see it.
    signed.delete('codex');
    return jobLaunchRoster(launchRosterNaming(roster({ launch: true }), lead, keys), {
      seats: { lead, keys, label: '' },
      relaunch: { deliver: 'pr', clisJson: held },
    }).clisJson!;
  }

  it('refuses an inherited lead codex that signed out during readiness, preserving held configuration', () => {
    const clisJson = launchAfterSignOut('codex');
    const seats = JSON.parse(clisJson) as Array<Record<string, unknown>>;
    expect(seats.find((s) => s['key'] === 'codex')).toMatchObject({ model: 'held' });
    expect(primaryRefusal('codex', clisJson)).toEqual(expect.stringContaining('cannot take work: codex'));
  });

  it('benches inherited non-lead codex after sign-out while claude stays usable, preserving both configurations', () => {
    const clisJson = launchAfterSignOut('claude');
    const engine = JSON.parse(engineRosterJson(clisJson)) as Array<Record<string, unknown>>;
    expect(engine.find((s) => s['key'] === 'codex')).toMatchObject({ model: 'held', health: { usable: false } });
    expect(engine.find((s) => s['key'] === 'claude')).toMatchObject({ model: 'held', health: { usable: true } });
  });
});


describe('launch admission and recovery', () => {
  it('a refused Go forgets its reduced assurance choice before the next plain Go', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const p = open(r);
    expect(p).not.toHaveProperty('reducedAssurance');
    r.launcher.failure = new LaunchRefusal(409, { code: 'no_independent_reviewer', error: 'No other seat can review.' });
    const refused = await r.svc.decide(CHAT, p.pid, { decision: 'go', reducedAssurance: true }, ME, 'i1');
    expect(refused).toMatchObject({ code: 409, body: { view: { state: 'open' } } });
    expect((refused.body['view'] as ChatProposalView).proposal).not.toHaveProperty('reducedAssurance');
    r.launcher.failure = null;
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched[0]!.resolution).not.toHaveProperty('reducedAssurance');
  });

  it('a refused Go preserves reduced assurance already chosen on the reshape card', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const p = open(r);
    r.records.push({ at: 1_001, turnId: 'person:test', kind: 'proposal', proposal: { ...p, reshapes: 'old-run', heldRejected: true, reducedAssurance: true } });
    r.launcher.failure = new LaunchRefusal(409, { code: 'no_independent_reviewer', error: 'No other seat can review.' });
    const refused = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(refused).toMatchObject({ code: 409, body: { view: { state: 'open', proposal: { reducedAssurance: true } } } });
    r.launcher.failure = null;
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched[0]!.resolution.reducedAssurance).toBe(true);
  });

  it('a typed launch refusal preserves its status and retry fields and reopens Start', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const p = open(r);
    const excluded = [{ seat: 'claude', reason: 'wrote the change' }];
    const retryWith = { reducedAssurance: true };
    const launch = r.launcher.launch.bind(r.launcher);
    r.launcher.launch = async () => { throw new LaunchRefusal(409, { code: 'no_independent_reviewer', error: 'No other seat can check this change.', excluded, retryWith }); };
    const refused = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(refused.code).toBe(409);
    expect(refused.body).toMatchObject({ code: 'no_independent_reviewer', excluded, retryWith, view: { state: 'open' } });
    r.launcher.launch = launch;
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go', reducedAssurance: true }, ME, 'i1')).code).toBe(200);
    expect(r.launcher.launched[0]!.resolution.reducedAssurance).toBe(true);
    expect(r.records.filter((x) => x.kind === 'proposal_accepting').at(-1)).toMatchObject({ resolution: { reducedAssurance: true } });
  });

  it.each([false, true])('reduced assurance is only a job Start choice (%s)', async (reducedAssurance) => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const p = open(r);
    const notNow = await r.svc.decide(CHAT, p.pid, { decision: 'not_now', reducedAssurance }, ME, 'i1');
    expect(notNow).toMatchObject({ code: 400, body: { code: 'reduced_assurance_not_applicable' } });
    r.records.push({ at: 1_001, turnId: 'person:test', kind: 'proposal', proposal: { ...p, kind: 'create' } });
    const document = await r.svc.decide(CHAT, p.pid, { decision: 'go', reducedAssurance }, ME, 'i1');
    expect(document).toMatchObject({ code: 400, body: { code: 'reduced_assurance_not_applicable' } });
    expect(r.launcher.launched).toHaveLength(0);
  });

  it('an interrupted job with a lost seat reopens and accepts a new seat pick', async () => {
    const r = rig({ repos: [{ id: 'r-pay', name: 'payments-service' }] });
    await pick(r, 'bug');
    const p = open(r);
    r.launcher.failure = new Error('launch interrupted');
    expect((await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1')).code).toBe(502);
    r.roster = r.roster.filter((x) => x.key !== 'pi');
    const again = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(again.code).toBe(409);
    expect(again.body).toMatchObject({ code: 'helper_unavailable', view: { state: 'open' } });
    r.launcher.failure = null;
    const fixed = await r.svc.decide(CHAT, p.pid, { decision: 'go', edits: { seats: ['claude', 'codex'] } }, ME, 'i1');
    expect(fixed.code, JSON.stringify(fixed.body)).toBe(200);
    expect(r.launcher.launched[0]!.resolution.seats?.keys).toEqual(['claude', 'codex']);
  });

  it('uncovered seats add a coverage note instead of claiming a judge exists', async () => {
    const calls: unknown[] = [];
    const r = rig({ roster: [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }], repos: [{ id: 'r-pay', name: 'payments-service' }], coverage: (keys, bound) => {
      calls.push([keys, bound]);
      return { covered: false, singleIdentity: false, authors: [{ seat: 'claude', judges: [{ seat: 'codex', seenSharing: 'anthropic' }], notJudges: [] }], benched: [] };
    } });
    await pick(r, 'bug');
    const p = open(r);
    expect(p.blocked).toBeNull();
    expect(p.sentence?.notes.join(' ')).toContain('anthropic');
    expect(p.sentence?.notes.join(' ')).not.toContain('judge is the author of the validator');
    expect(calls).toContainEqual([p.seats!.keys, true]);
  });

  it('the card coverage note uses display names and names a benched seat once', async () => {
    const benched = { seat: 'pi', reason: 'benched', detail: 'cannot use this checkout' };
    const r = rig({
      roster: [{ key: 'claude', name: 'Builder' }, { key: 'codex', name: 'Reviewer' }, { key: 'pi', name: 'Helper' }],
      repos: [{ id: 'r-pay', name: 'payments-service' }],
      coverage: () => ({
        covered: false, singleIdentity: false,
        authors: [
          { seat: 'claude', judges: [{ seat: 'codex', seenSharing: 'anthropic' }], notJudges: [benched] },
          { seat: 'codex', judges: [], notJudges: [{ seat: 'claude', reason: 'same_identity' }, benched] },
        ],
        benched: [benched],
      }),
    });
    await pick(r, 'bug');
    const note = open(r).sentence?.notes.find((n) => n.startsWith('These seats'));
    expect(note).toContain('Reviewer was seen calling anthropic, as was Builder');
    expect(note).toContain('Builder runs the same CLI as Reviewer');
    expect(note).toContain('Helper cannot check it: cannot use this checkout');
    expect(note?.match(/Helper/g)).toHaveLength(1);
    expect(note).not.toMatch(/claude|codex|\bpi\b/);
  });

  it('the hold sentence says how many seats can work and how many more to sign in', () => {
    const r = resolveOption('bug', null, served)!;
    expect(seatsShortLine(r, 1)).toBe('Needs 2 seats that can work now, one to build it and one to check it, and only 1 can. Sign in another seat to start it.');
    expect(seatsShortLine(r, 0)).toBe('Needs 2 seats that can work now, one to build it and one to check it, and none can. Sign in 2 more seats to start it.');
    const one = { ...r, resolved: { ...r.resolved, seats: { ...r.resolved.seats, distinctEvaluator: false } } };
    expect(seatsShortLine(one, 0)).toBe('Needs a seat that can work now to build it, and none can. Sign in a seat to start it.');
  });
});
