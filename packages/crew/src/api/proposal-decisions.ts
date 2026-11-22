/**
 * crew#1261: who rejected a proposal, and why. estate's queue keeps only `state: rejected`; three different things end
 * there, and a client cannot tell them apart from the row (`payload.edited_from` is a field any filer can set):
 *
 *  - `operator` / `rejected`: a person turned it down (`POST /proposals/:id/reject`, or dismissing its decision).
 *  - `crew` / `replaced-by-edit`: an accept-with-edit approved an edited copy (`copy_id`) and rejected the original.
 *  - `crew` / `withdrawn-copy`: an accept-with-edit's copy whose approve failed, withdrawn so a retry leaves no duplicate.
 *  - `operator` / `restated`: a person said a decision's proposal restates a rule they have (the decision's "Same").
 *  - `crew` / `withdrawn`: crew withdrew a proposal it filed itself (a widening that did not land, an undone memory edit).
 *  - `crew` / `stale`: a memory replacement whose memory is gone (edited again or retired), rejected so it cannot
 *    bring retired words back.
 *
 * Crew records each decision it makes as a `proposal.decided` line on its audit trail and returns it on
 * `GET /proposals` (`Proposal.decision`). A row with none is UNKNOWN (estate's own tools, a crew path that records
 * none, a trail that could not be read or written): never a guess. `by: 'operator'` is only ever a HUMAN actor's line
 * (with auth off every caller is the local person, as for every other audit line).
 */

import type { ProposalDecision, ProposalDecisionReason } from 'wicked-crew-api-types';
import type { Actor, AuditEntry } from '../core/types.js';
import type { AuditLog } from './audit.js';

export const PROPOSAL_DECIDED = 'proposal.decided';

const REASONS: ReadonlySet<string> = new Set<ProposalDecisionReason>(['rejected', 'restated', 'replaced-by-edit', 'withdrawn-copy', 'withdrawn', 'stale']);

/** The reasons that are a person's own decision (when a human actor made it); every other reason is crew's. */
const PERSON_REASONS: ReadonlySet<ProposalDecisionReason> = new Set<ProposalDecisionReason>(['rejected', 'restated']);

/** Record one decision crew made on a proposal. A person's own rejection (`rejected`, `restated`) by a human `actor`
 *  is the operator's; every other reason is crew's, whoever asked for the request that led to it. */
export function recordProposalDecision(audit: Pick<AuditLog, 'record'> | undefined, actor: Actor, proposalId: string, reason: ProposalDecisionReason, copyId?: string): void {
  const by = PERSON_REASONS.has(reason) && actor.kind === 'human' ? 'operator' : 'crew';
  audit?.record(PROPOSAL_DECIDED, actor, { detail: { proposalId, by, reason, ...(copyId !== undefined ? { copy_id: copyId } : {}) } });
}

/** One audit line as a decision, or null when it is not a well-formed `proposal.decided` line. */
export function decisionOf(e: Pick<AuditEntry, 'ts' | 'action' | 'actor' | 'detail'>): { id: string; decision: ProposalDecision } | null {
  if (e.action !== PROPOSAL_DECIDED || typeof e.ts !== 'number') return null;
  const d = (typeof e.detail === 'object' && e.detail !== null ? e.detail : {}) as Record<string, unknown>;
  const id = d['proposalId'];
  const reason = d['reason'];
  if (typeof id !== 'string' || id === '' || typeof reason !== 'string' || !REASONS.has(reason)) return null;
  // Only a person's line, for a person's reason, says a person decided.
  const by = d['by'] === 'operator' && e.actor?.kind === 'human' && PERSON_REASONS.has(reason as ProposalDecisionReason) ? 'operator' : 'crew';
  const copy = d['copy_id'];
  return {
    id,
    decision: { by, reason: reason as ProposalDecisionReason, at: Math.floor(e.ts / 1000), ...(typeof copy === 'string' && copy !== '' ? { copy_id: copy } : {}) },
  };
}

/**
 * Every decision on the trail, by proposal id: read once from the trail on first use, then from each line as it is
 * recorded. The newest line for a proposal wins.
 */
export class ProposalDecisionIndex {
  private readonly byId = new Map<string, { ts: number; decision: ProposalDecision }>();
  private hydrated: Promise<void> | null = null;

  constructor(private readonly audit: Partial<Pick<AuditLog, 'onRecord' | 'readAll'>> | undefined, private readonly log?: (m: string) => void) {
    if (typeof audit?.onRecord === 'function') audit.onRecord((e) => this.apply(e));
  }

  private apply(e: AuditEntry): void {
    const got = decisionOf(e);
    if (got === null) return;
    const have = this.byId.get(got.id);
    if (have === undefined || e.ts >= have.ts) this.byId.set(got.id, { ts: e.ts, decision: got.decision });
  }

  /** The decisions, once the trail is read (never rejects: an unreadable trail leaves what was recorded since). */
  async decisions(): Promise<ReadonlyMap<string, ProposalDecision>> {
    this.hydrated ??= (async () => {
      if (typeof this.audit?.readAll !== 'function') return;
      try {
        for (const e of await this.audit.readAll({ action: PROPOSAL_DECIDED })) this.apply(e);
      } catch (err) {
        this.log?.(`[proposals] the trail could not be read for proposal decisions: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    await this.hydrated;
    return new Map([...this.byId].map(([id, v]) => [id, v.decision]));
  }
}
