/**
 * The ONE landing path for decisions (DES-decision-capture §4.5, DC-S4a): `remember()` and its
 * siblings `undo` / `dismiss` / `widen` / `same`, plus the act-on-route step `ingest` hands over.
 *
 * Every landing — auto, the chip, Needs You, and `POST /proposals/:id/approve` of a proposal this
 * ledger filed — goes through `remember()`, and the human check lives INSIDE it (actor kind
 * `human` ∧ trust ≥ operator), so no route branch can skip it. Words, actor and ORIGIN come from
 * the ledger, never from a proposal payload (which carries only the decision id).
 */

import { randomUUID } from 'node:crypto';

import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, ConformanceRule, DecisionChangedFrame, SteeringType } from '../core/types.js';
import { trustAtLeast, type AuthMode } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { landPolicyRule, policyProposalToRule } from '../api/policy-landing.js';
import type { InForceRule } from './derive.js';
import {
  DECISION_DISMISSED,
  DECISION_OFFERED,
  DECISION_REMEMBERED,
  DECISION_RESTATED,
  DECISION_UNDONE,
  DECISION_WIDENED,
  decisionFact,
  type DecisionBusEmit,
} from './events.js';
import type { DecisionLedger } from './ledger.js';
import type { DecisionDismissReason, DecisionOutcome, DecisionRecord, DecisionsMode, DecisionView } from './types.js';

/** A refusal with its HTTP status (403 human check, 404 unknown, 409 wrong state, 502 upstream). */
export class DecisionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 501 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

export interface DecisionDeps {
  ledger: DecisionLedger;
  mode: DecisionsMode;
  authMode: AuthMode;
  estateTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  adapter: Pick<
    CoreAdapter,
    'projectRulesSupported' | 'upsertConformanceRule' | 'readConformanceRule' | 'retireConformanceRule' | 'listConformanceRules'
  > &
    Partial<Pick<CoreAdapter, 'considerRules'>>;
  audit: AuditLog;
  emit?: DecisionBusEmit | null;
  broadcast?: (frame: DecisionChangedFrame) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RememberEdits {
  statement?: string;
  scope?: 'project' | 'everywhere';
  steering_type?: SteeringType;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `dec_` + a uuid v7-shaped id: a 48-bit ms timestamp prefix so ids sort by time. */
export function newDecisionId(now: number = Date.now()): string {
  const hex = randomUUID().replace(/-/g, '');
  const ts = Math.max(0, Math.floor(now)).toString(16).padStart(12, '0').slice(-12);
  const raw = `${ts}7${hex.slice(13, 16)}${((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 32)}`;
  return `dec_${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

export class DecisionService {
  constructor(readonly deps: DecisionDeps) {}

  get mode(): DecisionsMode {
    return this.deps.mode;
  }

  private readonly inFlight = new Set<Promise<unknown>>();
  /** Per-decision serialization: two concurrent writes on one decision never both land (codex). */
  private readonly locks = new Map<string, Promise<unknown>>();

  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(id, tail);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  /** Run host-side work off the request path (`void`), tracked so tests and shutdown can await it. */
  track(work: Promise<unknown>): void {
    const p = work.catch((err: unknown) => this.log(`[decisions] ${message(err)}`)).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  /** Resolves once every tracked host recording has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  private requireHuman(actor: Actor): void {
    if (actor.kind !== 'human' || !trustAtLeast(actor, 'operator')) {
      throw new DecisionError(
        403,
        `only a human operator can decide what is remembered (you are ${actor.kind}/${actor.trust})`,
      );
    }
  }

  private requireRecord(id: string): DecisionRecord {
    const record = this.deps.ledger.record(id);
    if (record === null) throw new DecisionError(404, `decision ${id} is not in the ledger`);
    return record;
  }

  private viewOf(id: string): DecisionView {
    const view = this.deps.ledger.view(id);
    if (view === null) throw new DecisionError(404, `decision ${id} is not in the ledger`);
    return view;
  }

  private async fact(type: string, payload: Record<string, string | number | boolean | null | undefined>, key: string): Promise<void> {
    const emit = this.deps.emit;
    if (emit === null || emit === undefined) return;
    const f = decisionFact(type, payload, key);
    try {
      await emit(f.type, f.payload, f.key);
    } catch (err) {
      this.log(`[decisions] emit ${type} failed: ${message(err)}`);
    }
  }

  private changed(id: string): void {
    const view = this.deps.ledger.view(id);
    if (view === null || this.deps.broadcast === undefined) return;
    this.deps.broadcast({
      type: 'decisionChanged',
      id,
      state: view.state,
      ...(view.rule_id !== undefined ? { rule_id: view.rule_id } : {}),
      project_id: view.project_id,
    });
  }

  private outcome(o: Omit<DecisionOutcome, 'op' | 'at'>): void {
    this.deps.ledger.appendOutcome({ op: 'outcome', at: this.now(), ...o });
    this.changed(o.id);
  }

  /** The in-force rules for a project (this project's and the global ones). Fail-soft: `[]` + a log. */
  async inForce(projectId: string | null): Promise<InForceRule[]> {
    const { adapter } = this.deps;
    try {
      if (adapter.projectRulesSupported() && typeof adapter.considerRules === 'function') {
        const c = await adapter.considerRules({ projects: projectId !== null ? [projectId] : [] });
        return c.in_force.map(toInForce);
      }
      const all = await adapter.listConformanceRules();
      return all.filter((r) => r.retired !== true && r.targets?.project === undefined).map(toInForce);
    } catch (err) {
      this.log(`[decisions] could not read the in-force rules: ${message(err)}`);
      return [];
    }
  }

  // ── Acting on a fresh record (mode `on` only) ───────────────────────────────────────────────

  /** Act on a record's route. Never throws: a failure is a `landing_failed` outcome + a log. */
  async act(record: DecisionRecord): Promise<void> {
    if (this.deps.mode !== 'on') return;
    try {
      switch (record.route) {
        case 'auto':
          // Auto needs `auth=required` NOW as well as at record time: a daemon restarted under
          // auth=off re-drives the record as an offer, never a silent landing (codex on DC-S4a).
          if (this.deps.authMode === 'required') {
            await this.remember(record.id, record.origin.actor as Actor, { how: 'auto' });
          } else {
            await this.offer(record);
          }
          return;
        case 'offer':
        case 'conflict':
        case 'maybe-restated':
          await this.offer(record);
          return;
        case 'restated':
          this.outcome({ id: record.id, state: 'restated', by: { id: 'crew', kind: 'system' }, ...(record.rule_ref !== undefined ? { restates_rule_id: record.rule_ref } : {}) });
          await this.fact(DECISION_RESTATED, { decision_id: record.id, rule_id: record.rule_ref ?? null }, `restated:${record.id}`);
          return;
        default:
          return;
      }
    } catch (err) {
      const error = message(err);
      this.log(`[decisions] ${record.route} for ${record.id} failed: ${error}`);
      if (this.deps.ledger.view(record.id)?.state === 'recorded') {
        this.outcome({ id: record.id, state: 'landing_failed', by: { id: 'crew', kind: 'system' }, error });
      }
    }
  }

  /** Re-drive records whose route asks for an action but which have no outcome (a restart mid-landing). */
  async redrive(): Promise<number> {
    if (this.deps.mode !== 'on') return 0;
    const pending = this.deps.ledger.pending();
    for (const record of pending) await this.act(record);
    return pending.length;
  }

  /** The review-queue proposal already filed for a decision (idempotent re-drive), or `null`. */
  private async proposalFor(decisionId: string): Promise<{ id: string; state: string } | null> {
    const listed = (await this.deps.estateTool('proposal.list', {})) as {
      proposals?: Array<{ id: string; state?: string; payload?: unknown }>;
    };
    for (const p of listed.proposals ?? []) {
      const payload = p.payload as { decision?: { id?: unknown } } | undefined;
      if (payload?.decision?.id === decisionId) return { id: p.id, state: p.state ?? 'pending' };
    }
    return null;
  }

  private async submitProposal(record: DecisionRecord, statement: string, steeringType: SteeringType, project: string | undefined): Promise<string> {
    const existing = await this.proposalFor(record.id);
    if (existing !== null) return existing.id;
    const submitted = (await this.deps.estateTool('proposal.submit', {
      kind_type: `policy:${steeringType}`,
      // The payload carries ONLY the decision id beside the rule text: estate proposals are writable
      // by anyone, so crew reads words, actor and ORIGIN from its own ledger (§4.2.4).
      payload: { rule: statement, severity: 'warn', capture: 'decision', decision: { id: record.id } },
      facets: project !== undefined ? { project } : {},
    })) as { id?: unknown };
    if (typeof submitted?.id !== 'string' || submitted.id === '') {
      throw new DecisionError(502, 'proposal.submit returned no id');
    }
    return submitted.id;
  }

  /** File the decision into the review queue (the chip + its Needs You row are the same object). */
  async offer(record: DecisionRecord): Promise<string> {
    return this.locked(record.id, () => this.offerLocked(record));
  }

  private async offerLocked(record: DecisionRecord): Promise<string> {
    const current = this.viewOf(record.id);
    if (current.proposal_id !== undefined) return current.proposal_id;
    if (record.derived.statement === null) throw new DecisionError(409, `decision ${record.id} has no rule to offer`);
    const project = record.derived.scope === 'project' && record.project_id !== null ? record.project_id : undefined;
    const proposalId = await this.submitProposal(record, record.derived.statement, record.derived.steering_type, project);
    this.outcome({ id: record.id, state: 'offered', by: { id: 'crew', kind: 'system' }, proposal_id: proposalId });
    await this.fact(DECISION_OFFERED, { decision_id: record.id, proposal_id: proposalId }, `offered:${record.id}`);
    return proposalId;
  }

  // ── The landing ─────────────────────────────────────────────────────────────────────────────

  async remember(
    id: string,
    actor: Actor,
    opts: { how: 'auto' | 'chip' | 'needs-you'; edits?: RememberEdits },
  ): Promise<{ rule_id: string; proposal_id: string; project?: string }> {
    this.requireHuman(actor);
    return this.locked(id, () => this.rememberLocked(id, actor, opts));
  }

  private async rememberLocked(
    id: string,
    actor: Actor,
    opts: { how: 'auto' | 'chip' | 'needs-you'; edits?: RememberEdits },
  ): Promise<{ rule_id: string; proposal_id: string; project?: string }> {
    const record = this.requireRecord(id);
    const view = this.viewOf(id);
    if (view.state === 'remembered' && view.rule_id !== undefined && view.proposal_id !== undefined) {
      return { rule_id: view.rule_id, proposal_id: view.proposal_id, ...(view.edits?.scope !== 'everywhere' && record.project_id !== null && record.derived.scope === 'project' ? { project: record.project_id } : {}) };
    }
    if (view.state !== 'recorded' && view.state !== 'offered' && view.state !== 'landing_failed') {
      throw new DecisionError(409, `decision ${id} is ${view.state}; it cannot be remembered`);
    }
    if (opts.how === 'auto' && (record.route !== 'auto' || record.origin.auth_mode !== 'required' || this.deps.authMode !== 'required')) {
      throw new DecisionError(409, `decision ${id} is not auto-eligible (route ${record.route}, auth ${record.origin.auth_mode})`);
    }
    const edits = opts.edits ?? {};
    const statement = (edits.statement ?? record.derived.statement ?? '').trim();
    if (statement === '') throw new DecisionError(409, `decision ${id} has no rule to remember`);
    const scope = edits.scope ?? record.derived.scope;
    if (scope === 'project' && record.project_id === null) {
      throw new DecisionError(400, `decision ${id} has no project — choose scope "everywhere" or file it in a project`);
    }
    const project = scope === 'project' ? (record.project_id ?? undefined) : undefined;
    const steeringType = edits.steering_type ?? record.derived.steering_type;
    const supersedes = record.route === 'conflict' && record.rule_ref !== undefined ? [record.rule_ref] : [];

    let proposalId: string;
    try {
      proposalId = view.proposal_id ?? (await this.submitProposal(record, statement, steeringType, project));
      await this.approve(proposalId);
    } catch (err) {
      if (err instanceof DecisionError) throw err;
      throw new DecisionError(502, `the review queue (estate) refused the landing: ${message(err)}`);
    }
    const built = policyProposalToRule(
      proposalId,
      `policy:${steeringType}`,
      { rule: statement, severity: 'warn' },
      project !== undefined ? { project } : {},
    );
    if ('error' in built) throw new DecisionError(400, built.error);
    const rule: ConformanceRule = {
      ...built.rule,
      provenance: { ...built.rule.provenance, source_kinds: ['operator-words'] },
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };
    const landing = await landPolicyRule({ adapter: this.deps.adapter, audit: this.deps.audit }, { rule, steeringType: built.steeringType }, actor, {
      via: 'decision',
      proposalId,
      decisionId: id,
      how: opts.how,
    });
    if (landing.outcome !== 'landed' || landing.ruleId === undefined) {
      const error = landing.error ?? 'the landing failed';
      this.outcome({ id, state: 'landing_failed', by: byOf(actor), proposal_id: proposalId, error });
      throw new DecisionError(502, error);
    }
    for (const old of supersedes) {
      try {
        await this.deps.adapter.retireConformanceRule(old);
      } catch (err) {
        this.log(`[decisions] retiring superseded rule ${old} failed: ${message(err)}`);
      }
    }
    const editsRecorded = {
      ...(edits.statement !== undefined && edits.statement !== record.derived.statement ? { statement: edits.statement } : {}),
      ...(edits.scope !== undefined && edits.scope !== record.derived.scope ? { scope: edits.scope } : {}),
      ...(edits.steering_type !== undefined && edits.steering_type !== record.derived.steering_type ? { steering_type: edits.steering_type } : {}),
    };
    this.outcome({
      id,
      state: 'remembered',
      how: opts.how,
      by: byOf(actor),
      proposal_id: proposalId,
      rule_id: landing.ruleId,
      ...(Object.keys(editsRecorded).length > 0 ? { edits: editsRecorded } : {}),
    });
    const at = this.now();
    await this.fact(
      DECISION_REMEMBERED,
      { decision_id: id, rule_id: landing.ruleId, how: opts.how, scope, project_id: project ?? null },
      `remembered:${id}:${at}`,
    );
    return { rule_id: landing.ruleId, proposal_id: proposalId, ...(project !== undefined ? { project } : {}) };
  }

  private async isApproved(proposalId: string): Promise<boolean> {
    const listed = (await this.deps.estateTool('proposal.list', { state: 'approved' })) as {
      proposals?: Array<{ id: string }>;
    };
    return (listed.proposals ?? []).some((p) => p.id === proposalId);
  }

  /** Approve a proposal; one already approved (a re-drive after a crash) is not an error. */
  private async approve(proposalId: string): Promise<void> {
    try {
      await this.deps.estateTool('proposal.approve', { id: proposalId });
    } catch (err) {
      if (await this.isApproved(proposalId)) return;
      throw err;
    }
  }

  async undo(id: string, actor: Actor): Promise<void> {
    this.requireHuman(actor);
    return this.locked(id, () => this.undoLocked(id, actor));
  }

  private async undoLocked(id: string, actor: Actor): Promise<void> {
    const view = this.viewOf(id);
    if (view.state !== 'remembered' || view.rule_id === undefined) {
      throw new DecisionError(409, `decision ${id} is ${view.state}; only a remembered decision can be undone`);
    }
    try {
      await this.deps.adapter.retireConformanceRule(view.rule_id);
    } catch (err) {
      throw new DecisionError(502, `retiring rule ${view.rule_id} failed: ${message(err)}`);
    }
    this.deps.audit.record('governance.rule.retired', actor, { detail: { id: view.rule_id, via: 'decision-undo', decisionId: id } });
    this.outcome({ id, state: 'undone', by: byOf(actor), rule_id: view.rule_id, reason: 'undone' });
    await this.fact(DECISION_UNDONE, { decision_id: id, rule_id: view.rule_id }, `undone:${id}:${this.now()}`);
  }

  async dismiss(id: string, actor: Actor, reason: DecisionDismissReason): Promise<void> {
    this.requireHuman(actor);
    return this.locked(id, () => this.dismissLocked(id, actor, reason));
  }

  private async dismissLocked(id: string, actor: Actor, reason: DecisionDismissReason): Promise<void> {
    const view = this.viewOf(id);
    if (view.state === 'remembered' || view.state === 'undone' || view.state === 'widened' || view.state === 'dismissed') {
      throw new DecisionError(409, `decision ${id} is ${view.state}; it cannot be dismissed`);
    }
    if (view.proposal_id !== undefined) {
      try {
        await this.deps.estateTool('proposal.reject', { id: view.proposal_id });
      } catch (err) {
        // A failed landing leaves its proposal approved (estate rejects only pending ones): the
        // decision is still dismissable — nothing landed (codex on DC-S4a).
        const approved = view.state === 'landing_failed' && (await this.isApproved(view.proposal_id).catch(() => false));
        if (!approved) throw new DecisionError(502, `the review queue (estate) refused the dismissal: ${message(err)}`);
      }
    }
    this.outcome({ id, state: 'dismissed', by: byOf(actor), reason, ...(view.proposal_id !== undefined ? { proposal_id: view.proposal_id } : {}) });
    await this.fact(DECISION_DISMISSED, { decision_id: id, reason }, `dismissed:${id}`);
  }

  /** B7 "Same as your rule '…'? · Same · New rule" — resolves a `maybe-restated` decision. */
  async same(id: string, actor: Actor, same: boolean): Promise<{ rule_id?: string }> {
    this.requireHuman(actor);
    if (!same) {
      const record = this.requireRecord(id);
      if (record.route !== 'maybe-restated') {
        throw new DecisionError(409, `decision ${id} is not waiting on "same or new" (route ${record.route})`);
      }
      return { rule_id: (await this.remember(id, actor, { how: 'chip' })).rule_id };
    }
    return this.locked(id, () => this.sameLocked(id, actor));
  }

  private async sameLocked(id: string, actor: Actor): Promise<{ rule_id?: string }> {
    const record = this.requireRecord(id);
    const view = this.viewOf(id);
    if (record.route !== 'maybe-restated' || (view.state !== 'recorded' && view.state !== 'offered')) {
      throw new DecisionError(409, `decision ${id} is not waiting on "same or new" (route ${record.route}, ${view.state})`);
    }
    if (view.proposal_id !== undefined) {
      try {
        await this.deps.estateTool('proposal.reject', { id: view.proposal_id });
      } catch (err) {
        throw new DecisionError(502, `the review queue (estate) refused: ${message(err)}`);
      }
    }
    this.outcome({ id, state: 'restated', by: byOf(actor), ...(record.rule_ref !== undefined ? { restates_rule_id: record.rule_ref } : {}) });
    await this.fact(DECISION_RESTATED, { decision_id: id, rule_id: record.rule_ref ?? null }, `restated:${id}`);
    return record.rule_ref !== undefined ? { rule_id: record.rule_ref } : {};
  }

  /** B8: one project-less successor that supersedes the same rule in every project. */
  async widen(id: string, actor: Actor): Promise<{ rule_id: string }> {
    this.requireHuman(actor);
    const record = this.requireRecord(id);
    if (record.derived.key === null) throw new DecisionError(409, `decision ${id} has no rule to widen`);
    const remembered = this.deps.ledger.rememberedWithKey(record.derived.key);
    const projects = [...new Set(remembered.map((r) => r.record.project_id).filter((p): p is string => p !== null))];
    if (projects.length < 2) {
      throw new DecisionError(409, `decision ${id} is remembered in ${projects.length} project(s); widening needs 2`);
    }
    const supersedes = [...new Set(remembered.map((r) => r.rule_id))].sort();
    // The EFFECTIVE rule the operator remembered (an edit at Remember wins over the derivation).
    const clicked = this.viewOf(id);
    const statement = clicked.edits?.statement ?? record.derived.statement ?? '';
    const steeringType = clicked.edits?.steering_type ?? record.derived.steering_type;
    let proposalId: string;
    try {
      const submitted = (await this.deps.estateTool('proposal.submit', {
        kind_type: `policy:${steeringType}`,
        payload: { rule: statement, severity: 'warn', capture: 'decision', decision: { id }, widens: supersedes.length },
        facets: {},
      })) as { id?: unknown };
      if (typeof submitted?.id !== 'string' || submitted.id === '') throw new Error('proposal.submit returned no id');
      proposalId = submitted.id;
      await this.approve(proposalId);
    } catch (err) {
      throw new DecisionError(502, `the review queue (estate) refused the widening: ${message(err)}`);
    }
    const built = policyProposalToRule(proposalId, `policy:${steeringType}`, { rule: statement, severity: 'warn' }, {});
    if ('error' in built) throw new DecisionError(400, built.error);
    const rule: ConformanceRule = {
      ...built.rule,
      provenance: { ...built.rule.provenance, source_kinds: ['operator-words'] },
      supersedes,
    };
    const landing = await landPolicyRule({ adapter: this.deps.adapter, audit: this.deps.audit }, { rule, steeringType: built.steeringType }, actor, {
      via: 'decision-widen',
      proposalId,
      decisionId: id,
    });
    if (landing.outcome !== 'landed' || landing.ruleId === undefined) {
      throw new DecisionError(502, landing.error ?? 'the widening failed to land');
    }
    for (const old of supersedes) {
      try {
        await this.deps.adapter.retireConformanceRule(old);
      } catch (err) {
        this.log(`[decisions] retiring superseded rule ${old} failed: ${message(err)}`);
      }
    }
    for (const r of remembered) {
      this.outcome({ id: r.record.id, state: 'widened', by: byOf(actor), rule_id: landing.ruleId, proposal_id: proposalId });
    }
    await this.fact(
      DECISION_WIDENED,
      { decision_id: id, rule_id: landing.ruleId, superseded_count: supersedes.length },
      `widened:${id}:${this.now()}`,
    );
    return { rule_id: landing.ruleId };
  }
}

function byOf(actor: Actor): { id: string; kind: 'human' | 'system' } {
  return { id: actor.id, kind: actor.kind === 'human' ? 'human' : 'system' };
}

function toInForce(rule: ConformanceRule): InForceRule {
  return {
    id: rule.id,
    statement: rule.statement,
    ...(rule.targets?.project !== undefined ? { project: rule.targets.project } : {}),
  };
}
