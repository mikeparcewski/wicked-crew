// wicked-core#469 / #467 — the escalation arms of `POST /runs/:id/gate`.
//
// A floor that did not finish (`repo_checks_timeout`) is answered with `extend`, `targeted` or
// `accept_partial`; an evaluator's discarded, pinned edit with `accept_suggestion`. All four are
// approve-shaped and carry nothing else: the schema refuses `approve: false` and any amend /
// amendScope / plan beside them (a 400 naming the rule), and the route passes the token through
// `confirmGate(id, true, undefined, action, undefined, undefined)`. The ENGINE decides whether the
// open gate is one the arm answers; its refusal is the route's 409.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDecision } from 'wicked-crew-api-types';

import { ESCALATION_ACTIONS, GateSchema, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { BUILTIN_WORKFLOWS, type CoreAdapter } from '../src/core/adapter.js';

describe('GateSchema — the escalation arms', () => {
  it.each(ESCALATION_ACTIONS)('`%s` with approve: true and nothing else parses', (action) => {
    const body: GateDecision = { approve: true, action };
    expect(GateSchema.safeParse(body).success).toBe(true);
    expect(GateSchema.safeParse({ ...body, ord: 3 }).success).toBe(true);
  });

  it.each(ESCALATION_ACTIONS)('`%s` with approve: false is refused by the rule naming action and approve', (action) => {
    const r = GateSchema.safeParse({ approve: false, action });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /action/.test(i.message) && /approve/.test(i.message))).toBe(true);
  });

  it.each(ESCALATION_ACTIONS)('`%s` beside an amend or amendScope is refused — the arm takes nothing else', (action) => {
    for (const extra of [{ amend: 'also fix the lint' }, { amendScope: 'creator' as const }]) {
      const r = GateSchema.safeParse({ approve: true, action, ...extra });
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.some((i) => /take no amend, amendScope or plan/.test(i.message))).toBe(true);
    }
  });

  it('core#820: a consent choice `consent:<id>` is an approve-shaped arm too; a bare or malformed one is refused', () => {
    const ok: GateDecision = { approve: true, action: 'consent:worker' };
    expect(GateSchema.safeParse(ok).success).toBe(true);
    expect(GateSchema.safeParse({ approve: true, action: 'consent:operator', ord: 7 }).success).toBe(true);
    expect(GateSchema.safeParse({ approve: false, action: 'consent:worker' }).success).toBe(false);
    expect(GateSchema.safeParse({ approve: true, action: 'consent:worker', amend: 'x' }).success).toBe(false);
    expect(GateSchema.safeParse({ approve: true, action: `consent:${'x'.repeat(32)}` }).success).toBe(true);
    for (const bad of ['consent:', 'consent:a b', 'consent:../x', `consent:${'x'.repeat(33)}`]) {
      expect(GateSchema.safeParse({ approve: true, action: bad }).success, bad).toBe(false);
    }
  });

  it('an unknown arm is still refused', () => {
    expect(GateSchema.safeParse({ approve: true, action: 'extend_forever' }).success).toBe(false);
  });
});

function view(id: string, status: string) {
  return {
    session: {
      id,
      workflow_id: 'bug',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude', 'codex'],
      status,
      human_confirm: 'none',
      unit_ix: 2,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

describe('POST /runs/:id/gate — the escalation arms reach the engine', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  let refuse: string | null = null;
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-gated', 'awaiting_human')]),
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
      audit,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    recorded.length = 0;
    refuse = null;
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/runs/run-gated/gate', payload: body });

  it.each(ESCALATION_ACTIONS)('`%s` → 200, confirmGate(id, true, undefined, action, undefined, undefined), audited with the arm', async (action) => {
    const res = await gate({ approve: true, action });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toEqual([['run-gated', true, undefined, action, undefined, undefined]]);
    expect(recorded[0]!.detail).toMatchObject({ approve: true, action });
  });

  it('core#820: `consent:operator` reaches the engine as the arm, like the escalation tokens', async () => {
    const res = await gate({ approve: true, action: 'consent:operator' });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toEqual([['run-gated', true, undefined, 'consent:operator', undefined, undefined]]);
  });

  it("the engine's refusal (a gate the arm does not answer) is a 409 carrying its words; nothing is audited", async () => {
    refuse = '`extend` answers the gate of a repo-checks floor that did not finish (denial source `repo_checks_timeout`); unit 3 was denied by `repo_checks` — approve (retry), request changes, or reject';
    const res = await gate({ approve: true, action: 'extend' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('repo_checks_timeout');
    expect(recorded).toEqual([]);
  });

  it('a malformed escalation body never reaches the engine (400)', async () => {
    const res = await gate({ approve: true, action: 'accept_partial', amend: 'and the e2e' });
    expect(res.statusCode).toBe(400);
    expect(confirmCalls).toEqual([]);
  });
});
