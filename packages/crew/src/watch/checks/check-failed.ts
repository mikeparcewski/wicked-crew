/**
 * `deterministic:check_failed` — a check that keeps throwing or timing out (entry
 * `registry-check-failed`, §4.3, §6).
 *
 * The deterministic lane reports every throw and every timeout as an internal key point. Past
 * `failures` of one entry inside `window_minutes`, one run-less flag for that entry's episode. A
 * failed check never emits "fine": its runs' coverage already says it did not check.
 */

import { z } from 'zod';
import type { CheckOutput, WatchCheck } from '../types.js';

const Threshold = z
  .object({
    failures: z.number().int().min(1).max(1_000),
    window_minutes: z.number().int().min(1).max(1_440),
  })
  .strict();
type Threshold = z.infer<typeof Threshold>;

interface Episode {
  times: number[];
  open: number | null;
}

export const checkFailedCheck: WatchCheck<Record<string, never>, Threshold> = {
  name: 'deterministic:check_failed',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: Threshold,
  evaluate(input, state, _params, t, ctx) {
    const entryId = typeof input.event['entry_id'] === 'string' ? input.event['entry_id'] : null;
    if (entryId === null) return [];
    const reason = input.event['reason'] === 'timeout' ? 'timed out' : 'failed';
    const now = ctx.now();
    const windowMs = t.window_minutes * 60_000;
    const ep = (state.bag.get(entryId) as Episode | undefined) ?? { times: [], open: null };
    state.bag.set(entryId, ep);
    // A quiet window closes the episode AND clears its flag: the next burst is a new flag.
    const out: CheckOutput[] = [];
    const last = ep.times[ep.times.length - 1];
    if (ep.open !== null && last !== undefined && now - last > windowMs) {
      out.push({ op: 'clear', subject: `check-failed:${entryId}:${ep.open}` });
      ep.open = null;
    }
    ep.times = ep.times.filter((x) => now - x <= windowMs);
    ep.times.push(now);
    if (ep.open !== null || ep.times.length < t.failures) return out;
    ep.open = now;
    return [
      ...out,
      {
        op: 'raise',
        subject: `check-failed:${entryId}:${ep.open}`,
        sentence: `The "${entryId}" check ${reason} ${ep.times.length} times in ${t.window_minutes} min, so it is not checking right now.`,
        facts: { entry_id: entryId, failures: ep.times.length, last: reason },
        re: 'registry.check_failed',
      },
    ];
  },
  coverage: () => null,
  describe: (t) => `When one check fails or times out ${t.failures} times within ${t.window_minutes} min`,
};
