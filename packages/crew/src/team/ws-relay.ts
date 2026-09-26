/**
 * DES-TEAMING-002 §4.5 (seam T8) — the `wicked.team.*` → `/ws` relay.
 *
 * The engine publishes every team fact on the bus (§4.0, one owner per type, §7). This relay puts
 * each new team row on the SAME `/ws` socket the studio already holds, as
 * `{ type: 'teamEvent', event: <the bus row> }`, tagged `project_id` when the run's membership
 * files it, as every CoreEvent frame is. No CoreEvent variant carries a team event, and crew never
 * puts a team row on the bus (tests/team-no-publish.test.ts).
 *
 * READ-ONLY. The bus file is the engine's (T0), and crew reads it through the engine that holds it
 * (`Core.busRead`, wicked-core#631, core/bus.ts) — crew opens no SQLite of its own. The relay is a
 * tap with its cursor in memory, starting at the newest row (`latest`). Nothing is lost that
 * matters: the bus is the durable record and `GET /runs/:id/team` reads it back, so a restart needs
 * no stored cursor.
 *
 * Posture: loud, non-fatal. A bus no engine holds → one log line and `null`; `/ws` then
 * carries no team frames. A read that fails (the engine mid-checkpoint) is logged and retried on
 * the next poll.
 */

import { tapBus } from '../core/bus.js';
import { broadcast as broadcastToWs } from '../events/bus.js';
import type { CoreEvent } from '../core/types.js';

/** The scope guard: only team rows are relayed. */
const RELAY_FILTER = 'wicked.team.**';

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
  let lastError: string | null = null;
  try {
    return await tapBus({
      dbPath: opts.dbPath,
      filter: RELAY_FILTER,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      handler: (event) => {
        lastError = null;
        const runId = (event.payload as { run_id?: unknown } | null)?.run_id;
        const projectId = typeof runId === 'string' ? opts.projectOf(runId) : undefined;
        send({
          type: TEAM_EVENT_FRAME,
          event,
          ...(projectId !== undefined ? { project_id: projectId } : {}),
        } as CoreEvent);
      },
      // A failed read (the engine mid-checkpoint) is retried on the next poll; said once per
      // distinct failure, not once per poll.
      onError: (err) => {
        if (message(err) !== lastError) log(`[team-relay] bus read failed (retrying): ${message(err)}`);
        lastError = message(err);
      },
    });
  } catch (err) {
    log(`[team-relay] cannot read the bus at ${opts.dbPath} — /ws carries no teamEvent frames: ${message(err)}`);
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
