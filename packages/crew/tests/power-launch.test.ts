// Power mode at launch (program DES-POWER-MODE; operator ruling 2026-10-29): a New job runs in power
// mode unless the launch or the Settings default says otherwise, only a repo-scoped plan or preset
// launch can, and a power launch has no plan-approval gate (humanConfirm forced to none).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';

const READ_ONLY_DEF = { id: 'bug', phases: [{ id: 'understand', kind: 'recon', role: 'creator', executes_code: false }] };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function launch(opts: { supports: boolean; setting?: boolean; body: Record<string, unknown> }) {
  const adapter: Record<string, Mock> = {
    launchRun: vi.fn().mockResolvedValue('run-1'),
    getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'none', ...(opts.setting !== undefined ? { powerModeDefault: opts.setting } : {}) }),
    getWorkflow: vi.fn().mockReturnValue(READ_ONLY_DEF),
    supportsPowerMode: vi.fn(() => opts.supports),
    listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'r', root_path: '/nowhere', default_branch: 'main', registered_at: 0 }]),
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
  await app.ready();
  apps.push(app);
  const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', ...opts.body } });
  const input = adapter.launchRun!.mock.calls[0]?.[0] as LaunchRunInput | undefined;
  return { res, input };
}

describe('POST /runs power mode', () => {
  it('runs a repo-scoped preset launch in power mode by default, with no plan gate', async () => {
    const { res, input } = await launch({ supports: true, body: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:1' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ runId: 'run-1', power: true });
    expect(input?.power).toBe(true);
    expect(input?.humanConfirm).toBe('none');
  });

  it('honours the Settings default off, and the launch\'s own word over it', async () => {
    const off = await launch({ supports: true, setting: false, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(off.input?.power).toBeUndefined();
    expect(off.res.json().power).toBeUndefined();
    const on = await launch({ supports: true, setting: false, body: { workflow: 'bug', repoRef: 'repo-1', power: true } });
    expect(on.input?.power).toBe(true);
    const no = await launch({ supports: true, body: { workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'all' } });
    expect(no.input?.power).toBeUndefined();
    expect(no.input?.humanConfirm).toBe('all');
  });

  it('runs phased, and says why, when the launch has no repo or the engine has no power mode', async () => {
    const repoless = await launch({ supports: true, body: { workflow: 'bug', power: true } });
    expect(repoless.input?.power).toBeUndefined();
    expect(repoless.res.json().powerNotice).toMatch(/repo-scoped/);
    const old = await launch({ supports: false, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(old.input?.power).toBeUndefined();
    expect(old.res.json().powerNotice).toBeUndefined();
    const oldAsked = await launch({ supports: false, body: { workflow: 'bug', repoRef: 'repo-1', power: true } });
    expect(oldAsked.res.json().powerNotice).toMatch(/no power mode/);
  });
});
