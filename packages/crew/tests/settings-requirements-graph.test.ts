// Requirements-graph minimum coverage (operator ruling 2026-10-31) — the settings half.
//
// `requirementsGraph.minCoveragePct` (a whole percentage 1..100, default 80 in the engine) is
// persisted in settings.json, validated at the PUT boundary, and APPLIED as env
// WICKED_REQUIREMENTS_MIN_COVERAGE_PCT on every settings change (the PUT route) and at boot
// (createServer → applyRequirementsGraphSettings). The engine's coverage check and its
// `domain-graph` step read it.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import {
  applyRequirementsGraphSettings,
  DEFAULT_MIN_COVERAGE_PCT,
  isRequirementsGraphSettings,
  minCoveragePct,
  REQUIREMENTS_MIN_COVERAGE_ENV,
} from '../src/core/requirements-graph-setting.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const saved = process.env[REQUIREMENTS_MIN_COVERAGE_ENV];
function restoreEnv(): void {
  if (saved === undefined) delete process.env[REQUIREMENTS_MIN_COVERAGE_ENV];
  else process.env[REQUIREMENTS_MIN_COVERAGE_ENV] = saved;
}

function memoryAdapter(initial?: Partial<SystemSettings>): CoreAdapter {
  let store: SystemSettings = { graphNodeLimit: 150, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
  } as unknown as CoreAdapter;
}

function buildApp(adapter: CoreAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache());
  return app;
}

describe('PUT/GET /settings requirementsGraph.minCoveragePct', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    restoreEnv();
  });

  it('round-trips and applies it as the env the engine reads', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { requirementsGraph: { minCoveragePct: 65 } },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { settings: SystemSettings }).settings.requirementsGraph).toEqual({ minCoveragePct: 65 });
    expect(process.env[REQUIREMENTS_MIN_COVERAGE_ENV]).toBe('65');
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect((get.json() as { settings: SystemSettings }).settings.requirementsGraph?.minCoveragePct).toBe(65);
  });

  it.each([
    [{ minCoveragePct: 0 }],
    [{ minCoveragePct: 101 }],
    [{ minCoveragePct: 80.5 }],
    [{ minCoveragePct: '80' }],
    [{ minCoveragePct: 80, extra: true }],
    [80],
    [null],
  ])('refuses %j with 400 and leaves the env alone', async (bad) => {
    process.env[REQUIREMENTS_MIN_COVERAGE_ENV] = '70';
    app = buildApp(memoryAdapter());
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { requirementsGraph: bad } });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toMatch(/requirementsGraph\.minCoveragePct/);
    expect(process.env[REQUIREMENTS_MIN_COVERAGE_ENV]).toBe('70');
  });

  it('clearing it ({}) deletes the variable so the engine default (80) holds', async () => {
    process.env[REQUIREMENTS_MIN_COVERAGE_ENV] = '65';
    app = buildApp(memoryAdapter({ requirementsGraph: { minCoveragePct: 65 } }));
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { requirementsGraph: {} } });
    expect(put.statusCode).toBe(200);
    expect(process.env[REQUIREMENTS_MIN_COVERAGE_ENV]).toBeUndefined();
  });
});

describe('requirements-graph setting helpers', () => {
  afterEach(restoreEnv);
  it('reads the minimum in force, defaulting to 80', () => {
    expect(DEFAULT_MIN_COVERAGE_PCT).toBe(80);
    expect(minCoveragePct(undefined)).toBe(80);
    expect(minCoveragePct({})).toBe(80);
    expect(minCoveragePct({ requirementsGraph: { minCoveragePct: 90 } })).toBe(90);
    expect(minCoveragePct({ requirementsGraph: { minCoveragePct: 900 } })).toBe(80);
  });
  it('boot application: a valid value is exported, an invalid one deletes the variable', () => {
    const env: NodeJS.ProcessEnv = {};
    applyRequirementsGraphSettings({ requirementsGraph: { minCoveragePct: 75 } }, env);
    expect(env[REQUIREMENTS_MIN_COVERAGE_ENV]).toBe('75');
    applyRequirementsGraphSettings({ requirementsGraph: { minCoveragePct: -1 } }, env);
    expect(env[REQUIREMENTS_MIN_COVERAGE_ENV]).toBeUndefined();
  });
  it('validates the object shape', () => {
    expect(isRequirementsGraphSettings({})).toBe(true);
    expect(isRequirementsGraphSettings({ minCoveragePct: 100 })).toBe(true);
    expect(isRequirementsGraphSettings({ minCoveragePct: 1 })).toBe(true);
    expect(isRequirementsGraphSettings([])).toBe(false);
  });
});
