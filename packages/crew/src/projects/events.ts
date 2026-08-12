/**
 * The project bus seam (DES-PROJECT-001 §4) — crew's side of the conversation.
 *
 * Two halves, one bus handle:
 *
 * 1. EMIT `wicked.crew.project.{created,updated,archived}` and
 *    `wicked.crew.membership.{attached,detached}` — always POST-COMMIT (the route handlers call
 *    these only after the engine's reply, so a phantom event for a write that never landed cannot
 *    exist). Idempotency keys are TYPE-INCLUSIVE (DES-EXEC-001 rev0.2 correction #4a — two event
 *    types sharing a key silently drop one on the bus's UNIQUE constraint) and occurrence-unique
 *    (an attach after a detach is a new fact, so the key carries the attach timestamp).
 *
 * 2. BRIDGE `wicked.interactive.*` events that carry a `project_id` onto the daemon's `/ws`
 *    stream as `projectActivity` frames, so an open project view sees creator-skin progress live
 *    without a reload (ADR §5.2 / §8 step 7). The durable feed read is `activity.ts`; this is
 *    only the liveness tap.
 *
 * Posture mirrors the QE/interactive-draft seams: the bus is OPTIONAL. A machine without
 * wicked-bus (or with a broken db) gets a loudly-logged null — project CRUD keeps working, the
 * events simply don't ride, and the daemon boots regardless.
 */

import { broadcast } from '../events/bus.js';
import type { CoreEvent } from '../core/types.js';

/** Crew's bus DOMAIN COLUMN value — the product-scoped plugin name, matching the repo precedent
 *  (`INTERACTIVE_DOMAIN = 'wicked-interactive'`). The EVENT TYPES carry the §4 grammar's bare
 *  `crew` segment (`wicked.crew.project.created`); the two spellings are different fields. */
export const CREW_BUS_DOMAIN = 'wicked-crew';
const CREW_PRODUCER = 'wicked-crew';
/** The subscriber identity of the /ws liveness bridge. */
const BRIDGE_PLUGIN = 'wicked-crew-projects';
const INTERACTIVE_FILTER = 'wicked.interactive.**';

export const PROJECT_CREATED = 'wicked.crew.project.created';
export const PROJECT_UPDATED = 'wicked.crew.project.updated';
export const PROJECT_ARCHIVED = 'wicked.crew.project.archived';
export const MEMBERSHIP_ATTACHED = 'wicked.crew.membership.attached';
export const MEMBERSHIP_DETACHED = 'wicked.crew.membership.detached';

export interface ProjectBus {
  /** Emit one post-commit project event. Never throws; WB-002 (duplicate key) is success. */
  emit(type: string, payload: Record<string, unknown>, idempotencyKey: string): boolean;
  /** The resolved bus db path (the activity feed's read side opens the same file). */
  dbPath: string | null;
  stop(): Promise<void>;
}

export interface ProjectBusOptions {
  /** Bus db path; omit for wicked-bus's own resolution (honors WICKED_BUS_DATA_DIR). */
  dbPath?: string;
  /** Poll cadence for the /ws bridge subscriber, ms (tests shorten it). */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Open the bus and arm both halves. Returns `null` (logged) when wicked-bus is not importable
 * or the db cannot open — the caller degrades to CRUD-without-events.
 */
export async function startProjectBus(opts: ProjectBusOptions = {}): Promise<ProjectBus | null> {
  const log = opts.log ?? ((): void => undefined);

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[projects] wicked-bus is not importable — project events disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let db: import('wicked-bus').BusDb;
  let config: Record<string, unknown>;
  try {
    config = bus.loadConfig(opts.dbPath !== undefined ? { db_path: opts.dbPath } : {});
    db = bus.openDb(opts.dbPath !== undefined ? { db_path: opts.dbPath } : {});
  } catch (err) {
    log(
      `[projects] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — project events disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  function emit(type: string, payload: Record<string, unknown>, idempotencyKey: string): boolean {
    try {
      bus.emit(db, config, {
        event_type: type,
        domain: CREW_BUS_DOMAIN,
        subdomain: type.startsWith('wicked.crew.membership.') ? 'membership' : 'project',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: CREW_PRODUCER,
        idempotency_key: idempotencyKey,
      });
      return true;
    } catch (err) {
      const code = (err as { error?: string }).error;
      if (code === 'WB-002') return true; // duplicate key — the emit already happened
      log(`[projects] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // The /ws liveness bridge: interactive events that name a project become `projectActivity`
  // frames. Consumers that don't know the frame ignore it (additive CoreEvent contract).
  let bridge: import('wicked-bus').BusSubscription | null = null;
  try {
    bridge = bus.subscribe({
      db,
      plugin: BRIDGE_PLUGIN,
      filter: INTERACTIVE_FILTER,
      cursor_init: 'latest',
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      // Fold-into-a-socket only; a retry loop / DLQ entry for a lost liveness frame is noise —
      // the durable read (`/projects/:id/activity`) is the record, this is the tap.
      maxRetries: 0,
      handler: (event) => {
        const payload = event.payload as Record<string, unknown> | null;
        const projectId = payload !== null && typeof payload === 'object' ? payload['project_id'] : undefined;
        if (typeof projectId !== 'string' || projectId === '') return;
        broadcast({
          type: 'projectActivity',
          project_id: projectId,
          source: 'interactive',
          event_type: event.event_type,
          payload,
          ts: event.emitted_at,
        } as unknown as CoreEvent);
      },
      onError: (err, event) => {
        log(
          `[projects] /ws bridge error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
        );
      },
    });
  } catch (err) {
    log(
      `[projects] could not arm the /ws activity bridge (events still emit): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const dbPath = typeof config['db_path'] === 'string' ? (config['db_path'] as string) : null;
  return {
    emit,
    dbPath,
    stop: async () => {
      if (bridge !== null) await bridge.stop();
    },
  };
}

// ── Idempotency keys (type-inclusive + occurrence-unique) ───────────────────────

export function projectCreatedKey(projectId: string): string {
  return `crew:project.created:${projectId}:v1`;
}
export function projectUpdatedKey(projectId: string, updatedAt: number): string {
  return `crew:project.updated:${projectId}:${updatedAt}`;
}
export function projectArchivedKey(projectId: string, updatedAt: number): string {
  return `crew:project.archived:${projectId}:${updatedAt}`;
}
export function membershipAttachedKey(
  projectId: string,
  kind: string,
  ref: string,
  attachedAt: number,
): string {
  return `crew:membership.attached:${projectId}:${kind}:${ref}:${attachedAt}`;
}
export function membershipDetachedKey(projectId: string, memberId: string, at: number): string {
  return `crew:membership.detached:${projectId}:${memberId}:${at}`;
}
