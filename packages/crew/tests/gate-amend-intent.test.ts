// wicked-core#555 — `POST /runs/:id/gate` takes the `amend_intent` arm.
//
// `request_changes` reaches the creator and an approve's `amend` reaches ONE unit's instruction;
// nothing amended the acceptance list an EVALUATOR is handed (that is the launch intent), so a
// mid-run descope could only end in a relaunch — and the evaluator judged the withdrawn item,
// inconsistently (the same tree PASSED on one attempt and FAILED on the next).
//
// The arm is approve-shaped and IS its text: the schema requires a non-empty `amend` and refuses
// an `amendScope` or `plan` beside it, because the scope is every unit at or after the cursor —
// which is what makes it reach the later evaluator. The ENGINE decides whether the open gate is
// one the arm answers (a plan gate and a team pause refuse it); its refusal is the route's 409.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDecision } from 'wicked-crew-api-types';

import { GateSchema, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

describe('GateSchema — amend_intent', () => {
  it('parses with approve: true and the amendment text', () => {
    const body: GateDecision = { approve: true, action: 'amend_intent', amend: 'issue #621 is withdrawn' };
    expect(GateSchema.safeParse(body).success).toBe(true);
    expect(GateSchema.safeParse({ ...body, ord: 4 }).success).toBe(true);
  });

  it('needs the text: absent or blank is refused, naming what it is for', () => {
    for (const body of [
      { approve: true, action: 'amend_intent' },
      { approve: true, action: 'amend_intent', amend: '' },
      { approve: true, action: 'amend_intent', amend: '   ' },
    ]) {
      const r = GateSchema.safeParse(body);
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.some((i) => /amend_intent needs `amend`/.test(i.message))).toBe(true);
    }
  });

  it('is approve-shaped: approve: false is refused by the rule naming action and approve', () => {
    const r = GateSchema.safeParse({ approve: false, action: 'amend_intent', amend: 'withdrawn' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /action/.test(i.message) && /approve/.test(i.message))).toBe(true);
  });

  it('takes no amendScope — the scope is what makes it reach the evaluator', () => {
    const r = GateSchema.safeParse({
      approve: true,
      action: 'amend_intent',
      amend: 'withdrawn',
      amendScope: 'creator',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /amend_intent takes no amendScope or plan/.test(i.message))).toBe(true);
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

describe('POST /runs/:id/gate — amend_intent reaches the engine', () => {
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

  it('→ 200, confirmGate carries the arm and the text, and the amendment is audited', async () => {
    const res = await gate({ approve: true, action: 'amend_intent', amend: 'issue #621 is withdrawn' });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toEqual([
      ['run-gated', true, 'issue #621 is withdrawn', 'amend_intent', undefined, undefined],
    ]);
    // WHO amended, and WHAT — the amendment is the audit record's point.
    expect(recorded[0]!.detail).toMatchObject({
      approve: true,
      action: 'amend_intent',
      amend: 'issue #621 is withdrawn',
    });
  });

  it("the engine's refusal (a plan gate, a team pause, empty text) is a 409 carrying its words; nothing is audited", async () => {
    refuse =
      'a plan_approval gate reviews a plan, not a floor, an evaluator\'s edit or an intent amendment — approve, approve with an edited plan, or reject';
    const res = await gate({ approve: true, action: 'amend_intent', amend: 'withdrawn' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('intent amendment');
    expect(recorded).toEqual([]);
  });

  it('a blank amendment never reaches the engine (400)', async () => {
    const res = await gate({ approve: true, action: 'amend_intent', amend: '  ' });
    expect(res.statusCode).toBe(400);
    expect(confirmCalls).toEqual([]);
  });
});
