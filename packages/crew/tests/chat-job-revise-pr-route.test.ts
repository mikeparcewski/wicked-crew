// crew#1840, through the real routes: a chat job asked to change the pull request an earlier job of the same chat
// delivered launches as a REVISION. The chat's runs are the daemon's own: the delivering run's chat and its PR URL come
// from the audit trail the daemon replays at boot (`run.launched` `detail.chatId`, `run.delivered` `detail.url`, written
// here with the product's own AuditLog), and Go goes through the production job launcher to the engine's `launchRun`.
// Only GitHub/Azure DevOps is stubbed: the PR's head branch answers from `resolvePullRequest`.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { AuditLog } from '../src/api/audit.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, CoreEvent, LaunchRunInput, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const CHAT = 'e288a66e-5334-5255-9254-814498643270';
const RUN = '71fe752f-f17b-5978-9631-73fb3e11c7de';
const PR_URL = 'https://dev.azure.com/mikeparcewski/wicked/_git/wicked/pullrequest/1';
const HEAD = 'wicked/71fe752f-f17b-5978-9631-73fb3e11c7de';
/** The person's message, as typed in the live proof's chat. */
const ASK = `Revise the pull request this job delivered (${PR_URL}) on the same PR: add a test in test/math.test.js that sum([0, 2, 3]) is 5 and sum([-1, 1]) is 0. Do not open a new PR.`;

const resolved: Array<{ root: string; number: number }> = [];
/** The URL the provider answers for the pull request (a repository id re-pointed since answers another). */
let resolvedUrl = PR_URL;
/** The daemon's delivery default (an operator may set `none`). */
let deliverDefault: 'pr' | 'none' = 'pr';
vi.mock('../src/core/deliver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/deliver.js')>();
  return {
    ...real,
    resolvePullRequest: async (root: string, number: number) => {
      resolved.push({ root, number });
      return { ok: true, pr: { number, headRef: HEAD, url: resolvedUrl, state: 'OPEN' } };
    },
  };
});

const armedStateHome = crewStateHome();

describe('crew#1840 Go on a chat job that revises the PR this chat delivered launches the revision', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const listeners: Array<(e: CoreEvent) => void> = [];
  /** The delivering run's engine record: no `deliverUrl` or `chat_id` (the daemon adds them from its trail). */
  const delivered = (): SessionView => ({
    session: { id: RUN, status: 'completed', repo_ref: 'wicked', workflow_id: 'bug', run_branch: HEAD, title: 'In the wicked repo, fix AB#1', channel: 'studio', deliver_requested: true },
    units: [],
  }) as unknown as SessionView;

  const adapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({ deliverDefault }),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (fn: (e: CoreEvent) => void): (() => void) => {
      listeners.push(fn);
      return () => undefined;
    },
    listRepos: async () => [{ id: 'wicked', name: 'wicked', root_path: join(scratch, 'repo-wicked'), default_branch: 'main', registered_at: 1 }],
    projectGet: async () => null,
    projectList: async () => [],
    projectMembers: async () => [],
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      return input.sessionId ?? `run-${launches.length}`;
    },
    sessions: async () => [RUN],
    sessionsDetail: async () => [delivered()],
    runEvents: async () => [],
    engineCapabilities: () => ({ deliverGate: true, revisesPr: true }),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    workflowCatalog: async () => ({ workflows: BUILTIN_WORKFLOWS, unavailable: [] }),
    getWorkflow: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id),
    catalog: async () => [],
    listPresets: async () => [{ name: 'bug', scope: 'global', steps: [{ id: 'fix' }], created_by: 'builtin', updated_at: 1 }],
    supportsPowerMode: () => false,
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    vi.spyOn(CoreAdapter, 'judgeCoverage').mockReturnValue(JSON.stringify({ covered: true, singleIdentity: false, authors: [], benched: [] }));
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-revise-pr-route-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-wicked'));
    setCrewStateHome(home);
    // The delivering run's trail, as the daemon wrote it when the earlier job launched from this chat and delivered.
    const trail = new AuditLog(join(scratch, 'audit.log'));
    const person: Actor = { id: 'maria', kind: 'human', trust: 'operator' };
    trail.record('run.launched', person, { runId: RUN, detail: { chatId: CHAT, workflow: 'bug', repoRef: 'wicked' } });
    trail.record('run.delivered', person, { runId: RUN, detail: { url: PR_URL, via: 'deliver-phase' } });
    await trail.flush();
    app = await createServer(adapter(), {
      seats: { signedIn: () => true },
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
    });
    await app.ready();
  }, 150_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  it('the card carries revisesPr from the daemon\'s own record, and Go hands the engine revisesPr, deliver: pr and the PR branch', async () => {
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: CHAT, clis: ['claude', 'codex'], repoRefs: ['wicked'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/messages`, payload: { text: ASK } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: CHAT, cliKey: 'claude', text: 'I can add that test.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r1', words: ASK } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.blocked, JSON.stringify(p)).toBeNull();
    expect(p.revisesPr).toEqual({ number: 1, url: PR_URL, runId: RUN });

    const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals/${encodeURIComponent(p.pid)}`, payload: { decision: 'go' } });
    expect(go.statusCode, go.body).toBe(200);
    // (The chat's own session launches when it opens; the job is the one launch with a workflow.)
    const jobs = (): LaunchRunInput[] => launches.filter((l) => l.workflow !== undefined);
    for (let i = 0; i < 100 && jobs().length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(jobs()).toHaveLength(1);
    const launched = jobs()[0]!;
    expect(launched.workflow).toBe('bug');
    expect(resolved).toEqual([{ root: join(scratch, 'repo-wicked'), number: 1 }]);
    expect(launched.revisesPr).toEqual({ number: 1, headRef: HEAD, url: PR_URL });
    expect(launched.baseRef).toBe(HEAD);
    expect(launched.deliver).toBe('pr');
  });

  it('crew#2001: the route takes a revision naming where the job delivers, and checks its number against the chat\'s runs', async () => {
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r2001', words: ASK } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.revisesPr?.number).toBe(1);
    const revise = (revises: string, revisesPr: unknown, requestId: string) =>
      app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { revises, edits: { revisesPr }, source: 'suggestion', requestId } });
    expect((await revise(p.pid, 'two', 'r2001-bad')).statusCode).toBe(400);
    expect((await revise(p.pid, 0, 'r2001-zero')).statusCode).toBe(400);
    // A number this chat's runs did not deliver changes nothing, and says so.
    const refused = await revise(p.pid, 99, 'r2001-99');
    expect(refused.statusCode, refused.body).toBe(201);
    const q = (refused.json() as { view: ChatProposalView }).view.proposal;
    expect(q.revisesPr?.number).toBe(1);
    expect(q.sentence!.notes).toContain('Not changed: pull request #99 is not one this chat delivered on wicked');
    // null: a new pull request, whatever the words said.
    const fresh = await revise(q.pid, null, 'r2001-new');
    expect(fresh.statusCode, fresh.body).toBe(201);
    const n = (fresh.json() as { view: ChatProposalView }).view.proposal;
    expect(n.revisesPr).toBeUndefined();
    expect(n.suggestions?.[0]).toEqual({ label: 'Update pull request #1 instead', edit: { revisesPr: 1 } });
    // Go on "a new pull request" launches one: deliver pr, no revision.
    const before = launches.length;
    const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals/${encodeURIComponent(n.pid)}`, payload: { decision: 'go' } });
    expect(go.statusCode, go.body).toBe(200);
    for (let i = 0; i < 100 && launches.length === before; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(launches.length).toBe(before + 1);
    expect(launches.at(-1)!.deliver).toBe('pr');
    expect(launches.at(-1)!.revisesPr).toBeUndefined();
  });

  it('crew#2001 (R-B): with deliverDefault none the card promises no new pull request; "a new pull request" Go delivers one', async () => {
    deliverDefault = 'none';
    try {
      const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r2001-none', words: 'add a test that sum([]) is 0' } });
      expect(made.statusCode, made.body).toBe(201);
      const p = (made.json() as { view: ChatProposalView }).view.proposal;
      expect(p.revisesPr).toBeUndefined();
      expect(p.sentence!.text).toContain("It doesn't change pull request #1, which this chat delivered on wicked.");
      expect(p.sentence!.text).not.toContain('opens a new pull request');
      const fresh = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { revises: p.pid, edits: { revisesPr: null }, source: 'suggestion', requestId: 'r2001-none-new' } });
      const n = (fresh.json() as { view: ChatProposalView }).view.proposal;
      expect(n.sentence!.text).toContain('It opens a new pull request; pull request #1, which this chat delivered on wicked, is not changed.');
      const before = launches.length;
      const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals/${encodeURIComponent(n.pid)}`, payload: { decision: 'go' } });
      expect(go.statusCode, go.body).toBe(200);
      for (let i = 0; i < 100 && launches.length === before; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(launches.at(-1)!.deliver).toBe('pr');
    } finally {
      deliverDefault = 'pr';
    }
  });

  it('crew#2001 (codex r1): the same number now resolving to another pull request (the repository id re-pointed) is refused at Go', async () => {
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r2001-moved', words: ASK } });
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.revisesPr?.url).toBe(PR_URL);
    resolvedUrl = 'https://github.com/someone/else/pull/1';
    try {
      const before = launches.length;
      const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${CHAT}/proposals/${encodeURIComponent(p.pid)}`, payload: { decision: 'go' } });
      for (let i = 0; i < 25; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(launches.length).toBe(before);
      expect(go.body + JSON.stringify((await app.inject({ method: 'GET', url: `/api/v1/chats/${CHAT}/proposals` })).json())).toContain('which this chat delivered: it is not updated');
    } finally {
      resolvedUrl = PR_URL;
    }
  });
});
