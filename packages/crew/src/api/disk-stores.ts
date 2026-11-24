/**
 * crew#1126 (J8): what wicked itself holds on the state-home volume, so a disk row that is low can say what to clear.
 *
 * Two kinds of store, each only when it is on the SAME volume as the state home (a store elsewhere frees nothing here):
 * - the check cache (`<worker home>/repo-checks`) and the floor logs beside it, as the engine measures them
 *   (`Core.floorCacheUsage`, read through the diagnostics' 60 s {@link FloorCacheCache});
 * - each registered repository's run worktrees: `<repo>.wicked/wicked-worktrees` (wicked-core#1109) and the older
 *   `<repo>/wicked-worktrees`.
 *
 * The worktree walk is bounded three ways: an entry budget shared by every store of one read (every entry the walk
 * sees counts, directories included), a deadline, and the volume (it never follows a link, and never descends into a
 * directory on another device, such as a mount point). A walk cut short, or one that could not read a subtree, says
 * "at least". Read only when the disk row is low, and kept for {@link DISK_STORES_TTL_MS} per volume: a skin polls
 * `/system`. Read-only: nothing here deletes anything; the fix line says how a person clears each store.
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { shellPath } from './cluster-status.js';

export interface DiskStore {
  kind: 'check_cache' | 'floor_logs' | 'run_worktrees';
  /** What it is, as a person reads it: "the checks cache", "3 job worktrees of wicked-core". */
  label: string;
  /** Where it is, the home directory shown as `~` (shell-quoted when it needs quoting). */
  path: string;
  bytes: number;
  /** The walk stopped at its budget or deadline, or could not read part of the tree: it holds at least `bytes`. */
  partial: boolean;
  /** How to clear it, in plain words. */
  clear: string;
}

/** The walk's entry budget across every worktree dir of one read. */
export const DISK_STORES_WALK_BUDGET = 200_000;
export const DISK_STORES_TTL_MS = 60_000;
/** A store under this size is not worth naming on a disk that is running out. */
export const DISK_STORES_NAMED_MIN_BYTES = 100 * 2 ** 20;

const GONE = new Set(['ENOENT', 'ENOTDIR']);

/** The bytes in words: `16.9 GiB`, `512 MiB`. */
export function sizeWords(n: number): string {
  return n >= 2 ** 30 ? `${Math.round((n / 2 ** 30) * 10) / 10} GiB` : `${Math.max(1, Math.round(n / 2 ** 20))} MiB`;
}

/** A real directory (never a link) on device `dev`: `yes`, `no` (gone, a link, not a directory, another device), or
 *  `error` (it could not be read: the size that leaves it out is a lower bound). */
async function dirOn(p: string, dev: number): Promise<'yes' | 'no' | 'error'> {
  try {
    const st = await fsp.lstat(p);
    return st.isDirectory() && st.dev === dev ? 'yes' : 'no';
  } catch (err) {
    return GONE.has((err as NodeJS.ErrnoException).code ?? '') ? 'no' : 'error';
  }
}

const spent = (walk: Walk): boolean => walk.left <= 0 || Date.now() >= walk.deadline;

interface Walk {
  left: number;
  deadline: number;
  dev: number;
}

/**
 * Bytes under `dir` and how many directories sit directly in it. Entries are streamed (never a whole listing at once)
 * and each one is charged to the shared budget; links are never followed; a directory on another device is skipped.
 */
async function treeBytes(dir: string, walk: Walk): Promise<{ bytes: number; trees: number; partial: boolean }> {
  let bytes = 0;
  let trees = 0;
  let partial = false;
  const stack: Array<{ path: string; top: boolean }> = [{ path: dir, top: true }];
  while (stack.length > 0) {
    // The bounds hold between directories too: a budget spent on empty directories queues no more I/O.
    if (spent(walk)) return { bytes, trees, partial: true };
    const d = stack.pop()!;
    // Checked again when it is read: a directory swapped for a link after it was queued is not followed.
    if (!d.top) {
      const ok = await dirOn(d.path, walk.dev);
      if (ok === 'error') partial = true;
      if (ok !== 'yes') continue;
    }
    let handle;
    try {
      handle = await fsp.opendir(d.path);
    } catch (err) {
      if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) partial = true;
      continue;
    }
    try {
      for await (const e of handle) {
        if (spent(walk)) return { bytes, trees, partial: true };
        walk.left -= 1;
        if (e.isSymbolicLink()) continue;
        const child = join(d.path, e.name);
        if (e.isDirectory()) {
          if (d.top) trees += 1;
          stack.push({ path: child, top: false });
        } else if (e.isFile()) {
          try {
            const st = await fsp.lstat(child);
            if (st.dev === walk.dev) bytes += st.size;
          } catch (err) {
            if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) partial = true;
          }
        }
      }
    } catch (err) {
      if (!GONE.has((err as NodeJS.ErrnoException).code ?? '')) partial = true;
    }
  }
  return { bytes, trees, partial };
}

export interface DiskStoresInput {
  /** The volume the disk row measures (the state home). */
  volumePath: string;
  /** The engine's floor-cache usage with its real paths (`FloorCacheCache.getRaw`), `null` without the addon static. */
  floorCache: () => Promise<Record<string, unknown> | null>;
  repos: ReadonlyArray<{ name: string; root_path: string }>;
  /** Absolute ms: the walk stops here and says "at least". */
  deadline: number;
  home?: string;
  devOf?: (p: string) => Promise<number | null>;
  budget?: number;
  minBytes?: number;
}

async function statDev(p: string): Promise<number | null> {
  try {
    return (await fsp.stat(p)).dev;
  } catch {
    return null;
  }
}

/** Throws when the volume itself cannot be read (the caller then keeps the plain fix and caches nothing). */
export async function readDiskStores(input: DiskStoresInput): Promise<DiskStore[]> {
  const home = (input.home ?? homedir()).replace(/\/+$/, '') || '/';
  const show = (p: string): string => shellPath(p, home);
  const devOf = input.devOf ?? statDev;
  const volume = await devOf(input.volumePath);
  if (volume === null) throw new Error(`the state-home volume (${show(input.volumePath)}) could not be read`);
  const out: DiskStore[] = [];

  // Given half of what is left: an engine read that never answers leaves the worktrees still measured.
  const usage = await Promise.race([
    input.floorCache().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, (input.deadline - Date.now()) / 2)).unref()),
  ]);
  if (usage !== null && typeof usage['path'] === 'string' && typeof usage['bytes'] === 'number') {
    const cache = usage['path'];
    if ((await devOf(cache)) === volume) {
      out.push({ kind: 'check_cache', label: 'the checks cache', path: show(cache), bytes: usage['bytes'], partial: false, clear: 'safe to delete while no job and no check is running: the next check rebuilds it' });
    }
    const logs = usage['logs'];
    if (logs !== null && typeof logs === 'object') {
      const { path, bytes } = logs as { path?: unknown; bytes?: unknown };
      if (typeof path === 'string' && typeof bytes === 'number' && (await devOf(path)) === volume) {
        out.push({ kind: 'floor_logs', label: 'the past checks’ logs', path: show(path), bytes, partial: false, clear: 'safe to delete while no job and no check is running' });
      }
    }
  }

  const walk: Walk = { left: input.budget ?? DISK_STORES_WALK_BUDGET, deadline: input.deadline, dev: volume };
  for (const repo of input.repos) {
    for (const dir of [join(`${repo.root_path}.wicked`, 'wicked-worktrees'), join(repo.root_path, 'wicked-worktrees')]) {
      if (spent(walk)) break;
      if ((await dirOn(dir, volume)) !== 'yes') continue;
      const size = await treeBytes(dir, walk);
      if (size.trees === 0) continue;
      out.push({
        kind: 'run_worktrees',
        label: `${size.trees} job worktree${size.trees === 1 ? '' : 's'} of ${repo.name}`,
        path: show(dir),
        bytes: size.bytes,
        partial: size.partial,
        clear: `remove a finished job’s tree with git -C ${show(repo.root_path)} worktree remove ${show(dir)}/<job id> (its work stays on the job’s branch)`,
      });
    }
  }
  const min = input.minBytes ?? DISK_STORES_NAMED_MIN_BYTES;
  return out.filter((s) => s.bytes >= min).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

/** One read per TTL per volume; concurrent callers share it; a failed read is never kept, and a read that never
 *  settles is abandoned after a TTL so it cannot wedge every later poll. */
export class DiskStoreCache {
  private value: { at: number; volume: string; stores: DiskStore[] } | null = null;
  private inFlight: { at: number; volume: string; p: Promise<DiskStore[]> } | null = null;

  constructor(
    private readonly read: (volume: string, deadline: number) => Promise<DiskStore[]>,
    private readonly ttlMs: number = DISK_STORES_TTL_MS,
  ) {}

  /** `deadline` (absolute ms) bounds a read this call starts. */
  async get(volume: string, deadline: number): Promise<DiskStore[]> {
    const now = Date.now();
    if (this.value !== null && this.value.volume === volume && now - this.value.at < this.ttlMs) return this.value.stores;
    if (this.inFlight !== null && this.inFlight.volume === volume && now - this.inFlight.at < this.ttlMs) return this.inFlight.p;
    const flight = {
      at: now,
      volume,
      p: this.read(volume, deadline).then((stores) => {
        if (this.inFlight === flight) this.value = { at: Date.now(), volume, stores };
        return stores;
      }),
    };
    flight.p.then(
      () => { if (this.inFlight === flight) this.inFlight = null; },
      () => { if (this.inFlight === flight) this.inFlight = null; },
    );
    this.inFlight = flight;
    return flight.p;
  }
}

/** The fix line's list: the biggest three, each with its size, place and how to clear it. */
export function storesWords(stores: readonly DiskStore[]): string {
  return [...stores]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((s) => `${s.label} (${s.path}, ${s.partial ? 'at least ' : ''}${sizeWords(s.bytes)}): ${s.clear}`)
    .join('; ');
}
