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
import { onePersonUrl } from '../src/api/chat-proposals.js';
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
    projectGet: async (id: string) => id === 'p-demo' ? { id, name: 'Demo', status: 'active' } : null,
    projectList: async () => [],
    projectMembers: async () => [],
    projectMemberAttach: async (projectId: string, kind: string, ref: string) => ({ member: { id: randomUUID(), project_id: projectId, kind, ref, attached_at: 1 }, created: true }),
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
    catalog: async () => [{ id: 'demo_record' }],
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

  // JobProjectChoices opens a new chat in the chosen project with these same seed words.
  const demoSeed = async (words: string, card = '/demo'): Promise<OpenBody> => {
    const opened = await app.inject({
      method: 'POST', url: '/api/v1/chats',
      payload: { projectId: 'p-demo', seed: { card, words, source: 'command' }, requestId: randomUUID(), accepts: ['job'] },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const body = opened.json() as OpenBody;
    expect(body.seedRefused, opened.body).toBeUndefined();
    expect(body.proposal?.proposal.shape?.card, opened.body).toBe('demo-video');
    return body;
  };

  it.each(['/demo', 'demo-video'])('a %s seed takes the one app address from the person’s words', async (card) => {
    const body = await demoSeed('Record a short demo video of my app running at http://127.0.0.1:4319/ ...', card);
    const p = body.proposal!.proposal;
    expect(p.inputs?.['url']).toEqual({ kind: 'url', value: 'http://127.0.0.1:4319/' });
    expect(p.needs).toContainEqual(expect.objectContaining({ id: 'url', status: 'met' }));
    expect(p.question?.input?.edit).not.toBe('inputs.url');
    expect(p.question?.text).not.toBe('The running app?');
  });

  it.each([
    ['no address', 'Record a short demo video of my app'],
    ['two addresses', 'Record a demo of http://127.0.0.1:4319/ or http://localhost:4320/'],
  ])('a demo seed with %s keeps the running-app question', async (_label, words) => {
    const body = await demoSeed(words);
    const p = body.proposal!.proposal;
    expect(p.inputs?.['url']).toBeUndefined();
    expect(p.question).toMatchObject({ kind: 'missing', text: 'The running app?', choices: [], input: { kind: 'text', edit: 'inputs.url' } });
  });

  it('studio#1134: the words a person types for the running-app question are its address', async () => {
    const body = await demoSeed('Record a short demo video of my app');
    expect(body.proposal!.proposal.question).toMatchObject({ input: { kind: 'text', edit: 'inputs.url' } });
    const revised = await app.inject({
      method: 'POST', url: `/api/v1/chats/${body.chatId}/proposals`,
      payload: { revises: body.proposal!.proposal.pid, source: 'question', requestId: randomUUID(), edits: { inputs: { url: { kind: 'text', value: ' http://127.0.0.1:4319/ ' } } } },
    });
    expect(revised.statusCode, revised.body).toBe(201);
    const p = (revised.json() as { view: ChatProposalView }).view.proposal;
    expect(p.inputs?.['url']).toEqual({ kind: 'url', value: 'http://127.0.0.1:4319/' });
    expect(p.question?.input?.edit).not.toBe('inputs.url');
  });

  it('a demo seed’s external address is still refused by the demo launcher', async () => {
    const body = await demoSeed('Record a demo of https://example.com/app');
    expect(body.proposal!.proposal.inputs?.['url']).toEqual({ kind: 'url', value: 'https://example.com/app' });
    // Supply the other required fields so Start reaches the existing demo URL check.
    const revised = await app.inject({
      method: 'POST', url: `/api/v1/chats/${body.chatId}/proposals`,
      payload: { revises: body.proposal!.proposal.pid, source: 'question', requestId: randomUUID(), edits: { inputs: {
        audience: { kind: 'text', value: 'App users' }, show: { kind: 'text', value: 'Show the home page' },
      } } },
    });
    expect(revised.statusCode, revised.body).toBe(201);
    const p = (revised.json() as { view: ChatProposalView }).view.proposal;
    expect(p.question).toBeNull();
    const started = await app.inject({
      method: 'POST', url: `/api/v1/chats/${body.chatId}/proposals/${encodeURIComponent(p.pid)}`,
      payload: { decision: 'go' },
    });
    expect(started.statusCode, started.body).toBe(502);
    expect(started.json()).toMatchObject({
      code: 'launch_failed',
      error: 'could not start it: a demo records an app on this machine: use http://127.0.0.1:<port>/…, http://localhost:<port>/… or http://[::1]:<port>/… (the recorder reaches no other host), with no #fragment. Go again resumes the same job.',
    });
    expect(launches).toEqual([]);
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

// Review r1 on the seed fill: the one address is taken exactly as typed, or the person is asked.
describe('onePersonUrl: the one app address in a person\u2019s words, as typed', () => {
  it.each([
    ['Record my app at http://127.0.0.1:4319/ please', 'http://127.0.0.1:4319/'],
    ['Record HTTP://localhost:4319/', 'HTTP://localhost:4319/'],
    ['Use the http:// scheme and record http://localhost:4319/app', 'http://localhost:4319/app'],
    ['Record http://[::1]', 'http://[::1]'],
  ])('%s -> %s', (words, url) => {
    expect(onePersonUrl(words)).toBe(url);
  });
  it.each([
    ['no address', 'Record my app'],
    ['two addresses', 'Record http://localhost:4319/ or http://localhost:4320/'],
    ['two addresses in mixed case', 'Record http://localhost:4319/ or HTTP://localhost:4320/'],
    ['an address that runs into a quote', "Record http://localhost:4319/a'b"],
    ['an address with a fragment', 'Record http://localhost:4319/#!'],
    ['an address a sentence may have ended', 'Record http://localhost:4319/report.'],
    ['an address in brackets', 'Record it (http://localhost:4319/app)'],
    ['a quoted address', 'Record "http://localhost:4319/"'],
    ['an address that does not parse', 'Record http://['],
  ])('%s -> asked', (_label, words) => {
    expect(onePersonUrl(words)).toBeNull();
  });
});
