/**
 * `deterministic:lag` — the registry watching itself (entry `registry-lagging`, §4.3).
 *
 * Fed by the registry's own 30 s tick (and at once when the push ring sheds). Lagging means the
 * ring is over its depth threshold, the bus pull is more than `tail_lag_ms` behind the bus tail, or
 * the ring shed an input since the last tick. One flag per episode, run-less ("for whoever runs
 * studio"); the episode's flag clears when a tick finds the registry caught up.
 */

import { z } from 'zod';
import type { WatchCheck } from '../types.js';

const Threshold = z
  .object({
    queue_depth: z.number().int().min(1).max(100_000),
    tail_lag_ms: z.number().int().min(1_000).max(3_600_000),
  })
  .strict();
type Threshold = z.infer<typeof Threshold>;

interface LagBag {
  episode: number | null;
  shedSeen: number;
}

export const lagCheck: WatchCheck<Record<string, never>, Threshold> = {
  name: 'deterministic:lag',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: Threshold,
  evaluate(_input, state, _params, t, ctx) {
    const s = ctx.stats();
    const bag = (state.bag.get('lag') as LagBag | undefined) ?? { episode: null, shedSeen: 0 };
    state.bag.set('lag', bag);
    const shedNow = s.shedTotal > bag.shedSeen;
    bag.shedSeen = s.shedTotal;
    const lagging = s.queueDepth >= t.queue_depth || s.tailLagMs > t.tail_lag_ms || shedNow;
    if (lagging && bag.episode === null) {
      bag.episode = ctx.now();
      const why = shedNow
        ? 'it had to drop some low-priority events'
        : s.tailLagMs > t.tail_lag_ms
          ? `it is ${Math.round(s.tailLagMs / 1000)} s behind the event bus`
          : `${s.queueDepth} events are waiting to be checked`;
      return [
        {
          op: 'raise',
          subject: `lag:${bag.episode}`,
          sentence: `Watching is falling behind: ${why}.`,
          facts: { queue_depth: s.queueDepth, queue_hwm: s.queueHwm, shed_total: s.shedTotal, tail_lag_ms: s.tailLagMs },
          re: 'registry.tick',
        },
      ];
    }
    if (!lagging && bag.episode !== null) {
      const subject = `lag:${bag.episode}`;
      bag.episode = null;
      return [{ op: 'clear', subject }];
    }
    return [];
  },
  coverage: () => null,
  describe: (t) =>
    `When ${t.queue_depth} or more events are waiting, watching is more than ${Math.round(t.tail_lag_ms / 1000)} s behind the bus, or an event had to be dropped`,
};
