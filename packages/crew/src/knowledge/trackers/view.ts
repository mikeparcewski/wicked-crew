/**
 * A tracker link as the wire shows it (DES-PM-001 §3.3, `TrackerLink`): built from the registry entry and the
 * projector's state for the tracker. One builder for the PM source's sheet, the tracker-links routes and the picker.
 */

import type { TrackerLink } from '../../core/types.js';
import type { PmSystem, StoredTracker } from '../registry/entry.js';

/** Whether estate holds a tracker's current links yet (the reconciled projector's answer; `pending` until known). */
export type TrackerProjectionState = 'current' | 'pending' | 'failed';
export type TrackerProjectionLookup = (trackerId: string) => TrackerProjectionState;

export const PROJECTION_UNKNOWN: TrackerProjectionLookup = () => 'pending';

export function trackerLinkView(src: { id: string; name: string; system: PmSystem }, t: StoredTracker, link: StoredTracker['links'][number], projection: TrackerProjectionLookup): TrackerLink {
  return {
    id: link.id,
    trackerId: t.id,
    source: src.name,
    sourceId: src.id,
    system: src.system,
    tenant: t.tenant,
    ...(t.tenantLabel !== null ? { tenantLabel: t.tenantLabel } : {}),
    key: t.key,
    label: t.label,
    target: { ...link.target },
    linkedAt: link.linkedAt,
    linkedBy: link.linkedBy,
    projection: projection(t.id),
  };
}

/** Every link of a PM entry, in a stable order. */
export function trackerLinkViews(src: { id: string; name: string; system: PmSystem }, trackers: readonly StoredTracker[], projection: TrackerProjectionLookup = PROJECTION_UNKNOWN): TrackerLink[] {
  const out: TrackerLink[] = [];
  for (const t of trackers) for (const l of t.links) out.push(trackerLinkView(src, t, l, projection));
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.tenant.localeCompare(b.tenant) || a.target.kind.localeCompare(b.target.kind) || a.target.id.localeCompare(b.target.id));
}
