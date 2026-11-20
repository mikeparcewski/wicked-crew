// studio#1094: the person’s repository answer stays in the same chat.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessagesResponse, ChatProposalView } from 'wicked-crew-api-types';

import { AskPathIndex } from '../src/api/ask-paths.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();

type OpenBody = { chatId: string; seats: unknown[]; proposal?: ChatProposalView; seedRefused?: unknown; adopted?: boolean };

describe('studio#1094: the person picks the chat’s first repository for its job', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runIds = new Set<string>();
  const listeners = new Set<(event: CoreEvent) => void>();

  const adapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (listener: (event: CoreEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    listRepos: async () => ['a', 'b'].map((key) => ({ id: `r-${key}`, name: `repo-${key}`, root_path: join(scratch, `repo-${key}`), default_branch: 'main', registered_at: 1 })),
    projectGet: async (id: string) => id === 'p-demo' ? { id, name: 'Demo', status: 'active' } : null,
    projectList: async () => [],
    projectMembers: async () => [],
    projectMemberAttach: async (projectId: string, kind: string, ref: string) => ({ member: { id: randomUUID(), project_id: projectId, kind, ref, attached_at: 1 }, created: true }),
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      const id = input.sessionId ?? `run-${launches.length}`;
      runIds.add(id);
      return id;
    },
    sessions: async () => [],
    sessionsDetail: async () => [],
    runView: async (id: string) => runIds.has(id) ? ({ session: { id, status: 'awaiting_human' }, units: [] }) as unknown as SessionView : undefined,
    runEvents: async () => [],
    listWorkflows: () => BUILTIN_WORKFLOWS,
    workflowCatalog: async () => ({ workflows: BUILTIN_WORKFLOWS, unavailable: [] }),
    getWorkflow: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id),
    catalog: async () => [{ id: 'demo_record' }],
    listPresets: async () => [],
    supportsPowerMode: () => false,
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-first-repo-pick-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-a'));
    mkdirSync(join(scratch, 'repo-b'));
    setCrewStateHome(home);
    app = await boot();
  }, 150_000);

  const boot = async () => {
    const server = await createServer(adapter(), {
      seats: { signedIn: () => true },
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
    });
    await server.ready();
    return server;
  };

  afterAll(async () => {
    await app.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  const seededOpen = async (repoRefs: string[] = [], clis?: string[]) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: {
      ...(repoRefs.length > 0 ? { repoRefs } : {}), seed: { card: 'migrate', option: 'upgrade', words: 'upgrade node to version 22', source: 'command' },
      requestId: randomUUID(), accepts: ['job'], ...(clis !== undefined ? { clis } : {}),
    } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as OpenBody;
    expect(body.seedRefused, res.body).toBeUndefined();
    expect(body.proposal?.proposal.shape?.card).toBe('migrate');
    if (repoRefs.length === 0) expect(body.proposal!.proposal.needs).toContainEqual(expect.objectContaining({ id: 'repo', status: 'missing' }));
    return { chatId: body.chatId, parent: body.proposal!.proposal };
  };
  const revise = (chatId: string, pid: string, repoRef: string) => app.inject({
    method: 'POST', url: `/api/v1/chats/${chatId}/proposals`,
    payload: { revises: pid, edits: { repoRef }, source: 'question', requestId: randomUUID() },
  });
  const scopeOf = async (chatId: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().scope as { kind: string; repos: { id: string }[]; cwd: string };
  };
  const proposals = async (chatId: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages` });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as ChatMessagesResponse).messages.filter((r) => r.kind === 'proposal');
  };
  const auditPicks = async (chatId: string) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?action=chat.scope.repo_picked' });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { entries: { action: string; detail: Record<string, unknown> }[] }).entries.filter((e) => e.detail['chatId'] === chatId);
  };

  it('sets the first repository in the same chat, meets the job need, states the pick and audits it', async () => {
    const { chatId, parent } = await seededOpen();
    const res = await revise(chatId, parent.pid, 'repo-b');
    expect(res.statusCode, res.body).toBe(201);
    const p = (res.json() as { view: ChatProposalView }).view.proposal;
    expect(p.repoRefs).toEqual(['r-b']);
    expect(p.needs).toContainEqual(expect.objectContaining({ id: 'repo', status: 'met' }));
    expect(p.sentence?.notes.filter((n) => n === 'This chat now reads repo-b: you picked it for this job.')).toHaveLength(1);
    const scope = await scopeOf(chatId);
    expect(scope).toMatchObject({ kind: 'repos', repos: [{ id: 'r-b' }] });
    for (const file of ['AGENTS.md', 'CLAUDE.md']) expect(readFileSync(join(scope.cwd, file), 'utf8')).toContain(join(scratch, 'repo-b'));
    expect(await auditPicks(chatId)).toEqual([expect.objectContaining({ action: 'chat.scope.repo_picked', detail: expect.objectContaining({ chatId, pid: p.pid, repoRef: 'r-b', from: 'none' }) })]);
    expect(await proposals(chatId)).toHaveLength(2);
  });

  it('keeps refusing an outside repository when the chat already has one', async () => {
    const { chatId, parent } = await seededOpen(['r-a']);
    const res = await revise(chatId, parent.pid, 'r-b');
    expect(res.statusCode, res.body).toBe(201);
    const p = (res.json() as { view: ChatProposalView }).view.proposal;
    expect(p.sentence?.notes).toContain("Not changed: r-b isn't in this chat's scope (start a thread on it)");
    expect((await scopeOf(chatId)).repos.map((r) => r.id)).toEqual(['r-a']);
    expect(await auditPicks(chatId)).toEqual([]);
  });

  it('refuses an unknown repository with the open resolver’s status and writes nothing', async () => {
    const { chatId, parent } = await seededOpen();
    const before = await proposals(chatId);
    const res = await revise(chatId, parent.pid, 'unknown-repo');
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ code: 'chat_scope_refused', error: expect.stringContaining('unknown-repo') });
    expect(await proposals(chatId)).toEqual(before);
    expect(await scopeOf(chatId)).toMatchObject({ kind: 'none', repos: [] });
    expect(await auditPicks(chatId)).toEqual([]);
  });

  it('keeps the picked proposal and audit across a restart, and Go launches on the picked repo', async () => {
    const { chatId, parent } = await seededOpen();
    const res = await revise(chatId, parent.pid, 'r-b');
    expect(res.statusCode, res.body).toBe(201);
    const pid = (res.json() as { view: ChatProposalView }).view.proposal.pid;
    await app.close();
    app = await boot();
    const records = await proposals(chatId);
    expect(records.at(-1)).toMatchObject({ proposal: { pid, repoRefs: ['r-b'], shape: { by: 'person' } } });
    expect(await auditPicks(chatId)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ chatId, repoRef: 'r-b' }) })]);
    const started = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: { decision: 'go' } });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ view: { state: 'decided', decision: 'go' } });
    expect(launches).toHaveLength(1);
    expect(launches.at(-1)?.repoRef).toBe('r-b');
  });

  it('refuses answers after the person picks the first repository through the revision route (crew#1034)', async () => {
    const { chatId, parent } = await seededOpen([], ['claude']);
    const before = launches.length;
    const send = () => app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'Which repository does this job need?' } });
    const first = await send();
    expect(first.statusCode, first.body).toBe(202);
    expect(launches).toHaveLength(before + 1);
    expect(launches.at(-1)).not.toHaveProperty('repoRef');
    expect(launches.at(-1)?.extraReadRoots).not.toContain(join(scratch, 'repo-b'));
    for (const listener of listeners) listener({ type: 'chatReply', chat: chatId, cliKey: 'claude', text: 'Which repository?', ok: true } as CoreEvent);
    // The answer releases the proposal held by the person's message before they revise it.
    await vi.waitFor(async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages` });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as ChatMessagesResponse).messages).toContainEqual(expect.objectContaining({ kind: 'proposal_released', pid: parent.pid }));
    });
    const picked = await revise(chatId, parent.pid, 'repo-b');
    expect(picked.statusCode, picked.body).toBe(201);
    expect((picked.json() as { view: ChatProposalView }).view.proposal.repoRefs).toEqual(['r-b']);
    expect(await scopeOf(chatId)).toMatchObject({ kind: 'repos', repos: [{ id: 'r-b' }] });
    const second = await send();
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ code: 'chat_scope_changed', error: "This chat's repository was picked for its job after the conversation started, so its answers can't read it. Start a new chat on repo-b to ask about it; the job stays in this chat." });
    expect(launches).toHaveLength(before + 1);
  });
});


describe('AskPathIndex.rescope', () => {
  it('updates governance before launch, preserves it after launch, and ignores an unknown chat', () => {
    const paths = new AskPathIndex();
    const path = paths.open('pick', ['claude'], undefined, { seats: [{ key: 'claude' }], scopeKind: 'unscoped' });
    expect(paths.get('pick')?.scopeKind).toBe('unscoped');
    paths.rescope('pick', 'scoped_bound');
    expect(paths.get('pick')?.scopeKind).toBe('scoped_bound');
    expect(paths.started('pick', path.generation, 'run-pick', 'answer-1')).toBe(true);
    expect(paths.view('pick')?.governance_mode?.fence).toMatchObject({ read_roots: ['<run worktree>'], write_roots: ['<run worktree>'] });
    const view = paths.view('pick');
    paths.rescope('pick', 'unscoped');
    expect(paths.get('pick')?.scopeKind).toBe('scoped_bound');
    expect(paths.view('pick')).toEqual(view);
    paths.rescope('unknown', 'scoped_bound');
    expect(paths.get('unknown')).toBeUndefined();
    expect(paths.list()).toEqual([path]);
  });
});
