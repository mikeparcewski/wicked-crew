// The skills root is NOT a setting (skills keystone; codex round 5 / coordinator decision): it is
// `<state home>/skills`, full stop — design v3.1 §1 (one storage root) and v3.2 §1 (never a user
// CLI directory) leave no room for a configurable root, and a `skills_root` setting accepting any
// absolute path let `PUT /settings` aim the SEED at `~/.codex/skills`. So: `skills_root` and
// `WICKED_CREW_SKILLS_ROOT` are retired — a PUT carrying `skills_root` has it DROPPED and named in
// the audit entry's `ignored` (like the withdrawn `skills_mirror`), GET never shows it, a hand-edited
// settings.json value is dropped on read, the env is ignored — and the daemon REFUSES TO START
// (`SkillsRootUnfencedError`) when the root's canonical path leaves the state home or lands inside
// a user CLI directory (`~/.codex`, `~/.pi`, `~/.copilot`, `~/.config/opencode`, `~/.claude`,
// `CLAUDE_CONFIG_DIR`). Boot tests configure the state home the way the CLI does
// (`setCrewStateHome(<--db parent>)`) and are HERMETIC: the provisioner is injected (`noVenv`).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS, type DiagnosticsResponse, type SkillsManifestResponse, type SystemSettings } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { BOOT_SKILLS_SNAPSHOT, canonicalCrewStateHome, SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { pluginSourceAt, type PluginSource } from '../src/skills/plugin-source.js';
import { assertSkillsRootFenced, canonicalPath, SkillsRootUnfencedError, userCliDirs } from '../src/skills/root-fence.js';
import { refusalPath, SkillsRuntime } from '../src/skills/runtime.js';
import { COPILOT_VIEW_SKILLS_REL, resolveSkillsRoot, SKILLS_DIRNAME } from '../src/skills/store.js';
import { noVenv } from '../src/skills/venv.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN, scaffold, type Scaffold } from './support/skills-fixture.js';

/** The retired override — spelled here only to prove it has no effect. */
const RETIRED_ROOT_ENV = 'WICKED_CREW_SKILLS_ROOT';
const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
const savedRetiredEnv = process.env[RETIRED_ROOT_ENV];
/** Whatever the process carried under the RETIRED engine-input name — crew must leave it untouched (v3.4 §2). */
const stateHomeEnvBefore = process.env['WICKED_CREW_STATE_HOME'];
/** The state home the harness armed (tests/setup/hermetic-home.ts) — every test restores it. */
const armedStateHome = crewStateHome();

function restoreEnv(): void {
  if (savedSnapshotEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshotEnv;
  if (savedRetiredEnv === undefined) delete process.env[RETIRED_ROOT_ENV];
  else process.env[RETIRED_ROOT_ENV] = savedRetiredEnv;
  setCrewStateHome(armedStateHome);
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

describe('skills_root is NOT a setting (PUT/GET /settings)', () => {
  let s: Scaffold;
  let app: FastifyInstance | undefined;
  let runtime: SkillsRuntime;
  let audit: AuditLog;

  beforeEach(() => {
    s = scaffold();
    runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    audit = new AuditLog(join(s.base, 'audit.log'), () => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(s.base);
    restoreEnv();
  });

  const build = (adapter: CoreAdapter): FastifyInstance => {
    const fastify = Fastify({ logger: false });
    registerRoutes(fastify, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, { audit, authMode: 'off' }, { skills: runtime });
    return fastify;
  };

  it('a PUT carrying skills_root is a 200 that DROPS the key (named in the audit `ignored`), re-roots nothing, seeds nothing, and GET never shows it', async () => {
    app = build(memoryAdapter());
    await app.ready();
    const elsewhere = join(s.base, 'elsewhere');
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { skills_root: elsewhere, graphNodeLimit: 100 } });
    expect(put.statusCode).toBe(200);
    const settings = (put.json() as { settings: Record<string, unknown> }).settings;
    expect(Object.hasOwn(settings, 'skills_root')).toBe(false);
    expect(settings['graphNodeLimit']).toBe(100);
    expect(s.store.root).toBe(s.root); // never re-aimed
    expect(existsSync(elsewhere)).toBe(false); // nothing seeded anywhere else
    expect(s.store.isSeeded()).toBe(false); // …and no re-apply seeded the store either
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(Object.hasOwn((get.json() as { settings: Record<string, unknown> }).settings, 'skills_root')).toBe(false);
    expect(Object.hasOwn(DEFAULT_SETTINGS, 'skills_root')).toBe(false);
    await audit.flush();
    const entries = await audit.read({ action: 'settings.updated' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({ changed: ['graphNodeLimit'], ignored: ['skills_root'] });
  });

  it('skills_mirror is NOT a setting either (design v3.2 §1): dropped, not honored, never shown', async () => {
    app = build(memoryAdapter());
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { skills_mirror: true } });
    expect(put.statusCode).toBe(200);
    const settings = (put.json() as { settings: Record<string, unknown> }).settings;
    expect(Object.hasOwn(settings, 'skills_mirror')).toBe(false);
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(Object.hasOwn((get.json() as { settings: Record<string, unknown> }).settings, 'skills_mirror')).toBe(false);
    expect(Object.hasOwn(DEFAULT_SETTINGS, 'skills_mirror')).toBe(false);
  });

  it('the boot seed log names the ACTUAL source — kind, path and plugin version — never an assumed installed plugin (Copilot on #480): a plugin directory, a git checkout, the plugin cache; an already-seeded root logs no seed line', async () => {
    const saved = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    try {
      // The scaffold seeds from a writable COPY of the fixture: a plain directory (no `.git`, no `plugins` segment).
      const source = pluginSourceAt(s.upstream);
      expect(source?.kind).toBe('directory');
      const lines: string[] = [];
      const seeding = new SkillsRuntime({ store: s.store, log: (m) => lines.push(m) });
      await seeding.apply();
      const seedLine = lines.find((l) => l.startsWith('[skills] seeded '));
      expect(seedLine).toBe(
        `[skills] seeded ${s.root} from a plugin directory (an explicit plugin root — WICKED_CREW_SKILLS_SOURCE or the configured source) at ${s.upstream}, plugin version ${source?.plugin_version ?? '?'}, source kind directory`,
      );
      expect(seedLine).not.toContain('installed wicked-garden plugin');
      // Already seeded: a second boot re-verifies and logs no seed line at all.
      lines.length = 0;
      await seeding.apply();
      expect(lines.some((l) => l.startsWith('[skills] seeded '))).toBe(false);
      // A git checkout as the explicit source (classified by its `.git`).
      const co = scaffold();
      try {
        mkdirSync(join(co.upstream, '.git'));
        const coLines: string[] = [];
        await new SkillsRuntime({ store: co.store, log: (m) => coLines.push(m) }).apply();
        expect(coLines.find((l) => l.startsWith('[skills] seeded '))).toBe(
          `[skills] seeded ${co.root} from a wicked-garden git checkout (an explicit plugin root — WICKED_CREW_SKILLS_SOURCE or the configured source) at ${co.upstream}, plugin version 1.0.0, source kind checkout`,
        );
      } finally {
        removeScratch(co.base);
      }
      // The installed plugin (Claude plugin cache) — the one case the old hard-coded line was right about.
      const cache = scaffold({ source: () => ({ path: FIXTURE_PLUGIN, kind: 'claude-plugin-cache', plugin_version: '1.0.0' }) });
      try {
        const cacheLines: string[] = [];
        await new SkillsRuntime({ store: cache.store, log: (m) => cacheLines.push(m) }).apply();
        expect(cacheLines.find((l) => l.startsWith('[skills] seeded '))).toBe(
          `[skills] seeded ${cache.root} from the installed wicked-garden plugin (Claude plugin cache) at ${FIXTURE_PLUGIN}, plugin version 1.0.0, source kind claude-plugin-cache`,
        );
      } finally {
        removeScratch(cache.base);
      }
    } finally {
      if (saved === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
      else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = saved;
    }
  });

  it('the skills.source WARNING follows the CURRENT baseline live (design v3.6): present after an installer-copy seed (said once per boot); a refresh that finds the SAME bytes in the marketplace cache re-records the provenance (codex on #491) and the warning is gone — before any publish', async () => {
    const warning = `seeded from the installer copy at ${FIXTURE_PLUGIN}; register the plugin with Claude Code (marketplace) to receive marketplace updates`;
    let source: PluginSource = { path: FIXTURE_PLUGIN, kind: 'installer-copy', plugin_version: '1.0.0' };
    const sc = scaffold({ source: () => source });
    try {
      const lines: string[] = [];
      const seeding = new SkillsRuntime({ store: sc.store, log: (m) => lines.push(m) });
      const health = await seeding.apply();
      // The copy seeds and publishes like any source — the ladder's outcome is `published`, the warning rides beside it.
      expect(health.state).toBe('published');
      expect(health.findings).toEqual([{ kind: 'skills.source', severity: 'warning', message: warning }]);
      expect(seeding.health().findings).toEqual([{ kind: 'skills.source', severity: 'warning', message: warning }]);
      expect(lines.find((l) => l.startsWith('[skills] seeded '))).toBe(
        `[skills] seeded ${sc.root} from the installer-managed wicked-garden copy (plugins/wicked-garden — the LAST-resort source, design v3.6; not the marketplace cache) at ${FIXTURE_PLUGIN}, plugin version 1.0.0, source kind installer-copy`,
      );
      expect(lines.filter((l) => l === `[skills] skills.source: ${warning}`)).toHaveLength(1);
      // A second boot over the seeded root: the warning persists (the baseline is still the copy), said once again.
      lines.length = 0;
      expect((await seeding.apply()).findings.map((f) => f.kind)).toEqual(['skills.source']);
      expect(lines.filter((l) => l.startsWith('[skills] skills.source: '))).toHaveLength(1);
      // The operator registers the marketplace; the cache holds the SAME bytes (the scaffold's upstream
      // is a byte-identical copy of the fixture). A refresh has nothing to merge — but the provenance
      // moved, and the manifest records it: kind, path, revision; the baseline key (the content hash)
      // is unchanged, no publish happened, and the warning is gone with the provenance.
      const before = sc.store.revision();
      source = { path: sc.upstream, kind: 'claude-plugin-cache', plugin_version: '1.0.0' };
      const refreshed = sc.store.refreshBaseline(before);
      expect(refreshed.verdict).toBe('clear');
      expect(refreshed.baseline).toBe(refreshed.previous_baseline);
      expect(refreshed.revision).toBe(before + 1);
      const m = sc.store.manifest();
      expect(m.revision).toBe(before + 1);
      expect(m.baselines[m.baseline]?.source).toEqual({ kind: 'claude-plugin-cache', path: sc.upstream });
      expect(seeding.health()).toMatchObject({ state: 'published', current: { gen: 1 }, findings: [] });
      // The same source again: a true no-op — nothing to record, the revision stands.
      expect(sc.store.refreshBaseline(m.revision).revision).toBe(m.revision);
      expect(sc.store.revision()).toBe(m.revision);
    } finally {
      removeScratch(sc.base);
    }
  });

  it('diagnostics FAIL CLOSED (codex on #491): a manifest.json that cannot be read is reported as config-error with a skills.manifest finding naming the cause — never the stale published state; the engine input is untouched; readable again ⇒ published again', async () => {
    const sc = scaffold();
    try {
      const runtime = new SkillsRuntime({ store: sc.store, log: () => undefined });
      const published = await runtime.apply();
      expect(published.state).toBe('published');
      const manifestPath = join(sc.root, 'manifest.json');
      const pristine = readFileSync(manifestPath);
      writeFileSync(manifestPath, 'not a manifest');
      const corrupt = runtime.health();
      expect(corrupt).toMatchObject({ state: 'config-error', root: sc.root, current: null, engineInput: published.engineInput });
      expect(corrupt.findings).toHaveLength(1);
      expect(corrupt.findings[0]).toMatchObject({ kind: 'skills.manifest', severity: 'error' });
      expect(corrupt.findings[0]?.message).toMatch(/^manifest\.json cannot be read: .*not a skills manifest/);
      expect(corrupt.findings[0]?.message).toContain(`${SKILLS_SNAPSHOT_ENGINE_ENV} still exports what the last boot or publish set (${published.engineInput ?? 'unset'})`);
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(published.engineInput); // a READ never touches the engine input
      writeFileSync(manifestPath, pristine);
      expect(runtime.health()).toEqual(published);
      // Unreadable (permissions), not merely corrupt — POSIX only, and root reads through 0o000.
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        chmodSync(manifestPath, 0o000);
        try {
          const unreadable = runtime.health();
          expect(unreadable.state).toBe('config-error');
          expect(unreadable.findings.map((f) => f.kind)).toEqual(['skills.manifest']);
          expect(unreadable.findings[0]?.message).toMatch(/manifest\.json cannot be read: .*(EACCES|permission denied)/);
        } finally {
          chmodSync(manifestPath, 0o644);
        }
        expect(runtime.health()).toEqual(published);
      }
    } finally {
      removeScratch(sc.base);
    }
  });

  it('a settings PUT never touches the skills seam: a seeded store stays at its root and revision', async () => {
    s.store.seed();
    app = build(memoryAdapter());
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { graphNodeLimit: 120, skills_root: join(s.base, 'nope') } });
    expect(put.statusCode).toBe(200);
    expect(s.store.root).toBe(s.root);
    expect(s.store.revision()).toBe(1);
    expect(s.store.currentSnapshot()).toBeNull(); // no re-apply published
    expect(existsSync(join(s.base, 'nope'))).toBe(false);
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

  it('drops a hand-edited skills_root (ANY value — a pre-release settings.json) and the withdrawn skills_mirror knob; keeps the settings that exist', async () => {
    writeSettings({ graphNodeLimit: 150, skills_root: '/srv/skills', skills_mirror: 'on', worker_config_root: '/srv/worker' });
    const dropped = await read();
    expect(Object.hasOwn(dropped, 'skills_root')).toBe(false);
    expect(Object.hasOwn(dropped, 'skills_mirror')).toBe(false);
    expect(dropped).toMatchObject({ graphNodeLimit: 150, worker_config_root: '/srv/worker' });
    writeSettings({ graphNodeLimit: 150, skills_root: '' });
    expect(Object.hasOwn(await read(), 'skills_root')).toBe(false);
  });
});

describe('resolveSkillsRoot + the boot fence (root-fence.ts)', () => {
  let dir: string;
  let fakeHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-fence-'));
    fakeHome = join(dir, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    removeScratch(dir);
    restoreEnv();
  });

  it('the root is <state home>/skills — the retired WICKED_CREW_SKILLS_ROOT has no effect whatever it says', () => {
    const stateHome = join(dir, 'state-home');
    setCrewStateHome(stateHome);
    expect(resolveSkillsRoot()).toBe(join(stateHome, SKILLS_DIRNAME));
    process.env[RETIRED_ROOT_ENV] = join(fakeHome, '.codex', 'skills');
    expect(resolveSkillsRoot()).toBe(join(stateHome, SKILLS_DIRNAME));
    process.env[RETIRED_ROOT_ENV] = join(dir, 'anywhere-else');
    expect(resolveSkillsRoot()).toBe(join(stateHome, SKILLS_DIRNAME));
  });

  it('userCliDirs names codex, pi, copilot, opencode, the literal ~/.claude AND the daemon\'s CLAUDE_CONFIG_DIR', () => {
    const dirs = userCliDirs(fakeHome, { CLAUDE_CONFIG_DIR: join(dir, 'claude-cfg') });
    expect(dirs).toEqual([
      join(fakeHome, '.codex'),
      join(fakeHome, '.pi'),
      join(fakeHome, '.copilot'),
      join(fakeHome, '.config', 'opencode'),
      join(fakeHome, '.claude'),
      join(dir, 'claude-cfg'),
    ]);
    // Without CLAUDE_CONFIG_DIR the literal is the config dir too — listed once.
    expect(userCliDirs(fakeHome, {})).toHaveLength(5);
  });

  it('accepts <state home>/skills (existing or not) and answers its canonical path', () => {
    const stateHome = join(dir, 'state-home');
    const root = join(stateHome, 'skills');
    expect(assertSkillsRootFenced(root, { stateHome, home: fakeHome, env: {} })).toEqual({ root, canonical: canonicalPath(root) });
    mkdirSync(root, { recursive: true });
    expect(assertSkillsRootFenced(root, { stateHome, home: fakeHome, env: {} }).canonical).toBe(realpathSync(root));
  });

  it('refuses a root outside the state home, and the state home itself', () => {
    const stateHome = join(dir, 'state-home');
    expect(() => assertSkillsRootFenced(join(dir, 'elsewhere', 'skills'), { stateHome, home: fakeHome, env: {} })).toThrow(SkillsRootUnfencedError);
    expect(() => assertSkillsRootFenced(join(dir, 'elsewhere', 'skills'), { stateHome, home: fakeHome, env: {} })).toThrow(/not inside the daemon state home/);
    expect(() => assertSkillsRootFenced(stateHome, { stateHome, home: fakeHome, env: {} })).toThrow(/not inside the daemon state home/);
  });

  it('refuses a state home INSIDE every known user CLI directory — codex, pi, copilot, opencode, ~/.claude, CLAUDE_CONFIG_DIR — naming it', () => {
    const cases: Array<[string[], string]> = [
      [['.codex', 'wicked'], '.codex'],
      [['.pi', 'agent', 'wicked'], '.pi'],
      [['.copilot', 'wicked'], '.copilot'],
      [['.config', 'opencode', 'wicked'], join('.config', 'opencode')],
      [['.claude', 'wicked'], '.claude'],
    ];
    for (const [rel, named] of cases) {
      const stateHome = join(fakeHome, ...rel);
      const root = join(stateHome, 'skills');
      expect(() => assertSkillsRootFenced(root, { stateHome, home: fakeHome, env: {} }), rel.join('/')).toThrow(SkillsRootUnfencedError);
      expect(() => assertSkillsRootFenced(root, { stateHome, home: fakeHome, env: {} }), rel.join('/')).toThrow(`lies inside the user CLI directory ${canonicalPath(join(fakeHome, named))}`);
    }
    const cfg = join(dir, 'claude-config');
    const stateHome = join(cfg, 'wicked');
    expect(() => assertSkillsRootFenced(join(stateHome, 'skills'), { stateHome, home: fakeHome, env: { CLAUDE_CONFIG_DIR: cfg } })).toThrow(/lies inside the user CLI directory/);
    // The same state home is fine when CLAUDE_CONFIG_DIR does not name it.
    expect(() => assertSkillsRootFenced(join(stateHome, 'skills'), { stateHome, home: fakeHome, env: {} })).not.toThrow();
  });

  it('judges the CANONICAL path: a symlinked skills root, or a state-home ancestor linked into ~/.codex, is refused', () => {
    const stateHome = join(dir, 'state-home');
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(join(fakeHome, '.codex', 'skills'), { recursive: true });
    // The root entry itself a link (into the user's codex skills).
    symlinkSync(join(fakeHome, '.codex', 'skills'), join(stateHome, 'skills'));
    expect(() => assertSkillsRootFenced(join(stateHome, 'skills'), { stateHome, home: fakeHome, env: {} })).toThrow(/a symlink stands in for the skills root/);
    rmSync(join(stateHome, 'skills'));
    // A link to a sibling INSIDE the state home is refused too — a link never stands in for the root.
    mkdirSync(join(stateHome, 'sibling'));
    symlinkSync(join(stateHome, 'sibling'), join(stateHome, 'skills'));
    expect(() => assertSkillsRootFenced(join(stateHome, 'skills'), { stateHome, home: fakeHome, env: {} })).toThrow(/a symlink stands in for the skills root/);
    rmSync(join(stateHome, 'skills'));
    // An ANCESTOR of the state home is a link into ~/.codex: lexically fine, canonically inside.
    mkdirSync(join(fakeHome, '.codex', 'hidden-state'), { recursive: true });
    symlinkSync(join(fakeHome, '.codex', 'hidden-state'), join(dir, 'via'));
    const linkedStateHome = join(dir, 'via', 'state');
    expect(() => assertSkillsRootFenced(join(linkedStateHome, 'skills'), { stateHome: linkedStateHome, home: fakeHome, env: {} })).toThrow(
      `lies inside the user CLI directory ${realpathSync(join(fakeHome, '.codex'))}`,
    );
    // …and a root that canonically leaves a canonical state home (the root's parent linked away).
    mkdirSync(join(dir, 'outside-root'));
    symlinkSync(join(dir, 'outside-root'), join(stateHome, 'skills'));
    expect(() => assertSkillsRootFenced(join(stateHome, 'skills'), { stateHome, home: fakeHome, env: {} })).toThrow(SkillsRootUnfencedError);
  });
});

describe('daemon boot (createServer) — the root is <state home>/skills; the fence is a START error; the degradation ladder', () => {
  let dir: string;
  let adapter: CoreAdapter;
  const savedHome = process.env['HOME'];
  const savedProfile = process.env['USERPROFILE'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-boot-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    // The fixture catalog does not carry the daemon's built-in skill_refs (domain*, repo-learn), and
    // a registered ref the catalog lacks is BLOCKING at publish — so the boot suite registers no
    // workflows; the blocked-first-publish rung has its own test below (a missing plugin catalog).
    adapter.listWorkflows = () => [];
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    // What the CLI bootstrap does for `--db <dir>/core.db`: the state home is the db's parent.
    setCrewStateHome(dir);
  });

  afterEach(() => {
    adapter.close();
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedProfile;
    removeScratch(dir);
    restoreEnv();
  });

  const options = (skills: { source?: () => ReturnType<typeof pluginSourceAt>; disabled?: boolean }) => ({
    projectEvents: { disabled: true },
    auditPath: join(dir, 'audit.log'),
    studioRoot: join(dir, 'no-studio'),
    // HERMETIC: the provisioner is injected — a boot test never runs the host's `uv`.
    skills: { ...skills, provisionVenv: noVenv },
  });

  const diagnostics = async (app: FastifyInstance): Promise<DiagnosticsResponse['skills']> =>
    ((await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse).skills;

  it('seeds <state home>/skills from the plugin source, publishes (copilot view included), exports WICKED_SKILLS_SNAPSHOT — no outside-the-state-home warning exists any more', async () => {
    const root = join(dir, 'skills');
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const app = await createServer(adapter, options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }));
    try {
      expect(existsSync(join(root, 'manifest.json'))).toBe(true);
      // ONE engine input, the absolute REAL path of the generation (v3.1 §2); WICKED_SKILLS_CURRENT is never set.
      const real = realpathSync(join(root, 'snapshots', '000001'));
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real);
      expect(process.env['WICKED_SKILLS_CURRENT']).toBeUndefined();
      // The copilot view rides the snapshot (v3.2 §4) — inside the root, never in a home directory.
      expect(existsSync(join(real, ...COPILOT_VIEW_SKILLS_REL.split('/'), 'wicked-garden-gamma', 'SKILL.md'))).toBe(true);
      const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as SkillsManifestResponse).current).toEqual({ gen: 1, path: real });
      expect((res.json() as SkillsManifestResponse).root).toBe(root);
      // Exactly ONE engine input (v3.4 §2): nothing is exported beside the snapshot — the retired
      // WICKED_CREW_STATE_HOME is untouched — and the snapshot IS <state home>/skills/snapshots/<gen>
      // by construction, the layout core derives the state home from.
      expect(process.env['WICKED_CREW_STATE_HOME']).toBe(stateHomeEnvBefore);
      expect(real.startsWith(join(canonicalCrewStateHome(), SKILLS_DIRNAME, 'snapshots') + '/')).toBe(true);
      const skills = await diagnostics(app);
      expect(skills).toEqual({ state: 'published', root, current: { gen: 1, path: real }, engineInput: real, stateHome: canonicalCrewStateHome(), findings: [] });
      // The root lives under THIS state home — never under the operator's real one.
      expect(readdirSync(dir)).toContain('skills');
      expect(real.startsWith(join(homedir(), '.wicked-crew'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('REFUSES TO START when the state home lies inside a user CLI directory (SkillsRootUnfencedError) — nothing is created there', async () => {
    const fakeHome = join(dir, 'home');
    mkdirSync(join(fakeHome, '.codex', 'skills'), { recursive: true });
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;
    expect(homedir()).toBe(fakeHome);
    const stateHome = join(fakeHome, '.codex', 'wicked-state');
    setCrewStateHome(stateHome);
    adapter.close();
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true }); // the db stays in the temp dir — only the state home is misplaced
    adapter.listWorkflows = () => [];
    adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    await expect(createServer(adapter, { ...options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }), auditPath: join(dir, 'audit.log') })).rejects.toBeInstanceOf(SkillsRootUnfencedError);
    await expect(createServer(adapter, { ...options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }), auditPath: join(dir, 'audit.log') })).rejects.toThrow(/lies inside the user CLI directory/);
    expect(existsSync(stateHome)).toBe(false); // the skills seam never ran; nothing landed under ~/.codex
    expect(readdirSync(join(fakeHome, '.codex'))).toEqual(['skills']);
    expect(readdirSync(join(fakeHome, '.codex', 'skills'))).toEqual([]);
    // With the seam disabled the daemon boots (routes 503) — the fence is the skills seam's, not the daemon's.
    const app = await createServer(adapter, options({ disabled: true }));
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('REFUSES TO START when <state home>/skills is a symlink (into ~/.claude, say) — the link target is untouched', async () => {
    const fakeHome = join(dir, 'home');
    const target = join(fakeHome, '.claude', 'plugins', 'hijack');
    mkdirSync(target, { recursive: true });
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;
    symlinkSync(target, join(dir, 'skills'));
    await expect(createServer(adapter, options({ source: () => pluginSourceAt(FIXTURE_PLUGIN) }))).rejects.toThrow(/a symlink stands in for the skills root/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('seeded from the installer-managed copy (design v3.6): published and exported like any source, plus the persistent skills.source WARNING in GET /diagnostics naming the copy; the manifest carries kind installer-copy on the wire', async () => {
    const root = join(dir, 'skills');
    delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    const app = await createServer(adapter, options({ source: () => ({ path: FIXTURE_PLUGIN, kind: 'installer-copy', plugin_version: '1.0.0' }) }));
    try {
      const real = realpathSync(join(root, 'snapshots', '000001'));
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(real); // no degradation: the engine is handed a verified snapshot
      const skills = await diagnostics(app);
      expect(skills).toEqual({
        state: 'published',
        root,
        current: { gen: 1, path: real },
        engineInput: real,
        stateHome: canonicalCrewStateHome(),
        findings: [
          {
            kind: 'skills.source',
            severity: 'warning',
            message: `seeded from the installer copy at ${FIXTURE_PLUGIN}; register the plugin with Claude Code (marketplace) to receive marketplace updates`,
          },
        ],
      });
      const res = await app.inject({ method: 'GET', url: '/api/v1/skills' });
      expect(res.statusCode).toBe(200);
      const { manifest } = res.json() as SkillsManifestResponse;
      expect(manifest.baselines[manifest.baseline]?.source).toEqual({ kind: 'installer-copy', path: FIXTURE_PLUGIN });
    } finally {
      await app.close();
    }
  });

  it('ABSENT configuration (no plugin source) is the fallback: the boot-time env is restored and skills.fallback is reported', async () => {
    process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = '/stale';
    const app = await createServer(adapter, options({ source: () => null }));
    try {
      expect(process.env[SKILLS_SNAPSHOT_ENGINE_ENV]).toBe(BOOT_SKILLS_SNAPSHOT);
      expect((await app.inject({ method: 'GET', url: '/api/v1/skills' })).statusCode).toBe(503);
      const skills = await diagnostics(app);
      expect(skills.state).toBe('fallback');
      expect(skills.root).toBe(join(dir, 'skills'));
      expect(skills.engineInput).toBe(BOOT_SKILLS_SNAPSHOT ?? null); // diagnostics say what the env actually holds
      expect(skills.stateHome).toBe(canonicalCrewStateHome()); // REPORTED for humans whatever the skills outcome — never an engine input (v3.4 §2)
      expect(process.env['WICKED_CREW_STATE_HOME']).toBe(stateHomeEnvBefore);
      expect(skills.findings.map((f) => f.kind)).toEqual(['skills.fallback']);
      expect(skills.findings[0]?.message).toContain('install wicked-garden first');
      expect(existsSync(join(dir, 'skills'))).toBe(false); // a seed with no source creates nothing
    } finally {
      await app.close();
    }
  });

  it('a BLOCKED first publish is never a fallback: the engine input points at a refusal path and skills.blocked is reported', async () => {
    const root = join(dir, 'skills');
    const plugin = join(dir, 'defective-plugin');
    cpSync(FIXTURE_PLUGIN, plugin, { recursive: true });
    rmSync(join(plugin, '.claude-plugin', 'archetypes.json')); // a required catalog is missing → publish blocks
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
    const root = join(dir, 'skills');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), 'not a manifest');
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
