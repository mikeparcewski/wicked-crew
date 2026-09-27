/**
 * Standing orders (Studio OS behaviour 10) — the store.
 *
 * Plain-words rules for when the operator is busy or away, kept as STRUCTURED rules the operator
 * confirmed (never a guess: the seat's parse is shown back and only the confirmed rule is stored).
 *
 * The durable record is the AUDIT TRAIL, like retry lineage and guidance (`GuidanceIndex`): every
 * change is one entry — `standing-order.created {standingOrder, rule}`, `standing-order.retired`,
 * `standing-order.away {away}`, `standing-order.notified {standingOrder, messageId, text}` (the
 * queued outbox) — and this class is the in-memory fold of them, hydrated once at boot. No file of
 * its own under the state home (a new top-level entry there is one core's worker fence refuses).
 *
 * THE INVARIANT lives here as a validation (`refusal`) and again in the evaluator: an order never
 * approves the deliver gate and never approves a finding. It approves a plan approval only as a
 * TRUST RECEIPT (brainstorm idea 13): one project, one preset, and the lowest band (`0-19`) — and
 * the evaluator re-reads the open plan gate's own band and risk before it answers.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditLog } from '../api/audit.js';
import type { Actor, AuditEntry } from '../core/types.js';

export const StandingOrderRuleSchema = z
  .object({
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('project'), projectId: z.string().min(1) }).strict(),
    ]),
    trigger: z.discriminatedUnion('kind', [
      // `phase`: the phase the gate reviews (the reviewed unit's `phase_ref`), `intake` (the gate
      // before the run's first unit), or `*` for any gate. `band` (optional): only a run whose
      // accepted plan landed in that band (`"0-19"`, …); a run with no scored plan never matches.
      // `preset` (optional): only a run launched from that preset (`team_plan.preset`).
      z
        .object({
          kind: z.literal('gate'),
          phase: z.string().min(1).max(64),
          band: z.string().min(1).max(16).optional(),
          preset: z.string().min(1).max(128).optional(),
        })
        .strict(),
      z.object({ kind: z.literal('finding'), severity: z.enum(['high', 'medium', '*']) }).strict(),
    ]),
    action: z.enum(['approve', 'hold', 'notify']),
    activeWhen: z.enum(['away', 'always']),
  })
  .strict();

export type StandingOrderRule = z.infer<typeof StandingOrderRuleSchema>;

export interface StandingOrder {
  id: string;
  /** The operator's own words. */
  text: string;
  rule: StandingOrderRule;
  createdAt: number;
}

/** A message an order wants sent. Outbound is only ever QUEUED — no sender exists. */
export interface QueuedMessage {
  id: string;
  orderId: string;
  orderText: string;
  runId: string | null;
  text: string;
  at: number;
  status: 'queued';
}

export interface StandingOrdersState {
  away: boolean;
  awaySince: number | null;
  orders: StandingOrder[];
  outbox: QueuedMessage[];
}

/** Phases whose gate an order may never approve, by name. */
const NEVER_APPROVED_PHASES: ReadonlySet<string> = new Set(['deliver']);

/** The phase name a plan-approval trust order triggers on. */
export const PLAN_APPROVAL_PHASE = 'plan_approval';
/** The only band whose plan approval an order may answer: the lowest. */
export const TRUSTED_PLAN_BAND = '0-19';

/** Why a rule may not be stored, or null. The code invariant, stated once for creation. */
export function refusal(rule: StandingOrderRule): string | null {
  if (rule.action !== 'approve') return null;
  if (rule.trigger.kind === 'finding') return 'an order cannot approve a finding — hold or notify on it';
  if (NEVER_APPROVED_PHASES.has(rule.trigger.phase)) {
    return `an order never answers the ${rule.trigger.phase} gate — it always waits for you`;
  }
  if (rule.trigger.phase === PLAN_APPROVAL_PHASE) {
    if (rule.trigger.band !== TRUSTED_PLAN_BAND) {
      return `an order answers the plan_approval gate only for band ${TRUSTED_PLAN_BAND} runs — every other plan waits for you`;
    }
    if (rule.trigger.preset === undefined) {
      return 'an order answers the plan_approval gate only for runs of one preset — name the preset';
    }
    if (rule.scope.kind !== 'project') {
      return 'an order answers the plan_approval gate only within one project — scope it to the project';
    }
  }
  return null;
}

/** The trail actions this store folds, oldest first. */
export const STANDING_ORDER_ACTIONS = [
  'standing-order.created',
  'standing-order.retired',
  'standing-order.away',
  'standing-order.notified',
] as const;

export function orderActor(o: Pick<StandingOrder, 'id'>): Actor {
  return { id: `standing-order:${o.id}`, kind: 'system', trust: 'operator' };
}

export class StandingOrderStore {
  private state: StandingOrdersState = { away: false, awaySince: null, orders: [], outbox: [] };

  constructor(private readonly audit: Pick<AuditLog, 'record'>) {}

  /** Fold the trail's standing-order entries (best-effort: an unreadable trail starts empty, said). */
  async hydrate(trail: Pick<AuditLog, 'readAll'>, log?: (msg: string) => void): Promise<void> {
    try {
      // One full-file scan; the trail answers newest first, so replay it reversed (append order).
      const mine: ReadonlySet<string> = new Set(STANDING_ORDER_ACTIONS);
      const entries: AuditEntry[] = (await trail.readAll()).filter((e) => mine.has(e.action));
      for (const e of entries.reverse()) this.fold(e);
    } catch (err) {
      log?.(`[standing-orders] hydrate failed — no orders until restart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fold(e: AuditEntry): void {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    const so = d['standingOrder'] as { id?: unknown; text?: unknown } | undefined;
    switch (e.action) {
      case 'standing-order.created': {
        const rule = StandingOrderRuleSchema.safeParse(d['rule']);
        if (typeof so?.id !== 'string' || typeof so.text !== 'string' || !rule.success) return;
        this.state.orders.push({ id: so.id, text: so.text, rule: rule.data, createdAt: e.ts });
        return;
      }
      case 'standing-order.retired':
        if (typeof so?.id === 'string') this.state.orders = this.state.orders.filter((o) => o.id !== so.id);
        return;
      case 'standing-order.away':
        if (typeof d['away'] === 'boolean') {
          this.state.away = d['away'];
          this.state.awaySince = d['away'] ? e.ts : null;
        }
        return;
      case 'standing-order.notified':
        if (typeof so?.id !== 'string' || typeof d['messageId'] !== 'string' || typeof d['text'] !== 'string') return;
        this.state.outbox.push({
          id: d['messageId'],
          orderId: so.id,
          orderText: typeof so.text === 'string' ? so.text : '',
          runId: e.runId ?? null,
          text: d['text'],
          at: e.ts,
          status: 'queued',
        });
        return;
      default:
        return;
    }
  }

  /** Record one change and fold it, so memory and the trail cannot disagree. */
  private write(action: string, actor: Actor, fields: { runId?: string; detail: Record<string, unknown> }): void {
    const ts = this.audit.record(action, actor, fields) || Date.now();
    this.fold({ ts, action, actor, ...(fields.runId !== undefined ? { runId: fields.runId } : {}), detail: fields.detail });
  }

  snapshot(): StandingOrdersState {
    return structuredClone(this.state);
  }

  get away(): boolean {
    return this.state.away;
  }

  orders(): readonly StandingOrder[] {
    return this.state.orders;
  }

  /** Returns whether the flag changed. */
  setAway(away: boolean, actor: Actor): boolean {
    if (this.state.away === away) return false;
    this.write('standing-order.away', actor, { detail: { away } });
    return true;
  }

  add(text: string, rule: StandingOrderRule, actor: Actor): StandingOrder {
    // The full UUID: retiring an order removes every order with its id, so ids must never collide.
    const id = randomUUID();
    this.write('standing-order.created', actor, { detail: { standingOrder: { id, text }, rule } });
    return this.state.orders.find((o) => o.id === id)!;
  }

  remove(id: string, actor: Actor): boolean {
    const o = this.state.orders.find((x) => x.id === id);
    if (o === undefined) return false;
    this.write('standing-order.retired', actor, { detail: { standingOrder: { id, text: o.text } } });
    return true;
  }

  /** Queue a message an order wants sent — recorded as the order's `standing-order.notified`. */
  queue(o: StandingOrder, runId: string, text: string): QueuedMessage {
    // Idempotent: the same order's same message about the same run is queued once, so a gate
    // still open after a restart (the boot sweep sees it again) does not queue it twice.
    const queued = this.state.outbox.find((m) => m.orderId === o.id && m.runId === runId && m.text === text);
    if (queued !== undefined) return queued;
    const messageId = randomUUID();
    this.write('standing-order.notified', orderActor(o), {
      runId,
      detail: { standingOrder: { id: o.id, text: o.text }, messageId, queued: true, text },
    });
    return this.state.outbox[this.state.outbox.length - 1]!;
  }
}
