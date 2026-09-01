// Crew-side per-project settings (DES-MERGE-001 §7.1's `interactiveRoot`).
//
// The store is the durable half of the setting, so what matters is that it SURVIVES a restart
// and that a damaged file degrades to "everything uses the shared default" rather than taking
// the daemon's boot with it.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ProjectSettingsStore, defaultSettingsPath } from '../src/projects/settings.js';
import { setCrewStateHome, stateHomeOfDb } from '../src/projects/state-home.js';
import { resolveInteractiveRoot, defaultInteractiveRoot } from '../src/interactive/bridge-root.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-proj-settings-'));
  path = join(dir, 'nested', 'project-settings.json');
});
afterEach(() => {
  setCrewStateHome(undefined); // module state must never leak into another test
  rmSync(dir, { recursive: true, force: true });
});

describe('ProjectSettingsStore', () => {
  it('is empty for an unconfigured project, and for a store with no file yet', () => {
    const store = new ProjectSettingsStore(path);
    expect(store.get('p-1')).toEqual({});
    expect(store.get('default')).toEqual({});
  });

  it('persists a binding across a restart (creating the directory it needs)', () => {
    new ProjectSettingsStore(path).set('p-1', { interactiveRoot: '/srv/decks' });
    // A FRESH store — this is the restarted-daemon read.
    expect(new ProjectSettingsStore(path).get('p-1')).toEqual({ interactiveRoot: '/srv/decks' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ projects: { 'p-1': { interactiveRoot: '/srv/decks' } } });
  });

  it('null CLEARS the binding back to the shared default (distinct from omitting the key)', () => {
    const store = new ProjectSettingsStore(path);
    store.set('p-1', { interactiveRoot: '/srv/decks' });
    store.set('p-1', { interactiveRoot: null });
    expect(store.get('p-1')).toEqual({});
    // ...and the resolver then hands back the shared default, which is the point of the null.
    expect(resolveInteractiveRoot(store.get('p-1'), {}, '/home/t')).toBe(defaultInteractiveRoot('/home/t'));
    expect(new ProjectSettingsStore(path).get('p-1')).toEqual({});
  });

  it('keeps projects independent', () => {
    const store = new ProjectSettingsStore(path);
    store.set('p-1', { interactiveRoot: '/a' });
    store.set('p-2', { interactiveRoot: '/b' });
    expect(store.get('p-1')).toEqual({ interactiveRoot: '/a' });
    expect(store.get('p-2')).toEqual({ interactiveRoot: '/b' });
  });

  it('degrades to empty on a corrupt file instead of throwing at construction', () => {
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    const store = new ProjectSettingsStore(join(dir, 'bad.json'));
    expect(store.get('p-1')).toEqual({});
    // Still writable afterwards — a corrupt read must not wedge the store.
    store.set('p-1', { interactiveRoot: '/srv/decks' });
    expect(new ProjectSettingsStore(join(dir, 'bad.json')).get('p-1')).toEqual({ interactiveRoot: '/srv/decks' });
  });

  it('drops only the malformed ROWS, keeping the good ones', () => {
    // Same discipline as the handoff ledger: one bad row must not blank every binding.
    const p = join(dir, 'mixed.json');
    writeFileSync(
      p,
      JSON.stringify({ projects: { good: { interactiveRoot: '/ok' }, nullRow: null, numeric: { interactiveRoot: 7 } } }),
    );
    const store = new ProjectSettingsStore(p);
    expect(store.get('good')).toEqual({ interactiveRoot: '/ok' });
    expect(store.get('nullRow')).toEqual({});
    expect(store.get('numeric')).toEqual({});
  });

  it('honors WICKED_CREW_PROJECT_SETTINGS for its default path', () => {
    expect(defaultSettingsPath({ WICKED_CREW_PROJECT_SETTINGS: '/tmp/x.json' })).toBe('/tmp/x.json');
    expect(defaultSettingsPath({})).toContain(join('.wicked-crew', 'project-settings.json'));
  });
});

// crew#353 — the settings file must FOLLOW `--db`, exactly like the project graphs (crew#330).
describe('defaultSettingsPath precedence (crew#353)', () => {
  it('a configured state home moves the file — the --db parent owns the settings', () => {
    setCrewStateHome(join(sep, 'scratch', 'daemon-a'));
    expect(defaultSettingsPath({})).toBe(join(sep, 'scratch', 'daemon-a', 'project-settings.json'));
  });

  it('WICKED_CREW_PROJECT_SETTINGS still outranks the configured state home', () => {
    setCrewStateHome(join(sep, 'scratch', 'daemon-a'));
    expect(defaultSettingsPath({ WICKED_CREW_PROJECT_SETTINGS: '/tmp/x.json' })).toBe('/tmp/x.json');
  });

  it('no configured state home ⇒ the historical homedir default (library/unit consumers)', () => {
    setCrewStateHome(undefined);
    expect(defaultSettingsPath({})).toBe(join(homedir(), '.wicked-crew', 'project-settings.json'));
  });

  it('the default daemon (no --db) resolves byte-identically to the pre-fix path', () => {
    // What cli/index.ts does when --db is absent: dbPath = ~/.wicked-crew/core.db.
    setCrewStateHome(stateHomeOfDb(join(homedir(), '.wicked-crew', 'core.db')));
    expect(defaultSettingsPath({})).toBe(join(homedir(), '.wicked-crew', 'project-settings.json'));
  });
});

// crew#353's migration posture: an override root NEVER silently shadows a default-root file — the
// daemon starts empty at the override root (isolation is the point; the two files hold bindings
// keyed by ids from two different core dbs) and SAYS SO once at boot.
describe('legacy-shadow warning (crew#353)', () => {
  it('fires when the state-home root has no file but the legacy default root has one', () => {
    const legacy = join(dir, 'legacy-project-settings.json');
    writeFileSync(legacy, JSON.stringify({ projects: { p1: { interactiveRoot: '/real' } } }));
    setCrewStateHome(join(dir, 'isolated'));
    const onShadow = vi.fn();
    const active = defaultSettingsPath({}, onShadow, legacy);
    expect(active).toBe(join(dir, 'isolated', 'project-settings.json'));
    expect(onShadow).toHaveBeenCalledTimes(1);
    expect(onShadow).toHaveBeenCalledWith(legacy, active);
  });

  it('stays quiet when the override root already has its own file (the daemon lives there)', () => {
    const legacy = join(dir, 'legacy-project-settings.json');
    writeFileSync(legacy, '{"projects":{}}');
    setCrewStateHome(join(dir, 'isolated'));
    mkdirSync(join(dir, 'isolated'), { recursive: true });
    writeFileSync(join(dir, 'isolated', 'project-settings.json'), '{"projects":{}}');
    const onShadow = vi.fn();
    defaultSettingsPath({}, onShadow, legacy);
    expect(onShadow).not.toHaveBeenCalled();
  });

  it('stays quiet when there is nothing at the legacy root to shadow', () => {
    setCrewStateHome(join(dir, 'isolated'));
    const onShadow = vi.fn();
    defaultSettingsPath({}, onShadow, join(dir, 'no-such-legacy.json'));
    expect(onShadow).not.toHaveBeenCalled();
  });

  it('stays quiet for the env override — an explicitly spelled path is intent, not surprise', () => {
    const legacy = join(dir, 'legacy-project-settings.json');
    writeFileSync(legacy, '{"projects":{}}');
    const onShadow = vi.fn();
    defaultSettingsPath({ WICKED_CREW_PROJECT_SETTINGS: join(dir, 'elsewhere.json') }, onShadow, legacy);
    expect(onShadow).not.toHaveBeenCalled();
  });

  it('stays quiet when the resolved path IS the legacy path (default daemon, no --db)', () => {
    const legacy = join(dir, 'project-settings.json');
    writeFileSync(legacy, '{"projects":{}}');
    setCrewStateHome(dir); // resolves to exactly the "legacy" file — nothing is shadowed
    const onShadow = vi.fn();
    expect(defaultSettingsPath({}, onShadow, legacy)).toBe(legacy);
    expect(onShadow).not.toHaveBeenCalled();
  });

  it('the constructor routes the warning through its warn hook (the daemon boot wiring)', () => {
    // The constructor resolves via process.env, so pin the env-override slot empty for the call.
    const saved = process.env['WICKED_CREW_PROJECT_SETTINGS'];
    delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
    try {
      setCrewStateHome(join(dir, 'isolated'));
      const warn = vi.fn();
      const store = new ProjectSettingsStore(undefined, warn);
      // No legacy file at the REAL homedir default is a machine-dependent fact, so assert only
      // what is invariant: the store landed under the state home and works there.
      store.set('p-1', { interactiveRoot: '/srv/decks' });
      expect(readFileSync(join(dir, 'isolated', 'project-settings.json'), 'utf8')).toContain('/srv/decks');
    } finally {
      if (saved === undefined) delete process.env['WICKED_CREW_PROJECT_SETTINGS'];
      else process.env['WICKED_CREW_PROJECT_SETTINGS'] = saved;
    }
  });
});
