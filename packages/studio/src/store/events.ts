import { create } from 'zustand';
import type { CoreEvent } from '../api/types.js';

/**
 * The raw per-run append log the {@link import('../hooks/useRunModel.js').useRunModel}
 * merge folds over. Distinct from the runtime store (which owns high-volume output text +
 * a summarized event log): this keeps the *structured* frames the insight merge needs —
 * lifecycle + the Phase-B insight events — so the merge stays a pure function of them.
 *
 * `cliOutputDelta` (streamed by the runtime store into `outputs`) and heartbeats are
 * dropped here — they carry no structured insight and would flood the buffer.
 */

/** Ring-buffer cap per run (keep the most recent). */
const CAP = 4000;

const IGNORED: ReadonlySet<string> = new Set(['cliOutputDelta', 'heartbeat']);

interface RunEventStore {
  /** Ordered, capped structured frames keyed by run id. */
  byRun: Record<string, CoreEvent[]>;
  /** Fold one CoreEvent (drops output deltas / heartbeats / run-less frames). */
  ingest: (event: CoreEvent) => void;
  /** Drop a run's log. */
  clear: (runId: string) => void;
}

export const useRunEventStore = create<RunEventStore>((set) => ({
  byRun: {},

  ingest: (event) => {
    const session = typeof event.session === 'string' ? event.session : undefined;
    if (session === undefined) return;
    if (IGNORED.has(event.type)) return;
    set((s) => {
      const prev = s.byRun[session] ?? [];
      const next = [...prev, event];
      if (next.length > CAP) next.splice(0, next.length - CAP);
      return { byRun: { ...s.byRun, [session]: next } };
    });
  },

  clear: (runId) =>
    set((s) => {
      if (!(runId in s.byRun)) return s;
      const byRun = { ...s.byRun };
      delete byRun[runId];
      return { byRun };
    }),
}));
