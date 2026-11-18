// crew#1593: a chat job's Start hands the engine the card's seats, ALWAYS. Before, when the card's seats equalled the
// roster read at Start, the launcher sent no `clisJson`; the launch then waited for roster readiness and read the
// roster again, so a seat added in between (an operator adding one while the sign-in probe runs) joined a job whose
// card never named it. Driven through the real routes and launcher to the engine's `launchRun`; the daemon's roster
// is held to three seats, and a fourth appears while the launch waits for readiness.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

/** What happens while a launch waits for roster readiness (here: a fourth seat is added to the roster). */
let duringReadiness: (() => void) | null = null;
/** The daemon's roster: these seats (whatever the registry holds), plus `late` once it is added. */
const ROSTER = ['claude', 'codex', 'pi'];
let lateAdded = false;
vi.mock('../src/api/roster-standing.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/roster-standing.js')>();
  return {
    ...real,
    rosterWithStandingFactory: (...args: Parameters<typeof real.rosterWithStandingFactory>) => {
      const accessor = real.rosterWithStandingFactory(...args);
      const held = Object.assign(() => {
        const rows = accessor().filter((r) => ROSTER.includes(String(r.key)));
        const like = rows.find((r) => r.key === 'claude')!;
        return lateAdded ? [...rows, { ...like, key: 'late', display_name: 'Late' }] : rows;
      }, accessor);
      held.ready = async () => {
        duringReadiness?.();
      };
      return held;
    },
  };
});

const armedStateHome = crewStateHome();

describe("a chat job's Start hands the engine the card's seats, even when they equal the roster (crew#1593)", () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runs: string[] = [];
  const listeners: Array<(e: CoreEvent) => void> = [];
  /** The seats signed in; every other seat reads signed out. */
  const signedIn = new Set(['claude', 'codex', 'pi']);

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
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-launch-roster-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
    app = await createServer(adapter(), {
      seats: { signedIn: (key: string) => signedIn.has(key.split('#')[0] ?? key) },
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

  it('a seat added during launch readiness does not join: the engine gets exactly the card\'s seats', async () => {
    const chatId = 'launch-roster-1';
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude', 'codex', 'pi'], repoRefs: ['r-crew'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'the login page 500s' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: 'claude', text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r1', words: 'the login page 500s' } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.seats?.keys).toEqual(['claude', 'codex', 'pi']);
    expect(p.blocked, JSON.stringify(p)).toBeNull();

    // A fourth seat is added while the launch waits for the roster to be ready.
    duringReadiness = () => {
      lateAdded = true;
    };
    try {
      const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(p.pid)}`, payload: { decision: 'go' } });
      expect(go.statusCode, go.body).toBe(200);
    } finally {
      duringReadiness = null;
      lateAdded = false;
    }
    const launched = launches.at(-1)!;
    expect(launched.clisJson, 'the launch carries the card\'s roster').toBeDefined();
    expect((JSON.parse(launched.clisJson!) as Array<{ key: string }>).map((s) => s.key)).toEqual(['claude', 'codex', 'pi']);
  });

  // (coord merge check on 684bb5c, codex repro) The card's seats say WHICH seats, never that they are usable now: the
  // launch still waits for roster readiness and checks the lead against the fresh standing before the engine is called.
  it("a lead whose login expired during launch readiness is refused by name; the engine is never called", async () => {
    const chatId = 'launch-roster-expired-lead';
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude', 'codex', 'pi'], repoRefs: ['r-crew'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'the login page 500s' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: 'claude', text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { card: 'bug', source: 'pick', requestId: 'r1', words: 'the login page 500s' } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.seats?.keys).toEqual(['claude', 'codex', 'pi']);
    expect(p.blocked, JSON.stringify(p)).toBeNull();

    const beforeStart = launches.length;
    // The lead's login check, run by the readiness wait, now reads signed out.
    duringReadiness = () => {
      signedIn.delete('claude');
    };
    try {
      const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(p.pid)}`, payload: { decision: 'go' } });
      expect(go.statusCode, go.body).toBe(502);
      expect(go.body).toMatch(/claude/);
    } finally {
      duringReadiness = null;
      signedIn.add('claude');
    }
    expect(launches).toHaveLength(beforeStart);
  });
});
