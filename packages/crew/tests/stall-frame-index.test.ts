// wicked-studio#284 — the durable half of the watchdog's frames (`api/stall-frame-index.ts`).
//
// The frames are daemon-authored, so the engine's log never carries them; the audit trail does, and
// this index is the read-side map `GET /runs/:id/events` serves. What matters here is exactly what
// the finding is about: the frames survive the run leaving the executing listing AND this process
// exiting, hydration re-emits nothing, and a trail written by any crew version parses safely.
import { describe, expect, it } from 'vitest';
import {
  STALL_DETECTED_ACTION,
  STALL_ESCALATED_ACTION,
  STALL_FRAME_CAP,
  StallFrameIndex,
  stallFrameAction,
} from '../src/api/stall-frame-index.js';
import type { AuditEntry, WorkerStallEscalatedFrame, WorkerStalledFrame } from '../src/core/types.js';

const RUN = 'r-wedge';

const stalled = (session = RUN, quietForMs = 900_000, ord = 1): WorkerStalledFrame => ({
  type: 'workerStalled',
  session,
  ord,
  quietForMs,
});

const escalated = (session = RUN): WorkerStallEscalatedFrame => ({
  type: 'workerStallEscalated',
  session,
  ord: 1,
  quietForMs: 1_800_000,
  action: 'notify',
  outcome: 'ok',
  needsYou: true,
});

/** An audit line exactly as `server.ts`'s recorder writes it: the frame minus `type`/`session`.
 *  `drop` removes a key outright — an ABSENT field, which is what a malformed trail line really
 *  looks like (and what `exactOptionalPropertyTypes` insists is not the same as `undefined`). */
function entry(
  frame: WorkerStalledFrame | WorkerStallEscalatedFrame,
  ts: number,
  overrides: Partial<AuditEntry> = {},
  drop: string[] = [],
): AuditEntry {
  const { type, session, ...detail } = frame;
  void type;
  const line: Record<string, unknown> = {
    ts,
    action: stallFrameAction(frame),
    actor: { id: 'stall-watchdog', kind: 'system', trust: 'admin' },
    runId: session,
    detail,
    ...overrides,
  };
  for (const key of drop) delete line[key];
  return line as unknown as AuditEntry;
}

describe('stallFrameAction — one action per frame kind', () => {
  it('detections and escalations are recorded under their own actions, the escalation spelling unchanged (crew#341)', () => {
    expect(stallFrameAction(stalled())).toBe(STALL_DETECTED_ACTION);
    expect(stallFrameAction(escalated())).toBe(STALL_ESCALATED_ACTION);
    expect(STALL_ESCALATED_ACTION).toBe('run.stall.escalated');
  });
});

describe('StallFrameIndex — the live record', () => {
  it('stamps the audit ts and daemon:true, keeps insertion order, and answers per run', () => {
    const idx = new StallFrameIndex();
    idx.record(stalled(), 1_000);
    idx.record(escalated(), 2_000);
    idx.record(stalled('r-other'), 1_500);

    expect(idx.framesFor(RUN)).toEqual([
      { type: 'workerStalled', session: RUN, ord: 1, quietForMs: 900_000, ts: 1_000, daemon: true },
      { ...escalated(), ts: 2_000, daemon: true },
    ]);
    expect(idx.framesFor('r-other')).toHaveLength(1);
    expect(idx.framesFor('never-stalled')).toEqual([]);
  });

  it('a disabled or failed trail (ts 0) still records the frame, on the wall clock', () => {
    const idx = new StallFrameIndex();
    const before = Date.now();
    idx.record(stalled(), 0);
    const [frame] = idx.framesFor(RUN);
    expect(frame?.ts).toBeGreaterThanOrEqual(before);
    expect(frame?.daemon).toBe(true);
  });

  it('caps a run at the newest STALL_FRAME_CAP frames', () => {
    const idx = new StallFrameIndex();
    for (let i = 0; i < STALL_FRAME_CAP + 10; i += 1) idx.record(stalled(RUN, i), i + 1);
    const frames = idx.framesFor(RUN);
    expect(frames).toHaveLength(STALL_FRAME_CAP);
    expect(frames[0]?.ts).toBe(11); // the ten oldest were dropped, not the newest
    expect(frames.at(-1)?.ts).toBe(STALL_FRAME_CAP + 10);
  });
});

describe('StallFrameIndex — hydrating from the trail (the restart case)', () => {
  it('rebuilds both frame kinds from audit entries, oldest first, whatever order the trail answers in', () => {
    const idx = new StallFrameIndex();
    // `readAll` answers NEWEST first, and the server feeds the two filtered scans concatenated —
    // so the input is deliberately not in capture order.
    idx.hydrateFromEntries([entry(escalated(), 2_000), entry(stalled(), 1_000)]);

    expect(idx.framesFor(RUN)).toEqual([
      { type: 'workerStalled', session: RUN, ord: 1, quietForMs: 900_000, ts: 1_000, daemon: true },
      { ...escalated(), ts: 2_000, daemon: true },
    ]);
  });

  it('hydration is a read: it fills the map and emits nothing (no broadcast, no reassign, no clock)', () => {
    // The index has no sink to call — the proof is structural, and stated here so a future
    // refactor that gives it one has to face this test. What a restart must NOT do is re-detect.
    const idx = new StallFrameIndex();
    idx.hydrateFromEntries([entry(stalled(), 1_000)]);
    expect(Object.keys(idx)).not.toContain('broadcast');
    expect(idx.framesFor(RUN)).toHaveLength(1);
  });

  it('keeps the NEWEST cap-worth of a long trail, still oldest first', () => {
    const idx = new StallFrameIndex();
    const entries = [];
    for (let i = 0; i < STALL_FRAME_CAP + 5; i += 1) entries.push(entry(stalled(RUN, i), i + 1));
    idx.hydrateFromEntries(entries.reverse()); // newest first, as the trail answers
    const frames = idx.framesFor(RUN);
    expect(frames).toHaveLength(STALL_FRAME_CAP);
    expect(frames[0]?.ts).toBe(6);
    expect(frames.at(-1)?.ts).toBe(STALL_FRAME_CAP + 5);
  });

  it('live frames recorded after a hydrate append to the rehydrated history', () => {
    const idx = new StallFrameIndex();
    idx.hydrateFromEntries([entry(stalled(), 1_000)]);
    idx.record(escalated(), 5_000);
    expect(idx.framesFor(RUN).map((f) => f.type)).toEqual(['workerStalled', 'workerStallEscalated']);
  });

  it('skips what is not ours or not usable: another action, no run id, no ts, no object detail', () => {
    const idx = new StallFrameIndex();
    idx.hydrateFromEntries([
      entry(stalled(), 1_000, { action: 'run.launched' }),
      entry(stalled(), 1_000, {}, ['runId']),
      entry(stalled(), 0),
      entry(stalled(), -5),
      entry(stalled(), 1_000, {}, ['detail']),
      entry(stalled(), 1_000, { detail: null as unknown as Record<string, unknown> }),
      entry(stalled(), 1_000, { runId: '' }),
    ]);
    expect(idx.framesFor(RUN)).toEqual([]);
  });

  it('a stale or malformed detail can never rewrite which run or which kind a frame is', () => {
    const idx = new StallFrameIndex();
    idx.hydrateFromEntries([
      entry(stalled(), 1_000, {
        detail: { ord: 1, quietForMs: 60_000, type: 'sessionCompleted', session: 'r-someone-else', ts: 999, daemon: false },
      }),
    ]);
    expect(idx.framesFor('r-someone-else')).toEqual([]);
    expect(idx.framesFor(RUN)).toEqual([
      { type: 'workerStalled', session: RUN, ord: 1, quietForMs: 60_000, ts: 1_000, daemon: true },
    ]);
  });
});
