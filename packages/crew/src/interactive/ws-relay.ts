/**
 * DES-MERGE-001 §5.4 / §6.1 (slice 3) — the `wicked.interactive.*` ↔ `/ws` relay.
 *
 * wicked-studio is absorbing wicked-interactive. The SPA already holds crew's `/ws` socket for
 * CoreEvent frames; interactive's own progress travels on the wicked-bus. This module bridges the
 * two so the skin needs exactly ONE socket — no second websocket, no new port.
 *
 * Two halves, one bus handle:
 *
 * 1. RELAY (bus → /ws). Subscribe to `wicked.interactive.**` and rebroadcast each event as
 *    `{ type: 'interactiveEvent', event: <the full bus event> }` — ONE envelope type, the original
 *    event nested whole, no field renaming, no project filter. Ordering is as received (the bus
 *    hands a batch to the handler in order and `broadcast` is synchronous), and there is no
 *    buffering beyond what the existing broadcast path already does.
 *
 * 2. EMIT (/ws client → bus). `POST /projects/:projectId/interactive-events` validates the body
 *    against a SERVER-SIDE whitelist ({@link EMITTABLE_TYPES}) and puts the event on the bus with
 *    interactive's own envelope conventions (domain `wicked-interactive`, producer `wi-crew`,
 *    `ts`-stamped payload — draft-events.ts is the precedent), so interactive's own subscribers
 *    see a UI-originated event exactly as they see a service-originated one.
 *
 * Deliberately DISTINCT from the `projectActivity` bridge in projects/events.ts, which reads the
 * same filter: that one is project-FILTERED and reshapes the event into an activity frame for a
 * project view. This one is unfiltered and verbatim, because the studio's document canvas must see
 * the events of a doc that was never filed under a project. Separate plugin identity → separate
 * durable cursor, so neither seam can strand the other.
 *
 * Posture mirrors every other bus seam here: LOUD-non-fatal. No wicked-bus, or a broken db → the
 * factory logs once and returns null, the daemon boots without the relay, and the POST route
 * answers 503 instead of pretending the emit landed.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { broadcast } from '../events/bus.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import { INTERACTIVE_DOMAIN, INTERACTIVE_PRODUCER } from './draft-events.js';
import type { Actor } from '../core/types.js';

const V = API_PREFIX;

/** Dedicated durable-cursor identity — NOT the projects bridge's, so the two seams that read
 *  `wicked.interactive.**` advance independent cursors. */
const RELAY_PLUGIN = 'wicked-crew-interactive-relay';
const RELAY_FILTER = 'wicked.interactive.**';
/** The scope guard, restated locally: the property "only interactive events are relayed" is this
 *  module's, not the bus glob's. */
const RELAY_TYPE_PREFIX = 'wicked.interactive.';

/** The ONE envelope type this relay puts on `/ws`. Consumers that don't know it ignore it — the
 *  CoreEvent contract is additive-safe (DES-STUDIO-001 §2.1). */
export const INTERACTIVE_EVENT_FRAME = 'interactiveEvent';

/**
 * Server-side whitelist of the event types a `/ws` client may emit through
 * `POST /projects/:projectId/interactive-events`. A non-whitelisted type is a 400 that NAMES this
 * array — the UI never has to guess. Extend here; nothing else needs to change.
 */
export const EMITTABLE_TYPES: readonly string[] = [
  'wicked.interactive.feedback.submitted',
  'wicked.interactive.status.requested',
];

/** The request body: a whitelisted type plus that type's own payload. Strict — an unknown key is
 *  a 400, not a silently-dropped field. */
export const EmitInteractiveEventSchema = z
  .object({
    type: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface InteractiveRelay {
  /**
   * Emit one interactive event onto the bus. Returns true on success (or on WB-002, a duplicate
   * key — the emit already happened); logs and returns false otherwise. Never throws.
   */
  emitInteractive(type: string, payload: Record<string, unknown>, idempotencyKey: string): boolean;
  stop(): Promise<void>;
}

export interface InteractiveRelayOptions {
  /** Bus db path; omit for wicked-bus's own resolution (honors WICKED_BUS_DATA_DIR). */
  dbPath?: string;
  /** Poll cadence for the relay subscriber, ms (tests shorten it). */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Open the bus and arm both halves. Returns `null` (logged) when wicked-bus is not importable or
 * the db cannot open — the caller degrades to a daemon whose `/ws` simply carries no interactive
 * frames, exactly as before this slice.
 */
export async function startInteractiveWsRelay(
  opts: InteractiveRelayOptions = {},
): Promise<InteractiveRelay | null> {
  const log = opts.log ?? ((): void => undefined);

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[interactive-relay] wicked-bus is not importable — the interactive /ws relay is disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let db: import('wicked-bus').BusDb;
  let config: Record<string, unknown>;
  try {
    const override = opts.dbPath !== undefined ? { db_path: opts.dbPath } : {};
    config = bus.loadConfig(override);
    db = bus.openDb(override);
  } catch (err) {
    log(
      `[interactive-relay] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — the interactive /ws relay is disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Half 1 — bus → /ws. maxRetries: 0 for the same reason the projects bridge uses it: a retry
  // loop or a DLQ entry for a lost liveness frame is noise, and the durable feed is the record.
  //
  // This subscription also sees the events emitted by half 2 (they match the same filter). That
  // is not a loop — the relay only broadcasts, never re-emits — and the echo is the UI's
  // confirmation that its own emission actually landed on the bus.
  let subscription: import('wicked-bus').BusSubscription | null = null;
  try {
    subscription = bus.subscribe({
      db,
      plugin: RELAY_PLUGIN,
      filter: RELAY_FILTER,
      cursor_init: 'latest',
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      maxRetries: 0,
      handler: (event) => {
        if (!event.event_type.startsWith(RELAY_TYPE_PREFIX)) return;
        broadcast({ type: INTERACTIVE_EVENT_FRAME, event });
      },
      onError: (err, event) => {
        log(
          `[interactive-relay] relay error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
        );
      },
    });
  } catch (err) {
    log(
      `[interactive-relay] could not arm the /ws relay subscriber (the emit direction still works): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Half 2 — the emit surface the POST route calls after the whitelist check. The subdomain is
  // the third segment of interactive's own type grammar (`wicked.interactive.<subdomain>.<verb>`).
  function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): boolean {
    try {
      bus.emit(db, config, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: type.split('.')[2] ?? 'status',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: INTERACTIVE_PRODUCER,
        idempotency_key: idempotencyKey,
      });
      return true;
    } catch (err) {
      const code = (err as { error?: string }).error;
      if (code === 'WB-002') return true; // duplicate key — the emit already happened
      log(
        `[interactive-relay] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  return {
    emitInteractive,
    stop: async () => {
      if (subscription !== null) await subscription.stop();
    },
  };
}

/** Occurrence-unique, type-inclusive (DES-EXEC-001 rev0.2 #4a): two types sharing a key would
 *  silently drop one on the bus's UNIQUE constraint, and every UI emission is a new fact. */
export function interactiveEmitKey(projectId: string, type: string): string {
  return `crew:interactive.ui:${projectId}:${type}:${randomUUID()}`;
}

/**
 * `POST /api/v1/projects/:projectId/interactive-events` — the UI-emittable direction (§6.1).
 * Registered even when the relay is null, so the failure is an honest 503 rather than a 404 that
 * reads like "this daemon doesn't have the feature".
 */
export function registerInteractiveEventRoutes(
  app: FastifyInstance,
  relay: InteractiveRelay | null,
): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  app.post(`${V}/projects/:projectId/interactive-events`, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const parsed = EmitInteractiveEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const { type } = parsed.data;
    if (!EMITTABLE_TYPES.includes(type)) {
      return reply.code(400).send({
        error: `Event type '${type}' is not emittable from a client`,
        allowed: EMITTABLE_TYPES,
      });
    }
    if (relay === null) {
      return reply
        .code(503)
        .send({ error: 'the interactive bus seam is not armed on this daemon' });
    }
    // Server-side fields go LAST: `project_id` and `actor` are the daemon's to state, never the
    // caller's (task #88 — event actors are not caller-supplied), so a payload that names either
    // one cannot override them.
    const idempotencyKey = interactiveEmitKey(projectId, type);
    const emitted = relay.emitInteractive(
      type,
      { ...(parsed.data.payload ?? {}), project_id: projectId, actor: actorOf(req).id },
      idempotencyKey,
    );
    if (!emitted) {
      return reply.code(502).send({ error: `the bus refused the ${type} emit` });
    }
    return reply.code(202).send({ emitted: true, type, projectId, idempotencyKey });
  });
}
