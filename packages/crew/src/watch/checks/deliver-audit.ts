/**
 * `deterministic:deliver_audit` — entry `deliver-audit` (DES-TRIGGER-REGISTRY-001 §4.3 row 3, TR-W5b).
 *
 * A sequence check over the engine's own facts, nothing parsed: the deliver unit's
 * `deliverLiftEvaluated.outcome`, joined to the same (session, ord, attempt)'s next
 * `repoChecksEvaluated`, with the unit's end (`unitOutputCaptured` or `gateEvaluated` for that ord)
 * closing the window.
 *
 * - `lifted` and the unit ends with NO re-check for that attempt → FINDING high: the tree that ships
 *   was moved onto the remote tip and never re-verified. (A re-check that ran and FAILED is not a
 *   finding: the engine failed the unit and pushed nothing.) A re-check arriving later clears it.
 * - `skipped` → flag medium at once: the lift could not be decided, so the tree that ships was not
 *   re-verified on the remote tip (the deliver script's own rebase stands).
 * - `conflict` / `failed` → flag info: the engine already failed the unit; this only names it.
 * - `unchanged` → nothing.
 */

import { z } from 'zod';
import type { CheckOutput, WatchCheck } from '../types.js';

interface Lift {
  ord: number;
  attempt: number;
  rechecked: boolean;
  raised: boolean;
}

interface Bag {
  lifts: Map<string, Lift>;
  outcomes: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const keyOf = (ord: number, attempt: number): string => `${ord}:${attempt}`;

export const deliverAuditCheck: WatchCheck<Record<string, never>, Record<string, never>> = {
  name: 'deterministic:deliver_audit',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  evaluate(input, state) {
    const bag = (state.bag.get('deliver') as Bag | undefined) ?? { lifts: new Map(), outcomes: 0 };
    state.bag.set('deliver', bag);
    const e = input.event;
    const ord = num(e['ord']);
    const attempt = num(e['attempt']);
    switch (input.type) {
      case 'deliverLiftEvaluated': {
        if (ord === null || attempt === null) return [];
        bag.outcomes++;
        const outcome = typeof e['outcome'] === 'string' ? e['outcome'] : '';
        const re = `deliverLiftEvaluated#${ord}:${attempt}`;
        if (outcome === 'lifted') {
          bag.lifts.set(keyOf(ord, attempt), { ord, attempt, rechecked: false, raised: false });
          return [];
        }
        if (outcome === 'skipped') {
          const note = typeof e['note'] === 'string' && e['note'] !== '' ? ` (${e['note'].slice(0, 160)})` : '';
          return [
            {
              op: 'raise',
              subject: `${ord}:${attempt}:lift-skipped`,
              kind: 'flag',
              severity: 'medium',
              sentence: `The tree that ships was not re-checked on the newest main: the lift was skipped${note}.`,
              facts: { outcome, base_ref: e['baseRef'] ?? null },
              ord,
              attempt,
              re,
            },
          ];
        }
        if (outcome === 'conflict' || outcome === 'failed') {
          const conflicts = Array.isArray(e['conflicts']) ? (e['conflicts'] as unknown[]).filter((c) => typeof c === 'string').slice(0, 10) : [];
          return [
            {
              op: 'raise',
              subject: `${ord}:${attempt}:lift-${outcome}`,
              kind: 'flag',
              severity: 'info',
              sentence:
                outcome === 'conflict'
                  ? `Delivery stopped: the work would conflict with the newest main${conflicts.length > 0 ? ` in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}` : ''}. Nothing was pushed.`
                  : 'Delivery stopped: moving the work onto the newest main failed part-way. Nothing was pushed.',
              facts: { outcome, conflicts },
              ord,
              attempt,
              re,
            },
          ];
        }
        return [];
      }
      case 'repoChecksEvaluated': {
        if (ord === null || attempt === null) return [];
        const lift = bag.lifts.get(keyOf(ord, attempt));
        if (lift === undefined) return [];
        lift.rechecked = true;
        // A late re-check resolves a raised finding (passing or failing: either way it ran). Cleared
        // unconditionally — a restart may hold the row open while this life never raised it; a
        // clear naming no row is a no-op in the emitter.
        lift.raised = false;
        return [{ op: 'clear', subject: `${ord}:${attempt}:lift-unverified` }];
      }
      case 'unitOutputCaptured':
      case 'gateEvaluated': {
        if (ord === null) return [];
        const out: CheckOutput[] = [];
        for (const lift of bag.lifts.values()) {
          if (lift.ord !== ord || lift.rechecked || lift.raised) continue;
          // `gateEvaluated` carries no attempt: it closes every open lift of its unit.
          if (input.type === 'unitOutputCaptured' && attempt !== null && attempt !== lift.attempt) continue;
          lift.raised = true;
          out.push({
            op: 'raise',
            subject: `${lift.ord}:${lift.attempt}:lift-unverified`,
            kind: 'finding',
            severity: 'high',
            sentence: 'The work was moved onto the newest main before delivery, and the moved tree was never re-checked.',
            facts: { outcome: 'lifted', rechecked: false },
            ord: lift.ord,
            attempt: lift.attempt,
            re: `deliverLiftEvaluated#${lift.ord}:${lift.attempt}`,
          });
        }
        return out;
      }
      default:
        return [];
    }
  },
  coverage(state) {
    const bag = state.bag.get('deliver') as Bag | undefined;
    if (bag !== undefined && bag.outcomes > 0) return { state: 'checked' };
    return { state: 'not_checked', reason: 'nothing was delivered on this run yet' };
  },
  describe: () =>
    'When delivery moves the work onto the newest main and the moved tree is not re-checked, or the move is skipped, conflicts or fails',
};
