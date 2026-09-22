// F-E2E-021 (visibility half) — a dead bus subscriber connection must reach the diagnostics error
// ring. The seams log through `log` (warn); the ring folds ERROR-level lines only. The reporter keeps
// every seam's own warn line for ordinary errors and escalates connection-fatal ones to `logError`
// on the 1st and every ESCALATE_EVERY-th consecutive repeat, with the count; a fatal error more than
// NEW_OUTAGE_AFTER_POLLS poll intervals after the previous one is a new outage (count restarts).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLL_INTERVAL_MS,
  ESCALATE_EVERY,
  NEW_OUTAGE_AFTER_POLLS,
  busSubscriberErrorReporter,
  isBusConnectionFatal,
} from '../src/interactive/bus-subscriber-errors.js';
import { ErrorRing, teeStreamWithErrorRing } from '../src/api/diagnostics.js';

function sqliteError(code: string, message = 'database disk image is malformed'): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** The shape wicked-bus's `WBError('WB-014', 'SUBSCRIBER_DB_UNUSABLE', context)` has on the wire. */
function wb014(): Error {
  const err = new Error('subscriber x cannot read the bus db (SQLITE_CORRUPT: database disk image is malformed)') as Error & {
    error: string;
    code: string;
    context: Record<string, unknown>;
  };
  err.error = 'WB-014';
  err.code = 'SUBSCRIBER_DB_UNUSABLE';
  err.context = { sqlite_code: 'SQLITE_CORRUPT', consecutive: 1 };
  return err;
}

describe('isBusConnectionFatal', () => {
  it('recognises the driver codes that mean the handle is dead', () => {
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_IOERR', 'SQLITE_IOERR_READ', 'SQLITE_IOERR_SHMMAP']) {
      expect(isBusConnectionFatal(sqliteError(code)), code).toBe(true);
    }
  });
  it('recognises wicked-bus WB-014 by error code, by name, and by the driver code in its context', () => {
    expect(isBusConnectionFatal(wb014())).toBe(true);
    expect(isBusConnectionFatal({ code: 'SUBSCRIBER_DB_UNUSABLE' })).toBe(true);
    expect(isBusConnectionFatal({ context: { sqlite_code: 'SQLITE_NOTADB' } })).toBe(true);
  });
  it('leaves ordinary errors alone', () => {
    expect(isBusConnectionFatal(sqliteError('SQLITE_BUSY', 'database is locked'))).toBe(false);
    expect(isBusConnectionFatal(new Error('handler threw'))).toBe(false);
    expect(isBusConnectionFatal({ error: 'WB-003', code: 'CURSOR_BEHIND_TTL_WINDOW' })).toBe(false);
    expect(isBusConnectionFatal(null)).toBe(false);
    expect(isBusConnectionFatal('SQLITE_CORRUPT')).toBe(false);
  });
});

describe('busSubscriberErrorReporter', () => {
  const describeLine = (err: Error, event?: { event_id?: unknown } | null): string =>
    `[seam] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`;

  it('keeps the seam warn line, verbatim, for ordinary errors and never escalates them', () => {
    const warn: string[] = [];
    const error: string[] = [];
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m), logError: (m) => error.push(m) });
    onError(new Error('handler threw'), { event_id: 7 });
    onError(sqliteError('SQLITE_BUSY', 'database is locked'), null);
    expect(warn).toEqual([
      '[seam] handler error on event 7: handler threw',
      '[seam] handler error on event ?: database is locked',
    ]);
    expect(error).toEqual([]);
  });

  it('escalates a poll-side connection-fatal error to logError on the 1st and every ESCALATE_EVERY-th consecutive repeat, warn in between, with the count and the torn-store remediation', () => {
    const warn: string[] = [];
    const error: string[] = [];
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m), logError: (m) => error.push(m) });
    for (let i = 0; i < ESCALATE_EVERY * 2; i++) onError(sqliteError('SQLITE_CORRUPT'), null);
    expect(error).toHaveLength(3);
    expect(error[0]).toContain('[seam] handler error on event ?: database disk image is malformed');
    expect(error[0]).toContain('bus subscriber connection UNUSABLE (1 consecutive)');
    expect(error[0]).toContain('this seam receives no events');
    expect(error[1]).toContain(`UNUSABLE (${ESCALATE_EVERY} consecutive)`);
    expect(error[2]).toContain(`UNUSABLE (${ESCALATE_EVERY * 2} consecutive)`);
    // the remediation names the safe action AND the torn-store case, never a reopen
    expect(error[0]).toMatch(/restart the daemon/);
    expect(error[0]).toMatch(/exits WITHOUT closing bus connections/);
    expect(error[0]).toMatch(/PRAGMA integrity_check/);
    expect(error[0]).toMatch(/the store is torn/);
    expect(error[0]).not.toMatch(/reopen/);
    expect(error[0]).toMatch(/F-E2E-021/);
    expect(warn).toHaveLength(ESCALATE_EVERY * 2 - 3);
    expect(warn[0]).toContain('UNUSABLE (2 consecutive)');
  });

  it('names a connection-fatal error thrown inside the handler (event present) as such, still error-level on the 1st', () => {
    const warn: string[] = [];
    const error: string[] = [];
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m), logError: (m) => error.push(m) });
    onError(sqliteError('SQLITE_NOTADB', 'file is not a database'), { event_id: 9 });
    expect(error).toHaveLength(1);
    expect(error[0]).toContain('[seam] handler error on event 9: file is not a database');
    expect(error[0]).toContain('connection-fatal SQLite error inside the handler for event 9 (1 consecutive)');
    expect(error[0]).toContain("the seam's own store or the bus is unusable");
    expect(error[0]).not.toContain('receives no events');
    expect(warn).toEqual([]);
  });

  it('treats wicked-bus WB-014 like the driver code and resets the count after an ordinary error', () => {
    const warn: string[] = [];
    const error: string[] = [];
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m), logError: (m) => error.push(m) });
    onError(wb014(), null);
    onError(wb014(), null);
    onError(new Error('handler threw'), { event_id: 1 }); // the connection is back, a handler failed
    onError(wb014(), null); // a fresh outage starts a fresh count → escalates again
    expect(error).toHaveLength(2);
    expect(error[0]).toContain('(1 consecutive)');
    expect(error[1]).toContain('(1 consecutive)');
    expect(warn).toEqual([
      expect.stringContaining('(2 consecutive)'),
      '[seam] handler error on event 1: handler threw',
    ]);
  });

  it('a second outage after a quiet recovery escalates at its 1st error again (time-based reset via the last fatal)', () => {
    const warn: string[] = [];
    const error: string[] = [];
    let clock = 1_000_000;
    const pollIntervalMs = 2000;
    const onError = busSubscriberErrorReporter({
      describe: describeLine,
      log: (m) => warn.push(m),
      logError: (m) => error.push(m),
      pollIntervalMs,
      now: () => clock,
    });
    // outage 1: three consecutive polls, one interval apart — one escalation, count climbs
    onError(sqliteError('SQLITE_IOERR_READ', 'disk I/O error'), null);
    clock += pollIntervalMs;
    onError(sqliteError('SQLITE_IOERR_READ', 'disk I/O error'), null);
    clock += pollIntervalMs;
    onError(sqliteError('SQLITE_IOERR_READ', 'disk I/O error'), null);
    expect(error).toHaveLength(1);
    expect(warn.map((l) => l.match(/\((\d+) consecutive\)/)?.[1])).toEqual(['2', '3']);
    // exactly the boundary (NEW_OUTAGE_AFTER_POLLS intervals) still counts as the same outage
    clock += NEW_OUTAGE_AFTER_POLLS * pollIntervalMs;
    onError(sqliteError('SQLITE_IOERR_READ', 'disk I/O error'), null);
    expect(error).toHaveLength(1);
    expect(warn[warn.length - 1]).toContain('(4 consecutive)');
    // hours of healthy polls (onError is never called on a good poll), then a new outage
    clock += 3 * 60 * 60 * 1000;
    onError(sqliteError('SQLITE_CORRUPT'), null);
    expect(error).toHaveLength(2);
    expect(error[1]).toContain('UNUSABLE (1 consecutive)');
  });

  it('uses the default poll interval when a seam passes none', () => {
    const warn: string[] = [];
    const error: string[] = [];
    let clock = 0;
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m), logError: (m) => error.push(m), now: () => clock });
    onError(sqliteError('SQLITE_CORRUPT'), null);
    clock += NEW_OUTAGE_AFTER_POLLS * DEFAULT_POLL_INTERVAL_MS + 1;
    onError(sqliteError('SQLITE_CORRUPT'), null);
    expect(error).toHaveLength(2);
    expect(error[1]).toContain('(1 consecutive)');
    expect(warn).toEqual([]);
  });

  it('falls back to log when no logError is wired (a seam started without the daemon logger)', () => {
    const warn: string[] = [];
    const onError = busSubscriberErrorReporter({ describe: describeLine, log: (m) => warn.push(m) });
    onError(sqliteError('SQLITE_NOTADB', 'file is not a database'), null);
    expect(warn).toEqual([expect.stringContaining('UNUSABLE (1 consecutive)')]);
  });

  it('what logError feeds lands in the /diagnostics error ring; what log feeds does not', () => {
    // The daemon wires `log` → app.log.warn (level 40) and `logError` → app.log.error (level 50);
    // the ring keeps level ≥ 50 only. Drive the tee with the pino line shapes those calls produce.
    const ring = new ErrorRing();
    const tee = teeStreamWithErrorRing(ring, { write: () => undefined });
    const pinoLine = (level: number, msg: string): string => `${JSON.stringify({ level, time: 1, msg })}\n`;
    const onError = busSubscriberErrorReporter({
      describe: describeLine,
      log: (m) => tee.write(pinoLine(40, m)),
      logError: (m) => tee.write(pinoLine(50, m)),
    });
    onError(new Error('handler threw'), { event_id: 3 });
    onError(sqliteError('SQLITE_CORRUPT'), null);
    onError(sqliteError('SQLITE_CORRUPT'), null);
    const lines = ring.list().map((e) => e.line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bus subscriber connection UNUSABLE (1 consecutive)');
  });
});
