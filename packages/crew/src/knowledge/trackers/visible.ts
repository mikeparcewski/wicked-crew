/**
 * (DES-PM-001 §3.4) The trackers a unit's knowledge reads may see: the trackers of its tracker set T(u) (read now, the
 * gate's own computation), and only once estate has taken a projection of each. The relay adds `source:<tracker id>`
 * for each and `project:<P_u>` (`visibleDeps`). A tracker outside T(u) is never in the set, whatever estate holds.
 */

import type { PmGate } from './gate-pm.js';
import type { TrackerScope } from './set.js';

export async function unitTrackerIds(pm: Pick<PmGate, 'trackerSet' | 'entries'>, acknowledged: (trackerId: string) => boolean, scope: TrackerScope): Promise<string[]> {
  const set = await pm.trackerSet(scope);
  return set.filter((t) => acknowledged(t.trackerId)).map((t) => t.trackerId);
}
