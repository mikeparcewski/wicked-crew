/**
 * THE STEERING-AUTHOR LANDING (crew#388) — the post-approval write that closes TH-12.
 *
 * ## The defect
 *
 * The `steering-author` workflow's doctrine says "approved rules land via the rules CRUD with
 * `provenance.source: "chat"` — the run itself writes nothing", and the propose phase tells the
 * worker "do not write them yourself". Correct on both counts — evaluator≠creator — but NO
 * component performed the write: the generic `POST /runs/:id/gate` only confirmed the gate, core
 * has no steering-author hook, and the studio's `onRunResolved` only reloads rules. Every
 * chat-authored rule ever approved was silently lost, orphaned as prose in the run's transcript
 * (campaign 2026-09-01, scenario C5, run f3db4335).
 *
 * ## The design
 *
 * The landing is CREW-side, on APPROVE of the propose gate — the run keeps writing nothing to the
 * store. The proposal is read machine-readably first: the propose phase now ALSO writes the
 * proposed-rules JSON to a declared per-run artifact (`<steering inbox>/proposed-rules.json`,
 * inside the run's own `extraWriteRoots`) — an ARTIFACT of the proposal, not a store write, so
 * evaluator≠creator holds. Parsing the propose unit's stored transcript is the FALLBACK (runs
 * launched before this fix, or a worker that ignored the file contract), and the cached gate
 * prompt is the last resort (the transcript is written only on approval, so a store hiccup there
 * still has the prompt core composed FROM that output).
 *
 * Invariants:
 *  - AUDITABLE — every landed rule records `governance.rule.upserted` with the chat provenance
 *    and the run id, exactly as the doctrine documents; a landing that could not happen records
 *    `governance.steering.landing_failed` with the reason.
 *  - IDEMPOTENT — a durable marker (`landed.json` beside the proposal) is written after a full
 *    landing; a replayed approve (daemon restart mid-request, double-driven gate) finds it and
 *    re-lands nothing. The rule write itself is an UPSERT keyed by rule id, so even a lost
 *    marker degrades to a same-content overwrite, never a duplicate rule.
 *  - FAIL-LOUD — when no source yields a parseable proposal the approve still succeeds for the
 *    RUN (the gate decision is the operator's and already happened), but the response and the
 *    audit trail carry an explicit `landing.outcome: "failed"` with the reason. A silent no-op
 *    is the bug this module exists to end.
 *  - AMEND-APPROVE — an approve carrying an amend note lands the proposal UNCHANGED: the amend
 *    steers the RUN (core injects it into the run's continuation), not the rule text. An
 *    operator who wants different rules rejects and re-authors; editing rule text inside a gate
 *    note would land words nobody reviewed as JSON nobody saw.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import type { CoreAdapter } from '../core/adapter.js';
import type { Actor, ConformanceRule, SessionView, WorkflowDef } from '../core/types.js';
import { resolveRunWorkflow } from '../qe/acceptance.js';
import { coreUnitId } from './evidence.js';
import { STEERING_PROPOSAL_FILENAME, STEERING_TYPES, steeringInboxDir } from './governance-steering.js';
export { STEERING_PROPOSAL_FILENAME } from './governance-steering.js';
import type { AuditLog } from './audit.js';

/** The workflow whose propose gate this landing serves. */
export const STEERING_AUTHOR_WORKFLOW = 'steering-author';

/** Durable idempotency marker written beside the proposal after a full landing. */
export const STEERING_LANDED_MARKER_FILENAME = 'landed.json';

/** Where the propose phase is told to write its machine-readable proposal. */
export function steeringProposalPath(runId: string): string {
  return join(steeringInboxDir(runId), STEERING_PROPOSAL_FILENAME);
}

/** Where a completed landing records what it landed (replay dedupe). */
export function steeringLandedMarkerPath(runId: string): string {
  return join(steeringInboxDir(runId), STEERING_LANDED_MARKER_FILENAME);
}

/**
 * The steering fields a rule write may carry (the merged model's additions) — mirrored by
 * `POST /governance/rules`, which refuses them on a pre-steering engine because the engine
 * would silently DROP them and persist a rule that enforces differently than written. The
 * landing applies the same guard: authored-then-downgraded is a loud landing failure, never
 * a quiet field amputation.
 */
export const STEERING_RULE_FIELDS = [
  'steering_type',
  'applies_to',
  'excludes',
  'weight',
  'effect',
  'trigger',
  'obligations',
  'criteria',
] as const;

/** Where the landed proposal was read from, most-preferred first. */
export type SteeringProposalSource = 'deliverable' | 'transcript' | 'gate-prompt';

/**
 * The `landing` field on the `POST /runs/:id/gate` (and gated `/resume`) 200 body — present
 * ONLY when the approved gate was a steering-author propose gate. Published as
 * `SteeringLandingResult` in wicked-crew-api-types.
 */
export interface SteeringLandingResult {
  /** `landed` = every proposed rule is in the store; `failed` = the RUN still advanced but the
   *  landing (wholly or partly) did not — `error` says why, and the audit trail carries it. */
  outcome: 'landed' | 'failed';
  /** Rule ids actually upserted (all of them on `landed`; the partial set on a partial `failed`). */
  ruleIds: string[];
  /** Where the proposal was read from. Absent when no source yielded one. */
  source?: SteeringProposalSource;
  /** `true` when a replayed approve found the durable marker — nothing was re-landed. */
  alreadyLanded?: boolean;
  /** Present iff `outcome: "failed"` — the loud, operator-readable reason. */
  error?: string;
}

/** True when this run IS a steering-author run (by workflow id, or — for runs whose stored
 *  `workflow_id` is core's `wf-<uuid>` instance id — by exact phase sequence). Defensive on a
 *  view without a `workflow_id` (partial-stub adapters in tests; a free-text run has no def):
 *  "not steering-author" is the honest answer there, and the legacy gate path must not 500. */
export function isSteeringAuthorRun(run: SessionView, workflows: WorkflowDef[]): boolean {
  if (typeof run.session.workflow_id !== 'string') return false;
  return resolveRunWorkflow(run, workflows)?.id === STEERING_AUTHOR_WORKFLOW;
}

/**
 * Recover the default steering type from the author route's own problem-statement preamble
 * (`Author steering rules for the '<type>' steering type …`) so a proposed rule that omitted
 * `steering_type` still lands on the sub-page the operator authored it for. `undefined` when
 * the problem does not carry the preamble (a hand-launched run) — the engine's serde default
 * (`architecture`) then applies, same as any other write.
 */
export function steeringTypeFromProblem(problem: string): string | undefined {
  const m = /^Author steering rules for the '([a-z-]+)' steering type/.exec(problem);
  const type = m?.[1];
  return type !== undefined && STEERING_TYPES.has(type) ? type : undefined;
}

/** A parsed-but-not-yet-normalized proposal entry. */
type RawRule = Record<string, unknown>;

function isRawRule(v: unknown): v is RawRule {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as RawRule)['id'] === 'string' &&
    ((v as RawRule)['id'] as string).trim().length > 0 &&
    typeof (v as RawRule)['statement'] === 'string' &&
    ((v as RawRule)['statement'] as string).trim().length > 0
  );
}

/** Accept a bare array or a `{ rules: [...] }` wrapper; every entry must look like a rule. */
function rulesFromJson(parsed: unknown): RawRule[] | null {
  const arr = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as RawRule)['rules'])
      ? ((parsed as RawRule)['rules'] as unknown[])
      : null;
  if (arr === null || arr.length === 0) return null;
  return arr.every(isRawRule) ? (arr as RawRule[]) : null;
}

/**
 * Extract the proposed rules from free text — the whole text as JSON first (the deliverable
 * file's shape), then each fenced code block, then every balanced top-level `[...]` in the
 * text (the transcript / gate-prompt shape, where the JSON array is embedded in prose).
 * `null` when nothing parses to a non-empty array of `{id, statement}` objects.
 */
export function extractProposedRules(text: string): RawRule[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // 1. The whole text is the JSON (the deliverable-file contract).
  try {
    const whole = rulesFromJson(JSON.parse(trimmed));
    if (whole !== null) return whole;
  } catch {
    /* fall through to embedded extraction */
  }

  // 2. Fenced code blocks — workers habitually wrap JSON in ```json fences.
  for (const m of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    const block = m[1];
    if (block === undefined) continue;
    try {
      const rules = rulesFromJson(JSON.parse(block.trim()));
      if (rules !== null) return rules;
    } catch {
      /* try the next block */
    }
  }

  // 3. Balanced top-level arrays embedded in prose. String-aware bracket walk, so a `]` inside
  //    a statement never closes the array early.
  for (let i = trimmed.indexOf('['); i !== -1; i = trimmed.indexOf('[', i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j++) {
      const ch = trimmed[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const rules = rulesFromJson(JSON.parse(trimmed.slice(i, j + 1)));
            if (rules !== null) return rules;
          } catch {
            /* not JSON — keep scanning from the next '[' */
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Stamp the chat provenance and the recovered default steering type onto one proposed rule.
 * `source: "chat"` is FORCED, not defaulted — the landing is the doctrine's one write path for
 * chat-authored rules, and a worker that wrote some other source into its proposal must not be
 * able to disguise where the rule came from. Everything else passes through untouched: the
 * ENGINE's upsert path is the one spelling of what a valid rule is.
 */
export function normalizeProposedRule(raw: RawRule, defaultType?: string): ConformanceRule {
  const prior =
    typeof raw['provenance'] === 'object' && raw['provenance'] !== null && !Array.isArray(raw['provenance'])
      ? (raw['provenance'] as Record<string, unknown>)
      : {};
  const sourceKinds = Array.isArray(prior['source_kinds']) ? prior['source_kinds'] : [];
  const out: RawRule = {
    ...raw,
    provenance: { ...prior, source: 'chat', source_kinds: sourceKinds },
  };
  const declaredType = raw['steering_type'];
  if (
    (typeof declaredType !== 'string' || !STEERING_TYPES.has(declaredType)) &&
    defaultType !== undefined
  ) {
    out['steering_type'] = defaultType;
  }
  return out as unknown as ConformanceRule;
}

/** The adapter surface the landing needs — narrow, so tests stub exactly what runs. */
export type SteeringLandingAdapter = Pick<
  CoreAdapter,
  'workOutput' | 'upsertConformanceRule' | 'steeringSupported'
>;

export interface SteeringLandingDeps {
  adapter: SteeringLandingAdapter;
  audit: AuditLog;
  actor: Actor;
}

/** The durable marker's shape. */
interface LandedMarker {
  ruleIds: string[];
  source: SteeringProposalSource;
  at: string;
}

/** Read a file, mapping ONLY a missing file to null — any other error (EACCES, EIO) throws. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Perform the landing for an APPROVED steering-author propose gate. Called AFTER
 * `confirmGate` resolved — the gate decision is already durable; this function's only job is
 * the write the doctrine promised. Never throws: every failure is folded into a loud
 * `outcome: "failed"` result (and the audit trail), because a landing error must not turn an
 * already-successful gate approval into an HTTP 500.
 *
 * `gatePrompt` is the cached gate prompt captured BEFORE the confirm (terminal events prune
 * the cache) — the last-resort proposal source.
 */
export async function landSteeringProposal(
  deps: SteeringLandingDeps,
  run: SessionView,
  gatePrompt?: string,
): Promise<SteeringLandingResult> {
  const runId = run.session.id;
  const { adapter, audit, actor } = deps;

  const failed = (error: string, landedIds: string[] = [], source?: SteeringProposalSource): SteeringLandingResult => {
    audit.record('governance.steering.landing_failed', actor, {
      runId,
      detail: { error, ...(landedIds.length > 0 ? { landedRuleIds: landedIds } : {}) },
    });
    return {
      outcome: 'failed',
      ruleIds: landedIds,
      ...(source !== undefined ? { source } : {}),
      error,
    };
  };

  // ── Idempotency: a replayed approve re-lands nothing ─────────────────────────
  let markerText: string | null = null;
  try {
    markerText = await readIfExists(steeringLandedMarkerPath(runId));
  } catch {
    /* an unreadable marker (not just missing) is treated as absent — the upsert is
       idempotent by rule id, so the worst case is a same-content overwrite */
  }
  if (markerText !== null) {
    try {
      const marker = JSON.parse(markerText) as LandedMarker;
      if (Array.isArray(marker.ruleIds)) {
        return {
          outcome: 'landed',
          ruleIds: marker.ruleIds,
          source: marker.source,
          alreadyLanded: true,
        };
      }
    } catch {
      /* a corrupt marker is treated as absent — the upsert is idempotent anyway */
    }
  }

  // ── Read the proposal: deliverable file → stored transcript → cached gate prompt ──
  let rawRules: RawRule[] | null = null;
  let source: SteeringProposalSource | undefined;

  let fileText: string | null = null;
  try {
    fileText = await readIfExists(steeringProposalPath(runId));
  } catch (err) {
    // A present-but-unreadable deliverable (EACCES, EIO) must NOT silently fall back to the
    // transcript — that would mask an operational failure. Fail the landing loudly instead.
    return failed(
      `the run's proposal deliverable exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (fileText !== null) {
    rawRules = extractProposedRules(fileText);
    if (rawRules !== null) source = 'deliverable';
  }

  if (rawRules === null) {
    // The transcript is stored on approval (deny-dominates writes no output for a rejected
    // unit), so post-confirm it is readable. Find the propose unit by its phase-suffixed id.
    const proposeUnit = run.units.find((u) => u.id === `${runId}:propose` || u.id.endsWith(':propose'));
    if (proposeUnit !== undefined) {
      try {
        const transcript = await adapter.workOutput(coreUnitId(runId, proposeUnit));
        if (transcript !== null) {
          rawRules = extractProposedRules(transcript);
          if (rawRules !== null) source = 'transcript';
        }
      } catch {
        /* an unreadable transcript falls through to the gate prompt */
      }
    }
  }

  if (rawRules === null && gatePrompt !== undefined) {
    rawRules = extractProposedRules(gatePrompt);
    if (rawRules !== null) source = 'gate-prompt';
  }

  if (rawRules === null || source === undefined) {
    return failed(
      `the approved steering proposal could not be parsed from the run record: no ` +
        `${STEERING_PROPOSAL_FILENAME} in the run's steering inbox, and no JSON array of ` +
        `{id, statement} rule objects in the propose unit's stored transcript or gate prompt. ` +
        `The gate approval stands, but NO rules were landed — re-author via ` +
        `POST /governance/steering/author, or land the transcript's rules by hand through ` +
        `POST /governance/rules.`,
    );
  }

  const defaultType = steeringTypeFromProblem(run.session.problem);
  const rules = rawRules.map((r) => normalizeProposedRule(r, defaultType));

  // ── The same pre-steering-engine guard as POST /governance/rules ─────────────
  if (!adapter.steeringSupported()) {
    const carrying = rules.filter((r) =>
      STEERING_RULE_FIELDS.some((f) => (r as unknown as RawRule)[f] !== undefined),
    );
    if (carrying.length > 0) {
      return failed(
        `the installed engine predates the steering model and would silently drop the steering ` +
          `fields on ${carrying.length} proposed rule(s) — landing refused so the rules are not ` +
          `persisted enforcing differently than authored. Upgrade wicked-core-ts (>= 0.7.5) and ` +
          `re-author.`,
      );
    }
  }

  // ── Land, auditing each write exactly as the doctrine documents ──────────────
  const landedIds: string[] = [];
  const failures: string[] = [];
  for (const rule of rules) {
    try {
      await adapter.upsertConformanceRule(rule);
      landedIds.push(rule.id);
      audit.record('governance.rule.upserted', actor, {
        runId,
        detail: { id: rule.id, source: 'chat', via: STEERING_AUTHOR_WORKFLOW },
      });
    } catch (err) {
      failures.push(`${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    return failed(
      `landing was partial: ${landedIds.length} of ${rules.length} proposed rule(s) landed; ` +
        `the store refused ${failures.join('; ')}`,
      landedIds,
      source,
    );
  }

  // ── Durable marker (best-effort — the upsert is idempotent even without it) ──
  try {
    await fsp.mkdir(steeringInboxDir(runId), { recursive: true });
    const marker: LandedMarker = { ruleIds: landedIds, source, at: new Date().toISOString() };
    await fsp.writeFile(steeringLandedMarkerPath(runId), JSON.stringify(marker, null, 2), 'utf8');
  } catch {
    /* a missing marker degrades to a re-upsert of identical content, never a duplicate */
  }

  return { outcome: 'landed', ruleIds: landedIds, source };
}
