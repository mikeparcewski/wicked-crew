/**
 * The router (DES-TRIGGER-REGISTRY-001 §4.6): which enabled entries a key point reaches.
 *
 * The type set is precomputed per source, so the 68% of CoreEvents that are `unitOutputDelta` are
 * rejected by one `Set.has` on the hot path (`wants`). The filter is JSON-path equality, an AND of
 * keys; an array value means "any of".
 */

import type { WatchEntrySource, WatchPriority } from 'wicked-crew-api-types';
import type { KeyPointInput, LoadedEntry } from './types.js';

const RANK: Record<WatchPriority, number> = { p0: 0, p1: 1, p2: 2 };

/** The value at a dotted path (`"a.b"`), or `undefined`. */
function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** JSON-value equality: key order does not matter, array order does. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => same(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** True when `event` satisfies every key of `filter` (an array value: any of its members). */
export function matchesFilter(filter: Record<string, unknown>, event: unknown): boolean {
  for (const [path, want] of Object.entries(filter)) {
    const got = at(event, path);
    if (Array.isArray(want) ? !want.some((w) => same(got, w)) : !same(got, want)) return false;
  }
  return true;
}

interface Routed {
  entry: LoadedEntry;
  /** A joined key point (TR-W5b): routed unfiltered, for the check to fold. */
  joined: boolean;
}

export class Router {
  private readonly byKey = new Map<string, Routed[]>();
  private readonly priorityByKey = new Map<string, WatchPriority>();

  constructor(entries: readonly LoadedEntry[]) {
    for (const e of entries) {
      if (!e.enabled) continue;
      const points = [{ point: e.on, joined: false }, ...(e.join ?? []).map((point) => ({ point, joined: true }))];
      for (const { point, joined } of points) {
        const key = `${point.source}\u0000${point.type}`;
        const list = this.byKey.get(key) ?? [];
        if (list.some((r) => r.entry.id === e.id)) continue; // a join naming the trigger's own type
        list.push({ entry: e, joined });
        this.byKey.set(key, list);
        const prev = this.priorityByKey.get(key);
        if (prev === undefined || RANK[e.priority] < RANK[prev]) this.priorityByKey.set(key, e.priority);
      }
    }
  }

  /** O(1): the input's priority when some enabled entry listens for it, else `null` (drop it). */
  wants(source: WatchEntrySource, type: string): WatchPriority | null {
    return this.priorityByKey.get(`${source}\u0000${type}`) ?? null;
  }

  /** The enabled entries whose `on` and `filter` the input satisfies. */
  route(input: KeyPointInput): LoadedEntry[] {
    const list = this.byKey.get(`${input.source}\u0000${input.type}`);
    if (list === undefined) return [];
    return list.filter((r) => r.joined || matchesFilter(r.entry.filter, input.event)).map((r) => r.entry);
  }

  /** Every bus type an enabled entry listens for (the bus pull reads only these). */
  busTypes(): string[] {
    return [...this.byKey.keys()].filter((k) => k.startsWith('bus\u0000')).map((k) => k.slice(4));
  }

  /** Enabled entries of one source (coverage, internal ticks). */
  entriesOf(source: WatchEntrySource): LoadedEntry[] {
    return [...this.byKey.entries()]
      .filter(([k]) => k.startsWith(`${source}\u0000`))
      .flatMap(([, v]) => v.filter((r) => !r.joined).map((r) => r.entry));
  }
}
