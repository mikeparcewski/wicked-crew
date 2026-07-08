import type { CoreEvent, SessionView } from '../core/types.js';

/** A cached open human gate for a run. */
export interface GateCacheEntry {
  /** The unit `ord` the run paused before. */
  ord: number;
  /** The gate prompt (lives only on the transient event — core does not persist it). */
  prompt: string;
  /** Lifecycle state. Only `open` in this foundation increment (see the class note). */
  lifecycle: 'open';
  /** When the daemon observed the gate. */
  receivedAt: string;
}

/**
 * Self-healing gate-prompt cache (DES-STUDIO-001 §3.3).
 *
 * Core does NOT persist the gate prompt — it exists only on the transient
 * `awaitingHuman` CoreEvent (`AgentSession` has no prompt field). So the daemon
 * event-sources it here, keyed by runId (a paused run has exactly one open gate,
 * before `unit_ix`). Entries are pruned on any resumed/terminal event for the
 * run, and re-checked against `sessionsDetail()` on every list reconcile so the
 * cache can neither leak nor go stale ("re-merged on reconcile, pruned to
 * still-paused — can't leak or blank").
 *
 * NOTE: the full HITL lifecycle from §3.3 (advisory / hard-expiry timers,
 * append-only message log, auto-cancel-on-expiry, synthesized `gateLifecycle`
 * frames) is a deliberate follow-on. This increment caches only the prompt so a
 * late-joining browser can render the gate; `lifecycle` is always `open`.
 */
export class GateCache {
  private readonly entries = new Map<string, GateCacheEntry>();

  /** Fold one CoreEvent into the cache. */
  ingest(event: CoreEvent): void {
    const session = typeof event.session === 'string' ? event.session : undefined;
    if (session === undefined) return;
    switch (event.type) {
      case 'awaitingHuman':
        if (typeof event.ord === 'number' && typeof event.prompt === 'string') {
          this.entries.set(session, {
            ord: event.ord,
            prompt: event.prompt,
            lifecycle: 'open',
            receivedAt: new Date().toISOString(),
          });
        }
        break;
      case 'resumed':
      case 'sessionCompleted':
      case 'runCancelled':
      case 'sessionFailed':
        this.entries.delete(session);
        break;
      default:
        break;
    }
  }

  /** The cached open gate for a run, if any. */
  get(runId: string): GateCacheEntry | undefined {
    return this.entries.get(runId);
  }

  /** Drop cache entries whose run is no longer `awaiting_human` (self-healing on reconcile). */
  reconcile(views: SessionView[]): void {
    const awaiting = new Set(
      views.filter((v) => v.session.status === 'awaiting_human').map((v) => v.session.id),
    );
    for (const id of [...this.entries.keys()]) {
      if (!awaiting.has(id)) this.entries.delete(id);
    }
  }
}
