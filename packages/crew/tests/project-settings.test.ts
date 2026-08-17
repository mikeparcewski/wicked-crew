// Crew-side per-project settings (DES-MERGE-001 §7.1's `interactiveRoot`).
//
// The store is the durable half of the setting, so what matters is that it SURVIVES a restart
// and that a damaged file degrades to "everything uses the shared default" rather than taking
// the daemon's boot with it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSettingsStore, defaultSettingsPath } from '../src/projects/settings.js';
import { resolveInteractiveRoot, defaultInteractiveRoot } from '../src/interactive/bridge-root.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-proj-settings-'));
  path = join(dir, 'nested', 'project-settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
