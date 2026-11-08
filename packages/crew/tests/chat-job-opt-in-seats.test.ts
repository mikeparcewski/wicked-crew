// F43 (e2e-1105): a chat job proposed opencode as a helper, and its Start then 409'd `helper_unavailable`, while
// Generate it on the same repository left opencode out. Both read the seats a job may name from `rosterEligible`, whose
// opt-in clause read a field the standing rows never carry. It is now the default launch roster (`defaultLaunchRoster`,
// the roster a launch that names no seat gets) narrowed to the seats that can work now. Driven through the real routes.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { proposalRoster } from '../src/api/routes.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();

describe('a chat job names only seats a default launch would seat (F43, server)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runs: string[] = [];
  const listeners: Array<(e: CoreEvent) => void> = [];
  /** `true`: every seat but opencode reads signed out (whatever the registry holds). */
  let onlyOpencode = false;

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
    scratch = mkdtempSync(join(tmpdir(), 'chat-job-opt-in-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-crew'));
    setCrewStateHome(home);
    app = await createServer(adapter(), {
      seats: { signedIn: (key: string) => !onlyOpencode || (key.split('#')[0] ?? key) === 'opencode' },
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

  let n = 0;
  /** A single-repo chat seated with `clis`, and a person-made Bug job proposed in it. */
  const proposed = async (clis: string[]): Promise<ChatProposalView['proposal']> => {
    n += 1;
    const chatId = `opt-in-${n}`;
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis, repoRefs: ['r-crew'], accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    expect((opened.json() as { seats: Array<{ cliKey: string; ok: boolean }> }).seats).toContainEqual({ cliKey: 'opencode', ok: true });
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'the login page 500s' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: clis[0], text: 'Looks like a bug.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { card: 'bug', source: 'pick', requestId: `r${n}`, words: 'the login page 500s' } });
    expect(made.statusCode, made.body).toBe(201);
    return (made.json() as { view: ChatProposalView }).view.proposal;
  };

  it('opencode signed in and seated in the chat: the job neither names it nor offers it as a lead', async () => {
    onlyOpencode = false;
    const p = await proposed(['claude', 'codex', 'pi', 'opencode']);
    // The registry's other seats may change; what F43 needs is that the chat's lead stays and opencode never shows.
    expect(p.seats?.keys[0]).toBe('claude');
    expect(p.seats?.keys).not.toContain('opencode');
    expect(p.blocked, JSON.stringify(p)).toBeNull();
    // The sentence's seats label and its lead swap choices are drawn from the same roster.
    expect(JSON.stringify(p.sentence)).not.toContain('opencode');
  });

  // A guard, not the discriminating case (the old filter kept opencode here too): the fix must not leave a job seatless.
  it('opencode is the only seat that can work: it is kept, as a launch that names no seat keeps it', async () => {
    onlyOpencode = true;
    try {
      const p = await proposed(['opencode']);
      expect(p.seats?.keys).toEqual(['opencode']);
    } finally {
      onlyOpencode = false;
    }
  });
});

describe('proposalRoster (F43): the standing predicate first, then the default launch rule', () => {
  const seat = (key: string, over: Record<string, unknown> = {}) => ({ key, display_name: key.toUpperCase(), enabled_for_council: true, seat_eligible_for_work: true, auth: 'signed_in', ...over });

  it('drops an opt-in seat, instances included, from standing rows that carry no `optIn`', () => {
    expect(proposalRoster([seat('claude'), seat('opencode'), seat('opencode#2'), seat('codex')])).toEqual([
      { key: 'claude', name: 'CLAUDE' },
      { key: 'codex', name: 'CODEX' },
    ]);
  });

  it('keeps the opt-in seat when the predicate leaves no other: never zero seats where one can work (codex r1)', () => {
    // A work-only claude passes the launch's own check but not this predicate (it needs the council flag); the
    // fallback is decided on what is left, so opencode stays rather than leaving the job with no seat.
    expect(proposalRoster([seat('claude', { enabled_for_council: false }), seat('opencode')]).map((s) => s.key)).toEqual(['opencode']);
    expect(proposalRoster([seat('claude', { auth: 'signed_out' }), seat('opencode')]).map((s) => s.key)).toEqual(['opencode']);
  });

  it('a signed-out or work-ineligible seat is never named, the opt-in one included', () => {
    expect(proposalRoster([seat('claude', { seat_eligible_for_work: false }), seat('opencode', { auth: 'signed_out' })])).toEqual([]);
  });
});
