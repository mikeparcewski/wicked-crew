// crew#755: a launch that names no workflow and no plan runs the engine's free-text planner (ONE
// unit, the brief verbatim, wicked-core D-11). It used to say nothing about that, and a repo-less one
// that changed nothing then read plain `completed` — indistinguishable on the Desk from real work.
//
//   - POST /runs with neither `workflow` nor `plan` answers 201 WITH `freeText.notice`, naming what
//     was applied and how to get work done; a launch that names one carries no such field;
//   - a COMPLETED repo-less free-text run with no write root of its own could change nothing, so it
//     reads `delivery: 'vacuous'` (the existing did-nothing spelling, recovery: retry), not `none`;
//     a repo-bound free-text run already gets the vacuity probes, and a named-workflow run is unchanged.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, SessionView } from '../src/core/types.js';

function run(id: string, opts: { kind: 'free_text' | 'workflow'; status?: string; repo?: string | null; roots?: string[] }): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'what is in this repo',
      status: opts.status ?? 'completed',
      unit_ix: 1,
      workdir: null,
      repo_ref: opts.repo ?? null,
      extra_write_roots: opts.roots ?? [],
      run_identity: { kind: opts.kind, name: opts.kind === 'workflow' ? 'bug' : null, user_plan: false, system: false },
    },
    units: [{ id: `${id}:u1`, session_id: id, ord: 1, status: 'done', assigned_cli: 'claude' }],
  } as unknown as SessionView;
}

describe('a launch with no workflow says what it ran, and a run that could change nothing says so (crew#755)', () => {
  let app: FastifyInstance;
  let launchRun: Mock;
  let sessionsDetail: Mock;

  beforeEach(async () => {
    launchRun = vi.fn(async (input: LaunchRunInput) => input.sessionId);
    sessionsDetail = vi.fn().mockResolvedValue([]);
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        launchRun,
        sessionsDetail,
        sessions: vi.fn().mockResolvedValue([]),
        listWorkflows: () => [],
        listRepos: vi.fn().mockResolvedValue([]),
        projectMembers: vi.fn().mockResolvedValue([]),
        projectMemberAttach: vi.fn(),
        projectMemberDetach: vi.fn(),
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('POST /runs with neither workflow nor plan answers 201 naming the free-text planner it applied', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'what is in this repo' } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { runId: string; freeText?: { notice: string } };
    expect(body.freeText?.notice).toMatch(/no workflow or plan/i);
    expect(body.freeText?.notice).toMatch(/free-text planner/);
    expect(body.freeText?.notice).toMatch(/GET \/workflows/);
  });

  it('a launch that names a workflow carries no freeText field', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', workflow: 'bug' } });
    expect(res.statusCode, res.body).toBe(201);
    expect('freeText' in (res.json() as object)).toBe(false);
  });

  it('a completed repo-less free-text run with no write root reads vacuous; others keep their delivery', async () => {
    sessionsDetail.mockResolvedValue([
      run('ft-empty', { kind: 'free_text' }),
      run('ft-roots', { kind: 'free_text', roots: ['/x/inbox'] }),
      run('ft-live', { kind: 'free_text', status: 'executing' }),
      run('wf-done', { kind: 'workflow' }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode, res.body).toBe(200);
    const runs = (res.json() as { runs: SessionView[] }).runs;
    const delivery = Object.fromEntries(runs.map((v) => [v.session.id, (v.session as { delivery?: string }).delivery]));
    expect(delivery).toEqual({ 'ft-empty': 'vacuous', 'ft-roots': 'none', 'ft-live': 'none', 'wf-done': 'none' });
    const one = await app.inject({ method: 'GET', url: '/api/v1/runs/ft-empty' });
    expect((one.json() as { run: SessionView }).run.session).toMatchObject({ delivery: 'vacuous' });
  });
});
