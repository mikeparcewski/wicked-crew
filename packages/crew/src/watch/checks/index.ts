/**
 * The check map (DES-TRIGGER-REGISTRY-001 §4.4): name → implementation, the ONE place a check is
 * named. Each crew slice adds one line here (TR-W5b, W6, W7, W9), which is why they land in
 * sequence. An entry naming a check that is not here is refused at load.
 */

import type { WatchCheck } from '../types.js';
import { checkFailedCheck } from './check-failed.js';
import { claimVsEvidenceCheck } from './claim-vs-evidence.js';
import { deliverAuditCheck } from './deliver-audit.js';
import { addedByHandCheck, whatCatchesCheck } from './discovery.js';
import { lagCheck } from './lag.js';
import { quietAfterClaimCheck } from './quiet-after-claim.js';
import { scopeDriftCheck } from './scope-drift.js';
import { helpUnansweredCheck, pathRepickedCheck, reviewerAbsentCheck } from './team-path.js';
import { ungatedCheck } from './ungated.js';
import { warnedRuleCheck } from './warned-rule.js';

export const SHIPPED_CHECKS: ReadonlyMap<string, WatchCheck> = new Map<string, WatchCheck>([
  [lagCheck.name, lagCheck as unknown as WatchCheck],
  [checkFailedCheck.name, checkFailedCheck as unknown as WatchCheck],
  // TR-W5b
  [deliverAuditCheck.name, deliverAuditCheck as unknown as WatchCheck],
  [ungatedCheck.name, ungatedCheck as unknown as WatchCheck],
  [quietAfterClaimCheck.name, quietAfterClaimCheck as unknown as WatchCheck],
  // TR-W6
  [claimVsEvidenceCheck.name, claimVsEvidenceCheck as unknown as WatchCheck],
  [warnedRuleCheck.name, warnedRuleCheck as unknown as WatchCheck],
  // TR-W7
  [scopeDriftCheck.name, scopeDriftCheck as unknown as WatchCheck],
  // WT-W4 (DES-walkthrough-proof §4.13: discovery, propose-only)
  [addedByHandCheck.name, addedByHandCheck as unknown as WatchCheck],
  [whatCatchesCheck.name, whatCatchesCheck as unknown as WatchCheck],
  // ASK-C3 (DES-ASK-TEAM-CHAT-001 §4.1, §4.5, §4.6: the ask path's team facts)
  [pathRepickedCheck.name, pathRepickedCheck as unknown as WatchCheck],
  [reviewerAbsentCheck.name, reviewerAbsentCheck as unknown as WatchCheck],
  [helpUnansweredCheck.name, helpUnansweredCheck as unknown as WatchCheck],
]);
