/**
 * THE CREW BUS TAP (crew#679) — the one way in-daemon crew code reads the bus.
 *
 * The daemon's bus file is the engine's too (DES-TEAMING-002 T0): the engine writes it through its
 * bundled SQLite, crew holds it through better-sqlite3. Two SQLite copies in one process do not see
 * each other's POSIX locks (sqlite.org/howtocorrupt.html §2.2.1), so a crew WRITE concurrent with an
 * engine write corrupts the file. A wicked-bus `subscribe` writes: it registers a subscription, acks
 * a durable cursor per row, and records delivery attempts and dead letters. crew#676 took the team
 * relay off it; this module takes every other seam off it too.
 *
 * A tap polls through crew's one long-lived bus handle (`core/bus-handle.ts`, never closed) with its
 * cursor in memory, starting at the newest row (`latest`, what every seam asked wicked-bus for), and
 * issues no write. Rows are matched with wicked-bus's own `matchesFilter`, so a filter means what it
 * meant under `subscribe`. What a restart loses is what `latest` + `maxRetries: 0` never promised:
 * rows emitted while the daemon was down, and a retry of a failed handler.
 *
 * Crew's bus WRITES go through the one bus writer instead (`core/bus-writer.ts`).
 * tests/bus-no-write.test.ts fails the build if in-daemon code calls subscribe/ack/register/emit.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, matchesFilter, resolveDbPath, type BusEvent } from 'wicked-bus';

import { crewBusHandle, type BusSqlite } from './bus-handle.js';

/** Rows per poll: a burst drains over a few polls instead of one unbounded read. */
const BATCH = 500;

export interface BusTapOptions {
  /** The bus db; omit for wicked-bus's own resolution (honors WICKED_BUS_DATA_DIR). */
  dbPath?: string | undefined;
  /** A wicked-bus filter (`wicked.interactive.**`, `wicked.qe.*`, …). */
  filter: string;
  /** Poll cadence, ms. */
  pollIntervalMs?: number | undefined;
  /** Called once per matching row, in order; awaited before the next row. */
  handler: (event: BusEvent) => void | Promise<void>;
  /** A failed read (`event` null) or a failed handler (the row). Never retried; the cursor moves on. */
  onError?: ((err: Error, event?: BusEvent | null) => void) | undefined;
}

export interface BusTap {
  /** The bus file this tap reads. */
  readonly dbPath: string;
  /** Stop polling; resolves once an in-flight handler has returned. */
  stop(): Promise<void>;
}

/** The bus file a seam option names: explicit, else wicked-bus's own default resolution. */
export function resolveBusDbPath(dbPath?: string): string {
  return dbPath !== undefined ? dbPath : resolveDbPath(loadConfig({}));
}

/**
 * Open crew's handle on the bus a seam names (creating the file when it is not there yet, as the
 * daemon's boot probe does: a file that does not exist is a file no engine holds) and return the
 * resolved path. Throws when it cannot be opened — the seam logs and disables itself.
 */
export function openCrewBus(dbPath?: string): string {
  const path = resolveBusDbPath(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  crewBusHandle(path, { create: true });
  return path;
}

/** The table does not exist yet: nothing has ever been emitted on this file. */
function noEventsTable(err: unknown): boolean {
  return err instanceof Error && /no such table: events/.test(err.message);
}

/**
 * Arm a tap. Throws when the bus file cannot be opened (the caller logs and disables its seam);
 * after that, read failures go to `onError` and the next poll retries.
 */
export function tapBus(opts: BusTapOptions): BusTap {
  const dbPath = openCrewBus(opts.dbPath);
  let db: BusSqlite = crewBusHandle(dbPath, { create: false });
  const newest = (): number => {
    try {
      return (db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').all()[0] as { m: number }).m;
    } catch (err) {
      if (noEventsTable(err)) return 0; // no row yet: every future row is new
      throw err;
    }
  };
  let cursor = newest();
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const report = (err: unknown, event: BusEvent | null): void => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)), event);
  };

  const poll = async (): Promise<void> => {
    let rows: Array<Record<string, unknown> & { event_id: number; event_type: string; domain: string }>;
    try {
      db = crewBusHandle(dbPath, { create: false }); // the same handle, unless the file was replaced
      rows = db
        .prepare(`SELECT * FROM events WHERE event_id > ? ORDER BY event_id LIMIT ${BATCH}`)
        .all(cursor) as typeof rows;
    } catch (err) {
      if (!noEventsTable(err)) report(err, null);
      return;
    }
    for (const row of rows) {
      if (stopped) return;
      cursor = row.event_id;
      if (!matchesFilter(row.event_type, row.domain, opts.filter)) continue;
      let payload: unknown = row['payload'];
      try {
        payload = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
      } catch {
        /* delivered as stored, as wicked-bus does */
      }
      const event = { ...row, payload } as BusEvent;
      try {
        await opts.handler(event);
      } catch (err) {
        report(err, event);
      }
    }
  };

  const timer = setInterval(() => {
    if (stopped || inFlight !== null) return;
    inFlight = poll().finally(() => {
      inFlight = null;
    });
  }, opts.pollIntervalMs ?? 2000);
  timer.unref();

  return {
    dbPath,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight !== null) await inFlight;
    },
  };
}
