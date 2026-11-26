// crew#1884 (DES-STANDIN-001 §4, K2a follow-up): a chat job's Start asks the stand-in choice, as studio's Start on
// `POST /runs` does. A short roster with no consent reopens the card with a `stand_in` question; its choice is a
// revision only the person's own press applies, and the revised card's Start launches with stand-ins. Driven through
// the real routes and the real job launcher, down to the engine's launch, with the engine's own one-helper preflight.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

/** The engine's own preflight for a one-CLI roster (`tests/fixtures/stand-in-preflight-one-helper.json`, written by
 *  wicked-core `src/independence.rs` `t_r2_one_signed_in_cli_is_short_for_every_independent_role`). */
const ONE_HELPER = readFileSync(new URL('./fixtures/stand-in-preflight-one-helper.json', import.meta.url), 'utf8');

const armedStateHome = crewStateHome();

describe('a chat job Start asks the stand-in choice (crew#1884, server, real job launcher)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runs: string[] = [];
  let short = true;
  const preflights: LaunchRunInput[] = [];
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
      const id = input.sessionId ?? `run-${launches.length}`;
      runs.push(id);
      return id;
    },
    sessions: async () => [...runs],
    sessionsDetail: async () => [],
    runEvents: async () => [],
    listWorkflows: () => BUILTIN_WORKFLOWS,
    workflowCatalog: async () => ({ workflows: BUILTIN_WORKFLOWS, unavailable: [] }),
    getWorkflow: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id),
    catalog: async () => [],
    listPresets: async () => [{ name: 'bug', scope: 'global', steps: [{ id: 'fix' }], created_by: 'builtin', updated_at: 1 }],
    supportsPowerMode: () => false,
    supportsStandIns: () => true,
    independencePreflight: async (input: LaunchRunInput) => {
      preflights.push(input);
      return short ? ONE_HELPER : JSON.stringify({ ...JSON.parse(ONE_HELPER), short: false });
    },
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-stand-in-'));
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

  beforeEach(() => {
    short = true;
  });

  let n = 0;
  /** A chat on the repository, with a person-made Bug job proposal in it: its chat id and pid. */
  const proposed = async (): Promise<{ chatId: string; pid: string }> => {
    n += 1;
    const chatId = `stand-in-${n}`;
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude'], repoRefs: ['r-crew'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    // A chat has its transcript once a turn was sent (a proposal is a record in it).
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'the login page 500s' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: 'claude', text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { card: 'bug', source: 'pick', requestId: `r${n}`, words: 'the login page 500s' } });
    expect(made.statusCode, made.body).toBe(201);
    const view = (made.json() as { view: ChatProposalView }).view;
    expect(view.proposal.blocked, JSON.stringify(view.proposal)).toBeNull();
    return { chatId, pid: view.proposal.pid };
  };
  const start = (chatId: string, pid: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: { decision: 'go', edits: { seats: ['claude', 'codex', 'pi'] }, ...body } });

  const revise = (chatId: string, pid: string, edits: Record<string, unknown>, requestId: string) =>
    app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { revises: pid, edits, source: 'question', requestId } });

  it('a short roster with no consent: 409 stand_in_choice, nothing started, the card reopened with the stand_in question', async () => {
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, {});
    expect(out.statusCode, out.body).toBe(409);
    const body = out.json() as { code: string; retryWith?: unknown; view: ChatProposalView };
    expect(body.code).toBe('stand_in_choice');
    expect(body.retryWith).toEqual({ standIns: true });
    expect(launches.length).toBe(before);
    expect(body.view.state).toBe('open');
    const q = body.view.proposal.question;
    expect(q?.kind).toBe('stand_in');
    expect(q?.text).toContain('stand-ins');
    expect(q?.choices.map((c) => c.label)).toEqual(['Use stand-ins for this job', 'Back to the job']);
    expect(q?.choices[0]!.edit).toEqual({ standIns: true });
  });

  it('the person presses the choice: the revised card\'s Start launches with stand-ins for this job, consent theirs', async () => {
    const { chatId, pid } = await proposed();
    const refused = await start(chatId, pid, {});
    expect(refused.statusCode, refused.body).toBe(409);
    const revised = await revise(chatId, pid, { standIns: true }, `si-${pid}`);
    expect(revised.statusCode, revised.body).toBe(201);
    const view = (revised.json() as { view: ChatProposalView }).view;
    expect(view.proposal.question ?? null).toBeNull();
    const before = launches.length;
    const go = await start(chatId, view.proposal.pid, { edits: undefined });
    expect(go.statusCode, go.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    const input = launches.at(-1)!;
    expect(input.standInAware).toBe(true);
    expect(input.standIn).toMatchObject({ scope: 'job', via: 'launch' });
  });

  it('standIns on a card wicked did not ask it on changes nothing, said in a note; its Start still asks', async () => {
    const { chatId, pid } = await proposed();
    const revised = await revise(chatId, pid, { standIns: true }, `unasked-${pid}`);
    expect(revised.statusCode, revised.body).toBe(201);
    const view = (revised.json() as { view: ChatProposalView }).view;
    expect(view.proposal.standIns).toBeUndefined();
    expect(view.proposal.sentence?.notes.join(' ')).toContain('stand-ins are chosen with your press');
    const before = launches.length;
    const out = await start(chatId, view.proposal.pid, { edits: undefined });
    expect(out.statusCode, out.body).toBe(409);
    expect(out.json()).toMatchObject({ code: 'stand_in_choice' });
    expect(launches.length).toBe(before);
  });

  it('Back to the job: the card returns to Start without stand-ins, and a roster no longer short starts it', async () => {
    const { chatId, pid } = await proposed();
    const refused = await start(chatId, pid, {});
    const q = (refused.json() as { view: ChatProposalView }).view.proposal.question!;
    const back = await revise(chatId, pid, q.choices[1]!.edit as Record<string, unknown>, `back-${pid}`);
    expect(back.statusCode, back.body).toBe(201);
    const view = (back.json() as { view: ChatProposalView }).view;
    expect(view.proposal.question ?? null).toBeNull();
    expect(view.proposal.standIns).toBeUndefined();
    short = false;
    const go = await start(chatId, view.proposal.pid, { edits: undefined });
    expect(go.statusCode, go.body).toBe(200);
    expect(launches.at(-1)!.standIn).toBeUndefined();
  });

  it('a roster that is not short launches as before, stand-in-aware (a seat lost mid-run holds at the stand-in gate)', async () => {
    short = false;
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, {});
    expect(out.statusCode, out.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    expect(launches.at(-1)!.standInAware).toBe(true);
    expect(launches.at(-1)!.standIn).toBeUndefined();
  });
});
