// A read redraws a seat-held job after sign-in, without another answer turn (crew#1484).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessagesResponse, ChatProposalView, ChatTranscriptRecord } from 'wicked-crew-api-types';

import { foldProposals } from '../src/api/chat-proposals.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, RosterSeat } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
const NEEDS_TWO = 'Needs 2 seats that can work now, one to build it and one to check it, and only 1 can. Sign in another seat to start it.';

describe('held job seats rechecked by the real GET routes (crew#1484)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  let codexSignedIn = false;
  const launches: LaunchRunInput[] = [];
  const continuations: string[] = [];
  const listeners: Array<(e: CoreEvent) => void> = [];

  const adapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (fn: (e: CoreEvent) => void): (() => void) => {
      listeners.push(fn);
      return () => undefined;
    },
    listRepos: async () => [{ id: 'r-crew', name: 'wicked-crew', root_path: join(scratch, 'repo-crew'), default_branch: 'main', registered_at: 1 }],
    projectGet: async () => null,
    projectList: async () => [],
    projectMembers: async () => [],
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      return input.sessionId!;
    },
    proposePlan: async (runId: string) => { continuations.push(runId); return { ok: true }; },
    sessions: async () => launches.map((input) => input.sessionId!),
    sessionsDetail: async () => [],
    runEvents: async () => [],
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
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-held-seats-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(scratch, 'settings.json');
    const roster = CoreAdapter.roster() as RosterSeat[];
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue(roster.map((s) => s.key === 'claude' ? { ...s, display_name: 'Claude' } : s));
    app = await createServer(adapter(), {
      seats: { signedIn: (key: string) => key === 'claude' || (key === 'codex' && codexSignedIn) },
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
    await app.close();
    vi.restoreAllMocks();
    setCrewStateHome(armedStateHome);
    if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
    removeScratch(scratch);
  });

  it.each(['messages', 'detail'])('%s read releases a seat hold without dispatching a chat message or changing its title', async (route) => {
    codexSignedIn = false;
    const chatId = `held-seats-${route}`;
    const url = `/api/v1/chats/${chatId}`;
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude'], repoRefs: ['r-crew'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `${url}/messages`, payload: { text: 'the login page 500s' } });
    expect(sent.statusCode, sent.body).toBe(202);
    const { runId, turnId } = sent.json() as { runId: string; turnId: string };
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: 'claude', turnId, text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
    const made = await app.inject({ method: 'POST', url: `${url}/proposals`, payload: { card: 'bug', source: 'pick', requestId: route, words: 'the login page 500s' } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.blocked).toBe(NEEDS_TWO);
    expect(p.seats?.keys).toEqual(['claude']);
    const before = (await app.inject({ method: 'GET', url: `${url}/messages` })).json() as ChatMessagesResponse;
    expect(before.chat.title).toBe('the login page 500s');
    // Chat sends reach the adapter as an initial answer launch or a continuation plan.
    const chatSends = () => launches.filter((input) => input.sessionId === runId).length + continuations.filter((id) => id === runId).length;
    expect(chatSends()).toBe(1);
    const sendsBefore = chatSends();
    const launchesBefore = launches.length;

    codexSignedIn = true;
    const read = await app.inject({ method: 'GET', url: route === 'messages' ? `${url}/messages` : url });
    expect(read.statusCode, read.body).toBe(200);
    const records = (read.json() as { messages: ChatTranscriptRecord[] }).messages;
    const refreshed = foldProposals(records).get(p.pid)!;
    expect(refreshed.state).toBe('open');
    expect(refreshed.proposal.blocked).toBeNull();
    expect(refreshed.proposal.seats?.keys).toEqual(['claude', 'codex']);
    expect(refreshed.proposal.seats?.label).toBe('Claude and Codex');
    expect(records.filter((rec) => rec.kind === 'proposal')).toHaveLength(before.messages.filter((rec) => rec.kind === 'proposal').length + 1);
    expect(chatSends()).toBe(sendsBefore);
    expect(launches).toHaveLength(launchesBefore);
    const after = (await app.inject({ method: 'GET', url: `${url}/messages` })).json() as ChatMessagesResponse;
    expect(after.chat.title).toBe(before.chat.title);
    expect(after.messages.filter((rec) => rec.kind === 'user')).toEqual(before.messages.filter((rec) => rec.kind === 'user'));
    expect(after.messages).toHaveLength(records.length);
    expect(chatSends()).toBe(sendsBefore);
  });
});
