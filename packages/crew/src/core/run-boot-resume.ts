/**
 * Boot-time run crash-resume (crew#830) — the run-level twin of `campaign/boot-resume.ts`.
 *
 * A daemon that dies mid-run leaves the run persisted `executing`: its worker was in the dead
 * process, and the engine's in-process path claims no cross-restart durability, so on the next
 * boot it does NOT redrive the run. It does say so: actor bootstrap emits a `runOrphaned` frame
 * into the run's durable event log for every `executing` session it restored no worker for
 * (core#124, `report_orphaned_executing_sessions`), naming `POST /runs/:id/resume` as the remedy.
 * Observed live (rig, 2026-10-06): the frame was written, the run stayed `executing` with no
 * process behind it, and nothing moved it until an operator POSTed the resume by hand — which
 * re-entered the cursor unit within seconds. The engine's resume path is sound; nobody called it.
 *
 * So at boot the daemon calls it, once, for every run whose trail ENDS on `runOrphaned`. The
 * tail-of-trail read is what separates a zombie from a live run: a session the armed exec path
 * redrove keeps `executing` too, but its trail continues past any orphan frame (a fresh
 * `unitDispatched`), and a run the operator cancelled between the crash and the boot is no longer
 * `executing` at all. A refused resume is logged and reported, never thrown — boot must finish.
 *
 * Ordering: the engine's orphan scan runs on actor bootstrap, BEFORE the actor answers its first
 * command, so by the time `sessionsDetail()` resolves every orphan frame the engine will write for
 * this boot is already in the log. No wait, no race.
 */

import type { Actor, RecordedEvent, SessionView } from './types.js';

/** The frame the engine writes for a run it left `executing` without a worker (core#124). */
export const RUN_ORPHANED_EVENT = 'runOrphaned';

/** The three engine calls the sweep needs (the real `CoreAdapter` has all of them). */
export interface RunResumeSurface {
  sessionsDetail(): Promise<SessionView[]>;
  /** `null` = the binding lacks the capability (the `runEvents` doctrine) — nothing is resumed. */
  runEvents(runId: string): Promise<RecordedEvent[] | null>;
  resumeRun(runId: string): Promise<string>;
}

/** The trail writer the sweep records `run.resumed {via: 'boot'}` through (an `AuditLog`). */
export interface RunResumeAudit {
  record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): number;
}

export interface BootRunResumeResult {
  /** Runs the engine was asked to resume, with the unit ord the orphan frame named and the status token it answered. */
  resumed: Array<{ id: string; ord: number | undefined; status: string }>;
  /** Runs whose resume the engine refused, with the reason. */
  failed: Array<{ id: string; error: string }>;
}

/** The last frame of a run's trail — by the log's own ordering counter, not array position. */
function tailOf(events: RecordedEvent[]): RecordedEvent | undefined {
  let tail: RecordedEvent | undefined;
  for (const e of events) {
    if (tail === undefined || e.seq >= tail.seq) tail = e;
  }
  return tail;
}

/** Ask the engine to resume every run it marked `runOrphaned` and still calls `executing`. Never throws. */
export async function resumeOrphanedRuns(
  adapter: RunResumeSurface,
  audit: RunResumeAudit,
  actor: Actor,
  log: (message: string) => void,
): Promise<BootRunResumeResult> {
  const result: BootRunResumeResult = { resumed: [], failed: [] };
  // A partial adapter (a directly-driven route set, a stub without the trail) may lack the surface.
  if (
    typeof adapter.sessionsDetail !== 'function' ||
    typeof adapter.runEvents !== 'function' ||
    typeof adapter.resumeRun !== 'function'
  ) {
    return result;
  }
  let executing: SessionView[];
  try {
    executing = (await adapter.sessionsDetail()).filter((v) => v.session.status === 'executing');
  } catch (err) {
    log(`[runs] boot resume: could not list runs: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  for (const view of executing) {
    const id = view.session.id;
    let events: RecordedEvent[] | null;
    try {
      events = await adapter.runEvents(id);
    } catch (err) {
      log(`[runs] boot resume: could not read the trail of ${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // No trail capability = cannot tell a zombie from a live run; resuming on a guess is what
    // this sweep must never do. Said once, for the first run it matters to.
    if (events === null) {
      log(`[runs] boot resume: the engine exposes no run event log — ${executing.length} executing run(s) left as they are`);
      return result;
    }
    const tail = tailOf(events);
    if (tail?.type !== RUN_ORPHANED_EVENT) continue;
    const ord = typeof tail.ord === 'number' ? tail.ord : undefined;
    try {
      const status = await adapter.resumeRun(id);
      result.resumed.push({ id, ord, status });
      audit.record('run.resumed', actor, {
        runId: id,
        detail: { via: 'boot', status, ...(ord !== undefined ? { ord } : {}) },
      });
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.resumed.length > 0 || result.failed.length > 0) {
    log(
      `[runs] boot resume: ${result.resumed.length} orphaned run(s) resumed` +
        (result.resumed.length > 0
          ? ` (${result.resumed.map((r) => `${r.id}${r.ord !== undefined ? `@${r.ord}` : ''} → ${r.status}`).join(', ')})`
          : '') +
        (result.failed.length > 0
          ? `; ${result.failed.length} refused (${result.failed.map((f) => `${f.id}: ${f.error}`).join('; ')})`
          : ''),
    );
  }
  return result;
}
