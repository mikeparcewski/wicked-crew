/**
 * The run→operator-guidance index (DES-UX-002 §7.2, CREW-UX-7).
 *
 * NAMING NOTE: DES-UX-002 §7.2 labels this slice CREW-UX-4, but that id was already spent on an
 * unrelated merged slice (crew#308) — this implementation is CREW-UX-7; the doc's §7.2 spec is
 * what it implements.
 *
 * A durable pre-gate annotation: ONE operator guidance note per run, upserted via
 * `PUT /runs/:id/guidance` and echoed as `AgentSession.guidance` on the run DTOs. The engine's
 * run record carries no such field (wicked-core-ts 0.6.x), so — exactly like retry lineage
 * (CREW-UX-3) and the actor trail (task #88) — the durable record is the audit trail: every
 * write lands as a `guidance.set` entry whose `detail.text` is the full note (empty string =
 * cleared), and this map is the read-side latency layer that lets the run DTOs echo it without
 * a trail scan per request.
 *
 * Mirrors `RetryIndex`'s posture: hydrated once at server start (best-effort — a missing or
 * unreadable trail leaves guidance blank, the pre-CREW-UX-7 behavior, not an error) and updated
 * at the same post-commit point that writes the audit entry, so the map can only lag by a
 * failed hydrate, never diverge silently.
 */

import type { AuditLog } from './audit.js';

export class GuidanceIndex {
  private readonly runToGuidance = new Map<string, string>();

  /**
   * Load guidance from EVERY `guidance.set` entry in the trail — exhaustively, not capped
   * (BRIEF-UX-002 C5, same defect as `RetryIndex.hydrate`: a durable note must not vanish
   * because 1000+ newer writes landed on top of it). The trail answers newest first, so the
   * FIRST entry seen per run is the current note — later (older) entries for the same run
   * are superseded writes and are skipped, which is also what keeps a cleared note (newest
   * entry has `text: ''`) from being resurrected by an older non-empty one. Still best-effort,
   * like `RetryIndex.hydrate`; cost is one full-file scan at boot.
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      const superseded = new Set<string>();
      for (const entry of await audit.readAll({ action: 'guidance.set' })) {
        if (typeof entry.runId !== 'string') continue;
        if (superseded.has(entry.runId)) continue;
        // The NEWEST entry for a run decides — even when its text is malformed. Marking the
        // run seen BEFORE the text check keeps a corrupt newest write from resurrecting an
        // older superseded note (Copilot, #312): unknowable current note = no note.
        superseded.add(entry.runId);
        const text = entry.detail?.['text'];
        if (typeof text !== 'string') continue;
        if (text !== '') this.runToGuidance.set(entry.runId, text);
      }
    } catch (err) {
      log?.(
        `[runs] guidance-index hydrate failed (prior runs read as no-guidance until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Upsert the note; the empty string CLEARS it (the DTO field goes back to absent). */
  set(runId: string, text: string): void {
    if (text === '') this.runToGuidance.delete(runId);
    else this.runToGuidance.set(runId, text);
  }

  /** The note for this run, or `undefined` (the DTO spells that as an ABSENT field). */
  guidanceFor(runId: string): string | undefined {
    return this.runToGuidance.get(runId);
  }
}
