/**
 * The campaigns-surface delivery rollup (wicked-studio#27; api-types 0.19.0).
 *
 * `GET /campaigns` / `GET /campaigns/:id` join, per member, the SAME delivery derivation the run
 * DTOs already carry (`AgentSession.delivery`/`deliverUrl` — crew#393's tri-state + crew#311's
 * vacuity split, computed by `deliveryStateWithVacuity` from the shared `DeliveryIndex` record
 * and the TTL-memoized git probes). One `sessionsDetail()` engine read serves a whole request —
 * never a per-node fetch — and the join is DTO-assembly-only: nothing here is persisted, so the
 * engine's Campaign shape stays the one producer of everything else on the wire.
 *
 * Why the fields ride the campaigns wire at all (instead of leaning on the `GET /runs` join a
 * client could do itself): the runs list default-excludes ARCHIVED runs, and bulk write-off of
 * campaign backlogs is an explicit feature (crew#265) — a rollup joined against the default runs
 * list would silently lose archived siblings. This join reads the full session set, so an
 * archived node still reports its delivery honestly.
 */

import type {
  AttachedRunView,
  Campaign,
  CampaignNodeDelivery,
  RunGroup,
  SessionView,
} from '../core/types.js';
import {
  deliveryStateWithVacuity,
  isDeliverConflictStranded,
  type VacuityProbes,
} from '../api/delivery-index.js';
import type { GroupIndex } from '../api/group-index.js';

/** The delivery machinery shared with the run DTOs — injected by `registerRoutes`. */
export interface RollupDeps {
  groupIndex: GroupIndex;
  /** The `DeliveryIndex` record (the durable `run.delivered` fact). */
  deliveryUrlFor: (runId: string) => string | undefined;
  /** The shared TTL-memoized probes behind `'stranded'`/`'vacuous'`. */
  vacuity: VacuityProbes;
}

/** Index a session list by run id — built once per request from ONE `sessionsDetail()` read. */
export function sessionsById(views: SessionView[]): Map<string, SessionView> {
  return new Map(views.map((v) => [v.session.id, v]));
}

async function deliveryOf(view: SessionView, deps: RollupDeps): Promise<CampaignNodeDelivery> {
  // The SAME honest precedence the run DTO applies (routes.ts `resolveDelivery`): a recorded PR
  // wins (`'delivered'`); else a crew#418 lift-conflict strand reads `'stranded'` from the branch
  // (the engine reports the run `failed`, but its work is committed and recoverable); else the
  // worktree-stat derivation. Without the crew#418 clause a node/attached run stranded by a lift
  // collision would read `'none'` here while the run wire reads `'stranded'` — the exact split-
  // brain crew#418 removes, on a surface whose charter is truthful per-node delivery.
  const url = deps.deliveryUrlFor(view.session.id);
  if (url !== undefined) return { delivery: 'delivered', deliverUrl: url };
  if (isDeliverConflictStranded(view)) return { delivery: 'stranded' };
  const state = await deliveryStateWithVacuity(view.session, undefined, deps.vacuity);
  return {
    delivery: state.delivery,
    ...(state.deliverUrl !== undefined ? { deliverUrl: state.deliverUrl } : {}),
  };
}

async function snapshot(
  view: SessionView,
  deps: RollupDeps,
): Promise<Omit<AttachedRunView, 'runId'>> {
  // crew#418: the status half of the same reinterpretation — a lift-conflict strand reads
  // `completed` (the engine's durable `failed` record is untouched; this is a wire derivation).
  const status = isDeliverConflictStranded(view) ? 'completed' : view.session.status;
  return { status, ...(await deliveryOf(view, deps)) };
}

/**
 * The served Campaign: the engine's persisted shape verbatim, plus the two daemon-joined 0.19.0
 * fields — `node_delivery` (keyed by node_id, entry present once the node's current-attempt run
 * exists on the store) and `attached_runs` (the ad-hoc runs filed onto this campaign at launch,
 * launch order; entries only for runs the store still holds).
 */
export async function enrichCampaign(
  campaign: Campaign,
  byId: Map<string, SessionView>,
  deps: RollupDeps,
): Promise<Campaign> {
  // Per-member computations are independent — resolved in parallel so a wide campaign's
  // GET /campaigns latency is the slowest member, not the sum (still one sessionsDetail read).
  const nodeEntries = Object.entries(campaign.node_run_id).filter(
    ([, runId]) => byId.get(runId) !== undefined, // node not dispatched yet — no run, no entry
  );
  const deliveries = await Promise.all(
    nodeEntries.map(([, runId]) => deliveryOf(byId.get(runId) as SessionView, deps)),
  );
  const node_delivery: Record<string, CampaignNodeDelivery> = {};
  nodeEntries.forEach(([nodeId], i) => {
    node_delivery[nodeId] = deliveries[i] as CampaignNodeDelivery;
  });
  const attachedIds = deps.groupIndex
    .attachedTo(campaign.id)
    // trail knows it, the store no longer does — don't invent
    .filter((runId) => byId.get(runId) !== undefined);
  const attached_runs: AttachedRunView[] = await Promise.all(
    attachedIds.map(async (runId) => ({
      runId,
      ...(await snapshot(byId.get(runId) as SessionView, deps)),
    })),
  );
  return { ...campaign, node_delivery, attached_runs };
}

/** Every ad-hoc label group, first-use order, members in launch order (wicked-studio#27). */
export async function buildGroups(
  byId: Map<string, SessionView>,
  deps: RollupDeps,
): Promise<RunGroup[]> {
  const groups: RunGroup[] = [];
  for (const { label, runIds } of deps.groupIndex.labelGroups()) {
    const memberIds = runIds.filter((runId) => byId.get(runId) !== undefined);
    const runs: AttachedRunView[] = await Promise.all(
      memberIds.map(async (runId) => ({
        runId,
        ...(await snapshot(byId.get(runId) as SessionView, deps)),
      })),
    );
    groups.push({ label, runs });
  }
  return groups;
}
