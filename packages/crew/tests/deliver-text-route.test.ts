// crew#524 / F-3R2-014 — `GET /runs/:id/deliver-text`: the PR title + body the deliver script asks
// its daemon for, composed from the PERSISTED RUN RECORD and answered as text/plain in the one
// framing both carriers share (line 1 title, line 2 blank, then the body).
//
// The route is what turns "the PR body is empty" into "the PR body is the run": the script cannot
// know at launch which seat took each phase, what the repo checks returned or what the evaluator
// said — the run record does, and this is where the script reads it.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { parseFramedDeliverText } from '../src/core/deliver-text.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { PhaseDef, SessionView, WorkflowDef, WorkUnit } from '../src/core/types.js';

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
): Promise<{ app: FastifyInstance; setOrigin: ReturnType<typeof vi.fn> }> {
  const setOrigin = vi.fn();
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    setDeliverApiOrigin: setOrigin,
    listWorkflows: () => workflows,
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    mockAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {},
  );
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, setOrigin };
}

describe('GET /runs/:id/deliver-text (crew#524)', () => {
  it('answers text/plain framed as title / blank / body, composed from the run record with a link to THIS daemon', async () => {
    const { app } = await buildApp([view()]);
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/deliver-text` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const text = parseFramedDeliverText(res.body);
    expect(text).not.toBeNull();
    expect(text!.title).toBe('the archive controls never render');
    expect(text!.body).toContain('Fixes #214');
    // The run link points at the daemon that answered — its own bound origin.
    expect(text!.body).toContain(`- Run: [\`${RUN_ID}\`](http://127.0.0.1:${port}/runs/${RUN_ID})`);
    expect(text!.body).toContain('workflow `bug` · repo `wicked-studio`');
    expect(text!.body).toContain('| `fix` | build | creator | claude | auto | approved |');
    expect(text!.body).toContain('| `verify` | test | evaluator | pi | human if verdict not pass | approved |');
    expect(text!.body).toContain('| `deliver` | build | neutral | tool | auto | this PR |');
    expect(text!.body).toContain('| test | `npm run test` | 0 | 1.5s |');
    expect(text!.body).toContain('- `verify` (pi): **approved**');
    expect(text!.body).toContain(`Delivered by [wicked-crew](https://wc.wickedagile.com) run \`${RUN_ID}\`.`);
  });

  it('names the workflow DEFINITION for a user-registered workflow whose view carries the engine instance id', async () => {
    // `sessionsDetail()` patches `wf-<uuid>` back to a name for BUILT-INS only; a user-registered
    // workflow is resolved here by phase sequence (fix, verify + the appended deliver).
    const v = view();
    v.session.workflow_id = `wf-${RUN_ID}`;
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
