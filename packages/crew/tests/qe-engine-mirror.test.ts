// The engine's mirror of the daemon's QE acceptance setting (`CoreAdapter.syncEngineQeSetting` →
// `Core.setQeAcceptanceOff`), which the engine applies to the launches it makes on its own (campaign
// nodes, bus requests). The mirror is the settings FILE as it stands when a read or write finishes —
// read synchronously, so an async read that a later edit overtook never sets it — it is cleared when
// a settings read fails (which `/health` and `launchRun` read as `'required'`), and the engine gets
// the boot value before `spawn` arms its bus bridge. Skips on an addon without the mirror.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, settingsFilePath } from '../src/core/adapter.js';
import { QE_OFF_REASON } from '../src/core/qe-acceptance-setting.js';
import { removeScratch } from './setup/scratch.js';

// The production read's own catch path: one async `readFile` of the settings file can be made to
// fail while the file itself stays readable (a transient fault the mirror's sync read would not see).
const failNextSettingsRead = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      // The hermetic settings file (`WICKED_CREW_SYSTEM_SETTINGS`, tests/setup/hermetic-home.ts).
      if (failNextSettingsRead.on && String(args[0]) === process.env['WICKED_CREW_SYSTEM_SETTINGS']) {
        failNextSettingsRead.on = false;
        throw Object.assign(new Error('EIO: transient read failure'), { code: 'EIO' });
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as { Core: { prototype: Record<string, unknown> } };
const supported = typeof Core.prototype['setQeAcceptanceOff'] === 'function';

let dir: string;
let original: string | null;
const adapters: CoreAdapter[] = [];

function writeQe(mode: 'off' | 'required'): void {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(settingsFilePath(), 'utf8')) as Record<string, unknown>;
  } catch {
    /* a fresh hermetic file */
  }
  writeFileSync(settingsFilePath(), JSON.stringify({ ...current, qeAcceptance: mode }, null, 2));
}

function spawn(name: string): CoreAdapter {
  const a = new CoreAdapter({ dbPath: join(dir, `${name}.db`), stub: true });
  adapters.push(a);
  return a;
}

const mirror = (a: CoreAdapter): string | null => (a as unknown as { core: { qeAcceptanceOff(): string | null } }).core.qeAcceptanceOff();

/** Replace the adapter's async settings read for one call (the file stays the source of truth). */
function nextRead(a: CoreAdapter, read: () => Promise<unknown>): void {
  const target = a as unknown as { readSettings: () => Promise<unknown> };
  const real = target.readSettings.bind(a);
  target.readSettings = async () => {
    target.readSettings = real;
    return read();
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qe-engine-mirror-'));
  try {
    original = readFileSync(settingsFilePath(), 'utf8');
  } catch {
    original = null;
  }
});

afterEach(() => {
  for (const a of adapters.splice(0)) a.close();
  if (original === null) writeFileSync(settingsFilePath(), '{}');
  else writeFileSync(settingsFilePath(), original);
  removeScratch(dir);
});

describe.skipIf(!supported)("the engine's mirror of qeAcceptance", () => {
  it('a daemon that boots with the setting off starts its engine with it, and the variable is scoped to the spawn', () => {
    writeQe('off');
    const a = spawn('boot-off');
    expect(mirror(a)).toBe(QE_OFF_REASON);
    expect(process.env['WICKED_QE_ACCEPTANCE_OFF']).toBeUndefined();
    writeQe('required');
    expect(mirror(spawn('boot-on'))).toBeNull();
  });

  it('follows reads and writes: PUT-style updates and a hand edit seen on the next read', async () => {
    writeQe('required');
    const a = spawn('follow');
    await a.updateSettings({ qeAcceptance: 'off' });
    expect(mirror(a)).toBe(QE_OFF_REASON);
    writeQe('required');
    await a.getSettings();
    expect(mirror(a)).toBeNull();
  });

  it('a read that an edit overtook never sets it: the file as it stands when the read finishes wins', async () => {
    writeQe('required');
    const a = spawn('stale');
    let release!: (v: unknown) => void;
    // This read "saw" the old file ('required') and resolves only after the file says 'off'.
    nextRead(a, () => new Promise((r) => { release = r; }));
    const stale = a.getSettings();
    writeQe('off');
    await a.getSettings(); // a newer read sees 'off'
    expect(mirror(a)).toBe(QE_OFF_REASON);
    release({ settings: { qeAcceptance: 'required' }, ok: true });
    await stale;
    expect(mirror(a)).toBe(QE_OFF_REASON);
  });

  it('a failed settings read clears it (fail closed, as /health and launchRun read a failed read)', async () => {
    writeQe('off');
    const a = spawn('fail');
    expect(mirror(a)).toBe(QE_OFF_REASON);
    nextRead(a, () => Promise.reject(new Error('EACCES: settings unreadable')));
    await expect(a.getSettings()).rejects.toThrow(/EACCES/);
    expect(mirror(a)).toBeNull();
    await a.getSettings();
    expect(mirror(a)).toBe(QE_OFF_REASON);
  });

  it("a read that FELL BACK to the defaults (the production read's own catch) clears it too, though the file is readable again", async () => {
    writeQe('off');
    const a = spawn('fallback');
    expect(mirror(a)).toBe(QE_OFF_REASON);
    failNextSettingsRead.on = true;
    const served = await a.getSettings();
    expect(failNextSettingsRead.on).toBe(false); // the fault was hit
    expect(served.qeAcceptance).toBe('required'); // what /health and launchRun read
    expect(mirror(a)).toBeNull();
    await a.getSettings();
    expect(mirror(a)).toBe(QE_OFF_REASON);
  });

  it('overlapping writes leave it equal to the file the last write left', async () => {
    writeQe('required');
    const a = spawn('overlap');
    await Promise.all([a.updateSettings({ qeAcceptance: 'off' }), a.updateSettings({ qeAcceptance: 'required' })]);
    const onDisk = (JSON.parse(readFileSync(settingsFilePath(), 'utf8')) as { qeAcceptance?: string }).qeAcceptance;
    expect(mirror(a)).toBe(onDisk === 'off' ? QE_OFF_REASON : null);
  });
});
