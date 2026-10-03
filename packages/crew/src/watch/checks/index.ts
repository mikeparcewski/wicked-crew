/**
 * The check map (DES-TRIGGER-REGISTRY-001 §4.4): name → implementation, the ONE place a check is
 * named. Each crew slice adds one line here (TR-W5b, W6, W7, W9), which is why they land in
 * sequence. An entry naming a check that is not here is refused at load.
 */

import type { WatchCheck } from '../types.js';
import { checkFailedCheck } from './check-failed.js';
import { deliverAuditCheck } from './deliver-audit.js';
import { lagCheck } from './lag.js';
import { quietAfterClaimCheck } from './quiet-after-claim.js';
import { ungatedCheck } from './ungated.js';

export const SHIPPED_CHECKS: ReadonlyMap<string, WatchCheck> = new Map<string, WatchCheck>([
  [lagCheck.name, lagCheck as unknown as WatchCheck],
  [checkFailedCheck.name, checkFailedCheck as unknown as WatchCheck],
  // TR-W5b
  [deliverAuditCheck.name, deliverAuditCheck as unknown as WatchCheck],
  [ungatedCheck.name, ungatedCheck as unknown as WatchCheck],
  [quietAfterClaimCheck.name, quietAfterClaimCheck as unknown as WatchCheck],
]);
