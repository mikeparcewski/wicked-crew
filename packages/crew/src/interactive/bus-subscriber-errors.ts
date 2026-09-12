/**
 * Bus subscriber error triage — the visibility half of F-E2E-021.
 *
 * Every wicked-bus seam in the daemon (the interactive relay / draft / edit / demo / chat seams, the
 * project bridge, the QE gate feed) reports its subscriber errors through its `log` option, which
 * `createServer` wires to `app.log.warn`. The `/diagnostics` error ring only folds ERROR-level lines
 * ({@link ../api/diagnostics.ts}), so when six subscribers died with `SQLITE_CORRUPT` and logged it
 * every 2 s for hours, `recentErrors` stayed `[]` and the Health rail stayed green — a dead bus that
 * nothing in the product disclosed.
 *
 * {@link busSubscriberErrorReporter} gives each seam one `onError` that keeps the seam's own warn
 * line for ordinary handler/poll errors and ESCALATES a connection-fatal error — the subscriber's
 * view of the database is gone (`SQLITE_CORRUPT` / `SQLITE_NOTADB` / `SQLITE_IOERR*` from the driver,
 * or wicked-bus's own `WB-014 SUBSCRIBER_DB_UNUSABLE` classification of the same) — to `logError`
 * on the first occurrence and then every {@link ESCALATE_EVERY} consecutive repeats, carrying the
 * count. The outage reaches the ring without the ring becoming the outage's log spam; the warn
 * cadence in between is unchanged, so an operator tailing the log still sees every tick.
 */

/** SQLite result codes that mean the handle's view of the database is unusable, not one failed call. */
export const CONNECTION_FATAL_SQLITE = /^SQLITE_(CORRUPT|NOTADB|IOERR)/;
/** Escalate the 1st, 30th, 60th … consecutive connection-fatal error to `logError` (≈ once a minute at a 2 s poll). */
export const ESCALATE_EVERY = 30;
/** The seams' usual poll cadence; a seam passes its own so the outage window scales with it. */
export const DEFAULT_POLL_INTERVAL_MS = 2000;
/** A fatal error more than this many poll intervals after the previous one starts a NEW outage (the count resets). */
export const NEW_OUTAGE_AFTER_POLLS = 2;

/**
 * Is `err` a connection-fatal bus error — the driver's own code, or wicked-bus's WB-014 wrapper
 * (`error: 'WB-014'` / `code: 'SUBSCRIBER_DB_UNUSABLE'`, with the driver code in `context.sqlite_code`)?
 */
export function isBusConnectionFatal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; error?: unknown; context?: { sqlite_code?: unknown } | null };
  if (e.error === 'WB-014' || e.code === 'SUBSCRIBER_DB_UNUSABLE') return true;
  if (typeof e.code === 'string' && CONNECTION_FATAL_SQLITE.test(e.code)) return true;
  const sqliteCode = e.context?.sqlite_code;
  return typeof sqliteCode === 'string' && CONNECTION_FATAL_SQLITE.test(sqliteCode);
}

/** The slice of a bus event the reporters name (`event_id`); null/undefined on poll errors. */
export interface BusEventRef {
  event_id?: unknown;
}

export interface BusSubscriberErrorReporterOptions {
  /** The seam's own one-line description of an error — its existing warn line, unchanged. */
  describe: (err: Error, event?: BusEventRef | null) => string;
  /** The seam's warn-level logger (every error, every tick). */
  log: (msg: string) => void;
  /** The error-level logger the diagnostics ring folds; falls back to `log` when absent. */
  logError?: ((msg: string) => void) | undefined;
  /**
   * The seam's poll cadence. Consecutive fatal errors arrive one per poll; a fatal error more than
   * {@link NEW_OUTAGE_AFTER_POLLS} intervals after the previous one is a NEW outage and escalates at
   * its 1st again (a good poll never calls `onError`, so the count cannot reset on success itself).
   */
  pollIntervalMs?: number | undefined;
  /** Clock, injectable for tests. */
  now?: (() => number) | undefined;
}

/** The one safe operator action, phrased for the ring; see wicked-bus WB-014 `context.remediation`. */
const REMEDIATION =
  'restart the daemon (its shutdown exits WITHOUT closing bus connections — the safe path; a graceful ' +
  'close of a ghost connection would checkpoint its stale WAL into the file); if `PRAGMA integrity_check` ' +
  'on bus.db fails from a fresh process, the store is torn — restore or rotate it (F-E2E-021)';

/**
 * One `onError` for a wicked-bus `subscribe()`: warn on ordinary errors (the seam's own line),
 * escalate connection-fatal ones to `logError` on the 1st and every {@link ESCALATE_EVERY}th
 * consecutive occurrence, with the running count and what it means for the seam. A poll-side fatal
 * (`event == null`) means the SUBSCRIBER CONNECTION is unusable — the seam receives nothing; a fatal
 * thrown inside the seam's handler (`event != null`) is named as such, since it may be the seam's own
 * store rather than the bus. The count restarts after a quiet stretch (see `pollIntervalMs`).
 */
export function busSubscriberErrorReporter(
  opts: BusSubscriberErrorReporterOptions,
): (err: Error, event?: BusEventRef | null) => void {
  let consecutiveFatal = 0;
  let lastFatalAt: number | null = null;
  const now = opts.now ?? Date.now;
  const newOutageAfterMs = NEW_OUTAGE_AFTER_POLLS * (opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  return (err, event) => {
    const line = opts.describe(err, event);
    if (!isBusConnectionFatal(err)) {
      consecutiveFatal = 0;
      lastFatalAt = null;
      opts.log(line);
      return;
    }
    const at = now();
    if (lastFatalAt !== null && at - lastFatalAt > newOutageAfterMs) consecutiveFatal = 0; // a new outage
    lastFatalAt = at;
    consecutiveFatal += 1;
    const what =
      event === null || event === undefined
        ? `bus subscriber connection UNUSABLE (${consecutiveFatal} consecutive): this seam receives no events`
        : `connection-fatal SQLite error inside the handler for event ${String(event.event_id ?? '?')} ` +
          `(${consecutiveFatal} consecutive): the seam's own store or the bus is unusable`;
    const escalated = `${line} — ${what}; ${REMEDIATION}`;
    if (consecutiveFatal === 1 || consecutiveFatal % ESCALATE_EVERY === 0) {
      (opts.logError ?? opts.log)(escalated);
    } else {
      opts.log(escalated);
    }
  };
}
