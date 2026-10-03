/**
 * `deterministic:ungated` — entry `ungated` (DES-TRIGGER-REGISTRY-001 §4.3 row 2, TR-W5b).
 *
 * A projection of the engine's own `gateEvaluated.ungated` and `ungatedReason` (the entry's filter
 * is empty, so every gate counts toward coverage; only `ungated === true` raises): it computes nothing, and a judge-verified PASS without a floor is gated and
 * never flagged (S5). The engine says such a unit "must be rendered as UNGATED, never as pass", so
 * the flag is a `problem`, never "Finished". `gateEvaluated` carries no attempt; the attempt comes
 * from the unit's `unitOutputCaptured`, emitted before the gate runs (joined).
 */

import { z } from 'zod';
import type { WatchCheck } from '../types.js';

interface Bag {
  attemptByOrd: Map<number, number>;
  /** Gates that SAID whether they were gated (a boolean `ungated`). */
  gates: number;
  /** Gates from an engine before the field (no `ungated`): this projection cannot tell. */
  silent: number;
}

const REASON_MAX = 200;

export const ungatedCheck: WatchCheck<Record<string, never>, Record<string, never>> = {
  name: 'deterministic:ungated',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  evaluate(input, state) {
    const bag = (state.bag.get('ungated') as Bag | undefined) ?? { attemptByOrd: new Map(), gates: 0, silent: 0 };
    state.bag.set('ungated', bag);
    const e = input.event;
    const ord = typeof e['ord'] === 'number' ? e['ord'] : null;
    if (ord === null) return [];
    if (input.type === 'unitOutputCaptured') {
      if (typeof e['attempt'] === 'number') bag.attemptByOrd.set(ord, e['attempt']);
      return [];
    }
    if (input.type !== 'gateEvaluated') return [];
    if (typeof e['ungated'] !== 'boolean') {
      bag.silent++;
      return [];
    }
    bag.gates++;
    if (e['ungated'] !== true) return [];
    const attempt = bag.attemptByOrd.get(ord) ?? null;
    const raw = typeof e['ungatedReason'] === 'string' ? e['ungatedReason'].trim() : '';
    const reason = raw.length > REASON_MAX ? `${raw.slice(0, REASON_MAX - 1)}…` : raw;
    return [
      {
        op: 'raise',
        subject: `${ord}:${attempt ?? '-'}:ungated`,
        sentence: reason !== '' ? `Nothing checked this step: ${reason}` : 'Nothing checked this step.',
        facts: { ungated_reason: reason },
        ord,
        attempt,
        re: `gateEvaluated#${ord}`,
      },
    ];
  },
  coverage(state) {
    const bag = state.bag.get('ungated') as Bag | undefined;
    if (bag !== undefined && bag.gates > 0) return { state: 'checked' };
    if (bag !== undefined && bag.silent > 0) {
      return { state: 'not_checked', reason: 'the engine is too old to say whether a step was checked' };
    }
    return { state: 'not_checked', reason: 'no step has reached its gate yet' };
  },
  describe: () => 'When a step finishes with nothing checking it: no checks, no judge, no policy',
};
