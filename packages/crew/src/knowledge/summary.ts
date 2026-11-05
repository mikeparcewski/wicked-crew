/**
 * What knowledge an app in a project can be built on (DES-KNOWLEDGE-DATA-001 §9.1, §9.3): counts and registry names
 * only, never a row, a document's text, a memory's words or a rule's statement. ONE summary, two readers: the apps
 * builder's knowledge package carries it, and `GET /knowledge/summary?project=` serves it to studio's suggestions, so
 * a suggestion never names knowledge the builder cannot use (and a recall query never reads past it either: each
 * part is counted under the same rule its `recall` read applies).
 *
 *  - **sources**: every source the predicate lets the project see (`agentMay` `see`), read again before release,
 *    `described` when estate holds its structure under its current description (it is in the project's visible set),
 *    and its approved data shapes VERIFIED against estate's own node and deps (`verifiedShapes`), counted up to
 *    {@link SUMMARY_SHAPES_MAX} (`null` = the count could not be established: the review queue or a shape's node could
 *    not be read, or the budget ran out before enough candidates were checked);
 *  - **memories**: what a recall with the project as its facet intent can reach ({@link memoryAdmits}: every facet of
 *    a memory must match), working memories left out, split into the project's own and the shared (unfaceted) ones;
 *  - **steering**: the active rules with no project facet or this project's, by steering type.
 *
 * A part estate or the engine cannot answer is `null` (said, never zero).
 */

import type { ConformanceRule, KnowledgeSummaryResponse, SteeringType } from '../core/types.js';
import { agentMay } from './gate/access.js';
import type { GateSource } from './gate/sources.js';
import { sourceDep } from './package.js';
import type { EstateCall } from './shapes/shapes.js';
import { approvedShapes, type VerifiedShape, verifiedShapes } from './shapes/verified.js';

export interface KnowledgeSummaryDeps {
  sources: () => Promise<GateSource[]>;
  visible: (projectId: string) => Promise<string[]>;
  estate: EstateCall;
  rules: () => Promise<ConformanceRule[]>;
}

/** How many shapes are verified per source for the summary (it says whether a source has some; the read counts all). */
export const SUMMARY_SHAPES_MAX = 5;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a memory with these facets is one a recall with the project as its facet intent reaches: estate's
 * `facet_admits` (every facet of the memory must equal the intent's), with the intent `{project}`. Unreadable facets
 * admit nothing.
 */
export function memoryAdmits(facets: unknown, projectId: string): boolean {
  if (facets === undefined || facets === null) return true;
  if (!isObj(facets)) return false;
  return Object.entries(facets).every(([axis, value]) => axis === 'project' && value === projectId);
}

/** The summary's whole budget: past it no further estate call starts, and what is not read yet is `null`. */
export const SUMMARY_BUDGET_MS = 8_000;

/** A memory an app's memory recall may release for the project: admitted by its facets, and not a working memory. */
export function recallableMemory(m: Record<string, unknown>, projectId: string): boolean {
  return m['tier'] !== 'working' && memoryAdmits(m['facets'], projectId);
}

/** The project's summary (module doc). Throws only when the registry itself cannot be read. */
export async function projectKnowledge(projectId: string, deps: KnowledgeSummaryDeps, opts: { budgetMs?: number; now?: () => number } = {}): Promise<KnowledgeSummaryResponse> {
  const clock = opts.now ?? Date.now;
  const until = clock() + (opts.budgetMs ?? SUMMARY_BUDGET_MS);
  // Bounded: an estate that does not answer costs the summary its budget, never a turn's launch minutes.
  const estate: EstateCall = (tool, args) => (clock() >= until ? Promise.reject(new Error('the summary ran past its budget')) : deps.estate(tool, args));
  const all = [...(await deps.sources())].sort((a, b) => a.name.localeCompare(b.name));
  const visible = await deps.visible(projectId);
  const fresh = async (): Promise<ReadonlySet<string>> => new Set(await deps.visible(projectId));
  const seen = all.filter((s) => agentMay(s.access, s, projectId, 'see'));
  const described = seen.filter((s) => visible.includes(sourceDep(s.id)));
  const shapes = new Map<string, { shapes: VerifiedShape[]; exhausted: boolean; failed: boolean } | null>();
  const proposals = described.length > 0 ? await approvedShapes(estate) : [];
  for (const s of described) {
    shapes.set(s.id, proposals === null ? null : await verifiedShapes(estate, proposals, s.id, visible, fresh, { want: SUMMARY_SHAPES_MAX }).catch(() => null));
  }
  let memories: KnowledgeSummaryResponse['memories'] = null;
  try {
    const got = await estate('memory.list', {});
    const items = isObj(got) && Array.isArray(got['items']) ? got['items'] : null;
    if (items !== null) {
      let own = 0;
      let shared = 0;
      for (const m of items) {
        // A working memory expires within a day and is not what a recall-built table shows.
        if (!isObj(m) || !recallableMemory(m, projectId)) continue;
        if (isObj(m['facets']) && Object.keys(m['facets']).length > 0) own++;
        else shared++;
      }
      memories = { project: own, shared };
    }
  } catch {
    memories = null;
  }
  let steering: KnowledgeSummaryResponse['steering'] = null;
  try {
    const byType: Partial<Record<SteeringType, number>> = {};
    let total = 0;
    for (const r of await deps.rules()) {
      if (r.retired === true) continue;
      const scoped = r.targets?.project;
      if (scoped !== undefined && scoped !== projectId) continue;
      const t = (r.steering_type ?? 'architecture') as SteeringType;
      byType[t] = (byType[t] ?? 0) + 1;
      total++;
    }
    steering = { total, byType };
  } catch {
    steering = null;
  }
  // The release re-check: what the project may see is read again now; a source it no longer sees is not named.
  const nowSources = await deps.sources();
  const nowVisible = await fresh();
  const sources: KnowledgeSummaryResponse['sources'] = [];
  for (const s of seen) {
    const cur = nowSources.find((x) => x.id === s.id);
    if (cur === undefined || cur.name !== s.name || !agentMay(cur.access, cur, projectId, 'see')) continue;
    const isDescribed = nowVisible.has(sourceDep(s.id)) && visible.includes(sourceDep(s.id));
    // Shapes counted under the set read now; a count below the cap that was not established (a read failed, the
    // budget ran out) is unknown, not zero.
    const v = shapes.get(s.id);
    const kept = v == null ? null : v.shapes.filter((x) => x.deps.every((d) => nowVisible.has(d))).length;
    // Established only when nothing failed and every candidate was checked, or the cap is still met after release.
    const count = v == null || kept === null || v.failed ? null : kept >= SUMMARY_SHAPES_MAX ? SUMMARY_SHAPES_MAX : v.exhausted ? kept : null;
    sources.push({ name: s.name, described: isDescribed, query: agentMay(cur.access, cur, projectId, 'query'), shapes: isDescribed ? count : 0 });
  }
  return { projectId, sources, memories, steering };
}
