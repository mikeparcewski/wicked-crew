/**
 * Freeze deliveries (studio brainstorm idea 15, the SRE stop-the-line) — ONE switch that holds
 * every deliver gate:
 *
 *   GET /deliveries/freeze   {frozen, since, by, reason}
 *   PUT /deliveries/freeze   {frozen, reason?} → the same shape; audited
 *
 * While frozen, THE gate decision path (`decideGate` in routes.ts, which standing orders share)
 * refuses an APPROVE of a gate that would run a deliver unit (409 `deliveries_frozen`), and the
 * post-hoc `POST /runs/:id/deliver` refuses too. The gate stays open: unfreezing lets the same
 * approve through. A reject still cancels (it pushes nothing), and no other gate is held.
 *
 * Not held: a run launched with `deliverGate: "auto"` has no gate to hold — the engine pushes it
 * without asking the daemon. The switch stops every push a person or an order would approve.
 *
 * The durable record is the AUDIT TRAIL (`deliveries.frozen {reason?}` / `deliveries.unfrozen`),
 * folded once at boot like the standing orders' away flag, so a restart keeps the freeze. No file
 * under the state home (core's worker fence refuses unregistered top-level entries there).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditLog } from './audit.js';
import type { Actor, AuditEntry } from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';
import { LOCAL_ACTOR } from './auth.js';
import { DELIVER_PHASE_ID } from '../core/deliver.js';

const V = API_PREFIX;

export const DELIVERY_FREEZE_ACTIONS = ['deliveries.frozen', 'deliveries.unfrozen'] as const;

export const PutDeliveryFreezeSchema = z
  .object({ frozen: z.boolean(), reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export interface DeliveryFreezeState {
  frozen: boolean;
  /** ISO time the freeze was turned on; null while thawed. */
  since: string | null;
  /** The actor id that turned it on; null while thawed. */
  by: string | null;
  reason: string | null;
}

const THAWED: DeliveryFreezeState = Object.freeze({ frozen: false, since: null, by: null, reason: null });

/** Whether a unit is a run's deliver step: by phase, by phase id in its unit id, or by catalog id. */
export function isDeliverUnit(u: { id: string; phase_ref?: string | null; catalog?: string }): boolean {
  if (u.phase_ref === DELIVER_PHASE_ID || u.catalog === DELIVER_PHASE_ID) return true;
  const i = u.id.indexOf(':');
  return i >= 0 && u.id.slice(i + 1) === DELIVER_PHASE_ID;
}

/** The refusal a held approve answers with. */
export function frozenRefusal(s: DeliveryFreezeState): { error: string; code: 'deliveries_frozen' } {
  const who = s.by !== null ? ` by ${s.by}` : '';
  const when = s.since !== null ? ` since ${s.since}` : '';
  const why = s.reason !== null ? ` (${s.reason})` : '';
  return {
    error:
      `Deliveries are frozen${who}${when}${why}: nothing is pushed while the freeze is on. `
      + 'The gate stays open — unfreeze deliveries, then approve again.',
    code: 'deliveries_frozen',
  };
}

export class DeliveryFreeze {
  private s: DeliveryFreezeState = { ...THAWED };

  state(): DeliveryFreezeState {
    return { ...this.s };
  }

  /** Set the switch; records one audit line when it changes. Returns whether it changed. */
  set(frozen: boolean, actor: Actor, audit: Pick<AuditLog, 'record'>, reason?: string): boolean {
    if (frozen === this.s.frozen) return false;
    const ts = audit.record(frozen ? 'deliveries.frozen' : 'deliveries.unfrozen', actor, {
      detail: frozen && reason !== undefined ? { reason } : {},
    });
    this.s = frozen
      ? { frozen: true, since: new Date(ts > 0 ? ts : Date.now()).toISOString(), by: actor.id, reason: reason ?? null }
      : { ...THAWED };
    return true;
  }

  /** Fold the trail once at boot. A trail that cannot be read leaves the switch off, loudly. */
  async hydrate(trail: Pick<AuditLog, 'readAll'>, log?: (msg: string) => void): Promise<void> {
    try {
      const mine: ReadonlySet<string> = new Set(DELIVERY_FREEZE_ACTIONS);
      // Newest first: the first matching entry is the current state.
      const last: AuditEntry | undefined = (await trail.readAll()).find((e) => mine.has(e.action));
      if (last === undefined || last.action === 'deliveries.unfrozen') {
        this.s = { ...THAWED };
        return;
      }
      const reason = (last.detail as Record<string, unknown> | undefined)?.['reason'];
      this.s = {
        frozen: true,
        since: new Date(last.ts).toISOString(),
        by: typeof last.actor?.id === 'string' ? last.actor.id : null,
        reason: typeof reason === 'string' ? reason : null,
      };
    } catch (err) {
      log?.(`[deliveries] freeze hydrate failed — deliveries NOT frozen until restart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function registerDeliveryFreezeRoutes(
  app: FastifyInstance,
  deps: { freeze: DeliveryFreeze; audit: Pick<AuditLog, 'record'> },
): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  app.get(
    `${V}/deliveries/freeze`,
    { config: { manifest: { responseType: 'DeliveryFreezeState', statusCodes: [200] } } },
    async () => deps.freeze.state(),
  );
  app.put(
    `${V}/deliveries/freeze`,
    {
      config: {
        manifest: { requestType: 'PutDeliveryFreezeBody', responseType: 'DeliveryFreezeState', statusCodes: [200, 400] },
      },
    },
    async (req, reply) => {
      const parsed = PutDeliveryFreezeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body: expected {frozen: boolean, reason?: string}', details: parsed.error.issues });
      }
      deps.freeze.set(parsed.data.frozen, actorOf(req), deps.audit, parsed.data.reason);
      return deps.freeze.state();
    },
  );
}
