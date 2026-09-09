// skills_root / skills_mirror — the settings half of the skills seam, modeled on worker_config_root:
// validated at the PUT boundary (absolute path or ""; strict boolean), allowlisted (an unknown key
// is dropped and NAMED in the audit entry), re-applied on every change (the store re-roots, seeds,
// publishes, exports WICKED_SKILLS_SNAPSHOT), and restored at daemon boot (createServer) — with the
// degradation ladder: no garden → fallback (engine input unset); a blocked first publish or a
// corrupt root → a refusal path the engine fails loudly on, surfaced on GET /diagnostics. Boot tests
// are HERMETIC: the provisioner is injected (`noVenv`) — no host `uv`, no downloads.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS, type DiagnosticsResponse, type SkillsManifestResponse, type SystemSettings } from '../src/core/types.js';
import { BOOT_SKILLS_SNAPSHOT, SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import { refusalPath, SkillsRuntime } from '../src/skills/runtime.js';
import { SKILLS_ROOT_ENV } from '../src/skills/store.js';
import { noVenv } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN, scaffold, type Scaffold } from './support/skills-fixture.js';

const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
const savedRootEnv = process.env[SKILLS_ROOT_ENV];

function restoreEnv(): void {
  if (savedSnapshotEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshotEnv;
  if (savedRootEnv === undefined) delete process.env[SKILLS_ROOT_ENV];
  else process.env[SKILLS_ROOT_ENV] = savedRootEnv;
}

/** In-memory settings store with the adapter's exact merge semantics (defaults + patch). */
function memoryAdapter(initial?: Partial<SystemSettings>): CoreAdapter {
  let store: SystemSettings = { ...DEFAULT_SETTINGS, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
    listWorkflows: () => [],
  } as unknown as CoreAdapter;
}

describe('PUT/GET /settings skills_root + skills_mirror', () => {
  let s: Scaffold;
  let app: FastifyInstance | undefined;
  let runtime: SkillsRuntime;

  beforeEach(() => {
    s = scaffold();
    // The harness arms WICKED_CREW_SKILLS_ROOT per process; the setting must win here, so unset it.
    delete process.env[SKILLS_ROOT_ENV];
    runtime = new SkillsRuntime({ store: s.store, mirrorHome: s.home, log: () => undefined });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(s.base);
    restoreEnv();
  });

  const build = (adapter: CoreAdapter): FastifyInstance => {
    const fastify = Fastify({ logger: false });
    registerRoutes(fastify, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, { skills: runtime });
    return fastify;
  };

  it('GET reports skills_mirror ON by default', async () => {
    app = build(memoryAdapter());
    await app.ready();
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect((get.json() as { settings: SystemSettings }).settings.skills_mirror).toBe(true);
  });

  it('round-trips an absolute skills_root, re-roots the store, seeds + publishes there, and exports the snapshot env', async () => {
    app = build(memoryAdapter());
    await app.ready();
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const newRoot = join(s.base, 'elsewhere');
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { skills_root: newRoot, skills_mirror: false } });
    expect(put.statusCode).toBe(200);
    const settings = (put.json() as { settings: SystemSettings }).settings;
    expect(settings.skills_root).toBe(newRoot);
    expect(settings.skills_mirror).toBe(false);
    expect(s.store.root).toBe(newRoot);
    expect(existsSync(join(newRoot, 'manifest.json'))).toBe(true);
    // The engine input is the absolute REAL path of the generation (v3.1 §2), and the only input.
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(realpathSync(join(newRoot, 'snapshots', '000001')));
    expect(process.env['WICKED_SKILLS_CURRENT']).toBeUndefined();
    expect(runtime.health()).toMatchObject({ state: 'published', root: newRoot, current: { gen: 1 }, findings: [] });
    // skills_mirror: false → nothing written into the home.
    expect(existsSync(join(s.home, '.codex'))).toBe(false);
  });

  it('400s a relative skills_root and a non-boolean skills_mirror, touching nothing', async () => {
    app = build(memoryAdapter());
    await app.ready();
    const rel = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { skills_root: 'relative/skills' } });
    expect(rel.statusCode).toBe(400);
    expect((rel.json() as { error: string }).error).toContain('skills_root');
    const flag = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { skills_mirror: 'yes' } });
    expect(flag.statusCode).toBe(400);
    expect((flag.json() as { error: string }).error).toContain('skills_mirror');
    expect(s.store.isSeeded()).toBe(false);
  });

  it('a patch that does not name the skills keys RE-APPLIES the persisted root (no clobber)', async () => {
    const root = join(s.base, 'persisted');
    app = build(memoryAdapter({ skills_root: root, skills_mirror: false }));
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { graphNodeLimit: 100 } });
    expect(put.statusCode).toBe(200);
    expect(s.store.root).toBe(root);
    expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(realpathSync(join(root, 'snapshots', '000001')));
  });
});

describe('adapter getSettings read-validation', () => {
  const savedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'skills-settings-'));
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(fakeHome, 'settings.json');
  });

  afterEach(() => {
    if (savedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = savedSettings;
    removeScratch(fakeHome);
  });

  function writeSettings(content: unknown): void {
    const file = settingsFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }

  const read = (): Promise<SystemSettings> => CoreAdapter.prototype.getSettings.call({} as CoreAdapter);

  it('drops a hand-edited relative skills_root and a non-boolean skills_mirror; keeps valid values and the empty default', async () => {
    writeSettings({ graphNodeLimit: 150, skills_root: 'relative/nope', skills_mirror: 'on' });
    const dropped = await read();
    expect(dropped.skills_root).toBeUndefined();
    expect(dropped.skills_mirror).toBe(true); // the shipped default, not the garbage
    writeSettings({ graphNodeLimit: 150, skills_root: '/srv/skills', skills_mirror: false });
    expect(await read()).toMatchObject({ skills_root: '/srv/skills', skills_mirror: false });
    writeSettings({ graphNodeLimit: 150, skills_root: '' });
    expect((await read()).skills_root).toBe('');
  });
});

describe('daemon boot applies the skills settings (createServer) — the degradation ladder', () => {
  let dir: string;
  let adapter: CoreAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-boot-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    // The fixture catalog does not carry the daemon's built-in skill_refs (domain*, repo-learn), and
    // a registered ref the catalog lacks is BLOCKING at publish — so the boot suite registers no
    // workflows; the blocked-first-publish rung has its own test below (a missing plugin catalog).
    adapter.listWorkflows = () => [];
    delete process.env[SKILLS_ROOT_ENV];
  });

  afterEach(() => {
    adapter.close();
    removeScratch(dir);
    restoreEnv();
  });

  const options = (skills: { source?: () => ReturnType<typeof pluginSourceAt>; disabled?: boolean }) => ({
    projectEvents: { disabled: true },
    auditPath: join(dir, 'audit.log'),
    studioRoot: join(dir, 'no-studio'),
    // HERMETIC: the provisioner is injected — a boot test never runs the host's `uv`.
    skills: { ...skills, mirrorHome: join(dir, 'home'), provisionVenv: noVenv },
  });

  const diagnostics = async (app: FastifyInstance): Promise<DiagnosticsResponse['skills']> =>
    ((await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse).skills;

  it('seeds the persisted skills_root from the plugin source, publishes, exports WICKED_SKILLS_SNAPSHOT, mirrors into the given home', async () => {
    const root = join(dir, 'skills-root');
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS, skills_root: root });
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const app = await createServer(adapter, options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }));
    try {
      expect(existsSync(join(root, 'manifest.json'))).toBe(true);
      // ONE engine input, the absolute REAL path of the generation (v3.1 §2); WICKED_SKILLS_CURRENT is never set.
      const real = realpathSync(join(root, 'snapshots', '000001'));
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real);
      expect(process.env['WICKED_SKILLS_CURRENT']).toBeUndefined();
      expect(existsSync(join(dir, 'home', '.codex', 'skills', 'wicked-garden-gamma', 'SKILL.md'))).toBe(true);
      const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as SkillsManifestResponse).current).toEqual({ gen: 1, path: real });
      expect(await diagnostics(app)).toMatchObject({ state: 'published', root, current: { gen: 1, path: real }, engineInput: real, findings: [] });
    } finally {
      await app.close();
    }
  });

  it('ABSENT configuration (no plugin source) is the fallback: the boot-time env is restored and skills.fallback is reported', async () => {
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS, skills_root: join(dir, 'skills-root') });
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = '/stale';
    const app = await createServer(adapter, options({ source: () => null }));
    try {
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(BOOT_SKILLS_SNAPSHOT);
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
      const skills = await diagnostics(app);
      expect(skills.state).toBe('fallback');
      expect(skills.findings.map((f) => f.kind)).toEqual(['skills.fallback']);
      expect(skills.findings[0]?.message).toContain('install wicked-garden first');
    } finally {
      await app.close();
    }
  });

  it('a BLOCKED first publish is never a fallback: the engine input points at a refusal path and skills.blocked is reported', async () => {
    const root = join(dir, 'skills-root');
    const plugin = join(dir, 'defective-plugin');
    cpSync(FIXTURE_PLUGIN, plugin, { recursive: true });
    rmSync(join(plugin, '.claude-plugin', 'archetypes.json')); // a required catalog is missing → publish blocks
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS, skills_root: root });
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = '/stale';
    const app = await createServer(adapter, options({ source: () => pluginSourceAt(plugin) }));
    try {
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(refusalPath(root, 'skills.blocked'));
      expect(existsSync(refusalPath(root, 'skills.blocked'))).toBe(false); // it does not exist — that is the point
      const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as SkillsManifestResponse).current).toBeNull();
      const skills = await diagnostics(app);
      expect(skills).toMatchObject({ state: 'blocked', root, current: null, engineInput: refusalPath(root, 'skills.blocked') });
      expect(skills.findings.map((f) => f.kind)).toEqual(['skills.blocked']);
      expect(skills.findings[0]?.message).toContain('missing-plugin-manifest');
    } finally {
      await app.close();
    }
  });

  it('a CORRUPT root is skills.config: never "restore and proceed" — the engine input points at a refusal path and /skills is 503', async () => {
    const root = join(dir, 'skills-root');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), 'not a manifest');
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS, skills_root: root });
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = '/stale';
    const app = await createServer(adapter, options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }));
    try {
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(refusalPath(root, 'skills.config'));
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
      const skills = await diagnostics(app);
      expect(skills).toMatchObject({ state: 'config-error', root, engineInput: refusalPath(root, 'skills.config') });
      expect(skills.findings.map((f) => f.kind)).toEqual(['skills.config']);
      expect(skills.findings[0]?.message).toContain('not a skills manifest');
    } finally {
      await app.close();
    }
  });

  it('skills: { disabled: true } registers the routes without a store', async () => {
    const app = await createServer(adapter, options({ disabled: true }));
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
      expect((await diagnostics(app)).state).toBe('disabled');
    } finally {
      await app.close();
    }
  });
});
