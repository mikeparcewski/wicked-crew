// Guards for GET /api/v1/runs/:id/units/:unitKey/output (FINDING-006).
//
// Driven through `registerRoutes` + Fastify `inject` — the CALL SITE, not the helpers. A test
// that only exercised `resolveUnit`/`outputUnavailableReason` would prove those functions work
// while proving nothing about whether the route ever reaches them; the endpoint answering
// `200 {"output": null}` is exactly the failure a helper-only test cannot see.
//
// The defect: the route built `<run>:<segment>` from whatever the caller typed and sent it
// straight to core, so an unknown run, an unknown key, an unfinished unit and a DENIED unit all
// came back as the same `200 {"output": null}`. The denied unit is the one an operator opens
// during triage, so the one case that most needed an answer was the case that gave none.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView, UnitStatus, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const RUN = 'run-unit-output-01';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function unit(partial: { ord: number; id: string; status: UnitStatus; denial_reason?: string | null }): WorkUnit {
  return {
    id: partial.id,
    session_id: RUN,
    ord: partial.ord,
    description: `phase ${partial.ord}`,
    stage: 'build',
    assigned_cli: 'claude',
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: partial.denial_reason ?? null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: partial.status,
  };
}

/** A workflow run: units keyed `<run>:<phase_id>`, ord 3 rejected — the FINDING-006 shape. */
function workflowRun(): SessionView {
  return {
    session: {
      id: RUN,
      workflow_id: 'onboard',
      problem: 'onboard the repo',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude'],
      status: 'failed',
      human_confirm: 'none',
      unit_ix: 3,
      attempt: 1,
      workdir: null,
      repo_ref: null,
    },
    units: [
      unit({ ord: 1, id: `${RUN}:index`, status: 'done' }),
      unit({ ord: 2, id: `${RUN}:annotate`, status: 'done' }),
      unit({
        ord: 3,
        id: `${RUN}:domain`,
        status: 'rejected',
        denial_reason: 'Worker FAILED on unit 3 (triage: nonzero exit): domain extraction found no entities',
      }),
    ],
  };
}

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  workOutput: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
};

function buildApp(mockAdapter: MockAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
  );
  return app;
}

// Built by concatenation so the assertion can never match its own source text. A needle spelled
// literally in the file it searches is a check that passes on itself — five times in this campaign.
const REJECTED_TOKEN = 'REJ' + 'ECTED';

describe('GET /runs/:id/units/:unitKey/output', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([workflowRun()]),
      // Only the two APPROVED units have a stored transcript — core writes a work_output node
      // only on approval, so the rejected unit genuinely has none.
      workOutput: vi.fn().mockImplementation(async (unitId: string) =>
        unitId === `${RUN}:index` || unitId === `${RUN}:annotate` ? `transcript for ${unitId}` : null,
      ),
      sessions: vi.fn().mockResolvedValue([RUN]),
    };
    app = buildApp(mockAdapter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── The finding: a failed unit must yield a REASON, never a bare null ────────

  it('answers a rejected unit with the cause, the denial reason, and where to look', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/domain/output` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ output: string | null; outputUnavailable?: string }>();
    expect(body.output).toBeNull();
    const reason = body.outputUnavailable;
    expect(reason).toBeDefined();
    // The substance, not the presence of a string: it must name the cause, quote what core
    // actually recorded about this unit, and point at a surface that still holds the decision.
    expect(reason).toContain(REJECTED_TOKEN);
    expect(reason).toContain('domain extraction found no entities');
    expect(reason).toContain(`/runs/${RUN}/evidence`);
    // And it must NOT tell the operator the unit produced nothing — it produced output that
    // deny-dominates then withheld. That inversion is the whole defect.
    expect(reason).not.toMatch(/produced no output|no transcript captured/i);
  });

  it('does not claim the transcript is retrievable somewhere it is not', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/domain/output` });
    const reason = res.json<{ outputUnavailable: string }>().outputUnavailable;
    // The streamed text rode cliOutputDelta, which core excludes from the durable log, and no
    // work_output node was written. The reason may point at the DECISION trail; it must not
    // promise the transcript itself is in the evidence bundle.
    expect(reason).not.toMatch(/transcript is in the evidence|transcript.*available in.*evidence/i);
    expect(reason).toContain('not retained');
  });

  it('distinguishes "has not run yet" from "was denied"', async () => {
    const view = workflowRun();
    view.units[2] = unit({ ord: 3, id: `${RUN}:domain`, status: 'pending' });
    mockAdapter.sessionsDetail.mockResolvedValue([view]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/domain/output` });
    const reason = res.json<{ outputUnavailable: string }>().outputUnavailable;
    expect(reason).toContain('has not finished');
    expect(reason).not.toContain(REJECTED_TOKEN);
  });

  // ── Key resolution: every spelling an operator would reach for ───────────────

  it.each([
    ['phase-id suffix', 'domain'],
    ['fully-qualified id', `${RUN}:domain`],
    ['u<ord>', 'u3'],
    ['bare ord', '3'],
  ])('resolves the rejected unit by %s', async (_label, key) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN}/units/${encodeURIComponent(key)}/output`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ outputUnavailable?: string }>().outputUnavailable).toContain(REJECTED_TOKEN);
  });

  it('reads an approved unit keyed off the unit record, not the caller path segment', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/2/output` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ output: string | null; outputUnavailable?: string }>();
    // 'u2'/'2' is NOT the store key — `<run>:annotate` is. Concatenating the segment would have
    // asked core for `<run>:2` and got null back for a unit that has a transcript.
    expect(mockAdapter.workOutput).toHaveBeenCalledWith(`${RUN}:annotate`);
    expect(body.output).toBe(`transcript for ${RUN}:annotate`);
    expect(body.outputUnavailable).toBeUndefined();
  });

  // ── Fail closed: an unknown run or key is an error, not an empty success ─────

  it('404s an unknown run instead of answering 200 with null', async () => {
    mockAdapter.sessionsDetail.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/domain/output` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/run not found/i);
    expect(mockAdapter.workOutput).not.toHaveBeenCalled();
  });

  it('404s an unknown key and returns the keys that do resolve', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/nosuchphase/output` });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string; units: string[] }>();
    expect(body.error).toContain('nosuchphase');
    expect(body.units).toEqual(['index', 'annotate', 'domain']);
    expect(mockAdapter.workOutput).not.toHaveBeenCalled();
  });

  // ── Free-text runs still resolve by their own key shape ──────────────────────

  it('resolves free-text units keyed `<run>:u<ord>` by every accepted spelling', async () => {
    const view = workflowRun();
    view.units = [unit({ ord: 1, id: `${RUN}:u1`, status: 'done' })];
    mockAdapter.sessionsDetail.mockResolvedValue([view]);
    // The store answers ONLY its real key. A mock that answered any id would let a route that
    // concatenated the caller's segment (`<run>:1`) look correct here — the assertion has to be
    // able to tell the two derivations apart, or it is not a guard.
    mockAdapter.workOutput.mockImplementation(async (unitId: string) =>
      unitId === `${RUN}:u1` ? 'free-text transcript' : null,
    );
    for (const key of ['u1', '1', `${RUN}:u1`]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/units/${key}/output` });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ output: string }>().output).toBe('free-text transcript');
    }
    expect(mockAdapter.workOutput).toHaveBeenCalledWith(`${RUN}:u1`);
  });
});

// FINDING-006 review follow-up (#215): the operator-facing evidence URL must carry the SAME prefix
// the route is actually registered under, or a copied URL 404s. Reads BOTH sides (P1), so a prefix
// change on either cannot silently diverge.
import { API_PREFIX } from '../src/api/routes.js';
import { outputUnavailableReason } from '../src/api/unit-output.js';
import { describe as _d, it as _it, expect as _e } from 'vitest';
_d('evidence URL matches the registered route prefix (FINDING-006/#215)', () => {
  _it('names /api/v1/runs/:id/evidence, not a bare /runs path', () => {
    const msg = outputUnavailableReason({
      session_id: 'run-x',
      status: 'rejected',
      denial_reason: null,
    } as never);
    _e(msg).toContain(`${API_PREFIX}/runs/run-x/evidence`);
    // The bug was a bare 'GET /runs/...' with no prefix. Every '/runs/run-x/evidence' occurrence
    // in the message must be immediately preceded by the prefix — none bare.
    const bare = msg.split('/runs/run-x/evidence').slice(0, -1).filter((seg) => !seg.endsWith(API_PREFIX));
    _e(bare, 'the evidence URL must not appear without the /api/v1 prefix').toEqual([]);
  });
});
