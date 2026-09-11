/**
 * The roster crew hands the ENGINE (`LaunchOptions.clisJson`) vs the roster crew serves the STUDIO
 * (`GET /roster`) — one seat, two audiences, and the fields must not leak across (wave 6, the crew
 * half of F-7R2-006).
 *
 * `GET /roster` decorates every registry seat with crew's own readings: runtime `health`
 * (`{status: 'active'|'inactive', since, …}` — seat-health.ts), `signed_in`, `auth`,
 * `free_tier(_source)`, `council_eligible` + `council_ineligible_reason` + `council_bench`
 * (seat-standing.ts). The studio's launch form round-trips those seats into `clisJson` verbatim,
 * which was fine while the engine ignored every unknown field — but the wave-6 engine grew its own
 * `AgenticCli.health: Option<SeatHealth {usable: bool, reason?}>` (the launcher's usability verdict
 * that benches a seat for the run). Same key, different shape: a round-tripped crew `health`
 * (`{status: …}`) would fail the engine's deserializer with "missing field `usable`" and refuse the
 * launch. So the boundary translates:
 *
 *  - crew's standing fields are STRIPPED (they are the studio's, not the engine's);
 *  - `council_eligible` becomes the engine's `health`: `false` ⇒ `{usable: false, reason}` — the seat
 *    is BENCHED for the run (never convened, never a failover or judge target, named in
 *    `unitDistributed.degradedReason`); `true` ⇒ `{usable: true}`; absent ⇒ no `health` (unknown —
 *    the engine treats the seat as eligible until it fails authentication in the run);
 *  - a seat that already carries an ENGINE-shaped `health` (`usable` is a boolean) is kept as sent.
 *
 * An engine predating the field ignores `health` (the `AgenticCli` deserializer has no
 * `deny_unknown_fields`), so the stamp is additive there and effective on the wave-6 engine.
 */

/** The crew-only readings `GET /roster` adds to a registry seat — never handed to the engine. */
export const CREW_ONLY_SEAT_FIELDS: ReadonlySet<string> = new Set([
  'health',
  'signed_in',
  'auth',
  'free_tier',
  'free_tier_source',
  'council_eligible',
  'council_ineligible_reason',
  'council_bench',
]);

/** The engine's `AgenticCli.health` (wicked-core `SeatHealth`, wave 6). */
export interface EngineSeatHealth {
  usable: boolean;
  reason?: string;
}

function isEngineHealth(v: unknown): v is EngineSeatHealth {
  return typeof v === 'object' && v !== null && typeof (v as { usable?: unknown }).usable === 'boolean';
}

/**
 * The SHORT bench reason the engine renders inline — `"codex (signed out — launcher)"` in
 * `unitDistributed.degradedReason` — derived from the standing readings themselves (seat-standing.ts
 * `seatStanding` decides `council_eligible`; this names the one cause in two or three words), falling
 * back to the first clause of `council_ineligible_reason` for a cause this table does not know.
 */
export function shortBenchReason(seat: Record<string, unknown>): string | undefined {
  if (seat['enabled_for_council'] === false) return 'not enabled for council';
  if (seat['auth'] === 'signed_out') return 'signed out';
  const health = seat['health'];
  if (typeof health === 'object' && health !== null && (health as { status?: unknown }).status === 'inactive') {
    return 'inactive after a seat-level error';
  }
  const bench = seat['council_bench'];
  if (typeof bench === 'object' && bench !== null) {
    const b = bench as { failures?: unknown; last_kind?: unknown };
    const kind = typeof b.last_kind === 'string' ? b.last_kind.replace(/_/g, ' ') : 'ballot failures';
    const n = typeof b.failures === 'number' ? `${b.failures} ` : '';
    return `benched by recent councils (${n}${kind})`;
  }
  const verbose = seat['council_ineligible_reason'];
  if (typeof verbose === 'string' && verbose.trim() !== '') {
    return verbose.split(/\s+—\s+|;\s+/, 1)[0]!.trim().slice(0, 80);
  }
  return undefined;
}

/** One seat translated for the engine (see the module doc). Non-object entries pass through so the
 *  engine reports its own parse error rather than crew inventing one. */
export function toEngineSeat(seat: unknown): unknown {
  if (typeof seat !== 'object' || seat === null || Array.isArray(seat)) return seat;
  const s = seat as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!CREW_ONLY_SEAT_FIELDS.has(k)) out[k] = v;
  }
  if (isEngineHealth(s['health'])) out['health'] = s['health'];
  if (s['council_eligible'] === false) {
    const reason = shortBenchReason(s);
    out['health'] = {
      usable: false,
      ...(reason !== undefined ? { reason } : {}),
    } satisfies EngineSeatHealth;
  } else if (s['council_eligible'] === true) {
    out['health'] = { usable: true } satisfies EngineSeatHealth;
  }
  return out;
}

/** Translate a whole roster. */
export function toEngineRoster(seats: readonly unknown[]): unknown[] {
  return seats.map(toEngineSeat);
}

/**
 * Translate a `clisJson` string for the engine. A string that does not parse to a JSON array is
 * returned UNCHANGED — the engine's own "invalid clisJson" refusal is the honest answer, not a
 * crew-side rewrite of something crew could not read.
 */
export function engineRosterJson(clisJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(clisJson);
  } catch {
    return clisJson;
  }
  if (!Array.isArray(parsed)) return clisJson;
  return JSON.stringify(toEngineRoster(parsed));
}

/** The seat keys of a roster the ENGINE would convene — every seat not benched by its `health`. */
export function eligibleSeatKeys(seats: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const seat of toEngineRoster(seats)) {
    if (typeof seat !== 'object' || seat === null) continue;
    const s = seat as { key?: unknown; health?: unknown; enabled_for_council?: unknown };
    if (typeof s.key !== 'string') continue;
    if (s.enabled_for_council === false) continue;
    if (isEngineHealth(s.health) && !s.health.usable) continue;
    out.push(s.key);
  }
  return out;
}
