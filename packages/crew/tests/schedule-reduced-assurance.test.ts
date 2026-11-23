// crew#1837: on a one-seat daemon every seat that could review recent work ran some of it, so the default
// "Review recent work" schedule was refused at every due time (no_independent_reviewer) and had no way to take the
// person's reduced assurance. Through the scheduler and the route: the refusal says how to accept, Run it now with
// `reducedAssurance: true` keeps the accept on the schedule, and the schedule's own runs launch with it.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchedulesResponse, WorkflowSchedule } from 'wicked-crew-api-types';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { loadReviewWorkflow, REVIEW_WORKFLOW } from '../src/insights/workflow.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { defaultSchedulesPath, HOUR_MS } from '../src/schedules/store.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();
const sec = (hoursAgo: number): number => Math.floor((Date.now() - hoursAgo * HOUR_MS) / 1000);

/** A run claude did in the review window, as `GET /runs` decorates the engine's view (the unit is crew-api-types
 *  `WorkUnit`, the same shape tests/insights-review.test.ts `unitOn` builds). */
function claudeRun(id: string) {
  return {
    session: { id, status: 'completed', created_at: sec(4), deliver_requested: false, delivery: 'none', archived_at: null, workflow_id: 'bug', repo_ref: 'core', title: `run ${id}`, project_id: null },
    units: [{
      id: `${id}:build`, session_id: id, ord: 1, description: 'build', stage: 'build', assigned_cli: 'claude', assigned_invocation: null,
      council_task_ref: null, routing: { method: 'primary' }, denial_reason: null, phase_ref: 'build', conformance_ref: null,
      phase_status: 'complete', collection_scope: null, status: 'done', role: 'creator',
    }],
  };
}

/** The row as the store writes it (src/schedules/store.ts `put`), due an hour ago. */
function row(over: Record<string, unknown> = {}) {
  const past = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    workflow: REVIEW_WORKFLOW, everyHours: 48, enabled: true, projectIds: [], repoRef: null, problem: null,
    nextDueAt: past, lastRunId: null, lastRunAt: null, lastOutcome: null, lastNote: null, blocked: null, failures: 0,
    createdAt: past, updatedAt: past, ...over,
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

async function boot(schedule: Record<string, unknown>, opts: { sweep: boolean }) {
  scratch = mkdtempSync(join(tmpdir(), 'schedule-reduced-assurance-'));
  const home = join(scratch, 'state-home');
  mkdirSync(home);
  setCrewStateHome(home);
  writeFileSync(defaultSchedulesPath(), JSON.stringify({ schedules: { [REVIEW_WORKFLOW]: schedule } }));
  const def = loadReviewWorkflow({ node: process.execPath, analyzeCli: join(scratch, 'analyze-cli.js'), reviewsDir: join(scratch, 'reviews') });
  const launches: LaunchRunInput[] = [];
  const launchRun = vi.fn(async (input: LaunchRunInput) => {
    launches.push(structuredClone(input));
    return input.sessionId;
  });
  const adapter = {
    dbPath: join(home, 'core.db'),
    projectsSupported: () => false,
    getSettings: async () => ({}),
    ping: async () => 'ok',
    onLaunch: () => () => undefined,
    onEvent: () => () => undefined,
    listRepos: async () => [],
    // One seat: the daemon a person signs in once.
    seatsForWorkflow: async () => [{ key: 'claude' }],
    getWorkflow: (id: string) => (id === REVIEW_WORKFLOW ? def : null),
    sessionsDetail: async () => [claudeRun('done-1')],
    runEvents: async () => [],
    launchRun,
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
    workflowSchedules: opts.sweep ? { enabled: true, sweepIntervalMs: 50 } : { enabled: true, sweepIntervalMs: 3_600_000 },
  });
  app = server;
  await server.ready();
  return { app: server, launches, launchRun };
}

async function schedule(a: FastifyInstance): Promise<WorkflowSchedule> {
  const res = await a.inject({ method: 'GET', url: '/api/v1/schedules' });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as SchedulesResponse).schedules.find((s) => s.id === REVIEW_WORKFLOW)!;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe('a one-seat review schedule (crew#1837)', () => {
  it('a scheduled refusal says how to accept; Run it now answers retryWith; the accept is kept and runs it', async () => {
    const { app: a, launches, launchRun } = await boot(row(), { sweep: true });
    await until(async () => (await schedule(a)).lastOutcome === 'refused');
    const refused = await schedule(a);
    expect(refused).toMatchObject({ lastOutcome: 'refused', reducedAssurance: false, retryWith: { reducedAssurance: true } });
    expect(refused.lastNote).toMatch(/ran some of the work it reviews/u);
    expect(launchRun).not.toHaveBeenCalled();

    const plain = await a.inject({ method: 'POST', url: `/api/v1/schedules/${REVIEW_WORKFLOW}/run` });
    expect(plain.statusCode, plain.body).toBe(409);
    expect(plain.json()).toMatchObject({ code: 'no_independent_reviewer', excluded: ['claude'], retryWith: { reducedAssurance: true } });
    expect(launchRun).not.toHaveBeenCalled();

    const accepted = await a.inject({ method: 'POST', url: `/api/v1/schedules/${REVIEW_WORKFLOW}/run`, payload: { reducedAssurance: true } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ workflow: REVIEW_WORKFLOW, reducedAssurance: true });
    expect(launches[0]!.problem).toMatch(/Reduced assurance: every seat that could interpret this review ran some of the work/u);
    const kept = (accepted.json() as { schedule: WorkflowSchedule }).schedule;
    expect(kept.reducedAssurance).toBe(true);
    expect(kept).not.toHaveProperty('retryWith');
    // Durable: the store file carries the accept, so the schedule's own runs take it after a restart too.
    const file = JSON.parse(readFileSync(defaultSchedulesPath(), 'utf8')) as { schedules: Record<string, { reducedAssurance?: boolean }> };
    expect(file.schedules[REVIEW_WORKFLOW]?.reducedAssurance).toBe(true);
    const trail = await a.inject({ method: 'GET', url: '/api/v1/audit?action=schedule.saved' });
    expect((trail.json() as { entries: Array<{ detail?: Record<string, unknown> }> }).entries.at(-1)?.detail).toMatchObject({ id: REVIEW_WORKFLOW, reducedAssurance: true, via: 'run_now' });
  }, 20_000);

  it('a schedule the person accepted reduced assurance on launches at its due time with it', async () => {
    const { app: a, launches } = await boot(row({ reducedAssurance: true }), { sweep: true });
    await until(async () => launches.length > 0);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ workflow: REVIEW_WORKFLOW, reducedAssurance: true });
    expect(JSON.parse(launches[0]!.clisJson)).toEqual([{ key: 'claude' }]);
    await until(async () => (await schedule(a)).lastOutcome === 'launched');
    expect((await schedule(a)).lastOutcome).toBe('launched');
  }, 20_000);

  it('PUT takes the accept and withdraws it; a bad Run it now body is a 400', async () => {
    const { app: a } = await boot(row(), { sweep: false });
    const on = await a.inject({ method: 'PUT', url: `/api/v1/schedules/${REVIEW_WORKFLOW}`, payload: { workflow: REVIEW_WORKFLOW, everyHours: 48, reducedAssurance: true } });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ reducedAssurance: true });
    const kept = await a.inject({ method: 'PUT', url: `/api/v1/schedules/${REVIEW_WORKFLOW}`, payload: { workflow: REVIEW_WORKFLOW, everyHours: 72 } });
    expect(kept.json()).toMatchObject({ reducedAssurance: true, everyHours: 72 });
    const off = await a.inject({ method: 'PUT', url: `/api/v1/schedules/${REVIEW_WORKFLOW}`, payload: { workflow: REVIEW_WORKFLOW, everyHours: 72, reducedAssurance: false } });
    expect(off.json()).toMatchObject({ reducedAssurance: false });
    const bad = await a.inject({ method: 'POST', url: `/api/v1/schedules/${REVIEW_WORKFLOW}/run`, payload: { reducedAssurance: false } });
    expect(bad.statusCode, bad.body).toBe(400);
  }, 20_000);
});
