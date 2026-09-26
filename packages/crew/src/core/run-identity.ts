/**
 * "What is this run?" — the ONE resolver (seam X2), read from the engine's own record.
 *
 * The engine stores a synthetic `workflow_id` on every run it launches (`wf-<run>`), so the name a
 * run was launched under is not on the session's `workflow_id`. Crew used to recover it by matching
 * the run's unit sequence against its mirrors of the built-in defs — which stops matching the moment
 * the engine's floor adds a step to a preset run, never matched a user plan (`<run>:plan-<rev>`),
 * and cannot survive the mirrors being deleted. This module replaces that guess with what the
 * engine RECORDED:
 *
 *   1. `AgentSession.team_plan` (wicked-core `TeamPlanState`, DES-TEAMING-002 §8.4) — present on a
 *      run launched from a plan or a preset. `team_plan.preset` names the preset; absent, the run
 *      is a USER PLAN.
 *   2. The launch's `sessionStarted` frame in the engine's durable run event log (`workflowId`):
 *      the preset name, the registered def id, the per-run plan def (`<run>:plan-<rev>`) or `null`
 *      for a free-text run. The adapter reads it once per run and memoizes it (`launched` below);
 *      this is the only record of a NON-team run's def, because the session keeps only `wf-<run>`.
 *   3. A session whose `workflow_id` is not synthetic already names its def.
 *
 * Each unit's catalog id (`WorkUnit.catalog`, stamped by the engine on a catalog-composed plan) is
 * carried as-is. Nothing here reads unit ids or phase sequences.
 *
 * SYSTEM classification lives here too, in ONE list keyed by preset/workflow name: the runs studio
 * keeps off its delivery surfaces (chat, onboarding, the interactive seams, …). The served run
 * carries it as `run_identity.system`, and `listWorkflows()` stamps the defs' `is_system` from the
 * same list, so the two can no longer disagree.
 */

import type { RunIdentity, SessionView, WorkflowDef } from './types.js';
import { baseWorkflowId } from './deliver-text.js';

/**
 * The machine-owned workflows (and, once they migrate, presets) — keyed by NAME, so a preset and
 * the def it replaces classify alike. Studio hides these from its delivery surfaces and its
 * work-mode selector; `GET /workflows` serves `is_system: true` for exactly these ids.
 */
export const SYSTEM_WORKFLOWS: ReadonlySet<string> = new Set([
  'chat',
  'onboarding',
  'survey-repo',
  'capture-learnings',
  'domain-graph-slice',
  'memories',
  'steering-author',
  'collab',
  // The interactive document and video seams (`interactive/*-events.ts`).
  'interactive-chat',
  'interactive-demo',
  'interactive-demo-reauthor',
  'interactive-draft',
  'interactive-edit',
]);

/** Whether a preset/workflow name is a system one ({@link SYSTEM_WORKFLOWS}). */
export function isSystemWorkflow(name: string | null | undefined): boolean {
  return typeof name === 'string' && SYSTEM_WORKFLOWS.has(name);
}

/**
 * A def with its `is_system` flag set from {@link SYSTEM_WORKFLOWS} — the ONE source of the flag.
 * Returns the same object when it already agrees (a registered def's own `is_system` is not a
 * second source: it is overwritten either way).
 */
export function withSystemFlag<T extends WorkflowDef>(def: T): T {
  const system = SYSTEM_WORKFLOWS.has(def.id);
  if (system) return def.is_system === true ? def : { ...def, is_system: true };
  if (!('is_system' in def)) return def;
  const rest = { ...def };
  delete rest.is_system;
  return rest;
}

/**
 * The run a per-run plan def id belongs to — `<run>:plan-<rev>`, `rev` a positive decimal
 * (wicked-core `plan::per_run_def_run_id`, the same reserved shape). `null` for any other id.
 */
export function perRunPlanRunId(defId: string): string | null {
  const at = defId.lastIndexOf(':plan-');
  if (at <= 0) return null;
  const rev = defId.slice(at + ':plan-'.length);
  return /^[1-9]\d*$/.test(rev) ? defId.slice(0, at) : null;
}

/** The engine's synthetic instance id — a session that carries it does not name its def. */
export function isSyntheticWorkflowId(workflowId: string): boolean {
  return workflowId.startsWith('wf-');
}

/** What the resolver answers: the wire identity plus each unit's catalog id, in `ord` order. */
export interface ResolvedRun extends RunIdentity {
  /** `WorkUnit.catalog` per unit, ordered by `ord` — `null` for a unit not planned from the catalog. */
  catalog: Array<string | null>;
}

/** A session's engine plan state, as far as this resolver reads it. */
interface TeamPlanRecord {
  preset?: string | null;
}

function teamPlanOf(view: SessionView): TeamPlanRecord | null {
  const plan = (view.session as { team_plan?: unknown }).team_plan;
  return plan !== null && typeof plan === 'object' ? (plan as TeamPlanRecord) : null;
}

function identity(kind: RunIdentity['kind'], name: string | null): RunIdentity {
  return { kind, name, user_plan: kind === 'user_plan', system: isSystemWorkflow(name) };
}

/**
 * Resolve a run from its record.
 *
 * `launched` is the launch's `sessionStarted.workflowId` from the engine's event log: `undefined`
 * when it is not known (no log binding, a run predating the log, or a caller that has none),
 * `null` when the launch named nothing (a free-text run). Pure.
 */
export function resolveRunIdentity(view: SessionView, launched?: string | null): ResolvedRun {
  const catalog = [...(view.units ?? [])]
    .sort((a, b) => a.ord - b.ord)
    .map((u) => (typeof u.catalog === 'string' && u.catalog !== '' ? u.catalog : null));
  return { ...identityOf(view, launched), catalog };
}

function identityOf(view: SessionView, launched: string | null | undefined): RunIdentity {
  const s = view.session;
  const plan = teamPlanOf(view);
  if (plan !== null) {
    return typeof plan.preset === 'string' && plan.preset !== ''
      ? identity('preset', plan.preset)
      : identity('user_plan', null);
  }
  const recorded = typeof s.workflow_id === 'string' ? s.workflow_id : '';
  if (recorded !== '' && perRunPlanRunId(recorded) !== null) return identity('user_plan', null);
  if (recorded !== '' && !isSyntheticWorkflowId(recorded)) {
    return identity('workflow', baseWorkflowId(recorded, s.id));
  }
  if (launched === undefined) return identity('unknown', null);
  if (launched === null || launched === '') return identity('free_text', null);
  if (perRunPlanRunId(launched) !== null) return identity('user_plan', null);
  // A preset launch whose plan state is not written yet (the planning stub) names its preset here
  // too; its units, once planned, carry catalog ids. Either way the NAME is what callers read.
  const catalogPlanned = (view.units ?? []).some(
    (u) => typeof u.catalog === 'string' || (u as { team_run?: boolean }).team_run === true,
  );
  // A crew-composed per-run def (`<base>-deliver-<run>`, `<base>-verified-<run>`) reads as its base.
  return identity(catalogPlanned ? 'preset' : 'workflow', baseWorkflowId(launched, s.id));
}

/** The wire half of a resolution (`AgentSession.run_identity`): the identity without the catalog. */
export function wireIdentity(resolved: ResolvedRun): RunIdentity {
  return { kind: resolved.kind, name: resolved.name, user_plan: resolved.user_plan, system: resolved.system };
}

/**
 * The identity of a served run view: the one the adapter attached (`session.run_identity`, which
 * the event-log read informed), else resolved from the record alone. Every caller asking "what is
 * this run?" goes through here.
 */
export function runIdentityOf(view: SessionView): ResolvedRun {
  const attached = view.session.run_identity;
  const resolved = resolveRunIdentity(view);
  if (attached === undefined || attached === null) return resolved;
  return { ...attached, catalog: resolved.catalog };
}

/** The run's preset or workflow NAME (`null` for a user plan, a free-text run, or an unknown one). */
export function runNameOf(view: SessionView): string | null {
  return runIdentityOf(view).name;
}

/**
 * The registered def carrying the run's name, for callers that read def fields (acceptance,
 * delivery candidacy, the deliver text). `null` when the run has no name or the registry holds no
 * def under it. A lookup BY NAME — never by phase sequence.
 */
export function runWorkflowDef(view: SessionView, workflows: WorkflowDef[]): WorkflowDef | null {
  const name = runNameOf(view);
  if (name === null) return null;
  return workflows.find((w) => w.id === name) ?? null;
}
