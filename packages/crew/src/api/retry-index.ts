/**
 * The run→retry-lineage index (DES-UX-001 §8.3, CREW-UX-3).
 *
 * The engine's `LaunchOptions` carries no lineage field (checked, wicked-core-ts 0.6.x), so —
 * exactly like the actor trail (task #88) — WHICH run a launch retries is knowledge only the
 * daemon's HTTP layer ever holds. The durable record is the `run.launched` audit entry whose
 * `detail.retryOf` the launch route writes; this map is the read-side latency layer that lets
 * `GET /runs` / `GET /runs/:id` echo `AgentSession.retry_of` without a trail scan per request.
 *
 * Mirrors `MembershipIndex`'s posture: hydrated once at server start (from the audit trail,
 * best-effort — a missing/unreadable trail leaves lineage blank for PRIOR runs, which is the
 * pre-CREW-UX-3 behavior, not an error) and updated at the same post-commit point that writes
 * the audit entry, so the map can only lag by a failed hydrate, never diverge silently.
 */

import type { AuditLog } from './audit.js';
import type { AuditEntry } from '../core/types.js';

export class RetryIndex {
  private readonly runToRetryOf = new Map<string, string>();

  /**
   * Consume pre-read `run.launched` entries — the seam that lets `createServer` feed this index
   * and `GroupIndex` from ONE trail scan (the delivery-index consolidation note, crew#321).
   */
  hydrateFromLaunchEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      const retryOf = entry.detail?.['retryOf'];
      if (typeof entry.runId === 'string' && typeof retryOf === 'string') {
        this.runToRetryOf.set(entry.runId, retryOf);
      }
    }
  }

  /**
   * Load lineage from EVERY `run.launched` entry in the trail — exhaustively, not capped
   * (BRIEF-UX-002 C5: a lineage fact 2,678 launches deep must survive a restart; the newest-1000
   * cap silently dropped it and the chronicle rendered the chain as peer episodes). Still
   * best-effort: a missing/unreadable trail leaves lineage blank, the pre-CREW-UX-3 answer.
   * Cost: one full-file scan at boot — `read` already parses the whole file anyway.
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      this.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
    } catch (err) {
      log?.(
        `[runs] retry-index hydrate failed (prior runs read as not-a-retry until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  set(runId: string, retryOf: string): void {
    this.runToRetryOf.set(runId, retryOf);
  }

  /** The run id this run retries, or `undefined` (the DTO spells that as an ABSENT field). */
  retryOfFor(runId: string): string | undefined {
    return this.runToRetryOf.get(runId);
  }
}
