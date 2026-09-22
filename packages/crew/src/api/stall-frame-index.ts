/**
 * The run→watchdog-frame index (wicked-studio#284; the crew companion L8 handed to L3).
 *
 * The stall watchdog's `workerStalled` / `workerStallEscalated` frames are DAEMON-SYNTHETIC: the
 * engine's event log never sees them, so `GET /runs/:id/events` — the only history a RELOADED run
 * page reads — showed nothing of the "needs you" story the live socket carried.
 *
 * Remembering them inside the watchdog fixed the reload only while the run stayed executing and the
 * daemon stayed up. Both halves failed exactly where the finding lives: the watchdog prunes a run's
 * state the moment it leaves the executing listing (completed / cancelled / awaiting_human — which
 * is precisely when a human opens the page to find out what happened), and a restart forgot
 * everything. So the frames are held HERE, and the durable record is the audit trail — the same
 * mechanism every other restart-surviving daemon fact already uses (`RetryIndex`, `GroupIndex`,
 * `RunTimingIndex`, crew#600's `run.ended`): the server writes ONE audit entry per frame it
 * broadcasts and hydrates this map from those entries at boot.
 *
 * Nothing is re-emitted at boot. Hydration fills a map; it never broadcasts, never reassigns and
 * never re-arms a clock — a restarted daemon SHOWS the old frames and re-detects a stall only when
 * its own quiet clock trips. No new state-home root and no core fence-registry entry: the trail is
 * a file crew already owns and already wrote on every escalation (crew#341).
 */

import type { AuditEntry, WorkerStallEscalatedFrame, WorkerStalledFrame } from '../core/types.js';

/** A watchdog frame as the daemon REMEMBERS it for `GET /runs/:id/events`: the `/ws` frame plus the
 *  capture-time `ts` (the audit entry's own stamp, so the live answer and the post-restart
 *  rehydrate agree to the millisecond) and a `daemon: true` marker — it is daemon-authored, so the
 *  engine's event log never gave it a `seq` (the events route stamps one at serve time). */
export type RecordedStallFrame = (WorkerStalledFrame | WorkerStallEscalatedFrame) & {
  ts: number;
  daemon: true;
};

/** Audit action for a DETECTION frame (`workerStalled`) — new in crew 0.7.36 with this index. */
export const STALL_DETECTED_ACTION = 'run.stall.detected';

/** Audit action for an ESCALATION frame (`workerStallEscalated`) — the line crew#341 already wrote,
 *  spelling unchanged, so trails written by earlier daemons hydrate here without a migration. */
export const STALL_ESCALATED_ACTION = 'run.stall.escalated';

/** Per-run cap on remembered frames — a wedged run emits one detection per quiet period and at most
 *  `maxPerRun` escalations, so this is a backstop, not a budget. The NEWEST frames survive it. */
export const STALL_FRAME_CAP = 64;

/** The audit action a frame is recorded under. */
export function stallFrameAction(frame: WorkerStalledFrame | WorkerStallEscalatedFrame): string {
  return frame.type === 'workerStalled' ? STALL_DETECTED_ACTION : STALL_ESCALATED_ACTION;
}

/** …and back: the frame type an audit action names. Anything else in the trail is not ours. */
const TYPE_FOR_ACTION: Readonly<Record<string, RecordedStallFrame['type']>> = {
  [STALL_DETECTED_ACTION]: 'workerStalled',
  [STALL_ESCALATED_ACTION]: 'workerStallEscalated',
};

export class StallFrameIndex {
  /** run id → its remembered frames, oldest first. */
  private readonly byRun = new Map<string, RecordedStallFrame[]>();

  /**
   * Remember a frame the watchdog just broadcast. `ts` is the durable stamp the audit entry got
   * (`AuditLog.record`'s return), so what this answers now and what a restart rehydrates are the
   * same instant; a disabled/failed trail (`0`) falls back to the wall clock rather than losing the
   * frame from the live answer.
   */
  record(frame: WorkerStalledFrame | WorkerStallEscalatedFrame, ts: number): void {
    const at = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
    this.push(frame.session, { ...frame, ts: at, daemon: true } as RecordedStallFrame);
  }

  /**
   * Rebuild the frames from pre-read audit entries — the boot seam, fed the `run.stall.detected` +
   * `run.stall.escalated` scans (`readAll` answers newest first; each run's list is sorted oldest
   * first here and capped to the NEWEST {@link STALL_FRAME_CAP}).
   *
   * The entry's `detail` is the frame minus `type` and `session`, which is how the server writes it;
   * both are restored from the entry itself and are spread LAST, so a malformed or stale `detail`
   * can never rewrite which run or which kind a frame belongs to. An entry with another action, no
   * run id, no usable `ts` or no object `detail` is skipped — a trail is append-only and may carry
   * lines from any crew version.
   */
  hydrateFromEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      const type = TYPE_FOR_ACTION[entry.action];
      if (type === undefined) continue;
      if (typeof entry.runId !== 'string' || entry.runId === '') continue;
      if (typeof entry.ts !== 'number' || entry.ts <= 0) continue;
      const detail = entry.detail;
      if (typeof detail !== 'object' || detail === null) continue;
      // NOT `push`: the trail answers newest first, so capping on insertion order here would drop
      // the NEWEST frames. Collect everything, then order by capture time and cap the tail below.
      const list = this.byRun.get(entry.runId) ?? [];
      list.push({
        ...detail,
        type,
        session: entry.runId,
        ts: entry.ts,
        daemon: true,
      } as unknown as RecordedStallFrame);
      this.byRun.set(entry.runId, list);
    }
    for (const list of this.byRun.values()) {
      list.sort((a, b) => a.ts - b.ts);
      if (list.length > STALL_FRAME_CAP) list.splice(0, list.length - STALL_FRAME_CAP);
    }
  }

  /** The frames remembered for `runId`, oldest first. Empty for a run that never stalled — or one
   *  whose stalls predate this daemon's trail. */
  framesFor(runId: string): readonly RecordedStallFrame[] {
    return this.byRun.get(runId) ?? [];
  }

  private push(runId: string, frame: RecordedStallFrame): void {
    const list = this.byRun.get(runId) ?? [];
    list.push(frame);
    if (list.length > STALL_FRAME_CAP) list.splice(0, list.length - STALL_FRAME_CAP);
    this.byRun.set(runId, list);
  }
}
