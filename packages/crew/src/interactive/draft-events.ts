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
 * Shape mirrors `qe/gate-events.ts` (crew's existing bus seam, Phase 6a): OPT-IN, dynamic
 * wicked-bus import, graceful degradation when the bus is absent, durable cursor with
 * `cursor_init: 'latest'` under a dedicated plugin name.
 *
 * Behavioral invariants honored (recon-verified against interactive):
 *  - Heartbeat: the canvas shows a working veil and the browser fires ~20s
 *    `status.requested` heartbeats; a silent answerer reads as a frozen UI. We narrate
 *    `wicked.interactive.status.posted` on every phase transition AND on a ≤15s timer.
 *  - Idempotency: the durable cursor redelivers under at-least-once semantics, and a replayed
 *    `doc.created` must not produce a duplicate `_v2.html`. A durable per-doc ledger
 *    (JSON file, atomic rename) gates the launch, and the final `draft.completed` emit carries
 *    a deterministic idempotency key (`crew:interactive.draft:<doc>:v1`) so even a double
 *    emit dedupes at the bus (WB-002).
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

import { resolveProjectGraphBinding } from '../projects/graph.js';
import { mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
import { InteractiveHandoffLedger } from './ledger.js';
import { snapshotRepo, type SnapshotFailureReason } from './repo-snapshot.js';
import type { CoreAdapter } from '../core/adapter.js';
import { DELIVERABLE_FLOOR_PHASE_ID } from '../core/deliverable-floor.js';
import type { CoreEvent, WorkflowDef } from '../core/types.js';

// ── Vocabulary constants (interactive's, verbatim — src/service/events.js is the truth) ──────

export const INTERACTIVE_DOMAIN = 'wicked-interactive';
export const DOC_CREATED = 'wicked.interactive.doc.created';
export const DRAFT_COMPLETED = 'wicked.interactive.draft.completed';
export const STATUS_POSTED = 'wicked.interactive.status.posted';

/** Exact-type filter with a domain guard — no wildcard, one event type is the whole trigger. */
export const INTERACTIVE_BUS_FILTER = `${DOC_CREATED}@${INTERACTIVE_DOMAIN}`;

/** Dedicated durable-cursor identity — NOT the qe subscriber's `wicked-crew`, so the two
 *  seams advance independent cursors and stopping one never strands the other. */
export const INTERACTIVE_BUS_PLUGIN = 'wicked-crew-interactive-draft';

/** The producer identity stamped on every event crew's interactive seams emit (this module and
 *  edit-events.ts). Must appear in interactive's events.js ownership table for DRAFT_COMPLETED,
 *  EDIT_COMPLETED, and STATUS_POSTED — the additive vocabulary rows that are the only
 *  interactive changes Phase 7c is allowed. */
export const INTERACTIVE_PRODUCER = 'wi-crew';

/** Interactive's doc-name grammar (server.js DOC_NAME) — re-checked before any launch so a
 *  malformed document_id can't name a ledger key or a draft file path. Shared with the
 *  structural-edit seam (edit-events.ts), which guards the same identity. */
export const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── The workflow (workflows-as-data) ─────────────────────────────────────────────────────────

export const INTERACTIVE_DRAFT_WORKFLOW = 'interactive-draft';

/**
 * The governed workflow that produces a first draft. Two agent phases — outline (recon) then
 * draft (build, creator role) — so the run narrates a real phase transition and the drafting
 * worker builds on a planned structure instead of one-shotting the whole document.
 *
 * The phase `instructions` adapt the draft-production contract from interactive's assist skill
 * (Step 5): honor the brief/sources/style, ground content in what the brief supports, produce a
 * complete self-contained HTML document, and NEVER mint `data-wid` attributes (the service
 * instruments fresh anchors itself). They are SINGLE-LINE by contract: the engine folds
 * instructions onto the unit description with a single-line separator, and the PTY seat runner
 * refuses any prompt carrying an embedded newline (wicked-core FINDING-011).
 *
 * All gates are `auto` with `validator_pin: null` — no human gate, no deterministic floor —
 * because the acceptance gate for a draft is the INTERACTIVE side (the service's INV-2
 * instrument+theme pipeline and the user's own eyes on the canvas). Registered via
 * `adapter.registerWorkflow()` at arm time (validate-before-persist, hot-registered into the
 * engine), not added to BUILTIN_WORKFLOWS: this def is crew-only data owned by this seam, not a
 * mirror of a wicked-core drop-in.
 */
export const INTERACTIVE_DRAFT_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_DRAFT_WORKFLOW,
  is_system: true,
  phases: [
    {
      id: 'outline',
      kind: 'recon',
      instructions:
        'Plan the document, do not write it yet: read the brief (and any source files/folders named in the task, expanding ~), then produce a concise outline — the sections in order, the key points each section carries, and the tone/format guidance the draft phase must honor for the requested style (web = rich scrollable page; ppt = fixed landscape slides; brochure = landscape print pages; doc = minimal content-first prose). Never invent facts, numbers, or claims the brief and sources do not support; where material is thin, plan honest placeholder copy that says what belongs there. Output the outline as plain text. Do NOT write HTML and do NOT create any files in this phase.',
      gate_type: 'value',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: [],
      role: 'neutral',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
    {
      id: 'draft',
      kind: 'build',
      instructions:
        'Using the outline from the prior phase, write the COMPLETE first-draft HTML document and SAVE it to the absolute output file named in the task (create parent directories if needed, overwrite if present) — the file on disk is the deliverable, so write it before you finish and end your reply with the absolute path you wrote. Contract: a full self-contained HTML document (inline CSS, no external network resources, no build step); honor the requested style/format and the brief; keep every fact grounded in the brief/sources — never fabricate figures; do NOT add data-wid attributes anywhere (the wicked-interactive service instruments its own anchors); keep the markup semantic and well-formed (balanced tags) so the instrumentation pass lands cleanly.',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: ['outline'],
      role: 'creator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
};

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

/**
 * The run's problem statement (the engine scopes it per phase and folds each phase's
 * instructions on top). Carries everything doc-specific: identity, brief, sources, style, and
 * the absolute path the finished HTML must land at. When the doc's project is repo-bound
 * (CREW-UX-8 v4), a SHORT grounding clause names the launch-scoped repo SNAPSHOT inside the
 * inbox for the worker to READ — the run itself launches unbound (wicked-core#293) and cannot
 * read the live repo (wicked-core#294), so the snapshot named by this clause is the whole
 * grounding mechanism, not a nudge on top of an engine binding.
 *
 * `snapshotDir` is embedded VERBATIM — never flattened, never truncated (the snapshot exists
 * at exactly this path; Copilot, crew#313). The caller guards it with {@link groundablePath}
 * BEFORE snapshotting and skips grounding (honest degrade) when the path cannot ride.
 */
export function draftProblem(doc: SourceDocCreated, outPath: string, snapshotDir?: string): string {
  const sources =
    doc.sourcePaths.length > 0
      ? `Source materials to read: ${doc.sourcePaths.join(', ')}.`
      : 'There are no source files — the brief alone is the spec.';
  const brief = doc.brief.length > 0 ? oneLine(doc.brief, 2000) : '(no brief provided)';
  const grounding =
    snapshotDir !== undefined
      ? `Ground the document in the repository snapshot at ${snapshotDir} — read it and use its real content, never placeholders. `
      : '';
  return (
    `Produce the first draft of the wicked-interactive document "${doc.documentId}" ` +
    `(requested style: ${doc.style}). The user's brief: ${brief} ${sources} ${grounding}` +
    `The finished draft MUST be written to exactly this absolute file path: ${outPath}`
  );
}

/** Deterministic bus idempotency key for the one draft this seam may land per document. */
export function draftIdempotencyKey(documentId: string): string {
  return `crew:interactive.draft:${documentId}:v1`;
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
  /** Bus SQLite db path. Omit to let wicked-bus resolve its own default
   *  (honors `WICKED_BUS_DATA_DIR`) — which is where interactive's service emits unless
   *  redirected, so the default is usually right. */
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
  /** Repo-snapshot size budget in bytes (CREW-UX-8 v4; default ~200MB — see
   *  {@link snapshotRepo}). A repo over budget degrades the launch to ungrounded, narrated.
   *  Tests shrink it to exercise the degradation path without a 200MB fixture. */
  repoSnapshotMaxBytes?: number;
  /** Called after a launch that FILED the run into a project (doc.created carried
   *  `project_id`). The server wires this to the same post-commit half the launch route
   *  performs: tag the run in the live membership index + emit `wicked.crew.membership.attached`
   *  (the engine already attached the crew.run membership atomically with the launch). */
  onRunFiled?: (runId: string, projectId: string) => void;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
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
  outPath: string;
  /** The launch-scoped repo snapshot grounding this run (CREW-UX-8 v4): set BEFORE the snapshot
   *  materializes (so a shutdown sweep can clear a half-made clone — Copilot round 2), cleared
   *  when the snapshot is refused/degraded, removed on EVERY terminal path. */
  snapshotDir?: string | undefined;
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  /** Undefined while the flight is a PRE-LAUNCH placeholder (registered before the snapshot
   *  await so `inFlightDocs()` reports the doc busy — Copilot round 2); set once the launch
   *  resolves. */
  heartbeat?: ReturnType<typeof setInterval> | undefined;
  /** The engine's own reason for the most recent failed unit (`stepFailed.detail`, a bounded
   *  excerpt of the worker/tool output). Carried so the terminal error status names WHY —
   *  crucially, the crew#311 deliverable-floor report, which says exactly which artifact was
   *  expected and what was found instead of "the run failed, inspect it via the API". */
  failureDetail?: string | undefined;
}

function defaultStateDir(): string {
  return join(homedir(), '.wicked-crew');
}

/** The production council roster, resolved lazily through the adapter's own class so this module
 *  never imports the native addon at runtime (unit tests pass `clisJson` and a fake adapter). */
function rosterOf(adapter: CoreAdapter): unknown[] {
  return (adapter.constructor as unknown as { roster(): unknown[] }).roster();
}

/**
 * Arm the seam: register the `interactive-draft` workflow, open a durable
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

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[interactive-draft] wicked-bus is not importable — governed drafting disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let db: import('wicked-bus').BusDb;
  let config: Record<string, unknown>;
  try {
    config = bus.loadConfig(opts.dbPath !== undefined ? { db_path: opts.dbPath } : {});
    db = bus.openDb(opts.dbPath !== undefined ? { db_path: opts.dbPath } : {});
  } catch (err) {
    log(
      `[interactive-draft] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — governed drafting disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // The workflow rides the normal registration path — core validates the def BEFORE it is
  // persisted/hot-registered (FINDING-002 ordering), so a drifted def fails the arm loudly
  // instead of failing the first launch obscurely.
  try {
    await adapter.registerWorkflow(INTERACTIVE_DRAFT_WORKFLOW_DEF);
  } catch (err) {
    log(
      `[interactive-draft] could not register the '${INTERACTIVE_DRAFT_WORKFLOW}' workflow — ` +
        `governed drafting disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const ledger = new InteractiveHandoffLedger(
    opts.ledgerPath ?? join(defaultStateDir(), 'interactive-draft-ledger.json'),
  );
  const draftDir = opts.draftDir ?? join(defaultStateDir(), 'interactive-drafts');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  // The run executes ONE MORE unit than the def declares: the crew#311 deliverable floor,
  // appended per-run by `launchRun` from `requireDeliverables`. `agentPhaseCount` is what the
  // council-and-worker narration branches key on (unchanged); `phaseCount` is the run's real
  // length, so the thread never reports "phase 3/2" or calls the verification "the draft".
  const agentPhaseCount = INTERACTIVE_DRAFT_WORKFLOW_DEF.phases.length;
  const phaseCount = agentPhaseCount + 1;
  const inFlight = new Map<string, InFlight>(); // runId → live state (pre-launch placeholders included)
  let closed = false; // set by stop(): a handler mid-snapshot must never launch after shutdown

  /** Emit onto interactive's vocabulary as the `wi-crew` producer. Never throws into the
   *  caller: narration/announce failures are logged — a lost status line must not kill the
   *  subscription, and a duplicate draft emit (WB-002) is the idempotency key WORKING. */
  function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): boolean {
    try {
      bus.emit(db, config, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: type === DRAFT_COMPLETED ? 'generation' : 'status',
        payload: { ts: new Date().toISOString(), ...payload },
        producer_id: INTERACTIVE_PRODUCER,
        ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      });
      return true;
    } catch (err) {
      const code = (err as { error?: string }).error;
      if (code === 'WB-002') {
        // Duplicate idempotency key — the emit already happened (redelivery race). Success.
        return true;
      }
      log(
        `[interactive-draft] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  function narrate(flight: InFlight, message: string): void {
    flight.narration = message;
    emitInteractive(STATUS_POSTED, {
      document_id: flight.documentId,
      state: 'working',
      message,
    });
  }

  function endFlight(runId: string): InFlight | undefined {
    const flight = inFlight.get(runId);
    if (flight) {
      if (flight.heartbeat !== undefined) clearInterval(flight.heartbeat);
      inFlight.delete(runId);
    }
    return flight;
  }

  /** CREW-UX-8 v4: the repo snapshot is launch-scoped — remove it on EVERY terminal path
   *  (success, no-file, emit-failure, run failure/cancel) so the inbox never accretes dead
   *  clones. Best-effort: a leftover snapshot is a disk-space wart, never a correctness one. */
  function removeSnapshot(flight: InFlight): void {
    const dir = flight.snapshotDir;
    if (dir === undefined) return;
    flight.snapshotDir = undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
      log(`[interactive-draft] removed repo snapshot ${dir}`);
    } catch (err) {
      log(
        `[interactive-draft] could not remove repo snapshot ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Terminal-event fold: turn the governed run's own events into interactive narration, and
   *  close the loop with `draft.completed` when the run lands. */
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;

    // Narration ladder (#user-feedback 2026-08-14): the heartbeat repeats the LATEST line, and
    // the interactive transcript dedups consecutive repeats — so the more the line ADVANCES with
    // the run's real events, the more the thread reads as progress instead of a stuck echo.
    const phaseName = (ord: number): string =>
      ord > agentPhaseCount
        ? DELIVERABLE_FLOOR_PHASE_ID
        : (INTERACTIVE_DRAFT_WORKFLOW_DEF.phases[ord - 1]?.id ?? `phase ${ord}`);

    // The crew#311 deliverable floor is a DETERMINISTIC tool phase — no seat, no council. Core
    // still emits the seat-selection events for it (its `cli` is the node interpreter's absolute
    // path), so narrating them verbatim put "Council picked /opt/homebrew/.../node for
    // verify-deliverables…" in the reader's thread. Drop those two lines for the floor ord; the
    // `unitDispatched` line that follows immediately says what the phase actually is.
    const isFloorOrd = (e: CoreEvent): boolean =>
      typeof (e as { ord?: unknown }).ord === 'number' && (e as { ord: number }).ord > agentPhaseCount;

    if (event.type === 'councilConvened') {
      if (isFloorOrd(event)) return;
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      // "0-seat council" reads like a bug — generic phrasing whenever clis is missing or empty
      // (Copilot, #269).
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(
        flight,
        `Convening ${council} to pick who ${ord >= agentPhaseCount ? 'writes the draft' : 'plans the outline'}…`,
      );
      return;
    }

    if (event.type === 'unitDistributed') {
      if (isFloorOrd(event)) return;
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const who = typeof event.cli === 'string' ? event.cli : 'a worker';
      const pct = typeof event.agreement_pct === 'number' ? ` (${event.agreement_pct}% agreement)` : '';
      narrate(flight, `Council picked ${who} for ${phaseName(ord)}${pct}…`);
      return;
    }

    if (event.type === 'unitDispatched') {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const phase = phaseName(ord);
      narrate(
        flight,
        ord > agentPhaseCount
          ? `Crew phase ${ord}/${phaseCount}: checking the draft file was actually written (${phase})…`
          : ord >= agentPhaseCount
            ? `Crew phase ${ord}/${phaseCount}: writing the draft (${phase})…`
            : `Crew phase ${ord}/${phaseCount}: ${phase} — planning the document…`,
      );
      return;
    }

    if (event.type === 'toolInvoked') {
      const tools = Array.isArray(event.tools) ? [...new Set(event.tools)].join(', ') : '';
      if (tools) narrate(flight, `Worker is using ${tools} on your document…`);
      return;
    }

    if (event.type === 'unitOutputCaptured') {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      narrate(flight, `${phaseName(ord)} finished — the governance gate is reviewing it…`);
      return;
    }

    if (event.type === 'gateDecided' && event.allow === true) {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      narrate(
        flight,
        ord > agentPhaseCount
          ? 'Draft file verified on disk — landing it now…'
          : ord >= agentPhaseCount
            ? 'Gate approved the draft — checking the file landed…'
            : `Gate approved ${phaseName(ord)} — moving on…`,
      );
      return;
    }

    if (event.type === 'acpFallback') {
      const who = typeof event.cliKey === 'string' ? event.cliKey : 'the worker';
      narrate(flight, `${who}'s live session dropped — continuing in single-shot mode…`);
      return;
    }

    if (event.type === 'sessionCompleted') {
      endFlight(runId);
      finalize(flight, runId);
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
      removeSnapshot(flight); // the failure path cleans its snapshot too (CREW-UX-8 v4)
      ledger.recordFailure(flight.documentId);
      const why =
        flight.failureDetail !== undefined ? ` Reason: ${oneLine(flight.failureDetail, 600)}` : '';
      emitInteractive(STATUS_POSTED, {
        document_id: flight.documentId,
        state: 'error',
        message:
          `The crew run answering this document ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}).${why} Inspect it via the crew API (GET /api/v1/runs/${runId}); the assist loop can still take over.`,
      });
      log(`[interactive-draft] run ${runId} for doc ${flight.documentId} ended: ${event.type}`);
    }
  });

  function finalize(flight: InFlight, runId: string): void {
    // The run is terminal — its grounding snapshot is done serving reads, on every branch below.
    removeSnapshot(flight);
    const { documentId, outPath } = flight;
    let ok = false;
    try {
      ok = existsSync(outPath) && statSync(outPath).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      ledger.recordFailure(documentId);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'error',
        message: `The crew run completed but produced no draft file at ${outPath} (run ${runId}).`,
      });
      log(`[interactive-draft] run ${runId} completed but ${outPath} is missing/empty`);
      return;
    }
    // ADR-0019 D5: announce by path — the service reads the file itself, so a large draft
    // never rides the bus payload. The deterministic key makes a re-announce a WB-002 no-op.
    const emitted = emitInteractive(
      DRAFT_COMPLETED,
      { document_id: documentId, html_path: outPath },
      draftIdempotencyKey(documentId),
    );
    if (!emitted) {
      // The bus refused the announce (non-WB-002): the draft exists on disk but never reached
      // the service. Fail HONEST — leaving the ledger row launched-but-never-closed would
      // silently eat every replay of this doc (the launch gate is `ledger.has`).
      ledger.recordFailure(documentId);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'error',
        message:
          `Crew finished the draft but could not announce it on the bus (run ${runId}); ` +
          `the draft file is at ${outPath}. Inspect the crew daemon log.`,
      });
      log(`[interactive-draft] draft.completed emit FAILED for doc ${documentId} (run ${runId}) — recorded as failure`);
      return;
    }
    ledger.recordEmitted(documentId);
    emitInteractive(STATUS_POSTED, {
      document_id: documentId,
      state: 'complete',
      message: 'First draft is in — landing it on the canvas now. Click any block to refine it.',
    });
    log(`[interactive-draft] draft.completed emitted for doc ${documentId} (run ${runId})`);
  }

  async function handleDocCreated(event: BusEvent): Promise<void> {
    const doc = parseSourceDocCreated(event.event_type, event.payload);
    if (doc === null) return;

    // Replay-dedup: the ledger is the durable gate (redelivery after crash/restart), the
    // in-flight scan the live one (redelivery inside a single process lifetime).
    if (ledger.has(doc.documentId)) {
      log(
        `[interactive-draft] doc ${doc.documentId} already answered (run ${ledger.get(doc.documentId)?.runId}) — replay ignored`,
      );
      return;
    }
    for (const f of inFlight.values()) {
      if (f.documentId === doc.documentId) return;
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
      outPath,
      narration: 'Crew run launched — working on your draft…',
    };
    inFlight.set(runId, flight);

    // CREW-UX-8 v4: a repo-bound project's doc is grounded in a REPO SNAPSHOT — resolve the
    // binding BEFORE the launch. Unbound docs and repo-less projects resolve to `undefined`
    // and launch exactly as before.
    const repo =
      doc.projectId !== undefined ? await resolveProjectRepo(adapter, doc.projectId, log) : undefined;

    emitInteractive(STATUS_POSTED, {
      document_id: doc.documentId,
      state: 'processing',
      message: 'A governed crew picked up your brief — planning the draft…',
    });

    // The snapshot happens crew-side, AFTER the pickup narration (a big clone must not starve
    // the UI's silence budget) and BEFORE launchRun: <runDir>/repo sits inside the run's OWN
    // declared extra write root, so the unbound worker can read it (write roots are readable,
    // wicked-core#259) even though the live repo root is boundary-denied (wicked-core#294) —
    // and NO OTHER run can (per-run isolation, Copilot crew#313). An unsnapshotable repo (over
    // budget, unreadable, clone+copy failed) degrades HONESTLY: ungrounded launch, a visible
    // per-cause note on the thread, and the full reason in the log.
    let snapshotDir: string | undefined;
    let snapshotDest: string | undefined; // where a snapshot was ATTEMPTED (shutdown cleanup)
    if (repo !== undefined) {
      const dest = join(runDir, 'repo');
      if (!groundablePath(dest)) {
        // The PATH itself cannot ride the grounding clause (too long for the PTY prompt
        // budget, or multi-line) — and a truncated spelling would name a nonexistent dir, so
        // grounding is SKIPPED before any clone happens (Copilot, crew#313).
        emitInteractive(STATUS_POSTED, {
          document_id: doc.documentId,
          state: 'working',
          message: 'snapshot path too long to hand to the worker — drafting without repo grounding',
        });
        log(
          `[interactive-draft] doc ${doc.documentId}: snapshot dest ${dest} cannot ride the grounding clause — launching ungrounded`,
        );
      } else {
        // Track the dest BEFORE the await (Copilot round 2): stop() during the clone must be
        // able to sweep the half-made snapshot through the placeholder flight.
        snapshotDest = dest;
        flight.snapshotDir = dest;
        const snap = await snapshotRepo(repo.rootPath, dest, { maxBytes: opts.repoSnapshotMaxBytes, log });
        if (snap.ok) {
          snapshotDir = dest;
        } else {
          flight.snapshotDir = undefined; // nothing landed — snapshotRepo cleans its partials
          if (snap.reason === 'dest-overlap') {
            // FAIL CLOSED (Copilot round 2): the configured draft dir places this run's write
            // root inside the live repository (or the repo is registered at the inbox). An
            // "ungrounded" launch would still hand the unbound worker read/write access to
            // live repo content through `extraWriteRoots: [runDir]` — so the launch is REFUSED
            // outright: no mkdir, no run, no ledger row. The status names the CONFIG problem;
            // the thrown error dead-letters the frame, replayable after the config is fixed.
            endFlight(runId);
            const message =
              `Crew refused to draft this document: the configured draft directory (${draftDir}) ` +
              `overlaps the project's repository (${repo.rootPath}), so launching would give the ` +
              `worker write access inside the live repo. Point the crew draft directory outside ` +
              `every registered repository, then replay the request.`;
            emitInteractive(STATUS_POSTED, {
              document_id: doc.documentId,
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
          emitInteractive(STATUS_POSTED, {
            document_id: doc.documentId,
            state: 'working',
            message: `${because[snap.reason]} — drafting without repo grounding`,
          });
          log(
            `[interactive-draft] doc ${doc.documentId}: repo ${repo.rootPath} could not be snapshotted (${snap.reason}) — launching ungrounded`,
          );
        }
      }
    }

    // Shutdown gate (Copilot round 2): stop() may have run during the awaits above — its sweep
    // already dropped the placeholder, but a clone can re-materialize files after that rm, and
    // a launch must never start once the subscriber detached from the engine's events.
    if (closed) {
      endFlight(runId);
      flight.snapshotDir = undefined;
      if (snapshotDest !== undefined) {
        try {
          rmSync(snapshotDest, { recursive: true, force: true });
        } catch {
          // best-effort — a leftover snapshot is a disk-space wart, never a correctness one
        }
      }
      log(`[interactive-draft] doc ${doc.documentId}: subscriber stopped before launch — abandoned (a replay retries)`);
      return;
    }

    // Containment is settled (any repo overlap refused above) — the run's write root may exist.
    mkdirSync(runDir, { recursive: true });

    // Resolve the project's graph BEFORE the launch, never indexing (a refresh is
    // `wicked-estate index` per member, bounded at 600s EACH — doing that inside a launch turns
    // "start a draft" into an unannounced multi-repo job). Missing or stale degrades to no
    // binding and the run proceeds exactly as before; the graph is a bonus, never a gate.
    const projectGraphBinding =
      doc.projectId === undefined
        ? null
        : await resolveProjectGraphBinding(adapter, doc.projectId, undefined)
            .then((d) => d.binding)
            .catch(() => null);
    try {
      await adapter.launchRun({
        problem: draftProblem(doc, outPath, snapshotDir),
        sessionId: runId,
        clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter)),
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
      // A launch that never happened keeps no flight and no snapshot (a replayed frame
      // re-registers and re-snapshots fresh).
      endFlight(runId);
      removeSnapshot(flight);
      // The 'processing' status is already on the thread — close it out honestly so the
      // canvas never sits in an in-between state on a launch that went nowhere.
      const reason = err instanceof Error ? err.message : String(err);
      emitInteractive(STATUS_POSTED, {
        document_id: doc.documentId,
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
    ledger.recordLaunch(doc.documentId, runId);
    if (closed) {
      // stop() ran while the engine was accepting the launch: its sweep already dropped the
      // placeholder and the snapshot, and the engine's workers die with the daemon — the
      // ledger row above is what keeps a post-restart redelivery from double-launching.
      return;
    }
    if (doc.projectId !== undefined) opts.onRunFiled?.(runId, doc.projectId);

    // Upgrade the placeholder to a live flight: the heartbeat starts once the run exists.
    flight.heartbeat = setInterval(() => {
      // Repeat the last real narration so the ~20s status.requested window is always fed,
      // even mid-phase when the engine is quiet.
      emitInteractive(STATUS_POSTED, {
        document_id: flight.documentId,
        state: 'working',
        message: flight.narration,
      });
    }, heartbeatMs);
    // Do not keep the daemon alive for narration alone.
    flight.heartbeat.unref?.();
    log(`[interactive-draft] doc ${doc.documentId} → governed run ${runId} (draft → ${outPath})`);
  }

  const sub = bus.subscribe({
    db,
    plugin: INTERACTIVE_BUS_PLUGIN,
    filter: INTERACTIVE_BUS_FILTER,
    // Live triggers only: replaying a bus backlog would answer docs whose drafts the assist
    // loop long since produced. History reconciliation belongs to the state plane, not here.
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    // Our own ledger + idempotency key are the dedupe; a bus-level retry of a failed launch
    // would double-launch precisely because the ledger row is only written on success.
    maxRetries: 0,
    handler: (event: BusEvent) => handleDocCreated(event),
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[interactive-draft] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      );
    },
  });

  return {
    ledger,
    inFlightDocs: () => [...new Set([...inFlight.values()].map((f) => f.documentId))],
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
        if (flight !== undefined) removeSnapshot(flight);
      }
      await sub.stop();
    },
  };
}
