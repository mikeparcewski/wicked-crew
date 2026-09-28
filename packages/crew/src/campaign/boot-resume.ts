/**
 * Boot-time campaign crash-resume (crew#471).
 *
 * A daemon killed while a campaign was running left that campaign `running` forever: its node runs
 * froze (their worker was in the dead process) and nothing re-attached them, so the Tests page
 * showed a phantom running fan after every restart. The engine owns the recovery — its
 * `ResumeCampaign` is the crash-resume path (DES-CAMPAIGN-001 §6: reload the persisted statuses,
 * reconcile a node whose run already finished, re-attach or re-dispatch the rest, never re-run a
 * terminal node, never duplicate) — but only when asked. So at boot the daemon asks, once, for
 * every campaign the store still calls `running`. A `paused` campaign is left alone: resume would
 * un-pause it, and the operator paused it on purpose.
 */

import type { Campaign } from 'wicked-crew-api-types';

/** The two engine calls the sweep needs (the real `CoreAdapter` has both). */
export interface CampaignResumeSurface {
  campaignsSupported(): boolean;
  campaignList(): Promise<Campaign[]>;
  resumeCampaign(id: string): Promise<string>;
}

export interface BootResumeResult {
  /** Campaign ids the engine was asked to resume, with the status token it answered. */
  resumed: Array<{ id: string; status: string }>;
  /** Campaign ids whose resume the engine refused, with the reason. */
  failed: Array<{ id: string; error: string }>;
}

/** Ask the engine to crash-resume every `running` campaign. Never throws. */
export async function resumeRunningCampaigns(
  adapter: CampaignResumeSurface,
  log: (message: string) => void,
): Promise<BootResumeResult> {
  const result: BootResumeResult = { resumed: [], failed: [] };
  let campaigns: Campaign[];
  try {
    // A partial adapter (a directly-driven route set) may lack the campaign surface entirely.
    if (typeof adapter.campaignsSupported !== 'function' || !adapter.campaignsSupported()) return result;
    campaigns = await adapter.campaignList();
  } catch (err) {
    log(`[campaigns] boot resume: could not list campaigns: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  for (const c of campaigns) {
    if (c.status !== 'running') continue;
    try {
      const status = await adapter.resumeCampaign(c.id);
      result.resumed.push({ id: c.id, status });
    } catch (err) {
      result.failed.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.resumed.length > 0 || result.failed.length > 0) {
    log(
      `[campaigns] boot resume: ${result.resumed.length} running campaign(s) re-attached` +
        (result.resumed.length > 0 ? ` (${result.resumed.map((r) => `${r.id} → ${r.status}`).join(', ')})` : '') +
        (result.failed.length > 0 ? `; ${result.failed.length} refused (${result.failed.map((f) => `${f.id}: ${f.error}`).join('; ')})` : ''),
    );
  }
  return result;
}
