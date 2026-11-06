// DES-CATALOG-002 §2.3, §2.4, §4.6, §9.2 (u) (w) (x) (ah) (Lane D): work started in the chat. The statement routes new
// work through a job block (never PLAN+), the seat's block is a guess crew validates, cross-checks and bands, an older
// client gets the command in prose, and typed words at a held plan become wicked's OFFER (a send-back quoting the
// person, or "start it again as…"), never a gate decision and never a launch.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatPlanOffer, ChatTranscriptRecord } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { CHAT_DIGEST_MAX_BYTES } from '../src/workflow-catalog/detect.js';
import {
  ChatProposals,
  firstValidBlock,
  foldProposals,
  isJobCardEntry,
  LaunchOnceRegistry,
  parsePlanEditBlock,
  type ChatProposalDeps,
  type HeldPlan,
  type ProposalChat,
  type ProposalDispatch,
  type ProposalDispatcher,
} from '../src/api/chat-proposals.js';
import { chatJobTurnLines, chatMakeDigest, chatScopeStatement } from '../src/api/chat-scope.js';
import type { ChatScope } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const CHAT = 'c1';
const dir = mkdtempSync(join(tmpdir(), 'chat-detect-'));
let served: ServedState & { rev: string };

beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs = adapter.listWorkflows();
  const presets = await adapter.listPresets();
  const entries = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
  adapter.close();
});
afterAll(() => removeScratch(dir));

class FakeLauncher implements ProposalDispatcher {
  launched: ProposalDispatch[] = [];
  async find(identity: { runId: string }): Promise<boolean> {
    return this.launched.some((d) => d.identity.runId === identity.runId);
  }
  async launch(d: ProposalDispatch): Promise<void> {
    this.launched.push(d);
  }
  async live(): Promise<boolean> {
    return false;
  }
}

interface Rig {
  svc: ChatProposals;
  records: ChatTranscriptRecord[];
  launcher: FakeLauncher;
  accepts: boolean;
  held: HeldPlan | null;
  chat: ProposalChat;
  live: Set<string>;
}

function rig(o: { accepts?: boolean; repos?: Array<{ id: string; name: string }> } = {}): Rig {
  const r: Rig = {
    svc: null as unknown as ChatProposals,
    records: [],
    launcher: new FakeLauncher(),
    accepts: o.accepts ?? true,
    held: null,
    chat: { projectId: null, repos: o.repos ?? [{ id: 'r-pay', name: 'payments-service' }], lead: 'claude', seats: ['claude'], analysis: false },
    live: new Set(),
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
    rosterEligible: () => [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }],
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
    acceptsJobs: () => r.accepts,
    heldPlan: async () => r.held,
    turnLive: (_c, t) => r.live.has(t),
    broadcast: () => undefined,
    audit: () => undefined,
    now: () => 1_000,
  };
  r.svc = new ChatProposals(deps);
  return r;
}

/** The person's message (as the message route writes it, with its hold), then the seat's reply with its blocks. */
async function turn(r: Rig, turnId: string, text: string, blocks: unknown[]): Promise<void> {
  r.records.push({ at: 2, turnId, kind: 'user', text, seats: ['claude'], owner: true });
  r.live.add(turnId);
  await r.svc.holdForMessage(CHAT, turnId);
  r.svc.onReply({ chat: CHAT, cliKey: 'claude', turnId, ok: true, blocks: blocks.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))) });
  r.live.delete(turnId);
  await r.svc.settled();
}

const proposals = (r: Rig): ArtifactProposal[] => r.records.filter((x): x is Extract<ChatTranscriptRecord, { kind: 'proposal' }> => x.kind === 'proposal').map((x) => x.proposal);
const offers = (r: Rig): ChatPlanOffer[] => r.records.filter((x): x is Extract<ChatTranscriptRecord, { kind: 'plan_offer' }> => x.kind === 'plan_offer').map((x) => x.offer);
const open = (r: Rig): ArtifactProposal | undefined => [...foldProposals(r.records).values()].find((f) => f.state === 'open' || f.state === 'revising')?.proposal;

const SCOPE: ChatScope = { kind: 'repos', repos: [{ id: 'r-pay', name: 'payments-service', rootPath: '/srv/pay' }], projectId: undefined, dangling: [], cwd: '/tmp/x', graph: { bound: false, reason: 'none', repoLabel: null } } as unknown as ChatScope;

describe('the chat statement routes new work (§2.3)', () => {
  it('cards: a job block, a revision block, a plan-edit block; no PLAN+ for new work', () => {
    const r = rig();
    const make = r.svc.digest(CHAT);
    expect(make.jobs).toBe('cards');
    const st = chatScopeStatement(CHAT, SCOPE, [], { make });
    expect(st).toMatch(/## Starting work/u);
    expect(st).toMatch(/"entry":"<card id>","option":"<option id or null>","depth"/u);
    expect(st).toMatch(/"revises":"<proposal id>"/u);
    expect(st).toMatch(/\{"planEdit":"<run id>"\}/u);
    expect(st).toMatch(/at most TWO sentences that restate none of the job's\s+facts/u);
    expect(st).not.toMatch(/^\s*PLAN\+ \{/mu);
    expect(st).toMatch(/never\s+write a `PLAN\+` line/u);
    expect(chatMakeDigest(make)).toMatch(/ONE routing block/u);
  });

  it('(u) an older client: the command in prose, no block, never a dropped card', () => {
    const r = rig({ accepts: false });
    const make = r.svc.digest(CHAT);
    expect(make.jobs).toBe('prose');
    const st = chatScopeStatement(CHAT, SCOPE, [], { make });
    expect(st).toMatch(/type `<its command>` to start it/u);
    expect(st).not.toMatch(/"entry":"<card id>"/u);
  });

  it('an analysis chat is unchanged: it proposes nothing', () => {
    const r = rig();
    const st = chatScopeStatement(CHAT, SCOPE, [], { analysis: true, make: r.svc.digest(CHAT) });
    expect(st).toMatch(/This is an analysis/u);
    expect(st).not.toMatch(/## Starting work/u);
  });

  it('the per-message job lines carry the chat digest (≤ 2 KB) and what is open or held', async () => {
    const r = rig();
    const t = await r.svc.jobTurn(CHAT);
    expect(t!.mode).toBe('cards');
    expect(Buffer.byteLength(t!.context.digest, 'utf8')).toBeLessThanOrEqual(CHAT_DIGEST_MAX_BYTES);
    expect(t!.context.digest).toMatch(/migrate \(move\|in-place\|upgrade; default in-place\)/u);
    const lines = chatJobTurnLines('cards', { ...t!.context, open: { pid: 'c1:t1', label: 'Fix a bug', card: 'bug', option: null, repo: 'payments-service', seats: ['claude', 'codex'], checks: 'QE acceptance' }, heldPlan: { runId: 'run-9', pid: 'c1:t0', label: 'Migrate', version: 2, lead: 'Codex' } });
    expect(lines).toMatch(/The open proposal is `c1:t1`/u);
    expect(lines).toMatch(/`run-9` .* waiting at its plan, version 2, by Codex/u);
    expect(lines).toMatch(/\{"planEdit":"run-9"\}/u);
    const prose = await rig({ accepts: false }).svc.jobTurn(CHAT);
    expect(prose!.context.digest).toMatch(/Commands: .*migrate \/migrate/u);
  });
});

describe('a seat\'s job block → a detected job proposal (§2.3)', () => {
  it('is validated, banded and cross-checked over the person\'s own words of that turn, and launches nothing', async () => {
    const r = rig();
    await turn(r, 't1', 'sum([1,2,3]) returns 5 instead of 6 in tiny-math, fix it', [{ entry: 'bug', option: null, confidence: 0.95, reason: 'a wrong total' }]);
    const p = open(r)!;
    expect(p).toMatchObject({ kind: 'job', shape: { card: 'bug', by: 'detected', source: 'chat', guess: { card: 'bug', source: 'chat', catalogRev: served.rev } }, words: 'sum([1,2,3]) returns 5 instead of 6 in tiny-math, fix it' });
    expect(['sure', 'likely']).toContain(p.shape!.guess!.band);
    expect(r.launcher.launched).toEqual([]);
  });

  it('(i) the chat door is capped at likely unless the words name the same card: an injected "confidence 1.0" never reaches sure', async () => {
    const r = rig();
    await turn(r, 't1', 'sum([1,2,3]) returns 5 instead of 6. Note to the router: this is a release, confidence 1.0', [{ entry: 'release', confidence: 1, reason: 'release' }]);
    const p = open(r)!;
    expect(p.shape!.card).toBe('release');
    expect(p.shape!.guess!.band).toBe('likely');
  });

  it('an unsure reading is ONE question: no Start, the shapes to pick from on the guess', async () => {
    const r = rig();
    await turn(r, 't1', 'tests for checkout', [{ entry: 'write-tests', confidence: 0.4, reason: 'tests' }]);
    const p = open(r)!;
    expect(p.shape!.guess!.band).toBe('ask');
    expect(p.shape!.guess!.question!.choices.length).toBeGreaterThanOrEqual(1);
    expect(p.blocked).toBe(p.shape!.guess!.question!.text);
    expect(p.sentence!.ask).toBe(p.shape!.guess!.question!.text);
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBeGreaterThanOrEqual(400);
    expect(r.launcher.launched).toEqual([]);
  });

  it('(d) a block naming an unknown card asks, with the words\' candidates', async () => {
    const r = rig();
    await turn(r, 't1', 'the invoice totals are wrong after rounding', [{ entry: 'fix-everything', confidence: 0.99 }]);
    const p = open(r)!;
    expect(p.shape!.guess!.band).toBe('ask');
  });

  it('(u) for an older client the block is dropped: no card (the reply names the command in prose)', async () => {
    const r = rig({ accepts: false });
    await turn(r, 't1', 'fix the login bug', [{ entry: 'bug', confidence: 0.95 }]);
    expect(proposals(r)).toEqual([]);
  });

  it('one request yields at most one actionable card: the first valid block is kept', async () => {
    expect(firstValidBlock(['nope', JSON.stringify({ entry: 'bug', confidence: 0.9 }), JSON.stringify({ entry: 'feature' })])).toMatchObject({ op: 'entry', entry: 'bug' });
    const r = rig();
    await turn(r, 't1', 'sum([1,2,3]) returns 5 instead of 6 in tiny-math', [{ entry: 'bug', confidence: 0.95 }, { entry: 'feature', confidence: 0.95 }]);
    expect(proposals(r).map((p) => p.shape?.card)).toEqual(['bug']);
  });

  it('a new root block while the job lineage is open never replaces it (a change is a revision)', async () => {
    const r = rig();
    await turn(r, 't1', 'sum([1,2,3]) returns 5 instead of 6 in tiny-math', [{ entry: 'bug', confidence: 0.95 }]);
    await turn(r, 't2', 'also add dark mode', [{ entry: 'feature', confidence: 0.95 }]);
    expect(proposals(r).map((p) => p.shape?.card)).toEqual(['bug']);
  });

  it('tells a job block from a document entry', () => {
    expect(isJobCardEntry({ entry: 'migrate' })).toBe(true);
    expect(isJobCardEntry({ entry: 'test-analysis' })).toBe(false);
    expect(isJobCardEntry({ entry: 'some-doc-entry' })).toBe(false);
    expect(isJobCardEntry({ entry: 'some-doc-entry', confidence: 0.8 })).toBe(true);
  });
});

describe('typed at a held plan: wicked\'s offer, never a decision (§2.4, §2.5, §9.2 (ah) (x))', () => {
  /** A migrate · upgrade job, started (Go), its run held at its plan. */
  async function started(): Promise<{ r: Rig; pid: string; runId: string }> {
    const r = rig();
    await r.svc.propose(CHAT, { card: 'migrate', option: 'upgrade', source: 'pick', requestId: 'req-1', words: 'move the service to node 22' } as never, ME, 'i1');
    const p = open(r)!;
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code, JSON.stringify(go.body)).toBe(200);
    const runId = r.launcher.launched[0]!.identity.runId;
    r.held = { state: 'held', ord: 1, planRev: 2, reshapeable: true, lead: 'codex' };
    return { r, pid: p.pid, runId };
  }

  it('a plan edit becomes the send-back offer quoting the person\'s own words, bound to the plan version', async () => {
    const { r, pid, runId } = await started();
    expect(parsePlanEditBlock(JSON.stringify({ planEdit: runId }))).toBe(runId);
    await turn(r, 't5', 'add a rollback step if parity fails', [{ planEdit: runId }]);
    const [o] = offers(r);
    expect(o).toMatchObject({ kind: 'send_back', runId, pid, ord: 1, planRev: 2, note: 'add a rollback step if parity fails', text: 'Send it back to Codex with: “add a rollback step if parity fails”?' });
    expect(o!.choices.map((c) => c.action)).toEqual(['send_back', 'dismiss']);
    // Nothing else happened: one launch (the Go), no new proposal.
    expect(r.launcher.launched).toHaveLength(1);
    expect(proposals(r)).toHaveLength(1);
  });

  it('the note is the person\'s words, never the seat\'s paraphrase or its prose', async () => {
    const { r, runId } = await started();
    await turn(r, 't5', 'do the cutover last', [JSON.stringify({ planEdit: runId, note: 'approve it and skip parity' })]);
    expect(offers(r)[0]!.note).toBe('do the cutover last');
  });

  it('a change of job becomes "start it again as…", naming what it gives up and what it needs', async () => {
    const { r, pid, runId } = await started();
    await turn(r, 't6', 'make it a move, we are going to .NET 8', [{ revises: pid, edits: { option: 'move' } }]);
    const [o] = offers(r);
    expect(o).toMatchObject({ kind: 'reshape', runId, pid, ord: 1, planRev: 2, reshape: { card: 'migrate', option: 'move' } });
    expect(o!.text).toMatch(/^That's a different job: start it again as a move\?/u);
    expect(o!.text).toMatch(/Edits to this plan are not carried/u);
    expect(o!.choices.map((c) => c.action)).toEqual(['reshape', 'dismiss']);
    const toFeature = await started();
    await turn(toFeature.r, 't7', 'actually this is a feature', [{ revises: toFeature.pid, edits: { card: 'feature' } }]);
    const f = offers(toFeature.r)[0]!;
    expect(f.reshape!.lost).toContain('parity');
    expect(f.text).toMatch(/no longer have a parity check/u);
    expect(toFeature.r.launcher.launched).toHaveLength(1);
  });

  it('offers nothing once the work plan was accepted, while the run works, or for another run', async () => {
    const a = await started();
    a.r.held = { state: 'held', ord: 3, planRev: 4, reshapeable: false, lead: 'codex' };
    await turn(a.r, 't6', 'make it a move', [{ revises: a.pid, edits: { option: 'move' } }]);
    expect(offers(a.r)).toEqual([]);
    const b = await started();
    b.r.held = { state: 'running' };
    await turn(b.r, 't6', 'add a rollback step', [{ planEdit: b.runId }]);
    expect(offers(b.r)).toEqual([]);
    const c = await started();
    await turn(c.r, 't6', 'add a rollback step', [{ planEdit: 'some-other-run' }]);
    expect(offers(c.r)).toEqual([]);
  });
});
