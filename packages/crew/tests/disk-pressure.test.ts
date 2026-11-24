// crew#1126 (J8): disk pressure is visible BEFORE runs fail. A degraded free-disk row (under 10 GiB or over 90% used)
// is a Nerve Center need of its own, and the disk row's fix names wicked's own largest stores on that volume, with
// their size, where they are and how to clear each, instead of a generic "free disk space".
//
// The check-cache usage is the engine's own answer (`Core.floorCacheUsage`, the writer at wicked-core
// src/repo_checks.rs floor_cache_usage_in), read through the real addon over a scratch worker home.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemInfraRow } from 'wicked-crew-api-types';

import { CoreAdapter } from '../src/core/adapter.js';
import { FloorCacheCache } from '../src/api/diagnostics.js';
import { DiskStoreCache, readDiskStores, type DiskStore } from '../src/api/disk-stores.js';
import { buildNeeds } from '../src/api/needs.js';
import { diskRow } from '../src/api/system-snapshot.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;

function blob(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

const stores: DiskStore[] = [
  { kind: 'check_cache', label: 'the checks cache', path: '~/.wicked-worker/repo-checks', bytes: 16.9 * GiB, partial: false, clear: 'safe to delete while no job is running: the next check rebuilds it' },
  { kind: 'run_worktrees', label: '3 job worktrees of wicked-core', path: '~/src/wicked-core.wicked/wicked-worktrees', bytes: 3.2 * GiB, partial: true, clear: 'remove a finished job’s tree with git -C ~/src/wicked-core worktree remove <tree>' },
];

describe('crew#1126: the disk row names what wicked holds on the volume', () => {
  const fs = (freeGiB: number, totalGiB: number) => async () => ({ bavail: freeGiB, bsize: GiB, blocks: totalGiB });

  it('a degraded row names each store, biggest first, with its size, place and how to clear it', async () => {
    const row = await diskRow('/s', fs(8, 460), 1000, async () => null, async () => [...stores].reverse());
    expect(row.state).toBe('down'); // 98% used
    const low = await diskRow('/s', fs(45, 460), 1000, async () => null, async () => [...stores].reverse());
    expect(low.state).toBe('degraded');
    for (const r of [row, low]) {
      expect(r.remedy).toContain('the checks cache (~/.wicked-worker/repo-checks, 16.9 GiB)');
      expect(r.remedy).toContain('3 job worktrees of wicked-core (~/src/wicked-core.wicked/wicked-worktrees, at least 3.2 GiB)');
      expect(r.remedy!.indexOf('checks cache')).toBeLessThan(r.remedy!.indexOf('job worktrees'));
      expect(r.remedy).toMatch(/safe to delete while no job is running/);
      expect(r.remedy).not.toMatch(/cargo target dirs/);
      expect(r.details['stores']).toHaveLength(2);
    }
  });

  it('an ok row never walks the stores; a store read that fails or hangs keeps the plain fix', async () => {
    let walked = 0;
    const ok = await diskRow('/s', fs(300, 460), 1000, async () => null, async () => { walked += 1; return stores; });
    expect(ok.state).toBe('ok');
    expect(walked).toBe(0);
    const failed = await diskRow('/s', fs(3, 460), 1000, async () => null, async () => { throw new Error('EACCES'); });
    expect(failed.state).toBe('down');
    expect(failed.remedy).toMatch(/^Free disk space/);
    const hung = await diskRow('/s', fs(3, 460), 30, async () => null, () => new Promise(() => {}));
    expect(hung.state).toBe('down');
    expect(hung.remedy).toMatch(/^Free disk space/);
  });
});

describe('crew#1126: a degraded disk is a need before it is a failure', () => {
  const disk = (state: 'degraded' | 'down'): SystemInfraRow => ({
    key: 'disk',
    label: 'Free disk',
    state,
    reason: state === 'down' ? '3 GiB free on the state-home volume (99% used): writes will start to fail' : '8 GiB free on the state-home volume',
    remedy: 'Free space before the next large run. Wicked’s largest stores on it: the checks cache (~/.wicked-worker/repo-checks, 16.9 GiB): safe to delete while no job is running.',
    checkedAt: new Date(0).toISOString(),
    durationMs: 1,
    details: {},
  });
  const needs = (row: SystemInfraRow) => buildNeeds({ now: Date.now(), views: [], runs: [], infra: [row], clis: [], gaps: [], infraHoldsLive: () => false });

  it('degraded, with no job held: a yellow "slows" item carrying the named fix', () => {
    const item = needs(disk('degraded')).attention.find((a) => a.id === 'infra:disk');
    expect(item).toBeDefined();
    expect(item!.kind).toBe('slows');
    expect(item!.severity).toBe('yellow');
    expect(item!.title).toBe('Free disk: running low');
    expect(item!.remedy).toContain('the checks cache (~/.wicked-worker/repo-checks, 16.9 GiB)');
  });

  it('down stays a red "prevents" item', () => {
    const item = needs(disk('down')).attention.find((a) => a.id === 'infra:disk');
    expect(item!.kind).toBe('prevents');
    expect(item!.severity).toBe('red');
    expect(item!.title).toBe('Free disk: nearly full');
  });
});

describe('crew#1126: readDiskStores over a real layout', () => {
  let root: string;
  const prev = process.env['WICKED_WORKER_HOME'];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'disk-stores-')));
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['WICKED_WORKER_HOME'];
    else process.env['WICKED_WORKER_HOME'] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it('the engine-measured check cache and each repo’s run worktrees (both layouts), biggest first, home as ~', async () => {
    const reader = CoreAdapter.floorCacheReader();
    expect(reader).not.toBeNull();
    const worker = join(root, 'home', '.wicked-worker');
    process.env['WICKED_WORKER_HOME'] = worker;
    blob(join(worker, 'repo-checks', 'wicked-core-0a1b2c', 'run-a', 'target', 'big'), 3 * MiB);
    const repo = join(root, 'home', 'src', 'wicked-core');
    mkdirSync(repo, { recursive: true });
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'src', 'a.ts'), 2 * MiB);
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-2', 'b.ts'), 1 * MiB);
    blob(join(repo, 'wicked-worktrees', 'run-0', 'old.ts'), 1 * MiB);
    const empty = join(root, 'home', 'src', 'empty');
    mkdirSync(empty, { recursive: true });
    const floor = new FloorCacheCache(reader, 60_000, join(root, 'home'));
    const got = await readDiskStores({
      volumePath: root,
      floorCache: () => floor.get(),
      repos: [{ name: 'wicked-core', root_path: repo }, { name: 'empty', root_path: empty }],
      home: join(root, 'home'),
    });
    expect(got.map((s) => [s.kind, s.path, s.bytes])).toEqual([
      ['check_cache', '~/.wicked-worker/repo-checks', 3 * MiB],
      ['run_worktrees', '~/src/wicked-core.wicked/wicked-worktrees', 3 * MiB],
      ['run_worktrees', '~/src/wicked-core/wicked-worktrees', 1 * MiB],
    ]);
    expect(got[1]!.label).toBe('2 job worktrees of wicked-core');
    expect(got[2]!.label).toBe('1 job worktree of wicked-core');
    expect(got[1]!.clear).toContain('git -C ~/src/wicked-core worktree remove');
    expect(got.every((s) => s.partial === false)).toBe(true);
  });

  it('a store on another volume is left out; a walk past its budget says "at least"', async () => {
    const repo = join(root, 'r');
    for (let i = 0; i < 12; i++) blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', `f${i}`), 1024);
    const base = { floorCache: async () => null, repos: [{ name: 'r', root_path: repo }], home: '/nowhere' };
    const cut = await readDiskStores({ ...base, volumePath: root, budget: 5 });
    expect(cut).toHaveLength(1);
    expect(cut[0]!.partial).toBe(true);
    expect(cut[0]!.bytes).toBeLessThan(12 * 1024);
    const elsewhere = await readDiskStores({ ...base, volumePath: root, devOf: async (p) => (p === root ? 1 : 2) });
    expect(elsewhere).toEqual([]);
  });

  it('the cache reads once per TTL', async () => {
    let reads = 0;
    const cache = new DiskStoreCache(async () => { reads += 1; return stores; }, 60_000);
    await Promise.all([cache.get(), cache.get()]);
    await cache.get();
    expect(reads).toBe(1);
  });
});
