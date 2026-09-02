/**
 * The run→ad-hoc-group index (wicked-studio#27; api-types 0.19.0).
 *
 * Ad-hoc sibling runs launched via `POST /runs` can be filed onto a grouping surface at launch:
 * `campaignId` attaches the run to an EXISTING engine campaign (validated loudly — an unknown id
 * fails the launch), `groupLabel` puts it in a label group created on first use. Either way the
 * attach is daemon-side PROVENANCE only: the engine's run record carries no such field (the run
 * executes byte-identically to an ungrouped launch, and the campaign scheduler never learns of
 * it), so — exactly like retry lineage (CREW-UX-3) and the actor trail (task #88) — the durable
 * record is the `run.launched` audit entry (`detail.campaignId` / `detail.groupLabel`), and this
 * map is the read-side latency layer that lets `GET /runs` echo `campaign_id`/`group_label` and
 * `GET /campaigns` serve `attached_runs` + the `groups` rows without a trail scan per request.
 *
 * Mirrors `RetryIndex`'s posture: hydrated once at server start (best-effort — a missing or
 * unreadable trail leaves prior runs ungrouped, the pre-0.19 behavior, not an error) and updated
 * at the same post-commit point that writes the audit entry, so the map can only lag by a failed
 * hydrate, never diverge silently.
 *
 * SCAN BUDGET: this index consumes the SAME `run.launched` entries `RetryIndex` already scans,
 * so it exposes {@link GroupIndex.hydrateFromLaunchEntries} and `createServer` feeds both
 * indexes from ONE `readAll({ action: 'run.launched' })` — boot stays at three full-file trail
 * scans, not four (the delivery-index consolidation note, crew#321).
 */

import type { AuditLog } from './audit.js';
import type { AuditEntry } from '../core/types.js';

/** One launch's group attach: exactly one of the two forms (the launch route enforces it). */
export type GroupAttach = { campaignId: string } | { label: string };

export class GroupIndex {
  private readonly runToAttach = new Map<string, GroupAttach>();
  /** campaignId → attached run ids, launch order. */
  private readonly campaignRuns = new Map<string, string[]>();
  /** label → member run ids, launch order. */
  private readonly labelRuns = new Map<string, string[]>();

  /**
   * Consume pre-read `run.launched` entries (NEWEST FIRST, `AuditLog.readAll`'s order —
   * exhaustive, per BRIEF-UX-002 C5). The first entry seen per run wins, like the sibling
   * indexes; member lists come out in LAUNCH order because insertion happens on a reversed
   * walk. Idempotent per boot (called once).
   */
  hydrateFromLaunchEntries(entries: AuditEntry[]): void {
    const seen = new Set<string>();
    const oldestFirst: Array<{ runId: string; attach: GroupAttach }> = [];
    for (const entry of entries) {
      if (typeof entry.runId !== 'string') continue;
      if (seen.has(entry.runId)) continue;
      seen.add(entry.runId);
      const campaignId = entry.detail?.['campaignId'];
      const label = entry.detail?.['groupLabel'];
      if (typeof campaignId === 'string' && campaignId !== '') {
        oldestFirst.push({ runId: entry.runId, attach: { campaignId } });
      } else if (typeof label === 'string' && label !== '') {
        oldestFirst.push({ runId: entry.runId, attach: { label } });
      }
    }
    // The trail reads newest-first; one reverse restores launch order (unshift-in-loop is O(n²)).
    oldestFirst.reverse();
    for (const { runId, attach } of oldestFirst) this.set(runId, attach);
  }

  /** Standalone hydrate (tests / direct use) — production shares the scan via `createServer`. */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      this.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
    } catch (err) {
      log?.(
        `[runs] group-index hydrate failed (prior runs read as ungrouped until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Record one launch's attach (post-commit, beside the audit write). */
  set(runId: string, attach: GroupAttach): void {
    if (this.runToAttach.has(runId)) return; // launch-time fact — first write wins
    this.runToAttach.set(runId, attach);
    if ('campaignId' in attach) {
      const list = this.campaignRuns.get(attach.campaignId) ?? [];
      list.push(runId);
      this.campaignRuns.set(attach.campaignId, list);
    } else {
      const list = this.labelRuns.get(attach.label) ?? [];
      list.push(runId);
      this.labelRuns.set(attach.label, list);
    }
  }

  /** This run's attach, or `undefined` (the DTO spells that as ABSENT fields). */
  attachOf(runId: string): GroupAttach | undefined {
    return this.runToAttach.get(runId);
  }

  /** Run ids attached to this campaign, launch order (`[]` when none). */
  attachedTo(campaignId: string): string[] {
    return [...(this.campaignRuns.get(campaignId) ?? [])];
  }

  /** Every label group: `{ label, runIds }` in first-use order, members in launch order. */
  labelGroups(): Array<{ label: string; runIds: string[] }> {
    return [...this.labelRuns.entries()].map(([label, runIds]) => ({
      label,
      runIds: [...runIds],
    }));
  }
}
