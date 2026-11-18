// crew#1591: `PUT /settings` persists through read -> merge -> publish. Two concurrent writes that
// both read the old file let the later publish silently revert the earlier one, while both answer
// 200. The adapter queues the whole step per settings file, so neither write can be lost.
//
// The interleave is explicit, with no timers: write A has read the file and is HELD by the test.
// Write B is then issued. Without the queue, B enters its read at once (the read is reached
// synchronously from `updateSettings`); with it, B does not read until A has published. The test
// asserts B has not read while A is held, then releases A by hand.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CrewSystemSettings } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

// `rename` is the publish step (`publishSettingsFile`); a test makes one call reject.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, rename: vi.fn(real.rename) };
});

const armedHome = crewStateHome();
const armedSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
let dir: string;
let file: string;
let adapter: CoreAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-write-queue-'));
  file = join(dir, 'settings.json');
  process.env['WICKED_CREW_SYSTEM_SETTINGS'] = file;
  setCrewStateHome(join(dir, 'home'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'home', 'core.db'), stub: true });
});

afterEach(() => {
  adapter.close();
  setCrewStateHome(armedHome);
  if (armedSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armedSettings;
  removeScratch(dir);
});

type Reader = { readSettings: () => Promise<{ settings: CrewSystemSettings; ok: boolean }> };

/** Count settings reads across `adapters` (at the call), and hold the FIRST read's result until `release()`. */
function holdFirstRead(adapters: CoreAdapter[]): { reads: () => number; release: () => void } {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  for (const a of adapters) {
    const target = a as unknown as Reader;
    const real = target.readSettings.bind(a);
    target.readSettings = async () => {
      count += 1;
      const n = count;
      const out = await real();
      if (n === 1) await gate;
      return out;
    };
  }
  return { reads: () => count, release };
}

/** Let every queued microtask and one macrotask turn run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

const onDisk = (): CrewSystemSettings => JSON.parse(readFileSync(file, 'utf8')) as CrewSystemSettings;

describe('settings writes queue: a concurrent write never reverts another (crew#1591)', () => {
  it("a worker's unrelated patch keeps the person's human-only value", async () => {
    await adapter.updateSettings({ graphNodeLimit: 150, powerModeDefault: false });
    const hold = holdFirstRead([adapter]);
    // The person saves first; the worker's patch arrives while the person's write is in flight.
    const person = adapter.updateSettings({ powerModeDefault: true });
    await settle();
    expect(hold.reads()).toBe(1);
    const worker = adapter.updateSettings({ graphNodeLimit: 220 });
    await settle();
    // The worker's write has not read the file while the person's write holds it.
    expect(hold.reads()).toBe(1);
    hold.release();
    const [p, w] = await Promise.all([person, worker]);
    expect(p.powerModeDefault).toBe(true);
    // The worker's write lands after the person's and carries the person's value forward.
    expect(w).toMatchObject({ powerModeDefault: true, graphNodeLimit: 220 });
    expect(onDisk()).toMatchObject({ powerModeDefault: true, graphNodeLimit: 220 });
    expect(await adapter.getSettings()).toMatchObject({ powerModeDefault: true, graphNodeLimit: 220 });
  });

  it('the queue is per settings file, not per adapter: two adapters in one process writing one file keep both keys', async () => {
    const other = new CoreAdapter({ dbPath: join(dir, 'home', 'core2.db'), stub: true });
    try {
      await adapter.updateSettings({ graphNodeLimit: 150, powerModeDefault: false });
      const hold = holdFirstRead([adapter, other]);
      const person = adapter.updateSettings({ powerModeDefault: true });
      await settle();
      const worker = other.updateSettings({ graphNodeLimit: 220 });
      await settle();
      expect(hold.reads()).toBe(1);
      hold.release();
      await Promise.all([person, worker]);
      expect(onDisk()).toMatchObject({ powerModeDefault: true, graphNodeLimit: 220 });
    } finally {
      other.close();
    }
  });

  it('a stored-value merge (`derive`) runs against the value it replaces, not an earlier read', async () => {
    await adapter.updateSettings({ councilSize: 1 });
    const hold = holdFirstRead([adapter]);
    const bump = (c: CrewSystemSettings): Partial<CrewSystemSettings> => ({ councilSize: (c.councilSize ?? 0) + 1 });
    const a = adapter.updateSettings({}, bump);
    await settle();
    const b = adapter.updateSettings({}, bump);
    await settle();
    expect(hold.reads()).toBe(1);
    hold.release();
    expect([(await a).councilSize, (await b).councilSize]).toEqual([2, 3]);
    expect(onDisk().councilSize).toBe(3);
  });

  it("`derive` wins over `patch` for the keys it returns; `patch`'s other keys still land", async () => {
    const out = await adapter.updateSettings({ councilSize: 9, graphNodeLimit: 120 }, () => ({ councilSize: 4 }));
    expect(out).toMatchObject({ councilSize: 4, graphNodeLimit: 120 });
    expect(onDisk()).toMatchObject({ councilSize: 4, graphNodeLimit: 120 });
  });

  it('a failed merge rejects to its own caller and does not wedge the queue', async () => {
    const boom = adapter.updateSettings({}, () => {
      throw new Error('merge failed');
    });
    const next = adapter.updateSettings({ graphNodeLimit: 300 });
    await expect(boom).rejects.toThrow('merge failed');
    await expect(next).resolves.toMatchObject({ graphNodeLimit: 300 });
    expect(onDisk().graphNodeLimit).toBe(300);
  });

  it('a rejected publish rejects to its own caller, is not on disk, and the queued write still lands', async () => {
    await adapter.updateSettings({ graphNodeLimit: 150 });
    vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const failed = adapter.updateSettings({ councilSize: 7 });
    const next = adapter.updateSettings({ graphNodeLimit: 300 });
    await expect(failed).rejects.toThrow('disk full');
    await expect(next).resolves.toMatchObject({ graphNodeLimit: 300 });
    expect(onDisk().graphNodeLimit).toBe(300);
    expect(onDisk()).not.toHaveProperty('councilSize');
  });
});
