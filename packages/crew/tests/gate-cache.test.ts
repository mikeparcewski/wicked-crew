// Unit tests: gate-prompt cache + durable replay (src/api/gate-cache.ts).
//
// FINDING-051: every path into this cache was prune-only, so a daemon restart dropped the map and
// nothing could put an entry back. A run stayed parked at `awaiting_human` while the operator was
// never shown what they were being asked to approve — and the prompt had been on disk the whole
// time, in the event log core writes. These pin the read that closes that, and pin it to the SAME
// fold the live stream uses, because a second hand-written fold would only ever drift after a
// restart: the one condition nobody exercises.

import { describe, expect, it } from 'vitest';
import { GateCache } from '../src/api/gate-cache.js';
import type { CoreEvent, SessionView } from '../src/core/types.js';

const RUN = 'verify-022-155143';

/** A log entry as `runEvents` returns it: the `/ws` frame plus a capture-time `ts` and a `seq`. */
function logged(type: string, extra: Record<string, unknown> = {}, ts = 1_785_614_004_730): CoreEvent {
  return { type, session: RUN, ts, ...extra } as CoreEvent;
}

/** The real gate that was live when FINDING-051 was found. */
function awaitingHuman(ord = 2, ts?: number): CoreEvent {
  return logged(
    'awaitingHuman',
    { ord, reviewingOrd: null, prompt: `Approve unit ${ord} before it runs: design` },
    ts,
  );
}

/** A `sessionsDetail()` view, reduced to the one field `reconcile` reads. */
function view(id: string, status: string): SessionView {
  return { session: { id, status }, units: [] } as unknown as SessionView;
}

describe('GateCache', () => {
  it('serves a gate the live stream delivered', () => {
    const cache = new GateCache();
    cache.ingest(awaitingHuman());
    expect(cache.get(RUN)).toMatchObject({ ord: 2, lifecycle: 'open' });
  });

  it('rebuilds an open gate from the durable log after the cache is gone', () => {
    // The restart: nothing was ingested, so the map is empty — exactly the 404 state.
    const cache = new GateCache();
    expect(cache.get(RUN)).toBeUndefined();

    const entry = cache.rebuild(RUN, [
      logged('sessionStarted'),
      logged('unitDone', { ord: 1 }),
      awaitingHuman(2),
    ]);
    expect(entry).toMatchObject({ ord: 2, prompt: expect.stringContaining('Approve unit 2') });
    // Adopted, so the next read is a cache hit rather than another log replay.
    expect(cache.get(RUN)).toEqual(entry);
  });

  it('does not resurrect a gate the run already moved past', () => {
    // The whole rule: the LAST awaitingHuman not followed by a resumed/terminal event. Replaying a
    // closed gate would show an operator a question that has already been answered.
    const cache = new GateCache();
    for (const closing of ['resumed', 'sessionCompleted', 'runCancelled', 'sessionFailed']) {
      expect(cache.rebuild(RUN, [awaitingHuman(2), logged(closing, { ord: 2 })])).toBeUndefined();
      expect(cache.get(RUN)).toBeUndefined();
    }
  });

  it('serves the second gate when a run pauses, resumes, then pauses again', () => {
    const cache = new GateCache();
    const entry = cache.rebuild(RUN, [
      awaitingHuman(2),
      logged('resumed', { ord: 2 }),
      awaitingHuman(5),
    ]);
    expect(entry?.ord).toBe(5);
  });

  it('stamps a replayed gate with the event time, not the replay time', () => {
    // Studio sorts the open-gate list newest-first on `receivedAt`. Stamping a rebuild with "now"
    // would collapse every gate to the restart instant and scramble that order.
    const cache = new GateCache();
    const ts = 1_785_614_004_730;
    expect(cache.rebuild(RUN, [awaitingHuman(2, ts)])?.receivedAt).toBe(new Date(ts).toISOString());
  });

  it('reports no gate for a run whose history is empty or unknown', () => {
    // An absent history is not an error — a run that emitted nothing, or one predating the log.
    const cache = new GateCache();
    expect(cache.rebuild(RUN, [])).toBeUndefined();
    expect(cache.rebuild(RUN, [logged('unitDone', { ord: 1 })])).toBeUndefined();
  });

  it('replays only the requested run out of a mixed history', () => {
    const cache = new GateCache();
    const other: CoreEvent = { type: 'awaitingHuman', session: 'other-run', ord: 9, prompt: 'x' } as CoreEvent;
    expect(cache.rebuild(RUN, [other])).toBeUndefined();
    expect(cache.rebuild(RUN, [other, awaitingHuman(2)])?.ord).toBe(2);
  });

  it('drops a rebuilt entry once the run is no longer awaiting', () => {
    // Self-healing still applies to an adopted replay — it is a cache, not a second source of truth.
    const cache = new GateCache();
    cache.rebuild(RUN, [awaitingHuman(2)]);
    cache.reconcile([view(RUN, 'completed')]);
    expect(cache.get(RUN)).toBeUndefined();
  });

  it('ignores a malformed gate event rather than caching a blank prompt', () => {
    // A gate with no question is worse than no gate: it renders an empty approval dialog.
    const cache = new GateCache();
    expect(cache.rebuild(RUN, [logged('awaitingHuman', { ord: 2 })])).toBeUndefined();
    expect(cache.rebuild(RUN, [logged('awaitingHuman', { prompt: 'no ord' })])).toBeUndefined();
  });
});
