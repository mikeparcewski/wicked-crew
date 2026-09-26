// Seam X2 — "what is this run?", answered from the ENGINE'S RECORD, never from the run's phase
// sequence.
//
// The real-engine block is the point: a preset launch goes through the engine's plan pipeline, whose
// floor INSERTS steps the preset never declared, so the run's unit sequence matches no def — the
// case that used to lose its answer. The run must still resolve to its preset for every caller that
// asks (acceptance, the steering-author landing, test-set registration, delivery candidacy); a user
// plan must resolve as a user plan; and a non-team registered workflow must still resolve. Skipped
// on an addon without the preset bindings / plan launch (the npm-pinned engine) — CI links an
// engine built from wicked-core main.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { canDeliverResolver } from '../src/api/delivery-index.js';
import { isSteeringAuthorRun } from '../src/api/steering-landing.js';
import { isQeAuthorRun } from '../src/qe/test-sets.js';
import {
  SYSTEM_WORKFLOWS,
  perRunPlanRunId,
  resolveRunIdentity,
  runIdentityOf,
  runWorkflowDef,
} from '../src/core/run-identity.js';
import type { PresetStep, SessionView, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

/** Two authored steps; the engine's floor adds the phases a no-`touch` plan lacks. */
const TWO_STEPS: PresetStep[] = [
  { catalog: 'understand', id: 'scope' },
  { catalog: 'build', id: 'make', depends_on: ['scope'] },
];

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function view(session: Record<string, unknown>, units: Array<Record<string, unknown>> = []): SessionView {
  return { session: { id: 'r1', status: 'executing', ...session }, units } as unknown as SessionView;
}

describe('resolveRunIdentity — the record, never the phase sequence', () => {
  it('a preset run is its preset, whatever steps the floor added', () => {
    const v = view(
      { workflow_id: 'wf-r1', team_plan: { rev: 1, accepted_rev: 1, preset: 'feature' } },
      [
        { id: 'r1:clarify', ord: 1, catalog: 'understand' },
        { id: 'r1:test_plan', ord: 2, catalog: 'test_plan' },
        { id: 'r1:build', ord: 3, catalog: 'build' },
      ],
    );
    expect(resolveRunIdentity(v)).toEqual({
      kind: 'preset',
      name: 'feature',
      user_plan: false,
      system: false,
      catalog: ['understand', 'test_plan', 'build'],
    });
  });

  it('a plan with no preset is a user plan — from the plan state, or from a `:plan-` id', () => {
    const planned = view({ workflow_id: 'wf-r1', team_plan: { rev: 2, accepted_rev: 2 } });
    expect(resolveRunIdentity(planned)).toMatchObject({ kind: 'user_plan', name: null, user_plan: true });
    expect(resolveRunIdentity(view({ workflow_id: 'r1:plan-3' })).kind).toBe('user_plan');
    // The launch record names the per-run def when the plan state is not written yet.
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }), 'r1:plan-1').kind).toBe('user_plan');
  });

  it("a non-team run is the def its launch recorded; a crew-composed per-run def reads as its base", () => {
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }), 'bug')).toMatchObject({ kind: 'workflow', name: 'bug' });
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }), 'bug-deliver-r1').name).toBe('bug');
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }), 'bug-verified-r1-deliver-r1').name).toBe('bug');
    expect(resolveRunIdentity(view({ workflow_id: 'onboarding' }))).toMatchObject({ kind: 'workflow', system: true });
  });

  it('free text and unknown are said, never guessed from unit ids', () => {
    const units = [{ id: 'r1:analyze', ord: 1 }, { id: 'r1:propose', ord: 2 }];
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }, units), null).kind).toBe('free_text');
    // No launch record and no plan state: the steering-author phase sequence above is NOT read.
    expect(resolveRunIdentity(view({ workflow_id: 'wf-r1' }, units))).toMatchObject({ kind: 'unknown', name: null });
  });

  it('perRunPlanRunId mirrors the engine: a positive decimal rev only', () => {
    expect(perRunPlanRunId('run-9:plan-12')).toBe('run-9');
    for (const bad of ['run-9:plan-0', 'run-9:plan-01', 'run-9:plan-', ':plan-1', 'run-9:plan-1a', 'feature']) {
      expect(perRunPlanRunId(bad)).toBeNull();
    }
  });
});

describe('the system list is ONE list', () => {
  it('GET /workflows stamps is_system from SYSTEM_WORKFLOWS and nowhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x2-system-'));
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    try {
      for (const def of adapter.listWorkflows()) {
        expect(def.is_system === true, def.id).toBe(SYSTEM_WORKFLOWS.has(def.id));
      }
      expect(adapter.getWorkflow('chat')?.is_system).toBe(true);
      expect(adapter.getWorkflow('feature')?.is_system).toBeUndefined();
    } finally {
      adapter.close();
      removeScratch(dir);
    }
  });
});

const probeDir = mkdtempSync(join(tmpdir(), 'x2-probe-'));
const probe = new CoreAdapter({ dbPath: join(probeDir, 'core.db'), stub: true });
const ENGINE_HAS_PLANS = probe.presetsSupported() && engineSupportsPlanLaunch();
probe.close();
removeScratch(probeDir);

describe.skipIf(!ENGINE_HAS_PLANS)('run identity through the real engine', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl: string;

  async function planned(runId: string): Promise<SessionView> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const v = (await adapter.sessionsDetail()).find((x) => x.session.id === runId);
      if (v !== undefined && v.units.length > 0) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run ${runId} planned no units within 20 s`);
  }

  async function launch(body: Record<string, unknown>): Promise<SessionView> {
    const res = await fetch(`${baseUrl}/api/v1/runs`, json({ problem: 'x2 identity', clisJson: SEATS, ...body }));
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    return planned(runId);
  }

  async function launchPreset(name: string, steps: PresetStep[] = TWO_STEPS): Promise<SessionView> {
    if (name !== 'feature') await adapter.putPreset(name, steps);
    const v = await launch({ workflow: name });
    // The floor added steps the preset never declared, so the unit sequence matches no def.
    expect(v.units.length).toBeGreaterThan(name === 'feature' ? 6 : steps.length);
    return v;
  }

  beforeAll(async () => {
    baseSkillOff();
    dir = mkdtempSync(join(tmpdir(), 'x2-engine-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
    adapter?.close();
    removeScratch(dir);
  });

  it('acceptance: the built-in feature preset run resolves to `feature` and keeps its requirement', async () => {
    const v = await launchPreset('feature');
    const res = await fetch(`${baseUrl}/api/v1/runs/${v.session.id}/acceptance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requirement: { declared: boolean; phases: string[] } };
    const declared = adapter.getWorkflow('feature')!.phases.filter((p) => p.verified_evidence === true).map((p) => p.id);
    expect(declared.length).toBeGreaterThan(0);
    expect(body.requirement).toEqual({ declared: true, phases: declared });
    expect(v.session.run_identity).toEqual({ kind: 'preset', name: 'feature', user_plan: false, system: false });
    expect(runIdentityOf(v).catalog).toContain('build');
    expect(v.session.workflow_id).toBe('feature');
  });

  it('steering-landing: a steering-author preset run is a steering-author run', async () => {
    const v = await launchPreset('steering-author');
    expect(v.session.run_identity).toMatchObject({ kind: 'preset', name: 'steering-author', system: true });
    expect(isSteeringAuthorRun(v)).toBe(true);
  });

  it('test-sets: a qe-author-tests preset run is a qe-author run', async () => {
    const v = await launchPreset('qe-author-tests');
    expect(isQeAuthorRun(v)).toBe(true);
  });

  it('delivery-index: a capture-learnings preset run classifies by ITS def (no code work ⇒ not a candidate)', async () => {
    const v = await launchPreset('capture-learnings');
    expect(runWorkflowDef(v, adapter.listWorkflows())?.id).toBe('capture-learnings');
    expect(canDeliverResolver(() => adapter.listWorkflows())(v)).toBe(false);
    const served = (await (await fetch(`${baseUrl}/api/v1/runs/${v.session.id}`)).json()) as { run: SessionView };
    expect(served.run.session.run_identity).toMatchObject({ name: 'capture-learnings', system: true });
  });

  it('a user plan resolves as a user plan', async () => {
    const v = await launch({ plan: { steps: [{ catalog: 'build' }] } });
    expect(v.session.run_identity).toEqual({ kind: 'user_plan', name: null, user_plan: true, system: false });
    expect(runWorkflowDef(v, adapter.listWorkflows())).toBeNull();
  });

  it('a non-team registered workflow still resolves — from the launch the engine recorded', async () => {
    const def: WorkflowDef = {
      id: 'x2-plain',
      phases: [
        { id: 'look', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: 'e2e7af1db9e48454' },
      ],
    };
    await adapter.registerWorkflow(def);
    const v = await launch({ workflow: 'x2-plain' });
    expect((v.session as { team_plan?: unknown }).team_plan).toBeUndefined();
    expect(v.session.run_identity).toEqual({ kind: 'workflow', name: 'x2-plain', user_plan: false, system: false });
    expect(v.session.workflow_id).toBe('x2-plain');
    const res = await fetch(`${baseUrl}/api/v1/runs/${v.session.id}/acceptance`);
    expect(((await res.json()) as { requirement: { declared: boolean } }).requirement.declared).toBe(true);
  });
});
