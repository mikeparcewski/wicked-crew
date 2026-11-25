// (J6 K1, coord round 2 F1-F4) Every way to start a domain model run either carries its scope or is refused at the
// first step in words a person can act on: a chat job's Start (the words are the scope), the CLI's `--problem`, MCP's
// `problem`, and a schedule (refused when it is saved: no one is there to say what the model covers).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatProposalView } from 'wicked-crew-api-types';

import { AuditLog } from '../src/api/audit.js';
import { domainScopeOfWords } from '../src/api/domain-model.js';
import { createServer } from '../src/api/server.js';
import { launchRunToolBody } from '../src/cli/mcp.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { registerScheduleRoutes } from '../src/schedules/routes.js';
import type { WorkflowScheduler } from '../src/schedules/scheduler.js';
import { ScheduleStore } from '../src/schedules/store.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

// The installed addon decides whether a scope can ride a launch; the launch paths are what is tested here.
vi.mock('../src/core/adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/adapter.js')>()),
  addonSupportsDomainScope: () => true,
}));

const WORDS = 'How PAYCALC1 computes pay from the payroll file';

describe('the words are the scope', () => {
  it('takes the trimmed words, and refuses none or too many with how to fix it', () => {
    expect(domainScopeOfWords(`  ${WORDS} `, 'fix it')).toEqual({ scope: { intent: WORDS } });
    expect(domainScopeOfWords(' ', 'say it in this chat')).toEqual({ refusal: 'a domain model run needs to know what it should cover (a program, a job or a feature): say it in this chat' });
    expect(domainScopeOfWords('x'.repeat(2001), 'fix it')).toEqual({ refusal: 'say what the model should cover in at most 2,000 characters (these words have 2,001): fix it' });
  });
});

describe('MCP launch_run (F3)', () => {
  it('a domain-extraction launch carries `problem` as its scope; other workflows are unchanged', () => {
    expect(launchRunToolBody({ problem: WORDS, workflow: 'domain-extraction', repo: 'r1' }))
      .toEqual({ body: { problem: WORDS, workflow: 'domain-extraction', domainScope: { intent: WORDS }, repoRef: 'r1' } });
    expect(launchRunToolBody({ problem: 'fix the 500', workflow: 'bug' })).toEqual({ body: { problem: 'fix the 500', workflow: 'bug' } });
    expect(launchRunToolBody({ problem: 'x'.repeat(2001), workflow: 'domain-extraction' })).toMatchObject({ refusal: expect.stringMatching(/at most 2,000 characters/) });
  });
});

describe('CLI start (F2)', () => {
  it('refuses a domain-extraction start with no --problem before anything starts, saying the flag', () => {
    const home = mkdtempSync(join(tmpdir(), 'domain-cli-'));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli', 'index.ts'), 'start', '--workflow', 'domain-extraction', '--port', '1'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, HOME: home, WICKED_HOME: home, WICKED_CREW_STATE_HOME: join(home, 'crew') },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain('a domain model run needs to know what it should cover (a program, a job or a feature): wicked-crew start --workflow domain-extraction --problem "<what the model should cover>"');
    } finally {
      removeScratch(home);
    }
  }, 70_000);
});

describe('a schedule (F4)', () => {
  it('refuses to save a domain-extraction schedule, in words; another workflow saves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'domain-schedule-'));
    const app = Fastify();
    try {
      registerScheduleRoutes(app, {
        store: new ScheduleStore(join(dir, 'schedules.json')),
        scheduler: {} as WorkflowScheduler,
        knowsWorkflow: () => true,
        lastReview: () => null,
        audit: AuditLog.noop(),
        now: () => new Date('2026-11-25T00:00:00Z'),
      });
      const refused = await app.inject({ method: 'PUT', url: '/api/v1/schedules/map-it', payload: { workflow: 'domain-extraction', everyHours: 24 } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({
        code: 'workflow_not_schedulable',
        error: "a domain model run covers what a person says it should and is started by them (a repository's Requirements: Map the domain); it cannot run on a schedule",
      });
      expect((await app.inject({ method: 'GET', url: '/api/v1/schedules' })).json().schedules.some((s: { id: string }) => s.id === 'map-it')).toBe(false);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/schedules/fix-it', payload: { workflow: 'bug', everyHours: 24 } })).statusCode).toBe(200);
    } finally {
      await app.close();
      removeScratch(dir);
    }
  });
});

const armedStateHome = crewStateHome();

describe("a chat job's Start of a domain model (F1)", () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const runs: string[] = [];
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
    listRepos: async () => [{ id: 'r-pay', name: 'payroll', root_path: join(scratch, 'repo-pay'), default_branch: 'main', registered_at: 1 }],
    projectGet: async (id: string) => (id === 'p-pay' ? { id, name: 'Payroll', status: 'active', description: null, scope: `project:${id}`, created_at: 1, updated_at: 1 } : null),
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
    listPresets: async () => [{ name: 'domain-extraction', scope: 'global', steps: [{ id: 'domain-run', executor: { type: 'tool' } }], created_by: 'builtin', updated_at: 1 }],
    supportsPowerMode: () => false,
    chatClose: async () => undefined,
    chatList: async () => [],
    onboardedRepoOf: () => undefined,
  }) as unknown as CoreAdapter;

  beforeAll(async () => {
    vi.spyOn(CoreAdapter, 'judgeCoverage').mockReturnValue(JSON.stringify({ covered: true, singleIdentity: false, authors: [], benched: [] }));
    scratch = mkdtempSync(join(tmpdir(), 'chat-domain-start-'));
    home = join(scratch, 'state-home');
    mkdirSync(home);
    mkdirSync(join(scratch, 'repo-pay'));
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
    vi.restoreAllMocks();
    await app.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  const proposal = async (chatId: string, words: string): Promise<ChatProposalView['proposal']> => {
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId, clis: ['claude', 'codex'], repoRefs: ['r-pay'], projectId: 'p-pay', accepts: ['job'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/messages`, payload: { text: 'map the domain of payroll' } });
    expect(sent.statusCode, sent.body).toBe(202);
    for (const fn of listeners) fn({ type: 'chatReply', chat: chatId, cliKey: 'claude', text: 'A domain map fits.', ok: true } as unknown as CoreEvent);
    await new Promise((r) => setTimeout(r, 50));
    const made = await app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals`, payload: { card: 'analyze-codebase', option: 'domain', source: 'pick', requestId: 'r1', words } });
    expect(made.statusCode, made.body).toBe(201);
    const p = (made.json() as { view: ChatProposalView }).view.proposal;
    expect(p.blocked, JSON.stringify(p)).toBeNull();
    return p;
  };
  const start = (chatId: string, pid: string) =>
    app.inject({ method: 'POST', url: `/api/v1/chats/${chatId}/proposals/${encodeURIComponent(pid)}`, payload: { decision: 'go' } });

  it("hands the engine the person's words as the scope of the model", async () => {
    const p = await proposal('domain-start-1', WORDS);
    const go = await start('domain-start-1', p.pid);
    expect(go.statusCode, go.body).toBe(200);
    const launched = launches.at(-1)!;
    expect(launched.workflow).toBe('domain-extraction');
    expect(JSON.parse(launched.domainScopeJson ?? 'null')).toEqual({ intent: WORDS });
  });

  it('refuses words too long to be a scope, saying so, and launches nothing', async () => {
    const p = await proposal('domain-start-2', `map ${'the payroll rules '.repeat(120)}`);
    const before = launches.length;
    const go = await start('domain-start-2', p.pid);
    expect(go.statusCode).not.toBe(200);
    expect(go.body).toContain('say what the model should cover in at most 2,000 characters');
    expect(go.body).toContain('say it in this chat, then press Start again');
    expect(go.body).not.toMatch(/Invalid request body|domainScope/);
    expect(launches).toHaveLength(before);
  });
});
