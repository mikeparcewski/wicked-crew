/**
 * DES-TEAMING-002 §4.5 (seam T8) — the `wicked.team.*` → `/ws` relay.
 *
 * The engine publishes every team fact on the bus (§4.0, one owner per type, §7). This relay puts
 * each new team row on the SAME `/ws` socket the studio already holds, as
 * `{ type: 'teamEvent', event: <the bus row> }`, tagged `project_id` when the run's membership
 * files it, as every CoreEvent frame is. No CoreEvent variant carries a team event, and crew never
 * puts a team row on the bus (tests/team-no-publish.test.ts).
 *
 * READ-ONLY, by necessity. The bus file is the engine's too (T0), and the engine writes it through
 * its bundled SQLite while crew holds it through better-sqlite3: two SQLite copies in one process,
 * whose POSIX locks do not exclude each other (sqlite.org/howtocorrupt.html §2.2.1). A crew write
 * concurrent with an engine write corrupts the file. A wicked-bus `subscribe` writes (it registers
 * a subscription and acks a durable cursor per row), so the relay does not use one: it polls
 * through crew's one long-lived bus handle (`core/bus-handle.ts`) with its cursor in memory,
 * starting at the newest row (`latest`). Nothing is lost that matters: the bus is the durable
 * record and `GET /runs/:id/team` reads it back, so a restart needs no stored cursor.
 *
 * Posture: loud, non-fatal. A bus that cannot be opened → one log line and `null`; `/ws` then
 * carries no team frames. A read that fails (the engine mid-checkpoint) is logged and retried on
 * the next poll.
 */

import { crewBusHandle, type BusSqlite } from '../core/bus-handle.js';
import { broadcast as broadcastToWs } from '../events/bus.js';
import type { CoreEvent } from '../core/types.js';

/** The scope guard: only team rows are relayed. */
const RELAY_TYPE_PATTERN = 'wicked.team.%';
/** Rows per poll: a burst drains over a few polls instead of one unbounded read. */
const BATCH = 500;

/** The ONE envelope type this relay puts on `/ws` (api-types `TeamEventFrame`). */
export const TEAM_EVENT_FRAME = 'teamEvent';

export interface TeamRelay {
  stop(): Promise<void>;
}

export interface TeamRelayOptions {
  /** The bus db the engine publishes on (the adapter's `busDbPath`). */
  dbPath: string;
  /** The project a run is filed under, if any. */
  projectOf: (runId: string) => string | undefined;
  /** Poll cadence, ms (tests shorten it). */
  pollIntervalMs?: number;
  /** Where frames go; defaults to every `/ws` client (tests capture them). */
  broadcast?: (frame: CoreEvent) => void;
  log?: (msg: string) => void;
}

/** Arm the relay; `null` (logged) when the bus cannot be opened. */
export async function startTeamWsRelay(opts: TeamRelayOptions): Promise<TeamRelay | null> {
  const log = opts.log ?? ((): void => undefined);
  const send = opts.broadcast ?? broadcastToWs;
  let db: BusSqlite;
  let cursor: number;
  try {
    db = crewBusHandle(opts.dbPath, { create: false });
    cursor = (db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').all()[0] as { m: number }).m;
  } catch (err) {
    log(`[team-relay] cannot read the bus at ${opts.dbPath} — /ws carries no teamEvent frames: ${message(err)}`);
    return null;
  }
  const next = db.prepare(
    `SELECT * FROM events WHERE event_id > ? AND event_type LIKE '${RELAY_TYPE_PATTERN}' ORDER BY event_id LIMIT ${BATCH}`,
  );
  let lastError: string | null = null;
  const tick = (): void => {
    let rows: Array<Record<string, unknown> & { event_id: number; payload: unknown }>;
    try {
      rows = next.all(cursor) as typeof rows;
      lastError = null;
    } catch (err) {
      // Said once per distinct failure, not once per poll.
      if (message(err) !== lastError) log(`[team-relay] bus read failed (retrying): ${message(err)}`);
      lastError = message(err);
      return;
    }
    for (const row of rows) {
      cursor = row.event_id;
      let payload: unknown = row.payload;
      try {
        payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload;
      } catch {
        /* relayed as stored */
      }
      const runId = (payload as { run_id?: unknown } | null)?.run_id;
      const projectId = typeof runId === 'string' ? opts.projectOf(runId) : undefined;
      send({
        type: TEAM_EVENT_FRAME,
        event: { ...row, payload },
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      } as CoreEvent);
    }
  };
  const timer = setInterval(tick, opts.pollIntervalMs ?? 2000);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
