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

export class RetryIndex {
  private readonly runToRetryOf = new Map<string, string>();

  /**
   * Load lineage from the audit trail's `run.launched` entries. Best-effort and bounded by the
   * trail read cap (newest 1000 launches): older runs simply read as "not a retry", the same
   * answer a pre-CREW-UX-3 daemon gave for every run.
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      for (const entry of await audit.read({ action: 'run.launched', limit: 1000 })) {
        const retryOf = entry.detail?.['retryOf'];
        if (typeof entry.runId === 'string' && typeof retryOf === 'string') {
          this.runToRetryOf.set(entry.runId, retryOf);
        }
      }
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
