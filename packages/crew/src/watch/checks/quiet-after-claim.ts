/**
 * `deterministic:quiet_after_claim` — entry `quiet-after-claim` (DES-TRIGGER-REGISTRY-001 §4.3
 * row 5, TR-W5b).
 *
 * The watchdog's DETECTION frame (`workerStalled`, the `onFrame` tee) after the cursor unit handed
 * back `unitOutputCaptured{stepStatus:"ok"}` — and with no `gateEvaluated` for that unit since — is
 * a contradiction: the step says it is finished, yet nothing moved (R6 "contradicted").
 *
 * The frame carries no attempt and no quiet-start, and a restart never re-arms the watchdog clock,
 * so the subject is `ord:attempt:after-claim` with the attempt from the CLAIM: one finding per
 * claimed attempt however many quiet periods or restarts follow (the key resolves to the row
 * already on the bus). Its gate arriving afterwards clears it. Thresholds stay the watchdog's
 * (`workerStallMinutes`), so this entry has none of its own.
 */

import { z } from 'zod';
import type { WatchCheck } from '../types.js';

interface Claim {
  ord: number;
  attempt: number;
  gated: boolean;
  raised: boolean;
}

interface Bag {
  /** The latest ok claim per ord. */
  claims: Map<number, Claim>;
  /** The most recent claim's ord (a frame without `ord` is about the cursor unit). */
  lastOrd: number | null;
  seen: number;
}

export const quietAfterClaimCheck: WatchCheck<Record<string, never>, Record<string, never>> = {
  name: 'deterministic:quiet_after_claim',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  evaluate(input, state) {
    const bag = (state.bag.get('quiet') as Bag | undefined) ?? { claims: new Map(), lastOrd: null, seen: 0 };
    state.bag.set('quiet', bag);
    const e = input.event;
    const ord = typeof e['ord'] === 'number' ? e['ord'] : null;
    switch (input.type) {
      case 'unitOutputCaptured': {
        bag.seen++;
        if (ord === null || typeof e['attempt'] !== 'number') return [];
        if (e['stepStatus'] !== 'ok') {
          bag.claims.delete(ord);
          return [];
        }
        bag.claims.set(ord, { ord, attempt: e['attempt'], gated: false, raised: false });
        bag.lastOrd = ord;
        return [];
      }
      case 'gateEvaluated': {
        if (ord === null) return [];
        const claim = bag.claims.get(ord);
        if (claim === undefined) return [];
        claim.gated = true;
        // Clear unconditionally: after a restart the replay rebuilds the claim with `raised: false`
        // (watchdog frames are not replayed), yet the hydrated row may be open. A clear naming no
        // row is a no-op in the emitter (codex on TR-W5b).
        return [{ op: 'clear', subject: `${claim.ord}:${claim.attempt}:after-claim` }];
      }
      case 'workerStalled': {
        bag.seen++;
        // The DETECTION frame carries `quietForMs`; the engine's PTY-path event of the same name
        // carries `stalledSecs` and is not this input.
        if (typeof e['quietForMs'] !== 'number') return [];
        const at = ord ?? bag.lastOrd;
        if (at === null) return [];
        const claim = bag.claims.get(at);
        if (claim === undefined || claim.gated || claim.raised) return [];
        claim.raised = true;
        const minutes = Math.max(1, Math.round(e['quietForMs'] / 60_000));
        return [
          {
            op: 'raise',
            subject: `${claim.ord}:${claim.attempt}:after-claim`,
            sentence: `Says it's finished, but nothing new in ${minutes} min.`,
            facts: { quiet_for_ms: e['quietForMs'] },
            ord: claim.ord,
            attempt: claim.attempt,
            re: `workerStalled#${claim.ord}`,
          },
        ];
      }
      default:
        return [];
    }
  },
  coverage(state) {
    const bag = state.bag.get('quiet') as Bag | undefined;
    if (bag !== undefined && bag.seen > 0) return { state: 'checked' };
    return { state: 'not_checked', reason: 'no step has handed back yet' };
  },
  describe: () => "When a step says it's finished but the run then goes quiet past the stall watchdog's threshold",
};
