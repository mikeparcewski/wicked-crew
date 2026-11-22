// crew#1608: a review refused before the engine launch still appears in Insights.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InsightsResponse, SchedulesResponse } from 'wicked-crew-api-types';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { loadReviewWorkflow, REVIEW_WORKFLOW } from '../src/insights/workflow.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { defaultSchedulesPath, HOUR_MS } from '../src/schedules/store.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();

describe('a refused scheduled review (server)', () => {
  let scratch: string;
  let app: FastifyInstance;
  const launchRun = vi.fn(async () => { throw new Error('a refused review must never reach launchRun'); });

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'schedule-refused-review-'));
    const home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);
    const past = new Date(Date.now() - HOUR_MS).toISOString();
    writeFileSync(defaultSchedulesPath(), JSON.stringify({
      schedules: {
        [REVIEW_WORKFLOW]: {
          workflow: REVIEW_WORKFLOW,
          everyHours: 48,
          enabled: true,
          projectIds: [],
          repoRef: null,
          problem: null,
          nextDueAt: past,
          failures: 0,
          lastRunId: null,
          lastRunAt: null,
          lastOutcome: null,
          lastNote: null,
          blocked: null,
          createdAt: past,
          updatedAt: past,
        },
      },
    }));
    const def = loadReviewWorkflow({ node: process.execPath, analyzeCli: join(scratch, 'analyze-cli.js'), reviewsDir: join(scratch, 'reviews') });
    const adapter = {
      dbPath: join(home, 'core.db'),
      projectsSupported: () => false,
      getSettings: async () => ({}),
      ping: async () => 'ok',
      onLaunch: () => () => undefined,
      onEvent: () => () => undefined,
      listRepos: async () => [],
      seatsForWorkflow: async () => [],
      getWorkflow: (id: string) => id === REVIEW_WORKFLOW ? def : null,
      sessionsDetail: async () => [],
      launchRun,
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter;

    app = await createServer(adapter, {
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
    await app.ready();
  }, 150_000);

  afterAll(async () => {
    await app?.close();
    setCrewStateHome(armedStateHome);
    if (scratch !== undefined) removeScratch(scratch);
  });

  const insights = async (): Promise<InsightsResponse> => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/insights' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as InsightsResponse;
  };

  it('records one failed review, preserves the back-off across sweeps, and records Run it now separately', async () => {
    const deadline = Date.now() + 8_000;
    let body = await insights();
    while (body.reviews.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      body = await insights();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    body = await insights();
    expect(body.reviews).toHaveLength(1);
    const review = body.reviews[0]!;
    expect(review).toMatchObject({ status: 'failed', trigger: 'schedule', scheduleId: REVIEW_WORKFLOW });
    expect(review.endedAt).not.toBeNull();
    expect(review.error).toMatch(/the review could not be prepared: no signed-in, eligible agent seat/);
    expect(body.running).toBe(false);

    const schedules = await app.inject({ method: 'GET', url: '/api/v1/schedules' });
    expect(schedules.statusCode, schedules.body).toBe(200);
    const rows = (schedules.json() as SchedulesResponse).schedules;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ id: REVIEW_WORKFLOW, lastOutcome: 'refused', failures: 1, lastRunId: null, lastRunAt: null });
    expect(Math.abs(Date.parse(row.nextDueAt) - Date.parse(review.launchedAt) - 2 * HOUR_MS)).toBeLessThan(5_000);
    expect(launchRun).not.toHaveBeenCalled();

    const runNow = await app.inject({ method: 'POST', url: `/api/v1/schedules/${REVIEW_WORKFLOW}/run` });
    expect(runNow.statusCode, runNow.body).toBe(409);
    expect(runNow.json().error).toMatch(/the review could not be prepared: no signed-in, eligible agent seat/);
    const after = await insights();
    expect(after.reviews).toHaveLength(2);
    const manual = after.reviews.find((r) => r.trigger === 'manual');
    expect(manual).toMatchObject({ status: 'failed', scheduleId: REVIEW_WORKFLOW });
    expect(manual?.endedAt).not.toBeNull();
    expect(manual?.error).toMatch(/the review could not be prepared: no signed-in, eligible agent seat/);
    expect(manual?.runId).not.toBe(review.runId);
    expect(after.running).toBe(false);
    expect(launchRun).not.toHaveBeenCalled();

    // (crew#1656) The scheduled refusal is on the activity trail, once; the person's Run it now answered its own.
    const trail = await app.inject({ method: 'GET', url: '/api/v1/audit?action=schedule.launch_refused' });
    expect(trail.statusCode, trail.body).toBe(200);
    const entries = (trail.json() as { entries: Array<{ actor: { id: string }; detail?: Record<string, unknown> }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor.id).toBe('workflow-schedule');
    expect(entries[0]!.detail).toMatchObject({ id: REVIEW_WORKFLOW, workflow: REVIEW_WORKFLOW, trigger: 'schedule' });
    expect(String(entries[0]!.detail?.['reason'])).toMatch(/no signed-in, eligible agent seat/);
  }, 20_000);
});
