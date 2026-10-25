// crew#1071: a seat's recent bench, kept on the daemon's audit trail so it survives a restart.
//
// `SeatHealthTracker` folds the engine's `seatBenched` frames into an in-memory bench that keeps the
// seat out of new launches and asks until its lift time (J4: `benchUntil`). The boot replay re-reads only LIVE
// runs' events, and a quota failure normally ends its run (cancelled or failed), so after a restart
// the seat read Ready and the next ask was seated on it alone and got the same 429. Each bench and
// each early lift is now one audit entry; the boot reads the window's entries back.

import type { Actor, AuditEntry } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { SEAT_BENCH_MAX_MS, type SeatBenchEntry, type SeatBenchStore } from './seat-health.js';

/** The audit action of a bench the engine recorded in a run. */
export const SEAT_BENCHED_ACTION = 'seat.benched';
/** The audit action of a bench lifted before its window ran out (an ok turn, a live sign-in). */
export const SEAT_BENCH_LIFTED_ACTION = 'seat.bench_lifted';

const DAEMON: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };

/** The store the tracker writes through: one audit entry per bench and per lift. */
export function auditSeatBenchStore(audit: AuditLog): SeatBenchStore {
  return {
    benched: (cli, rec) => {
      audit.record(SEAT_BENCHED_ACTION, DAEMON, {
        ...(rec.session !== undefined ? { runId: rec.session } : {}),
        detail: {
          cli,
          at: rec.at,
          reason: rec.reason,
          source: rec.source,
          runs: rec.runs,
          ...(rec.until !== undefined ? { until: rec.until } : {}),
          ...(rec.untilSource !== undefined ? { untilSource: rec.untilSource } : {}),
          ...(rec.strikes !== undefined ? { strikes: rec.strikes } : {}),
        },
      });
    },
    lifted: (cli, atMs) => {
      audit.record(SEAT_BENCH_LIFTED_ACTION, DAEMON, { detail: { cli, at: atMs } });
    },
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** One trail entry as a bench entry, or `null` when it is not one this module wrote. */
export function benchEntryOf(e: AuditEntry): SeatBenchEntry | null {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const cli = text(d['cli']);
  const at = num(d['at']) ?? e.ts;
  if (cli === undefined) return null;
  if (e.action === SEAT_BENCH_LIFTED_ACTION) return { kind: 'lifted', cli, at };
  if (e.action !== SEAT_BENCHED_ACTION) return null;
  const reason = text(d['reason']);
  const source = text(d['source']);
  if (reason === undefined || source === undefined) return null;
  const until = num(d['until']);
  const untilSource = text(d['untilSource']);
  const strikes = num(d['strikes']);
  return {
    kind: 'benched',
    cli,
    rec: {
      at,
      reason,
      source,
      runs: num(d['runs']) ?? 1,
      ...(typeof e.runId === 'string' ? { session: e.runId } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(untilSource === 'engine' || untilSource === 'backoff' || untilSource === 'window' ? { untilSource } : {}),
      ...(strikes !== undefined ? { strikes } : {}),
    },
  };
}

/** The bench entries a live bench may still stand on, in append order (the audit `ts` is never earlier than the bench
 *  itself): (J4) a bench lifts at its own time, up to {@link SEAT_BENCH_MAX_MS} out, and the latest
 *  quota bench's strikes outlive its lift until a good turn. */
export async function readSeatBenchEntries(audit: AuditLog, nowMs = Date.now()): Promise<SeatBenchEntry[]> {
  const since = nowMs - SEAT_BENCH_MAX_MS;
  // One read, back in APPEND order (the trail answers newest first): the boot folds the entries in
  // the order the tracker wrote them, so two records of one millisecond keep their real order.
  const entries = (await audit.readAll({ since }))
    .filter((e) => e.action === SEAT_BENCHED_ACTION || e.action === SEAT_BENCH_LIFTED_ACTION)
    .reverse();
  return entries.map(benchEntryOf).filter((e): e is SeatBenchEntry => e !== null);
}
