// crew#311 defect 2 — POST /runs/:id/resume on a TERMINAL run.
//
// The engine's `resume_run` no-ops on a completed/cancelled run and answers the status token,
// so the route used to reply `200 {"status":"cancelled"}` — on the exact runs an operator was
// trying to rescue after killing wedged workers, the recovery affordance read as "resume
// destroyed my run". Pins:
//
//   - a CANCELLED run is refused 409 with `recovery: 'retry'` (the actual path: a retry
//     launch, `POST /runs {"retryOf":"<id>"}`), and the engine's resumeRun is NEVER invoked;
//   - a COMPLETED run whose work is stranded in its worktree is refused 409 with
//     `recovery: 'deliver'` (post-hoc `POST /runs/:id/deliver`);
//   - a COMPLETED-but-VACUOUS run (crew#311 defect 1's wire spelling: worktree carries no
//     contribution) is refused 409 with `recovery: 'retry'` and the word "vacuous" — there is
//     nothing to deliver;
//   - a completed repo-less run is refused 409 with `recovery: 'retry'`;
//   - a FAILED run still resumes from the cursor (200 + the engine's status) — failed is not
//     terminal for resume;
//   - an AWAITING_HUMAN run still routes through confirmGate (the gated-resume approval path)
//     — the terminal check must not intercept it.
//
// Fastify inject() with a mock adapter (no NAPI), mirroring run-delivery-field.test.ts.

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ResumeRefusal } from 'wicked-crew-api-types';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
  resumeRun: ReturnType<typeof vi.fn>;
  confirmGate: ReturnType<typeof vi.fn>;
};

function view(
  id: string,
  over: { status?: string; repo_ref?: string | null; workdir?: string | null } = {},
): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: over.workdir ?? null,
      repo_ref: over.repo_ref ?? null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

function adapterFor(views: SessionView[]): MockAdapter {
  return {
    sessionsDetail: vi.fn().mockResolvedValue(views),
    sessions: vi.fn().mockResolvedValue(views.map((v) => v.session.id)),
    resumeRun: vi.fn().mockResolvedValue('executing'),
    confirmGate: vi.fn().mockResolvedValue('executing'),
  };
}

function buildApp(
  mockAdapter: MockAdapter,
  opts: {
    worktreeExists?: (p: string) => boolean;
    worktreeIsClean?: (p: string) => Promise<boolean>;
    runBranchIsEmpty?: (repoRef: string, runId: string) => Promise<boolean>;
  } = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex: new DeliveryIndex(),
      ...(opts.worktreeExists !== undefined ? { worktreeExists: opts.worktreeExists } : {}),
      ...(opts.worktreeIsClean !== undefined ? { worktreeIsClean: opts.worktreeIsClean } : {}),
      ...(opts.runBranchIsEmpty !== undefined ? { runBranchIsEmpty: opts.runBranchIsEmpty } : {}),
    },
  );
  return app;
}

async function resume(app: FastifyInstance, id: string) {
  await app.ready();
  const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/resume` });
  return { code: res.statusCode, body: res.json() as ResumeRefusal & { status?: string } };
}

describe('crew#311 defect 2 — resume refuses terminal runs with the recovery named', () => {
  it('a cancelled run: 409, recovery retry, engine resume NEVER invoked', async () => {
    const adapter = adapterFor([view('run-c', { status: 'cancelled' })]);
    const app = buildApp(adapter);
    try {
      const { code, body } = await resume(app, 'run-c');
      expect(code).toBe(409);
      expect(body.recovery).toBe('retry');
      expect(body.error).toContain('cancelled');
      expect(body.error).toContain('"retryOf":"run-c"');
      expect(adapter.resumeRun).not.toHaveBeenCalled();
      expect(adapter.confirmGate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a completed STRANDED run: 409, recovery deliver, pointing at POST /runs/:id/deliver', async () => {
    const adapter = adapterFor([view('run-s', { repo_ref: 'repo-1', workdir: '/wt' })]);
    const app = buildApp(adapter, {
      worktreeExists: () => true,
      worktreeIsClean: async () => false,
    });
    try {
      const { code, body } = await resume(app, 'run-s');
      expect(code).toBe(409);
      expect(body.recovery).toBe('deliver');
      expect(body.error).toContain('/runs/run-s/deliver');
      expect(adapter.resumeRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a completed VACUOUS run: 409, recovery retry, and the refusal says vacuous', async () => {
    const adapter = adapterFor([view('run-v', { repo_ref: 'repo-1', workdir: '/wt' })]);
    const app = buildApp(adapter, {
      worktreeExists: () => true,
      worktreeIsClean: async () => true,
    });
    try {
      const { code, body } = await resume(app, 'run-v');
      expect(code).toBe(409);
      expect(body.recovery).toBe('retry');
      expect(body.error.toLowerCase()).toContain('vacuous');
      expect(body.error).toContain('"retryOf":"run-v"');
      expect(adapter.resumeRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a completed VACUOUS run whose worktree was already REAPED: 409, recovery retry, says vacuous', async () => {
    // The FINDING-003 shape a vacuous completion normally lands in: worktree gone, run branch
    // carrying nothing.
    const adapter = adapterFor([view('run-r', { repo_ref: 'repo-1', workdir: '/gone' })]);
    const app = buildApp(adapter, {
      worktreeExists: () => false,
      runBranchIsEmpty: async () => true,
    });
    try {
      const { code, body } = await resume(app, 'run-r');
      expect(code).toBe(409);
      expect(body.recovery).toBe('retry');
      expect(body.error.toLowerCase()).toContain('vacuous');
      expect(adapter.resumeRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a completed repo-less run: 409, recovery retry', async () => {
    const adapter = adapterFor([view('run-d')]);
    const app = buildApp(adapter);
    try {
      const { code, body } = await resume(app, 'run-d');
      expect(code).toBe(409);
      expect(body.recovery).toBe('retry');
      expect(adapter.resumeRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('a FAILED run still resumes from the cursor (failed is not terminal for resume)', async () => {
    const adapter = adapterFor([view('run-f', { status: 'failed' })]);
    const app = buildApp(adapter);
    try {
      const { code, body } = await resume(app, 'run-f');
      expect(code).toBe(200);
      expect(body.status).toBe('executing');
      expect(adapter.resumeRun).toHaveBeenCalledWith('run-f');
    } finally {
      await app.close();
    }
  });

  it('an AWAITING_HUMAN run still routes through confirmGate (gated resume untouched)', async () => {
    const adapter = adapterFor([view('run-g', { status: 'awaiting_human' })]);
    const app = buildApp(adapter);
    try {
      const { code, body } = await resume(app, 'run-g');
      expect(code).toBe(200);
      expect(body.status).toBe('executing');
      expect(adapter.confirmGate).toHaveBeenCalledWith('run-g', true);
      expect(adapter.resumeRun).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('an unknown run stays a 404', async () => {
    const adapter = adapterFor([]);
    const app = buildApp(adapter);
    try {
      const { code } = await resume(app, 'run-x');
      expect(code).toBe(404);
    } finally {
      await app.close();
    }
  });
});
