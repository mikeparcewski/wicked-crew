/**
 * DES-MERGE-001 §5.4 / §6.1 (slice 3) — the `wicked.interactive.*` ↔ `/ws` relay.
 *
 * wicked-studio is absorbing wicked-interactive. The SPA already holds crew's `/ws` socket for
 * CoreEvent frames; interactive's own progress travels on the wicked-bus. This module bridges the
 * two so the skin needs exactly ONE socket — no second websocket, no new port.
 *
 * Two halves, one bus handle:
 *
 * 1. RELAY (bus → /ws). Tap `wicked.interactive.**` and rebroadcast each event as
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
 * the events of a doc that was never filed under a project. Each is its own tap with its own
 * in-memory cursor, so neither seam can strand the other.
 *
 * Posture mirrors every other bus seam here: LOUD-non-fatal. A bus db that cannot open → the
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
import { busSubscriberErrorReporter } from './bus-subscriber-errors.js';
import { emitOnBus, tapBus, type BusTap } from '../core/bus.js';

const V = API_PREFIX;

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
   * Emit one interactive event onto the bus. Returns true on success (a key already on the bus is
   * success — the emit already happened); logs and returns false otherwise. Never rejects.
   */
  emitInteractive(type: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<boolean>;
  stop(): Promise<void>;
}

export interface InteractiveRelayOptions {
  /** The bus db the daemon handed its engine (core/bus.ts); without one the relay does not arm. */
  dbPath?: string;
  /** Poll cadence for the relay subscriber, ms (tests shorten it). */
  pollIntervalMs?: number;
  log?: (msg: string) => void;
  /** Error-level logger for connection-fatal subscriber errors (the /diagnostics ring folds it); defaults to `log`. */
  logError?: (msg: string) => void;
  /**
   * Called once per observed `wicked.interactive.doc.retired` with the retired document id
   * (crew#338). This is how a retirement that BYPASSED crew's governed delete route — a direct
   * bridge call, another tool — still drops the doc's handoff-ledger rows: `createServer` wires
   * the same idempotent four-ledger sweep the route runs, so at-least-once redelivery and the
   * route/relay overlap both collapse to "remove rows that may not exist". Best-effort by the
   * relay's nature (cursor starts at `latest`, no retries) — the governed route stays the
   * guaranteed path. A throw is caught and logged; it never takes the relay down.
   */
  onDocRetired?: (documentId: string) => void;
}

/**
 * Arm both halves. Returns `null` (logged) when the bus db cannot open — the caller degrades to a daemon whose `/ws` simply carries no interactive
 * frames, exactly as before this slice.
 */
export async function startInteractiveWsRelay(
  opts: InteractiveRelayOptions = {},
): Promise<InteractiveRelay | null> {
  const log = opts.log ?? ((): void => undefined);

  // Both halves go through the engine that holds the bus (wicked-core#631, core/bus.ts): the
  // relay is a tap over `Core.busRead`, the emit direction is `Core.busEmit` — crew opens no
  // SQLite of its own.
  //
  // Half 1 — bus → /ws. No retry: a lost liveness frame is noise, and the durable feed is the record.
  //
  // This tap also sees the events emitted by half 2 (they match the same filter). That is not a
  // loop — the relay only broadcasts, never re-emits — and the echo is the UI's confirmation that
  // its own emission actually landed on the bus.
  let tap: BusTap;
  try {
    tap = await tapBus({
      dbPath: opts.dbPath,
      filter: RELAY_FILTER,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      handler: (event) => {
        if (!event.event_type.startsWith(RELAY_TYPE_PREFIX)) return;
        broadcast({ type: INTERACTIVE_EVENT_FRAME, event });
        // The retire fact's crew-side consumer (crew#338): drop the doc's handoff-ledger rows
        // no matter WHO retired it. After the broadcast on purpose — the UI learning the doc is
        // gone must not wait on (or be lost to) a failing sweep.
        if (event.event_type === 'wicked.interactive.doc.retired' && opts.onDocRetired) {
          const payload = event.payload as { document_id?: unknown } | null | undefined;
          const documentId = payload?.document_id;
          if (typeof documentId === 'string' && documentId.length > 0) {
            try {
              opts.onDocRetired(documentId);
            } catch (err) {
              log(
                `[interactive-relay] doc.retired ledger sweep for ${documentId} failed (the governed ` +
                  `DELETE route retries it): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      },
      onError: busSubscriberErrorReporter({
        describe: (err, event) =>
          `[interactive-relay] relay error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
        log,
        logError: opts.logError,
        pollIntervalMs: opts.pollIntervalMs ?? 2000,
      }),
    });
  } catch (err) {
    log(
      `[interactive-relay] has no bus${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — the interactive /ws relay is disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Half 2 — the emit surface the POST route calls after the whitelist check. The subdomain is
  // the third segment of interactive's own type grammar (`wicked.interactive.<subdomain>.<verb>`).
  async function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<boolean> {
    try {
      await emitOnBus(tap.dbPath, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: type.split('.')[2] ?? 'status',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: INTERACTIVE_PRODUCER,
        idempotency_key: idempotencyKey,
      });
      return true;
    } catch (err) {
      log(
        `[interactive-relay] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  return {
    emitInteractive,
    stop: () => tap.stop(),
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
    const emitted = await relay.emitInteractive(
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
