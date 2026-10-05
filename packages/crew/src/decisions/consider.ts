/**
 * "Considered · set aside · cited (unchecked)" (DES-decision-capture §4.7, DC-S7).
 *
 *  - **Considered** = the engine's `considerRules({projects:[project]}).in_force` for the turn's or
 *    unit's project (project rules + global ones). On an engine without the binding, the global
 *    rules alone, and the Consideration says so (`source: 'global-only'`).
 *  - **Set aside** = the engine's `set_aside` (out of scope / replaced / retired) plus crew's own
 *    pending candidates for that project — decisions `offered` but not yet confirmed.
 *  - **Cited (unchecked)** = every `[rule:<id>]` the persisted reply or step wrote. An id in the
 *    in-force set is "cited by the step — unchecked"; any other id is unverified. It is NEVER
 *    summed into a "followed" count (B4): advisory rules never decide, so nothing here can know
 *    whether a rule was followed — DES-rule-check supplies that verdict.
 *
 * The same object answers `GET /chats/:id/turns/:turnId/considered` and
 * `GET /runs/:id/units/:unitKey/considered?attempt=`, and one `wicked.crew.rule.considered` fact
 * (counts and ids, never words) is emitted when a turn or a unit attempt lands — keyed per turn
 * and per (run, ord, attempt), so a re-dispatch is its own record (review N5).
 */

import { RULE_CITED_LABEL, RULE_UNKNOWN_LABEL, extractRuleCitations } from '../api/chat-citations.js';
import type { ChatTranscriptStore } from '../api/chat-transcripts.js';
import { coreUnitId } from '../api/evidence.js';
import { resolveUnit } from '../api/unit-output.js';
import type {
  ConformanceRule,
  Consideration,
  ConsiderationCitation,
  ConsiderationSetAside,
  SessionView,
} from '../core/types.js';
import { RULE_CONSIDERED, decisionFact, type DecisionBusEmit } from './events.js';
import type { DecisionLedger } from './ledger.js';
import { orderBySeverity, rulesPreface } from './rules-text.js';

export { RULE_CITED_LABEL, extractRuleCitations, rulesPreface };

/** What the service needs from the engine; every method optional so a partial stub never throws. */
export interface ConsiderAdapter {
  projectRulesSupported?(): boolean;
  listConformanceRules?(): Promise<ConformanceRule[]>;
  considerRules?(query: { projects?: string[]; steering_type?: string }): Promise<{
    in_force: ConformanceRule[];
    set_aside: Array<{ id: string; statement: string; reason: 'out_of_scope' | 'replaced' | 'retired' }>;
  }>;
  sessionsDetail?(): Promise<SessionView[]>;
  workOutput?(unitId: string): Promise<string | null>;
}

export interface InForceRead {
  rules: ConformanceRule[];
  setAside: Array<{ id: string; statement: string; reason: 'out_of_scope' | 'replaced' | 'retired' }>;
  source: Consideration['source'];
}

/**
 * The in-force rules for a project. `considerRules` when the engine has it; else the global,
 * non-retired rules; else (no engine read at all) nothing, said as `unavailable`. Never throws.
 */
export async function readInForce(adapter: ConsiderAdapter, projectId: string | null, log?: (m: string) => void): Promise<InForceRead> {
  try {
    if (typeof adapter.projectRulesSupported === 'function' && adapter.projectRulesSupported() && typeof adapter.considerRules === 'function') {
      const c = await adapter.considerRules({ projects: projectId !== null ? [projectId] : [] });
      return { rules: c.in_force, setAside: c.set_aside, source: 'considerRules' };
    }
    if (typeof adapter.listConformanceRules === 'function') {
      const all = await adapter.listConformanceRules();
      return {
        rules: all.filter((r) => r.retired !== true && r.targets?.project === undefined),
        setAside: all.filter((r) => r.retired === true).map((r) => ({ id: r.id, statement: r.statement, reason: 'retired' as const })),
        source: 'global-only',
      };
    }
  } catch (err) {
    log?.(`[decisions] could not read the in-force rules: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { rules: [], setAside: [], source: 'unavailable' };
}

export interface ConsiderationDeps {
  adapter: ConsiderAdapter;
  /** Crew's own pending candidates (`offered`) become `not_confirmed` set-asides. Absent = none. */
  ledger?: DecisionLedger;
  /** The chat turn's persisted replies. Absent = no chat considerations. */
  transcripts?: ChatTranscriptStore;
  projectOf: (id: string) => string | undefined;
  emit?: DecisionBusEmit | null;
  log?: (msg: string) => void;
}

export class ConsiderationService {
  /** chat → the rule ids its seats have been told about (the statement at open, then every preface). */
  private readonly seen = new Map<string, Set<string>>();

  constructor(private readonly deps: ConsiderationDeps) {}

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  async inForceFor(projectId: string | null): Promise<InForceRead> {
    return readInForce(this.deps.adapter, projectId, (m) => this.log(m));
  }

  /** The in-force ids, or `null` when no engine read was possible (a citation then stays unchecked). */
  async inForceIds(projectId: string | null): Promise<ReadonlySet<string> | null> {
    const read = await this.inForceFor(projectId);
    return read.source === 'unavailable' ? null : new Set(read.rules.map((r) => r.id));
  }

  // ── How seats learn the rules ──────────────────────────────────────────────────────────────

  /** The chat opened with these rules in its statement. */
  noteChatOpen(chat: string, rules: ReadonlyArray<ConformanceRule>): void {
    this.seen.set(chat, new Set(rules.map((r) => r.id)));
  }

  /**
   * The preface the next send carries, or `null`: the rules in force now that the seats have not
   * been told about. A chat this daemon did not open (a restart) is SEEDED on its first send —
   * nothing is known about what its seats were told, so the current set stands in for the open
   * statement and that send carries no preface; a rule that lands after the seed is new to the
   * seats and IS prefaced on the send after (codex r1, wording fixed: "seeded, then prefaced").
   */
  async prefaceForSend(chat: string, opts: { inForce?: ReadonlyArray<ConformanceRule> } = {}): Promise<string | null> {
    const pending = await this.pendingPreface(chat, opts);
    pending.commit();
    return pending.preface;
  }

  /**
   * {@link prefaceForSend} in two steps: the preface now, the bookkeeping ("told") only when the
   * caller's send is ACCEPTED (`commit`). A send the engine refuses — a path not at its turn gate,
   * a proposal that fails — must not consume the fresh rules, or the retry delivers nothing
   * (codex on #808 r2, 7). The seed of an unknown chat is recorded at once: nothing was told,
   * and the current set stands in for the open statement either way.
   */
  async pendingPreface(
    chat: string,
    opts: { inForce?: ReadonlyArray<ConformanceRule> } = {},
  ): Promise<{ preface: string | null; commit: () => void }> {
    const rules = opts.inForce ?? (await this.inForceFor(this.deps.projectOf(chat) ?? null)).rules;
    const seen = this.seen.get(chat);
    if (seen === undefined) {
      this.seen.set(chat, new Set(rules.map((r) => r.id)));
      return { preface: null, commit: () => undefined };
    }
    const fresh = rules.filter((r) => !seen.has(r.id));
    return {
      preface: fresh.length > 0 ? rulesPreface(fresh) : null,
      commit: () => {
        for (const r of rules) seen.add(r.id);
      },
    };
  }

  chatClosed(chat: string): void {
    this.seen.delete(chat);
  }

  // ── The Consideration ──────────────────────────────────────────────────────────────────────

  private notConfirmed(projectId: string | null): ConsiderationSetAside[] {
    const ledger = this.deps.ledger;
    if (ledger === undefined) return [];
    const views = ledger.list({ state: 'offered', ...(projectId !== null ? { project: projectId } : {}) });
    return views
      .filter((v) => v.project_id === projectId)
      .map((v) => ({ id: v.proposal_id ?? v.id, statement: v.derived.statement ?? v.origin.words, reason: 'not_confirmed' as const }));
  }

  private async build(
    subject: Consideration['subject'],
    key: string,
    projectId: string | null,
    texts: ReadonlyArray<{ by: string; text: string }>,
  ): Promise<Consideration> {
    const read = await this.inForceFor(projectId);
    const inForce = new Set(read.rules.map((r) => r.id));
    const considered = orderBySeverity(read.rules).map((r) => ({
      id: r.id,
      statement: r.statement,
      severity: r.severity,
      ...(r.steering_type !== undefined ? { steering_type: r.steering_type } : {}),
      ...(r.targets?.project !== undefined ? { project: r.targets.project } : {}),
    }));
    const cited: ConsiderationCitation[] = [];
    const seenCite = new Set<string>();
    for (const { by, text } of texts) {
      for (const id of extractRuleCitations(text)) {
        const k = `${by}\u0000${id}`;
        if (seenCite.has(k)) continue;
        seenCite.add(k);
        cited.push(
          inForce.has(id)
            ? { id, by, status: 'unchecked', label: RULE_CITED_LABEL }
            : { id, by, status: 'unverified', label: RULE_UNKNOWN_LABEL },
        );
      }
    }
    return {
      subject,
      key,
      project_id: projectId,
      considered,
      set_aside: [...read.setAside, ...this.notConfirmed(projectId)],
      cited,
      source: read.source,
    };
  }

  /** The Consideration of one chat turn, or `null` when the transcript holds no such turn. */
  async forChatTurn(chat: string, turnId: string): Promise<Consideration | null> {
    const transcripts = this.deps.transcripts;
    if (transcripts === undefined) return null;
    const records = transcripts.read(chat);
    if (!records.some((r) => r.turnId === turnId && r.kind === 'user')) return null;
    const texts = records.flatMap((r) => (r.turnId === turnId && r.kind === 'seat' ? [{ by: r.cliKey, text: r.text }] : []));
    return this.build(
      { kind: 'chat', chat_id: chat, turn_id: turnId },
      `considered:${chat}:${turnId}`,
      this.deps.projectOf(chat) ?? null,
      texts,
    );
  }

  /** The Consideration of one unit attempt (`unitKey` as `resolveUnit` accepts it), or `null`. */
  async forUnit(runId: string, unitKey: string, attempt = 0): Promise<Consideration | null> {
    const { adapter } = this.deps;
    if (typeof adapter.sessionsDetail !== 'function') return null;
    const run = (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
    if (run === undefined) return null;
    const unit = resolveUnit(run, unitKey);
    if (unit === null) return null;
    const text = typeof adapter.workOutput === 'function' ? ((await adapter.workOutput(coreUnitId(runId, unit))) ?? '') : '';
    return this.build(
      { kind: 'unit', run_id: runId, ord: unit.ord, attempt },
      `considered:${runId}:${unit.ord}:${attempt}`,
      this.deps.projectOf(runId) ?? null,
      [{ by: unit.id, text }],
    );
  }

  // ── The fact (post-commit, counts only) ───────────────────────────────────────────────────

  private async emit(c: Consideration): Promise<void> {
    const emit = this.deps.emit;
    if (emit === null || emit === undefined) return;
    const counts = {
      project_id: c.project_id,
      considered_count: c.considered.length,
      set_aside_count: c.set_aside.length,
      cited_count: c.cited.length,
    };
    const subject =
      c.subject.kind === 'chat'
        ? { chat_id: c.subject.chat_id, turn_id: c.subject.turn_id }
        : { run_id: c.subject.run_id, ord: c.subject.ord, attempt: c.subject.attempt };
    const f = decisionFact(RULE_CONSIDERED, { ...subject, ...counts }, c.key);
    try {
      await emit(f.type, f.payload, f.key);
    } catch (err) {
      this.log(`[decisions] emit ${RULE_CONSIDERED} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A chat turn's replies all landed: compute and emit. Never throws. */
  async onChatTurn(chat: string, turnId: string): Promise<void> {
    try {
      const c = await this.forChatTurn(chat, turnId);
      if (c !== null) await this.emit(c);
    } catch (err) {
      this.log(`[decisions] considered for chat ${chat} turn ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A unit attempt's output was captured: compute and emit. Never throws. */
  async onUnitCaptured(runId: string, ord: number, attempt: number): Promise<void> {
    try {
      const c = await this.forUnit(runId, String(ord), attempt);
      if (c !== null) await this.emit(c);
    } catch (err) {
      this.log(`[decisions] considered for run ${runId} unit ${ord} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
