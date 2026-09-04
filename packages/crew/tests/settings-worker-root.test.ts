// worker_config_root (seat sign-in) — the settings half of the seam.
//
// The setting is persisted in settings.json, validated at the PUT boundary (absolute path or ""
// = engine default), and APPLIED as env WICKED_WORKER_HOME: at daemon boot (createServer) and on
// every settings change (the PUT route). The engine reads the env per worker spawn (acp_runner.rs
// claude_worker_home), so boot + on-change application is the whole mechanism — no restart seam.
//
// Route tests drive registerRoutes directly with an in-memory settings store (the adapter's
// merge semantics, no disk); the boot test builds a real createServer over the stub engine.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { BOOT_WORKER_HOME } from '../src/api/seat-signin.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import type { SystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

function restoreWorkerHome(): void {
  if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
  else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
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

describe('PUT/GET /settings worker_config_root', () => {
  let app: FastifyInstance | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worker-root-'));
  });

  afterEach(async () => {
    // Guarded: a pre-assignment failure must surface itself, not this cleanup (Copilot).
    await app?.close();
    app = undefined;
    removeScratch(dir);
    restoreWorkerHome();
  });

  it('round-trips an absolute path and applies it as WICKED_WORKER_HOME', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { worker_config_root: dir },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { settings: SystemSettings }).settings.worker_config_root).toBe(dir);
    // The env the engine reads per-spawn is applied IMMEDIATELY — no restart seam.
    expect(process.env['WICKED_WORKER_HOME']).toBe(dir);

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect((get.json() as { settings: SystemSettings }).settings.worker_config_root).toBe(dir);
  });

  it('clearing with "" persists the empty default and restores the boot-time env (crew#396)', async () => {
    app = buildApp(memoryAdapter({ worker_config_root: dir }));
    await app.ready();
    process.env['WICKED_WORKER_HOME'] = dir;

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { worker_config_root: '' },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { settings: SystemSettings }).settings.worker_config_root).toBe('');
    // NOT deleted: an unconditional delete re-aimed every later worker spawn at the operator's
    // REAL ~/.wicked-worker (crew#396). Unset restores what the process booted with — the
    // harness's hermetic arming here, an operator's exported value in production.
    expect(process.env['WICKED_WORKER_HOME']).toBe(BOOT_WORKER_HOME);
  });

  it('400s a relative path and leaves the env untouched', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();
    process.env['WICKED_WORKER_HOME'] = '/before';

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { worker_config_root: 'relative/worker-homes' },
    });
    expect(put.statusCode).toBe(400);
    expect((put.json() as { error: string }).error).toContain('worker_config_root');
    expect(process.env['WICKED_WORKER_HOME']).toBe('/before');
  });

  it('400s a non-string', async () => {
    app = buildApp(memoryAdapter());
    await app.ready();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { worker_config_root: 42 },
    });
    expect(put.statusCode).toBe(400);
  });

  it('a patch that does not name the root RE-APPLIES the persisted one (no clobber)', async () => {
    app = buildApp(memoryAdapter({ worker_config_root: dir }));
    await app.ready();
    delete process.env['WICKED_WORKER_HOME'];

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { graphNodeLimit: 100 },
    });
    expect(put.statusCode).toBe(200);
    // The merged result still carries the root, so the env comes back with it.
    expect(process.env['WICKED_WORKER_HOME']).toBe(dir);
  });
});

describe('adapter getSettings read-validation', () => {
  // The harness arms WICKED_CREW_SYSTEM_SETTINGS per PROCESS (tests/setup/hermetic-home.ts);
  // re-aim it per TEST so each case gets a fresh fixture file, and restore the armed value.
  const savedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'worker-root-home-'));
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(fakeHome, 'settings.json');
  });

  afterEach(() => {
    if (savedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = savedSettings;
    removeScratch(fakeHome);
  });

  function writeSettings(content: unknown): void {
    // settingsFilePath() reads the env at call time, which beforeEach points at the fixture.
    const file = settingsFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }

  // getSettings touches no engine state — calling it off the prototype avoids spawning a Core.
  const read = (): Promise<SystemSettings> =>
    CoreAdapter.prototype.getSettings.call({} as CoreAdapter);

  it('drops a hand-edited RELATIVE root rather than exporting it as WICKED_WORKER_HOME', async () => {
    writeSettings({ graphNodeLimit: 150, worker_config_root: 'relative/nope' });
    expect((await read()).worker_config_root).toBeUndefined();
  });

  it('keeps an absolute root and the empty default', async () => {
    writeSettings({ graphNodeLimit: 150, worker_config_root: '/srv/worker-homes' });
    expect((await read()).worker_config_root).toBe('/srv/worker-homes');
    writeSettings({ graphNodeLimit: 150, worker_config_root: '' });
    expect((await read()).worker_config_root).toBe('');
  });
});

describe('daemon boot applies the persisted root (createServer)', () => {
  let dir: string;
  let adapter: CoreAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worker-root-boot-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  });

  afterEach(() => {
    adapter.close();
    removeScratch(dir);
    restoreWorkerHome();
  });

  const options = () => ({
    projectEvents: { disabled: true },
    auditPath: join(dir, 'audit.log'),
    studioRoot: join(dir, 'no-studio'),
  });

  it('sets WICKED_WORKER_HOME from settings at boot', async () => {
    adapter.getSettings = async () => ({ graphNodeLimit: 150, worker_config_root: dir });
    delete process.env['WICKED_WORKER_HOME'];

    const app = await createServer(adapter, options());
    try {
      expect(process.env['WICKED_WORKER_HOME']).toBe(dir);
    } finally {
      await app.close();
    }
  });

  it('restores the boot-time env over a stale WICKED_WORKER_HOME when no root is persisted (crew#396)', async () => {
    adapter.getSettings = async () => ({ graphNodeLimit: 150 });
    process.env['WICKED_WORKER_HOME'] = '/stale';

    const app = await createServer(adapter, options());
    try {
      // The stale override goes, but the env is NOT deleted: boot over an empty settings store
      // used to delete it, which re-aimed every test-spawned worker at the operator's REAL
      // ~/.wicked-worker. The boot-time value (the harness's hermetic arming) comes back instead.
      expect(process.env['WICKED_WORKER_HOME']).toBe(BOOT_WORKER_HOME);
    } finally {
      await app.close();
    }
  });
});
