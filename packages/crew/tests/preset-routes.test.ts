// `/api/v1/presets` (DES-TEAMING-002 §8.4, seam C2).
//
// Two halves:
//  1. The HTTP contract over a STUBBED adapter — status mapping (the engine's reason tokens →
//     409/404/400, an old addon → 501), zod strictness, the 404 on an absent row or a no-op delete.
//     These answer the same whatever engine is installed.
//  2. The acceptance (b) journey over the REAL engine (stub runner): `PUT /presets/my-flow` then
//     `POST /runs {workflow: "my-flow"}` launches exactly that selection — the engine resolves the
//     name; crew passes it through. Skipped on an addon without the preset bindings (the pinned
//     npm release predates them; crew CI builds core-ts from core main).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, PresetsUnsupportedError, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { Preset, PresetStep, WorkUnit } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

const MY_FLOW: PresetStep[] = [
  { catalog: 'understand', id: 'scope' },
  { catalog: 'build', id: 'make', depends_on: ['scope'] },
  { catalog: 'review', id: 'check', depends_on: ['make'] },
];

async function boot(name: string): Promise<{
  app: Awaited<ReturnType<typeof createServer>>;
  adapter: CoreAdapter;
  dir: string;
  baseUrl: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  return { adapter, dir, ...(await serve(adapter, dir)) };
}

async function serve(adapter: CoreAdapter, dir: string) {
  const app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { app, baseUrl };
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/v1/presets — HTTP contract (stubbed adapter)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const rows = new Map<string, Preset>();
  let unsupported = false;

  beforeAll(async () => {
    ctx = await boot('preset-routes');
    const a = ctx.adapter;
    a.listPresets = async (projectId?: string) => {
      if (unsupported) throw new PresetsUnsupportedError('Listing presets');
      const out = new Map<string, Preset>();
      for (const [k, p] of rows) if (k.startsWith('global/')) out.set(p.name, p);
      if (projectId !== undefined) for (const [k, p] of rows) if (k.startsWith(`project:${projectId}/`)) out.set(p.name, p);
      return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
    };
    a.putPreset = async (name: string, steps: PresetStep[], projectId?: string, createdBy?: string) => {
      if (unsupported) throw new PresetsUnsupportedError('Saving a preset');
      if (name === 'feature' && projectId === undefined) {
        throw new Error('preset_builtin_readonly: `feature` is a built-in preset');
      }
      if (projectId === 'proj_nope') throw new Error('preset_unknown_project: no project `proj_nope`');
      if (steps.some((s) => s['validator_pin'] === null)) {
        throw new Error('preset_invalid_steps: pin_removed: step b removes build\'s validator pin');
      }
      const scope = projectId === undefined ? 'global' : `project:${projectId}`;
      const p: Preset = { name, scope, steps, created_by: createdBy ?? 'api', updated_at: 1 };
      rows.set(`${scope}/${name}`, p);
      return p;
    };
    a.deletePreset = async (name: string, projectId?: string) => {
      if (unsupported) throw new PresetsUnsupportedError('Deleting a preset');
      if (name === 'feature' && projectId === undefined) {
        throw new Error('preset_builtin_readonly: `feature` is a built-in preset');
      }
      return rows.delete(`${projectId === undefined ? 'global' : `project:${projectId}`}/${name}`);
    };
    rows.set('global/feature', {
      name: 'feature',
      scope: 'global',
      steps: [{ catalog: 'understand', id: 'clarify' }],
      created_by: 'builtin',
      updated_at: 0,
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('PUT saves a global preset and GET lists and reads it', async () => {
    const put = await fetch(`${ctx.baseUrl}/api/v1/presets/my-flow`, { method: 'PUT', ...json({ steps: MY_FLOW }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { preset: Preset }).preset).toEqual({
      name: 'my-flow',
      scope: 'global',
      steps: MY_FLOW,
      created_by: 'api',
      updated_at: 1,
    });
    const list = (await (await fetch(`${ctx.baseUrl}/api/v1/presets`)).json()) as { presets: Preset[] };
    expect(list.presets.map((p) => `${p.name}@${p.scope}`)).toEqual(['feature@global', 'my-flow@global']);
    const one = await fetch(`${ctx.baseUrl}/api/v1/presets/my-flow`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { preset: Preset }).preset.steps).toEqual(MY_FLOW);
  });

  it('a project-scoped PUT shadows the global row only for that project', async () => {
    const put = await fetch(`${ctx.baseUrl}/api/v1/presets/feature`, {
      method: 'PUT',
      ...json({ steps: [{ catalog: 'understand', id: 'only' }], projectId: 'proj_1' }),
    });
    expect(put.status).toBe(200);
    const inProject = (await (await fetch(`${ctx.baseUrl}/api/v1/presets/feature?projectId=proj_1`)).json()) as {
      preset: Preset;
    };
    expect(inProject.preset.scope).toBe('project:proj_1');
    const global = (await (await fetch(`${ctx.baseUrl}/api/v1/presets/feature`)).json()) as { preset: Preset };
    expect(global.preset.scope).toBe('global');
  });

  it('maps the engine reason tokens: built-in 409, unknown project 404, invalid steps 400', async () => {
    const builtin = await fetch(`${ctx.baseUrl}/api/v1/presets/feature`, { method: 'PUT', ...json({ steps: MY_FLOW }) });
    expect(builtin.status).toBe(409);
    const del = await fetch(`${ctx.baseUrl}/api/v1/presets/feature`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: string }).error).toMatch(/^preset_builtin_readonly/);
    const proj = await fetch(`${ctx.baseUrl}/api/v1/presets/x`, {
      method: 'PUT',
      ...json({ steps: MY_FLOW, projectId: 'proj_nope' }),
    });
    expect(proj.status).toBe(404);
    const weak = await fetch(`${ctx.baseUrl}/api/v1/presets/weak`, {
      method: 'PUT',
      ...json({ steps: [{ catalog: 'build', id: 'b', validator_pin: null }] }),
    });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: string }).error).toMatch(/^preset_invalid_steps: pin_removed/);
  });

  it('refuses an unknown body key, a step without catalog/id, and empty steps (400)', async () => {
    for (const body of [
      { steps: MY_FLOW, stepz: [] },
      { steps: [{ id: 'x' }] },
      { steps: [] },
      {},
    ]) {
      const res = await fetch(`${ctx.baseUrl}/api/v1/presets/bad`, { method: 'PUT', ...json(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('DELETE removes a user preset (204) and a second DELETE is 404; GET of an absent name is 404', async () => {
    await fetch(`${ctx.baseUrl}/api/v1/presets/gone`, { method: 'PUT', ...json({ steps: MY_FLOW }) });
    expect((await fetch(`${ctx.baseUrl}/api/v1/presets/gone`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${ctx.baseUrl}/api/v1/presets/gone`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${ctx.baseUrl}/api/v1/presets/gone`)).status).toBe(404);
  });

  it('an addon without the bindings answers 501 on every route', async () => {
    unsupported = true;
    try {
      expect((await fetch(`${ctx.baseUrl}/api/v1/presets`)).status).toBe(501);
      expect((await fetch(`${ctx.baseUrl}/api/v1/presets/x`)).status).toBe(501);
      expect((await fetch(`${ctx.baseUrl}/api/v1/presets/x`, { method: 'PUT', ...json({ steps: MY_FLOW }) })).status).toBe(501);
      expect((await fetch(`${ctx.baseUrl}/api/v1/presets/x`, { method: 'DELETE' })).status).toBe(501);
    } finally {
      unsupported = false;
    }
  });
});

// ── Acceptance (b), (d), (f) over the real engine ────────────────────────────────────────────────

const probe = mkdtempSync(join(tmpdir(), 'preset-probe-'));
const probeAdapter = new CoreAdapter({ dbPath: join(probe, 'core.db'), stub: true });
const ENGINE_HAS_PRESETS = probeAdapter.presetsSupported();
probeAdapter.close();
removeScratch(probe);

async function unitsOf(adapter: CoreAdapter, runId: string): Promise<WorkUnit[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const view = (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
    if (view && view.units.length > 0) return view.units;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} planned no units within 10 s`);
}

/** `(phase id, stage, role)` per unit — the phase id is the unit id's suffix. */
const shape = (runId: string, units: WorkUnit[]) =>
  units.map((u) => [u.id.slice(runId.length + 1), u.stage, u.role]);

describe.skipIf(!ENGINE_HAS_PRESETS)('preset launch through the real engine', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    // Run mechanics, not grounding: the scratch HOME has no published skills generation, so the
    // base skill is switched off the way an operator does (tests/setup/base-skill-off.ts).
    baseSkillOff();
    ctx = await boot('preset-launch');
  });

  afterAll(async () => {
    await ctx.app.close();
    ctx.adapter.close();
    removeScratch(ctx.dir);
  });

  it('(b) PUT /presets/my-flow then POST /runs {workflow:"my-flow"} launches that selection', async () => {
    const put = await fetch(`${ctx.baseUrl}/api/v1/presets/my-flow`, { method: 'PUT', ...json({ steps: MY_FLOW }) });
    expect(put.status).toBe(200);
    const launch = await fetch(`${ctx.baseUrl}/api/v1/runs`, {
      method: 'POST',
      ...json({ problem: 'add SSO login', workflow: 'my-flow', clisJson: SEATS }),
    });
    expect(launch.status, await launch.clone().text()).toBe(201);
    const { runId } = (await launch.json()) as { runId: string };
    // DES-TEAMING-002 T3: an engine with the plan approval gate puts a preset launch through
    // the plan pipeline — a preset declares no `touch`, so its creator plan scores 100 ("no
    // declared scope") and floor fill inserts the 70-100 phases it lacks; an older engine
    // launches the selection as authored.
    expect(shape(runId, await unitsOf(ctx.adapter, runId))).toEqual(
      engineSupportsPlanLaunch()
        ? [
            ['scope', 'recon', 'neutral'],
            ['test_plan', 'test', 'neutral'],
            ['design', 'recon', 'neutral'],
            ['architecture', 'recon', 'neutral'],
            ['make', 'build', 'creator'],
            ['check', 'review', 'evaluator'],
            ['security_review', 'review', 'evaluator'],
          ]
        : [
            ['scope', 'recon', 'neutral'],
            ['make', 'build', 'creator'],
            ['check', 'review', 'evaluator'],
          ],
    );
  });

  it('(a) the built-in feature preset is listed and cannot be deleted (d)', async () => {
    const list = (await (await fetch(`${ctx.baseUrl}/api/v1/presets`)).json()) as { presets: Preset[] };
    const feature = list.presets.find((p) => p.name === 'feature');
    expect(feature?.created_by).toBe('builtin');
    expect(feature?.steps.map((s) => `${s.catalog}:${s.id}`)).toEqual([
      'understand:clarify',
      'design:design',
      'build:build',
      'review:adversarial-review',
      'test:test',
      'critique:review',
    ]);
    const del = await fetch(`${ctx.baseUrl}/api/v1/presets/feature`, { method: 'DELETE' });
    expect(del.status).toBe(409);
  });

  it('(f) a preset survives a daemon restart', async () => {
    await ctx.app.close();
    ctx.adapter.close();
    const adapter = new CoreAdapter({ dbPath: join(ctx.dir, 'core.db'), stub: true });
    ctx = { ...ctx, adapter, ...(await serve(adapter, ctx.dir)) };
    const one = await fetch(`${ctx.baseUrl}/api/v1/presets/my-flow`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { preset: Preset }).preset.steps).toEqual(MY_FLOW);
  });
});
