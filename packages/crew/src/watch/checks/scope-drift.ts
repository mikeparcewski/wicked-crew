/**
 * `deterministic:scope_drift` (DES-trigger-registry §4.3 row 4 "scope-drift", §4.4; TR-W7).
 *
 * Set logic over two facts the engine computed, nothing parsed: the creator floor's
 * `repoChecksEvaluated.changed` (TR-W1b — every path the unit changed, its dispatch baseline tree
 * against the tree the checks ran on; any carrier, any way of editing) against the run's declared
 * scope, `plan.accepted.touch` (TR-W1a — the accepted proposal's touch unioned with every earlier
 * accepted rev's; a BUS row the registry PULLS, the first entry that listens on the bus). A path the
 * floor names that no touch entry covers is one flag per (attempt, path); the emitter rolls them up
 * per attempt past the entry's rate (§4.7). Drift flags clear only by dismissal.
 *
 * Touch entries are files or directory prefixes ending `/` (§4.4). Nothing else is inferred: an entry
 * without a trailing slash names ONE file, never a prefix (a declared `src` does not cover `src/x.ts`;
 * a declared `src/` does). Both sides are normalised (`./`, doubled slashes) before the comparison so
 * a spelling difference is never drift.
 *
 * Order is not assumed. A plan is accepted minutes before its creator floors run, but the plan row is
 * polled off the bus while the floor arrives on the fan-in, so a floor that lands first is KEPT
 * (bounded) and judged when the plan row arrives — anchored to the floor's own time and replay
 * provenance (TR-W6's kept-frame rule). The newest accepted rev is the scope (core already unions the
 * revs); a lower rev replayed late never narrows it.
 *
 * Coverage (§4.7, G7):
 *   - "no declared scope" when `touch_source` is `none`, or absent — an old row reads as none, and an
 *     engine before TR-W1a cannot be told apart from a plan that declared nothing, so the reason
 *     names both. A DECLARED empty set (a source with no paths) is not none: it covers nothing, so
 *     every change is outside it and the run is checked;
 *   - not checked when the TOUCH set itself was cut at 64: what lies outside the listed paths cannot
 *     be known, so nothing is flagged rather than flagging what may be in scope;
 *   - a truncated CHANGE list is still judged on the paths it names, and the fact says it was cut
 *     (§4.4: "a truncated list still names its first 200 paths and says so").
 */

import { z } from 'zod';
import type { CheckOutput, RunWatchState, WatchCheck } from '../types.js';

/** The bus row the check joins to (TR-W1a). The entry's `join` names it; the loader checks the grammar. */
export const PLAN_ACCEPTED_TYPE = 'wicked.team.plan.accepted';
/** `plan.accepted.touch` is cut at this many paths by the engine (`ACCEPTED_TOUCH_CAP`). */
export const TOUCH_CAP = 64;

export interface ScopeDriftThreshold {
  /** An attempt raises only when at least this many of its changed paths lie outside the scope. */
  min_paths: number;
}

interface Touch {
  paths: string[];
  /** `user` | `pa_scope` | `floor_default` | `none` (an absent field reads as `none`). */
  source: string;
  truncated: boolean;
  rev: number;
  /** The row carried no `touch_source` at all: an engine before TR-W1a, or nothing declared. */
  fromOldRow: boolean;
}

interface ChangedPath {
  status: string;
  path: string;
}

interface Floor {
  ord: number | null;
  attempt: number | null;
  changed: ChangedPath[];
  truncated: boolean;
  /** The floor's own time and replay provenance — a row judged later is anchored to THEM. */
  at: number;
  replay: boolean;
}

interface Bag {
  touch: Touch | null;
  /** Creator floors seen (with or without a change list). */
  floors: number;
  /** Creator floors that arrived before any accepted plan, kept for it (one per ord:attempt). */
  waiting: Floor[];
  /** Floors that could not be kept (more than {@link WAITING_MAX} waiting). */
  lost: number;
  raised: Set<string>;
}

const BAG_KEY = 'scope_drift';
/** Floors one run may hold before its plan row arrives; past it they are counted lost and coverage says so. */
const WAITING_MAX = 50;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isChangedPath = (v: unknown): v is ChangedPath =>
  typeof v === 'object' && v !== null && typeof (v as ChangedPath).path === 'string' && (v as ChangedPath).path !== '';

/** Repo-relative, forward slashes: no leading `./` or `/`, no doubled slashes. */
export function normalisePath(p: string): string {
  let s = p.replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** True when some touch entry covers `path`: an equal file, or a directory prefix ending `/` (§4.4). */
export function inScope(path: string, touch: readonly string[]): boolean {
  const p = normalisePath(path);
  for (const raw of touch) {
    const t = normalisePath(raw);
    if (t === '') continue;
    if (t.endsWith('/')) {
      if (p.startsWith(t)) return true;
    } else if (p === t) {
      return true;
    }
  }
  return false;
}

function bagOf(state: RunWatchState): Bag {
  let bag = state.bag.get(BAG_KEY) as Bag | undefined;
  if (bag === undefined) {
    bag = { touch: null, floors: 0, waiting: [], lost: 0, raised: new Set() };
    state.bag.set(BAG_KEY, bag);
  }
  return bag;
}

const floorKey = (f: Pick<Floor, 'ord' | 'attempt'>): string => `${f.ord ?? '-'}:${f.attempt ?? '-'}`;

/**
 * The declared scope a judgement can use, or `null` when it cannot judge (none, or cut). A DECLARED
 * empty set (`touch_source` user/pa_scope with no paths) is usable and covers nothing: every change
 * is outside it — only `none` means "nothing was declared" (codex on #787: an empty set is not none).
 */
function usableTouch(bag: Bag): Touch | null {
  const t = bag.touch;
  if (t === null || t.source === 'none' || t.truncated) return null;
  return t;
}

/** One floor against the run's scope: a flag per path outside it (once per attempt+path). */
function judge(bag: Bag, floor: Floor, threshold: ScopeDriftThreshold, kept: boolean): CheckOutput[] {
  const touch = usableTouch(bag);
  if (touch === null) return [];
  const outside = floor.changed.filter((c) => !inScope(c.path, touch.paths));
  if (outside.length < threshold.min_paths) return [];
  const out: CheckOutput[] = [];
  for (const c of outside) {
    const path = normalisePath(c.path);
    const subject = `${floorKey(floor)}:drift:${path}`;
    if (bag.raised.has(subject)) continue;
    bag.raised.add(subject);
    out.push({
      op: 'raise',
      subject,
      kind: 'flag',
      sentence: `Changed a file outside the plan's declared scope: ${path}.`,
      facts: {
        path,
        status: c.status,
        touch_source: touch.source,
        declared: touch.paths.length,
        plan_rev: touch.rev,
        ...(floor.truncated ? { changed_truncated: true } : {}),
      },
      ord: floor.ord,
      attempt: floor.attempt,
      re: `repoChecksEvaluated#${floorKey(floor)}`,
      // A kept floor's rows carry the floor's own time and provenance, not the plan row's.
      ...(kept ? { at: floor.at, replay: floor.replay } : {}),
    });
  }
  return out;
}

export const scopeDriftCheck: WatchCheck<Record<string, never>, ScopeDriftThreshold> = {
  name: 'deterministic:scope_drift',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({ min_paths: z.number().int().min(1).max(200).default(1) }).strict() as unknown as z.ZodType<ScopeDriftThreshold>,
  evaluate(input, state, _params, threshold) {
    const bag = bagOf(state);
    if (input.source === 'bus' && input.type === PLAN_ACCEPTED_TYPE) {
      const payload = (input.event['payload'] ?? {}) as Record<string, unknown>;
      const rev = num(payload['plan_rev']) ?? 0;
      if (bag.touch !== null && rev < bag.touch.rev) return []; // a lower rev replayed late never narrows the scope
      const rawTouch = payload['touch'];
      const rawSource = payload['touch_source'];
      bag.touch = {
        paths: Array.isArray(rawTouch) ? rawTouch.filter((x): x is string => typeof x === 'string' && x !== '') : [],
        source: typeof rawSource === 'string' ? rawSource : 'none',
        truncated: payload['touch_truncated'] === true,
        rev,
        fromOldRow: typeof rawSource !== 'string',
      };
      const todo = bag.waiting;
      bag.waiting = [];
      const out: CheckOutput[] = [];
      for (const f of todo) out.push(...judge(bag, f, threshold, true));
      return out;
    }
    if (input.type !== 'repoChecksEvaluated') return [];
    const e = input.event;
    if (e['floor'] !== 'creator') return []; // a verify floor is the judge's tree, not the creator's change
    bag.floors++;
    const rawChanged = e['changed'];
    if (!Array.isArray(rawChanged)) return []; // the tree did not change (or an engine before TR-W1b): nothing to judge
    const floor: Floor = {
      ord: num(e['ord']),
      attempt: num(e['attempt']),
      changed: rawChanged.filter(isChangedPath),
      truncated: e['changedTruncated'] === true,
      at: input.at,
      replay: input.replay === true,
    };
    if (bag.touch === null) {
      // No plan row yet: keep the floor for it. A redelivery of the same floor replaces, never doubles.
      const i = bag.waiting.findIndex((w) => floorKey(w) === floorKey(floor));
      if (i !== -1) bag.waiting[i] = floor;
      else if (bag.waiting.length < WAITING_MAX) bag.waiting.push(floor);
      else bag.lost++;
      return [];
    }
    return judge(bag, floor, threshold, false);
  },
  coverage(state, run) {
    const none = run?.ended === true ? 'nothing to check: no creator floor ran on this run' : 'no creator floor has run yet';
    const bag = state.bag.get(BAG_KEY) as Bag | undefined;
    if (bag === undefined || (bag.floors === 0 && bag.touch === null)) return { state: 'not_checked', reason: none };
    if (bag.touch === null) {
      const n = bag.waiting.length + bag.lost;
      return { state: 'not_checked', reason: `no accepted plan has reached the registry yet (${n} creator floor${n === 1 ? '' : 's'} wait for it)` };
    }
    if (bag.touch.source === 'none') {
      return {
        state: 'not_checked',
        reason: bag.touch.fromOldRow
          ? 'no declared scope (the plan declared none, or the engine predates wicked-core-ts 0.7.35 and does not say)'
          : 'no declared scope (the plan declared none)',
      };
    }
    if (bag.touch.truncated) {
      return { state: 'not_checked', reason: `the declared scope was cut at ${TOUCH_CAP} paths, so what lies outside the listed ones cannot be judged` };
    }
    if (bag.floors === 0) return { state: 'not_checked', reason: none };
    if (bag.lost > 0) {
      return { state: 'not_checked', reason: `${bag.lost} creator floor${bag.lost === 1 ? '' : 's'} arrived before the plan and could not be kept` };
    }
    return { state: 'checked' };
  },
  describe: (t) => `When a creator step changes at least ${t.min_paths} path${t.min_paths === 1 ? '' : 's'} outside the plan's declared scope (plan.accepted.touch)`,
};
