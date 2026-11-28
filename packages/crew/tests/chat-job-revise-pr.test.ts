// crew#1840 — asked in chat to change a pull request the chat's own job delivered, the seat's routing block becomes a
// job that UPDATES that pull request (`revisesPr`, Go launches it with `revisesPr` + `deliver: "pr"`), and the card
// says so. Asked to change one crew cannot attach, the card says it updates none and where a delivered one
// is revised. Never "the existing PR" without the field behind it.
//
// Real shapes: the run record is the one the live Azure DevOps proof served for the delivering run (`GET /runs/:id`,
// run-leg2-final.json: its `deliverUrl`, `repo_ref`, `chat_id`, `delivery`), and the person's message is the one they
// typed in that chat (leg3-chat.json). The seat's block is what codex sent (entry `write-tests`).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, ProposalRevisionEdits, SessionView } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { ChatProposals, foldProposals, LaunchOnceRegistry, type ChatProposalDeps, type ProposalChat, type ProposalDispatch, type ProposalDispatcher } from '../src/api/chat-proposals.js';
import { deliveredOn, jobRevisionLaunch, prNumberOfUrl, prRevisionOf } from '../src/api/chat-jobs.js';
import { removeScratch } from './setup/scratch.js';

const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
const CHAT = 'e288a66e-5334-5255-9254-814498643270';
const RUN = '71fe752f-f17b-5978-9631-73fb3e11c7de';
const PR_URL = 'https://dev.azure.com/mikeparcewski/wicked/_git/wicked/pullrequest/1';
/** The person's message, as typed in the live proof's chat. */
const ASK = `Revise the pull request this job delivered (${PR_URL}) on the same PR: add a test in test/math.test.js that sum([0, 2, 3]) is 5 and sum([-1, 1]) is 0. Do not open a new PR.`;
/** The delivering run's record as `GET /runs/:id` served it (the fields this reads; paths and people left out). */
const DELIVERED: SessionView = {
  session: {
    id: RUN,
    status: 'completed',
    repo_ref: 'wicked',
    workflow_id: 'bug',
    run_branch: `wicked/${RUN}`,
    title: 'In the wicked repo, fix AB#1',
    channel: 'studio',
    delivery: 'delivered',
    deliver_requested: true,
    deliverUrl: PR_URL,
    chat_id: CHAT,
    from_proposal: `${CHAT}:p:d39352b77bdf63bc2104`,
  },
  units: [],
} as unknown as SessionView;

const dir = mkdtempSync(join(tmpdir(), 'chat-revise-pr-'));
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
  async find(identity: { runId: string }): Promise<boolean> { return this.launched.some((d) => d.identity.runId === identity.runId); }
  async launch(d: ProposalDispatch): Promise<void> { this.launched.push(d); }
  async live(): Promise<boolean> { return false; }
}

interface Rig { svc: ChatProposals; records: ChatTranscriptRecord[]; launcher: FakeLauncher; runsRead: number; runsFail: boolean }

function rig(runs: SessionView[], chatOf: (runId: string) => string | undefined, repo = 'wicked', more: string[] = []): Rig {
  const r: Rig = { svc: null as unknown as ChatProposals, records: [], launcher: new FakeLauncher(), runsRead: 0, runsFail: false };
  const registry = new LaunchOnceRegistry();
  registry.register('job', r.launcher);
  const chat: ProposalChat = { projectId: null, repos: [repo, ...more].map((x) => ({ id: x, name: x })), lead: 'codex', seats: ['codex', 'claude'], analysis: false };
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, instructions: true, proposals: true, create: false, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: () => [...r.records],
    append: (_c, rec) => (r.records.push(rec), true),
    instanceOf: () => 'i1',
    projectOf: () => null,
    chat: () => chat,
    rosterEligible: () => [{ key: 'codex', name: 'Codex' }, { key: 'claude', name: 'Claude Code' }],
    runs: async () => {
      r.runsRead += 1;
      if (r.runsFail) throw new Error('the run store is busy');
      return runs;
    },
    chatOfRun: chatOf,
    isAskPath: () => false,
    docsRoot: async () => null,
    projectName: async () => null,
    attachments: () => [],
    workflowSteps: async () => 4,
    runCostUsd: async () => null,
    registry,
    jobs: () => true,
    acceptsJobs: () => true,
    served: async () => served,
    qeOff: async () => false,
    preflight: async () => null,
    broadcast: () => undefined,
    audit: () => undefined,
    now: () => 1_000,
  };
  r.svc = new ChatProposals(deps);
  return r;
}

/** The person's message, then codex's reply with its routing block (`write-tests`, as in the proof). */
async function turn(r: Rig, text: string, entry = 'write-tests'): Promise<ArtifactProposal> {
  r.records.push({ at: 2, turnId: 't1', kind: 'user', text, seats: [], owner: true });
  r.svc.onReply({ chat: CHAT, cliKey: 'codex', turnId: 't1', ok: true, blocks: [JSON.stringify({ entry, option: null, depth: null, confidence: 0.99, reason: 'revise the delivered PR' })] });
  await r.svc.settled();
  const f = [...foldProposals(r.records).values()].find((x) => x.state === 'open');
  expect(f).toBeDefined();
  return f!.proposal;
}

function open(r: Rig): ArtifactProposal {
  const f = [...foldProposals(r.records).values()].find((x) => x.state === 'open');
  expect(f).toBeDefined();
  return f!.proposal;
}

/** The person's press on a card (a suggestion's edit, or any revision the studio sends). */
function press(r: Rig, p: ArtifactProposal, edits: ProposalRevisionEdits, requestId: string) {
  return r.svc.propose(CHAT, { revises: p.pid, edits, source: 'suggestion', requestId }, ME, 'i1');
}

describe('crew#1840 a chat job that changes a pull request this chat delivered', () => {
  it('the live proof\'s ask carries revisesPr for PR 1, the card says it updates it, and Go launches the revision', async () => {
    const r = rig([DELIVERED], (id) => (id === RUN ? CHAT : undefined));
    const p = await turn(r, ASK);
    expect(p.shape?.card).toBe('write-tests');
    expect(p.revisesPr).toEqual({ number: 1, url: PR_URL, runId: RUN });
    expect(p.sentence!.text).toContain('It updates pull request #1, which an earlier job of this chat delivered; no new pull request is opened.');
    expect(p.sentence!.notes.join(' ')).not.toContain("won't update");
    expect(jobRevisionLaunch(p)).toEqual({ revisesPr: 1, deliver: 'pr' });
    const go = await r.svc.decide(CHAT, p.pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(200);
    expect(r.launcher.launched).toHaveLength(1);
    expect(jobRevisionLaunch(r.launcher.launched[0]!.resolution)).toEqual({ revisesPr: 1, deliver: 'pr' });
  });

  it('asked, but the PR is not one this chat delivered: no revisesPr, and the card says it updates none and why', async () => {
    const r = rig([DELIVERED], () => 'another-chat');
    const p = await turn(r, ASK);
    expect(p.revisesPr).toBeUndefined();
    expect(jobRevisionLaunch(p)).toEqual({});
    expect(p.sentence!.text).not.toContain('updates pull request');
    expect(p.sentence!.notes).toContain(
      `This job won't update an existing pull request: ${PR_URL} is not one this chat delivered on wicked. To change a delivered pull request, use Revise this PR on the job that delivered it.`,
    );
  });

  it('naming two PRs this chat delivered (plural words) reads the chat\'s runs and asks for a choice', async () => {
    const second = { ...DELIVERED, session: { ...DELIVERED.session, id: 'r-2', deliverUrl: PR_URL.replace(/1$/, '2') } } as unknown as SessionView;
    const r = rig([DELIVERED, second], () => CHAT);
    const p = await turn(r, 'Update PRs #1 and #2 with a test that sum([0, 2, 3]) is 5');
    expect(r.runsRead).toBe(1);
    expect(p.revisesPr).toBeUndefined();
    expect(p.sentence!.notes).toContain(
      "This job won't update an existing pull request: you named more than one pull request this chat delivered on wicked. To change a delivered pull request, use Revise this PR on the job that delivered it.",
    );
  });

  it('a request that names no pull request updates none, and (crew#2001) its card still says where it delivers', async () => {
    const r = rig([DELIVERED], () => CHAT);
    const p = await turn(r, 'add a test in test/math.test.js that sum([0, 2, 3]) is 5');
    expect(r.runsRead).toBe(1);
    expect(p.revisesPr).toBeUndefined();
    expect(p.sentence!.notes.join(' ')).not.toContain('pull request');
    expect(p.sentence!.text).toContain("It doesn't change pull request #1, which this chat delivered on wicked.");
    expect(p.suggestions?.[0]).toEqual({ label: 'Update pull request #1 instead', edit: { revisesPr: 1 } });
    // A card that makes no pull request, with words that name none, reads no runs.
    const q = rig([DELIVERED], () => CHAT);
    expect((await turn(q, 'what could go wrong with the math module', 'risk')).revisesPr).toBeUndefined();
    expect(q.runsRead).toBe(0);
  });

  it('a card that makes no pull request never carries one', async () => {
    expect(resolveOption('risk', null, served)!.resolved.delivers).not.toBe('pr');
    const r = rig([DELIVERED], () => CHAT);
    const p = await turn(r, ASK, 'risk');
    expect(p.shape?.card).toBe('risk');
    expect(p.revisesPr).toBeUndefined();
  });
});

// crew#2001 — the live Azure DevOps proof's leg E (2026-11-28): in the chat whose bug fix delivered pull request 2 on
// tiny-math, the person wrote the words below. The card offered a plain bug fix with no PR line and no note, and its
// Start would have opened a second PR. The delivering run's record is the one `GET /runs/9e76663c-…` served (its
// `deliverUrl`, `repo_ref`, `chat_id`, `delivery`); the person's words are theirs, verbatim; codex's block chose `bug`.
const LEG_E_CHAT = '23884eeb-3183-5865-88a7-3bf30e1bba04';
const LEG_E_RUN = '9e76663c-3118-5800-a712-8f1d62393cc4';
const LEG_E_PR = 'https://dev.azure.com/mikeparcewski/wicked/_git/tiny-math/pullrequest/2';
const LEG_E_ASK = 'change the PR you delivered for tiny-math to also cover sum([])';
const LEG_E_DELIVERED: SessionView = {
  session: {
    id: LEG_E_RUN,
    status: 'completed',
    repo_ref: 'tiny-math',
    workflow_id: 'bug',
    run_branch: `wicked/${LEG_E_RUN}`,
    title: 'In tiny-math, fix AB#2',
    channel: 'studio',
    delivery: 'delivered',
    deliver_requested: true,
    deliverUrl: LEG_E_PR,
    chat_id: LEG_E_CHAT,
    from_proposal: `${LEG_E_CHAT}:p:3415ffef47caf1cd6e7c`,
  },
  units: [],
} as unknown as SessionView;

describe('crew#2001 a chat job in a chat that delivered a PR says where it delivers, and one click changes it', () => {
  it('the leg-E words: the card says PR #2 is not changed and offers "Update pull request #2 instead"', async () => {
    const r = rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math');
    const p = await turn(r, LEG_E_ASK, 'bug');
    expect(p.shape?.card).toBe('bug');
    expect(p.revisesPr).toBeUndefined();
    // (R-B) No promise of a new pull request without a press: the daemon's delivery default decides that.
    expect(p.sentence!.text).toContain("It doesn't change pull request #2, which this chat delivered on tiny-math.");
    expect(p.sentence!.text).not.toContain('opens a new pull request');
    expect(p.suggestions?.[0]).toEqual({ label: 'Update pull request #2 instead', edit: { revisesPr: 2 } });
  });

  it('the press attaches PR #2, Go launches the revision of it; "Open a new pull request instead" detaches it and stays', async () => {
    const r = rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math');
    const p = await turn(r, LEG_E_ASK, 'bug');
    expect((await press(r, p, p.suggestions![0]!.edit, 'press-1')).code).toBe(201);
    const q = open(r);
    expect(q.revisesPr).toEqual({ number: 2, url: LEG_E_PR, runId: LEG_E_RUN });
    expect(q.sentence!.text).toContain('It updates pull request #2, which an earlier job of this chat delivered; no new pull request is opened.');
    expect(q.suggestions?.[0]).toEqual({ label: 'Open a new pull request instead', edit: { revisesPr: null } });
    expect(jobRevisionLaunch(q)).toEqual({ revisesPr: 2, deliver: 'pr' });
    // Back to a new pull request, and a later revision of something else keeps that pick.
    expect((await press(r, q, q.suggestions![0]!.edit, 'press-2')).code).toBe(201);
    const n = open(r);
    expect(n.revisesPr).toBeUndefined();
    expect(n.sentence!.text).toContain('It opens a new pull request; pull request #2, which this chat delivered on tiny-math, is not changed.');
    expect(jobRevisionLaunch(n, true)).toEqual({ deliver: 'pr' });
    expect((await press(r, n, { depth: 'deep' }, 'press-3')).code).toBe(201);
    expect(open(r).revisesPr).toBeUndefined();
    // Go on the attached version launched the revision: re-attach and start.
    const a = open(r);
    expect((await press(r, a, a.suggestions![0]!.edit, 'press-4')).code).toBe(201);
    const go = await r.svc.decide(CHAT, open(r).pid, { decision: 'go' }, ME, 'i1');
    expect(go.code).toBe(200);
    expect(jobRevisionLaunch(r.launcher.launched[0]!.resolution)).toEqual({ revisesPr: 2, deliver: 'pr' });
  });

  it('words that attach a PR (crew#1840) get "Open a new pull request instead", and the press wins over the words', async () => {
    const r = rig([DELIVERED], (id) => (id === RUN ? CHAT : undefined));
    const p = await turn(r, ASK);
    expect(p.revisesPr?.number).toBe(1);
    expect(p.suggestions?.[0]).toEqual({ label: 'Open a new pull request instead', edit: { revisesPr: null } });
    await press(r, p, { revisesPr: null }, 'press-1');
    expect(open(r).revisesPr).toBeUndefined();
    expect(jobRevisionLaunch(open(r))).toEqual({});
  });

  it('never trusts the number: a PR this chat did not deliver is refused with a plain note, from the person or a seat', async () => {
    const r = rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math');
    const p = await turn(r, LEG_E_ASK, 'bug');
    const res = await press(r, p, { revisesPr: 7 }, 'press-1');
    expect(JSON.stringify(res.body)).toContain('Not changed: pull request #7 is not one this chat delivered on tiny-math');
    expect(open(r).revisesPr).toBeUndefined();
    // Another chat's PR with the same repository: not this chat's, so refused too.
    const other = rig([LEG_E_DELIVERED], () => 'another-chat', 'tiny-math');
    const o = await turn(other, LEG_E_ASK, 'bug');
    expect(o.suggestions?.some((s) => 'revisesPr' in s.edit)).toBe(false);
    await press(other, o, { revisesPr: 2 }, 'press-1');
    expect(open(other).revisesPr).toBeUndefined();
  });

  it('a seat\'s revision block naming a PR goes through the same check', async () => {
    const r = rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math');
    const seatRevises = async (turnId: string, edits: ProposalRevisionEdits): Promise<ArtifactProposal> => {
      const before = open(r).pid;
      r.records.push({ at: 3, turnId, kind: 'user', text: 'use the PR', seats: [], owner: true });
      await r.svc.holdForMessage(CHAT, turnId);
      r.svc.onReply({ chat: CHAT, cliKey: 'codex', turnId, ok: true, blocks: [JSON.stringify({ revises: before, edits })] });
      await r.svc.settled();
      expect(open(r).pid).not.toBe(before);
      return open(r);
    };
    await turn(r, LEG_E_ASK, 'bug');
    const bad = await seatRevises('t2', { revisesPr: 9 });
    expect(bad.revisesPr).toBeUndefined();
    expect(bad.sentence!.notes).toContain('Not changed: pull request #9 is not one this chat delivered on tiny-math');
    expect((await seatRevises('t3', { revisesPr: 2 })).revisesPr?.number).toBe(2);
  });

  it('runs that cannot be read: the pick is refused and says so; a repository swap drops a pick', async () => {
    const r = rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math', ['wicked']);
    const p = await turn(r, LEG_E_ASK, 'bug');
    r.runsFail = true;
    const res = await press(r, p, { revisesPr: 2 }, 'press-1');
    expect(JSON.stringify(res.body)).toContain("Not changed: this chat's delivered pull requests could not be read, so this job can't update pull request #2");
    expect(open(r).revisesPr).toBeUndefined();
    r.runsFail = false;
    await press(r, open(r), { revisesPr: 2 }, 'press-2');
    expect(open(r).revisesPr?.number).toBe(2);
    await press(r, open(r), { repoRef: 'wicked' }, 'press-3');
    expect(open(r).revisesPr).toBeUndefined();
    expect(open(r).repoRefs).toEqual(['wicked']);
  });
});

describe('crew#2001 review round 1: the pick holds, is checked once per change, and says when it can\'t be', () => {
  const tiny = (): Rig => rig([LEG_E_DELIVERED], (id) => (id === LEG_E_RUN ? CHAT : undefined), 'tiny-math');
  const detail = (r: Rig, add: string, id: string) => press(r, open(r), { detail: { add: [add] } }, id);

  it('words with no PR in them: the card offers PR #2; the pick holds across another revision; "new" launches a PR', async () => {
    const r = tiny();
    const p = await turn(r, 'also cover sum([]) in tiny-math', 'bug');
    expect(p.sentence!.text).toContain("It doesn't change pull request #2, which this chat delivered on tiny-math.");
    expect(p.suggestions?.[0]).toEqual({ label: 'Update pull request #2 instead', edit: { revisesPr: 2 } });
    await press(r, p, { revisesPr: 2 }, 'press-1');
    const a = open(r);
    expect(a.revisesPr?.number).toBe(2);
    expect(await detail(r, 'cover sum([1])', 'press-2')).toMatchObject({ code: 201 });
    expect(open(r).pid).not.toBe(a.pid);
    expect(open(r)).toMatchObject({ prChoice: 2, revisesPr: { number: 2, url: LEG_E_PR, runId: LEG_E_RUN } });
    await press(r, open(r), { revisesPr: null }, 'press-3');
    await detail(r, 'cover sum([2])', 'press-4');
    const n = open(r);
    expect(n.prChoice).toBe('new');
    expect(n.revisesPr).toBeUndefined();
    // Go on a new pull request launches with deliver: pr, whatever the daemon's delivery default.
    expect(jobRevisionLaunch(n, true)).toEqual({ deliver: 'pr' });
    expect(jobRevisionLaunch(n, false)).toEqual({});
    expect(jobRevisionLaunch({ ...n, relaunch: { deliver: 'none' } }, true)).toEqual({});
  });

  it('runs that can\'t be read keep a stored pick and hold Start until they can; then the pick is back', async () => {
    const r = tiny();
    const p = await turn(r, 'also cover sum([]) in tiny-math', 'bug');
    await press(r, p, { revisesPr: 2 }, 'press-1');
    r.runsFail = true;
    await detail(r, 'cover sum([1])', 'press-2');
    const held = open(r);
    expect(held.prChoice).toBe(2);
    expect(held.revisesPr).toBeUndefined();
    expect(held.blocked).toBe("This job is to update pull request #2, but this chat's delivered pull requests could not be read to check it: try again");
    expect(held.suggestions?.some((s) => 'revisesPr' in s.edit)).toBe(false);
    expect((await r.svc.decide(CHAT, held.pid, { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'proposal_blocked' });
    expect(r.launcher.launched).toHaveLength(0);
    r.runsFail = false;
    await detail(r, 'cover sum([2])', 'press-3');
    expect(open(r)).toMatchObject({ prChoice: 2, revisesPr: { number: 2 }, blocked: null });
  });

  it('a revision reads the chat\'s runs once for its check and its card', async () => {
    const r = tiny();
    const p = await turn(r, 'also cover sum([]) in tiny-math', 'bug');
    const reads = r.runsRead;
    await press(r, p, { revisesPr: 2 }, 'press-1');
    expect(r.runsRead - reads).toBe(1);
    expect(open(r).revisesPr?.number).toBe(2);
  });

  it('a pass through a report card keeps the pick on the same repository', async () => {
    const r = rig([DELIVERED], (id) => (id === RUN ? CHAT : undefined));
    const p = await turn(r, ASK);
    expect(p.revisesPr?.number).toBe(1);
    await press(r, p, { revisesPr: null }, 'press-1');
    // A change of card that drops a check asks first; the person's press on that question applies it.
    const move = async (card: string, id: string) => {
      await press(r, open(r), { card }, id);
      const q = open(r).question;
      if (q?.kind === 'lost_check') await press(r, open(r), q.choices[0]!.edit, `${id}-ok`);
    };
    await move('plan-it', 'press-2');
    expect(open(r)).toMatchObject({ shape: { card: 'plan-it' }, prChoice: 'new' });
    await move('write-tests', 'press-3');
    expect(open(r).shape?.card).toBe('write-tests');
    expect(open(r).prChoice).toBe('new');
    expect(open(r).revisesPr).toBeUndefined();
  });

  it('words naming a PR when the runs can\'t be read: the note says they could not be read', async () => {
    const r = rig([DELIVERED], (id) => (id === RUN ? CHAT : undefined));
    r.runsFail = true;
    const p = await turn(r, ASK);
    expect(p.revisesPr).toBeUndefined();
    expect(p.sentence!.notes).toContain(
      "This job won't update an existing pull request: this chat's delivered pull requests could not be read. To change a delivered pull request, use Revise this PR on the job that delivered it.",
    );
  });

  it('deliveredOn: one per number (its latest delivery), the most recently delivered last', () => {
    const d = (number: number, runId: string, url = `https://github.com/o/r/pull/${number}`) => ({ number, url, runId, repoRef: 'r' });
    expect(deliveredOn([d(10, 'a'), d(8, 'b')], 'r').map((x) => x.number)).toEqual([10, 8]);
    expect(deliveredOn([d(8, 'a'), d(10, 'b'), d(8, 'c', 'https://github.com/O/R/pull/8')], 'r').map((x) => [x.number, x.runId])).toEqual([[10, 'b'], [8, 'c']]);
    expect(deliveredOn([d(8, 'a'), { ...d(9, 'b'), repoRef: 'other' }], 'r').map((x) => x.number)).toEqual([8]);
  });
});

describe('prRevisionOf', () => {
  const gh = { number: 4, url: 'https://github.com/o/tiny-math/pull/4', runId: 'r1', repoRef: 'tiny' };
  const gh5 = { ...gh, number: 5, url: 'https://github.com/o/tiny-math/pull/5', runId: 'r2' };
  it('picks the delivered PR by URL, by number, or the only one; refuses another repository\'s', () => {
    expect(prRevisionOf('Revise https://github.com/o/tiny-math/pull/4.', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Update PR #4 with a test', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('add a test on the same PR', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Update PR #5 with a test', [gh], 'tiny')).toEqual({ pr: null, named: 'pull request #5', miss: 'not-delivered' });
    expect(prRevisionOf('add a test on the same PR', [gh], 'other')).toEqual({ pr: null, named: null, miss: 'none' });
    expect(prRevisionOf('add a test on the same PR', [gh, gh5], 'tiny')).toEqual({ pr: null, named: null, miss: 'none' });
    // Words that do not ask to change a pull request.
    expect(prRevisionOf('fix the bug PR #4 described', [gh], 'tiny')).toBeNull();
  });
  it('words that ask for a new pull request, or say not to change one, attach none; a negated new-PR ask is a revision', () => {
    expect(prRevisionOf('Update README and open a new PR', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Do not update PR #4; open a new PR', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Revise the parser in a separate pull request', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Add the test. Do not open a new PR.', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Update the same PR, without opening a new PR', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    // A negative contraction is a negation; a plain "open a PR" is a new one; a negated "add … to PR" changes none.
    expect(prRevisionOf("Add the test on the same PR; don't open a new PR", [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf("Add the test on the same PR, don’t open a PR", [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Update README and open a PR', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Fix it and create a pull request', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Open pull requests for these changes', [gh], 'tiny')).toBeNull();
    // A negation binds within its clause: an unrelated "don't add dependencies" leaves "update PR #4" a revision.
    expect(prRevisionOf("Don't add dependencies; update PR #4 with the fix.", [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf("Don't add tests to PR #4; just reproduce the failure locally", [gh], 'tiny')).toBeNull();
    expect(prRevisionOf('Never commit to PR #4', [gh], 'tiny')).toBeNull();
    expect(prRevisionOf("Don't apply the patch to the PR", [gh], 'tiny')).toBeNull();
    // "the open PR" is the delivered one, not a request to open one.
    expect(prRevisionOf('Push the fix to the open PR', [gh], 'tiny')).toEqual({ pr: gh, named: null });
  });
  it('reads "add … to PR #N" and "… on PR #N" as revisions', () => {
    expect(prRevisionOf('Add regression tests to PR #4', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Address the review comments on PR #4', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Push the fix onto pull request 4', [gh], 'tiny')).toEqual({ pr: gh, named: null });
  });
  it('a named URL is a target even with a tab, query or fragment after it, and never falls back to another PR', () => {
    expect(prRevisionOf('Revise https://github.com/o/tiny-math/pull/4/files?w=1', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Revise https://github.com/o/tiny-math/pull/4#discussion_r1', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Revise https://github.com/other/repo/pull/99/files', [gh], 'tiny')).toEqual({ pr: null, named: 'https://github.com/other/repo/pull/99', miss: 'not-delivered' });
    expect(prRevisionOf('Revise https://github.com/o/tiny-math/pull/41', [gh], 'tiny')).toEqual({ pr: null, named: 'https://github.com/o/tiny-math/pull/41', miss: 'not-delivered' });
  });
  it('every named PR is a target: two delivered ones is a choice to make, one undelivered among them refuses', () => {
    expect(prRevisionOf('Update PR #4 using https://github.com/o/tiny-math/pull/5 as a reference', [gh, gh5], 'tiny')).toEqual({ pr: null, named: null, miss: 'several' });
    expect(prRevisionOf('Update PR #4 like PR #9', [gh, gh5], 'tiny')).toEqual({ pr: null, named: 'pull request #9', miss: 'not-delivered' });
    expect(prRevisionOf('Update PR #4 and #9', [gh], 'tiny')).toEqual({ pr: null, named: 'pull request #9', miss: 'not-delivered' });
    expect(prRevisionOf('Update PRs #4, #5', [gh, gh5], 'tiny')).toEqual({ pr: null, named: null, miss: 'several' });
    expect(prRevisionOf('Update PR o/tiny-math#9', [gh], 'tiny')).toEqual({ pr: null, named: 'o/tiny-math#9', miss: 'not-delivered' });
    expect(prRevisionOf('Update PR other/repo#4', [gh], 'tiny')).toEqual({ pr: null, named: 'other/repo#4', miss: 'not-delivered' });
    expect(prRevisionOf('Update PR o/tiny-math#4', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    expect(prRevisionOf('Update pull requests 4 and 5', [gh, gh5], 'tiny')).toEqual({ pr: null, named: null, miss: 'several' });
    expect(prRevisionOf('Update pull requests 4 and 9', [gh], 'tiny')).toEqual({ pr: null, named: 'pull request #9', miss: 'not-delivered' });
    // A count after a PR is not another PR.
    expect(prRevisionOf('Update PR #4 and 5 more tests', [gh], 'tiny')).toEqual({ pr: gh, named: null });
    // The same PR by URL and by number is one target.
    expect(prRevisionOf('Update PR #5 (https://github.com/o/tiny-math/pull/5)', [gh, gh5], 'tiny')).toEqual({ pr: gh5, named: null });
  });
  it('reads the PR number of both URL shapes crew records', () => {
    expect(prNumberOfUrl(PR_URL)).toBe(1);
    expect(prNumberOfUrl('https://github.com/o/r/pull/12')).toBe(12);
    expect(prNumberOfUrl('https://github.com/o/r/pull/12?x=1')).toBeNull();
  });
});
