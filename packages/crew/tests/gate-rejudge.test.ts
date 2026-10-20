// (rejudge, api-types 0.134.0) A gate whose unit no judge could rule on (`judge_unavailable`) can
// RE-RUN ITS JUDGE: `{approve: true, action: 'rejudge'}`. The gate read says beforehand whether that
// can work now — `GET /runs/:id/gate` carries `rejudge: {available, eligible, missing}` from the
// engine's own judge selection (`rejudgeReadiness`) — and only on such a gate. The decision itself is
// the engine's to refuse (no eligible seat, any other gate): a 409 with its words, the gate open.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter, type RejudgeReadiness } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const PROMPT =
  'Unit 4 could not be judged — no eligible judge seat remained: agent judge could not run — every eligible judge seat failed: pi (no_seat_image). ' +
  'The work was not rejected. Approve to judge it yourself (it counts, labelled "judged by operator"), re-run the judge on the same work once a judge seat can rule (action `rejudge`; the step does not run again), request changes to send it back for rework, or reject to cancel the run';

function view(id: string, denialSource: string) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'pi', 'opencode'], status: 'awaiting_human', human_confirm: 'none', unit_ix: 3, attempt: 2,
      workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [
      { id: `${id}:fix`, session_id: id, ord: 4, description: 'fix', status: 'rejected', assigned_cli: 'claude', denial: { source: denialSource, reason: 'x' } },
    ],
  };
}

const READY: RejudgeReadiness = {
  applies: true, available: true, ord: 4, eligible: ['pi', 'agy'],
  missing: [{ seat: 'claude', reason: 'built this work' }, { seat: 'opencode', reason: 'benched for this run: quota_exhausted (no success in the run)' }],
  reason: 'agent judge could not run',
};

describe('GET /runs/:id/gate — the re-judge offer', () => {
  let app: FastifyInstance;
  let readiness: RejudgeReadiness | null = READY;
  const readinessCalls: string[] = [];

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-judge', 'judge_unavailable'),
        view('run-reject', 'agent_validator'),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 4, prompt: PROMPT, gate_kind: 'escalation', created_at: 1_785_614_004_730 }]),
      runEvents: vi.fn(async () => []),
      rejudgeReadiness: vi.fn(async (id: string) => {
        readinessCalls.push(id);
        return readiness;
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    readiness = READY;
    readinessCalls.length = 0;
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  it('a judge_unavailable gate with an eligible judge seat offers the re-run, naming the seats', async () => {
    expect(await gate('run-judge')).toMatchObject({
      ord: 4,
      rejudge: { available: true, eligible: ['pi', 'agy'], missing: READY.missing },
    });
    expect(readinessCalls).toEqual(['run-judge']);
  });

  it('with no eligible seat the offer says so and which seats are missing, and why', async () => {
    readiness = { ...READY, available: false, eligible: [], missing: [{ seat: 'pi', reason: 'benched for this run: quota_exhausted' }] };
    const body = await gate('run-judge');
    expect(body['rejudge']).toEqual({ available: false, eligible: [], missing: [{ seat: 'pi', reason: 'benched for this run: quota_exhausted' }] });
  });

  it('any other gate carries no offer — a judge that RULED is never re-asked — and the engine is not asked', async () => {
    expect(await gate('run-reject')).not.toHaveProperty('rejudge');
    expect(readinessCalls).toEqual([]);
  });

  it('an engine answer for another gate (the run moved on) or one that does not apply offers nothing', async () => {
    readiness = { ...READY, ord: 5 };
    expect(await gate('run-judge')).not.toHaveProperty('rejudge');
    readiness = { ...READY, applies: false, available: false };
    expect(await gate('run-judge')).not.toHaveProperty('rejudge');
    readiness = null; // an addon without the binding
    expect(await gate('run-judge')).not.toHaveProperty('rejudge');
  });
});

describe('GET /runs/:id/gate — the offer rides a cached gate too', () => {
  let app: FastifyInstance;
  const sessionsDetail = vi.fn().mockResolvedValue([view('run-cached', 'judge_unavailable')]);

  beforeAll(async () => {
    const gateCache = new GateCache();
    gateCache.ingest({ type: 'awaitingHuman', session: 'run-cached', ord: 4, prompt: PROMPT, gateKind: 'escalation' } as unknown as CoreEvent);
    const mockAdapter = {
      sessionsDetail,
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 4, prompt: PROMPT, gate_kind: 'escalation', created_at: 1_785_614_004_730 }]),
      runEvents: vi.fn(async () => []),
      rejudgeReadiness: vi.fn(async () => READY),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('a cache hit serves the receipt and the offer from one read of the gated unit', async () => {
    sessionsDetail.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-cached/gate' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4, gateKind: 'escalation', rejudge: { available: true, eligible: ['pi', 'agy'] } });
    expect(sessionsDetail).toHaveBeenCalledTimes(1);
  });
});

describe('POST /runs/:id/gate — `rejudge` reaches the engine, which may refuse it', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  let refuse: string | null = null;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-judge', 'judge_unavailable')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        if (refuse !== null) throw new Error(refuse);
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    refuse = null;
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/runs/run-judge/gate', payload: body });

  it('`rejudge` is approve-shaped and carries nothing else to confirmGate', async () => {
    const res = await post({ approve: true, action: 'rejudge' });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toEqual([['run-judge', true, undefined, 'rejudge', undefined, undefined]]);
    expect((await post({ approve: false, action: 'rejudge' })).statusCode).toBe(400);
    expect((await post({ approve: true, action: 'rejudge', amend: 'look again' })).statusCode).toBe(400);
  });

  it("the engine's refusal (no eligible judge seat) is a 409 with its words", async () => {
    refuse = 'no judge seat can rule on unit 4 now — pi (benched for this run: quota_exhausted) — sign a seat distinct from the work\'s authors in, then re-run the judge';
    const res = await post({ approve: true, action: 'rejudge' });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe(refuse);
  });
});
