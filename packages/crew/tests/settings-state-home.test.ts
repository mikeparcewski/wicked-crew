// crew#756: the daemon's system settings follow its STATE HOME. A daemon on a non-default `--db`
// (a proof lane, a throwaway install) reads and writes `<state home>/daemon-settings.json` — a
// `daemon-*` name the state-home registry already classifies (operator-owned, no worker read) — so
// changing its theme never touches the operator's real `~/.config/wicked-core/settings.json`. The
// default state home keeps that historical location, and `WICKED_CREW_SYSTEM_SETTINGS` still wins.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import { crewStateHome, defaultStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { isRegisteredStateHomeEntry } from '../src/projects/state-home-registry.js';
import { removeScratch } from './setup/scratch.js';

const armedHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
const realHome = process.env['HOME'];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-state-home-'));
  delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  // Never read (or seed from) the operator's real shared settings file (Copilot on #760).
  process.env['HOME'] = join(dir, 'home');
});

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  setCrewStateHome(armedHome);
  if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
  removeScratch(dir);
});

describe('system settings follow the state home (crew#756)', () => {
  it('a non-default state home keeps its settings at <state home>/daemon-settings.json, a registered entry', () => {
    setCrewStateHome(join(dir, 'proof-home'));
    expect(settingsFilePath()).toBe(join(dir, 'proof-home', 'daemon-settings.json'));
    expect(isRegisteredStateHomeEntry('daemon-settings.json')).toBe(true);
  });

  it('the default state home keeps the historical ~/.config/wicked-core/settings.json', () => {
    setCrewStateHome(defaultStateHome(homedir()));
    expect(settingsFilePath()).toBe(join(homedir(), '.config/wicked-core', 'settings.json'));
    setCrewStateHome(undefined);
    expect(settingsFilePath()).toBe(join(homedir(), '.config/wicked-core', 'settings.json'));
  });

  it('the default state home reached through a link is still the default (codex)', () => {
    const prevHome = process.env['HOME'];
    process.env['HOME'] = join(dir, 'home');
    try {
      mkdirSync(join(dir, 'home', '.wicked-crew'), { recursive: true });
      symlinkSync(join(dir, 'home', '.wicked-crew'), join(dir, 'crew-link'));
      setCrewStateHome(join(dir, 'crew-link'));
      expect(settingsFilePath()).toBe(join(dir, 'home', '.config/wicked-core', 'settings.json'));
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('WICKED_CREW_SYSTEM_SETTINGS still wins over both', () => {
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(dir, 'explicit.json');
    setCrewStateHome(join(dir, 'proof-home'));
    expect(settingsFilePath()).toBe(join(dir, 'explicit.json'));
  });

  it('migrates once: an upgraded non-default daemon starts from a COPY of the shared file, and its writes stay home', async () => {
    const prevHome = process.env['HOME'];
    process.env['HOME'] = join(dir, 'home');
    const legacy = join(dir, 'home', '.config/wicked-core', 'settings.json');
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ deliverDefault: 'none', graphNodeLimit: 77 }));
    const a = new CoreAdapter({ dbPath: join(dir, 'rig', 'core.db'), stub: true });
    try {
      setCrewStateHome(join(dir, 'rig'));
      expect(settingsFilePath()).toBe(join(dir, 'rig', 'daemon-settings.json'));
      expect((await a.getSettings()).graphNodeLimit).toBe(77);
      expect(existsSync(join(dir, 'rig', 'daemon-settings.json'))).toBe(true);
      await a.updateSettings({ graphNodeLimit: 5 });
      expect(JSON.parse(readFileSync(legacy, 'utf8')).graphNodeLimit).toBe(77);
      // Once only: a later change to the shared file is not re-imported.
      writeFileSync(legacy, JSON.stringify({ graphNodeLimit: 99 }));
      expect((await a.getSettings()).graphNodeLimit).toBe(5);
    } finally {
      a.close();
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('no shared file at the first read: the home starts its own empty file, and a later shared file is never imported (Copilot)', async () => {
    const a = new CoreAdapter({ dbPath: join(dir, 'iso', 'core.db'), stub: true });
    try {
      setCrewStateHome(join(dir, 'iso'));
      await a.getSettings();
      expect(JSON.parse(readFileSync(join(dir, 'iso', 'daemon-settings.json'), 'utf8'))).toEqual({});
      const shared = join(dir, 'home', '.config/wicked-core', 'settings.json');
      mkdirSync(join(shared, '..'), { recursive: true });
      writeFileSync(shared, JSON.stringify({ graphNodeLimit: 42 }));
      expect((await a.getSettings()).graphNodeLimit).not.toBe(42);
    } finally {
      a.close();
    }
  });

  it('a shared file that is not valid JSON is never copied as the seed; the home starts empty (Copilot)', async () => {
    const shared = join(dir, 'home', '.config/wicked-core', 'settings.json');
    mkdirSync(join(shared, '..'), { recursive: true });
    writeFileSync(shared, '{"graphNodeLimit": 4');
    const a = new CoreAdapter({ dbPath: join(dir, 'iso2', 'core.db'), stub: true });
    try {
      setCrewStateHome(join(dir, 'iso2'));
      await a.getSettings();
      expect(JSON.parse(readFileSync(join(dir, 'iso2', 'daemon-settings.json'), 'utf8'))).toEqual({});
    } finally {
      a.close();
    }
  });

  it('a settings write publishes whole: no partial file is ever visible at the settings path', async () => {
    const a = new CoreAdapter({ dbPath: join(dir, 'w', 'core.db'), stub: true });
    try {
      setCrewStateHome(join(dir, 'w'));
      await Promise.all(Array.from({ length: 8 }, (_, i) => a.updateSettings({ graphNodeLimit: 10 + i })));
      expect(() => JSON.parse(readFileSync(join(dir, 'w', 'daemon-settings.json'), 'utf8'))).not.toThrow();
      expect(readdirSync(join(dir, 'w')).filter((n) => n.includes('.tmp'))).toEqual([]);
    } finally {
      a.close();
    }
  });

  it('a settings write keeps the file\'s mode, and writes THROUGH a settings-file link (Copilot r2 on #760)', async () => {
    const a = new CoreAdapter({ dbPath: join(dir, 'm', 'core.db'), stub: true });
    try {
      setCrewStateHome(join(dir, 'm'));
      const path = join(dir, 'm', 'daemon-settings.json');
      // A first write is created owner-only: its text is never readable by others, even as a temp file (codex).
      await a.updateSettings({ graphNodeLimit: 10 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, '{}');
      chmodSync(path, 0o640);
      await a.updateSettings({ graphNodeLimit: 11 });
      expect(statSync(path).mode & 0o777).toBe(0o640);
      // A settings file that is a link (a dotfiles checkout, say) stays a link; its target is updated.
      const target = join(dir, 'dotfiles-settings.json');
      writeFileSync(target, '{}');
      rmSync(path);
      symlinkSync(target, path);
      await a.updateSettings({ graphNodeLimit: 12 });
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect((JSON.parse(readFileSync(target, 'utf8')) as { graphNodeLimit: number }).graphNodeLimit).toBe(12);
      expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
    } finally {
      a.close();
    }
  });

  it('two daemons on two state homes: one changing its theme leaves the other untouched', async () => {
    const a = new CoreAdapter({ dbPath: join(dir, 'a', 'core.db'), stub: true });
    const b = new CoreAdapter({ dbPath: join(dir, 'b', 'core.db'), stub: true });
    // Never write unless the path is inside this test's scratch dir: an engine that ignores the state
    // home would otherwise rewrite the operator's real settings file (it did, once, in this test's red run).
    const guarded = (): void => {
      if (!settingsFilePath().startsWith(dir)) throw new Error(`settings would be written outside the scratch dir: ${settingsFilePath()}`);
    };
    try {
      setCrewStateHome(join(dir, 'a'));
      guarded();
      await a.updateSettings({ studio: { theme: 'wicked-dark' } } as never);
      setCrewStateHome(join(dir, 'b'));
      expect(existsSync(join(dir, 'b', 'daemon-settings.json'))).toBe(false);
      guarded();
      await b.updateSettings({ studio: { theme: 'wicked-light' } } as never);
      expect(JSON.parse(readFileSync(join(dir, 'a', 'daemon-settings.json'), 'utf8')).studio.theme).toBe('wicked-dark');
      expect(JSON.parse(readFileSync(join(dir, 'b', 'daemon-settings.json'), 'utf8')).studio.theme).toBe('wicked-light');
    } finally {
      a.close();
      b.close();
    }
  });
});
