// crew#1041: the daemon's first boot exited 0 mid-boot (release smoke S01). `refreshInstalled` deferred
// its probe behind an unref'd `setImmediate`; with nothing else holding the loop — first boot, before
// the server listens — that immediate never fired, the (also unref'd) deadline never fired, and Node
// exited with the `await` pending. A vitest worker always holds its loop, so the drain itself cannot
// be reproduced here: this pins the mechanism instead — the probe's deferral keeps its immediate ref'd.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillsRuntime } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const scratch: Scaffold[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const sc of scratch.splice(0)) removeScratch(sc.base);
});

describe('refreshInstalled keeps the loop alive until its probe settles (crew#1041)', () => {
  it('never unrefs the immediate that starts the probe', async () => {
    const sc = scaffold();
    scratch.push(sc);
    const unrefs: string[] = [];
    const real = globalThis.setImmediate;
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
      const handle = real(fn, ...args);
      const unref = handle.unref.bind(handle);
      handle.unref = () => { unrefs.push(new Error().stack ?? ''); return unref(); };
      return handle;
    }) as typeof setImmediate);
    const runtime = new SkillsRuntime({ store: sc.store, log: () => {}, bootSnapshot: undefined, installedTtlMs: 0 });
    await runtime.refreshInstalled({ fresh: true });
    expect(unrefs.filter((s) => s.includes('probeInstalled'))).toEqual([]);
  });
});
