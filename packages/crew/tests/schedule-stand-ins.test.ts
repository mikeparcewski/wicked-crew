// crew#1884: a schedule launches with no one there to ask, so it takes stand-ins only on the consent a person already
// gave: the `standInReview: 'always'` setting (the saved author's consent, wicked-core#1930 F6). Without it, a schedule
// launches as before. A review schedule keeps its own path (a review takes no stand-ins).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { defaultSchedulesPath, HOUR_MS } from '../src/schedules/store.js';
import { removeScratch } from './setup/scratch.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const armedStateHome = crewStateHome();
const WORKFLOW = 'bug';
const SAVED = { scope: 'always', by: 'priya (human)', at: 3, via: 'setting' };

/** The row as the store writes it (src/schedules/store.ts `put`), due an hour ago. */
function row() {
  const past = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    workflow: WORKFLOW, everyHours: 48, enabled: true, projectIds: [], repoRef: null, problem: 'tidy the backlog',
    nextDueAt: past, lastRunId: null, lastRunAt: null, lastOutcome: null, lastNote: null, blocked: null, failures: 0,
    createdAt: past, updatedAt: past,
  };
}

let scratch: string | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  setCrewStateHome(armedStateHome);
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

async function boot(settings: Record<string, unknown>): Promise<LaunchRunInput[]> {
  scratch = mkdtempSync(join(tmpdir(), 'schedule-stand-ins-'));
  const home = join(scratch, 'state-home');
  mkdirSync(home);
  setCrewStateHome(home);
  writeFileSync(defaultSchedulesPath(), JSON.stringify({ schedules: { [WORKFLOW]: row() } }));
  const launches: LaunchRunInput[] = [];
  const adapter = {
    dbPath: join(home, 'core.db'),
    projectsSupported: () => false,
    getSettings: async () => settings,
    ping: async () => 'ok',
    onLaunch: () => () => undefined,
    onEvent: () => () => undefined,
    listRepos: async () => [],
    seatsForWorkflow: async () => [{ key: 'claude' }],
    getWorkflow: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null,
    listWorkflows: () => BUILTIN_WORKFLOWS,
    sessionsDetail: async () => [],
    runEvents: async () => [],
    supportsStandIns: () => true,
    launchRun: vi.fn(async (input: LaunchRunInput) => {
      launches.push(structuredClone(input));
      return input.sessionId;
    }),
    onboardedRepoOf: () => undefined,
  } as unknown as CoreAdapter;
  const server = await createServer(adapter, {
    auth: { mode: 'off' },
    seats: { signedIn: () => true },
    auditPath: join(scratch, 'audit.log'),
    evalStoreRoot: join(scratch, 'evals'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    skills: { disabled: true },
    workflowSchedules: { enabled: true, sweepIntervalMs: 50 },
  });
  app = server;
  await server.ready();
  return launches;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe('a scheduled launch and the stand-in setting (crew#1884)', () => {
  it('standInReview always: launches stand-in-aware with the saved consent', async () => {
    const launches = await boot({ standInReview: 'always', standInConsent: SAVED });
    await until(() => launches.length > 0);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.workflow).toBe(WORKFLOW);
    expect(launches[0]!.standInAware).toBe(true);
    expect(launches[0]!.standIn).toEqual(SAVED);
  }, 20_000);

  it('without it: launches as before, unaware and with no consent', async () => {
    const launches = await boot({ standInReview: 'ask' });
    await until(() => launches.length > 0);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.standInAware).toBeUndefined();
    expect(launches[0]!.standIn).toBeUndefined();
  }, 20_000);
});
