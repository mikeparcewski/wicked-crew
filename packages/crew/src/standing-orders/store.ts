/**
 * Standing orders (Studio OS behaviour 10) — the store.
 *
 * Plain-words rules for when the operator is busy or away, kept as STRUCTURED rules the operator
 * confirmed (never a guess: the seat's parse is shown back and only the confirmed rule is stored).
 * One JSON file in the daemon's state home — `{ away, awaySince, orders, outbox }` — rewritten
 * whole on every change (tmp + rename), read once at boot. A torn or unreadable file is said loud
 * and treated as empty rather than guessed at.
 *
 * THE INVARIANT lives here as a validation (`refusal`) and again in the evaluator: an order never
 * approves the deliver gate, never approves a plan approval, and never approves a finding.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { crewStateHome } from '../projects/state-home.js';

export const StandingOrderRuleSchema = z
  .object({
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('project'), projectId: z.string().min(1) }).strict(),
    ]),
    trigger: z.discriminatedUnion('kind', [
      // `phase`: the phase the gate reviews (the reviewed unit's `phase_ref`), or `*` for any gate.
      z.object({ kind: z.literal('gate'), phase: z.string().min(1).max(64) }).strict(),
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
const NEVER_APPROVED_PHASES: ReadonlySet<string> = new Set(['deliver', 'plan_approval']);

/** Why a rule may not be stored, or null. The code invariant, stated once for creation. */
export function refusal(rule: StandingOrderRule): string | null {
  if (rule.action !== 'approve') return null;
  if (rule.trigger.kind === 'finding') return 'an order cannot approve a finding — hold or notify on it';
  if (NEVER_APPROVED_PHASES.has(rule.trigger.phase)) {
    return `an order never answers the ${rule.trigger.phase} gate — it always waits for you`;
  }
  return null;
}

export function defaultStandingOrdersPath(): string {
  return join(crewStateHome(), 'standing-orders.json');
}

const EMPTY: StandingOrdersState = { away: false, awaySince: null, orders: [], outbox: [] };

export class StandingOrderStore {
  private state: StandingOrdersState;

  constructor(
    readonly path: string = defaultStandingOrdersPath(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
    private readonly persist = true,
  ) {
    this.state = this.load();
  }

  /** An in-memory store for directly-driven route sets (never writes the operator's home). */
  static memory(): StandingOrderStore {
    return new StandingOrderStore('(memory)', () => undefined, false);
  }

  private load(): StandingOrdersState {
    if (!this.persist || !existsSync(this.path)) return structuredClone(EMPTY);
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StandingOrdersState>;
      const orders = (Array.isArray(raw.orders) ? raw.orders : []).filter(
        (o) => typeof o?.id === 'string' && StandingOrderRuleSchema.safeParse(o.rule).success,
      );
      return {
        away: raw.away === true,
        awaySince: typeof raw.awaySince === 'number' ? raw.awaySince : null,
        orders,
        outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
      };
    } catch (err) {
      this.warn(`[standing-orders] cannot read ${this.path} — starting with no orders: ${String(err)}`);
      return structuredClone(EMPTY);
    }
  }

  private save(): void {
    if (!this.persist) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.path);
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

  setAway(away: boolean, now = Date.now()): void {
    if (this.state.away === away) return;
    this.state.away = away;
    this.state.awaySince = away ? now : null;
    this.save();
  }

  add(text: string, rule: StandingOrderRule, now = Date.now()): StandingOrder {
    const order: StandingOrder = { id: randomUUID().slice(0, 8), text, rule, createdAt: now };
    this.state.orders.push(order);
    this.save();
    return order;
  }

  remove(id: string): boolean {
    const before = this.state.orders.length;
    this.state.orders = this.state.orders.filter((o) => o.id !== id);
    if (this.state.orders.length === before) return false;
    this.save();
    return true;
  }

  queue(msg: Omit<QueuedMessage, 'id' | 'status'>): QueuedMessage {
    const queued: QueuedMessage = { ...msg, id: randomUUID().slice(0, 8), status: 'queued' };
    this.state.outbox.push(queued);
    this.save();
    return queued;
  }
}
