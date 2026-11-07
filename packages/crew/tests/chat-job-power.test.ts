// (api-types 0.196.0, operator ruling 2026-11-06) A chat job's Start chooses how it runs: `power: true` is a power run
// (no plan gate), `false` or absent stops at its first plan exactly as before. `true` is honoured only when this daemon
// can run THIS job as a power run, else 409 `power_unavailable` and nothing is recorded or started (never run phased
// behind the person's back). Driven through the real routes and the real job launcher, down to the engine's launch.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessagesResponse, ChatProposalView, ChatTranscriptRecord, HealthResponse } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();

describe('a chat job Start chooses power (server, real job launcher)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runs: string[] = [];
  let powerMode = true;
  let presets = ['bug'];
  let powerDefault = true;
  /** How many settings reads answer the setting before it turns off (`null`: never). */
  let settingsLeft: number | null = null;
  let settingsReads = 0;
  /** A system preset (not builtin, not listed in the catalog's saved map) the launch still accepts. */
  let systemPreset = false;
  /** How many power-mode reads answer yes before the engine stops answering yes (`null`: never). */
  let powerReadsLeft: number | null = null;
  let powerReads = 0;
  const listeners: Array<(e: CoreEvent) => void> = [];

  const adapter = (): CoreAdapter => ({
    dbPath: join(home, 'core.db'),
    projectsSupported: () => true,
    getSettings: async () => {
      settingsReads += 1;
      if (settingsLeft === null) return { powerModeDefault: powerDefault };
      settingsLeft -= 1;
      return { powerModeDefault: powerDefault && settingsLeft >= 0 };
    },
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
    listPresets: async () => presets.map((name) => ({ name, scope: 'global', steps: [{ id: 'fix' }], created_by: systemPreset ? 'operator' : 'builtin', ...(systemPreset ? { system: true } : {}), updated_at: 1 })),
    supportsPowerMode: () => {
      powerReads += 1;
      if (powerReadsLeft === null) return powerMode;
      powerReadsLeft -= 1;
      return powerMode && powerReadsLeft >= 0;
    },
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-power-'));
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
    powerMode = true;
    presets = ['bug'];
    powerDefault = true;
    powerReadsLeft = null;
    settingsLeft = null;
    systemPreset = false;
  });

  let n = 0;
  /** A chat on the repository, with a person-made Bug job proposal in it: its chat id and pid. */
  const proposed = async (): Promise<{ chatId: string; pid: string; sentence: string; stops: string | null; powerChoice: boolean | undefined }> => {
    n += 1;
    const chatId = `power-${n}`;
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
    return { chatId, pid: view.proposal.pid, sentence: view.proposal.sentence?.text ?? '', stops: view.proposal.stops, powerChoice: view.proposal.powerChoice };
  };
  const start = (chatId: string, pid: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: { decision: 'go', edits: { seats: ['claude', 'codex', 'pi'] }, ...body } });
  const records = async (chatId: string): Promise<ChatTranscriptRecord[]> =>
    ((await app.inject({ method: 'GET', url: `/api/v1/chats/${chatId}/messages` })).json() as ChatMessagesResponse).messages;

  it('the sentence promises a plan only where the Start can’t choose a power run; powerChoice says where it can', async () => {
    const chooses = await proposed();
    expect(chooses.sentence).not.toContain('show you the plan');
    expect(chooses.powerChoice).toBe(true);
    expect(chooses.stops).toBeNull();
    const cases: Array<() => void> = [() => { powerDefault = false; }, () => { powerMode = false; }, () => { presets = []; }];
    for (const set of cases) {
      powerDefault = true; powerMode = true; presets = ['bug'];
      set();
      const p = await proposed();
      expect(p.sentence).toContain("I'll show you the plan before anything changes.");
      expect(p.powerChoice).toBeUndefined();
      expect(p.stops).toBe('Asks you to approve the plan first.');
    }
  });

  it('a system preset the launch accepts is a Start that chooses, like a builtin one', async () => {
    systemPreset = true;
    const p = await proposed();
    expect(p.powerChoice).toBe(true);
    expect(p.stops).toBeNull();
    const before = launches.length;
    expect((await start(p.chatId, p.pid, { power: true })).statusCode).toBe(200);
    expect(launches.length).toBe(before + 1);
    expect(launches.at(-1)!.power).toBe(true);
  });

  it('the setting turned off by the time the engine is called: refused, never started as a power run', async () => {
    const probe = await proposed();
    const reads0 = settingsReads;
    expect((await start(probe.chatId, probe.pid, { power: true })).statusCode).toBe(200);
    const perStart = settingsReads - reads0;
    const { chatId, pid } = await proposed();
    const before = launches.length;
    settingsLeft = perStart - 1;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(502);
    expect(out.json()).toMatchObject({ code: 'launch_failed', error: expect.stringContaining('Power mode for new jobs is off') });
    expect(launches.length).toBe(before);
  });

  it('advertises chatJobPower', async () => {
    expect(((await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse).capabilities?.chatJobPower).toBe(true);
  });

  it('absent: exactly the launch of before (it stops at its first plan, even with power mode on by default)', async () => {
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, {});
    expect(out.statusCode, out.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    const input = launches.at(-1)!;
    expect(input.humanConfirm).toBe('before:1');
    expect(input.power).not.toBe(true);
  });

  it('false: it stops at its first plan', async () => {
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, { power: false });
    expect(out.statusCode, out.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    const input = launches.at(-1)!;
    expect(input.humanConfirm).toBe('before:1');
    expect(input.power).not.toBe(true);
  });

  it('true: a power run, with no plan gate', async () => {
    const { chatId, pid, stops } = await proposed();
    expect(stops).toBeNull();
    const before = launches.length;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    const input = launches.at(-1)!;
    expect(input.power).toBe(true);
    expect(input.humanConfirm).toBe('none');
  });

  it('true with Power mode for new jobs off: refused (chat starts follow the setting, and the sentence promised the plan)', async () => {
    powerDefault = false;
    const { chatId, pid, sentence, stops } = await proposed();
    expect(sentence).toContain("I'll show you the plan before anything changes.");
    expect(stops).toBe('Asks you to approve the plan first.');
    const before = launches.length;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(409);
    expect(out.json()).toMatchObject({ code: 'power_unavailable', error: expect.stringContaining('Power mode for new jobs is off') });
    expect(launches.length).toBe(before);
    expect((await start(chatId, pid, {})).statusCode).toBe(200);
    expect(launches.at(-1)!.humanConfirm).toBe('before:1');
  });

  it('power mode gone by the time the engine is called: refused, never started phased; Go again with the plan starts it', async () => {
    // How many times one power Start reads power mode (its last read is launchRun's own, just before the engine).
    const probe = await proposed();
    const reads0 = powerReads;
    expect((await start(probe.chatId, probe.pid, { power: true })).statusCode).toBe(200);
    const perStart = powerReads - reads0;
    const { chatId, pid } = await proposed();
    const before = launches.length;
    // Every check before the last answers yes; launchRun's own check (the last) answers no.
    powerReadsLeft = perStart - 1;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(502);
    expect(out.json()).toMatchObject({ code: 'launch_failed', error: expect.stringContaining('power_unavailable') });
    expect(launches.length).toBe(before);
    powerReadsLeft = null;
    // Go again resumes the choices it was accepted with (no edits), now held at its plan.
    const again = await start(chatId, pid, { power: false, edits: undefined });
    expect(again.statusCode, again.body).toBe(200);
    expect(launches.length).toBe(before + 1);
    expect(launches.at(-1)!.humanConfirm).toBe('before:1');
    expect(launches.at(-1)!.power).not.toBe(true);
  });

  it('true on an engine without power mode: 409 power_unavailable, nothing recorded or started; then Start with the plan works', async () => {
    powerMode = false;
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(409);
    expect(out.json()).toMatchObject({ code: 'power_unavailable', error: expect.stringContaining('no power mode') });
    expect(launches.length).toBe(before);
    expect((await records(chatId)).some((r) => r.kind === 'proposal_accepting' || r.kind === 'proposal_decided')).toBe(false);
    const again = await start(chatId, pid, { power: false });
    expect(again.statusCode, again.body).toBe(200);
    expect(launches.at(-1)!.humanConfirm).toBe('before:1');
  });

  it('true when the workflow is not a preset: refused, never run phased', async () => {
    presets = [];
    const { chatId, pid } = await proposed();
    const before = launches.length;
    const out = await start(chatId, pid, { power: true });
    expect(out.statusCode, out.body).toBe(409);
    expect(out.json()).toMatchObject({ code: 'power_unavailable', error: expect.stringContaining('not a preset') });
    expect(launches.length).toBe(before);
  });

  it('power with Not now, or a non-boolean power, is a 400', async () => {
    const { chatId, pid } = await proposed();
    const notNow = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: { decision: 'not_now', power: true } });
    expect(notNow.statusCode, notNow.body).toBe(400);
    expect(notNow.json()).toMatchObject({ code: 'power_not_applicable' });
    expect((await start(chatId, pid, { power: 'yes' })).statusCode).toBe(400);
  });
});
