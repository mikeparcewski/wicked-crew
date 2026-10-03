/**
 * Workflow discovery (DES-walkthrough-proof §4.13; WT-W4): two deterministic, propose-only queries,
 * registered as trigger-registry entries and fired on a run's terminal frames.
 *
 *   added_by_hand  per project, a catalog id a PERSON added to N consecutive launched chains (the
 *                  steps of `plan.proposed{by:"human"}` the PA's proposal did not have; floor-added
 *                  never; PA additions — `pa_added`, `member_request` — never) and never overrode
 *                  → a testing-rule draft that makes the step the default for the observed kinds.
 *   what_catches   per project per 30 days, a walkthrough FAIL while the same run's `test` verdict
 *                  was PASS, K times → hold TST-1002 (Test plus a walkthrough review).
 *
 * Both count over ONE project-level view the daemon builds and the registry hands over as
 * `ctx.discovery` (bounded, cached; `src/api/discovery-source.ts`). The checks stay pure over that
 * view: no bus read, no ledger read, no engine call here.
 *
 * A hit is one `proposal` row per (project, query, draft hash) — RUN-LESS and project-scoped
 * (`project` on the output; the emitter keys it to the project, so a second run of the project
 * re-deriving the same draft resolves to the row already there, across restarts too). The emitter
 * hands the row to the existing review queue (`facts.proposal` = the estate `proposal.submit` item,
 * `kind_type: "policy:testing"`, payload `{rule, severity, evidence: {count, window, run_ids}}`).
 * Nothing here lands a rule: approval is the operator's, in the queue (§4.13 "Approving"). The draft
 * is a proposal, not the operator's words, so it never auto-remembers.
 *
 * The draft hash is over the RULE text, not the count: a sixth consecutive run re-derives the same
 * draft and raises nothing new. A changed set of observed kinds is a new draft.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckCtx, CheckOutput, DiscoveryRun, DiscoverySnapshot, KeyPointInput, RunWatchState, WatchCheck } from '../types.js';

export type DiscoveryQuery = 'added_by_hand' | 'what_catches';

export interface AddedByHandParams {
  /** The catalog ids a testing rule may oblige — only a step of this kind becomes a proposal. */
  catalog: string[];
}
export interface AddedByHandThreshold {
  /** Consecutive launched chains the step must have been added to, counted from the newest back. */
  consecutive: number;
}
export interface WhatCatchesThreshold {
  times: number;
  window_days: number;
}

export interface DiscoveryProposal {
  query: DiscoveryQuery;
  /** `added_by_hand`: the step. */
  catalog?: string;
  /** The rule statement the proposal carries (the operator's review queue shows it verbatim). */
  rule: string;
  /** The watch row's sentence (the Watchtower's question). */
  sentence: string;
  evidence: { count: number; window: string; run_ids: string[]; kinds: string[] };
}

const DAY_MS = 86_400_000;
const TST_1002 = 'TST-1002';
const BAG_KEY = 'discovery';

/** The dedupe key's draft part: 12 hex of sha256 over (query, rule). */
export function draftHash(query: DiscoveryQuery, rule: string): string {
  return createHash('sha256').update(`${query}\u0000${rule}`).digest('hex').slice(0, 12);
}

const kindsOf = (runs: readonly DiscoveryRun[]): string[] => [...new Set(runs.map((r) => r.kind))].sort();
const kindsText = (kinds: readonly string[]): string => kinds.join(' or ');
/** Oldest launch first, whatever order the view lists them in. */
const byLaunch = (snap: DiscoverySnapshot): DiscoveryRun[] =>
  [...snap.runs].sort((a, b) => a.launched_at - b.launched_at || a.run_id.localeCompare(b.run_id));

export function addedByHandProposals(snap: DiscoverySnapshot, params: AddedByHandParams, threshold: AddedByHandThreshold): DiscoveryProposal[] {
  const runs = byLaunch(snap);
  const out: DiscoveryProposal[] = [];
  for (const catalog of params.catalog) {
    let streak = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i]!.human_added.includes(catalog); i -= 1) streak += 1;
    if (streak === 0 || streak < threshold.consecutive) continue;
    const hits = runs.slice(runs.length - streak);
    const kinds = kindsOf(hits);
    out.push({
      query: 'added_by_hand',
      catalog,
      rule: `A ${kindsText(kinds)} run includes the \`${catalog}\` step.`,
      sentence: `You've added \`${catalog}\` by hand to ${streak} consecutive ${kindsText(kinds)} runs — make it the default?`,
      evidence: { count: streak, window: `${streak} consecutive runs`, run_ids: hits.map((r) => r.run_id), kinds },
    });
  }
  return out;
}

export function whatCatchesProposals(snap: DiscoverySnapshot, threshold: WhatCatchesThreshold, now: number): DiscoveryProposal[] {
  const since = now - threshold.window_days * DAY_MS;
  const hits = byLaunch(snap).filter((r) => r.launched_at >= since && r.walkthrough === 'FAIL' && r.test === 'PASS');
  if (hits.length < threshold.times) return [];
  const kinds = kindsOf(hits);
  return [
    {
      query: 'what_catches',
      rule: `A change to code or config gets Test plus a walkthrough review by a different helper (${TST_1002}, held).`,
      sentence: `A walkthrough caught what the tests passed ${hits.length} times in the last ${threshold.window_days} days — hold ${TST_1002} (Test plus a walkthrough review) for ${kindsText(kinds)} runs?`,
      evidence: { count: hits.length, window: `${threshold.window_days}d`, run_ids: hits.map((r) => r.run_id), kinds },
    },
  ];
}

interface Bag {
  frames: number;
  noSource: boolean;
  noProject: boolean;
  unreadable: string | null;
  judged: boolean;
}

function bagOf(state: RunWatchState): Bag {
  let bag = state.bag.get(BAG_KEY) as Bag | undefined;
  if (bag === undefined) {
    bag = { frames: 0, noSource: false, noProject: false, unreadable: null, judged: false };
    state.bag.set(BAG_KEY, bag);
  }
  return bag;
}

/** The review-queue item the emitter files (`facts.proposal`), beside the plain facts studio shows. */
function proposalFacts(p: DiscoveryProposal, project: string): Record<string, unknown> {
  return {
    proposal: {
      kind_type: 'policy:testing',
      payload: { rule: p.rule, severity: 'warn', evidence: p.evidence },
      facets: { project },
    },
    query: p.query,
    ...(p.catalog !== undefined ? { catalog: p.catalog } : {}),
    count: p.evidence.count,
    kinds: p.evidence.kinds,
  };
}

async function discover(
  input: KeyPointInput,
  state: RunWatchState,
  ctx: CheckCtx,
  compute: (snap: DiscoverySnapshot) => DiscoveryProposal[],
): Promise<CheckOutput[]> {
  const bag = bagOf(state);
  bag.frames += 1;
  if (ctx.discovery === undefined) {
    bag.noSource = true;
    return [];
  }
  if (input.runId === null) return [];
  let snap: DiscoverySnapshot | null;
  try {
    snap = await ctx.discovery(input.runId);
  } catch (err) {
    bag.unreadable = err instanceof Error ? err.message : String(err);
    return [];
  }
  if (snap === null) {
    bag.noProject = true;
    return [];
  }
  const project = snap.project_id;
  bag.noProject = false;
  bag.unreadable = null;
  bag.judged = true;
  return compute(snap).map((p) => ({
    op: 'raise',
    subject: `${project}:${p.query}:${draftHash(p.query, p.rule)}`,
    project,
    sentence: p.sentence,
    facts: proposalFacts(p, project),
    re: `${input.type}#${input.runId}`,
  }));
}

function coverageOf(state: RunWatchState): { state: 'checked' } | { state: 'not_checked'; reason: string } {
  const bag = state.bag.get(BAG_KEY) as Bag | undefined;
  if (bag === undefined || bag.frames === 0) return { state: 'not_checked', reason: 'the run has not ended yet' };
  if (bag.noSource) return { state: 'not_checked', reason: 'no discovery source (the daemon gave the registry no project view to count over)' };
  if (bag.noProject) return { state: 'not_checked', reason: 'the run belongs to no project, so there is nothing to count over' };
  if (bag.unreadable !== null) {
    return { state: 'not_checked', reason: `the project's run records could not be read in time (${bag.unreadable}); counted again when the next run ends` };
  }
  return bag.judged ? { state: 'checked' } : { state: 'not_checked', reason: 'the run has not ended yet' };
}

export const addedByHandCheck: WatchCheck<AddedByHandParams, AddedByHandThreshold> = {
  name: 'deterministic:added_by_hand',
  lane: 'deterministic',
  paramsSchema: z.object({ catalog: z.array(z.string().min(1).max(64)).min(1).max(32) }).strict() as unknown as z.ZodType<AddedByHandParams>,
  thresholdSchema: z.object({ consecutive: z.number().int().min(2).max(100).default(5) }).strict() as unknown as z.ZodType<AddedByHandThreshold>,
  evaluate: (input, state, params, threshold, ctx) => discover(input, state, ctx, (snap) => addedByHandProposals(snap, params, threshold)),
  coverage: coverageOf,
  describe: (t) => `When a step you added by hand appears in ${t.consecutive} consecutive runs of a project (a testing rule to make it the default)`,
};

export const whatCatchesCheck: WatchCheck<Record<string, never>, WhatCatchesThreshold> = {
  name: 'deterministic:what_catches',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z
    .object({ times: z.number().int().min(1).max(100).default(3), window_days: z.number().int().min(1).max(365).default(30) })
    .strict() as unknown as z.ZodType<WhatCatchesThreshold>,
  evaluate: (input, state, _params, threshold, ctx) => discover(input, state, ctx, (snap) => whatCatchesProposals(snap, threshold, ctx.now())),
  coverage: coverageOf,
  describe: (t) => `When a walkthrough fails while the same run's tests passed ${t.times} times in ${t.window_days} days (hold ${TST_1002})`,
};
