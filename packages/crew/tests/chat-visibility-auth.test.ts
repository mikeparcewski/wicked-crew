// crew#1669: hidden chats are refused before reads, sends, re-seats or held-seat rechecks.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalFrame, ChatProposalView, ChatTranscriptRecord } from 'wicked-crew-api-types';

import { foldProposals } from '../src/api/chat-proposals.js';
import { tokenHash } from '../src/api/auth.js';
import * as eventBus from '../src/events/bus.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, RosterSeat } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
const NEEDS_TWO = 'Needs 2 seats that can work now, one to build it and one to check it, and only 1 can. Sign in another seat to start it.';

describe('chat visibility under auth: required (crew#1669)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  let local: FastifyInstance;
  let codexSignedIn = false;
  const broadcast = vi.spyOn(eventBus, 'broadcast');
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
    confirmGate: async () => 'awaiting_human',
    runView: async (id: string) => ({ session: { id, status: 'awaiting_human', extra_write_roots: [] }, units: [] }),
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
    scratch = mkdtempSync(join(tmpdir(), 'chat-visibility-auth-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(scratch, 'settings.json');
    const roster = CoreAdapter.roster() as RosterSeat[];
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue(roster.map((s) => s.key === 'claude' ? { ...s, display_name: 'Claude' } : s));
    const tokensPath = join(scratch, 'tokens.json');
    writeFileSync(tokensPath, JSON.stringify({ tokens: [
      { sha256: tokenHash('owner-token'), actor: { id: 'maria', kind: 'human', trust: 'operator' } },
      { sha256: tokenHash('agent-token'), actor: { id: 'agent', kind: 'agent', trust: 'operator' } },
      { sha256: tokenHash('system-token'), actor: { id: 'system', kind: 'system', trust: 'operator' } },
      { sha256: tokenHash('plugin-token'), actor: { id: 'plugin:test@1.0.0', kind: 'plugin', trust: 'observer' } },
      { sha256: tokenHash('observer-token'), actor: { id: 'watcher', kind: 'human', trust: 'observer' } },
      { sha256: tokenHash('other-token'), actor: { id: 'sam', kind: 'human', trust: 'operator' } },
    ] }));
    const opts = {
      seats: { signedIn: (key: string) => key === 'claude' || (key === 'codex' && codexSignedIn) },
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    } as const;
    app = await createServer(adapter(), { ...opts, auth: { mode: 'required', tokensPath }, auditPath: join(scratch, 'audit.log') });
    await app.ready();
    local = await createServer(adapter(), { ...opts, auth: { mode: 'off' }, auditPath: join(scratch, 'audit-local.log') });
    await local.ready();
  }, 150_000);

  afterAll(async () => {
    await app.close();
    await local.close();
    vi.restoreAllMocks();
    setCrewStateHome(armedStateHome);
    if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
    removeScratch(scratch);
  });

  const auth = (token = 'owner-token') => ({ headers: { authorization: `Bearer ${token}` } });
  const open = async (chatId: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude'], repoRefs: ['r-crew'], accepts: ['job'] }, ...auth() });
    expect(res.statusCode, res.body).toBe(201);
  };
  const send = (chatId: string, token = 'owner-token') => app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'the login page 500s' }, ...auth(token) });
  const replyTo = (chat: string, turnId: string) => {
    for (const fn of listeners) fn({ type: 'chatReply', chat, cliKey: 'claude', turnId, text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
  };
  const proposalFrames = (chat: string, pid: string) => broadcast.mock.calls.flatMap(([frame]) => {
    if (frame.type !== 'chatProposal' || frame.chat !== chat) return [];
    const { record } = frame as ChatProposalFrame;
    return record.kind === 'proposal' && record.proposal.pid === pid ? [record] : [];
  });

  it('hides detail like a never-opened id, without rewriting a held card or broadcasting it; the owner rechecks it', async () => {
    codexSignedIn = false;
    const chatId = 'hidden-held';
    const url = `/api/v1/chats/${chatId}`;
    // The same id before open makes the refusal bodies directly comparable.
    const unknown = await app.inject({ method: 'GET', url, ...auth('other-token') });
    expect.soft(unknown.statusCode, unknown.body).toBe(404);
    await open(chatId);
    const sent = await send(chatId);
    expect(sent.statusCode, sent.body).toBe(202);
    const { turnId } = sent.json() as { turnId: string };
    replyTo(chatId, turnId);
    const made = await app.inject({ method: 'POST', url: `${url}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'held', words: 'the login page 500s' }, ...auth() });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.blocked).toBe(NEEDS_TWO);
    await vi.waitFor(() => expect(proposalFrames(chatId, p.pid)).toHaveLength(1));
    const transcript = join(home, 'chats', `${chatId}.jsonl`);
    const bytesBefore = readFileSync(transcript);
    const launchesBefore = launches.length;
    const continuationsBefore = continuations.length;
    const framesBefore = proposalFrames(chatId, p.pid).length;
    codexSignedIn = true;

    const hidden = await app.inject({ method: 'GET', url, ...auth('other-token') });
    expect.soft(hidden.statusCode, hidden.body).toBe(404);
    expect.soft(hidden.body).toBe(unknown.body);
    expect.soft(readFileSync(transcript).equals(bytesBefore)).toBe(true);
    expect.soft(proposalFrames(chatId, p.pid)).toHaveLength(framesBefore);
    expect.soft(launches).toHaveLength(launchesBefore);
    expect.soft(continuations).toHaveLength(continuationsBefore);

    const owner = await app.inject({ method: 'GET', url, ...auth() });
    expect(owner.statusCode, owner.body).toBe(200);
    const records = (owner.json() as { messages: ChatTranscriptRecord[] }).messages;
    const refreshed = foldProposals(records).get(p.pid)!;
    expect(refreshed.proposal.blocked).toBeNull();
    expect(refreshed.proposal.seats?.keys).toEqual(['claude', 'codex']);
    expect(readFileSync(transcript).equals(bytesBefore)).toBe(false);
    expect(proposalFrames(chatId, p.pid)).toHaveLength(framesBefore + 1);
    expect(proposalFrames(chatId, p.pid).at(-1)?.proposal.blocked).toBeNull();
    expect(launches).toHaveLength(launchesBefore);
    expect(continuations).toHaveLength(continuationsBefore);
  });

  it.each([
    ['agent-token', 404], ['system-token', 404], ['plugin-token', 403], ['observer-token', 403],
    [undefined, 401], ['wmt_not_a_bound_unit_token', 401],
  ] as const)('hides chat reads and messages from %s (crew#1270)', async (token, postStatus) => {
    const chatId = `matrix-${token ?? 'no-token'}`;
    const url = `/api/v1/chats/${chatId}`;
    const headers = token === undefined ? {} : auth(token);
    const unknown = await app.inject({ method: 'GET', url, ...headers });
    await open(chatId);
    const hidden = await app.inject({ method: 'GET', url, ...headers });
    expect(hidden.statusCode, hidden.body).toBe(postStatus === 401 ? 401 : 404);
    expect(hidden.body).toBe(unknown.body);
    const payload = { text: 'the login page 500s' };
    const unknownSend = await app.inject({ method: 'POST', url: '/api/v1/chats/never-opened/messages', payload, ...headers });
    const hiddenSend = await app.inject({ method: 'POST', url: `${url}/messages`, payload, ...headers });
    expect(hiddenSend.statusCode, hiddenSend.body).toBe(postStatus);
    expect(hiddenSend.body).toBe(postStatus === 404 ? unknown.body : unknownSend.body);
  });

  it('refuses another actor re-seating before changing the owner roster; the owner can re-seat', async () => {
    codexSignedIn = true;
    const chatId = 'hidden-seats';
    const url = `/api/v1/chats/${chatId}`;
    await open(chatId);
    const before = (await app.inject({ method: 'GET', url, ...auth() })).json() as { seats: string[] };
    const hidden = await app.inject({ method: 'POST', url: `${url}/seats`, payload: { clis: ['codex'] }, ...auth('other-token') });
    expect.soft(hidden.statusCode, hidden.body).toBe(404);
    const after = (await app.inject({ method: 'GET', url, ...auth() })).json() as { seats: string[] };
    expect.soft(after.seats).toEqual(before.seats);
    const owner = await app.inject({ method: 'POST', url: `${url}/seats`, payload: { clis: ['codex'] }, ...auth() });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(((await app.inject({ method: 'GET', url, ...auth() })).json() as { seats: string[] }).seats).toEqual(['codex']);
  });

  it('refuses another actor sending without context before launching or continuing; the owner can send', async () => {
    const chatId = 'hidden-send';
    await open(chatId);
    const launchesBefore = launches.length;
    const continuationsBefore = continuations.length;
    const hidden = await send(chatId, 'other-token');
    expect.soft(hidden.statusCode, hidden.body).toBe(404);
    expect.soft(launches).toHaveLength(launchesBefore);
    expect.soft(continuations).toHaveLength(continuationsBefore);
    if (hidden.statusCode === 202) replyTo(chatId, (hidden.json() as { turnId: string }).turnId);
    const owner = await send(chatId);
    expect(owner.statusCode, owner.body).toBe(202);
    replyTo(chatId, (owner.json() as { turnId: string }).turnId);
    const sendsBefore = { launches: launches.length, continuations: continuations.length };
    const hiddenAgain = await send(chatId, 'other-token');
    expect.soft(hiddenAgain.statusCode, hiddenAgain.body).toBe(404);
    expect.soft(launches).toHaveLength(sendsBefore.launches);
    expect.soft(continuations).toHaveLength(sendsBefore.continuations);
  });

  it('hides considered text from another operator while serving the owner turn', async () => {
    const chatId = 'hidden-considered';
    await open(chatId);
    const sent = await send(chatId);
    expect(sent.statusCode, sent.body).toBe(202);
    const { turnId } = sent.json() as { turnId: string };
    replyTo(chatId, turnId);
    const url = `/api/v1/chats/${chatId}/turns/${turnId}/considered`;
    const hidden = await app.inject({ method: 'GET', url, ...auth('other-token') });
    expect.soft(hidden.statusCode, hidden.body).toBe(404);
    const owner = await app.inject({ method: 'GET', url, ...auth() });
    expect(owner.statusCode, owner.body).toBe(200);
    expect.soft(owner.body).not.toBe(hidden.body);
  });

  it.each([
    ['GET', ''], ['POST', '/seats'], ['POST', '/messages'], ['GET', '/turns/t1/considered'],
  ] as const)('%s %s refuses an unknown id before body parsing or path reads', async (method, suffix) => {
    const res = await app.inject({ method, url: `/api/v1/chats/never-opened${suffix}`, ...(method === 'POST' ? { payload: {} } : {}), ...auth('other-token') });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual({ error: 'no chat never-opened on this daemon' });
  });

  it('keeps local-mode detail for a never-opened id', async () => {
    const res = await local.inject({ method: 'GET', url: '/api/v1/chats/never-opened' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ seats: [], scope: null });
  });
});

