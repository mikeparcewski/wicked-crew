/**
 * The registry's pulled sources and its `/ws` relay (DES-TRIGGER-REGISTRY-001 §4.5, §4.6).
 *
 * BUS PULL. Bus key points are PULLED through the engine (`tapBus` over `Core.busRead`), never
 * pushed: the tap awaits each row's handler (route, check, emit) before it reads on, so its
 * in-memory cursor advances only after the row's outputs were emitted or recorded as failed. When
 * the lanes are slow the tap simply reads later; the bus is the buffer. Armed only while an enabled
 * entry listens on the bus (none does in TR-W5a; `plan.accepted` arrives with TR-W7).
 *
 * RELAY. Watch rows reach `/ws` as `{type:"watchEvent", event:<bus row>, project_id?}` through a tap
 * of `wicked.crew.watch_finding.**`, the team relay's pattern (`team/ws-relay.ts`). The registry
 * never broadcasts directly, so the socket and the record cannot disagree.
 */

import { readBus, tapBus, type BusEvent, type BusTap } from '../core/bus.js';
import type { CoreEvent } from '../core/types.js';
import { WATCH_EVENT_FRAME, WATCH_FINDING_PREFIX } from './events.js';
import type { KeyPointInput } from './types.js';

/** Every bus row the registry may pull starts with this; the router keeps only the wanted types. */
const BUS_PULL_FILTER = 'wicked.**';

export interface BusPull {
  /** ms between the newest handled row's emit and its handling (0 when caught up). */
  tailLagMs(): number;
  stop(): Promise<void>;
}

function inputOf(row: BusEvent, replay: boolean): KeyPointInput {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const runId = typeof payload['run_id'] === 'string' ? payload['run_id'] : null;
  return {
    source: 'bus',
    type: row.event_type,
    event: row as unknown as Record<string, unknown>,
    runId,
    at: typeof row.emitted_at === 'number' ? row.emitted_at : Date.now(),
    busKey: row.idempotency_key,
    ...(replay ? { replay: true } : {}),
  };
}

/** Arm the bus pull. `wants(type)` is the router's O(1) type check; `handle` is awaited per row. */
export async function startBusPull(opts: {
  dbPath: string;
  wants: (type: string) => boolean;
  handle: (input: KeyPointInput) => Promise<void>;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}): Promise<BusPull> {
  let lag = 0;
  let lastHandled = Date.now();
  const tap: BusTap = await tapBus({
    dbPath: opts.dbPath,
    filter: BUS_PULL_FILTER,
    pollIntervalMs: opts.pollIntervalMs ?? 2_000,
    handler: async (row) => {
      if (!opts.wants(row.event_type)) return;
      const now = Date.now();
      lag = typeof row.emitted_at === 'number' ? Math.max(0, now - row.emitted_at) : 0;
      lastHandled = now;
      await opts.handle(inputOf(row, false));
    },
    onError: (err) => opts.log?.(`[watch] bus pull read failed (retrying): ${err.message}`),
  });
  return {
    // A pull that has handled nothing for a poll or two is caught up, not "behind".
    tailLagMs: () => (Date.now() - lastHandled > 5_000 ? 0 : lag),
    stop: () => tap.stop(),
  };
}

/** The boot replay's bus half (§4.8 step 2): the wanted rows of the live runs, oldest first. */
export async function replayBusRows(dbPath: string, types: readonly string[], liveRuns: ReadonlySet<string>): Promise<KeyPointInput[]> {
  const out: KeyPointInput[] = [];
  for (const type of types) {
    for (const row of await readBus(dbPath, type, { history: true })) {
      if (row.event_type !== type) continue;
      const input = inputOf(row, true);
      if (input.runId !== null && liveRuns.has(input.runId)) out.push(input);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface WatchRelay {
  stop(): Promise<void>;
}

/** Arm the `watchEvent` relay; `null` (logged) when no engine holds the bus. */
export async function startWatchWsRelay(opts: {
  dbPath: string;
  projectOf: (runId: string) => string | undefined;
  broadcast: (frame: CoreEvent) => void;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}): Promise<WatchRelay | null> {
  let lastError: string | null = null;
  try {
    return await tapBus({
      dbPath: opts.dbPath,
      filter: `${WATCH_FINDING_PREFIX}**`,
      pollIntervalMs: opts.pollIntervalMs ?? 2_000,
      handler: (event) => {
        lastError = null;
        const payload = event.payload as { run_id?: unknown; project_id?: unknown } | null;
        const runId = payload?.run_id;
        const projectId =
          typeof payload?.project_id === 'string'
            ? payload.project_id
            : typeof runId === 'string'
              ? opts.projectOf(runId)
              : undefined;
        opts.broadcast({
          type: WATCH_EVENT_FRAME,
          event,
          ...(projectId !== undefined ? { project_id: projectId } : {}),
        } as unknown as CoreEvent);
      },
      onError: (err) => {
        if (err.message !== lastError) opts.log?.(`[watch-relay] bus read failed (retrying): ${err.message}`);
        lastError = err.message;
      },
    });
  } catch (err) {
    opts.log?.(`[watch-relay] cannot read the bus — /ws carries no watchEvent frames: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
