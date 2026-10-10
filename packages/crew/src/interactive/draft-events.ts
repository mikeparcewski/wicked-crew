/**
 * Opt-in governed answering of wicked-interactive's first-draft generation (task #86 spike,
 * Phase 7c first leg).
 *
 * wicked-interactive's service is model-free: when a doc is created with `kind: "source"` it
 * seeds a placeholder v0 and emits `wicked.interactive.doc.created`, expecting *something with
 * intelligence* to answer with `wicked.interactive.draft.completed` carrying the first draft
 * (the service then instruments `data-wid` anchors, themes it, and lands `_v1.html`). Today
 * that answerer is an ad-hoc `assist` agent session. This module makes a crew-governed run the
 * answerer instead — same bus vocabulary, zero interactive-service changes beyond the additive
 * producer row (`wi-crew`) in interactive's events.js ownership table.
 *
 * Shape: graceful degradation when no engine holds the bus, a tap from the newest row and every emit through the engine that
 * holds the bus (`core/bus.ts`, wicked-core#631) — crew opens no SQLite of its own.
 *
 * Behavioral invariants honored (recon-verified against interactive):
 *  - Heartbeat: the canvas shows a working veil and the browser fires ~20s
 *    `status.requested` heartbeats; a silent answerer reads as a frozen UI. We narrate
 *    `wicked.interactive.status.posted` on every phase transition AND on a ≤15s timer.
 *  - Idempotency: interactive may re-emit (and a replay tool can re-post) a doc, and a replayed
 *    `doc.created` must not produce a duplicate `_v2.html`. A durable per-doc ledger
 *    (JSON file, atomic rename) gates the launch, and the final `draft.completed` emit carries
 *    a deterministic idempotency key (`crew:interactive.draft:<doc>:v1`) so even a double
 *    emit dedupes at the bus (a duplicate key resolves to the existing row).
 *  - INV-2 (`data-wid`): first drafts are whole documents with no pre-existing anchors — the
 *    service instruments fresh ones — so the worker contract explicitly forbids inventing
 *    `data-wid` attributes rather than requiring preservation. The feedback→edit leg (fragment
 *    preservation at scale) is the structural seam next door: edit-events.ts.
 *  - UNFILED DOCS ARE ANSWERED TOO: this seam originally rejected `doc.created` frames without
 *    a `project_id` ("unbound docs are the assist skill's solo business") — superseded by
 *    DES-UX-001 slice U (wicked-studio, §6.2 + §8.4.1 probe 3), which made unfiled docs a
 *    first-class path created through crew's synthesized `default` mount with NO project field.
 *    Nothing else answers those (BRIEF-UX-001 J3 CRITICAL: the doc sat on its placeholder
 *    forever), so the launch simply omits `projectId` — an unfiled governed run (CREW-UX-2).
 */

import { resolveProjectGraphBinding, type ProjectGraphBinding } from '../projects/graph.js';
import { mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InteractiveHandoffLedger } from './ledger.js';
import { reviewPartitionOf as projectPartitionOf } from './review-ledger.js';
import {
  DRAFT_SKILL,
  draftQualityClause,
  draftSkillArmLine,
  pageBudgetFor,
  runDraftFloor,
  type DraftFloorIo,
  type PageBudget,
  type SkillHeld,
} from './draft-skill.js';
import { crewStateHome } from '../projects/state-home.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import { runDirInsideRepo, snapshotRepo, type SnapshotFailureReason } from './repo-snapshot.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import {
  groundingNarration,
  groundingRecord,
  resolveGroundingRepos,
  snapshotDirName,
  styleContract,
  type DocGroundingStore,
  type GroundingDecision,
  type GroundingRecord,
  type GroundingRepo,
} from './doc-grounding.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';
import { awaitingHumanLine, describeStep, resyncRunUnits, ResyncGate, RunUnits } from './run-units.js';
import {
  acpFallbackLine,
  ungatedGateNote,
  unitDistributedLine,
  workerToolCallDeniedLine,
} from './council-outcome.js';
import { busSubscriberErrorReporter } from './bus-subscriber-errors.js';
import { emitOnBus, requireEngineBus, tapBus, type BusEvent } from '../core/bus.js';

// ── Vocabulary constants (interactive's, verbatim — src/service/events.js is the truth) ──────

export const INTERACTIVE_DOMAIN = 'wicked-interactive';
export const DOC_CREATED = 'wicked.interactive.doc.created';
export const DRAFT_COMPLETED = 'wicked.interactive.draft.completed';
export const STATUS_POSTED = 'wicked.interactive.status.posted';

/** Exact-type filter with a domain guard — no wildcard, one event type is the whole trigger. */
export const INTERACTIVE_BUS_FILTER = `${DOC_CREATED}@${INTERACTIVE_DOMAIN}`;

/** The producer identity stamped on every event crew's interactive seams emit (this module and
 *  edit-events.ts). Must appear in interactive's events.js ownership table for DRAFT_COMPLETED,
 *  EDIT_COMPLETED, and STATUS_POSTED — the additive vocabulary rows that are the only
 *  interactive changes Phase 7c is allowed. */
export const INTERACTIVE_PRODUCER = 'wi-crew';

/** Interactive's doc-name grammar (server.js DOC_NAME) — re-checked before any launch so a
 *  malformed document_id can't name a ledger key or a draft file path. Shared with the
 *  structural-edit seam (edit-events.ts), which guards the same identity. */
export const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The doc-identity half of EVERY payload crew's interactive seams emit (acceptance finding F-045):
 * `document_id`, plus `project_id` when the document is project-bound. The bridge stamps
 * `project_id` on its own emits (DES-PROJECT-001 enrichment) and the studio files frames by it —
 * so a crew heartbeat carrying `document_id` alone was filed under the Unfiled mount while the
 * project-bound thread heard nothing and, 90 s later, told the user "the generation service may
 * be down" over a run that was executing. Shared by all four seams (draft/edit/chat/demo); an
 * unfiled doc keeps the field OFF — never a fabricated 'default'.
 */
export function docScope(
  documentId: string,
  projectId?: string | undefined,
): { document_id: string; project_id?: string } {
  return projectId !== undefined ? { document_id: documentId, project_id: projectId } : { document_id: documentId };
}

/** What every seam's `status.posted` payload carries (before `emitInteractive` stamps `ts`) — the
 *  produced side of the published `InteractiveStatusPosted` frame (wire-contract.test.ts). */
export interface SeamStatusPayload {
  document_id: string;
  project_id?: string;
  state: 'processing' | 'working' | 'asking' | 'complete' | 'error';
  message?: string;
  version?: number;
  /** The governed run this narration is about (wave 6, F-4R2-005): a skin keys narration per run
   *  and per unit instead of one undifferentiated thread. Absent on a pre-launch status. */
  run_id?: string;
  /** The unit (ord) the line narrates — the most recent engine frame's `ord`; absent before the
   *  first unit-scoped frame. */
  unit_ord?: number;
  /** crew#512: the document's repository grounding as data — on the ONE frame per draft launch that
   *  carries the "Grounded on …" narration (the published `InteractiveDocGrounding`). */
  grounding?: GroundingRecord;
}

/**
 * The `run_id` / `unit_ord` stamps every seam's narration and heartbeat carry (F-4R2-005): the run
 * the flight launched and the ord of the latest unit-scoped engine frame — so a repeated heartbeat
 * says which unit it is still waiting on, and a skin can render one council at a time.
 */
export function narrationStamps(flight: {
  runId?: string | undefined;
  narrationOrd?: number | undefined;
}): { run_id?: string; unit_ord?: number } {
  return {
    ...(flight.runId !== undefined ? { run_id: flight.runId } : {}),
    ...(flight.narrationOrd !== undefined ? { unit_ord: flight.narrationOrd } : {}),
  };
}

/** How long a seam waits for the proxy to record a document's create-time grounding binding when
 *  a create for the same project is still in flight (doc-grounding.ts `waitFor`): the bridge emits
 *  `doc.created` before it answers the create, so the bus can beat the record by a few ms. */
export const GROUNDING_BINDING_WAIT_MS = 3000;

// ── The workflow (workflows-as-data) ─────────────────────────────────────────────────────────

/**
 * The governed workflow that produces a first draft: the wicked-core built-in preset
 * `interactive-draft` (X-MIG M9, wicked-core#860; crew#935). Its one creator step plans, then
 * writes (crew#621: a separate neutral `outline` phase authored the whole deliverable in its
 * output, so the split was deleted rather than gated), and runs `wicked-garden-draft`, the document
 * quality floor. The engine owns the steps: it puts the PA's RISK rating (`pa-scope`) first, adds
 * its floor (`critique`, and more at higher bands), and judges the launch's declared deliverable on
 * the creator step (`LaunchOptions.deliverables`, written by THIS run). Crew registers no def for
 * it; its narration reads the run's planned units (`run-units.ts`). The preset always requires the
 * draft skill: a snapshot without it fails the run before the document work starts.
 */
export const INTERACTIVE_DRAFT_WORKFLOW = 'interactive-draft';

// ── Pure helpers (unit-tested without a bus or an engine) ─────────────────────────────────────

/** The doc-creation fields this seam acts on. */
export interface SourceDocCreated {
  documentId: string;
  brief: string;
  sourcePaths: string[];
  style: string;
  /** The crew project this doc is bound to. `undefined` = an UNFILED doc — a first-class path
   *  since DES-UX-001 slice U (wicked-studio, §6.2 + §8.4.1 probe 3): the Make→Document picker's
   *  Unfiled option creates through crew's synthesized `default` mount with NO project field,
   *  and this seam is the only answerer of its generation. Never fabricate 'default' here — the
   *  governed run is launched unfiled (CREW-UX-2 made `project_id: null` legitimate on the run
   *  DTO), not filed into a project that is a mount alias, not a membership target. */
  projectId?: string;
}

/**
 * Parse a bus frame into a {@link SourceDocCreated}, or `null` when it is not an actionable
 * `doc.created` (wrong type, non-`source` kind, missing/malformed document_id). `kind: "demo"`
 * and plain html docs are the assist loop's business, not this seam's. A missing `project_id`
 * is NOT a rejection: unfiled docs (DES-UX-001 slice U) are actionable with `projectId`
 * undefined — the earlier "unbound docs are the assist skill's solo business" gate is
 * superseded (nothing else answers a doc created through the default mount; BRIEF-UX-001 J3).
 */
export function parseSourceDocCreated(eventType: string, payload: unknown): SourceDocCreated | null {
  if (eventType !== DOC_CREATED) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p['kind'] !== 'source') return null;
  const documentId = typeof p['document_id'] === 'string' ? p['document_id'] : '';
  if (!DOC_NAME.test(documentId)) return null;
  const brief = typeof p['brief'] === 'string' ? p['brief'] : '';
  const sourcePaths = Array.isArray(p['source_paths'])
    ? p['source_paths'].filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const style = typeof p['style'] === 'string' && p['style'].length > 0 ? p['style'] : 'web';
  const projectId =
    typeof p['project_id'] === 'string' && p['project_id'].length > 0 ? p['project_id'] : undefined;
  return { documentId, brief, sourcePaths, style, ...(projectId !== undefined ? { projectId } : {}) };
}

/** Collapse whitespace/newlines to single spaces and cap length — the intent must stay a
 *  single line (the PTY seat runner refuses embedded newlines) and a pasted-novel brief must
 *  not balloon the worker prompt. Shared with the structural-edit seam. */
export function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** A project's repo binding, resolved for a governed launch (CREW-UX-8). */
export interface ProjectRepo {
  /** The registered repo id — the verified registry identity behind `rootPath` (diagnostics
   *  only: deliberately NEVER passed to `launchRun` as `repoRef` — see {@link resolveProjectRepo}). */
  repoRef: string;
  /** The repo's root path — the SOURCE the launch-scoped snapshot is cloned/copied from
   *  (v4). Never handed to the worker directly: an unbound worker's boundary denies reads of
   *  it (wicked-core#294) — the grounding clause names the SNAPSHOT inside the inbox instead. */
  rootPath: string;
}

/**
 * Resolve the repo a project is bound to (CREW-UX-8): the project's first `crew.repo` member,
 * verified against the repo registry so a stale membership (repo deleted after attach) never
 * grounds the task in a path the registry no longer vouches for. `undefined` when the project
 * has no repo member, the registry no longer knows the ref, or the adapter cannot answer (old
 * addon, engine hiccup) — every one of those degrades to today's behavior: an ungrounded launch.
 *
 * NO LONGER THE SEAM'S GROUNDING RULE (acceptance finding F-046): "the first member" grounded a
 * brochure about wicked-studio on wicked-core. The draft and demo seams now resolve through
 * `doc-grounding.ts` `resolveGroundingRepos` — the repos NAMED on the create request, else the
 * ones the brief names, else the project's sole repo, else none (narrated). Kept exported for
 * diagnostics and its callers.
 *
 * WHY: a doc created under a repo-backed project used to launch its governed draft/revision
 * run with NO repo context at all, so the worker could not read the project's actual code and
 * generated placeholder content (operator report, wicked-studio project). Shared by the draft
 * and chat seams.
 *
 * WHY the result feeds a SNAPSHOT, never a binding and never a direct read path (the v4
 * design): the launch itself stays UNBOUND (no `repoRef`), even though the project verifiably
 * has one, because on a repoRef-bound run the worker's ACP tool-permission stream closes on
 * the FIRST call that needs a permission prompt, so the session dies before any work lands —
 * no write destination works, not the external inbox, not an in-repo path (wicked-core#293;
 * v2 of this seam tried both and the adversarial verifier killed each with run evidence).
 * v3 then handed the unbound worker the absolute `rootPath` to READ — but that rested on a
 * boundary-context-dependent premise: the "repo reads work" evidence came from BOUND runs,
 * and an UNBOUND worker's governance boundary is {sandbox, extraWriteRoots,
 * ~/.claude/plugins}, so its reads of the live repo root are governance-DENIED
 * (wicked-core#294). What an unbound worker can always read is the inbox the run already
 * writes to (write roots are readable, wicked-core#259) — so v4 grounds via a capped,
 * launch-scoped repo SNAPSHOT cloned into the inbox crew-side BEFORE the launch (see
 * repo-snapshot.ts), and the grounding clause names the snapshot. `rootPath` here is the
 * clone SOURCE only; `projectId` still passes on the launch — filing is unaffected.
 */
export async function resolveProjectRepo(
  adapter: CoreAdapter,
  projectId: string,
  log?: (message: string) => void,
): Promise<ProjectRepo | undefined> {
  try {
    const members = await adapter.projectMembers(projectId);
    const repoMember = members.find((m) => m.member_kind === 'crew.repo');
    if (repoMember === undefined) return undefined;
    const ref = repoMember.member_ref;
    const repo = (await adapter.listRepos()).find((r) => r.id === ref);
    if (repo === undefined) {
      log?.(
        `[interactive] project ${projectId} has repo member ${ref} but the registry does not — launching without repo context`,
      );
      return undefined;
    }
    return { repoRef: ref, rootPath: repo.root_path };
  } catch (err) {
    log?.(
      `[interactive] could not resolve project ${projectId}'s repo — launching without repo context: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/** The longest snapshot path the grounding clause will carry. NOT a truncation cap — the
 *  clause embeds the path VERBATIM or not at all (see {@link groundablePath}): the snapshot
 *  sits at exactly one spelling, so a flattened/truncated path would ground the worker on a
 *  directory that does not exist (Copilot, crew#313). The budget exists for the PTY prompt
 *  length; a dest over it degrades the launch to ungrounded, honestly narrated. */
export const SNAPSHOT_PATH_MAX = 300;

/** `true` when a snapshot path can ride the grounding clause EXACTLY as spelled: single-line
 *  (the PTY seat runner refuses embedded newlines — and `oneLine`'s whitespace collapse would
 *  respell the path, so it is never applied to paths) and within the prompt budget. */
export function groundablePath(path: string): boolean {
  return path.length <= SNAPSHOT_PATH_MAX && !/[\n\r\t]/.test(path);
}

// ── The recall-prior-learnings clause (DES-MEM-FACETED-001 Phase 3) ───────────────────────────
//
// Phases 1+2 gave the worker's (read-only) estate MCP a faceted `memory.recall`: pass an `intent`
// of `{axis:value}` and it returns memories whose facets are a SUBSET of the intent,
// specificity-ranked. This phase makes the interactive workers USE it — a sibling to the grounding
// clause above: before starting, recall prior decisions/patterns for this work and build on them.
// Shared by all three interactive prompt builders (draft/chat/edit), like `oneLine` and `DOC_NAME`.

/** The facet axes a recall intent can carry. Every axis is OPTIONAL and only defined ones ride the
 *  clause — `memory.recall` matches on a subset, so a `{project}`-only intent is legitimate.
 *  `project` is the reliably-available axis threaded today; `cli`/`repo` are Phase 6. */
export interface RecallIntent {
  project?: string;
  cli?: string;
  repo?: string;
}

/** The non-empty subset of DEFINED axes for a recall intent, or `undefined` when no axis is set.
 *  Only defined axes are included, so `JSON.stringify` never emits `undefined`/`null` keys — the
 *  clause carries exactly the facets that were threaded. */
export function recallIntentObject(intent?: RecallIntent): Record<string, string> | undefined {
  if (intent === undefined) return undefined;
  const obj: Record<string, string> = {};
  if (intent.project !== undefined) obj['project'] = intent.project;
  if (intent.cli !== undefined) obj['cli'] = intent.cli;
  if (intent.repo !== undefined) obj['repo'] = intent.repo;
  return Object.keys(obj).length > 0 ? obj : undefined;
}

/** The recall clause (DES-MEM-FACETED-001 Phase 3): instruct the worker to call the read-only
 *  wicked-estate MCP `memory.recall` with the faceted intent BEFORE it starts, then ground its
 *  work in what returns. Empty (no axis) ⇒ `''` — omitted entirely, exactly like the grounding
 *  clause omits the snapshot fallback when there is no snapshot. SINGLE-LINE by contract (the PTY
 *  seat runner refuses embedded newlines; `JSON.stringify` of a flat string map never emits one). */
export function recallClause(intent?: RecallIntent): string {
  const intentObj = recallIntentObject(intent);
  if (intentObj === undefined) return '';
  return (
    `Before you start, recall relevant prior learnings and decisions for this work: call the ` +
    `wicked-estate MCP memory.recall tool with intent ${JSON.stringify(intentObj)} and a query ` +
    `describing the task, then ground your work in what it returns (it may be empty — that is fine). `
  );
}

/** The propose clause (DES-MEM-FACETED-001 write side): instruct the worker to record a reusable
 *  learning by calling the wicked-estate MCP `proposal.submit` tool. This is a SAFE write — the
 *  proposal lands in a review queue, inert (never recalled or applied) until an operator approves
 *  it, so it can never pollute anything. Unconditional (every worker may propose). SINGLE-LINE by
 *  contract (the PTY seat runner refuses embedded newlines). Provenance is stamped by the server
 *  from the run env, so the worker supplies only content/facets. */
export function proposeClause(): string {
  return (
    `When you learn something reusable that would help a future run — a CLI quirk, a repo build ` +
    `gotcha, a tool behavior, a project decision — record it: call the wicked-estate MCP ` +
    `proposal.submit tool with kind_type "memory", payload {"content":"<the learning>","tier":"procedural"}, ` +
    `and facets tagging ONLY the natural axis it is about (e.g. {"cli":"codex"} for a codex quirk, not ` +
    `tied to this repo). NEVER include secrets, credentials, tokens, API keys, or personal data — a ` +
    `promoted proposal becomes shared memory. proposal.submit is a PERMITTED safe write even though your ` +
    `estate MCP is otherwise read-only (it refuses your other writes) — the proposal is inert (never ` +
    `recalled or applied) until a human reviews it, so proposing costs nothing and pollutes nothing; ` +
    `capturing nothing is fine; never fabricate. `
  );
}

/**
 * The run's problem statement (the engine scopes it per phase and folds each phase's
 * instructions on top). Carries everything doc-specific: identity, brief, sources, style, and
 * the absolute path the finished HTML must land at.
 *
 * PRIMARY grounding (DES-GROUNDING-001 §3.3): every governed worker is now given the
 * wicked-estate MCP tools pointed at a code graph. This draft run is repo-LESS; when the project's
 * graph binding resolves it is passed on the launch and the tools span the project's indexed repos —
 * but for an UNFILED doc, or when `resolveProjectGraphBinding` returns null, the worker instead gets
 * whatever graph the run binds (its repo's, or none). The clause below therefore instructs the
 * worker — UNCONDITIONALLY — to research through
 * those tools (SearchEntity to find, FetchContent to read, ContextBundle to gather related
 * material, RetrieveEntity/TraverseGraph to follow references) and to ground every claim in what
 * they return, never in placeholders. The index is the grounding path.
 *
 * FALLBACK — the file snapshot: when a launch-scoped repo snapshot was cloned into the inbox
 * (CREW-UX-8 v4), its path is named ONLY as a secondary/offline backup the worker uses if the
 * estate tools are unavailable — no longer the whole grounding mechanism. `snapshotDir` is
 * embedded VERBATIM — never flattened, never truncated (the snapshot exists at exactly this
 * path; Copilot, crew#313). The caller guards it with {@link groundablePath} BEFORE snapshotting
 * and omits it (the estate-tool clause still stands alone) when the path cannot ride.
 *
 * SINGLE-LINE by contract: the PTY seat runner refuses any embedded newline (FINDING-011), so
 * every fragment here stays on one line and the brief is flattened+capped by {@link oneLine}.
 */
export function draftProblem(
  doc: SourceDocCreated,
  outPath: string,
  snapshotDir?: string,
  intent?: RecallIntent,
  grounding?: DraftGrounding,
): string {
  const sources =
    doc.sourcePaths.length > 0
      ? `Source materials to read: ${doc.sourcePaths.join(', ')}.`
      : 'There are no source files — the brief alone is the spec.';
  const brief = doc.brief.length > 0 ? oneLine(doc.brief, 2000) : '(no brief provided)';
  // F-046: the SUBJECT — which repositories the document is about, stated before any tool clause,
  // so the worker never substitutes a sibling repository (the brochure-about-studio-drafted-from-
  // core outcome). Absent for an unfiled doc or a repo-less project.
  const subjects = grounding?.subjects ?? [];
  const subjectClause =
    subjects.length > 0
      ? `This document is ABOUT the ${subjects.length === 1 ? 'repository' : 'repositories'} ` +
        `${subjects.map((s) => s.name).join(', ')} — ground every product claim in ` +
        `${subjects.length === 1 ? 'that repository' : 'those repositories'} (never a sibling repository ` +
        `that happens to share the project), and say in the draft's notes when something you need is not in reach. `
      : grounding?.unnamedAmong !== undefined && grounding.unnamedAmong > 1
        ? `The project has ${grounding.unnamedAmong} repositories and none was named for this document — do not ` +
          `present details from an arbitrary one as the subject's; where the brief refers to a specific ` +
          `repository, say in the draft's notes that its source was not in reach. `
        : '';
  // The offline fallback: the subjects' snapshots when grounding resolved them (F-046), else the
  // legacy single snapshot dir a caller passed. Paths ride VERBATIM (Copilot, crew#313).
  const snapshots: Array<{ name: string | undefined; dir: string }> = subjects.flatMap((s) =>
    s.snapshotDir !== undefined ? [{ name: s.name, dir: s.snapshotDir }] : [],
  );
  if (snapshots.length === 0 && snapshotDir !== undefined) snapshots.push({ name: undefined, dir: snapshotDir });
  const fallback =
    snapshots.length === 0
      ? ''
      : snapshots.length === 1
        ? `If the estate tools are unavailable, fall back to the offline repository snapshot at ${snapshots[0]!.dir}` +
          `${snapshots[0]!.name !== undefined ? ` (${snapshots[0]!.name})` : ''} instead. `
        : `If the estate tools are unavailable, fall back to the offline repository snapshots at ` +
          `${snapshots.map((s) => `${s.dir} (${s.name})`).join(' and ')} instead. `;
  const groundingClause =
    `Ground every claim in the indexed repositories via the wicked-estate MCP tools: ` +
    `SearchEntity to find relevant code and docs, FetchContent to read them, ContextBundle to gather ` +
    `related material, and RetrieveEntity/TraverseGraph to follow references — research across all ` +
    `bound repos and use what those tools return, never placeholders. ` +
    fallback;
  // The recall clause (DES-MEM-FACETED-001 Phase 3) sits right beside grounding; `''` when the
  // intent carries no axis, so an unfiled draft reads exactly as it did before this phase.
  const recall = recallClause(intent);
  const propose = proposeClause();
  return (
    `Produce the first draft of the wicked-interactive document "${doc.documentId}" ` +
    `(requested style: ${doc.style} — ${styleContract(doc.style)}). The user's brief: ${brief} ${sources} ` +
    `${subjectClause}${groundingClause}${recall}${propose}` +
    `The finished draft MUST be written to exactly this absolute file path: ${outPath}`
  );
}

/** The subject-repo grounding a draft launch resolved (F-046): the repositories the document is
 *  about — each with the offline snapshot that landed for it, when one did — or, when the project
 *  has several repos and none was named, how many there were (the worker must not guess). */
export interface DraftGrounding {
  subjects: Array<{ name: string; snapshotDir?: string | undefined }>;
  unnamedAmong?: number | undefined;
}

/** Deterministic bus idempotency key for the one draft this seam may land per document. */
export function draftIdempotencyKey(documentId: string, projectId?: string): string {
  const partition = projectPartitionOf(projectId);
  // crew#809: the bus resolves a repeated key to the existing row, so a same-slug document in
  // ANOTHER project must announce under its own key or its draft.completed is silently dropped.
  return partition === '_unfiled'
    ? `crew:interactive.draft:${documentId}:v1`
    : `crew:interactive.draft:${documentId}:${partition}:v1`;
}

// ── Per-project identity of a draft (crew#809) ────────────────────────────────────────────────
//
// A document slug is unique within ONE project (the bridge, its docs root and the slug grammar are
// all per project — review-events.ts partitions its rows the same way), so the draft leg's dedupe
// key, its idempotency key and its per-run directory carry the project too. An UNFILED document
// (no project, or the `default` mount alias) keeps the historical bare `<doc>` key and `<doc>/`
// directory — every ledger row written before this release is an unfiled-or-filed `<doc>` row,
// and only the unfiled ones are still consulted by that spelling: the subscription is live-only
// (no backlog replay), and a dead-lettered pre-upgrade frame never had a row to begin with.

/** The dedupe unit of the draft leg: one first draft per document PER PROJECT. `<doc>` when
 *  unfiled (legacy spelling), `<doc>:draft:<partition>` when filed — it starts `<doc>:` like every
 *  handoff key, so the doc↔run index and the delete sweep see it. */
export function draftHandoffKey(documentId: string, projectId?: string): string {
  const partition = projectPartitionOf(projectId);
  return partition === '_unfiled' ? documentId : `${documentId}:draft:${partition}`;
}

/** Is `key` a draft row of the name `documentId` that is NOT this document's — another project's
 *  (`<doc>:draft:<other partition>`), or, when THIS document is filed, the UNFILED document's bare
 *  `<doc>` row? The delete sweep keeps those: deleting one project's document must not make a
 *  same-named document elsewhere forget that it was drafted (the review seam's
 *  `isAnotherProjectsReviewKey`, for drafts; codex on crew#809 for the unfiled row). */
export function isAnotherProjectsDraftKey(key: string, documentId: string, projectId: string | undefined): boolean {
  const own = draftHandoffKey(documentId, projectId);
  if (key === own) return false;
  if (key.startsWith(`${documentId}:draft:`)) return true;
  return key === documentId && own !== documentId; // the unfiled document's row, when this one is filed
}

/** The per-run directory under the draft root is `<doc>` for every project — studio's run↔thread
 *  binding reads `interactive-drafts/<doc>` back off the run's write root and narrows by `project_id`
 *  (`wicked-studio src/interactive/runBinding.ts`), so the directory grammar cannot carry the
 *  partition. Residual, documented: two projects drafting the SAME slug at the SAME time share that
 *  per-doc directory (deliverable name and snapshot subdir); their keys, announces and ledger rows
 *  do not. */

/** wicked-studio's brand-learn scratch document (`src/theming/scratchDoc.ts`): a FIXED name, kind
 *  `source`, a FIXED brief, one per project, created so a theme learn has a workspace to land tokens
 *  in. It is never a document a person asked to have drafted — answering its creation with a
 *  governed run spent a council and a worker on a scratch pad (crew#811). Matched on the name AND
 *  the brief's fixed opening (codex: a person may legitimately name a document `brand-learn`). */
export const STUDIO_SCRATCH_DOC_NAME = 'brand-learn';
export const STUDIO_SCRATCH_DOC_BRIEF_PREFIX = 'Scratch document wicked-studio uses to learn brand themes';
export function isStudioScratchDoc(doc: { documentId: string; brief: string }): boolean {
  return doc.documentId === STUDIO_SCRATCH_DOC_NAME && doc.brief.trimStart().startsWith(STUDIO_SCRATCH_DOC_BRIEF_PREFIX);
}

// ── Durable per-doc ledger (replay-dedup across redelivery AND daemon restarts) ──────────────
//
// The ledger implementation now lives in ledger.ts (shared with the structural-edit seam);
// this leg keys it by DOCUMENT ID — one first draft per document lifetime. Re-exported here so
// the seam's public surface stays one module.

export { InteractiveHandoffLedger, type HandoffLedgerEntry } from './ledger.js';

// ── The subscriber ────────────────────────────────────────────────────────────────────────────

/** Options for {@link startInteractiveDraftSubscriber}. */
export interface InteractiveDraftOptions {
  /** The bus db the daemon handed its engine (core/bus.ts); without one the seam does not arm. */
  dbPath?: string;
  /** Poll cadence, ms (default 2000; tests shorten it). */
  pollIntervalMs?: number;
  /** Heartbeat narration cadence while a run is in flight, ms (default 15000 — inside the
   *  UI's ~20s `status.requested` window so the canvas never reads frozen). */
  heartbeatMs?: number;
  /** Ledger file (default `~/.wicked-crew/interactive-draft-ledger.json`). */
  ledgerPath?: string;
  /** Root under which each launch gets its own per-run subdirectory (`<draftDir>/<docId>/`)
   *  holding the deliverable and, when grounded, the repo snapshot; only that subdirectory is
   *  declared as the run's extra write root (per-run isolation — Copilot, crew#313).
   *  Default `~/.wicked-crew/interactive-drafts`. */
  draftDir?: string;
  /** Seat roster JSON for the governed run (default: the production council roster).
   *  The functional-test harness passes a deterministic stub seat here. */
  clisJson?: string;
  /** The roster accessor used when `clisJson` is not set — the server wires the daemon's roster
   *  WITH crew's standing (`api/roster-standing.ts`, F-RECON-002/003) so a signed-out seat reaches
   *  the engine benched (`health {usable: false, reason}`) instead of being convened or elected. */
  roster?: () => unknown[];
  /** Does the daemon's PUBLISHED skills snapshot hold (and enable) a skill? Consulted ONCE at arm time
   *  for `wicked-garden-draft` (interactive/draft-skill.ts), only for the arm log line: the preset
   *  always runs the skill, and a snapshot without it fails the run before the document work starts (crew#935).
   *  Default: `() => false` (a caller without a skills runtime has no snapshot to hold anything). */
  skillHeld?: SkillHeld;
  /** Repo-snapshot size budget in bytes (CREW-UX-8 v4; default ~200MB — see
   *  {@link snapshotRepo}). A repo over budget degrades the launch to ungrounded, narrated.
   *  Tests shrink it to exercise the degradation path without a 200MB fixture. */
  repoSnapshotMaxBytes?: number;
  /** Called after a launch that FILED the run into a project (doc.created carried
   *  `project_id`). The server wires this to the same post-commit half the launch route
   *  performs: tag the run in the live membership index + emit `wicked.crew.membership.attached`
   *  (the engine already attached the crew.run membership atomically with the launch). */
  onRunFiled?: (runId: string, projectId: string) => void;
  /** Called after every successful `adapter.launchRun()` with the run id and provenance detail
   *  (channel, actor from the create-time grounding binding). The server wires this to
   *  `recordRunLaunched` so subscriber-launched runs appear in the audit trail and run DTOs. */
  onRunLaunched?: (runId: string, detail: Record<string, unknown>) => void;
  /** The create-time doc → subject-repo bindings the proxy recorded (F-046, `doc-grounding.ts` —
   *  a `crew-grounding.json` sidecar beside the doc's `versions.json`); the server wires the
   *  daemon's shared instance. Absent = nothing was ever named on a create request: grounding falls
   *  back to the brief / sole-member rules. */
  groundingStore?: DocGroundingStore;
  /** The docs root a doc's workspace lives under — where the grounding sidecar is READ (F-046).
   *  Default: the shared-default resolution (`WICKED_INTERACTIVE_ROOT` › `~/wicked-interactive/docs`);
   *  the server wires the per-project `interactiveRoot` setting through here, like the sibling seams.
   *  Only consulted when a `groundingStore` is wired. */
  resolveDocsRoot?: (projectId: string | undefined) => string;
  /** Injectable IO for the draft floor crew re-derives at finalize (crew#621/#504) — tests
   *  substitute the plugin root and the check's answer; the daemon passes nothing. */
  draftFloorIo?: DraftFloorIo;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
  /** Error-level logger for connection-fatal subscriber errors (the /diagnostics ring folds it); defaults to `log`. */
  logError?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface InteractiveDraftSubscription {
  stop(): Promise<void> | void;
  /** The durable ledger (diagnostics / tests). */
  ledger: InteractiveHandoffLedger;
  /** Documents with a draft run currently in flight — the chat seam's per-doc serialization
   *  (CREW-UX-5 contract (c)) consults this so an iteration ask never races a first draft. */
  inFlightDocs(): string[];
}

interface InFlight {
  documentId: string;
  /** The doc's project binding — stamped on every emit (F-045). Undefined = unfiled. */
  projectId?: string | undefined;
  outPath: string;
  /** The launch-scoped repo snapshots grounding this run (CREW-UX-8 v4; one per subject repo since
   *  F-046): each dest is tracked BEFORE its snapshot materializes (so a shutdown sweep can clear a
   *  half-made clone — Copilot round 2), dropped again when refused/degraded, and every one is
   *  removed on EVERY terminal path. */
  snapshotDirs: string[];
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  /** The governed run id (the in-flight map key), stamped on narration as `run_id` (F-4R2-005). */
  runId?: string | undefined;
  /** The ord of the latest unit-scoped engine frame, stamped on narration as `unit_ord`. */
  narrationOrd?: number | undefined;
  /** Undefined while the flight is a PRE-LAUNCH placeholder (registered before the snapshot
   *  await so `inFlightDocs()` reports the doc busy — Copilot round 2); set once the launch
   *  resolves. */
  heartbeat?: ReturnType<typeof setInterval> | undefined;
  /** What crew's re-derivation of the draft floor needs at finalize (crew#621/#504): the page
   *  budget the brief implied and the requested style, so the check runs with the same inputs the
   *  worker's clause named. */
  floor?: { budget: PageBudget; style: string } | undefined;
  /** The engine's own reason for the most recent failed unit (`stepFailed.detail`, a bounded
   *  excerpt of the worker/tool output). Carried so the terminal error status names WHY —
   *  crucially, the crew#311 deliverable-floor report, which says exactly which artifact was
   *  expected and what was found instead of "the run failed, inspect it via the API". */
  failureDetail?: string | undefined;
}

/** The seam's durable state (handoff ledger + working dirs) follows the daemon's state home —
 *  the `--db` parent when configured, `~/.wicked-crew` otherwise (crew#353): an isolated
 *  daemon's interactive handoffs must not land in the operator's real home. */
function defaultStateDir(): string {
  return crewStateHome();
}

/** The council roster a launch carries when no `clisJson` override is set. F-RECON-002/003: the
 *  server injects `roster` — the daemon's roster WITH standing (`api/roster-standing.ts`), so
 *  `launchRun`'s `engineRosterJson` benches signed-out seats instead of convening (or electing)
 *  them. Without an injected accessor the adapter's own `launchRoster()` is asked (the same
 *  standing when the daemon wired it); the raw registry, resolved lazily through the adapter's
 *  class so this module never imports the native addon at runtime, is the last resort (unit tests
 *  pass `clisJson` and a fake adapter). */
function rosterOf(adapter: CoreAdapter, roster?: () => unknown[]): unknown[] {
  if (roster !== undefined) return roster();
  const own = (adapter as unknown as { launchRoster?: () => unknown[] }).launchRoster;
  if (typeof own === 'function') return own.call(adapter);
  return (adapter.constructor as unknown as { roster(): unknown[] }).roster();
}

/**
 * Arm the seam (it registers nothing: the run is the engine's `interactive-draft` preset), open a durable
 * `wicked.interactive.doc.created` subscription, and answer each `kind: "source"` creation
 * with a governed run that ends in `wicked.interactive.draft.completed`.
 *
 * Graceful degradation mirrors `startQeGateSubscriber`: a missing wicked-bus package or an
 * unopenable db LOGS and returns `null` — the daemon must still boot on a machine whose bus is
 * broken; interactive's assist loop remains the (always-available) fallback answerer.
 */
export async function startInteractiveDraftSubscriber(
  adapter: CoreAdapter,
  opts: InteractiveDraftOptions = {},
): Promise<InteractiveDraftSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));

  // This seam reads and writes the bus through the engine that holds it (wicked-core#631,
  // core/bus.ts). Checked here so a bus no engine holds disables the seam before anything is armed.
  let busDbPath: string;
  try {
    busDbPath = requireEngineBus(opts.dbPath);
  } catch (err) {
    log(
      `[interactive-draft] has no bus${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — governed drafting disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // The workflow is the engine's built-in `interactive-draft` preset (crew#935): nothing to
  // register. It always runs the draft skill, so the arm line says whether the published snapshot
  // holds it — without it the engine fails each run before the document work starts, naming the fix.
  log(draftSkillArmLine(INTERACTIVE_DRAFT_WORKFLOW, (opts.skillHeld ?? (() => false))(DRAFT_SKILL)));

  const ledger = new InteractiveHandoffLedger(
    opts.ledgerPath ?? join(defaultStateDir(), 'interactive-draft-ledger.json'),
  );
  const draftDir = opts.draftDir ?? join(defaultStateDir(), 'interactive-drafts');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const groundingStore = opts.groundingStore;
  const resolveDocsRoot = opts.resolveDocsRoot ?? (() => resolveInteractiveRoot(null));
  const inFlight = new Map<string, InFlight>(); // runId → live state (pre-launch placeholders included)
  // runId → the run's planned units (crew#935). Opened BEFORE the launch: the engine announces the
  // first plan (`unitPlanned`) while `launchRun` is still in flight, before the flight is recorded.
  const unitsByRun = new Map<string, RunUnits>();
  // Documents whose run is terminal but whose FINALIZE is still running — the draft floor's
  // re-derivation and the announce (codex on crew#725). The doc must stay BUSY across that window:
  // `inFlightDocs()` is what serializes the chat seam's asks (CREW-UX-5 contract (c)), and a floor
  // that takes seconds — up to its 120 s bound — would otherwise let an iteration ask launch
  // against the placeholder while the first draft was still being judged.
  // Keyed by the per-project handoff key (crew#809: two projects finalizing the same slug must not
  // clear each other's marker); the VALUE is the document id `inFlightDocs()` reports.
  const finalizing = new Map<string, string>();
  let closed = false; // set by stop(): a handler mid-snapshot must never launch after shutdown

  /** Emit onto interactive's vocabulary as the `wi-crew` producer. Never throws into the
   *  caller: narration/announce failures are logged — a lost status line must not kill the
   *  subscription, and a duplicate draft emit (its key already on the bus) is the idempotency key WORKING. */
  async function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<boolean> {
    try {
      await emitOnBus(busDbPath, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: type === DRAFT_COMPLETED ? 'generation' : 'status',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: INTERACTIVE_PRODUCER,
        ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      });
      return true;
    } catch (err) {
      log(
        `[interactive-draft] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Every `status.posted` this seam emits is typed as the published frame's payload (codex on
   *  crew#506: the wire type at the real boundary, not a detached alias) — `emitInteractive` adds `ts`. */
  function emitStatus(payload: SeamStatusPayload): Promise<boolean> {
    return emitInteractive(STATUS_POSTED, { ...payload });
  }

  function narrate(flight: InFlight, message: string): void {
    flight.narration = message;
    emitStatus({
      ...docScope(flight.documentId, flight.projectId),
      state: 'working',
      message,
      ...narrationStamps(flight),
    });
  }

  function endFlight(runId: string): InFlight | undefined {
    const flight = inFlight.get(runId);
    if (flight) {
      if (flight.heartbeat !== undefined) clearInterval(flight.heartbeat);
      inFlight.delete(runId);
    }
    unitsByRun.delete(runId);
    return flight;
  }

  /** CREW-UX-8 v4: the repo snapshots are launch-scoped — remove them on EVERY terminal path
   *  (success, no-file, emit-failure, run failure/cancel) so the inbox never accretes dead
   *  clones. Best-effort: a leftover snapshot is a disk-space wart, never a correctness one. */
  function removeSnapshots(flight: InFlight): void {
    const dirs = flight.snapshotDirs;
    flight.snapshotDirs = [];
    const parents = new Set<string>();
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
        log(`[interactive-draft] removed repo snapshot ${dir}`);
        parents.add(dirname(dir));
      } catch (err) {
        log(
          `[interactive-draft] could not remove repo snapshot ${dir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // The per-run `repos/` parent held nothing but this run's snapshots — it goes too, so the
    // inbox never accretes empty shells.
    for (const parent of parents) {
      if (basename(parent) !== 'repos') continue;
      try {
        rmSync(parent, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  /** Terminal-event fold: turn the governed run's own events into interactive narration, and
   *  close the loop with `draft.completed` when the run lands. */
  const foldEvent = (event: CoreEvent): void => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const planned = unitsByRun.get(runId);
    if (planned?.observe(event) === true) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;
    // F-4R2-005: every narration line and heartbeat from here carries the run id and the ord of the
    // latest unit-scoped frame (`narrationStamps`), so a skin keys the thread per run and per unit.
    flight.runId ??= runId;
    if (typeof event.ord === 'number') flight.narrationOrd = event.ord;

    // Narration ladder (#user-feedback 2026-08-14): the heartbeat repeats the LATEST line, and
    // the interactive transcript dedups consecutive repeats — so the more the line ADVANCES with
    // the run's real events, the more the thread reads as progress instead of a stuck echo.
    //
    // The steps are the engine's (crew#935): the preset's creator, the PA's `pa-scope` first and
    // the floor's additions, as the run's `unitPlanned` frames announce them. A deterministic tool
    // unit has no seat, so its council and routing frames are not narrated.
    const units = planned ?? new RunUnits();
    const ordOf = (e: CoreEvent): number => (typeof e.ord === 'number' ? e.ord : 0);

    if (event.type === 'councilConvened') {
      const ord = ordOf(event);
      if (units.isTool(ord)) return;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      // "0-seat council" reads like a bug — generic phrasing whenever clis is missing or empty
      // (Copilot, #269).
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(
        flight,
        units.isWriter(ord)
          ? `Convening ${council} to pick who plans and writes the draft…`
          : `Convening ${council} to pick who runs ${units.idAt(ord)}…`,
      );
      return;
    }

    if (event.type === 'unitDistributed') {
      const ord = ordOf(event);
      if (units.isTool(ord)) return;
      // One helper narrates the frame by `routingMethod` (S5 `teamed` = "Routed …", a recorded
      // council = "Council picked …" honest about its benched seats, F-4R2-007).
      narrate(flight, unitDistributedLine(event, `for ${units.idAt(ord)}`));
      return;
    }

    if (event.type === 'unitDispatched') {
      const ord = ordOf(event);
      const id = units.idAt(ord);
      narrate(
        flight,
        units.isWriter(ord)
          ? `Crew phase ${units.position(ord)}: planning and writing the draft (${id})…`
          : units.isEvaluator(ord)
            ? `Crew phase ${units.position(ord)}: reviewing the draft (${id})…`
            : `Crew phase ${units.position(ord)}: ${describeStep(id)}…`,
      );
      return;
    }

    // A preset run can pause for a person (the plan approval of a high-risk ask, crew#935): say so
    // and where to answer, rather than repeat the last working line. A plan edited at that gate can
    // drop or reorder pending units, so the fold is re-read from the run when it resumes.
    if (event.type === 'awaitingHuman') {
      narrate(flight, awaitingHumanLine(event, runId, units));
      return;
    }
    if (event.type === 'resumed') {
      if (planned !== undefined) resync.hold(runId, resyncRunUnits(adapter, runId, planned));
      return;
    }

    if (event.type === 'toolInvoked') {
      const tools = Array.isArray(event.tools) ? [...new Set(event.tools)].join(', ') : '';
      if (tools) narrate(flight, `Worker is using ${tools} on your document…`);
      return;
    }

    if (event.type === 'unitOutputCaptured') {
      narrate(flight, `${units.idAt(ordOf(event))} finished — the governance gate is reviewing it…`);
      return;
    }

    if (event.type === 'gateDecided' && event.allow === true) {
      const ord = ordOf(event);
      // The engine's deliverable floor judges the creator's unit before its gate decides, so an
      // approved writer means the draft file is on disk and was written by this run.
      narrate(
        flight,
        units.isWriter(ord)
          ? 'Gate approved the draft — the draft file is verified on disk…'
          : `Gate approved ${units.idAt(ord)} — moving on…`,
      );
      return;
    }

    // Wave 6 — the honest gate (F-7R2-005): a unit NOTHING gated must read as UNGATED in the thread,
    // never as approved; the engine says so on `gateEvaluated.ungated` and names the missing layers.
    if (event.type === 'gateEvaluated') {
      const note = ungatedGateNote(event);
      if (note !== null) {
        const ord = typeof event.ord === 'number' ? event.ord : 0;
        narrate(flight, `Gate for ${units.idAt(ord)}: ${note}`);
      }
      return;
    }

    // Wave 6 — the fenced worker (F-7R2-012): a seat that tried to push or open a PR itself was
    // refused; the thread names who, what, and that delivery belongs to the run's deliver phase.
    if (event.type === 'workerToolCallDenied') {
      narrate(flight, workerToolCallDeniedLine(event));
      return;
    }

    if (event.type === 'acpFallback') {
      narrate(flight, acpFallbackLine(event));
      return;
    }

    if (event.type === 'sessionCompleted') {
      endFlight(runId);
      // The doc stays busy until the floor and the announce are done (codex on crew#725).
      finalizing.set(draftHandoffKey(flight.documentId, flight.projectId), flight.documentId);
      // The announce awaits the bus writer; a throw is logged, as a synchronous one was.
      finalize(flight, runId)
        .catch((err: unknown) =>
          log(`[interactive-draft] finalizing run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(() => finalizing.delete(draftHandoffKey(flight.documentId, flight.projectId)));
      return;
    }

    if (event.type === 'stepFailed') {
      // Remember the engine's own reason (crew#311): the terminal status below reads far better
      // as "the draft file was never written" than as "inspect it via the API".
      const detail = typeof event.detail === 'string' ? event.detail.trim() : '';
      if (detail.length > 0) flight.failureDetail = detail;
      return;
    }

    if (event.type === 'sessionFailed' || event.type === 'runCancelled') {
      endFlight(runId);
      removeSnapshots(flight); // the failure path cleans its snapshots too (CREW-UX-8 v4)
      ledger.recordFailure(draftHandoffKey(flight.documentId, flight.projectId));
      const why =
        flight.failureDetail !== undefined ? ` Reason: ${oneLine(flight.failureDetail, 600)}` : '';
      emitStatus({
        ...docScope(flight.documentId, flight.projectId),
        state: 'error',
        message:
          `The crew run answering this document ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}).${why} Inspect it via the crew API (GET /api/v1/runs/${runId}); the assist loop can still take over.`,
      });
      log(`[interactive-draft] run ${runId} for doc ${flight.documentId} ended: ${event.type}`);
    }
  };
  const resync = new ResyncGate(foldEvent);
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => resync.deliver(event));

  async function finalize(flight: InFlight, runId: string): Promise<void> {
    const { documentId, projectId, outPath } = flight;
    let ok = false;
    try {
      ok = existsSync(outPath) && statSync(outPath).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      // The run is terminal — its grounding snapshots are done serving reads.
      removeSnapshots(flight);
      ledger.recordFailure(draftHandoffKey(documentId, projectId));
      emitStatus({
        ...docScope(documentId, projectId),
        state: 'error',
        message: `The crew run completed but produced no draft file at ${outPath} (run ${runId}).`,
      });
      log(`[interactive-draft] run ${runId} completed but ${outPath} is missing/empty`);
      return;
    }
    // THE DRAFT FLOOR (crew#621 / crew#504): the document's own verdict, re-derived by crew from
    // the artifact before it is published — the same `wicked-garden-draft` self-check the worker
    // was told to run, on the same inputs (hence BEFORE the snapshots go: the claims scan traces
    // every number and URL to them). A breach fails the draft naming the rule; a floor that could
    // not run is published with that said, never rounded to a pass. Every run is held to it: the
    // preset always runs the skill, and a snapshot without it fails the run (crew#935).
    const floorVerdict = await runDraftFloor(
      outPath,
      flight.floor?.budget ?? { pages: null, exact: false, source: 'unknown' },
      flight.snapshotDirs,
      { ...(flight.floor !== undefined ? { style: flight.floor.style } : {}) },
      opts.draftFloorIo ?? {},
    );
    removeSnapshots(flight);
    log(`[interactive-draft] run ${runId} draft floor: ${floorVerdict.verdict} — ${floorVerdict.summary}`);
    if (floorVerdict.verdict === 'fail') {
      ledger.recordFailure(draftHandoffKey(documentId, projectId));
      emitStatus({
        ...docScope(documentId, projectId),
        state: 'error',
        message:
          `The draft did not meet the document floor, so it was not landed on the canvas (run ${runId}). ` +
          `${floorVerdict.breaches.join(' ')} The file crew checked is at ${outPath}; ask again — ` +
          `the brief's hard constraints are part of the deliverable, not a preference.`,
      });
      return;
    }
    if (floorVerdict.verdict === 'unverified' || floorVerdict.verdict === 'unavailable') {
      // Disclosed, not silently passed: the reader is told which floor could not be re-derived.
      emitStatus({
        ...docScope(documentId, projectId),
        state: 'working',
        message: `Draft floor: ${floorVerdict.summary}.`,
      });
    }
    // ADR-0019 D5: announce by path — the service reads the file itself, so a large draft
    // never rides the bus payload. The deterministic key makes a re-announce a no-op (the key resolves to the existing row).
    const emitted = await emitInteractive(
      DRAFT_COMPLETED,
      { ...docScope(documentId, projectId), html_path: outPath },
      draftIdempotencyKey(documentId, projectId),
    );
    if (!emitted) {
      // The bus refused the announce: the draft exists on disk but never reached
      // the service. Fail HONEST — leaving the ledger row launched-but-never-closed would
      // silently eat every replay of this doc (the launch gate is `ledger.has`).
      ledger.recordFailure(draftHandoffKey(documentId, projectId));
      emitStatus({
        ...docScope(documentId, projectId),
        state: 'error',
        message:
          `Crew finished the draft but could not announce it on the bus (run ${runId}); ` +
          `the draft file is at ${outPath}. Inspect the crew daemon log.`,
      });
      log(`[interactive-draft] draft.completed emit FAILED for doc ${documentId} (run ${runId}) — recorded as failure`);
      return;
    }
    ledger.recordEmitted(draftHandoffKey(documentId, projectId));
    emitStatus({
      ...docScope(documentId, projectId),
      state: 'complete',
      message: 'First draft is in — landing it on the canvas now. Click any block to refine it.',
    });
    log(`[interactive-draft] draft.completed emitted for doc ${documentId} (run ${runId})`);
  }

  async function handleDocCreated(event: BusEvent): Promise<void> {
    const doc = parseSourceDocCreated(event.event_type, event.payload);
    if (doc === null) return;
    const where = doc.projectId !== undefined ? ` (project ${doc.projectId})` : ' (unfiled)';

    // crew#811: studio's theme-learning scratch pad is not a drafting request.
    if (isStudioScratchDoc(doc)) {
      log(
        `[interactive-draft] doc ${doc.documentId}${where} is wicked-studio's brand-learn scratch document — ` +
          `no draft run is launched for it (crew#811)`,
      );
      return;
    }

    // Replay-dedup: the ledger is the durable gate (redelivery after crash/restart), the
    // in-flight scan the live one (redelivery inside a single process lifetime). Keyed per
    // PROJECT (crew#809): the same slug in another project is another document.
    const key = draftHandoffKey(doc.documentId, doc.projectId);
    if (ledger.has(key)) {
      log(`[interactive-draft] doc ${doc.documentId}${where} already answered (run ${ledger.get(key)?.runId}) — replay ignored`);
      return;
    }
    for (const f of inFlight.values()) {
      if (f.documentId === doc.documentId && f.projectId === doc.projectId) return;
    }

    // Per-run ISOLATION (Copilot, crew#313): every launch gets its OWN subdirectory holding
    // both the deliverable and (when grounded) the repo snapshot, and declares ONLY that
    // subdirectory as its extra write root below. Declaring the shared draftDir wholesale let
    // any draft worker read/write every other run's deliverable AND every other project's
    // snapshot — cross-project exposure through the governance boundary itself.
    // NOT created here (Copilot round 2): runDir is only mkdir'd after the snapshot helper's
    // containment check has ruled the location safe — see the pre-launch mkdir below.
    const runDir = join(draftDir, doc.documentId);
    const outPath = join(runDir, `${doc.documentId}-v1.html`);
    const runId = randomUUID();

    // PRE-LAUNCH placeholder (Copilot round 2): the awaits below (repo resolution, snapshot)
    // open a window in which this doc has no `inFlight` entry — so the chat seam's `isDocBusy`
    // saw it idle (double-launch race) and stop()'s sweep could not find a half-made snapshot.
    // Register the flight FIRST; every exit path below (refusal, shutdown, launch failure)
    // must endFlight() it.
    const flight: InFlight = {
      documentId: doc.documentId,
      projectId: doc.projectId,
      outPath,
      snapshotDirs: [],
      narration: 'Crew run launched — working on your draft…',
      floor: { budget: pageBudgetFor(doc.brief, doc.style), style: doc.style },
    };
    inFlight.set(runId, flight);

    // F-046: WHICH repositories is this document about? The create request's `repo_ref(s)` (the
    // proxy recorded them, keyed by this doc — waited for, bounded, when the create is still
    // answering), else the ones the brief names, else the project's sole repo, else NONE. Never
    // the project's first member: that grounded a brochure about wicked-studio on wicked-core.
    // Unbound docs are never repo-grounded (the proxy refuses a repo on an Unfiled create).
    let decision: GroundingDecision | undefined;
    // The sidecar sits beside the doc; a refused partition (bridge-root.ts) throws here and the
    // frame goes unanswered — fail closed, like the sibling seams' docs-root reads. An UNFILED doc
    // reads its binding too (studio#302): the proxy records the create's seat choice and
    // provenance under the default mount, and only the repo grounding is project-only.
    const binding =
      groundingStore !== undefined
        ? await groundingStore.waitFor(
            resolveDocsRoot(doc.projectId),
            doc.documentId,
            doc.projectId ?? DEFAULT_PROJECT_ID,
            GROUNDING_BINDING_WAIT_MS,
          )
        : undefined;
    const docClisJson = binding?.clis_json;
    const docChannel = binding?.channel;
    const docActor = binding?.actor;
    if (doc.projectId !== undefined) {
      decision = await resolveGroundingRepos(adapter, doc.projectId, doc.brief, binding?.repo_refs, log);
    }

    emitStatus({
      ...docScope(doc.documentId, doc.projectId),
      state: 'processing',
      message: 'A governed crew picked up your brief — planning the draft…',
    });

    // The snapshots happen crew-side, AFTER the pickup narration (a big clone must not starve
    // the UI's silence budget) and BEFORE launchRun: <runDir>/repos/<name> sits inside the run's
    // OWN declared extra write root, so the unbound worker can read it (write roots are readable,
    // wicked-core#259) even though the live repo root is boundary-denied (wicked-core#294) —
    // and NO OTHER run can (per-run isolation, Copilot crew#313). An unsnapshotable repo (over
    // budget, unreadable, clone+copy failed) degrades HONESTLY: the subject is still NAMED in the
    // task, a visible per-cause note lands on the thread, and the full reason in the log.
    // The inbox must never sit inside ANY registered repository (codex on crew#506): it is the
    // worker's extra write root, so a draft dir configured inside a checkout hands the unbound
    // worker write access to live source whatever the run is about — the per-repo dest-overlap
    // check below covers only the repo being snapshotted. Refuse BEFORE anything is created.
    let inside: string | null;
    try {
      inside = await runDirInsideRepo(adapter, runDir);
    } catch (err) {
      // Unresolvable (EACCES/ELOOP — plain ENOENT is walked past) = unprovable = refused, WITH a
      // user-facing status naming the cause before the frame dead-letters (Copilot on crew#506).
      endFlight(runId);
      const why = err instanceof Error ? err.message : String(err);
      const message =
        `Crew refused to draft this document: the configured draft directory (${draftDir}) could not be verified ` +
        `against the registered repositories (${why}). Fix the path or its permissions, then replay the request.`;
      emitStatus({ ...docScope(doc.documentId, doc.projectId), state: 'error', message });
      log(`[interactive-draft] doc ${doc.documentId}: REFUSING launch — run dir ${runDir} unverifiable: ${why}`);
      throw new Error(message);
    }
    if (inside !== null) {
      endFlight(runId);
      const message =
        `Crew refused to draft this document: the configured draft directory (${draftDir}) overlaps the ` +
        `registered repository ${inside}, so launching would give the worker write access inside live source. ` +
        `Point the crew draft directory outside every registered repository, then replay the request.`;
      emitStatus({ ...docScope(doc.documentId, doc.projectId), state: 'error', message });
      log(`[interactive-draft] doc ${doc.documentId}: REFUSING launch — run dir ${runDir} is inside repo ${inside}`);
      throw new Error(message);
    }

    const snapshotted: GroundingRepo[] = [];
    const subjects: DraftGrounding['subjects'] = [];
    const taken = new Set<string>();
    for (const repo of decision?.repos ?? []) {
      const dest = join(runDir, 'repos', snapshotDirName(repo, taken));
      if (!groundablePath(dest)) {
        // The PATH itself cannot ride the grounding clause (too long for the PTY prompt
        // budget, or multi-line) — and a truncated spelling would name a nonexistent dir, so
        // the snapshot is SKIPPED before any clone happens (Copilot, crew#313).
        emitStatus({
          ...docScope(doc.documentId, doc.projectId),
          state: 'working',
          message: `snapshot path for ${repo.name} too long to hand to the worker — drafting without its snapshot`,
        });
        log(
          `[interactive-draft] doc ${doc.documentId}: snapshot dest ${dest} cannot ride the grounding clause — no snapshot for ${repo.repoRef}`,
        );
        subjects.push({ name: repo.name });
        continue;
      }
      // Track the dest BEFORE the await (Copilot round 2): stop() during the clone must be able
      // to sweep the half-made snapshot through the placeholder flight.
      flight.snapshotDirs.push(dest);
      const snap = await snapshotRepo(repo.rootPath, dest, { maxBytes: opts.repoSnapshotMaxBytes, log });
      if (snap.ok) {
        snapshotted.push(repo);
        subjects.push({ name: repo.name, snapshotDir: dest });
        continue;
      }
      flight.snapshotDirs = flight.snapshotDirs.filter((d) => d !== dest); // nothing landed — snapshotRepo cleans its partials
      if (snap.reason === 'dest-overlap') {
        // FAIL CLOSED (Copilot round 2): the configured draft dir places this run's write
        // root inside the live repository (or the repo is registered at the inbox). An
        // "ungrounded" launch would still hand the unbound worker read/write access to
        // live repo content through `extraWriteRoots: [runDir]` — so the launch is REFUSED
        // outright: no mkdir, no run, no ledger row. The status names the CONFIG problem;
        // the thrown error dead-letters the frame, replayable after the config is fixed.
        endFlight(runId);
        removeSnapshots(flight); // whatever sibling subjects already landed
        const message =
          `Crew refused to draft this document: the configured draft directory (${draftDir}) ` +
          `overlaps the project's repository (${repo.rootPath}), so launching would give the ` +
          `worker write access inside the live repo. Point the crew draft directory outside ` +
          `every registered repository, then replay the request.`;
        emitStatus({
          ...docScope(doc.documentId, doc.projectId),
          state: 'error',
          message,
        });
        log(
          `[interactive-draft] doc ${doc.documentId}: REFUSING launch — draft dir ${draftDir} overlaps repo ${repo.rootPath} (dest-overlap)`,
        );
        throw new Error(message);
      }
      // Per-cause operator message (Copilot, crew#313): "too large" was previously
      // claimed for EVERY failure — a deleted repo is not a large one. (`dest-overlap`
      // is handled above: it refuses the launch instead of degrading.)
      const because: Record<Exclude<SnapshotFailureReason, 'dest-overlap'>, string> = {
        'too-large': 'repository too large to snapshot',
        'root-unreadable': 'repository path is missing or unreadable',
        'dest-unclearable': 'a stale snapshot could not be cleared',
        'copy-failed': 'repository snapshot failed (clone and copy both errored)',
      };
      emitStatus({
        ...docScope(doc.documentId, doc.projectId),
        state: 'working',
        message: `${because[snap.reason]} (${repo.name}) — drafting without its snapshot`,
      });
      log(
        `[interactive-draft] doc ${doc.documentId}: repo ${repo.rootPath} could not be snapshotted (${snap.reason}) — no snapshot for ${repo.repoRef}`,
      );
      subjects.push({ name: repo.name });
    }
    // The thread hears WHERE this draft is grounded and WHY (F-046 follow-up) — or, for a
    // multi-repo project whose document named nothing, how to name one next time.
    // crew#512: the same facts as DATA — recorded beside the doc first (a skin that refetches the
    // docs list on this frame finds it there), then on the narration frame itself. The record is
    // written even when there is no line to say (a repo-less project): the list still answers.
    if (decision !== undefined && doc.projectId !== undefined) {
      const record = groundingRecord(decision, snapshotted);
      if (groundingStore !== undefined) {
        try {
          groundingStore.recordGrounding(resolveDocsRoot(doc.projectId), doc.documentId, doc.projectId, record);
        } catch (err) {
          log(
            `[interactive-draft] doc ${doc.documentId}: grounding record not written beside the doc (${err instanceof Error ? err.message : String(err)}) — the thread still hears it`,
          );
        }
      }
      const line = groundingNarration(decision, snapshotted, 'draft');
      if (line !== null) {
        emitStatus({ ...docScope(doc.documentId, doc.projectId), state: 'working', message: line, grounding: record });
      }
    }

    // Shutdown gate (Copilot round 2): stop() may have run during the awaits above — its sweep
    // already dropped the placeholder, but a clone can re-materialize files after that rm, and
    // a launch must never start once the subscriber detached from the engine's events.
    if (closed) {
      endFlight(runId);
      removeSnapshots(flight);
      log(`[interactive-draft] doc ${doc.documentId}: subscriber stopped before launch — abandoned (a replay retries)`);
      return;
    }

    // Containment is settled (any repo overlap refused above) — the run's write root may exist.
    mkdirSync(runDir, { recursive: true });

    // Resolve the project's graph BEFORE the launch, never indexing (a refresh is
    // `wicked-estate index` per member, bounded at 600s EACH — doing that inside a launch turns
    // "start a draft" into an unannounced multi-repo job). Missing or stale degrades to no
    // binding and the run proceeds exactly as before; the graph is a bonus, never a gate.
    //
    // The decision is RECORDED on both outcomes, like the API launch path (`api/routes.ts`).
    // "this draft sees the project" and "this draft sees nothing, because X" are equally facts
    // about what the run could observe, and the second is the one someone needs when a worker
    // reports that a sibling repo does not exist. An unexpected failure degrades the same way,
    // but says so — a silent `catch(() => null)` would make a broken binding indistinguishable
    // from a project that simply has no graph yet.
    let projectGraphBinding: ProjectGraphBinding | null = null;
    if (doc.projectId !== undefined) {
      const decision = await resolveProjectGraphBinding(adapter, doc.projectId, undefined).catch(
        (err: unknown) => ({
          binding: null,
          reason:
            `the project graph binding could not be resolved ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `This repo-less run gets no code graph.`,
        }),
      );
      projectGraphBinding = decision.binding;
      log(`run ${runId}: ${decision.reason}`);
    }
    try {
      unitsByRun.set(runId, new RunUnits()); // before the launch: its first plan is announced during it
      await adapter.launchRun({
        // DES-MEM-FACETED-001 Phase 3: thread the doc's project as the recall intent's `project`
        // axis (the reliably-available axis on this seam). An unfiled doc leaves it undefined, so
        // the clause is omitted. Phase 6: thread cli/repo (no single cli is in scope here — the
        // launch carries the whole council roster via `clisJson`, not one assigned seat).
        problem:
          draftProblem(
            doc,
            outPath,
            undefined,
            doc.projectId !== undefined ? { project: doc.projectId } : undefined,
            decision !== undefined
              ? {
                  subjects,
                  ...(decision.source === 'none' ? { unnamedAmong: decision.memberCount } : {}),
                }
              : undefined,
          ) +
          // The quality floor's inputs (draft-skill.ts): the preset's steps always run the skill.
          ' ' +
          draftQualityClause(
            outPath,
            pageBudgetFor(doc.brief, doc.style),
            subjects.flatMap((s) => (s.snapshotDir !== undefined ? [s.snapshotDir] : [])),
            { style: doc.style },
          ),
        sessionId: runId,
        clisJson: docClisJson ?? opts.clisJson ?? JSON.stringify(rosterOf(adapter, opts.roster)),
        workflow: INTERACTIVE_DRAFT_WORKFLOW,
        // A project-bound doc's governed draft is FILED (P7 gate DEFECT-1): the engine attaches
        // the crew.run membership atomically with the launch, so the run shows up in the
        // project's activity feed instead of floating unattributed. An UNFILED doc (DES-UX-001
        // slice U — created through the default mount with no project field) launches with the
        // key OMITTED: an unfiled governed run (project_id: null on the DTO, CREW-UX-2) — never
        // a fabricated 'default' membership.
        ...(doc.projectId !== undefined ? { projectId: doc.projectId } : {}),
        // A project-filed run sees the PROJECT's graph, like any other (verification
        // found this seam launching filed but unbound). These launches are repo-LESS,
        // which is exactly the case that gets a graph where it previously got none.
        ...(projectGraphBinding !== null ? { projectGraph: projectGraphBinding } : {}),
        // CREW-UX-8: deliberately NO `repoRef`, even when the project has one — a repoRef-bound
        // run's tool-permission stream closes on the first prompt-needing call, so no write
        // destination works (wicked-core#293) — and NO live-repo path in the task either: the
        // unbound boundary denies those reads (wicked-core#294). The grounding clause in
        // `problem` names the in-inbox snapshot instead; this ONE launch shape serves all docs.
        // The task text names `outPath` (inside runDir) as the deliverable, which sits OUTSIDE
        // the unit's sandbox — on the wrapped-CLI path the boundary denied that exact write and
        // failed the run AFTER the draft was produced (crew#263, run eed69dfa). Declare the
        // run's OWN subdirectory — never the shared draftDir (Copilot, crew#313: the wholesale
        // declaration let one project's worker read another's snapshot and deliverables) — so
        // the engine widens the boundary by exactly this run's inbox (validated launch-side,
        // wicked-core#259).
        extraWriteRoots: [runDir],
        // THE DELIVERABLE FLOOR (crew#311): the draft file IS the deliverable, so the run is
        // not done until it exists. Without this the engine's substance floor is the only
        // check on this unbound run, and it passes a worker whose Write was denied as long as
        // ~200 characters of narration came first — the exact reproducer shape. The floor
        // phase FAILS the run naming this path; `finalize` below stays as the belt-and-braces
        // check for a run that never reaches the floor at all.
        requireDeliverables: [outPath],
      });
    } catch (err) {
      unitsByRun.delete(runId);
      // A launch that never happened keeps no flight and no snapshot (a replayed frame
      // re-registers and re-snapshots fresh).
      endFlight(runId);
      removeSnapshots(flight);
      // The 'processing' status is already on the thread — close it out honestly so the
      // canvas never sits in an in-between state on a launch that went nowhere.
      const reason = err instanceof Error ? err.message : String(err);
      emitStatus({
        ...docScope(doc.documentId, doc.projectId),
        state: 'error',
        message: `Crew could not start a run for this document: ${reason}. The assist loop can still take over.`,
      });
      // DELIBERATELY no ledger write: only an answered doc earns a row, so an operator can
      // replay the dead-lettered doc.created after fixing the daemon and get a real retry.
      // Re-throw so the bus (maxRetries 0) dead-letters the frame — visible, replayable,
      // and incapable of hot-looping.
      throw err;
    }
    // Record AFTER the launch resolved: a failed launch leaves no ledger row, so a replayed
    // delivery retries. The crash window between launch and this write is the reason the
    // draft emit ALSO carries a deterministic idempotency key.
    ledger.recordLaunch(key, runId);
    if (closed) {
      // stop() ran while the engine was accepting the launch: its sweep already dropped the
      // placeholder and the snapshot, and the engine's workers die with the daemon — the
      // ledger row above is what keeps a post-restart redelivery from double-launching.
      return;
    }
    if (doc.projectId !== undefined) opts.onRunFiled?.(runId, doc.projectId);
    opts.onRunLaunched?.(runId, {
      deliver: 'none', // crew#762: a document draft publishes a document, it never delivers a PR
      ...(docChannel !== undefined ? { channel: docChannel } : {}),
      ...(docActor !== undefined ? { actor: docActor } : {}),
    });

    // Upgrade the placeholder to a live flight: the heartbeat starts once the run exists.
    flight.heartbeat = setInterval(() => {
      // Repeat the last real narration so the ~20s status.requested window is always fed,
      // even mid-phase when the engine is quiet.
      emitStatus({
        ...docScope(flight.documentId, flight.projectId),
        state: 'working',
        message: flight.narration,
        ...narrationStamps(flight),
      });
    }, heartbeatMs);
    // Do not keep the daemon alive for narration alone.
    flight.heartbeat.unref?.();
    log(`[interactive-draft] doc ${doc.documentId} → governed run ${runId} (draft → ${outPath})`);
  }

  const sub = await tapBus({
    dbPath: busDbPath,
    filter: INTERACTIVE_BUS_FILTER,
    // Live triggers only: replaying a bus backlog would answer docs whose drafts the assist
    // loop long since produced. History reconciliation belongs to the state plane, not here.
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    // Our own ledger + idempotency key are the dedupe; a bus-level retry of a failed launch
    // would double-launch precisely because the ledger row is only written on success.
    handler: (event: BusEvent) => handleDocCreated(event),
    onError: busSubscriberErrorReporter({
      describe: (err, event) =>
        `[interactive-draft] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      log,
      logError: opts.logError,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
    }),
  });

  return {
    ledger,
    inFlightDocs: () => [
      ...new Set([...[...inFlight.values()].map((f) => f.documentId), ...finalizing.values()]),
    ],
    stop: async () => {
      closed = true; // a handler mid-snapshot sees this and never launches (Copilot round 2)
      offCoreEvents();
      for (const runId of [...inFlight.keys()]) {
        const flight = endFlight(runId);
        // Best-effort snapshot sweep (Copilot, crew#313): a graceful shutdown with a run in
        // flight would otherwise strand the clone forever — after restart the ledger's launch
        // row suppresses redelivery, so no later fold ever revisits it. Pre-launch
        // placeholders are in the map too (Copilot round 2), so a snapshot still
        // materializing is swept as well — and the handler's own closed-gate re-sweeps
        // whatever the in-flight clone re-materializes after this rm. The engine's workers
        // die with the daemon, so nothing is still reading the snapshot.
        if (flight !== undefined) removeSnapshots(flight);
      }
      finalizing.clear(); // nothing is finalizing after the subscriber detaches
      await sub.stop();
    },
  };
}
