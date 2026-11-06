/**
 * (workdoc-all-runs) The audit entries a person's words in a run's working document come from (`personNotes`), per run,
 * in the order they were recorded. Filled once from the trail at daemon start and then from each entry as it is
 * recorded (`AuditLog.onRecord`), so a sync reads memory, never the whole trail again (xreview r1: one full parse of
 * the trail per sync), and an entry that lands after the event that prompted a sync (the gate route records `gate.decided`
 * after the engine answered) still brings the document up to date.
 *
 * People only: an entry by anyone else is never kept.
 */

import { NOTE_ACTIONS, type AuditLike } from './event-lines.js';

export class PersonNotesIndex {
  private readonly byRun = new Map<string, AuditLike[]>();
  private readonly seen = new Set<string>();

  /** Keep `entry` if it may become a person's line; `true` when it is new. */
  add(entry: AuditLike): boolean {
    const runId = entry.runId;
    if (typeof runId !== 'string' || runId === '' || entry.actor?.kind !== 'human' || !NOTE_ACTIONS.has(entry.action) || typeof entry.ts !== 'number') return false;
    // The start-up read and a live entry may both carry the same line.
    const key = `${runId}\u0000${entry.ts}\u0000${entry.action}\u0000${JSON.stringify(entry.detail ?? null)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const kept: AuditLike = { ts: entry.ts, action: entry.action, runId, actor: { id: entry.actor.id, kind: entry.actor.kind }, detail: entry.detail ?? null };
    const list = this.byRun.get(runId);
    if (list === undefined) this.byRun.set(runId, [kept]);
    else list.push(kept);
    return true;
  }

  /** The trail as `AuditLog.readAll` answers it (newest first). */
  hydrate(newestFirst: readonly AuditLike[]): void {
    for (let i = newestFirst.length - 1; i >= 0; i -= 1) this.add(newestFirst[i]!);
  }

  /** The run's kept entries, oldest first. */
  of(runId: string): readonly AuditLike[] {
    return this.byRun.get(runId) ?? [];
  }
}
