/**
 * DES-TEAMING-002 §4.5 (seam T8) — the `wicked.team.*` → `/ws` relay.
 *
 * The engine publishes every team fact on the bus (§4.0, one owner per type, §7). This relay
 * subscribes to `wicked.team.**` and rebroadcasts each row on the SAME `/ws` socket the studio
 * already holds, as `{ type: 'teamEvent', event: <the full bus row> }` — the `interactiveEvent`
 * pattern (`interactive/ws-relay.ts`) verbatim, one direction only: crew RELAYS, it never puts a
 * team row on the bus (tests/team-no-publish.test.ts). No CoreEvent variant carries a team event.
 *
 * A frame carries `project_id` when the run's membership files it, as every CoreEvent frame does.
 *
 * Posture: loud, non-fatal. No wicked-bus, or a bus that will not open → one log line and `null`;
 * the daemon boots and `/ws` simply carries no team frames. The durable record is the bus itself
 * (`GET /runs/:id/team` reads it back), so the relay needs no retries: `maxRetries: 0`, cursor
 * `latest`.
 */

import { broadcast } from '../events/bus.js';
import { busSubscriberErrorReporter } from '../interactive/bus-subscriber-errors.js';

/** The relay's own durable-cursor identity on the bus. */
const RELAY_PLUGIN = 'wicked-crew-team-relay';
const RELAY_FILTER = 'wicked.team.**';
/** The scope guard, restated locally: only team rows are relayed, whatever the glob matches. */
const RELAY_TYPE_PREFIX = 'wicked.team.';

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
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
}

/** Open the bus and arm the relay; `null` (logged) when the bus is not there. */
export async function startTeamWsRelay(opts: TeamRelayOptions): Promise<TeamRelay | null> {
  const log = opts.log ?? ((): void => undefined);
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  let bus: typeof import('wicked-bus');
  let db: import('wicked-bus').BusDb;
  try {
    bus = await import('wicked-bus');
    db = bus.openDb({ db_path: opts.dbPath });
  } catch (err) {
    log(
      `[team-relay] could not open the bus db at ${opts.dbPath} — /ws carries no teamEvent frames: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  try {
    const subscription = bus.subscribe({
      db,
      plugin: RELAY_PLUGIN,
      filter: RELAY_FILTER,
      cursor_init: 'latest',
      pollIntervalMs,
      maxRetries: 0,
      handler: (event) => {
        if (!event.event_type.startsWith(RELAY_TYPE_PREFIX)) return;
        const runId = (event.payload as { run_id?: unknown } | null | undefined)?.run_id;
        const projectId = typeof runId === 'string' ? opts.projectOf(runId) : undefined;
        broadcast({ type: TEAM_EVENT_FRAME, event, ...(projectId !== undefined ? { project_id: projectId } : {}) });
      },
      onError: busSubscriberErrorReporter({
        describe: (err, event) =>
          `[team-relay] relay error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
        log,
        logError: opts.logError,
        pollIntervalMs,
      }),
    });
    return { stop: () => subscription.stop() };
  } catch (err) {
    log(`[team-relay] could not arm the /ws relay subscriber: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
