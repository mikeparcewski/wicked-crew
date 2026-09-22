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

/** The pull request a run REVISES (DES-L9 / crew#550) — the durable record is the `run.launched`
 *  audit entry's `detail.revisesPr` (number, head branch, URL), written beside `retryOf`. */
export interface RevisesPrRecord {
  number: number;
  headRef: string;
  url: string;
}

function revisesPrOf(detail: Record<string, unknown> | undefined): RevisesPrRecord | undefined {
  const v = detail?.['revisesPr'];
  if (v === null || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const number = r['number'];
  const headRef = r['headRef'];
  const url = r['url'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return undefined;
  if (typeof headRef !== 'string' || headRef === '' || typeof url !== 'string') return undefined;
  return { number, headRef, url };
}

export class RetryIndex {
  private readonly runToRetryOf = new Map<string, string>();
  /** DES-L9: run → the PR it revises, from the same `run.launched` entry (post-hoc re-push reads it). */
  private readonly runToRevisesPr = new Map<string, RevisesPrRecord>();

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
      const revises = revisesPrOf(entry.detail);
      if (typeof entry.runId === 'string' && revises !== undefined) {
        this.runToRevisesPr.set(entry.runId, revises);
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

  /** DES-L9: record the PR a run revises (the same post-commit point that writes the trail entry). */
  setRevisesPr(runId: string, pr: RevisesPrRecord): void {
    this.runToRevisesPr.set(runId, pr);
  }

  /** The PR this run revises, or `undefined` — a post-hoc `POST /runs/:id/deliver` on a stranded
   *  revision re-pushes to THAT branch (after re-checking the PR is still OPEN), never a new PR. */
  revisesPrFor(runId: string): RevisesPrRecord | undefined {
    return this.runToRevisesPr.get(runId);
  }
}
