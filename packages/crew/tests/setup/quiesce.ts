// Best-effort engine quiesce before teardown (crew#429, Layer A).
//
// `wicked-core-ts`'s `Core` exposes no awaitable drain/join (see `scratch.ts`), so this cannot
// PROVE the engine's worktree reaper has stopped touching a run's/campaign's worktrees — it only
// shrinks the race window: cancel whatever the test launched and wait for it to reach a terminal
// status, so the scheduler has no in-flight work left that could still trigger a reap after
// `adapter.close()`. Always pair with `removeScratch` for the actual guarantee — bounded retries
// there absorb the reaper's residual tail that quiescing alone cannot close.
import type { CoreAdapter } from '../../src/core/adapter.js';

const RUN_TERMINAL: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
const CAMPAIGN_TERMINAL: ReadonlySet<string> = new Set([
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
]);

async function pollUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  // A failed status read is not evidence that the engine is quiescent. In particular, treating
  // it as an unknown run/campaign lets teardown delete scratch while its actor may still be
  // reaping a worktree. Keep polling through a transient read failure and time out loudly if the
  // engine never gives us a terminal observation.
  do {
    try {
      if (await check()) return true;
    } catch {
      // The next read may succeed once the actor has drained its current operation.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (true);
}

/**
 * Cancel one campaign (best-effort — a reject means it's already terminal, unsupported, or
 * unknown to the engine) and wait for its status to settle to terminal.
 */
export async function quiesceCampaign(adapter: CoreAdapter, id: string, ms = 15_000): Promise<void> {
  try {
    await adapter.cancelCampaign(id);
  } catch {
    /* already terminal, unsupported on this addon, or unknown — nothing to cancel */
  }
  const settled = await pollUntil(async () => {
    const detail = await adapter.campaignDetail(id);
    return detail === null || CAMPAIGN_TERMINAL.has(detail.status);
  }, ms);
  if (!settled) {
    throw new Error(`campaign ${id} did not reach a terminal state within ${ms}ms during teardown`);
  }
}

/**
 * Cancel one run (best-effort — a reject means it's already terminal or unknown to the engine)
 * and wait for it to reach a terminal status.
 */
export async function quiesceRun(adapter: CoreAdapter, runId: string, ms = 15_000): Promise<void> {
  try {
    await adapter.cancelRun(runId);
  } catch {
    /* already terminal or unknown to the engine — nothing to cancel */
  }
  const settled = await pollUntil(async () => {
    const views = await adapter.sessionsDetail();
    const view = views.find((v) => v.session.id === runId);
    return view === undefined || RUN_TERMINAL.has(view.session.status);
  }, ms);
  if (!settled) {
    throw new Error(`run ${runId} did not reach a terminal state within ${ms}ms during teardown`);
  }
}
