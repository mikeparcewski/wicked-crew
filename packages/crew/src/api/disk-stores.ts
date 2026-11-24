/**
 * crew#1126 (J8): what wicked itself holds on the state-home volume, so a disk row that is low can say what to clear.
 *
 * Two kinds of store, each only when it is on the SAME volume as the state home (a store elsewhere frees nothing here):
 * - the check cache (`<worker home>/repo-checks`) and the floor logs beside it, as the engine measures them
 *   (`Core.floorCacheUsage`, read through the diagnostics' 60 s {@link FloorCacheCache}, home shown as `~`);
 * - each registered repository's run worktrees: `<repo>.wicked/wicked-worktrees` (wicked-core#1109) and the older
 *   `<repo>/wicked-worktrees`, sized by a walk with an entry budget (past it the size is "at least").
 *
 * Read only when the disk row is degraded or down, and kept for {@link DISK_STORES_TTL_MS}: a skin polls `/system`.
 * Read-only: nothing here deletes anything; the fix line says how a person clears each store.
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export interface DiskStore {
  kind: 'check_cache' | 'floor_logs' | 'run_worktrees';
  /** What it is, as a person reads it: "the checks cache", "3 job worktrees of wicked-core". */
  label: string;
  /** Where it is, the home directory shown as `~`. */
  path: string;
  bytes: number;
  /** The walk stopped at its budget: the store holds at least `bytes`. */
  partial: boolean;
  /** How to clear it, in plain words. */
  clear: string;
}

/** The walk's entry budget across every worktree dir of one read. */
export const DISK_STORES_WALK_BUDGET = 200_000;
export const DISK_STORES_TTL_MS = 60_000;
/** A store under this size is not worth naming. */
const NAMED_MIN_BYTES = 1 * 2 ** 20;

function tildePath(p: string, home: string): string {
  return home.length > 1 && (p === home || p.startsWith(home + sep)) ? `~${p.slice(home.length)}` : p;
}

function untilde(p: string, home: string): string {
  return p === '~' || p.startsWith(`~${sep}`) || p.startsWith('~/') ? join(home, p.slice(1)) : p;
}

async function statDev(p: string): Promise<number | null> {
  try {
    return (await fsp.stat(p)).dev;
  } catch {
    return null;
  }
}

/** Bytes under `dir`, never following a link; stops when `budget.left` runs out. */
async function treeBytes(dir: string, budget: { left: number }): Promise<{ bytes: number; partial: boolean }> {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let names: string[];
    try {
      names = await fsp.readdir(d);
    } catch {
      continue;
    }
    for (const name of names) {
      if (budget.left <= 0) return { bytes, partial: true };
      budget.left -= 1;
      const child = join(d, name);
      try {
        const st = await fsp.lstat(child);
        if (st.isDirectory()) stack.push(child);
        else if (st.isFile()) bytes += st.size;
      } catch {
        /* raced deletion */
      }
    }
  }
  return { bytes, partial: false };
}

async function childDirs(dir: string): Promise<number> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export interface DiskStoresInput {
  /** The volume the disk row measures (the state home). */
  volumePath: string;
  /** The engine's floor-cache usage (FloorCacheCache.get: paths shown as `~`), `null` without the addon static. */
  floorCache: () => Promise<Record<string, unknown> | null>;
  repos: ReadonlyArray<{ name: string; root_path: string }>;
  home?: string;
  devOf?: (p: string) => Promise<number | null>;
  budget?: number;
}

export async function readDiskStores(input: DiskStoresInput): Promise<DiskStore[]> {
  const home = input.home ?? homedir();
  const devOf = input.devOf ?? statDev;
  const volume = await devOf(input.volumePath);
  if (volume === null) return [];
  const here = async (p: string): Promise<boolean> => (await devOf(p)) === volume;
  const out: DiskStore[] = [];

  const usage = await input.floorCache().catch(() => null);
  if (usage !== null && typeof usage['path'] === 'string' && typeof usage['bytes'] === 'number') {
    if (await here(untilde(usage['path'], home))) {
      out.push({ kind: 'check_cache', label: 'the checks cache', path: usage['path'], bytes: usage['bytes'], partial: false, clear: 'safe to delete while no job is running: the next check rebuilds it' });
    }
    const logs = usage['logs'] as { path?: unknown; bytes?: unknown } | undefined;
    if (logs !== undefined && typeof logs.path === 'string' && typeof logs.bytes === 'number' && (await here(untilde(logs.path, home)))) {
      out.push({ kind: 'floor_logs', label: 'the past checks’ logs', path: logs.path, bytes: logs.bytes, partial: false, clear: 'safe to delete while no job is running' });
    }
  }

  const budget = { left: input.budget ?? DISK_STORES_WALK_BUDGET };
  for (const repo of input.repos) {
    for (const dir of [join(`${repo.root_path}.wicked`, 'wicked-worktrees'), join(repo.root_path, 'wicked-worktrees')]) {
      const trees = await childDirs(dir);
      if (trees === 0 || !(await here(dir))) continue;
      const size = await treeBytes(dir, budget);
      out.push({
        kind: 'run_worktrees',
        label: `${trees} job worktree${trees === 1 ? '' : 's'} of ${repo.name}`,
        path: tildePath(dir, home),
        bytes: size.bytes,
        partial: size.partial,
        clear: `remove a finished job’s tree with git -C ${tildePath(repo.root_path, home)} worktree remove <tree>`,
      });
    }
  }
  return out.filter((s) => s.bytes >= NAMED_MIN_BYTES || s.partial).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

/** One read per TTL, concurrent callers share it; a failed read is never kept. */
export class DiskStoreCache {
  private value: { at: number; stores: DiskStore[] } | null = null;
  private inFlight: Promise<DiskStore[]> | null = null;

  constructor(
    private readonly read: () => Promise<DiskStore[]>,
    private readonly ttlMs: number = DISK_STORES_TTL_MS,
  ) {}

  async get(): Promise<DiskStore[]> {
    if (this.value !== null && Date.now() - this.value.at < this.ttlMs) return this.value.stores;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.read()
      .then((stores) => {
        this.value = { at: Date.now(), stores };
        return stores;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** The fix line's list: the biggest three, each with its size, place and how to clear it. */
export function storesWords(stores: readonly DiskStore[]): string {
  const gib = (n: number): string => `${Math.round((n / 2 ** 30) * 10) / 10} GiB`;
  return [...stores]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((s) => `${s.label} (${s.path}, ${s.partial ? 'at least ' : ''}${gib(s.bytes)}): ${s.clear}`)
    .join('; ');
}
