// crew#1071: a seat's recent bench, kept on the daemon's audit trail so it survives a restart.
//
// `SeatHealthTracker` folds the engine's `seatBenched` frames into an in-memory bench that keeps the
// seat out of new launches and asks for SEAT_BENCH_WINDOW_MS. The boot replay re-reads only LIVE
// runs' events, and a quota failure normally ends its run (cancelled or failed), so after a restart
// the seat read Ready and the next ask was seated on it alone and got the same 429. Each bench and
// each early lift is now one audit entry; the boot reads the window's entries back.

import type { Actor, AuditEntry } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { SEAT_BENCH_WINDOW_MS, type SeatBenchEntry, type SeatBenchStore } from './seat-health.js';

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
        detail: { cli, at: rec.at, reason: rec.reason, source: rec.source, runs: rec.runs },
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
  return {
    kind: 'benched',
    cli,
    rec: {
      at,
      reason,
      source,
      runs: num(d['runs']) ?? 1,
      ...(typeof e.runId === 'string' ? { session: e.runId } : {}),
    },
  };
}

/** The bench entries of the last window (the audit `ts` is never earlier than the bench itself). */
export async function readSeatBenchEntries(audit: AuditLog, nowMs = Date.now()): Promise<SeatBenchEntry[]> {
  const since = nowMs - SEAT_BENCH_WINDOW_MS;
  const entries = [
    ...(await audit.readAll({ action: SEAT_BENCHED_ACTION, since })),
    ...(await audit.readAll({ action: SEAT_BENCH_LIFTED_ACTION, since })),
  ];
  return entries.map(benchEntryOf).filter((e): e is SeatBenchEntry => e !== null);
}
