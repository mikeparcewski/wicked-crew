// (operator ruling 2026-10-21, api-types 0.135.0) "Approve as your own judgment" at a FAILED
// REPO-CHECKS FLOOR's escalation gate: `{approve: true, action: 'operator_judgment', amend: <why>}`.
//
// The operator's written rationale IS the record, so the schema refuses a blank one before the
// engine is asked; the engine decides whether the open gate is one the arm answers (a floor that
// failed, no other layer denying) and its refusal is the route's 409, gate left open. The override
// is labelled "floor overridden by operator" on the delivery: the PR body's phase table, and a
// post-hoc delivery's aggregated receipt.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssuranceReceipt, GateDecision, OperatorJudgment } from 'wicked-crew-api-types';

import { GateSchema, registerRoutes } from '../src/api/routes.js';
import { aggregateReceipt } from '../src/api/delivery-assurance.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { operatorJudgedLabel } from '../src/core/deliver-text.js';
import type { SessionView } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const WHY = '27 head-only failures are load flakes in untouched files; each passes alone';

const OVERRIDE: OperatorJudgment = {
  by: 'an-operator (user)',
  at: 1_785_614_004_730,
  note: WHY,
  reason: 'repo checks failed: test (27 failing, head-only)',
  floorOverride: {
    layer: 'repo_checks',
    resultId: 'run-gated:unit-6:attempt-7:repo_checks',
    ord: 6,
    attempt: 7,
    tree: 'abc123',
    label: 'floor overridden by operator',
  },
};

describe('GateSchema — operator_judgment', () => {
  it('parses with approve: true and a written rationale', () => {
    const body: GateDecision = { approve: true, action: 'operator_judgment', amend: WHY };
    expect(GateSchema.safeParse(body).success).toBe(true);
    expect(GateSchema.safeParse({ ...body, ord: 6 }).success).toBe(true);
  });

  it('needs the rationale: absent or blank is refused, naming what it is for', () => {
    for (const body of [
      { approve: true, action: 'operator_judgment' },
      { approve: true, action: 'operator_judgment', amend: '' },
      { approve: true, action: 'operator_judgment', amend: ' \n\t ' },
    ]) {
      const r = GateSchema.safeParse(body);
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.some((i) => /operator_judgment needs `amend`: your written rationale/.test(i.message))).toBe(true);
    }
  });

  it('is approve-shaped and takes no amendScope or plan', () => {
    const no = GateSchema.safeParse({ approve: false, action: 'operator_judgment', amend: WHY });
    expect(no.success).toBe(false);
    const scoped = GateSchema.safeParse({ approve: true, action: 'operator_judgment', amend: WHY, amendScope: 'creator' });
    expect(scoped.success).toBe(false);
    if (scoped.success) return;
    expect(scoped.error.issues.some((i) => /operator_judgment takes no amendScope or plan/.test(i.message))).toBe(true);
  });
});

function view(id: string): SessionView {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'none', unit_ix: 5, attempt: 7,
      workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

describe('POST /runs/:id/gate — operator_judgment reaches the engine', () => {
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
      sessionsDetail: vi.fn().mockResolvedValue([view('run-gated')]),
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

  it('→ 200: confirmGate carries the arm and the rationale, and both are audited', async () => {
    const res = await gate({ approve: true, action: 'operator_judgment', amend: WHY });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toEqual([['run-gated', true, WHY, 'operator_judgment', undefined, undefined]]);
    expect(recorded[0]!.detail).toMatchObject({ approve: true, action: 'operator_judgment', amend: WHY });
  });

  it('a blank rationale never reaches the engine (400)', async () => {
    const res = await gate({ approve: true, action: 'operator_judgment', amend: '   ' });
    expect(res.statusCode).toBe(400);
    expect(confirmCalls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("the engine's refusal (another layer denies, not a floor gate) is a 409 carrying its words; nothing is audited", async () => {
    refuse =
      "unit 6's gate was ALSO denied by `agent_validator` (REJECT) — `operator_judgment` overrides the failed floor only, and every other layer still denies (deny-dominates)";
    const res = await gate({ approve: true, action: 'operator_judgment', amend: WHY });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('deny-dominates');
    expect(recorded).toEqual([]);
  });
});

describe('the delivery says "floor overridden by operator"', () => {
  it("the PR body's phase cell carries the engine's label and who", () => {
    expect(operatorJudgedLabel({ assurance: { operatorJudges: [OVERRIDE] } })).toBe('floor overridden by operator (an-operator (user))');
  });

  it('a gate with both an override and a judge-unavailable judgment names both', () => {
    const judged: OperatorJudgment = { by: 'coordinator (agent)', at: 2, note: null, reason: null };
    expect(operatorJudgedLabel({ assurance: { operatorJudges: [OVERRIDE, judged] } })).toBe(
      'floor overridden by operator (an-operator (user)); judged by operator (coordinator (agent))',
    );
  });

  it("a post-hoc delivery's aggregated receipt lists the run's operator judgments", () => {
    const receipt: AssuranceReceipt = {
      mode: 'full', required: ['judge', 'qe_acceptance'], ran: ['repo_checks', 'operator_judge'], skipped: [],
      creator: 'codex', evaluator: null, judge: 'claude', tree: 'abc123', attempt: 7, operatorJudges: [OVERRIDE],
    };
    const v = view('run-posthoc');
    v.session.assurance = { mode: 'full', required: ['judge', 'qe_acceptance'], floorOverrides: [OVERRIDE] };
    v.units = [{ id: 'u6', session_id: 'run-posthoc', ord: 6, description: 'build', status: 'done', assurance: receipt }] as unknown as SessionView['units'];
    const r = aggregateReceipt(v, 'def456');
    expect(r?.operatorJudges?.map((j) => j.floorOverride?.label)).toEqual(['floor overridden by operator']);
    // Once each: the unit's receipt and the run's record name the same judgment.
    expect(r?.operatorJudges).toHaveLength(1);
    // A later rework cut a fresh receipt for the unit: the run's record still puts it on the delivery.
    v.units = [{ id: 'u6', session_id: 'run-posthoc', ord: 6, description: 'build', status: 'done', assurance: { ...receipt, ran: ['repo_checks', 'judge'], operatorJudges: undefined, attempt: 8 } }] as unknown as SessionView['units'];
    const after = aggregateReceipt(v, 'def456');
    expect(after?.operatorJudges?.map((j) => j.floorOverride?.label)).toEqual(['floor overridden by operator']);
    expect(after?.ran).toContain('operator_judge');
    // QE acceptance is not skipped by an override: no skip entry, the run's decision stands.
    expect(r?.skipped.some((s) => s.instrument === 'qe_acceptance')).toBe(false);
  });
});
