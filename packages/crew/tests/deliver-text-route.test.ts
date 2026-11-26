// crew#524 / F-3R2-014 — `GET /runs/:id/deliver-text`: the PR title + body the deliver script asks
// its daemon for, composed from the PERSISTED RUN RECORD and answered as text/plain in the one
// framing both carriers share (line 1 title, line 2 blank, then the body).
//
// The route is what turns "the PR body is empty" into "the PR body is the run": the script cannot
// know at launch which seat took each phase, what the repo checks returned or what the evaluator
// said — the run record does, and this is where the script reads it.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { parseFramedDeliverText } from '../src/core/deliver-text.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { registerAuthHooks, type ResolvedAuth } from '../src/api/auth.js';
import { deliverPrScript } from '../src/core/deliver.js';
import { grantPostHocDeliverText } from '../src/core/deliver-grants.js';
import type { PhaseDef, SessionView, WorkflowDef, WorkUnit } from '../src/core/types.js';
import { withRunViews } from './support/run-views.js';

const RUN_ID = 'd74e4e8f-bbc9-4697-8c30-181bae005217';

function unit(over: Partial<WorkUnit> & { id: string; ord: number }): WorkUnit {
  return {
    session_id: RUN_ID,
    description: 'x',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: 'approved',
    collection_scope: null,
    status: 'done',
    ...over,
  } as WorkUnit;
}

function view(): SessionView {
  const verify = unit({
    id: `${RUN_ID}:verify`,
    ord: 2,
    stage: 'test',
    role: 'evaluator',
    assigned_cli: 'pi',
    gate: { human_confirm_if: 'verdict_not_pass' },
  });
  (verify as WorkUnit & { repo_checks: unknown }).repo_checks = {
    checks: [{ name: 'test', argv: ['npm', 'run', 'test'], exit_code: 0, duration_ms: 1500, timed_out: false, spawn_error: null }],
  };
  return {
    session: {
      id: RUN_ID,
      workflow_id: `bug-deliver-${RUN_ID}`,
      problem: 'the archive controls never render\n\nfix issue #214',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude', 'pi'],
      status: 'executing',
      human_confirm: 'all',
      unit_ix: 3,
      attempt: 0,
      workdir: '/tmp/wt',
      repo_ref: 'wicked-studio',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    } as SessionView['session'],
    units: [
      unit({ id: `${RUN_ID}:fix`, ord: 1, role: 'creator', assigned_cli: 'claude', gate: 'auto' }),
      verify,
      unit({ id: `${RUN_ID}:deliver`, ord: 3, status: 'distributed', phase_status: null, routing: { method: 'tool' }, gate: 'auto' }),
    ],
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function buildApp(
  views: SessionView[],
  workflows: WorkflowDef[] = [],
  auth?: ResolvedAuth,
): Promise<{ app: FastifyInstance; setOrigin: Mock }> {
  const setOrigin = vi.fn();
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    setDeliverApiOrigin: setOrigin,
    listWorkflows: () => workflows,
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  if (auth !== undefined) registerAuthHooks(app, auth);
  registerRoutes(
    app,
    withRunViews(mockAdapter),
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: auth?.mode ?? 'off' },
    {},
  );
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, setOrigin };
}

describe('GET /runs/:id/deliver-text (crew#524)', () => {
  it('answers text/plain framed as title / blank / body, composed from the run record, naming the run without a loopback link', async () => {
    const { app } = await buildApp([view()]);
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const text = parseFramedDeliverText(res.body);
    expect(text).not.toBeNull();
    // DES-L9: the workflow's conventional prefix (`bug` → `fix:`).
    expect(text!.title).toBe('fix: the archive controls never render');
    expect(text!.body).toContain('Fixes #214');
    // crew#550 P-2: the daemon's own loopback origin is never the PR's run link (it opens only on
    // this host); with no public origin configured the run is named, not linked.
    expect(text!.body).toContain(`- Run: \`${RUN_ID}\``);
    expect(text!.body).not.toContain(`127.0.0.1:${port}/runs/`);
    expect(text!.body).toContain('workflow `bug` · repo `wicked-studio`');
    expect(text!.body).toContain('| `fix` | build | creator | claude | auto | approved |');
    expect(text!.body).toContain('| `verify` | test | evaluator | pi | human if verdict not pass | approved |');
    expect(text!.body).toContain('| `deliver` | build | neutral | tool | auto | this PR |');
    expect(text!.body).toContain('| `verify` | test | `npm run test` | 0 | — | 1.5s |');
    // DES-L9: the evaluator GATE reads a clean pass as such.
    expect(text!.body).toContain('- `verify` (pi): passed its gate');
    expect(text!.body).toContain(`Delivered by [wicked-crew](https://wc.wickedagile.com) run \`${RUN_ID}\`.`);
  });

  it('carries the run\'s QE skip on the text every delivery path composes (crew#1186)', async () => {
    const v = view();
    (v.session as { assurance?: unknown }).assurance = {
      mode: 'full',
      required: ['qe_acceptance'],
      qe: { status: 'skipped', basis: 'operator', score: null, threshold: 20, reason: 'QE acceptance skipped by operator: hotfix, reviewed by hand', reasons: [], ord: 3, tree: null },
    };
    const { app } = await buildApp([v]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` });
    expect(res.statusCode).toBe(200);
    expect(parseFramedDeliverText(res.body)!.body).toContain('- **QE acceptance skipped by operator**: hotfix, reviewed by hand');
  });

  it('names the workflow the ENGINE RECORDED for a run whose view carries the engine instance id (seam X2)', async () => {
    // The adapter resolves the name from the engine's record (the launch's `sessionStarted`) and
    // attaches it as `run_identity`; the route names that, never a phase-sequence guess.
    const v = view();
    v.session.workflow_id = `wf-${RUN_ID}`;
    v.session.run_identity = { kind: 'workflow', name: 'custom-bug', user_plan: false, system: false };
    const phase = (id: string, kind: PhaseDef['kind'], role: PhaseDef['role']): PhaseDef => ({
      id, kind, gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false,
      required_deliverables: [], depends_on: [], role, skill_ref: null, allowed_skills: [], validator_pin: null,
    });
    const custom: WorkflowDef = { id: 'custom-bug', phases: [phase('fix', 'build', 'creator'), phase('verify', 'test', 'evaluator')] };
    const { app } = await buildApp([v], [custom]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` });
    expect(res.statusCode).toBe(200);
    expect(parseFramedDeliverText(res.body)!.body).toContain('workflow `custom-bug` · repo `wicked-studio`');
  });

  it('404s an unknown run', async () => {
    const { app } = await buildApp([view()]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/nope/deliver-text' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Run not found' });
  });

  it('hands the adapter a LAZY origin getter that resolves to the bound address once listening', async () => {
    const { app, setOrigin } = await buildApp([]);
    expect(setOrigin).toHaveBeenCalledTimes(1);
    const get = setOrigin.mock.calls[0]![0] as () => string | null;
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(get()).toBe(`http://127.0.0.1:${port}`);
  });
});

// crew#1885: the deliver script holds no operator bearer, so under `auth: required` the GET above answered it 401 and the
// PR went out with the launch-time text, none of the run's assurance lines on it. The script asks with the nonce its own
// command carries instead; the deliver unit's command here is the one the composer writes (`deliverPrScript`).
describe('POST /deliver/text (crew#1885)', () => {
  const NONCE = '0123456789abcdef0123456789abcdef';
  const REQUIRED: ResolvedAuth = {
    mode: 'required',
    verifiers: [{ name: 'test', verify: async (t) => (t === 'operator-token' ? { id: 'op', kind: 'human', trust: 'admin' } : null) }],
    allowedOrigins: null,
  };
  /** The run, its deliver unit carrying the script the composer writes for it, with this nonce. */
  function delivering(): SessionView {
    const v = view();
    const deliver = v.units.find((u) => u.id.endsWith(':deliver'))!;
    deliver.tool_cmd = ['bash', '-lc', deliverPrScript('fix issue #214', { runId: RUN_ID, nonce: NONCE, apiOrigin: 'http://127.0.0.1:7701' })];
    (v.session as { assurance?: unknown }).assurance = {
      mode: 'reduced',
      required: [],
    };
    return v;
  }
  const post = (app: FastifyInstance, body: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/deliver/text', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  it('answers the run\'s own deliver script, with no bearer, under required auth: the same text, assurance lines and all', async () => {
    const { app } = await buildApp([delivering()], [], REQUIRED);
    // The cause: the bearer route refuses the script, which holds no operator token.
    expect((await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` })).statusCode).toBe(401);
    const res = await post(app, { run: RUN_ID, nonce: NONCE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const body = parseFramedDeliverText(res.body)!.body;
    expect(body).toContain('**Reduced assurance**');
    // The same text an operator reads on the bearer route.
    const operator = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text`, headers: { authorization: 'Bearer operator-token' } });
    expect(operator.statusCode).toBe(200);
    expect(res.body).toBe(operator.body);
    // The nonce's case does not matter (hex), and the run id may come percent-encoded, as the script sends it.
    expect((await post(app, { run: encodeURIComponent(RUN_ID), nonce: NONCE.toUpperCase() })).statusCode).toBe(200);
  });

  it('refuses another nonce, another run\'s deliver nonce, a finished deliver unit and an unknown run alike (403, so it says nothing of which runs exist), and a bad body (400)', async () => {
    const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
    // Another run, delivering now, with its own deliver script and nonce.
    const other = view();
    other.session = { ...other.session, id: 'other-run' };
    other.units = other.units.map((u) => (u.id.endsWith(':deliver')
      ? { ...u, id: 'other-run:deliver', tool_cmd: ['bash', '-lc', deliverPrScript('other work', { runId: 'other-run', nonce: OTHER_NONCE, apiOrigin: 'http://127.0.0.1:7701' })] }
      : u));
    // A run whose deliver unit is done: its script printed the nonce in its exit sentinel, so the nonce reads nothing.
    const finished = delivering();
    finished.session = { ...finished.session, id: 'finished-run' };
    finished.units = finished.units.map((u) => (u.id.endsWith(':deliver') ? { ...u, status: 'done' } : u));
    const { app } = await buildApp([delivering(), other, finished], [], REQUIRED);
    expect((await post(app, { run: 'other-run', nonce: OTHER_NONCE })).statusCode).toBe(200); // the other run's own script
    for (const body of [
      { run: RUN_ID, nonce: OTHER_NONCE }, // another run's deliver nonce
      { run: 'other-run', nonce: NONCE }, // this run's nonce on another run
      { run: 'finished-run', nonce: NONCE }, // a finished deliver unit
      { run: 'nope', nonce: NONCE }, // an unknown run
    ]) {
      const res = await post(app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json()).toEqual({ code: 'not_the_deliver_script', error: "only this run's own deliver script can read its delivery text here" });
      expect(res.body).not.toContain(body.nonce); // the refusal never echoes a nonce
    }
    for (const body of [{ run: RUN_ID }, { run: RUN_ID, nonce: 'not-hex-at-all-x' }, { run: RUN_ID, nonce: 'abc' }, { run: '', nonce: NONCE }, { run: RUN_ID, nonce: NONCE, extra: 1 }]) {
      expect((await post(app, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers a post-hoc delivery\'s own text (composed with the QE check it was approved on) while its grant is held, and refuses after', async () => {
    const POST_HOC = 'abcdef0123456789abcdef0123456789';
    const { app } = await buildApp([view()], [], REQUIRED);
    const release = grantPostHocDeliverText(RUN_ID, POST_HOC, 'fix: composed for the post-hoc delivery\n\nbody\n');
    try {
      const res = await post(app, { run: RUN_ID, nonce: POST_HOC });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('fix: composed for the post-hoc delivery\n\nbody\n');
    } finally {
      release();
    }
    expect((await post(app, { run: RUN_ID, nonce: POST_HOC })).statusCode).toBe(403);
  });

  it('answers the same under auth off (the script asks one way in every mode)', async () => {
    const { app } = await buildApp([delivering()]);
    expect((await post(app, { run: RUN_ID, nonce: NONCE })).statusCode).toBe(200);
    expect((await post(app, { run: RUN_ID, nonce: 'fedcba9876543210fedcba9876543210' })).statusCode).toBe(403);
  });
});
