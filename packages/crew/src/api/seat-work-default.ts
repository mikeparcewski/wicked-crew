// crew 0.15.2 (#916, wicked-core#572) read a seat's two roles separately: `enabled_for_council` (may
// cast a council ballot) and `seat_eligible_for_work` (may be seated for work, engine default TRUE).
// Before it, crew read `enabled_for_council = false` as "off both". So an operator's CUSTOM seat
// written `enabled_for_council = false` with no work flag (a chat-only or helper seat) silently
// became work-eligible on upgrade, and the engine may now seat it on a unit, for example as the
// distinct evaluator of a review. This module names each such seat once, on `GET /health.warnings`
// (`seat.work_default`), `GET /diagnostics.seatGovernance.roleFindings` and `wicked-crew status`.
//
// Only the operator's overlay can say whether the key was WRITTEN: the engine's merged roster has
// already filled the default. So this reads the overlay file itself, the one the engine loads
// (`seatRosterFile`), and only the parts it needs: each top-level `[[cli]]` record's `key`,
// `enabled_for_council`, and whether `seat_eligible_for_work` is present. It is a line reader for
// the registry's documented shape, not a TOML parser: keys inside a sub-table (`[cli.acp]`) and
// multi-line strings are skipped, and a record written in another TOML form (an inline table, a
// dotted `cli.` key) is not read. An unreadable file yields no finding (the engine reports a
// malformed overlay itself).
//
// Built-in seats never warn: a record whose key is a built-in's overrides it, and an omitted flag
// inherits the built-in's value (wicked-council `registry::load`), so its standing did not change.
import { readFileSync, statSync } from 'node:fs';

import type { HealthWarning } from 'wicked-crew-api-types';

import { seatRosterFile } from './diagnostics.js';

/** The engine's built-in seat keys (wicked-council `registry::builtin`). An instance
 *  (`claude#2`) is its CLI's. */
export const BUILTIN_SEAT_KEYS: readonly string[] = ['claude', 'agy', 'codex', 'pi', 'copilot', 'opencode'];

export const SEAT_WORK_DEFAULT_KIND = 'seat.work_default';

/** What one `[[cli]]` record of the overlay says about its roles. */
export interface OverlaySeatRoles {
  key: string;
  /** `undefined` when the record does not write the flag. */
  enabled_for_council: boolean | undefined;
  /** The record writes `seat_eligible_for_work` (true or false). */
  work_flag_written: boolean;
}

export function isBuiltinSeat(key: string): boolean {
  return BUILTIN_SEAT_KEYS.includes(key.split('#')[0] ?? key);
}

const HEADER = /^\s*\[\[\s*cli\s*\]\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;
const assignment = (name: string): RegExp => new RegExp(`^\\s*(?:${name}|"${name}"|'${name}')\\s*=\\s*(.*)$`);
const KEY = assignment('key');
const COUNCIL = assignment('enabled_for_council');
const WORK = assignment('seat_eligible_for_work');

/** The value of a basic or literal TOML string at the start of `rest`, or `null`. */
function stringValue(rest: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(rest.trim());
  if (m === null) return null;
  return m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : (m[2] ?? null);
}

function boolValue(rest: string): boolean | undefined {
  const m = /^(true|false)\s*(#.*)?$/.exec(rest.trim());
  return m === null ? undefined : m[1] === 'true';
}

/** The `[[cli]]` records of an overlay's text, in file order (see the module doc for the subset). */
export function readOverlaySeatRoles(text: string): OverlaySeatRoles[] {
  const out: OverlaySeatRoles[] = [];
  let current: { key: string | null; council: boolean | undefined; work: boolean } | null = null;
  let inSubTable = false;
  let openQuote: '"""' | "'''" | null = null;
  const close = (): void => {
    if (current !== null && current.key !== null) {
      out.push({ key: current.key, enabled_for_council: current.council, work_flag_written: current.work });
    }
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (openQuote !== null) {
      if (line.split(openQuote).length % 2 === 0) openQuote = null;
      continue;
    }
    for (const q of ['"""', "'''"] as const) {
      if (line.split(q).length % 2 === 0) openQuote = q;
    }
    if (HEADER.test(line)) {
      close();
      current = { key: null, council: undefined, work: false };
      inSubTable = false;
      continue;
    }
    if (ANY_TABLE.test(line)) {
      // `[cli.acp]` belongs to the record above it, but its keys are not the record's; any other
      // table header ends the record.
      if (!/^\s*\[\s*cli\./.test(line)) close();
      inSubTable = true;
      continue;
    }
    if (current === null || inSubTable) continue;
    const rec: { key: string | null; council: boolean | undefined; work: boolean } = current;
    const k = KEY.exec(line);
    if (k !== null) {
      rec.key = stringValue(k[1] ?? '');
      continue;
    }
    const c = COUNCIL.exec(line);
    if (c !== null) {
      rec.council = boolValue(c[1] ?? '');
      continue;
    }
    if (WORK.test(line)) rec.work = true;
  }
  close();
  return out;
}

/** One `seat.work_default` warning per custom seat that is council-off with no work flag written.
 *  A key the overlay writes twice is judged by its last record (the engine's merge keeps the last). */
export function seatWorkDefaultWarnings(records: readonly OverlaySeatRoles[]): HealthWarning[] {
  const byKey = new Map<string, OverlaySeatRoles>();
  for (const r of records) {
    byKey.delete(r.key);
    byKey.set(r.key, r);
  }
  const out: HealthWarning[] = [];
  for (const r of byKey.values()) {
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
    const warnings = seatWorkDefaultWarnings(readOverlaySeatRoles(readFileSync(file.path, 'utf8')));
    cache = { path: file.path, mtimeMs: st.mtimeMs, size: st.size, warnings };
    return warnings;
  } catch {
    return [];
  }
}
