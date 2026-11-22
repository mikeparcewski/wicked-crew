/**
 * THE policy-rule landing (DES-MEM-FACETED-001 §5.2; DC-S3 probe + read-back; DC-S4a one path).
 *
 * `POST /proposals/:id/approve` (an ordinary policy proposal) and the decision landing
 * (`decisions/land.ts remember()`) both end here, so the probe, the read-back and the audit cannot
 * drift between them:
 *
 * 1. probe: a project-scoped (or superseding) rule on an engine without project rules fails loud
 *    and writes nothing — the engine would accept the fields and drop them, landing it everywhere;
 * 2. upsert through the single-writer actor;
 * 3. read-back: the stored rule must still carry `targets.project`, the proposal ref and every
 *    `supersedes` id; a mismatch RETIRES the just-written rule (retire, never delete) and fails loud;
 * 4. audit `governance.rule.upserted` with the caller's `via`.
 *
 * Failures are returned in-band (`outcome:"failed"`, the crew#388 anti-silent-loss doctrine).
 */

import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, ConformanceRule, PolicyLandingResult, PolicyReach, SteeringType } from '../core/types.js';
import type { AuditLog } from './audit.js';
import { STEERING_TYPE_VALUES, STEERING_TYPES } from './governance-steering.js';

const V = '/api/v1';

/**
 * Map an APPROVED policy proposal (estate `proposal.approve` → `handed_off`) into a steering
 * ConformanceRule (DES-MEM-FACETED-001 §5.2). A policy proposal's `kind_type` is
 * `policy:<steering_type>` and its `payload` is `{ rule, severity }`; estate writes NOTHING for it
 * (the AW-11 "no rules.write on estate" invariant) and hands the payload back for crew — the ONE
 * governed rules-write path — to land. Returns the rule to upsert plus the resolved steering type,
 * or a loud `error` string when the proposal cannot be shaped into a valid rule (a malformed
 * `kind_type` / missing `rule` / out-of-enum `severity`) — the caller reports it as a failed
 * landing, never a silent drop (the crew#388 anti-silent-loss doctrine).
 *
 * The rule id is DETERMINISTIC (`proposal:<id>`) so a re-driven landing UPSERTS the same rule
 * (idempotent) instead of minting a duplicate; it sits OUTSIDE the reserved `PAT-/POL-` namespace,
 * which UI/chat/proposal-authored rules are free to do (INV-C1). The rule carries NO `effect`
 * (recall-only — exactly what `{rule, severity}` supports: an enforcement rule would need a
 * non-blank `applies_to`, which the payload does not carry, and INV-S3 fails such a rule closed).
 * `steering_type` is validated against the vocabulary here so the engine's INV-S1 never rejects it
 * as an unknown page.
 */
export function policyProposalToRule(
  proposalId: string,
  kindType: string,
  payload: unknown,
  facets: Record<string, string> | undefined,
  scope: { runProject?: string; reach?: PolicyReach; projects?: readonly KnownProject[] } = {},
): { rule: ConformanceRule; steeringType: SteeringType; reach: PolicyReach } | { error: string } {
  const steeringType = kindType.startsWith('policy:') ? kindType.slice('policy:'.length) : '';
  if (!STEERING_TYPES.has(steeringType)) {
    return {
      error:
        `the approved proposal's kind_type ${JSON.stringify(kindType)} does not name a steering ` +
        `type — expected \`policy:<${STEERING_TYPE_VALUES.join('|')}>\``,
    };
  }
  const body =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const statement = typeof body['rule'] === 'string' ? (body['rule'] as string).trim() : '';
  if (statement === '') {
    return {
      error:
        'the approved policy proposal payload has no `rule` string to make a rule statement from',
    };
  }
  const rawSeverity = body['severity'];
  // Normalize common LLM drift before the enum check: a model naturally writes the English word
  // "warning", but the engine's enum is the short "warn" (info/error/critical are already the
  // natural words). Tolerate case/whitespace too. A capture worker that says "warning" must still
  // land its policy — otherwise every derived policy at the middle band silently fails to land.
  const normSeverity =
    typeof rawSeverity === 'string'
      ? (() => {
          const s = rawSeverity.trim().toLowerCase();
          return s === 'warning' ? 'warn' : s;
        })()
      : rawSeverity;
  const severity =
    normSeverity === 'info' || normSeverity === 'warn' || normSeverity === 'error' || normSeverity === 'critical'
      ? normSeverity
      : undefined;
  if (rawSeverity !== undefined && severity === undefined) {
    return {
      error:
        `the approved policy proposal payload has an invalid severity ${JSON.stringify(rawSeverity)} — ` +
        'expected info|warn|error|critical (or the natural "warning" for warn)',
    };
  }
  const language = facets?.['language'];
  const facetProject = facets?.['project'];
  const repo = facets?.['repo'];
  const named = (v: unknown): v is string => typeof v === 'string' && v !== '';
  // REACH — what the rule is about, the same `reach` word memories use: `operator` = how the operator
  // works, a rule for EVERY project; `project` = that project's (or repo's) code. The proposer sets
  // it (`payload.reach`), the person may change it at accept (`scope.reach`); a row with none (filed
  // before the field) reads as `project` when its facets name a project or repo, else `operator` —
  // exactly where it landed before. Never widened or narrowed silently: the landing reports it.
  const rawReach = scope.reach ?? body['reach'];
  if (rawReach !== undefined && rawReach !== 'project' && rawReach !== 'operator') {
    return {
      error: `the policy proposal has an invalid reach ${JSON.stringify(rawReach)} — expected "project" (that project or repo) or "operator" (every project)`,
    };
  }
  const reach: PolicyReach = rawReach ?? (named(facetProject) || named(repo) ? 'project' : 'operator');
  // DC-S3: a project rule's `targets.project` is the project the `project` facet names (crew#1774: resolved against
  // the known projects, since proposers often write a repo-ish name the engine never matches), else the project of
  // the run that filed it (`scope.runProject`, the caller's membership lookup of `provenance.run_id`).
  const project = reach === 'operator' ? undefined : resolvePolicyProject(facetProject, scope.runProject, scope.projects ?? []);
  // The engine's Targets has no repo slot. A project-reach rule that resolves to no project would
  // land as a rule for EVERY project (the tiny-calc rules that went global), so it fails loud and
  // writes nothing; the person rejects it, or accepts it with reach "operator" on purpose.
  if (reach === 'project' && project === undefined) {
    return {
      error:
        `the policy proposal's reach is one project${named(repo) ? ` (repo \`${repo}\`)` : ''}, but it names no ` +
        `${named(facetProject) ? `known project (its project facet is ${JSON.stringify(facetProject)})` : 'project'} ` +
        'and the run that filed it is in no project; steering rules are scoped by project, so it would land ' +
        'as a rule for every project — reject it, or accept it with reach "operator" if it is meant for every project',
    };
  }
  const targets: ConformanceRule['targets'] = {};
  if (typeof language === 'string' && language !== '') targets.language = language;
  // The caller probes the engine and reads the rule back.
  if (project !== undefined) targets.project = project;
  const rule: ConformanceRule = {
    id: `proposal:${proposalId}`,
    rule_type: 'policy',
    statement,
    // A policy proposal SHOULD carry severity; a missing one defaults to `warn` (the middle band)
    // rather than failing the landing, but a present-but-garbage one fails loud above.
    severity: severity ?? 'warn',
    // REQUIRED engine-side (f32, no serde default, INV-C2 `[0,1]`); the payload carries none, so a
    // fixed authority — the same 0.8 the steering-author landing defaults to.
    confidence: 0.8,
    // `language` and `project` map onto the engine's Targets; a `repo` facet has no rule slot (a
    // project-reach proposal that resolves to no project is refused above).
    targets,
    // The landed rule names the proposal it came from (DC-S3), the same id it is keyed on.
    provenance: { source: 'proposal', ref: `proposal:${proposalId}`, source_kinds: [] },
    steering_type: steeringType as SteeringType,
  };
  return { rule, steeringType: steeringType as SteeringType, reach };
}

/** A project a facet may name: its id, or its name. */
export interface KnownProject {
  id: string;
  name?: string;
}

/**
 * crew#1774: the project id a policy proposal's `project` facet names. The engine matches `targets.project` against
 * the job's project id, so a facet that is a name (`wicked-crew`, `carddemo`) copied verbatim lands a rule that never
 * applies. The facet resolves to the project with that id, else to the ONE project with that name (case and spaces
 * ignored); a facet that names no known project (or a name two projects share) does not resolve.
 */
export function projectIdFor(facet: string | undefined, projects: readonly KnownProject[]): string | undefined {
  if (typeof facet !== 'string' || facet.trim() === '') return undefined;
  const byId = projects.find((p) => p.id === facet);
  if (byId !== undefined) return byId.id;
  const want = facet.trim().toLowerCase();
  const byName = projects.filter((p) => typeof p.name === 'string' && p.name.trim().toLowerCase() === want);
  return byName.length === 1 ? byName[0]!.id : undefined;
}

/** The project a project-reach policy rule targets: the one its facet names, else its filing run's, else none. */
export function resolvePolicyProject(facet: string | undefined, runProject: string | undefined, projects: readonly KnownProject[]): string | undefined {
  return projectIdFor(facet, projects) ?? (typeof runProject === 'string' && runProject !== '' ? runProject : undefined);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Withdraw the rule a policy proposal landed, once the proposal is rejected. The rule lands BEFORE
 * estate approves the proposal, so a proposal left pending (a crash between the two, or an approve
 * estate did not confirm) may already have a live `proposal:<id>` rule; rejecting the proposal must
 * not leave it in force. Returns `null` when nothing is live (a memory proposal, never landed, or
 * already retired) or the rule was retired, else the loud reason the retire failed.
 */
export async function withdrawLandedRule(
  adapter: Pick<CoreAdapter, 'readConformanceRule' | 'retireConformanceRule'>,
  proposalId: string,
): Promise<string | null> {
  const id = `proposal:${proposalId}`;
  try {
    const stored = await adapter.readConformanceRule(id);
    if (stored === null || stored.retired === true) return null;
    await adapter.retireConformanceRule(id);
    return null;
  } catch (err) {
    return `the proposal is rejected but its landed rule ${id} could not be retired (${message(err)}); retire it by hand via DELETE ${V}/governance/rules/${id}`;
  }
}

export interface PolicyLandingDeps {
  adapter: Pick<CoreAdapter, 'projectRulesSupported' | 'upsertConformanceRule' | 'readConformanceRule' | 'retireConformanceRule'>;
  audit: AuditLog;
}

export async function landPolicyRule(
  deps: PolicyLandingDeps,
  built: { rule: ConformanceRule; steeringType: SteeringType; reach?: PolicyReach },
  actor: Actor,
  detail: { via: string; proposalId: string } & Record<string, unknown>,
): Promise<PolicyLandingResult> {
  const { adapter, audit } = deps;
  const project = built.rule.targets.project;
  const supersedes = built.rule.supersedes ?? [];
  if ((project !== undefined || supersedes.length > 0) && !adapter.projectRulesSupported()) {
    return {
      outcome: 'failed',
      error:
        project !== undefined
          ? `the approved policy proposal is scoped to project \`${project}\`, but the installed engine ` +
            'cannot keep a rule\'s project and would land it everywhere; upgrade wicked-core-ts (>= 0.7.35)'
          : 'the rule replaces other rules (`supersedes`), but the installed engine would drop the field; ' +
            'upgrade wicked-core-ts (>= 0.7.35)',
    };
  }
  try {
    await adapter.upsertConformanceRule(built.rule);
  } catch (err) {
    return {
      outcome: 'failed',
      error: `the store refused the steering rule derived from the approved policy proposal: ${message(err)}`,
    };
  }
  let lost: string | null;
  try {
    const stored = await adapter.readConformanceRule(built.rule.id);
    const storedSupersedes = new Set(stored?.supersedes ?? []);
    const missing = supersedes.filter((s) => !storedSupersedes.has(s));
    lost =
      stored === null
        ? 'the rule is not in the store'
        : (stored.targets?.project ?? undefined) !== project
          ? `targets.project reads back ${JSON.stringify(stored.targets?.project ?? null)}, not ${JSON.stringify(project ?? null)}`
          : stored.provenance?.ref !== built.rule.provenance.ref
            ? `provenance.ref reads back ${JSON.stringify(stored.provenance?.ref ?? null)}, not ${JSON.stringify(built.rule.provenance.ref)}`
            : missing.length > 0
              ? `supersedes reads back without ${JSON.stringify(missing)}`
              : null;
  } catch (err) {
    lost = `the rule could not be read back (${message(err)})`;
  }
  if (lost !== null) {
    let retired: string;
    try {
      await adapter.retireConformanceRule(built.rule.id);
      retired = `rule ${built.rule.id} was retired`;
    } catch (err) {
      retired = `retiring rule ${built.rule.id} FAILED (${message(err)}); retire it by hand via DELETE ${V}/governance/rules/${built.rule.id}`;
    }
    return { outcome: 'failed', error: `the engine did not keep the landed rule as written: ${lost}; ${retired}` };
  }
  audit.record('governance.rule.upserted', actor, {
    detail: {
      id: built.rule.id,
      source: 'proposal',
      steeringType: built.steeringType,
      ...detail,
      ...(project !== undefined ? { project } : {}),
      ...(supersedes.length > 0 ? { supersedes } : {}),
    },
  });
  return {
    outcome: 'landed',
    ruleId: built.rule.id,
    steering_type: built.steeringType,
    reach: built.reach ?? (project !== undefined ? 'project' : 'operator'),
    ...(project !== undefined ? { project } : {}),
  };
}

export interface InertRuleMigrationDeps {
  adapter: PolicyLandingDeps['adapter'] & Pick<CoreAdapter, 'listConformanceRules' | 'projectList'>;
  audit: AuditLog;
  /** The approve queue (estate `proposal.*`): an approved proposal's `provenance.run_id`. */
  estateTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The project a run is filed in (the membership index). */
  projectOf: (runId: string) => string | undefined;
  log: (msg: string) => void;
}

/** The actor the migration's audit lines name. */
const MIGRATION_ACTOR: Actor = { id: 'crew', kind: 'system', trust: 'admin' };

/**
 * crew#1774: the rules a policy landing put in force before the facet was resolved, whose `targets.project` is a name
 * no project has, apply to no run. Once per boot, each live proposal-sourced rule whose project is not a known project
 * id (and not shaped like one: a deleted project's `proj_…` id is left alone) is retargeted to the project its facet
 * names or its filing run's project, through THE landing (probe, upsert, read-back, audit `via:
 * 'inert-project-migration'`). One that resolves to no project is retired (never deleted), audited with the name it
 * carried, so the operator can author it again for the right project; when the approve queue cannot be read, none is
 * retired (its run might have resolved it). Nothing to do = no estate call. Never throws.
 */
export async function migrateInertPolicyRules(deps: InertRuleMigrationDeps): Promise<{ retargeted: string[]; retired: string[] }> {
  const done = { retargeted: [] as string[], retired: [] as string[] };
  try {
    const [rules, projects] = await Promise.all([deps.adapter.listConformanceRules(), deps.adapter.projectList()]);
    const known = new Set(projects.map((p) => p.id));
    const inert = rules.filter((r) => {
      const target = r.targets?.project;
      return (
        r.retired !== true &&
        r.provenance?.source === 'proposal' &&
        typeof target === 'string' &&
        target !== '' &&
        !known.has(target) &&
        !/^proj_/.test(target)
      );
    });
    if (inert.length === 0) return done;
    const runOf = new Map<string, string>();
    let queueRead = true;
    try {
      const listed = (await deps.estateTool('proposal.list', { state: 'approved' })) as { proposals?: Array<{ id?: unknown; provenance?: Record<string, unknown> }> };
      for (const p of listed.proposals ?? []) {
        const run = p.provenance?.['run_id'];
        if (typeof p.id === 'string' && typeof run === 'string' && run !== '') runOf.set(p.id, run);
      }
    } catch (err) {
      queueRead = false;
      deps.log(`[policy-landing] the approve queue could not be read for the inert-rule migration (${message(err)}); rules resolve by their project name only, and none is retired`);
    }
    for (const rule of inert) {
      const facet = rule.targets.project as string;
      const ref = rule.provenance.ref ?? '';
      const proposalId = ref.startsWith('proposal:') ? ref.slice('proposal:'.length) : rule.id;
      const run = runOf.get(proposalId);
      const project = resolvePolicyProject(facet, run !== undefined ? deps.projectOf(run) : undefined, projects);
      if (project !== undefined) {
        const landing = await landPolicyRule(
          deps,
          { rule: { ...rule, targets: { ...rule.targets, project } }, steeringType: rule.steering_type as SteeringType, reach: 'project' },
          MIGRATION_ACTOR,
          { via: 'inert-project-migration', proposalId, from: facet },
        );
        if (landing.outcome === 'landed') {
          done.retargeted.push(rule.id);
          continue;
        }
        deps.log(`[policy-landing] retargeting rule ${rule.id} from ${JSON.stringify(facet)} to ${project} failed: ${landing.error ?? 'unknown'}`);
        continue;
      }
      // Without the filing runs a rule might have resolved through its run: it is left for the next boot.
      if (!queueRead) continue;
      try {
        await deps.adapter.retireConformanceRule(rule.id);
        deps.audit.record('governance.rule.retired', MIGRATION_ACTOR, { detail: { id: rule.id, via: 'inert-project-migration', project: facet } });
        done.retired.push(rule.id);
      } catch (err) {
        deps.log(`[policy-landing] retiring inert rule ${rule.id} (project ${JSON.stringify(facet)}) failed: ${message(err)}`);
      }
    }
    if (done.retargeted.length + done.retired.length > 0) {
      deps.log(`[policy-landing] rules that named no project: retargeted ${done.retargeted.join(', ') || 'none'}; retired ${done.retired.join(', ') || 'none'}`);
    }
  } catch (err) {
    deps.log(`[policy-landing] the inert-rule migration could not run: ${message(err)}`);
  }
  return done;
}
