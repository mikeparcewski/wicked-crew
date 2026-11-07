// F36 (DES-CATALOG-002 §4.6): a `/` command picked in a NEW chat opens the chat with its job proposal. The seeded open's
// retry check read the chat history's `stateOf` (`T | null`) against `undefined`, so a FIRST seeded open was taken for a
// retry: 200 `adopted`, no chat opened, no proposal. Driven through the real routes, with studio's exact body.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessagesResponse, ChatProposalView } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();

type OpenBody = { chatId: string; seats: unknown[]; proposal?: ChatProposalView; seedRefused?: unknown; adopted?: boolean };

describe('a seeded chat open makes its proposal the first time (F36)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];

  const adapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (): (() => void) => () => undefined,
    listRepos: async () => [{ id: 'r-crew', name: 'wicked-crew', root_path: join(scratch, 'repo-crew'), default_branch: 'main', registered_at: 1 }],
    projectGet: async () => null,
    projectList: async () => [],
    projectMembers: async () => [],
    launchRun: async (input: LaunchRunInput) => {
      launches.push(input);
      return input.sessionId ?? `run-${launches.length}`;
    },
    sessions: async () => [],
    sessionsDetail: async () => [],
    runEvents: async () => [],
    listWorkflows: () => BUILTIN_WORKFLOWS,
    workflowCatalog: async () => ({ workflows: BUILTIN_WORKFLOWS, unavailable: [] }),
    getWorkflow: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id),
    catalog: async () => [],
    listPresets: async () => [],
    supportsPowerMode: () => false,
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-seed-open-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
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
    await app.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  // Studio's body for a `/migrate` pick in a new chat (no seats named, no scope).
  const seededOpen = (requestId: string, seed: Record<string, unknown> = { card: 'migrate', source: 'pick' }) =>
    app.inject({ method: 'POST', url: '/api/v1/chats', payload: { seed, requestId, accepts: ['job'] } });
  const proposalPids = async (chatId: string): Promise<string[]> => {
    const read = await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages` });
    expect(read.statusCode, read.body).toBe(200);
    return (read.json() as ChatMessagesResponse).messages.filter((r) => r.kind === 'proposal').map((r) => (r as { proposal: { pid: string } }).proposal.pid);
  };

  it('a first seeded open with a fresh request id answers 201 with the chat and its proposal', async () => {
    const opened = await seededOpen(randomUUID());
    expect(opened.statusCode, opened.body).toBe(201);
    const body = opened.json() as OpenBody;
    expect(body.adopted).toBeUndefined();
    expect(body.seedRefused, opened.body).toBeUndefined();
    expect(body.proposal?.proposal.shape?.card, opened.body).toBe('migrate');
    // The chat exists and holds the proposal.
    const chat = await app.inject({ method: 'GET', url: `/api/v1/chats/${body.chatId}` });
    expect(chat.statusCode, chat.body).toBe(200);
    expect(await proposalPids(body.chatId)).toEqual([body.proposal!.proposal.pid]);
  });

  it('a retry with the same request id is adopted: the same chat and the same proposal, nothing opened again', async () => {
    const requestId = randomUUID();
    const first = await seededOpen(requestId);
    expect(first.statusCode, first.body).toBe(201);
    const made = first.json() as OpenBody;
    const again = await seededOpen(requestId);
    expect(again.statusCode, again.body).toBe(200);
    const adopted = again.json() as OpenBody;
    expect(adopted.adopted).toBe(true);
    expect(adopted.chatId).toBe(made.chatId);
    expect(adopted.seats).toEqual([]);
    expect(adopted.proposal?.proposal.pid).toBe(made.proposal!.proposal.pid);
    // Nothing was made again: the chat still holds exactly the one proposal record.
    expect(await proposalPids(made.chatId)).toEqual([made.proposal!.proposal.pid]);
  });

  it('a typed command with words (Requirements -> "Generate it") makes its proposal the first time too', async () => {
    const opened = await seededOpen(randomUUID(), { card: 'migrate', source: 'command', words: 'upgrade node to version 22 everywhere' });
    expect(opened.statusCode, opened.body).toBe(201);
    const body = opened.json() as OpenBody;
    expect(body.proposal?.proposal.shape?.card, opened.body).toBe('migrate');
    expect(body.proposal?.proposal.shape?.source).toBe('command');
    expect(await proposalPids(body.chatId)).toEqual([body.proposal!.proposal.pid]);
  });

  it('a retry after the chat was closed is adopted from its kept history: nothing reopened, no second proposal', async () => {
    const requestId = randomUUID();
    const first = await seededOpen(requestId);
    expect(first.statusCode, first.body).toBe(201);
    const made = first.json() as OpenBody;
    const closed = await app.inject({ method: 'POST', url: `/api/v1/chats/${made.chatId}/close` });
    expect(closed.statusCode, closed.body).toBe(200);
    const again = await seededOpen(requestId);
    expect(again.statusCode, again.body).toBe(200);
    const adopted = again.json() as OpenBody & { scope: unknown };
    expect(adopted.adopted).toBe(true);
    expect(adopted.chatId).toBe(made.chatId);
    expect(adopted.seats).toEqual([]);
    expect(adopted.scope).toBeNull();
    expect(adopted.proposal?.proposal.pid).toBe(made.proposal!.proposal.pid);
    expect(await proposalPids(made.chatId)).toEqual([made.proposal!.proposal.pid]);
  });
});
