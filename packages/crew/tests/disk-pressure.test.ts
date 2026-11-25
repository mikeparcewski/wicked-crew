// crew#1126 (J8): disk pressure is visible BEFORE runs fail. A degraded free-disk row (under 10 GiB or over 90% used)
// is a Nerve Center need of its own, and the disk row's fix names wicked's own largest stores on that volume, with
// their size, where they are and how to clear each, instead of a generic "free disk space".
//
// The check-cache usage is the engine's own answer (`Core.floorCacheUsage`, the writer at wicked-core
// src/repo_checks.rs floor_cache_usage_in), read through the real addon over a scratch worker home.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemInfraRow } from 'wicked-crew-api-types';

import { CoreAdapter } from '../src/core/adapter.js';
import { FloorCacheCache } from '../src/api/diagnostics.js';
import { DiskStoreCache, readDiskStores, sizeWords, storesWords, type DiskStore } from '../src/api/disk-stores.js';
import { buildNeeds } from '../src/api/needs.js';
import { diskRow } from '../src/api/system-snapshot.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;

function blob(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

const stores: DiskStore[] = [
  { kind: 'check_cache', label: 'the checks cache', path: '~/.wicked-worker/repo-checks', bytes: 16.9 * GiB, partial: false, clear: 'safe to delete while no job and no check is running: the next check rebuilds it' },
  { kind: 'run_worktrees', label: '3 job worktrees of core-repo', path: '~/src/core-repo.wicked/wicked-worktrees', bytes: 3.2 * GiB, partial: true, clear: 'remove a finished job’s tree with git -C ~/src/core-repo worktree remove <tree>' },
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
      expect(r.remedy).toContain('3 job worktrees of core-repo (~/src/core-repo.wicked/wicked-worktrees, at least 3.2 GiB)');
      expect(r.remedy!.indexOf('checks cache')).toBeLessThan(r.remedy!.indexOf('job worktrees'));
      expect(r.remedy).toMatch(/safe to delete while no job and no check is running/);
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
    let asked = 0;
    const t0 = Date.now();
    const hung = await diskRow('/s', fs(3, 460), 300, async () => null, () => { asked += 1; return new Promise(() => {}); });
    expect(asked).toBe(1);
    expect(Date.now() - t0).toBeLessThan(550);
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
    blob(join(worker, 'repo-checks', 'core-repo-0a1b2c', 'run-a', 'target', 'big'), 3 * MiB);
    const repo = join(root, 'home', 'src', 'core-repo');
    mkdirSync(repo, { recursive: true });
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'src', 'a.ts'), 2 * MiB);
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-2', 'b.ts'), 1 * MiB);
    blob(join(repo, 'wicked-worktrees', 'run-0', 'old.ts'), 1 * MiB);
    const empty = join(root, 'home', 'src', 'empty');
    mkdirSync(empty, { recursive: true });
    const floor = new FloorCacheCache(reader, 60_000, join(root, 'home'));
    const got = await readDiskStores({
      volumePath: root,
      deadline: Date.now() + 10_000,
      minBytes: MiB,
      floorCache: () => floor.getRaw(),
      repos: [{ name: 'core-repo', root_path: repo }, { name: 'empty', root_path: empty }],
      home: join(root, 'home'),
    });
    expect(got.map((s) => [s.kind, s.path, s.bytes])).toEqual([
      ['check_cache', '~/.wicked-worker/repo-checks', 3 * MiB],
      ['run_worktrees', '~/src/core-repo.wicked/wicked-worktrees', 3 * MiB],
      ['run_worktrees', '~/src/core-repo/wicked-worktrees', 1 * MiB],
    ]);
    expect(got[1]!.label).toBe('2 job worktrees of core-repo');
    expect(got[2]!.label).toBe('1 job worktree of core-repo');
    expect(got[1]!.clear).toContain('git -C ~/src/core-repo worktree remove ~/src/core-repo.wicked/wicked-worktrees/<job id>');
    expect(storesWords(got)).toContain('the checks cache (~/.wicked-worker/repo-checks, 3 MiB)');
    expect(got.every((s) => s.partial === false)).toBe(true);
  });

  it('a store on another volume is left out; a walk past its budget says "at least"', async () => {
    const repo = join(root, 'r');
    for (let i = 0; i < 12; i++) blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', `f${i}`), 1024);
    const base = { floorCache: async () => null, repos: [{ name: 'r', root_path: repo }], home: '/nowhere', deadline: Date.now() + 10_000, minBytes: 0 };
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
    const d = Date.now() + 1000;
    await Promise.all([cache.get('/s', d), cache.get('/s', d)]);
    await cache.get('/s', d);
    expect(reads).toBe(1);
    await cache.get('/other', d); // keyed by volume
    expect(reads).toBe(2);
    let fail = true;
    const flaky = new DiskStoreCache(async () => { if (fail) throw new Error('EIO'); return stores; }, 60_000);
    await expect(flaky.get('/s', d)).rejects.toThrow('EIO');
    fail = false;
    expect(await flaky.get('/s', d)).toHaveLength(2); // a failed read is never kept
  });

  it('review r1: links are never followed, another device is never walked, an unreadable subtree says "at least"', async () => {
    const repo = join(root, 'r');
    const outside = join(root, 'outside');
    blob(join(outside, 'huge'), 2 * MiB);
    // The legacy dir is a link to a tree outside: not walked at all.
    mkdirSync(repo, { recursive: true });
    symlinkSync(outside, join(repo, 'wicked-worktrees'));
    // A job tree holding a link to the outside tree: the link is skipped.
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'a'), 1 * MiB);
    symlinkSync(outside, join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'linked'));
    const args = { volumePath: root, floorCache: async () => null, repos: [{ name: 'r', root_path: repo }], home: '/nowhere', deadline: Date.now() + 10_000, minBytes: 0 };
    const got = await readDiskStores(args);
    expect(got.map((s) => [s.path.endsWith('r.wicked/wicked-worktrees'), s.bytes, s.partial])).toEqual([[true, 1 * MiB, false]]);
    // A child directory on another device (a mount point) is not descended into.
    const dev = (await import('node:fs')).statSync(root).dev;
    const mounted = join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'mnt');
    blob(join(mounted, 'far'), 2 * MiB);
    const lstat = (await import('node:fs')).promises.lstat;
    const spy = vi.spyOn((await import('node:fs')).promises, 'lstat').mockImplementation(async (p, o) => {
      const st = await lstat(p as string, o as never);
      return String(p).startsWith(mounted) ? Object.assign(st, { dev: dev + 1 }) : st;
    });
    try {
      expect((await readDiskStores(args))[0]!.bytes).toBe(1 * MiB);
    } finally {
      spy.mockRestore();
    }
    rmSync(mounted, { recursive: true, force: true });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'locked');
      blob(join(locked, 'x'), 1024);
      chmodSync(locked, 0o000);
      try {
        expect((await readDiskStores(args))[0]!.partial).toBe(true);
      } finally {
        chmodSync(locked, 0o700);
      }
    }
  });

  it('review r1: a spent budget names no empty store; a null logs block is no error; a quoted repo path', async () => {
    const a = join(root, 'a');
    const b = join(root, 'my repo;x');
    for (let i = 0; i < 8; i++) blob(join(`${a}.wicked`, 'wicked-worktrees', 'run-1', `f${i}`), 1024);
    blob(join(`${b}.wicked`, 'wicked-worktrees', 'run-1', 'f'), 1024);
    const repos = [{ name: 'a', root_path: a }, { name: 'b', root_path: b }];
    const cut = await readDiskStores({ volumePath: root, floorCache: async () => ({ path: '/nowhere', bytes: 1, logs: null }), repos, home: '/nowhere', deadline: Date.now() + 10_000, budget: 4, minBytes: 1 });
    expect(cut.map((s) => s.label)).toEqual(['1 job worktree of a']);
    expect(cut[0]!.partial).toBe(true);
    const all = await readDiskStores({ volumePath: root, floorCache: async () => null, repos, home: root, deadline: Date.now() + 10_000, minBytes: 1 });
    const quoted = all.find((s) => s.label.endsWith('of b'))!;
    expect(quoted.path).toBe(`~/'my repo;x.wicked/wicked-worktrees'`);
    expect(quoted.clear).toContain(`git -C ~/'my repo;x' worktree remove`);
  });

  it('review r1: a store read past the deadline says "at least"; the row keeps one bound in all', async () => {
    const repo = join(root, 'r');
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', 'a'), 1024);
    const late = await readDiskStores({ volumePath: root, floorCache: async () => null, repos: [{ name: 'r', root_path: repo }], home: '/nowhere', deadline: Date.now() - 1, minBytes: 0 });
    expect(late).toEqual([]);
    const t0 = Date.now();
    const row = await diskRow('/s', async () => ({ bavail: 3, bsize: GiB, blocks: 100 }), 300, () => new Promise(() => {}), () => new Promise(() => {}));
    expect(row.state).toBe('down');
    expect(Date.now() - t0).toBeLessThan(550);
  });

  it('sizes read in GiB from 1 GiB, in MiB under it', () => {
    expect(sizeWords(16.94 * GiB)).toBe('16.9 GiB');
    expect(sizeWords(300 * MiB)).toBe('300 MiB');
    expect(sizeWords(3 * MiB)).toBe('3 MiB');
  });

  it('review r2: a budget spent on empty directories opens no more; a hung engine read leaves the worktrees measured', async () => {
    const repo = join(root, 'r');
    for (let i = 0; i < 6; i++) mkdirSync(join(`${repo}.wicked`, 'wicked-worktrees', 'run-1', `d${i}`, 'deeper'), { recursive: true });
    const fsMod = await import('node:fs');
    const opendir = vi.spyOn(fsMod.promises, 'opendir');
    try {
      await readDiskStores({ volumePath: root, floorCache: async () => null, repos: [{ name: 'r', root_path: repo }], home: '/nowhere', deadline: Date.now() + 10_000, budget: 7, minBytes: 0 });
      // the store root, run-1, then nothing: the 6 queued d* directories spent the budget of 7.
      expect(opendir.mock.calls.length).toBe(2);
    } finally {
      opendir.mockRestore();
    }
    blob(join(`${repo}.wicked`, 'wicked-worktrees', 'run-2', 'a'), 2 * MiB);
    const t0 = Date.now();
    const got = await readDiskStores({ volumePath: root, floorCache: () => new Promise(() => {}), repos: [{ name: 'r', root_path: repo }], home: '/nowhere', deadline: Date.now() + 1_500, minBytes: MiB });
    expect(got.map((s) => s.kind)).toEqual(['run_worktrees']);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('review r2: the check cache is found by its real path even when the home is a prefix of it', async () => {
    const reader = CoreAdapter.floorCacheReader()!;
    const home = join(root, 'al');
    const worker = join(root, 'alice', '.wicked-worker');
    process.env['WICKED_WORKER_HOME'] = worker;
    blob(join(worker, 'repo-checks', 'k', 'run-a', 'big'), 2 * MiB);
    const floor = new FloorCacheCache(reader, 60_000, home);
    expect(String((await floor.get())!['path'])).not.toContain(root); // the response copy is tildified (lossily)
    const got = await readDiskStores({ volumePath: root, floorCache: () => floor.getRaw(), repos: [], home, deadline: Date.now() + 10_000, minBytes: MiB });
    expect(got.map((s) => [s.kind, s.bytes])).toEqual([['check_cache', 2 * MiB]]);
  });
});
