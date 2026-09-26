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
import { busSubscriberErrorReporter } from '../interactive/bus-subscriber-errors.js';
import { emitOnBus, tapBus, type BusTap } from '../core/bus.js';

/** Crew's bus DOMAIN COLUMN value — the product-scoped plugin name, matching the repo precedent
 *  (`INTERACTIVE_DOMAIN = 'wicked-interactive'`). The EVENT TYPES carry the §4 grammar's bare
 *  `crew` segment (`wicked.crew.project.created`); the two spellings are different fields. */
export const CREW_BUS_DOMAIN = 'wicked-crew';
const CREW_PRODUCER = 'wicked-crew';
const INTERACTIVE_FILTER = 'wicked.interactive.**';

export const PROJECT_CREATED = 'wicked.crew.project.created';
export const PROJECT_UPDATED = 'wicked.crew.project.updated';
export const PROJECT_ARCHIVED = 'wicked.crew.project.archived';
export const MEMBERSHIP_ATTACHED = 'wicked.crew.membership.attached';
export const MEMBERSHIP_DETACHED = 'wicked.crew.membership.detached';

export interface ProjectBus {
  /** Emit one post-commit project event (through the engine, core/bus.ts). Never rejects; a key
   *  already on the bus is success. */
  emit(type: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<boolean>;
  /** The resolved bus db path (the activity feed's read side opens the same file). */
  dbPath: string | null;
  stop(): Promise<void>;
}

export interface ProjectBusOptions {
  /** The bus db the daemon handed its engine (core/bus.ts); without one the seam does not arm. */
  dbPath?: string;
  /** Poll cadence for the /ws bridge subscriber, ms (tests shorten it). */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
  /** Error-level logger for connection-fatal subscriber errors (the /diagnostics ring folds it); defaults to `log`. */
  logError?: (msg: string) => void;
}

/**
 * Arm both halves. Returns `null` (logged) when the bus db cannot open — the caller degrades to
 * CRUD-without-events.
 */
export async function startProjectBus(opts: ProjectBusOptions = {}): Promise<ProjectBus | null> {
  const log = opts.log ?? ((): void => undefined);

  // Both halves go through the engine that holds the bus (wicked-core#631, core/bus.ts): the
  // bridge is a tap over `Core.busRead`, every emit is `Core.busEmit` — crew opens no SQLite.
  let dbPath: string;
  let bridge: BusTap;
  try {
    // The /ws liveness bridge: interactive events that name a project become `projectActivity`
    // frames. Consumers that don't know the frame ignore it (additive CoreEvent contract). A lost
    // liveness frame is not retried — the durable read (`/projects/:id/activity`) is the record.
    bridge = await tapBus({
      dbPath: opts.dbPath,
      filter: INTERACTIVE_FILTER,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
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
      onError: busSubscriberErrorReporter({
        describe: (err, event) =>
          `[projects] /ws bridge error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
        log,
        logError: opts.logError,
        pollIntervalMs: opts.pollIntervalMs ?? 2000,
      }),
    });
    dbPath = bridge.dbPath;
  } catch (err) {
    log(
      `[projects] has no bus${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — project events disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  async function emit(type: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<boolean> {
    try {
      await emitOnBus(dbPath, {
        event_type: type,
        domain: CREW_BUS_DOMAIN,
        subdomain: type.startsWith('wicked.crew.membership.') ? 'membership' : 'project',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: CREW_PRODUCER,
        idempotency_key: idempotencyKey,
      });
      return true;
    } catch (err) {
      log(`[projects] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  return {
    emit,
    dbPath,
    stop: () => bridge.stop(),
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
