/**
 * The seat record: each seat's week, folded from the runs' durable event logs (studio's weekly
 * 1:1 per agent). `GET /roster/record?days=7`.
 *
 * Nothing new is stored. The fold reads what the engine already records per run:
 *
 * - who ran a unit: `unitDistributed.cli`, moved by `unitReassigned.newCli`; a unit no frame
 *   names falls back to the unit row's `assigned_cli`;
 * - units run: the distinct units a seat was dispatched on (`unitDispatched`) inside the window;
 * - first pass: the unit's FIRST `gateEvaluated` in the window passed (`combined` and no `denial`);
 *   `gated` is how many units had a gate evaluation at all;
 * - rework: a unit dispatched more than once (a retry or a send-back) or given a
 *   `unitReworkAmended`, counted against the seat that ran its first dispatch;
 * - stalls: distinct units that went quiet (`workerStalled`, the engine's or the daemon
 *   watchdog's), against the seat running the unit then;
 * - benched: runs whose `benched_seats` names the seat, with the reasons;
 * - cost: the sum of `cliUsage.costUsd` where a price was known; `null` when none was.
 *
 * The window is by event time (`ts`, millis). A run that ended before the window opened is not
 * read at all; the reads are capped at {@link SEAT_RECORD_RUN_CAP} runs, newest first, and the
 * answer says when the cap cut.
 */

import type {
  BenchedSeat,
  RecordedEvent,
  SeatPhaseRecord,
  SeatRecord,
  SeatRecordResponse,
  SessionView,
} from '../core/types.js';

export const SEAT_RECORD_DEFAULT_DAYS = 7;
export const SEAT_RECORD_MAX_DAYS = 30;
export const SEAT_RECORD_RUN_CAP = 200;

type Frame = RecordedEvent & Record<string, unknown>;

const emptyPhase = (): SeatPhaseRecord => ({ units: 0, gated: 0, firstPass: 0, rework: 0, stalls: 0 });

function emptySeat(cli: string): SeatRecord {
  return { cli, units: 0, gated: 0, firstPass: 0, rework: 0, stalls: 0, benched: 0, benchReasons: {}, costUsd: null, costedUsage: 0, byPhase: {} };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Whether a run can have any event inside the window: it ended in it, or has not ended. */
export function runTouchesWindow(view: SessionView, since: number): boolean {
  const endedSec = num(view.session.ended_at);
  if (endedSec !== undefined) return endedSec * 1000 >= since;
  const finished = num(view.session.finished_at);
  if (finished !== undefined) return finished >= since;
  return true;
}

/** Fold one run's events into the seat map. `since` is the window start, unix millis. */
export function foldRunIntoSeats(
  seats: Map<string, SeatRecord>,
  view: SessionView,
  events: readonly RecordedEvent[],
  since: number,
): void {
  const seat = (cli: string): SeatRecord => {
    let s = seats.get(cli);
    if (s === undefined) { s = emptySeat(cli); seats.set(cli, s); }
    return s;
  };
  const unitRow = new Map(view.units.map((u) => [u.ord, u]));
  const phaseOf = (ord: number): string => {
    const u = unitRow.get(ord);
    return str(u?.phase_ref) ?? str(u?.stage) ?? 'unit';
  };
  const phase = (s: SeatRecord, ord: number): SeatPhaseRecord => {
    const key = phaseOf(ord);
    let p = s.byPhase[key];
    if (p === undefined) { p = emptyPhase(); s.byPhase[key] = p; }
    return p;
  };

  const owner = new Map<number, string>();
  const ownerOf = (ord: number): string | undefined => owner.get(ord) ?? str(unitRow.get(ord)?.assigned_cli) ?? undefined;
  const ranBy = new Map<number, Set<string>>();
  const firstBy = new Map<number, string>();
  const dispatches = new Map<number, number>();
  const amended = new Set<number>();
  const gatedOnce = new Set<number>();
  const stalled = new Set<string>();
  let touched = false;

  const sorted = [...events].sort((a, b) => (a.ts - b.ts) || ((num(a.seq) ?? 0) - (num(b.seq) ?? 0)));
  for (const raw of sorted) {
    const e = raw as Frame;
    const ord = num(e['ord']);
    const inWindow = e.ts >= since;
    if (inWindow) touched = true;
    // Ownership is tracked from the whole log (a unit distributed before the window may run in it).
    if (e.type === 'unitDistributed' && ord !== undefined && str(e['cli']) !== undefined) {
      owner.set(ord, e['cli'] as string);
      continue;
    }
    if (e.type === 'unitReassigned' && ord !== undefined) {
      const next = str(e['newCli']);
      if (next !== undefined) owner.set(ord, next);
      continue;
    }
    if (!inWindow || ord === undefined) continue;
    const cli = ownerOf(ord);
    switch (e.type) {
      case 'unitDispatched': {
        if (cli === undefined) break;
        dispatches.set(ord, (dispatches.get(ord) ?? 0) + 1);
        if (!firstBy.has(ord)) firstBy.set(ord, cli);
        let set = ranBy.get(ord);
        if (set === undefined) { set = new Set(); ranBy.set(ord, set); }
        if (!set.has(cli)) {
          set.add(cli);
          const s = seat(cli);
          s.units += 1;
          phase(s, ord).units += 1;
        }
        break;
      }
      case 'gateEvaluated': {
        if (cli === undefined || gatedOnce.has(ord)) break;
        gatedOnce.add(ord);
        const s = seat(cli);
        const p = phase(s, ord);
        s.gated += 1;
        p.gated += 1;
        if (e['combined'] === true && (e['denial'] ?? null) === null) {
          s.firstPass += 1;
          p.firstPass += 1;
        }
        break;
      }
      case 'unitReworkAmended':
        amended.add(ord);
        break;
      case 'workerStalled': {
        if (cli === undefined) break;
        const key = `${cli}\u0000${ord}`;
        if (stalled.has(key)) break;
        stalled.add(key);
        const s = seat(cli);
        s.stalls += 1;
        phase(s, ord).stalls += 1;
        break;
      }
      case 'cliUsage': {
        if (cli === undefined) break;
        const s = seat(cli);
        const cost = num(e['costUsd']);
        if (cost !== undefined) {
          s.costUsd = (s.costUsd ?? 0) + cost;
          s.costedUsage += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  // Rework: a unit sent back or retried, against the seat that ran it first.
  for (const [ord, first] of firstBy) {
    if ((dispatches.get(ord) ?? 0) > 1 || amended.has(ord)) {
      const s = seat(first);
      s.rework += 1;
      phase(s, ord).rework += 1;
    }
  }

  // Benched: the run's own record of the seats it never convened (no time on it, so a run counts
  // only when it has an event inside the window).
  if (touched) {
    const benched: readonly BenchedSeat[] = view.session.benched_seats ?? [];
    const seen = new Set<string>();
    for (const b of benched) {
      if (typeof b?.cli !== 'string' || seen.has(b.cli)) continue;
      seen.add(b.cli);
      const s = seat(b.cli);
      s.benched += 1;
      const reason = str(b.reason) ?? 'benched';
      s.benchReasons[reason] = (s.benchReasons[reason] ?? 0) + 1;
    }
  }
}

/** Round a summed cost to cents' hundredths so float dust never reaches the wire. */
function tidy(s: SeatRecord): SeatRecord {
  return s.costUsd === null ? s : { ...s, costUsd: Math.round(s.costUsd * 10_000) / 10_000 };
}

/**
 * The whole read: pick the runs that can touch the window (newest first, capped), read each log,
 * fold. `readEvents` answers `null` when the engine has no event-log binding — the caller turns
 * that into a 503 (a missing binding is not an empty week).
 */
export async function seatRecord(
  views: readonly SessionView[],
  readEvents: (runId: string) => Promise<readonly RecordedEvent[] | null>,
  opts: { days: number; now: number },
): Promise<SeatRecordResponse | null> {
  const since = opts.now - opts.days * 86_400_000;
  const candidates = views
    .filter((v) => runTouchesWindow(v, since))
    // Newest launch first; an undated run (no `run.launched` record) sorts LAST, so a pile of
    // pre-field runs can never crowd a dated run out of the cap. Ties by id, for a stable read.
    .sort((a, b) =>
      ((num(b.session.created_at) ?? -Infinity) - (num(a.session.created_at) ?? -Infinity)) ||
      a.session.id.localeCompare(b.session.id));
  const read = candidates.slice(0, SEAT_RECORD_RUN_CAP);
  const seats = new Map<string, SeatRecord>();
  for (const v of read) {
    const events = await readEvents(v.session.id);
    if (events === null) return null;
    foldRunIntoSeats(seats, v, events, since);
  }
  return {
    days: opts.days,
    since,
    until: opts.now,
    runsRead: read.length,
    truncated: candidates.length > read.length,
    seats: [...seats.values()].sort((a, b) => a.cli.localeCompare(b.cli)).map(tidy),
  };
}
