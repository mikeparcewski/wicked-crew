// crew 0.15.2 (#916, wicked-core#572) read a seat's two roles separately: `enabled_for_council` (may
// cast a council ballot) and `seat_eligible_for_work` (may be seated for work, engine default TRUE).
// Before it, crew read `enabled_for_council = false` as "off both". So an operator's CUSTOM seat
// written `enabled_for_council = false` with no work flag (a chat-only or helper seat) silently
// became work-eligible on upgrade, and the engine may now seat it on a unit, for example as the
// distinct evaluator of a review. This module names each such seat once, on `GET /health.warnings`
// (`seat.work_default`), `GET /diagnostics.seatGovernance.roleFindings` and `wicked-crew status`.
//
// Only the operator's overlay can say whether the key was WRITTEN: the engine's merged roster has
// already filled the default. So this parses the overlay file itself, the one the engine loads
// (`seatRosterFile`), and folds its `[[cli]]` records by the engine's own rules
// (wicked-council `registry::load`): a record whose key matches an earlier one (a built-in or a
// previous record) inherits that record's `false` for a flag it omits. An unreadable or malformed
// file yields no finding (the engine reports a malformed overlay itself).
//
// Built-in seats never warn: a record whose key is EXACTLY a built-in's overrides it, and an omitted
// flag inherits the built-in's value, so its standing did not change. Keys match exactly, as in the
// engine: `agy#2` in the overlay is a new custom seat, not agy.
import { readFileSync, statSync } from 'node:fs';

import { parse } from 'smol-toml';
import type { HealthWarning } from 'wicked-crew-api-types';

import { seatRosterFile } from './diagnostics.js';

/** The engine's built-in seat keys (wicked-council `registry::builtin`). */
export const BUILTIN_SEAT_KEYS: readonly string[] = ['claude', 'agy', 'codex', 'pi', 'copilot', 'opencode'];

export const SEAT_WORK_DEFAULT_KIND = 'seat.work_default';

/** What the overlay says about one seat's roles, after folding every record with its key. */
export interface OverlaySeatRoles {
  key: string;
  /** The last value a record wrote; `undefined` when none wrote the flag. */
  enabled_for_council: boolean | undefined;
  /** Some record with this key writes `seat_eligible_for_work` (true or false). */
  work_flag_written: boolean;
}

export function isBuiltinSeat(key: string): boolean {
  return BUILTIN_SEAT_KEYS.includes(key);
}

/** The overlay's seats, in first-appearance order, each folded over its records. Throws on a
 *  malformed file (the caller treats that as "nothing to say"). */
export function readOverlaySeatRoles(text: string): OverlaySeatRoles[] {
  const doc = parse(text) as { cli?: unknown };
  const records = Array.isArray(doc.cli) ? doc.cli : [];
  const byKey = new Map<string, OverlaySeatRoles>();
  for (const raw of records) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['key'] !== 'string') continue;
    const prev = byKey.get(r['key']);
    const council = typeof r['enabled_for_council'] === 'boolean' ? r['enabled_for_council'] : prev?.enabled_for_council;
    byKey.set(r['key'], {
      key: r['key'],
      enabled_for_council: council,
      work_flag_written: (prev?.work_flag_written ?? false) || typeof r['seat_eligible_for_work'] === 'boolean',
    });
  }
  return [...byKey.values()];
}

/** One `seat.work_default` warning per custom seat that is council-off with no work flag written. */
export function seatWorkDefaultWarnings(seats: readonly OverlaySeatRoles[]): HealthWarning[] {
  const out: HealthWarning[] = [];
  for (const r of seats) {
    if (isBuiltinSeat(r.key) || r.enabled_for_council !== false || r.work_flag_written) continue;
    out.push({
      kind: SEAT_WORK_DEFAULT_KIND,
      severity: 'warning',
      message:
        `seat ${r.key} is not enabled for council but is now eligible for work (since crew 0.15.2 the two are separate); ` +
        'set seat_eligible_for_work = false to keep it off work',
    });
  }
  return out;
}

let cache: { path: string; mtimeMs: number; size: number; warnings: HealthWarning[] } | null = null;

/** The warnings for the overlay the engine reads now. Re-read when the file changes (one `stat` per
 *  call otherwise), so an edit is reported without a restart; none when there is no overlay. */
export function seatWorkDefaultNow(env: NodeJS.ProcessEnv = process.env): HealthWarning[] {
  const file = seatRosterFile(env);
  if (file === null || !file.present) return [];
  try {
    const st = statSync(file.path);
    if (cache !== null && cache.path === file.path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.warnings;
    }
    let warnings: HealthWarning[];
    try {
      warnings = seatWorkDefaultWarnings(readOverlaySeatRoles(readFileSync(file.path, 'utf8')));
    } catch {
      warnings = []; // malformed: the engine reports the overlay itself; not re-parsed until it changes
    }
    cache = { path: file.path, mtimeMs: st.mtimeMs, size: st.size, warnings };
    return warnings;
  } catch {
    return [];
  }
}
