// crew#1840 — asked in chat to change a pull request the chat's own job delivered, the seat's routing block becomes a
// job that UPDATES that pull request (`revisesPr`, Go launches it with `revisesPr` + `deliver: "pr"`), and the card
// says so. Asked to change one crew cannot attach, the card says it opens a new pull request and where a delivered one
// is revised. Never "the existing PR" without the field behind it.
//
// Real shapes: the run record is the one the live Azure DevOps proof served for the delivering run (`GET /runs/:id`,
// run-leg2-final.json: its `deliverUrl`, `repo_ref`, `chat_id`, `delivery`), and the person's message is the one they
// typed in that chat (leg3-chat.json). The seat's block is what codex sent (entry `write-tests`).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, ChatTranscriptRecord, SessionView } from '../src/core/types.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { ChatProposals, foldProposals, LaunchOnceRegistry, type ChatProposalDeps, type ProposalChat, type ProposalDispatch, type ProposalDispatcher } from '../src/api/chat-proposals.js';
import { jobRevisionLaunch, prNumberOfUrl, prRevisionOf } from '../src/api/chat-jobs.js';
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

interface Rig { svc: ChatProposals; records: ChatTranscriptRecord[]; launcher: FakeLauncher; runsRead: number }

function rig(runs: SessionView[], chatOf: (runId: string) => string | undefined): Rig {
  const r: Rig = { svc: null as unknown as ChatProposals, records: [], launcher: new FakeLauncher(), runsRead: 0 };
  const registry = new LaunchOnceRegistry();
  registry.register('job', r.launcher);
  const chat: ProposalChat = { projectId: null, repos: [{ id: 'wicked', name: 'wicked' }], lead: 'codex', seats: ['codex', 'claude'], analysis: false };
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, instructions: true, proposals: true, create: false, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: () => [...r.records],
    append: (_c, rec) => (r.records.push(rec), true),
    instanceOf: () => 'i1',
    projectOf: () => null,
    chat: () => chat,
    rosterEligible: () => [{ key: 'codex', name: 'Codex' }, { key: 'claude', name: 'Claude Code' }],
    runs: async () => (r.runsRead += 1, runs),
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

  it('a request that names no pull request reads no runs and changes nothing', async () => {
    const r = rig([DELIVERED], () => CHAT);
    const p = await turn(r, 'add a test in test/math.test.js that sum([0, 2, 3]) is 5');
    expect(r.runsRead).toBe(0);
    expect(p.revisesPr).toBeUndefined();
    expect(p.sentence!.notes.join(' ')).not.toContain('pull request');
  });

  it('a card that makes no pull request never carries one', async () => {
    expect(resolveOption('risk', null, served)!.resolved.delivers).not.toBe('pr');
    const r = rig([DELIVERED], () => CHAT);
    const p = await turn(r, ASK, 'risk');
    expect(p.shape?.card).toBe('risk');
    expect(p.revisesPr).toBeUndefined();
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
