// FIX-IT-ALL L8-0b — mirror-first test EXPECTATIONS for L1's gate arms (DES-L1 §5 PR-1B core /
// PR-2 crew; api-types 0.38.0 `GateDecision.action` / `.amendScope`), landing BEFORE the code.
//
// The contract 0.38.0 publishes: `POST /runs/:id/gate` grows an additive `action`
// (`approve | request_changes | reject`) and `amendScope` (`cursor | creator`). `request_changes`
// requires `approve: false` (a disagreement is a 400 naming it) and rewinds the run to the most
// recent creator phase; `amendScope: 'creator'` routes an approve's `amend` to the first creator
// phase at/after the cursor. The daemon passes both through `CoreAdapter.confirmGate(runId,
// approve, amend?, action?, amendScope?)`.
//
// TODAY the daemon's `GateSchema` is `.strict()` over `{approve, amend}` and `confirmGate` has
// arity 3, so every case below marked NOT_FIXED_YET is written with `it.fails`: it PASSES while the
// arms are refused and starts FAILING the moment L1 PR-2 lands — that failure is the flip signal
// (`it.fails` → `it` in the same PR). The unmarked cases pin today's contract and must never move.
//
// Why a wire-level expectation and not a fixture: the compile-time side already holds —
// `tests/wire-contract.test.ts` asserts every 0.38.0 `GateDecision` body is assignable to the
// schema's INPUT type (extra optional keys are assignable) — so only the RUNTIME strictness and the
// adapter arity can drift; this file watches those.
//
// Contract for L1 PR-2 (so its flip is not a false red): the route pins below spread ALL FIVE
// positionals — `confirmGate(id, approve, amend, action, amendScope)` with an explicit `undefined`
// for an absent `amend` / `action` / `amendScope` — because `toEqual` on the recorded argument array
// checks its LENGTH too; a 4-arg call for a body without `amendScope` would read as a mismatch. The
// disagreement pin asks only that SOME zod issue names both `action` and `approve` in its message
// (DES-L1: "400 naming it") — the refine may sit at the object root or on the `action` path.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDecision } from 'wicked-crew-api-types';

import { GateSchema, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { BUILTIN_WORKFLOWS, type CoreAdapter } from '../src/core/adapter.js';

function view(id: string, status: string, unitIx: number) {
  return {
    session: {
      id,
      workflow_id: 'bug',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude', 'codex'],
      status,
      human_confirm: 'all',
      unit_ix: unitIx,
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

describe('GateSchema — the 0.38.0 GateDecision arms (DES-L1 PR-2)', () => {
  it("today's two-arm body parses: {approve}, {approve, amend}; an unknown key is refused (strict)", () => {
    expect(GateSchema.safeParse({ approve: true }).success).toBe(true);
    expect(GateSchema.safeParse({ approve: false, amend: 'tighten the failing test first' }).success).toBe(true);
    expect(GateSchema.safeParse({ approve: true, nonsense: 1 }).success).toBe(false);
    expect(GateSchema.safeParse({}).success).toBe(false);
  });

  it.fails('NOT_FIXED_YET (L1 PR-2, crew 0.7.36): `action: request_changes` with `approve: false` parses', () => {
    const body: GateDecision = { approve: false, action: 'request_changes', amend: 'the fix must add a regression test' };
    expect(GateSchema.safeParse(body).success).toBe(true);
  });

  it.fails('NOT_FIXED_YET (L1 PR-2): `amendScope: creator` on an approve parses; the explicit `action: approve` / `reject` spellings parse', () => {
    const scoped: GateDecision = { approve: true, amend: 'land the steer on the fix phase', amendScope: 'creator' };
    expect(GateSchema.safeParse(scoped).success).toBe(true);
    const explicitApprove: GateDecision = { approve: true, action: 'approve' };
    expect(GateSchema.safeParse(explicitApprove).success).toBe(true);
    const explicitReject: GateDecision = { approve: false, action: 'reject' };
    expect(GateSchema.safeParse(explicitReject).success).toBe(true);
  });

  it.fails('NOT_FIXED_YET (L1 PR-2): an `action` / `approve` DISAGREEMENT is refused by a rule that names `action` and `approve` — not by the strict-object arm', () => {
    // `request_changes` requires `approve: false`. Today the strict object refuses the unknown key
    // ("Unrecognized key(s) in object: 'action'" — a message that never says `approve`) — the wrong
    // reason; the expectation is the L1 refine, wherever it attaches (object root or the `action` path).
    const r = GateSchema.safeParse({ approve: true, action: 'request_changes' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /action/i.test(i.message) && /approve/i.test(i.message))).toBe(true);
  });
});

describe('POST /runs/:id/gate — the arms reach the adapter (DES-L1 PR-2)', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-gated', 'awaiting_human', 2), view('run-exec', 'executing', 1)]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      // Arity-agnostic on purpose: records EVERY positional argument the route passes, so the
      // expectation below can pin the 5-arg call L1 PR-2 introduces without this stub changing.
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
      audit,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    recorded.length = 0;
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: body });

  it("today's reject reaches confirmGate(id, false) and is audited — the regression control", async () => {
    const res = await gate('run-gated', { approve: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'executing' });
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.slice(0, 2)).toEqual(['run-gated', false]);
    expect(recorded.map((r) => r.action)).toEqual(['gate.decided']);
    expect(recorded[0]!.detail).toMatchObject({ approve: false, status: 'executing' });
  });

  it.fails('NOT_FIXED_YET (L1 PR-2): `{approve: false, action: request_changes, amend}` → 200 and confirmGate(id, false, amend, "request_changes", undefined); the audit detail names the arm', async () => {
    const res = await gate('run-gated', { approve: false, action: 'request_changes', amend: 'add the missing null check' });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toEqual(['run-gated', false, 'add the missing null check', 'request_changes', undefined]);
    expect(recorded[0]!.detail).toMatchObject({ approve: false, action: 'request_changes' });
  });

  it.fails('NOT_FIXED_YET (L1 PR-2): `{approve: true, amend, amendScope: creator}` → 200 and confirmGate(id, true, amend, undefined, "creator")', async () => {
    const res = await gate('run-gated', { approve: true, amend: 'prefer the existing helper', amendScope: 'creator' });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toEqual(['run-gated', true, 'prefer the existing helper', undefined, 'creator']);
    expect(recorded[0]!.detail).toMatchObject({ approve: true, amendScope: 'creator' });
  });

  it('a run not awaiting a gate is a 409 whatever the arm — unchanged by L1', async () => {
    const res = await gate('run-exec', { approve: false });
    expect(res.statusCode).toBe(409);
    expect(confirmCalls).toEqual([]);
  });
});
