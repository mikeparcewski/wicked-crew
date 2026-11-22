/**
 * crew#1261: who rejected a proposal, and why. estate's queue keeps only `state: rejected`; three different things end
 * there, and a client cannot tell them apart from the row (`payload.edited_from` is a field any filer can set):
 *
 *  - `operator` / `rejected`: a person turned it down (`POST /proposals/:id/reject`, or dismissing its decision).
 *  - `crew` / `replaced-by-edit`: an accept-with-edit approved an edited copy (`copy_id`) and rejected the original.
 *  - `crew` / `withdrawn-copy`: an accept-with-edit's copy whose approve failed, withdrawn so a retry leaves no duplicate.
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

const REASONS: ReadonlySet<string> = new Set<ProposalDecisionReason>(['rejected', 'replaced-by-edit', 'withdrawn-copy']);

/** Record one decision crew made on a proposal. A person's own rejection is `rejected` by a human `actor`; the
 *  accept-with-edit's two are crew's, whoever asked for the accept. */
export function recordProposalDecision(audit: Pick<AuditLog, 'record'> | undefined, actor: Actor, proposalId: string, reason: ProposalDecisionReason, copyId?: string): void {
  const by = reason === 'rejected' && actor.kind === 'human' ? 'operator' : 'crew';
  audit?.record(PROPOSAL_DECIDED, actor, { detail: { proposalId, by, reason, ...(copyId !== undefined ? { copy_id: copyId } : {}) } });
}

/** One audit line as a decision, or null when it is not a well-formed `proposal.decided` line. */
export function decisionOf(e: Pick<AuditEntry, 'ts' | 'action' | 'actor' | 'detail'>): { id: string; decision: ProposalDecision } | null {
  if (e.action !== PROPOSAL_DECIDED || typeof e.ts !== 'number') return null;
  const d = (typeof e.detail === 'object' && e.detail !== null ? e.detail : {}) as Record<string, unknown>;
  const id = d['proposalId'];
  const reason = d['reason'];
  if (typeof id !== 'string' || id === '' || typeof reason !== 'string' || !REASONS.has(reason)) return null;
  // Only a person's line says a person decided.
  const by = d['by'] === 'operator' && e.actor?.kind === 'human' ? 'operator' : 'crew';
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
