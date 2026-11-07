/**
 * (workdoc-all-runs) A person's answers with their words, per run, as the lines a run's working document shows
 * (`personNotes`), kept in memory: filled once from the trail at daemon start and then from each entry as it is
 * recorded (`AuditLog.onRecord`). A sync reads memory, never the whole trail again (xreview r1), and an entry that lands
 * after the event that prompted a sync (the gate route records `gate.decided` after the engine answered) still brings
 * the document up to date.
 *
 *  - People only, and only entries that make a line (a bare approval makes none).
 *  - In recorded order: entries recorded while the start-up read is in flight wait, and join after it (xreview r2).
 *  - Bounded per run: each kept note is the line's compact form (words cut to 280 characters), at most
 *    {@link NOTES_PER_RUN} per run, the newest. That is more than a full Decisions section can show (4,000 characters,
 *    and the shortest line is 27), so a note leaves the document long before it leaves this index, and a line crew wrote
 *    is never mistaken for a person's (xreview r3). Across runs the index grows with people's answers only, the posture
 *    of the daemon's other trail-hydrated indexes (`RunTimingIndex`, `GuidanceIndex`: every run, for the daemon's life);
 *    a global eviction and read-back was tried and dropped in xreview r4 (it lost live answers and thrashed the trail).
 */

import { NOTE_ACTIONS, personNotes, type AuditLike, type PersonNote } from './event-lines.js';

export const NOTES_PER_RUN = 160;

const relevant = (e: AuditLike): e is AuditLike & { runId: string } =>
  typeof e.runId === 'string' && e.runId !== '' && e.actor?.kind === 'human' && NOTE_ACTIONS.has(e.action) && typeof e.ts === 'number';

/** One record's identity while the start-up read and live entries are merged (never kept after). */
const keyOf = (e: AuditLike): string =>
  JSON.stringify([e.runId, e.ts, e.action, typeof e.actor?.id === 'string' ? e.actor.id : null, e.detail ?? null]);

export class PersonNotesIndex {
  private readonly byRun = new Map<string, PersonNote[]>();
  private ready = false;
  private waiting: Array<AuditLike & { runId: string }> = [];

  constructor(private readonly perRun: number = NOTES_PER_RUN) {}

  /** A live entry. Resolves to the run whose document should be brought up to date, or `null` (no line, or the
   *  start-up read is still in flight: it joins after, and {@link hydrate} names its run). */
  add(entry: AuditLike): string | null {
    if (!relevant(entry)) return null;
    if (!this.ready) {
      this.waiting.push(entry);
      return null;
    }
    return this.keep(entry) ? entry.runId : null;
  }

  /** The trail as `AuditLog.readAll` answers it (newest first; `[]` when it could not be read). Then the entries that
   *  arrived meanwhile, in their order, minus any the read already had. Resolves to the runs those touched. */
  hydrate(newestFirst: readonly AuditLike[]): string[] {
    const seen = new Set<string>();
    for (let i = newestFirst.length - 1; i >= 0; i -= 1) {
      const e = newestFirst[i]!;
      if (!relevant(e)) continue;
      seen.add(keyOf(e));
      this.keep(e);
    }
    const touched = new Set<string>();
    // Every answer that arrived meanwhile names its run (its document is brought up to date), whether or not the read
    // already had it (xreview r3); it is kept once.
    for (const e of this.waiting) {
      if (seen.has(keyOf(e)) ? personNotes([e]).length > 0 : this.keep(e)) touched.add(e.runId);
    }
    this.waiting = [];
    this.ready = true;
    return [...touched];
  }

  /** The run's notes, oldest first. */
  of(runId: string): readonly PersonNote[] {
    return this.byRun.get(runId) ?? [];
  }

  private keep(e: AuditLike & { runId: string }): boolean {
    const notes = personNotes([e]);
    if (notes.length === 0) return false;
    const list = this.byRun.get(e.runId);
    if (list === undefined) this.byRun.set(e.runId, notes);
    else list.push(...notes);
    const kept = this.byRun.get(e.runId)!;
    if (kept.length > this.perRun) kept.splice(0, kept.length - this.perRun);
    return true;
  }
}
