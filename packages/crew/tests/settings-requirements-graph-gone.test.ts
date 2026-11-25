// (J6 M1) The requirements-graph minimum and the page-loop knobs are no longer settings: a domain model has no share
// to reach and no pages. A PUT naming `requirementsGraph` (studio main's Settings, until S5) is a 200 that keeps
// nothing and exports nothing; one left in settings.json is dropped on read. The engine variables are never set.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import type { SystemSettings } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const ENGINE_VARS = ['WICKED_REQUIREMENTS_MIN_COVERAGE_PCT', 'WICKED_DOMAIN_MAX_PAGES', 'WICKED_DOMAIN_MAX_MINUTES', 'WICKED_DOMAIN_PAGE_SIZE'];

function memoryAdapter(initial?: Partial<SystemSettings>): { adapter: CoreAdapter; patches: Array<Partial<SystemSettings>> } {
  let store: SystemSettings = { graphNodeLimit: 150, ...initial };
  const patches: Array<Partial<SystemSettings>> = [];
  const adapter = {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      patches.push(patch);
      store = { ...store, ...patch };
      return { ...store };
    },
  } as unknown as CoreAdapter;
  return { adapter, patches };
}

describe('PUT /settings with requirementsGraph (J6 M1)', () => {
  let app: FastifyInstance | undefined;
  const saved = ENGINE_VARS.map((k) => [k, process.env[k]] as const);
  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it('is a 200 that keeps nothing and exports nothing, whatever the value', async () => {
    for (const k of ENGINE_VARS) delete process.env[k];
    const { adapter, patches } = memoryAdapter();
    app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache());
    await app.ready();
    for (const value of [{ minCoveragePct: 65 }, { maxPages: 5, maxMinutes: 30, pageSize: 100 }, 'nonsense']) {
      const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { requirementsGraph: value, graphNodeLimit: 200 } });
      expect(put.statusCode, put.body).toBe(200);
      expect(Object.hasOwn((put.json() as { settings: SystemSettings }).settings, 'requirementsGraph')).toBe(false);
    }
    // The other key in the same patch is written each time and read back; the dead one never reaches the store.
    expect(patches).toHaveLength(3);
    expect(patches.every((p) => !Object.hasOwn(p, 'requirementsGraph') && p.graphNodeLimit === 200)).toBe(true);
    const got = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect((got.json() as { settings: SystemSettings }).settings).toMatchObject({ graphNodeLimit: 200 });
    expect(Object.hasOwn((got.json() as { settings: SystemSettings }).settings, 'requirementsGraph')).toBe(false);
    for (const k of ENGINE_VARS) expect(process.env[k], k).toBeUndefined();
  });
});

describe('a settings.json written before J6 M1', () => {
  const savedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reqgraph-settings-'));
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(home, 'settings.json');
  });
  afterEach(() => {
    if (savedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = savedSettings;
    removeScratch(home);
  });

  it('drops its requirementsGraph on read and keeps the settings that exist', async () => {
    const file = settingsFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ graphNodeLimit: 150, requirementsGraph: { minCoveragePct: 65, maxPages: 5 } }));
    const read = await CoreAdapter.prototype.getSettings.call(Object.create(CoreAdapter.prototype) as CoreAdapter);
    expect(Object.hasOwn(read, 'requirementsGraph')).toBe(false);
    expect(read).toMatchObject({ graphNodeLimit: 150 });
  });
});
