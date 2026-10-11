// Council size + spawn stagger (operator ruling 2026-10-11, wicked-core#888) — the settings half.
//
// `councilSize` (1..9, default 3 in the engine) and `councilSpawnStaggerMs` (0..30000, default
// 3000) are persisted in settings.json, validated at the PUT boundary, and APPLIED as env
// WICKED_COUNCIL_SIZE / WICKED_COUNCIL_SPAWN_STAGGER_MS — on every settings change (the PUT route)
// and at boot (createServer → applyCouncilSettings). The engine reads both per council.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import {
  applyCouncilSettings,
  COUNCIL_SIZE_ENV,
  COUNCIL_STAGGER_ENV,
} from '../src/core/council-settings.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const saved = {
  size: process.env[COUNCIL_SIZE_ENV],
  stagger: process.env[COUNCIL_STAGGER_ENV],
};

function restoreEnv(): void {
  if (saved.size === undefined) delete process.env[COUNCIL_SIZE_ENV];
  else process.env[COUNCIL_SIZE_ENV] = saved.size;
  if (saved.stagger === undefined) delete process.env[COUNCIL_STAGGER_ENV];
  else process.env[COUNCIL_STAGGER_ENV] = saved.stagger;
}

/** In-memory settings store with the adapter's exact merge semantics (defaults + patch). */
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

describe('PUT/GET /settings councilSize + councilSpawnStaggerMs', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    restoreEnv();
  });

  it('round-trips both and applies them as the env the engine reads per council', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { councilSize: 5, councilSpawnStaggerMs: 4000 },
    });
    expect(put.statusCode).toBe(200);
    const { settings } = put.json() as { settings: SystemSettings };
    expect(settings.councilSize).toBe(5);
    expect(settings.councilSpawnStaggerMs).toBe(4000);
    expect(process.env[COUNCIL_SIZE_ENV]).toBe('5');
    expect(process.env[COUNCIL_STAGGER_ENV]).toBe('4000');

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect((get.json() as { settings: SystemSettings }).settings.councilSize).toBe(5);
  });

  it('a zero stagger is a valid choice (spawn together)', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { councilSpawnStaggerMs: 0 },
    });
    expect(put.statusCode).toBe(200);
    expect(process.env[COUNCIL_STAGGER_ENV]).toBe('0');
  });

  it.each([0, 10, 2.5, '3', null])('400s councilSize %s and leaves the env untouched', async (bad) => {
    app = buildApp(memoryAdapter());
    await app.ready();
    process.env[COUNCIL_SIZE_ENV] = '4';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { councilSize: bad },
    });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toMatch(/councilSize/);
    expect(process.env[COUNCIL_SIZE_ENV]).toBe('4');
  });

  it.each([-1, 30001, 1.5, '3000'])('400s councilSpawnStaggerMs %s', async (bad) => {
    app = buildApp(memoryAdapter());
    await app.ready();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { councilSpawnStaggerMs: bad },
    });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toMatch(/councilSpawnStaggerMs/);
  });

  it('an unset setting deletes the variable so the engine default (3 seats, 3000 ms) holds', () => {
    const env: NodeJS.ProcessEnv = { [COUNCIL_SIZE_ENV]: '7', [COUNCIL_STAGGER_ENV]: '9' };
    applyCouncilSettings({}, env);
    expect(env[COUNCIL_SIZE_ENV]).toBeUndefined();
    expect(env[COUNCIL_STAGGER_ENV]).toBeUndefined();
    applyCouncilSettings({ councilSize: 2, councilSpawnStaggerMs: 5000 }, env);
    expect(env).toMatchObject({ [COUNCIL_SIZE_ENV]: '2', [COUNCIL_STAGGER_ENV]: '5000' });
    // A hand-edited invalid value is never exported.
    applyCouncilSettings({ councilSize: 99, councilSpawnStaggerMs: -5 }, env);
    expect(env[COUNCIL_SIZE_ENV]).toBeUndefined();
    expect(env[COUNCIL_STAGGER_ENV]).toBeUndefined();
  });
});
