// studio#1150: a launch's human gates are ONE decision (`core/launch-posture.ts`). `POST /runs/preview` answers it for a
// body, `POST /runs` hands it to the engine. SAYS == DOES: for every body x daemon combination, what the preview says
// is what the launch does.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it, vi, type Mock } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';

const CODE_DEF = { id: 'bug', phases: [{ id: 'build', kind: 'build', role: 'creator', executes_code: true }] };
const READ_ONLY_DEF = { id: 'notes', phases: [{ id: 'understand', kind: 'recon', role: 'creator', executes_code: false }] };

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps.splice(0)) await a.close();
});

interface Daemon {
  supports: boolean;
  setting: boolean | undefined;
  deliverDefault: 'pr' | 'none';
}

async function daemon(d: Daemon) {
  const adapter: Record<string, Mock> = {
    launchRun: vi.fn().mockResolvedValue('run-1'),
    getSettings: vi.fn().mockResolvedValue({
      graphNodeLimit: 150,
      deliverDefault: d.deliverDefault,
      ...(d.setting !== undefined ? { powerModeDefault: d.setting } : {}),
    }),
    getWorkflow: vi.fn((name: string) => (name === 'notes' ? READ_ONLY_DEF : name === 'gone' ? null : CODE_DEF)),
    supportsPowerMode: vi.fn(() => d.supports),
    // `bug` and `notes` are presets; `my-def` is a registered def the engine plans the legacy way.
    listPresets: vi.fn().mockResolvedValue([
      { name: 'bug', scope: 'global', steps: [], created_by: 'builtin', updated_at: 0 },
      { name: 'notes', scope: 'global', steps: [], created_by: 'builtin', updated_at: 0 },
    ]),
    listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'r', root_path: '/nowhere', default_branch: 'main', registered_at: 0 }]),
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
  await app.ready();
  apps.push(app);
  return { app, adapter };
}

const PLAN = { steps: [{ catalog: 'build' }] };
const shapes: Array<Record<string, unknown>> = [
  { workflow: 'bug' },
  { workflow: 'notes' },
  { workflow: 'my-def' },
  { plan: PLAN },
  {},
];

function* bodies(): Generator<Record<string, unknown>> {
  for (const shape of shapes)
    for (const repoRef of [undefined, 'repo-1'])
      for (const power of [undefined, true, false])
        for (const humanConfirm of [undefined, 'none', 'before:2', 'all'])
          for (const deliver of [undefined, 'pr', 'none'])
            for (const deliverGate of [undefined, 'human', 'auto']) {
              yield {
                ...shape,
                ...(repoRef !== undefined ? { repoRef } : {}),
                ...(power !== undefined ? { power } : {}),
                ...(humanConfirm !== undefined ? { humanConfirm } : {}),
                ...(deliver !== undefined ? { deliver } : {}),
                ...(deliverGate !== undefined ? { deliverGate } : {}),
              };
            }
}

describe('POST /runs/preview == POST /runs (studio#1150)', () => {
  const daemons: Daemon[] = [];
  for (const supports of [true, false])
    for (const setting of [undefined, true, false])
      for (const deliverDefault of ['pr', 'none'] as const) daemons.push({ supports, setting, deliverDefault });

  it.each(daemons)('every body agrees on %o', async (d) => {
    const { app, adapter } = await daemon(d);
    let compared = 0;
    let powered = 0;
    let delivered = 0;
    let gated = 0;
    for (const body of bodies()) {
      const preview = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: body });
      adapter.launchRun!.mockClear();
      const launched = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', ...body } });
      const what = JSON.stringify(body);
      if (preview.statusCode === 400) {
        // A body the preview refuses is one the launch refuses too.
        expect(launched.statusCode, what).toBe(400);
        continue;
      }
      expect(preview.statusCode, what).toBe(200);
      if (launched.statusCode !== 201) {
        // The launch's own refusals the preview does not judge (deliver: pr with no workflow, an unknown repo…)
        // are loud, never a run with other gates than shown.
        expect(adapter.launchRun!, what).not.toHaveBeenCalled();
        continue;
      }
      const p = preview.json().posture as Record<string, unknown>;
      const input = adapter.launchRun!.mock.calls[0]![0] as LaunchRunInput;
      expect(input.power === true, `${what} power`).toBe(p['power']);
      expect(input.humanConfirm, `${what} humanConfirm`).toBe(p['humanConfirm']);
      expect(input.deliver ?? 'none', `${what} deliver`).toBe(p['deliver']);
      expect(input.autoDeliver === true, `${what} autoDeliver`).toBe(p['autoDeliver']);
      const answer = launched.json() as Record<string, unknown>;
      expect(answer['powerNotice'], `${what} powerNotice`).toBe(p['powerNotice']);
      expect(answer['humanConfirmNotice'], `${what} humanConfirmNotice`).toBe(p['humanConfirmNotice']);
      compared += 1;
      if (input.power === true) powered += 1;
      if (input.deliver === 'pr') delivered += 1;
      if (input.humanConfirm !== undefined && input.humanConfirm !== 'none') gated += 1;
    }
    // The matrix compares real launches, not only refusals.
    expect(compared).toBeGreaterThan(300);
    // …across power runs (where the engine supports it), deliveries and kept step gates.
    if (d.supports) expect(powered).toBeGreaterThan(0);
    else expect(powered).toBe(0);
    expect(delivered).toBeGreaterThan(0);
    expect(gated).toBeGreaterThan(0);
  }, 120_000);

  it('a power preset launch: the preview says power, hand-off only, and the posture it drops', async () => {
    const { app } = await daemon({ supports: true, setting: undefined, deliverDefault: 'pr' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      posture: {
        power: true,
        humanConfirm: 'none',
        deliver: 'pr',
        autoDeliver: false,
        humanConfirmNotice: 'power mode asks once, at hand-off: humanConfirm before:2 is not kept (launch with power: false to keep it)',
      },
    });
    // power: false keeps the step gate.
    const phased = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:2', power: false } });
    expect(phased.json().posture).toMatchObject({ power: false, humanConfirm: 'before:2' });
  });

  it('the setting cannot change a launch that said power explicitly (the form sends what it showed)', async () => {
    const { app, adapter } = await daemon({ supports: true, setting: true, deliverDefault: 'pr' });
    const shown = (await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'before:2' } })).json().posture;
    adapter.getSettings!.mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'pr', powerModeDefault: false });
    await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'before:2' } });
    const input = adapter.launchRun!.mock.calls.at(-1)![0] as LaunchRunInput;
    expect(input.power === true).toBe(shown.power);
    expect(input.humanConfirm).toBe(shown.humanConfirm);
  });

  it('launches nothing and refuses an unknown field', async () => {
    const { app, adapter } = await daemon({ supports: true, setting: undefined, deliverDefault: 'pr' });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', problem: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/problem/);
    await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(adapter.launchRun!).not.toHaveBeenCalled();
  });
});
