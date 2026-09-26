// DES-TEAMING-002 seam T3, the crew half: the COMMANDS `POST /runs {plan}` and
// `POST /runs/:id/gate` for a `plan_approval` gate (approve, approve with an edited plan, reject).
// Crew forwards; the ENGINE proposes, scores, floor-fills, gates and publishes every fact (§4.0).
//
// Two layers:
//   - the HTTP contract, against a real adapter whose napi calls are shadowed (what crew hands the
//     engine, what it refuses before asking, and the fail-closed 501 on an addon without the gate);
//   - the engine end to end (skipped until the linked addon carries `Core.supportsPlanLaunch`):
//     T2 (g) — an auto-mode `{plan:{steps:[{catalog:"build"}]}}` pauses `plan_approval` BEFORE
//     `build` dispatches — and the gate's three answers.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { DELIVER_PHASE_ID, EVIDENCE_FLOOR_PIN } from '../src/core/deliver.js';
import { createServer } from '../src/api/server.js';
import type { LaunchOptions } from 'wicked-core-ts';
import type { SessionView, WorkUnit } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const ENGINE_HAS_PLAN_GATE = engineSupportsPlanLaunch();

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function boot(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  const app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { dir, adapter, app, baseUrl };
}

/** Shadow a napi method with an own property (delete would silently keep the real one). */
function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

/** Run a body with the engine's plan gate present or absent (`CoreAdapter.supportsPlanLaunch`). */
async function withCapability<T>(a: CoreAdapter, present: boolean, body: () => Promise<T>): Promise<T> {
  a.supportsPlanLaunch = () => present;
  return body();
}

describe('POST /runs {plan} and the plan_approval gate — HTTP contract (shadowed engine)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let launched: LaunchOptions[];
  let gated: unknown[][];
  let registered: string[];

  beforeEach(async () => {
    ctx = await boot('plan-contract');
    launched = [];
    gated = [];
    stubCore(ctx.adapter, 'launchRun', (opts: LaunchOptions) => {
      launched.push(opts);
      return Promise.resolve(opts.sessionId);
    });
    registered = [];
    stubCore(ctx.adapter, 'registerWorkflow', (j: string) => {
      registered.push(j);
      return Promise.resolve('ok');
    });
    stubCore(ctx.adapter, 'confirmGate', (...args: unknown[]) => {
      gated.push(args);
      return Promise.resolve('executing');
    });
    // A run paused at a gate, for the gate route's own precondition.
    ctx.adapter.sessionsDetail = async () =>
      [{ session: { id: 'r1', status: 'awaiting_human' }, units: [] }] as unknown as SessionView[];
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('forwards the plan to the engine as planJson (T2 (g)\'s payload, step id omitted)', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = { steps: [{ catalog: 'build' }] };
      const res = await fetch(`${ctx.baseUrl}/api/v1/runs`, json({ problem: 'p', clisJson: SEATS, plan }));
      expect(res.status, await res.clone().text()).toBe(201);
      expect(launched).toHaveLength(1);
      const opts = launched[0] as LaunchOptions & { planJson?: string };
      expect(JSON.parse(opts.planJson ?? 'null')).toEqual(plan);
      expect(opts.workflow).toBeUndefined();
      // No humanConfirm on the wire ⇒ none reaches the engine (auto mode: the high-risk rule binds).
      expect(opts.humanConfirm).toBeUndefined();
    });
  });

  it('forwards touch and a manual-mode override unchanged', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = {
        steps: [{ catalog: 'build', id: 'make' }],
        touch: ['src/x.rs'],
        override: { remove: ['architecture'], reason: 'one-line fix' },
      };
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/runs`,
        json({ problem: 'p', clisJson: SEATS, humanConfirm: 'before:1', plan }),
      );
      expect(res.status).toBe(201);
      expect(JSON.parse((launched[0] as { planJson?: string }).planJson ?? 'null')).toEqual(plan);
    });
  });

  it('refuses a plan with a workflow and an unknown plan key (400), launching nothing', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const cases = [
        { problem: 'p', plan: { steps: [{ catalog: 'build' }] }, workflow: 'feature' },
        { problem: 'p', plan: { steps: [{ catalog: 'build' }], score: 0 } },
        { problem: 'p', plan: { steps: [] } },
      ];
      for (const body of cases) {
        const res = await fetch(`${ctx.baseUrl}/api/v1/runs`, json(body));
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(launched).toHaveLength(0);
    });
  });

  it('fails CLOSED with 501 on an addon without the plan gate — never an unplanned run', async () => {
    await withCapability(ctx.adapter, false, async () => {
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/runs`,
        json({ problem: 'p', clisJson: SEATS, plan: { steps: [{ catalog: 'build' }] } }),
      );
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toMatch(/supportsPlanLaunch/);
      expect(launched).toHaveLength(0);
    });
  });

  it('approve with an edited plan reaches the engine as confirmGate(…, "edit_plan", planJson)', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = { steps: [{ catalog: 'build', id: 'make' }, { catalog: 'test', id: 'prove' }] };
      const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json({ approve: true, plan }));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(gated).toEqual([['r1', true, undefined, 'edit_plan', undefined, JSON.stringify(plan)]]);
      const alsoNamed = await fetch(
        `${ctx.baseUrl}/api/v1/runs/r1/gate`,
        json({ approve: true, action: 'edit_plan', plan }),
      );
      expect(alsoNamed.status).toBe(200);
      expect(gated).toHaveLength(2);
    });
  });

  it('a plain approve and a reject keep the existing arity (no plan)', async () => {
    await withCapability(ctx.adapter, true, async () => {
      expect((await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json({ approve: true }))).status).toBe(200);
      expect((await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json({ approve: false }))).status).toBe(200);
      expect(gated).toEqual([
        ['r1', true, undefined],
        ['r1', false, undefined],
      ]);
    });
  });

  it('refuses an incoherent plan answer (400) before asking the engine', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = { steps: [{ catalog: 'build' }] };
      const cases = [
        { approve: false, plan },
        { approve: true, action: 'edit_plan' },
        { approve: true, action: 'approve', plan },
        { approve: true, plan, amend: 'also do x' },
        { approve: true, plan, amendScope: 'creator' },
      ];
      for (const body of cases) {
        const res = await fetch(`${ctx.baseUrl}/api/v1/runs/r1/gate`, json(body));
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(gated).toHaveLength(0);
    });
  });

  it('a delivering PRESET launch hands the engine its deliver step and composes no per-run def', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/runs`,
        json({ problem: 'ship SSO', clisJson: SEATS, workflow: 'feature', deliver: 'pr' }),
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const opts = launched[0] as LaunchOptions & { deliverStepJson?: string; planJson?: string };
      // The preset itself is launched — the engine floor-fills and gates it — never feature-deliver-<run>.
      expect(opts.workflow).toBe('feature');
      expect(opts.planJson).toBeUndefined();
      expect(registered).toEqual([]);
      const step = JSON.parse(opts.deliverStepJson ?? 'null') as Record<string, unknown>;
      expect(step['catalog']).toBe('deliver');
      expect(step['id']).toBe(DELIVER_PHASE_ID);
      expect(step['validator_pin']).toBe(EVIDENCE_FLOOR_PIN);
      expect((step['executor'] as { type: string; cmd: string[] }).type).toBe('tool');
      expect((step['executor'] as { cmd: string[] }).cmd[0]).toBe('bash');
      expect(step['depends_on']).toBeUndefined();
    });
  });

  it('T8: a delivering PLAN launch hands the engine the plan and its deliver step', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = { steps: [{ catalog: 'build' }] };
      const res = await fetch(`${ctx.baseUrl}/api/v1/runs`, json({ problem: 'ship SSO', clisJson: SEATS, plan, deliver: 'pr' }));
      expect(res.status, await res.clone().text()).toBe(201);
      const opts = launched[0] as LaunchOptions & { deliverStepJson?: string; planJson?: string };
      expect(JSON.parse(opts.planJson ?? 'null')).toEqual(plan);
      expect(opts.workflow).toBeUndefined();
      expect(registered).toEqual([]);
      const step = JSON.parse(opts.deliverStepJson ?? 'null') as Record<string, unknown>;
      expect(step['catalog']).toBe('deliver');
      expect(step['id']).toBe(DELIVER_PHASE_ID);
      expect(step['validator_pin']).toBe(EVIDENCE_FLOOR_PIN);
      expect((step['executor'] as { type: string }).type).toBe('tool');
    });
  });

  it('T8: a plan launch without deliver hands no deliver step; requireDeliverables with a plan is refused', async () => {
    await withCapability(ctx.adapter, true, async () => {
      const plan = { steps: [{ catalog: 'build' }] };
      const res = await fetch(`${ctx.baseUrl}/api/v1/runs`, json({ problem: 'p', clisJson: SEATS, plan }));
      expect(res.status).toBe(201);
      expect((launched[0] as { deliverStepJson?: string }).deliverStepJson).toBeUndefined();
      await expect(
        ctx.adapter.launchRun({ problem: 'p', sessionId: 'r-plan-floor', clisJson: SEATS, plan, requireDeliverables: ['out/r.md'] }),
      ).rejects.toThrow(/requireDeliverables with a plan/);
    });
  });

  it('a delivering preset on an addon without the gate is a 501 — no composed fallback', async () => {
    await withCapability(ctx.adapter, false, async () => {
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/runs`,
        json({ problem: 'ship SSO', clisJson: SEATS, workflow: 'feature', deliver: 'pr' }),
      );
      expect(res.status).toBe(501);
      expect(launched).toHaveLength(0);
      expect(registered).toEqual([]);
    });
  });

  it('requireDeliverables on a preset launch is refused, never composed past the gate', async () => {
    await withCapability(ctx.adapter, true, async () => {
      await expect(
        ctx.adapter.launchRun({
          problem: 'p',
          sessionId: 'r-floor',
          clisJson: SEATS,
          workflow: 'feature',
          requireDeliverables: ['out/report.md'],
        }),
      ).rejects.toThrow(/requireDeliverables on a preset launch/);
      expect(launched).toHaveLength(0);
      expect(registered).toEqual([]);
    });
  });

  it('an edited plan on an addon without the gate is a 501, never an unedited approve', async () => {
    await withCapability(ctx.adapter, false, async () => {
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/runs/r1/gate`,
        json({ approve: true, plan: { steps: [{ catalog: 'build' }] } }),
      );
      expect(res.status).toBe(501);
      expect(gated).toHaveLength(0);
    });
  });
});

// ── The engine end to end ─────────────────────────────────────────────────────────────────────

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  // Generous: a loaded CI host must never flake; returns as soon as the condition holds.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const got = await probe();
    if (got !== undefined) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function viewOf(adapter: CoreAdapter, runId: string): Promise<SessionView | undefined> {
  return (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
}

const ids = (runId: string, units: WorkUnit[]) => units.map((u) => u.id.slice(runId.length + 1));

describe.skipIf(!ENGINE_HAS_PLAN_GATE)('the plan approval gate through the real engine', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    // Run mechanics, not grounding (tests/setup/base-skill-off.ts).
    baseSkillOff();
    ctx = await boot('plan-engine');
  });

  afterAll(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  async function launch(sessionId: string, plan: unknown): Promise<SessionView> {
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs`, json({ problem: 'add SSO login', sessionId, clisJson: SEATS, plan }));
    expect(res.status, await res.clone().text()).toBe(201);
    return waitFor('the plan_approval pause', async () => {
      const v = await viewOf(ctx.adapter, sessionId);
      return v?.session.status === 'awaiting_human' ? v : undefined;
    });
  }

  it('T2 (g): an auto-mode build plan with no touch pauses plan_approval before build dispatches', async () => {
    const v = await launch('t3-g', { steps: [{ catalog: 'build' }] });
    // The 70-100 floor around the lone build (no deliver: the run does not deliver).
    expect(ids('t3-g', v.units)).toEqual([
      'test_plan',
      'design',
      'architecture',
      'build',
      'review',
      'security_review',
    ]);
    expect(v.units.every((u) => u.status === 'pending' || u.status === 'distributed')).toBe(true);
    const open = (await ctx.adapter.interactionRequests('t3-g', 'open')) ?? [];
    expect(open.map((r) => (r as { gate_kind?: string }).gate_kind)).toEqual(['plan_approval']);
    expect(open[0]?.ord).toBe(1);
  });

  it('approve with an edited plan re-plans onto rev 2 and releases its first unit', async () => {
    await launch('t3-e', { steps: [{ catalog: 'build' }] });
    const res = await fetch(
      `${ctx.baseUrl}/api/v1/runs/t3-e/gate`,
      json({ approve: true, plan: { steps: [{ catalog: 'build', id: 'make' }, { catalog: 'test', id: 'prove' }] } }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const v = await waitFor('the re-planned run', async () => {
      const view = await viewOf(ctx.adapter, 't3-e');
      return view && ids('t3-e', view.units).includes('make') ? view : undefined;
    });
    expect(ids('t3-e', v.units)).toEqual([
      'test_plan',
      'design',
      'architecture',
      'make',
      'prove',
      'review',
      'security_review',
    ]);
  });

  it('reject cancels', async () => {
    await launch('t3-f', { steps: [{ catalog: 'build' }] });
    const res = await fetch(`${ctx.baseUrl}/api/v1/runs/t3-f/gate`, json({ approve: false }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('cancelled');
  });

  it('the DEFAULT launch — a repo-scoped feature with deliver:"pr", auto mode, no touch — pauses plan_approval before build', async () => {
    // A real clone of a local bare origin (the worktree base resolution fetches origin).
    const origin = join(ctx.dir, 'origin.git');
    const seed = join(ctx.dir, 'seed');
    const clone = join(ctx.dir, 'clone');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    git(seed, 'config', 'user.email', 'seed@test');
    git(seed, 'config', 'user.name', 'seed');
    writeFileSync(join(seed, 'README.md'), '# t3\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'base');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, clone]);
    await ctx.adapter.registerRepo('t3-deliver-ws', clone);
    const repoId = (await ctx.adapter.listRepos()).find((r) => r.name === 't3-deliver-ws')!.id;

    const res = await fetch(
      `${ctx.baseUrl}/api/v1/runs`,
      json({ problem: 'add SSO login', sessionId: 't3-dlv', clisJson: SEATS, workflow: 'feature', repoRef: repoId, deliver: 'pr' }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const v = await waitFor('the plan_approval pause', async () => {
      const view = await viewOf(ctx.adapter, 't3-dlv');
      return view?.session.status === 'awaiting_human' ? view : undefined;
    });
    // The preset, floor-filled at 100 ("no declared scope"), with crew's deliver step last.
    expect(ids('t3-dlv', v.units)).toEqual([
      'clarify',
      'test_plan',
      'design',
      'architecture',
      'build',
      'adversarial-review',
      'test',
      'review',
      'security_review',
      'deliver',
    ]);
    expect(v.units.every((u) => u.status === 'pending' || u.status === 'distributed')).toBe(true);
    const open = (await ctx.adapter.interactionRequests('t3-dlv', 'open')) ?? [];
    expect(open.map((r) => (r as { gate_kind?: string }).gate_kind)).toEqual(['plan_approval']);
    expect(open[0]?.ord).toBe(1);
    // No per-run composed def was armed for the launch.
    expect(ctx.adapter.listWorkflows().map((w) => w.id).filter((id) => id.includes('-deliver-'))).toEqual([]);
  });

  it('an understand-only plan scores 0 and is not held in auto mode', async () => {
    const res = await fetch(
      `${ctx.baseUrl}/api/v1/runs`,
      json({ problem: 'survey', sessionId: 't3-u', clisJson: SEATS, plan: { steps: [{ catalog: 'understand' }] } }),
    );
    expect(res.status).toBe(201);
    await waitFor('the first dispatch', async () => {
      const v = await viewOf(ctx.adapter, 't3-u');
      return v && v.session.status !== 'planning' && v.session.status !== 'distributing' ? v : undefined;
    });
    const open = (await ctx.adapter.interactionRequests('t3-u', 'open')) ?? [];
    expect(open.filter((r) => (r as { gate_kind?: string }).gate_kind === 'plan_approval')).toEqual([]);
  });
});
