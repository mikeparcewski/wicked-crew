/**
 * Standing orders (Studio OS behaviour 10) — the daemon evaluator.
 *
 * Fed by the daemon's single CoreEvent subscription (`awaitingHuman`) and the team relay
 * (`wicked.team.finding.raised`), and re-swept over the engine's open gate rows when the away flag
 * turns on or an order is added. For each gate or finding it finds the ACTIVE orders that match
 * (away gating, project scope, the reviewed phase or the finding's severity) and acts:
 *
 *   hold    — the gate stays open; `standing-order.held` says an order is keeping it for you.
 *             A hold wins over an approve on the same gate.
 *   approve — answers the gate through `decideGate`, THE gate decision path `POST /runs/:id/gate`
 *             uses (ord check, 409 gate_changed / gate_unknown, confirmGate, `gate.decided` audit).
 *             The actor is the order. A refusal (a person got there first) is logged, never retried.
 *   notify  — the message is QUEUED: the store records `standing-order.notified` (its outbox).
 *             Nothing is sent: outbound always waits.
 *
 * THE INVARIANT: an order approves only a phase-review gate (`def`, `run_level`, `terminal`). The
 * deliver gate, a plan approval (whose risk band is not on the gate — so none, fail closed), an
 * escalation, a failure and a triage are never answered by an order, and neither is any gate of a
 * steering-author run (its approval lands doctrine).
 *
 * A gate's PHASE, for matching, is the reviewed unit's `phase_ref` (the upcoming unit's when
 * nothing has run). The gate before the run's first unit, with nothing to review, is also
 * `intake` — the name studio and operators use for it (`IntakePlan.isIntakeGate`).
 */

import type { AuditLog } from '../api/audit.js';
import type { RegisteredRoutes } from '../api/routes.js';
import type { CoreEvent } from '../core/types.js';
import { orderActor, type StandingOrder, type StandingOrderStore } from './store.js';

/** The only gate kinds an order may approve. */
export const APPROVABLE_GATE_KINDS: ReadonlySet<string> = new Set(['def', 'run_level', 'terminal']);

export interface GateFact {
  runId: string;
  ord: number;
  reviewingOrd: number | null;
  gateKind: string;
  prompt: string;
}

export interface FindingFact {
  runId: string;
  findingId: string;
  severity: string;
  claim: string;
}

/** What the evaluator needs to know about a run: its project and the phase of a unit. */
export interface RunFacts {
  projectId: string | undefined;
  problem: string;
  phaseOf: (ord: number) => string | undefined;
  /** The run's first unit ord — the gate before it, with nothing to review, is the INTAKE gate. */
  firstOrd: number | undefined;
  /** Approving this run's gate would land doctrine (a steering-author run): never an order's call. */
  landsDoctrine: boolean;
}

export interface EvaluatorDeps {
  store: StandingOrderStore;
  decideGate: RegisteredRoutes['decideGate'];
  audit: Pick<AuditLog, 'record'>;
  runFacts: (runId: string) => Promise<RunFacts | undefined>;
  /** The engine's open gate rows (a sweep); `[]` when the engine cannot say. */
  openGates: () => Promise<GateFact[]>;
  log?: (msg: string) => void;
}

export class StandingOrderEvaluator {
  /** `<subject>:<order or action>` keys already acted on — one action per gate/finding per order. */
  private readonly done = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: EvaluatorDeps) {
    this.log = deps.log ?? (() => undefined);
  }

  /** Every settled action, for tests: resolves when the evaluation it started is finished. */
  onEvent(event: CoreEvent): Promise<void> {
    if (event.type !== 'awaitingHuman') return Promise.resolve();
    const e = event as unknown as Record<string, unknown>;
    if (typeof e['session'] !== 'string' || typeof e['ord'] !== 'number') return Promise.resolve();
    return this.considerGate({
      runId: e['session'],
      ord: e['ord'],
      reviewingOrd: typeof e['reviewingOrd'] === 'number' ? e['reviewingOrd'] : null,
      gateKind: typeof e['gateKind'] === 'string' ? e['gateKind'] : '',
      prompt: typeof e['prompt'] === 'string' ? e['prompt'] : '',
    }).catch((err) => this.log(`[standing-orders] gate evaluation failed: ${String(err)}`));
  }

  /** A team relay frame (`{ type: 'teamEvent', event: <bus row> }`). */
  onTeamFrame(frame: CoreEvent): Promise<void> {
    const row = (frame as unknown as { event?: { event_type?: unknown; payload?: Record<string, unknown> } }).event;
    if (row?.event_type !== 'wicked.team.finding.raised' || row.payload === undefined) return Promise.resolve();
    const p = row.payload;
    if (typeof p['run_id'] !== 'string' || typeof p['severity'] !== 'string') return Promise.resolve();
    return this.considerFinding({
      runId: p['run_id'],
      findingId: typeof p['finding_id'] === 'string' ? p['finding_id'] : String(p['raise_seq'] ?? ''),
      severity: p['severity'],
      claim: typeof p['claim'] === 'string' ? p['claim'] : '',
    }).catch((err) => this.log(`[standing-orders] finding evaluation failed: ${String(err)}`));
  }

  /** Re-read the engine's open gates (the away flag turned on, or an order was added). */
  async sweep(): Promise<void> {
    // No active gate order, nothing a sweep could do: never touch the engine for it.
    if (!this.deps.store.orders().some((o) => this.active(o) && o.rule.trigger.kind === 'gate')) return;
    let gates: GateFact[];
    try {
      gates = await this.deps.openGates();
    } catch (err) {
      this.log(`[standing-orders] cannot read the open gates: ${String(err)}`);
      return;
    }
    for (const g of gates) await this.considerGate(g);
  }

  private active(o: StandingOrder): boolean {
    return o.rule.activeWhen === 'always' || this.deps.store.away;
  }

  private inScope(o: StandingOrder, projectId: string | undefined): boolean {
    return o.rule.scope.kind === 'all' || o.rule.scope.projectId === projectId;
  }

  private once(key: string): boolean {
    if (this.done.has(key)) return false;
    this.done.add(key);
    return true;
  }

  async considerGate(g: GateFact): Promise<void> {
    const orders = this.deps.store.orders().filter((o) => this.active(o) && o.rule.trigger.kind === 'gate');
    if (orders.length === 0) return;
    const run = await this.deps.runFacts(g.runId);
    if (run === undefined) return;
    const unitPhase = run.phaseOf(g.reviewingOrd ?? g.ord) ?? '';
    const intake = g.reviewingOrd === null && g.ord === run.firstOrd;
    const phase = intake ? 'intake' : unitPhase;
    const matching = orders.filter(
      (o) =>
        this.inScope(o, run.projectId) &&
        o.rule.trigger.kind === 'gate' &&
        (o.rule.trigger.phase === '*' || o.rule.trigger.phase === phase || o.rule.trigger.phase === unitPhase),
    );
    const subject = `gate:${g.runId}:${g.ord}`;
    const holds = matching.filter((o) => o.rule.action === 'hold');
    const approves = matching.filter((o) => o.rule.action === 'approve');
    for (const o of holds) {
      if (!this.once(`${subject}:${o.id}`)) continue;
      this.deps.audit.record('standing-order.held', orderActor(o), {
        runId: g.runId,
        detail: { standingOrder: { id: o.id, text: o.text }, ord: g.ord, gateKind: g.gateKind, phase },
      });
    }
    for (const o of matching.filter((x) => x.rule.action === 'notify')) {
      if (!this.once(`${subject}:${o.id}`)) continue;
      this.notify(o, g.runId, `${run.problem}: the ${phase || g.gateKind} gate is waiting on you`);
    }
    // THE INVARIANT: only a phase-review gate, and never under a hold.
    const approver = approves[0];
    if (approver === undefined || holds.length > 0 || !APPROVABLE_GATE_KINDS.has(g.gateKind) || run.landsDoctrine) return;
    if (!this.once(`${subject}:approve`)) return;
    const out = await this.deps.decideGate(g.runId, { approve: true, ord: g.ord }, orderActor(approver), {
      standingOrder: { id: approver.id, text: approver.text },
    });
    if (out.code !== 200) {
      this.log(
        `[standing-orders] order ${approver.id} did not answer the gate before unit ${g.ord} on ${g.runId}: ` +
          `${out.code} ${JSON.stringify(out.body)}`,
      );
    }
  }

  async considerFinding(f: FindingFact): Promise<void> {
    const orders = this.deps.store
      .orders()
      .filter(
        (o) =>
          this.active(o) &&
          o.rule.trigger.kind === 'finding' &&
          (o.rule.trigger.severity === '*' || o.rule.trigger.severity === f.severity),
      );
    if (orders.length === 0) return;
    const run = await this.deps.runFacts(f.runId);
    for (const o of orders.filter((x) => this.inScope(x, run?.projectId))) {
      if (!this.once(`finding:${f.runId}:${f.findingId}:${o.id}`)) continue;
      if (o.rule.action === 'notify') {
        this.notify(o, f.runId, `${f.severity.toUpperCase()} finding on ${run?.problem ?? f.runId}: ${f.claim}`);
      } else if (o.rule.action === 'hold') {
        this.deps.audit.record('standing-order.held', orderActor(o), {
          runId: f.runId,
          detail: { standingOrder: { id: o.id, text: o.text }, findingId: f.findingId, severity: f.severity },
        });
      }
    }
  }

  /** The store records it (`standing-order.notified`, the order as actor) — queued, never sent. */
  private notify(o: StandingOrder, runId: string, text: string): void {
    this.deps.store.queue(o, runId, text);
  }
}
