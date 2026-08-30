/**
 * The run→delivered-PR index (CREW-UX-8, crew#321).
 *
 * `LaunchRunBody.deliver?: 'pr'` is input-only; the deliver phase computes the PR URL
 * (`core/deliver.ts` — re-derived from the remote, refused without one) and prints it as the
 * unit's last output line, which is console text, not a wire. This index is the read-side
 * latency layer that lets the run DTOs echo `session.delivery` on BOTH `GET /runs` and
 * `GET /runs/:id` without a `workOutput` read per request — the persisted field that makes a
 * list surface's "4 of 5 siblings delivered" rollup affordable without an N-fetch fan-out
 * (wicked-studio#27).
 *
 * Mirrors `RetryIndex`/`GuidanceIndex`'s posture exactly: the DURABLE record is the audit
 * trail (the engine run record has no such field) — action `run.delivered`, `detail.url` —
 * hydrated once at server start (best-effort: a missing or unreadable trail leaves deliveries
 * blank, the pre-#321 behavior, not an error) and updated at the same post-terminal point
 * that writes the audit entry.
 *
 * KNOWN LIMIT (stated in the contract too): runs that delivered before this landed have no
 * `run.delivered` entry and carry no field. Do NOT backfill by scanning `work_output` at
 * hydrate — that is an unbounded boot cost. Historical runs still resolve their URL through
 * the per-run output endpoint.
 */

import type { AuditLog } from './audit.js';
import type { SessionView, WorkUnit } from '../core/types.js';

/** The wire shape `AgentSession.delivery` carries (api-types 0.11.0). */
export interface SessionDelivery {
  kind: 'pull_request';
  url: string;
}

/**
 * The PR URL in a deliver transcript — crew's own extraction, mirrored
 * (`core/deliver.ts`: `grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -1`). Requiring
 * the digits keeps `…/pull/new/<branch>` — the create-PR form git prints on every push —
 * from ever matching; the LAST match wins, same as `tail -1`.
 */
export function prUrlFrom(text: string): string | null {
  const matches = text.match(/https:\/\/\S+\/pull\/\d+/g);
  return matches === null ? null : (matches[matches.length - 1] ?? null);
}

/**
 * This run's deliver unit, or `null`. The composed id suffix (`<base>:deliver`) is the
 * primary key; the `tool_cmd` probe is the fallback for an operator OVERLAY that carried the
 * deliver phase under its own name — do NOT key on `workflow_id`, which is plain for
 * overlay-carried deliver phases (crew#321).
 */
export function deliverUnitOf(view: SessionView): WorkUnit | null {
  const byId = view.units.find((u) => u.id.endsWith(':deliver'));
  if (byId !== undefined) return byId;
  return view.units.find((u) => (u.tool_cmd ?? []).join(' ').includes('gh pr create')) ?? null;
}

export class DeliveryIndex {
  private readonly runToUrl = new Map<string, string>();

  /**
   * Load deliveries from EVERY `run.delivered` entry in the trail — exhaustively, not capped
   * (BRIEF-UX-002 C5, the same defect class as `RetryIndex.hydrate`: a durable record must
   * not vanish because 1000+ newer writes landed on top of it). The trail answers newest
   * first, so the FIRST entry seen per run wins; older entries for the same run are
   * superseded and skipped. Still best-effort, like its siblings; cost is one full-file scan
   * at boot. (Third exhaustive trail scan at boot, after RetryIndex and GuidanceIndex — a
   * FOURTH should trigger consolidating them into one pass, per crew#321.)
   */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      const seen = new Set<string>();
      for (const entry of await audit.readAll({ action: 'run.delivered' })) {
        if (typeof entry.runId !== 'string') continue;
        if (seen.has(entry.runId)) continue;
        // Newest entry decides, even when malformed — marking the run seen BEFORE the url
        // check keeps a corrupt newest write from resurrecting an older one (the #312 rule).
        seen.add(entry.runId);
        const url = entry.detail?.['url'];
        if (typeof url !== 'string' || url === '') continue;
        this.runToUrl.set(entry.runId, url);
      }
    } catch (err) {
      log?.(
        `[runs] delivery-index hydrate failed (prior runs read as undelivered until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Record the run's delivered PR URL (idempotent — the newest write wins). */
  set(runId: string, url: string): void {
    this.runToUrl.set(runId, url);
  }

  /** The delivery for this run, or `undefined` (the DTO spells that as an ABSENT field). */
  deliveryFor(runId: string): SessionDelivery | undefined {
    const url = this.runToUrl.get(runId);
    return url === undefined ? undefined : { kind: 'pull_request', url };
  }
}
