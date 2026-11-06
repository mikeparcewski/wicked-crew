// DES-CATALOG-002 §4.1, §4.4, §4.6, §2.5, §9.2 (ab) (Lane C) at the route level: the catalog route answers v1 exactly
// as before and v2 on `?v=2`; a plan-gate answer on a run launched from a chat proposal must name its plan revision,
// which reaches the engine's own decision (a stale one is the engine's `gate_changed`); a shaped launch is judged
// before anything starts; only a person proposes; reshape needs a run launched from a chat.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

function view(id: string, status: string, unitIx: number) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude'], status, human_confirm: 'all', unit_ix: unitIx, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  };
}

describe('Lane C routes', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  let engineRefuses: string | null = null;
  let actor: Actor = { id: 'local', kind: 'human', trust: 'admin' };
  const audit = { record: vi.fn(() => Date.now()) } as unknown as AuditLog;
  const timing = new RunTimingIndex();

  beforeAll(async () => {
    timing.noteLaunchFacts('run-chat', { fromProposal: 'c1:p:abc', envelope: { words: 'w', deliver: 'none', chatId: 'c1' } });
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-chat', 'awaiting_human', 1), view('run-plain', 'awaiting_human', 1)]),
      sessions: vi.fn().mockResolvedValue(['run-chat', 'run-plain']),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      workflowCatalog: async () => ({ workflows: BUILTIN_WORKFLOWS, unavailable: [] }),
      listPresets: async () => [],
      catalog: async () => [],
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 1, gate_kind: 'plan_approval', prompt: 'Approve the plan?', created_at: '2026-11-05T10:00:00Z' }]),
      runEvents: vi.fn(async () => null),
      supportsPlanSendBack: () => true,
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        if (engineRefuses !== null) throw new Error(engineRefuses);
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      (req as unknown as { actor: Actor }).actor = actor;
    });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' }, { runTimingIndex: timing });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    engineRefuses = null;
    actor = { id: 'local', kind: 'human', trust: 'admin' };
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = (id: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: body });

  it('(ab) a plan answer on a run started from a chat proposal must name its plan revision; a Reject need not', async () => {
    const res = await gate('run-chat', { approve: true, ord: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 1 });
    expect(confirmCalls).toEqual([]);
    const reject = await gate('run-chat', { approve: false, ord: 1 });
    expect(reject.statusCode).toBe(200);
    // Any other run keeps today's rule.
    expect((await gate('run-plain', { approve: true, ord: 1 })).statusCode).toBe(200);
  });

  it('(ab) ord and planRev reach the engine, which judges them inside its own decision', async () => {
    const res = await gate('run-chat', { approve: true, ord: 1, planRev: 2 });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls[0]).toEqual(['run-chat', true, undefined, undefined, undefined, undefined, { ord: 1, planRev: 2 }]);
    engineRefuses = 'gate_changed: plan rev 3 is open, not 2';
    const stale = await gate('run-chat', { approve: true, ord: 1, planRev: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'gate_changed', openOrd: 1 });
    // A send-back carries the person's words with the revision.
    engineRefuses = null;
    await gate('run-plain', { approve: false, action: 'request_changes', amend: 'add a rollback step', ord: 1, planRev: 1 });
    expect(confirmCalls.at(-1)).toEqual(['run-plain', false, 'add a rollback step', 'request_changes', undefined, undefined, { ord: 1, planRev: 1 }]);
  });

  it('(codex 15) every other way to approve a chat-launched plan is refused: it is answered by its version', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-chat/resume', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed' });
    expect(confirmCalls).toEqual([]);
  });

  it('the catalog answers v1 unchanged without `v`, v2 on `v=2`, and refuses another version', async () => {
    const v1 = await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog' });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).not.toHaveProperty('version');
    expect(v1.json()).toHaveProperty('entries');
    const v2 = await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog?v=2' });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toMatchObject({ version: 2, rev: expect.any(String) });
    expect((await app.inject({ method: 'GET', url: '/api/v1/workflows/catalog?v=3' })).statusCode).toBe(400);
  });

  it('a shaped launch that names another workflow is a 400 before anything starts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'fix it', workflow: 'feature', shape: { card: 'bug', option: null, depth: null, by: 'person', catalogRev: 'x' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'shape_mismatch' });
  });

  it('only a person proposes a job; reshape needs a run launched from a chat proposal', async () => {
    actor = { id: 'bot', kind: 'agent', trust: 'operator' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/chats/c1/proposals', payload: { card: 'bug', source: 'pick', requestId: 'r1' } });
    expect([403, 404]).toContain(res.statusCode);
    actor = { id: 'local', kind: 'human', trust: 'admin' };
    const reshape = await app.inject({ method: 'POST', url: '/api/v1/runs/run-plain/reshape', payload: { card: 'feature', requestId: 'x1' } });
    expect([404, 409]).toContain(reshape.statusCode);
    if (reshape.statusCode === 409) expect(reshape.json()).toMatchObject({ code: 'reshape_not_chat' });
  });
});
