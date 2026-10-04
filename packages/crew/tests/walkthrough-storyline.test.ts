// WT-W3 (DES-walkthrough-proof §4.8 "Edit the check", §9 W3):
//
//   PUT /api/v1/runs/:id/walkthrough/storyline?step=   refused with no open escalation; accepted while
//                                                      the pair's escalation gate is open, written to
//                                                      author/<plan step>/storyline.mjs and marked
//                                                      `edited_by: human`; only a person may edit.
//   GET /api/v1/runs/:id/acceptance → summary          the deliver card's acceptance line.

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkthroughStepState } from 'wicked-crew-api-types';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { acceptanceSummary, type AcceptanceGateResolution } from '../src/qe/acceptance.js';
import type { WalkthroughGate } from '../src/qe/walkthrough-acceptance.js';
import { removeScratch } from './setup/scratch.js';

const STORY = "export default { fixture: { start: 'npm start' }, segments: [] };\n";

function runView(id: string, evidenceRoot: string | null, status: string, opts: { reviewDenial?: string | null; planDenial?: string | null } = {}) {
  const units = [
    { step: 'build', catalog: 'build', role: 'creator', status: 'done', denial: null },
    { step: 'walkthrough_plan', catalog: 'walkthrough_plan', role: 'evaluator', status: 'done', denial: opts.planDenial ?? null },
    { step: 'walkthrough_review', catalog: 'walkthrough_review', role: 'neutral', status: 'distributed', denial: opts.reviewDenial ?? null },
  ];
  return {
    session: {
      id,
      status,
      unit_ix: 2,
      workflow_id: `${id}:plan-1`,
      problem: 'Fix the double charge',
      workdir: '/tmp/wt',
      extra_write_roots: evidenceRoot === null ? [] : [join(evidenceRoot, 'author')],
      ...(evidenceRoot === null ? {} : { evidence_root: evidenceRoot }),
    },
    units: units.map((u, i) => ({
      id: `${id}:${u.step}`,
      session_id: id,
      ord: i + 1,
      catalog: u.catalog,
      role: u.role,
      status: u.status,
      assigned_cli: null,
      denial_reason: u.denial,
    })),
  };
}

describe('PUT /runs/:id/walkthrough/storyline (WT-W3)', () => {
  let roots: string;
  let evidence: string;
  let app: FastifyInstance;
  let gates: GateCache;
  let view: ReturnType<typeof runView>;
  let audited: Array<{ action: string; detail?: Record<string, unknown> }>;
  let afterWrite: ReturnType<typeof runView> | null;

  beforeEach(async () => {
    roots = mkdtempSync(join(tmpdir(), 'wt-storyline-'));
    evidence = join(roots, 'r1');
    mkdirSync(join(evidence, 'author'), { recursive: true });
    view = runView('r1', evidence, 'awaiting_human', { reviewDenial: 'walkthrough FAIL: chapter 01-pay-once' });
    afterWrite = null;
    gates = new GateCache();
    audited = [];
    const audit = AuditLog.noop();
    audit.record = ((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      audited.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return 0;
    }) as AuditLog['record'];
    app = Fastify({ logger: false });
    app.decorateRequest('actor', null as unknown as never);
    app.addHook('onRequest', async (req) => {
      const h = req.headers['x-actor'];
      if (typeof h === 'string') (req as unknown as { actor: unknown }).actor = { id: `${h}-1`, kind: h, trust: 'operator' };
    });
    registerRoutes(
      app,
      {
        sessionsDetail: vi.fn(async () => {
          const out = [view];
          if (afterWrite !== null) view = afterWrite; // the next read sees the run moved on
          return out;
        }),
        listRepos: vi.fn(async () => []),
        interactionRequests: vi.fn(async () => []),
        runEvents: vi.fn(async () => []),
      } as unknown as CoreAdapter,
      gates,
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit, authMode: 'required' },
      { callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    removeScratch(roots);
  });

  const openGate = (ord: number): void => gates.ingest({ type: 'awaitingHuman', session: 'r1', ord, prompt: 'escalation' } as unknown as CoreEvent);
  const put = (body: unknown, headers: Record<string, string> = { 'x-actor': 'human' }, q = '') =>
    app.inject({ method: 'PUT', url: `/api/v1/runs/r1/walkthrough/storyline${q}`, headers, payload: body as Record<string, unknown> });

  it('is refused while no escalation is open (409 no_open_escalation) and writes nothing', async () => {
    view = runView('r1', evidence, 'executing', { reviewDenial: null });
    const res = await put({ storyline: STORY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_open_escalation' });
    expect(existsSync(join(evidence, 'author', 'walkthrough_plan', 'storyline.mjs'))).toBe(false);
  });

  it('is refused when the open gate is not a denied step of this walkthrough (a plain gate before the review)', async () => {
    view = runView('r1', evidence, 'awaiting_human', { reviewDenial: null });
    openGate(3);
    expect((await put({ storyline: STORY })).json()).toMatchObject({ code: 'no_open_escalation' });
    view = runView('r1', evidence, 'awaiting_human', { reviewDenial: 'FAIL' });
    openGate(1);
    expect((await put({ storyline: STORY })).json()).toMatchObject({ code: 'no_open_escalation' });
  });

  it('while the review escalation is open: writes the storyline, marks it edited_by human, audits the sha', async () => {
    openGate(3);
    const res = await put({ storyline: STORY });
    expect(res.statusCode, res.body).toBe(200);
    const sha = createHash('sha256').update(STORY).digest('hex');
    expect(res.json()).toMatchObject({ runId: 'r1', planStepId: 'walkthrough_plan', sha256: sha, edited_by: 'human' });
    const dir = join(evidence, 'author', 'walkthrough_plan');
    expect(readFileSync(join(dir, 'storyline.mjs'), 'utf8')).toBe(STORY);
    expect(JSON.parse(readFileSync(join(dir, 'storyline.edit.json'), 'utf8'))).toMatchObject({ edited_by: 'human', actor: 'human-1', sha256: sha, ord: 3 });
    expect(audited).toContainEqual({ action: 'walkthrough.storyline.edited', detail: { planStepId: 'walkthrough_plan', ord: 3, sha256: sha, bytes: STORY.length } });
  });

  it("the author's own lint escalation (a denied walkthrough_plan) also accepts an edit", async () => {
    view = runView('r1', evidence, 'awaiting_human', { planDenial: 'storyline lint: no checks' });
    openGate(2);
    expect((await put({ storyline: STORY })).statusCode).toBe(200);
  });

  it('only a person edits the checks: an agent token is 403', async () => {
    openGate(3);
    const res = await put({ storyline: STORY }, { 'x-actor': 'agent' });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(evidence, 'author', 'walkthrough_plan', 'storyline.mjs'))).toBe(false);
  });

  it('refuses a missing body (400), an oversize one (413), an unknown step (404) and a planted link (409)', async () => {
    openGate(3);
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ storyline: 'x'.repeat(256 * 1024 + 1) })).statusCode).toBe(413);
    expect((await put({ storyline: STORY }, { 'x-actor': 'human' }, '?step=nope')).statusCode).toBe(404);
    const outside = join(roots, 'elsewhere');
    mkdirSync(outside);
    symlinkSync(outside, join(evidence, 'author', 'walkthrough_plan'));
    const res = await put({ storyline: STORY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'write_refused' });
    expect(existsSync(join(outside, 'storyline.mjs'))).toBe(false);
  });

  it('a run with no evidence root is 409 no_evidence_root', async () => {
    view = runView('r1', null, 'awaiting_human', { reviewDenial: 'FAIL' });
    openGate(3);
    expect((await put({ storyline: STORY })).json()).toMatchObject({ code: 'no_evidence_root' });
  });

  it('a planted link at author/ itself is refused before anything is created through it', async () => {
    openGate(3);
    const outside = join(roots, 'elsewhere-author');
    mkdirSync(outside);
    removeScratch(join(evidence, 'author'));
    symlinkSync(outside, join(evidence, 'author'));
    const res = await put({ storyline: STORY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'write_refused', error: expect.not.stringMatching(new RegExp(roots)) });
    expect(existsSync(join(outside, 'walkthrough_plan'))).toBe(false);
  });

  it('the escalation answered while the file was written → 409 escalation_closed, never a bare 200', async () => {
    openGate(3);
    afterWrite = runView('r1', evidence, 'executing', { reviewDenial: null });
    const res = await put({ storyline: STORY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'escalation_closed' });
  });

  it('an author recorded by two reviews: ?step=<author> finds the pair whose review is escalated', async () => {
    const two = runView('r1', evidence, 'awaiting_human');
    two.units.push({ id: 'r1:walkthrough_review_2', session_id: 'r1', ord: 4, catalog: 'walkthrough_review', role: 'neutral', status: 'distributed', assigned_cli: null, denial_reason: 'FAIL' });
    (two.units[3] as Record<string, unknown>)['depends_on'] = ['walkthrough_plan'];
    (two.units[2] as Record<string, unknown>)['depends_on'] = ['walkthrough_plan'];
    view = two;
    openGate(4);
    expect((await put({ storyline: STORY }, { 'x-actor': 'human' }, '?step=walkthrough_plan')).statusCode).toBe(200);
  });
});

describe('acceptanceSummary — the deliver card acceptance line (WT-W3)', () => {
  const gate = (over: Partial<AcceptanceGateResolution>): AcceptanceGateResolution => ({
    required: true,
    satisfied: true,
    verdict: null,
    runStatus: null,
    reason: 'ok',
    ...over,
  });
  const walk = (over: Partial<WalkthroughGate> = {}): WalkthroughGate => ({
    stepId: 'walkthrough_review',
    sealed: true,
    satisfied: true,
    reason: 'PASS',
    overall: 'PASS',
    tree: 'a1b2c3d4e5f6',
    chapters: [],
    ...over,
  });
  const steps = (...states: WalkthroughStepState['checkState'][]): WalkthroughStepState[] =>
    states.map((checkState, i) => ({ stepId: `s${i}`, checkState, provedBy: [] }));

  it('a passing walkthrough reads "Checked by a walkthrough: N of M steps at <tree>"', () => {
    expect(acceptanceSummary(gate({}), [walk()], steps('checked', 'checked', 'checked'))).toEqual({
      required: true,
      satisfied: true,
      line: 'Checked by a walkthrough: 3 of 3 steps at a1b2c3d.',
      walkthrough: { checked: 3, failed: 0, ownedByYou: 0, steps: 3, sealed: true, tree: 'a1b2c3d4e5f6' },
    });
  });
  it('steps the plan left to the operator are named', () => {
    expect(acceptanceSummary(gate({}), [walk()], steps('checked', 'owned_by_you')).line).toBe(
      'Checked by a walkthrough: 1 of 2 steps at a1b2c3d; 1 left to your own testing.',
    );
  });
  it('a denial reads "Not accepted yet: <reason>", capped', () => {
    const s = acceptanceSummary(gate({ satisfied: false, reason: `walkthrough FAIL ${'x'.repeat(400)}` }), [walk({ satisfied: false })], steps('failed'));
    expect(s.satisfied).toBe(false);
    expect(s.line.startsWith('Not accepted yet: walkthrough FAIL')).toBe(true);
    expect(s.line.length).toBeLessThanOrEqual('Not accepted yet: '.length + 200);
    expect(s.walkthrough).toMatchObject({ failed: 1 });
  });
  it('nothing required, and accepted without a walkthrough', () => {
    expect(acceptanceSummary(gate({ required: false }), [], []).line).toBe('Nothing had to be proved before delivery.');
    expect(acceptanceSummary(gate({}), [], [])).toEqual({ required: true, satisfied: true, line: 'Accepted: the checks this run had to pass have passed.', walkthrough: null });
  });
  it('the override removed the pair: no walkthrough ran, the steps are the operator\'s and the line says so (#791)', () => {
    const yours = steps('owned_by_you', 'owned_by_you');
    expect(acceptanceSummary(gate({ required: false }), [], yours, null, true)).toEqual({
      required: false,
      satisfied: true,
      line: 'Nothing had to be proved before delivery; 2 left to your own testing.',
      walkthrough: { checked: 0, failed: 0, ownedByYou: 2, steps: 2, sealed: true, tree: null },
    });
    expect(acceptanceSummary(gate({}), [], yours, null, true).line).toBe(
      'Accepted: the checks this run had to pass have passed; 2 left to your own testing.',
    );
    expect(acceptanceSummary(gate({ satisfied: false, reason: 'no verdict' }), [], yours, null, true).line).toBe('Not accepted yet: no verdict');
  });
  it('the line never names a path, also when the ledger reason does', () => {
    expect(acceptanceSummary(gate({}), [walk()], steps('checked')).line).not.toMatch(/\//);
    const denied = acceptanceSummary(gate({ satisfied: false, reason: 'no verdict in /srv/home/op/repo/.wicked-qe (missing ⇒ deny)' }), [], []);
    expect(denied.line).toBe('Not accepted yet: no verdict in … (missing ⇒ deny)');
  });
  it('counts and tree come from the SAME walkthrough (the newest author pair), not the last gate in review order', () => {
    const older = walk({ stepId: 'r1', tree: 'aaaaaaa1' });
    const newer = walk({ stepId: 'r2', tree: 'bbbbbbb2' });
    expect(acceptanceSummary(gate({}), [newer, older], steps('checked'), newer).walkthrough?.tree).toBe('bbbbbbb2');
  });
});
