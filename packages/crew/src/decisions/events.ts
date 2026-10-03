/**
 * Decision capture's bus facts (DES-decision-capture §4.6, DC-S4a). Post-commit only; domain
 * column `wicked-crew` (the project bus's emit). Payloads carry ids and counts, NEVER words — the
 * engine's rule — so the operator's words stay in the 0600 ledger. Idempotency keys are
 * type-inclusive and occurrence-unique. (`wicked.crew.rule.considered` is DC-S7's.)
 */

export const DECISION_DETECTED = 'wicked.crew.decision.detected';
export const DECISION_OFFERED = 'wicked.crew.decision.offered';
export const DECISION_REMEMBERED = 'wicked.crew.decision.remembered';
export const DECISION_UNDONE = 'wicked.crew.decision.undone';
export const DECISION_DISMISSED = 'wicked.crew.decision.dismissed';
export const DECISION_RESTATED = 'wicked.crew.decision.restated';
export const DECISION_WIDENED = 'wicked.crew.decision.widened';
/** DC-S7 (§4.6): counts and ids only — `considered:<chat>:<turn>` / `considered:<run>:<ord>:<attempt>`. */
export const RULE_CONSIDERED = 'wicked.crew.rule.considered';

export interface DecisionBusEmit {
  (type: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<boolean>;
}

/** The fact for one decision event — the payload is ids/enums/counts only (a test pins no words). */
export function decisionFact(
  type: string,
  payload: Record<string, string | number | boolean | null | undefined>,
  key: string,
): { type: string; payload: Record<string, string | number | boolean | null>; key: string } {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(payload)) if (v !== undefined) clean[k] = v;
  return { type, payload: clean, key };
}
