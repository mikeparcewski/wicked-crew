// The engine bus a TEST gets for a bus file no engine is attached to (wicked-core#631).
//
// In-daemon crew reaches the bus only through the engine that holds it (src/core/bus.ts): the
// adapter attaches its engine's `Core.busEmit` / `Core.busRead` to the bus file it handed it. Most
// seam tests drive a seam with a FAKE adapter on a temp bus file and put input events on it with
// wicked-bus, so no engine holds that file. For those, this setup file answers the same two calls
// with wicked-bus on the same file — ONE SQLite library in the test process (better-sqlite3), the
// one the test's own emits use, one connection per file, never closed. It keeps the engine's
// contract: an emit refuses (`WB-001`) a field the engine does not write or a non-integer
// `ttl_hours`, and a duplicate key resolves to the existing row's id; a read answers `{ next, rows }`
// (rows after the cursor with the type prefix — live ones unless `includeExpired` — oldest first,
// whole rows with `payload` parsed; `next` the last row's id on a full page, else the tail read before the rows, `0` when
// the cursor is past the tail; `limit` 0 answers the tail alone).
//
// An engine the test attaches (a real `CoreAdapter` with a `busDbPath`) always wins: this is only
// consulted for a path nothing is attached to. tests/bus-seams-engine.test.ts pins the seams
// against the REAL engine.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as bus from 'wicked-bus';
import { busTesting, type EngineBus } from '../../src/core/bus.js';

interface Db {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

/** The fields the engine's wire emit accepts (wicked-core `BusDb::emit_wire`); any other is WB-001. */
const WIRE_FIELDS = new Set(['event_type', 'domain', 'subdomain', 'payload', 'idempotency_key', 'producer_id', 'ttl_hours']);

const open = new Map<string, { db: Db; config: Record<string, unknown> }>();

function handle(path: string): { db: Db; config: Record<string, unknown> } {
  let h = open.get(path);
  if (h === undefined) {
    const override = { db_path: path };
    mkdirSync(dirname(path), { recursive: true }); // as the daemon's boot probe makes the bus dir
    h = { db: bus.openDb(override) as Db, config: { ...bus.loadConfig(override), daemon_notify: false } };
    open.set(path, h);
  }
  return h;
}

function wickedBusDouble(path: string): EngineBus {
  // Opened now, as an engine holds its bus from spawn: a file that cannot open fails the arm.
  handle(path);
  return {
    async busEmit(eventJson) {
      const { db, config } = handle(path);
      const row = JSON.parse(eventJson) as Parameters<typeof bus.emit>[2];
      const unknown = Object.keys(row).filter((k) => !WIRE_FIELDS.has(k));
      if (unknown.length > 0) throw new Error(`WB-001 invalid event: unknown field ${unknown.join(', ')}`);
      const ttl = (row as { ttl_hours?: unknown }).ttl_hours;
      if (ttl !== undefined && ttl !== null && !Number.isInteger(ttl)) {
        throw new Error(`WB-001 invalid event: ttl_hours must be an integer (got ${String(ttl)})`);
      }
      try {
        return bus.emit(db, config, row).event_id;
      } catch (err) {
        if ((err as { error?: string }).error !== 'WB-002') throw err;
        const hit = db
          .prepare('SELECT event_id FROM events WHERE idempotency_key = ?')
          .get((row as { idempotency_key?: string }).idempotency_key) as { event_id: number };
        return hit.event_id;
      }
    },
    async busRead(afterId, limit, typePrefix, includeExpired) {
      const { db } = handle(path);
      const tail = (db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').get() as { m: number }).m;
      if (afterId > tail) return JSON.stringify({ next: 0, rows: [] });
      if (limit === 0) return JSON.stringify({ next: tail, rows: [] });
      const rows = (
        db
          .prepare(
            `SELECT * FROM events WHERE event_id > ? AND event_id <= ? AND expires_at > ?
               AND (? IS NULL OR substr(event_type, 1, length(?)) = ?)
             ORDER BY event_id LIMIT ?`,
          )
          .all(afterId, tail, includeExpired === true ? Number.MIN_SAFE_INTEGER : Date.now(), typePrefix ?? null, typePrefix ?? null, typePrefix ?? null, limit) as Array<
          Record<string, unknown> & { event_id: number; payload: string }
        >
      ).map((r) => {
        let payload: unknown = r.payload;
        try {
          payload = JSON.parse(r.payload);
        } catch {
          /* delivered as stored */
        }
        return { ...r, payload };
      });
      const next = rows.length === limit ? rows[rows.length - 1]!.event_id : tail;
      return JSON.stringify({ next, rows });
    },
  };
}

busTesting.unattached = wickedBusDouble;
