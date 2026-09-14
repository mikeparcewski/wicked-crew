/**
 * The run→launch-time index (home command-center run metrics; api-types 0.24.0).
 *
 * The engine's `AgentSession` (wicked-core `domain.rs`) records no launch timestamp — checked, it
 * carries only `archived_at` — so WHEN a run was launched is, exactly like its actor (task #88)
 * and its retry lineage (CREW-UX-3), knowledge only the daemon's HTTP layer ever holds. The
 * durable record is the `run.launched` audit entry's `ts` (unix MILLIS); this map is the read-side
 * latency layer that lets `GET /runs` / `GET /runs/:id` echo `AgentSession.created_at` (unix
 * SECONDS) without a trail scan per request.
 *
 * Mirrors `RetryIndex`'s posture exactly: hydrated once at server start from the SAME
 * `run.launched` scan `RetryIndex` + `GroupIndex` already share (the crew#321 consolidation note),
 * best-effort — a missing/unreadable trail leaves PRIOR runs undated, the pre-field behaviour, not
 * an error — and updated at the same post-commit point that writes the audit entry, so the map can
 * only lag by a failed hydrate, never diverge silently.
 */

import type { AuditLog } from './audit.js';
import type { Actor, AuditEntry } from '../core/types.js';

/**
 * Millis → whole unix SECONDS. The DTO field (`AgentSession.created_at`) and every other
 * `created_at` in this wire contract (`ConformanceRule`, memory items) are unix SECONDS; the audit
 * trail stamps millis (`AuditEntry.ts`), so the conversion happens here, once, at the seam.
 */
function toSeconds(millis: number): number {
  return Math.floor(millis / 1000);
}

export class RunTimingIndex {
  private readonly runToCreatedAt = new Map<string, number>();
  /** runId → terminal instant, unix SECONDS (`AgentSession.ended_at`; api-types 0.38.0, crew#496). */
  private readonly runToEndedAt = new Map<string, number>();

  /**
   * Consume pre-read `run.launched` entries — the seam that lets `createServer` feed this index
   * from the ONE `readAll({ action: 'run.launched' })` it already runs for `RetryIndex` +
   * `GroupIndex`, so boot stays at the same full-file trail scans, not one more.
   */
  hydrateFromLaunchEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      if (typeof entry.runId === 'string' && typeof entry.ts === 'number' && entry.ts > 0) {
        this.runToCreatedAt.set(entry.runId, toSeconds(entry.ts));
      }
    }
  }

  /**
   * Load launch times from EVERY `run.launched` entry in the trail — exhaustively, not capped, for
   * the same reason `RetryIndex.hydrate` is (BRIEF-UX-002 C5): a launch fact thousands of runs deep
   * must survive a restart, or a time-bucketed KPI silently drops the oldest runs. Still
   * best-effort: a missing/unreadable trail leaves runs undated, the pre-field answer. Cost is one
   * full-file scan at boot — the shared scan already parses the whole file.
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      this.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
    } catch (err) {
      log?.(
        `[runs] run-timing-index hydrate failed (prior runs read as undated until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Record a run's launch instant (unix MILLIS — the caller passes `Date.now()`, the same clock the
   * `run.launched` audit entry stamps, so the in-session answer and the post-restart rehydrate
   * agree to the second). Stored as whole unix seconds.
   */
  set(runId: string, launchedAtMillis: number): void {
    this.runToCreatedAt.set(runId, toSeconds(launchedAtMillis));
  }

  /** The run's launch time in unix SECONDS, or `undefined` (the DTO spells that as an ABSENT field). */
  createdAtFor(runId: string): number | undefined {
    return this.runToCreatedAt.get(runId);
  }

  /**
   * Consume pre-read `run.ended` entries (crew#496 / studio#230) — the daemon records one when it
   * sees a run's terminal frame (`sessionCompleted` | `sessionFailed` | `runCancelled`). The run's
   * FIRST terminal instant wins, the same rule the live {@link setEnded} applies: the trail answers
   * newest first, so the OLDEST entry per run (the last one seen) is kept — a resume/retry
   * re-terminal recorded after a hydrate failure never moves an already-dated run either way.
   * `ts <= 0` stamps nothing. One more filtered scan at boot, in the same try as the `run.launched`
   * scan (DES-L8 §5 PR-8B).
   */
  hydrateFromEndedEntries(entries: AuditEntry[]): void {
    for (const entry of entries) {
      if (typeof entry.runId !== 'string' || typeof entry.ts !== 'number' || entry.ts <= 0) continue;
      this.runToEndedAt.set(entry.runId, toSeconds(entry.ts)); // newest-first trail ⇒ the oldest wins
    }
  }

  /**
   * Record a run's terminal instant (unix MILLIS — the `run.ended` audit entry's own `ts`, so the
   * live answer and the post-restart rehydrate agree to the second). Idempotent per run: the first
   * stamp wins — a second terminal frame (resume, retry) re-stamps nothing.
   */
  setEnded(runId: string, endedAtMillis: number): void {
    if (this.runToEndedAt.has(runId)) return;
    this.runToEndedAt.set(runId, toSeconds(endedAtMillis));
  }

  /** The run's terminal time in unix SECONDS, or `undefined` (ABSENT on the wire — never null,
   *  never fabricated: a live run, a pre-field run, a run that terminalled before THIS daemon
   *  booted, a lost trail). */
  endedAtFor(runId: string): number | undefined {
    return this.runToEndedAt.get(runId);
  }
}

/**
 * Record a `run.launched` audit entry AND stamp the run-timing index with the SAME durable `ts`, so
 * `created_at` is answered LIVE (not only after a restart re-hydrates the trail) for EVERY route
 * that launches a run — `POST /runs` and the recon/steering-author launchers alike. Centralized
 * here (Copilot #466) so a new launch site can never again record the trail without stamping the
 * index. `ts === 0` (audit disabled — the `noop` trail route-unit tests build) stamps nothing,
 * keeping `created_at` derived ONLY from a durable entry, never fabricated. Returns the millis `ts`
 * for a caller that needs it (0 when audit is disabled).
 */
export function recordRunLaunched(
  audit: AuditLog,
  runTimingIndex: RunTimingIndex | undefined,
  actor: Actor,
  runId: string,
  detail: Record<string, unknown>,
): number {
  const ts = audit.record('run.launched', actor, { runId, detail });
  if (ts > 0) runTimingIndex?.set(runId, ts);
  return ts;
}
