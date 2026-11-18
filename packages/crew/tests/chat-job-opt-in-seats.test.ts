// F43 (e2e-1105): a chat job proposed opencode as a helper, and its Start then 409'd `helper_unavailable`, while
// Generate it on the same repository left opencode out. The pool a job is drawn from when nobody chose is the default
// launch roster (`defaultLaunchRoster`) over the seats that can work now. crew#1590: the seats a job may NAME
// (`rosterEligible`) keep opt-in seats, so a pick, a lead or a named seat is the opt-in. Driven through the real routes.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { launchRosterNaming, proposalRoster } from '../src/api/routes.js';
import { jobSeatPool } from '../src/core/job-seats.js';
import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];

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
    // The settings file the strict `newWorkSeats` reader reads (absent = nothing picked).
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(scratch, 'settings.json');
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
    if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
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

  const pick = (seats: string[] | null): void => {
    const file = process.env['WICKED_CREW_SYSTEM_SETTINGS']!;
    if (seats === null) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify({ newWorkSeats: seats }));
  };
  const start = async (p: ChatProposalView['proposal'], edits?: Record<string, unknown>) => {
    const chatId = `opt-in-${n}`;
    const before = launches.length;
    const go = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(p.pid)}`, payload: { decision: 'go', ...(edits !== undefined ? { edits } : {}) } });
    expect(go.statusCode, go.body).toBeLessThan(300);
    expect(launches.length).toBe(before + 1);
    const launched = launches.at(-1)!;
    expect(launched.clisJson, 'the launch carries the card\'s roster').toBeDefined();
    return (JSON.parse(launched.clisJson!) as Array<{ key: string }>).map((s) => s.key);
  };

  it('(crew#1590) picking opencode for new work is the opt-in: the job names it, and Start hands the engine it', async () => {
    onlyOpencode = false;
    pick(['claude', 'codex', 'opencode']);
    try {
      const p = await proposed(['claude', 'codex', 'pi', 'opencode']);
      expect([...(p.seats?.keys ?? [])].sort()).toEqual(['claude', 'codex', 'opencode']);
      expect(p.blocked, JSON.stringify(p)).toBeNull();
      expect((await start(p)).sort()).toEqual(['claude', 'codex', 'opencode']);
    } finally {
      pick(null);
    }
  });

  it('(crew#1590) with nothing picked, naming opencode on the job at Start is the opt-in: it is launched with the seats named', async () => {
    onlyOpencode = false;
    const p = await proposed(['claude', 'codex', 'pi', 'opencode']);
    expect(p.seats?.keys).not.toContain('opencode');
    expect((await start(p, { seats: ['claude', 'codex', 'opencode'] })).sort()).toEqual(['claude', 'codex', 'opencode']);
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

describe('proposalRoster and the pool (F43, crew#1590): the standing predicate first, then the default launch rule where nobody chose', () => {
  const seat = (key: string, over: Record<string, unknown> = {}) => ({ key, display_name: key.toUpperCase(), enabled_for_council: true, seat_eligible_for_work: true, auth: 'signed_in', ...over });
  const pool = (rows: ReturnType<typeof seat>[], pick: string[] | null) => jobSeatPool(proposalRoster(rows), pick).pool.map((s) => s.key);

  it('the seats work may NAME keep an opt-in seat; the pool drawn from with nothing picked drops it, instances included', () => {
    const rows = [seat('claude'), seat('opencode'), seat('opencode#2'), seat('codex')];
    expect(proposalRoster(rows).map((s) => s.key)).toEqual(['claude', 'opencode', 'opencode#2', 'codex']);
    expect(pool(rows, null)).toEqual(['claude', 'codex']);
  });

  it('a pick that names an opt-in seat is the opt-in: it is in the pool, in roster order (an instance too)', () => {
    expect(pool([seat('claude'), seat('opencode'), seat('codex')], ['codex', 'opencode'])).toEqual(['opencode', 'codex']);
    expect(pool([seat('claude'), seat('opencode'), seat('opencode#2')], ['opencode#2', 'claude'])).toEqual(['claude', 'opencode#2']);
  });

  it('keeps the opt-in seat when the predicate leaves no other: never zero seats where one can work (codex r1)', () => {
    // A work-only claude passes the launch's own check but not this predicate (it needs the council flag); the
    // fallback is decided on what is left, so opencode stays rather than leaving the job with no seat.
    expect(pool([seat('claude', { enabled_for_council: false }), seat('opencode')], null)).toEqual(['opencode']);
    expect(pool([seat('claude', { auth: 'signed_out' }), seat('opencode')], null)).toEqual(['opencode']);
  });

  it('a signed-out or work-ineligible seat is never named, the opt-in one included', () => {
    expect(proposalRoster([seat('claude', { seat_eligible_for_work: false }), seat('opencode', { auth: 'signed_out' })])).toEqual([]);
  });

  it('the launch roster carries every seat the card names, an opt-in one included; a name off the roster adds nothing', () => {
    const roster = [{ key: 'claude' }, { key: 'opencode' }, { key: 'codex' }];
    expect(launchRosterNaming(roster, undefined).map((s) => s.key)).toEqual(['claude', 'codex']);
    expect(launchRosterNaming(roster, 'claude', ['claude', 'opencode']).map((s) => s.key)).toEqual(['claude', 'codex', 'opencode']);
    expect(launchRosterNaming(roster, 'opencode', ['opencode', 'claude']).map((s) => s.key)).toEqual(['claude', 'codex', 'opencode']);
    expect(launchRosterNaming(roster, 'claude', ['gone']).map((s) => s.key)).toEqual(['claude', 'codex']);
    expect(launchRosterNaming([...roster, { key: 'opencode#2' }], undefined, ['opencode#2']).map((s) => s.key)).toEqual(['claude', 'codex', 'opencode#2']);
  });
});
