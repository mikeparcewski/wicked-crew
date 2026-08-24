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

import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
import { InteractiveHandoffLedger } from './ledger.js';
import type { CoreAdapter } from '../core/adapter.js';
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
        'Using the outline from the prior phase, write the COMPLETE first-draft HTML document and SAVE it to the output file named in the task — an absolute path, or a path relative to the root of the repository working tree you are in when the task names a repo-relative path — creating parent directories if needed and overwriting if present; the file on disk is the deliverable, so write it before you finish and end your reply with the path you wrote. Contract: a full self-contained HTML document (inline CSS, no external network resources, no build step); honor the requested style/format and the brief; keep every fact grounded in the brief/sources — never fabricate figures; do NOT add data-wid attributes anywhere (the wicked-interactive service instruments its own anchors); keep the markup semantic and well-formed (balanced tags) so the instrumentation pass lands cleanly.',
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
  /** The registered repo id — what `launchRun` takes as `repoRef`. */
  repoRef: string;
  /** The repo's root path (worker-facing: where the content actually lives). */
  rootPath: string;
}

/**
 * Resolve the repo a project is bound to (CREW-UX-8): the project's first `crew.repo` member,
 * verified against the repo registry so a stale membership (repo deleted after attach) never
 * fabricates a `repoRef` the engine would refuse. `undefined` when the project has no repo
 * member, the registry no longer knows the ref, or the adapter cannot answer (old addon,
 * engine hiccup) — every one of those degrades to today's behavior: a repo-less launch.
 *
 * WHY: a doc created under a repo-backed project used to launch its governed draft/revision
 * run with NO repo context at all, so the worker could not read the project's actual code and
 * generated placeholder content (operator report, wicked-studio project). Shared by the draft
 * and chat seams.
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

/**
 * The in-repo deliverable inbox for REPO-BOUND governed runs (wicked-core#293): declaring an
 * `extraWriteRoots` OUTSIDE the repo on a run whose cwd is a repo worktree kills the worker's
 * Write to that root deterministically BEFORE any hook fires — the exact combination v1 of
 * CREW-UX-8 shipped. So a bound run's deliverable lands INSIDE the worktree instead (this dir,
 * repo-relative — in-repo writes provably work), and crew copies it into the durable external
 * inbox at finalize, before the announce. Unbound runs keep the external-inbox shape (which
 * works: no repo worktree in play).
 */
export const IN_REPO_DELIVERABLE_DIR = '.wicked-drafts';

/** The repo-relative path a REPO-BOUND run's task names as its deliverable (wicked-core#293). */
export function inRepoDeliverablePath(fileName: string): string {
  return `${IN_REPO_DELIVERABLE_DIR}/${fileName}`;
}

/**
 * Resolve the worktree a run executed in — the run DTO carries `workdir` on the wire
 * (`AgentSession.workdir`, populated by the engine for repo-bound runs), and
 * `adapter.sessionsDetail()` is its daemon-side source. `undefined` when the run is unknown,
 * has no workdir (repo-less), or the adapter cannot answer — callers must treat that as
 * "the deliverable cannot be claimed", never guess a path.
 */
export async function resolveRunWorkdir(
  adapter: CoreAdapter,
  runId: string,
  log?: (message: string) => void,
): Promise<string | undefined> {
  try {
    const views = await adapter.sessionsDetail();
    const workdir = views.find((v) => v.session.id === runId)?.session.workdir;
    return typeof workdir === 'string' && workdir.length > 0 ? workdir : undefined;
  } catch (err) {
    log?.(
      `[interactive] could not resolve run ${runId}'s workdir: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Claim a REPO-BOUND run's deliverable (wicked-core#293 finalize half): resolve the run's
 * worktree, then COPY `repoRelPath` out of it into the durable `destPath` — BEFORE anything is
 * announced, so the bridge never depends on a worktree the engine may reap. Shared by the
 * draft and chat seams. Returns `{ok: false, reason}` (never throws) when the worktree cannot
 * be resolved, the file is missing/empty, or the copy fails — the caller turns that into the
 * honest error status instead of announcing a phantom deliverable.
 */
export async function claimWorktreeDeliverable(
  adapter: CoreAdapter,
  runId: string,
  repoRelPath: string,
  destPath: string,
  log?: (message: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const workdir = await resolveRunWorkdir(adapter, runId, log);
  if (workdir === undefined) {
    return { ok: false, reason: `could not resolve the run's worktree to collect ${repoRelPath}` };
  }
  const src = join(workdir, repoRelPath);
  let srcOk = false;
  try {
    srcOk = existsSync(src) && statSync(src).size > 0;
  } catch {
    srcOk = false;
  }
  if (!srcOk) {
    return { ok: false, reason: `no deliverable file at ${src} (missing or empty)` };
  }
  try {
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(src, destPath);
  } catch (err) {
    return {
      ok: false,
      reason: `could not copy ${src} to ${destPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true };
}

/**
 * The run's problem statement (the engine scopes it per phase and folds each phase's
 * instructions on top). Carries everything doc-specific: identity, brief, sources, style, and
 * the path the finished HTML must land at. When the doc's project is repo-bound (CREW-UX-8),
 * a SHORT grounding clause names the repo — the engine binds the run into it via `repoRef`,
 * but the worker only reads it when the task says to (the placeholder-content bug) — and
 * `outPath` is the REPO-RELATIVE deliverable path (wicked-core#293: the worker writes inside
 * its worktree; crew copies the file out at finalize). Unbound: `outPath` is absolute.
 */
export function draftProblem(doc: SourceDocCreated, outPath: string, repo?: ProjectRepo): string {
  const sources =
    doc.sourcePaths.length > 0
      ? `Source materials to read: ${doc.sourcePaths.join(', ')}.`
      : 'There are no source files — the brief alone is the spec.';
  const brief = doc.brief.length > 0 ? oneLine(doc.brief, 2000) : '(no brief provided)';
  const grounding =
    repo !== undefined
      ? `Ground the document in the repository at ${oneLine(repo.rootPath, 300)} — read it and use its real content, never placeholders. `
      : '';
  const destination =
    repo !== undefined
      ? `The finished draft MUST be written INSIDE the repository working tree you are in, at exactly this path relative to its root: ${outPath}`
      : `The finished draft MUST be written to exactly this absolute file path: ${outPath}`;
  return (
    `Produce the first draft of the wicked-interactive document "${doc.documentId}" ` +
    `(requested style: ${doc.style}). The user's brief: ${brief} ${sources} ${grounding}` +
    destination
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
  /** Where governed workers write finished drafts (default `~/.wicked-crew/interactive-drafts`). */
  draftDir?: string;
  /** Seat roster JSON for the governed run (default: the production council roster).
   *  The functional-test harness passes a deterministic stub seat here. */
  clisJson?: string;
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
  /** The durable inbox path the announce names — ALWAYS external (`draftDir`). */
  outPath: string;
  /** Set on REPO-BOUND runs (wicked-core#293): the repo-relative path the worker wrote inside
   *  its worktree; finalize copies it into `outPath` before announcing. */
  repoRelPath?: string;
  /** Guards the async finalize against a redelivered terminal event (double copy/announce). */
  finalizing?: boolean;
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  heartbeat: ReturnType<typeof setInterval>;
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
  const phaseCount = INTERACTIVE_DRAFT_WORKFLOW_DEF.phases.length;
  const inFlight = new Map<string, InFlight>(); // runId → live state

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
      clearInterval(flight.heartbeat);
      inFlight.delete(runId);
    }
    return flight;
  }

  /** Terminal-event fold: turn the governed run's own events into interactive narration, and
   *  close the loop with `draft.completed` when the run lands. */
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;
    // Finalize is async (the workdir resolution + copy, wicked-core#293): the flight stays in
    // the map while it runs — so the chat seam's isDocBusy wiring still sees the doc busy — and
    // this guard makes a redelivered terminal event a no-op instead of a double finalize.
    if (flight.finalizing === true) return;

    // Narration ladder (#user-feedback 2026-08-14): the heartbeat repeats the LATEST line, and
    // the interactive transcript dedups consecutive repeats — so the more the line ADVANCES with
    // the run's real events, the more the thread reads as progress instead of a stuck echo.
    const phaseName = (ord: number): string =>
      INTERACTIVE_DRAFT_WORKFLOW_DEF.phases[ord - 1]?.id ?? `phase ${ord}`;

    if (event.type === 'councilConvened') {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      // "0-seat council" reads like a bug — generic phrasing whenever clis is missing or empty
      // (Copilot, #269).
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(
        flight,
        `Convening ${council} to pick who ${ord >= phaseCount ? 'writes the draft' : 'plans the outline'}…`,
      );
      return;
    }

    if (event.type === 'unitDistributed') {
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
        ord >= phaseCount
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
        ord >= phaseCount
          ? 'Gate approved the draft — landing it now…'
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
      flight.finalizing = true;
      clearInterval(flight.heartbeat);
      void finalize(flight, runId)
        .catch((err) => {
          log(
            `[interactive-draft] finalize for run ${runId} threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        })
        .finally(() => {
          inFlight.delete(runId);
        });
      return;
    }

    if (event.type === 'sessionFailed' || event.type === 'runCancelled') {
      endFlight(runId);
      ledger.recordFailure(flight.documentId);
      emitInteractive(STATUS_POSTED, {
        document_id: flight.documentId,
        state: 'error',
        message:
          `The crew run answering this document ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}). Inspect it via the crew API (GET /api/v1/runs/${runId}); the assist loop can still take over.`,
      });
      log(`[interactive-draft] run ${runId} for doc ${flight.documentId} ended: ${event.type}`);
    }
  });

  async function finalize(flight: InFlight, runId: string): Promise<void> {
    const { documentId, outPath } = flight;
    // REPO-BOUND runs (wicked-core#293): the worker wrote INSIDE the run's worktree, so copy
    // the file into the durable inbox BEFORE announcing — the bridge must never depend on a
    // worktree the engine may reap, and the announce path stays the inbox path the service
    // already reads. The announce leg below is byte-identical to the unbound path.
    if (flight.repoRelPath !== undefined) {
      const claim = await claimWorktreeDeliverable(adapter, runId, flight.repoRelPath, outPath, log);
      if (!claim.ok) {
        ledger.recordFailure(documentId);
        emitInteractive(STATUS_POSTED, {
          document_id: documentId,
          state: 'error',
          message: `The crew run completed but its draft could not be collected from the run's worktree (run ${runId}): ${claim.reason}.`,
        });
        log(`[interactive-draft] run ${runId} completed but the worktree deliverable was not claimable: ${claim.reason}`);
        return;
      }
    }
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

    mkdirSync(draftDir, { recursive: true });
    const outPath = join(draftDir, `${doc.documentId}-v1.html`);
    const runId = randomUUID();

    // CREW-UX-8: a repo-bound project's doc is grounded in that repo — resolve BEFORE the
    // launch so the run binds into the repo (`repoRef`) and the task names it. Unbound docs
    // and repo-less projects resolve to `undefined` and launch exactly as before.
    const repo =
      doc.projectId !== undefined ? await resolveProjectRepo(adapter, doc.projectId, log) : undefined;
    // wicked-core#293: a REPO-BOUND run's deliverable moves INSIDE the run's worktree (the
    // task names this repo-relative path; in-repo writes provably work), because declaring an
    // external write root on a repo-worktree run kills the worker's Write before any hook
    // fires. Finalize copies the file from the worktree into `outPath` (the durable inbox)
    // before the announce, so the announce path is unchanged for the service.
    const repoRelPath =
      repo !== undefined ? inRepoDeliverablePath(`${doc.documentId}-v1.html`) : undefined;

    emitInteractive(STATUS_POSTED, {
      document_id: doc.documentId,
      state: 'processing',
      message: 'A governed crew picked up your brief — planning the draft…',
    });

    try {
      await adapter.launchRun({
        problem: draftProblem(doc, repoRelPath ?? outPath, repo),
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
        // CREW-UX-8: bind the run into the project's repo so the worker can actually read the
        // code it is asked to document. Never fabricated — only a verified `crew.repo` member.
        ...(repo !== undefined ? { repoRef: repo.repoRef } : {}),
        // UNBOUND runs deliver into the external inbox, which sits OUTSIDE the unit's sandbox —
        // on the wrapped-CLI path the boundary denied that exact write and failed the run AFTER
        // the draft was produced (crew#263, run eed69dfa); declaring the inbox widens the
        // boundary by exactly this root (wicked-core#259). REPO-BOUND runs must NOT declare it:
        // an external write root combined with a repo-worktree cwd kills the worker's Write
        // deterministically before any hook fires (wicked-core#293) — those runs deliver
        // in-repo (`repoRelPath`) instead, and finalize copies the file out.
        ...(repoRelPath === undefined ? { extraWriteRoots: [draftDir] } : {}),
      });
    } catch (err) {
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
    if (doc.projectId !== undefined) opts.onRunFiled?.(runId, doc.projectId);

    const flight: InFlight = {
      documentId: doc.documentId,
      outPath,
      ...(repoRelPath !== undefined ? { repoRelPath } : {}),
      narration: 'Crew run launched — working on your draft…',
      heartbeat: setInterval(() => {
        // Repeat the last real narration so the ~20s status.requested window is always fed,
        // even mid-phase when the engine is quiet.
        emitInteractive(STATUS_POSTED, {
          document_id: flight.documentId,
          state: 'working',
          message: flight.narration,
        });
      }, heartbeatMs),
      // Do not keep the daemon alive for narration alone.
    };
    flight.heartbeat.unref?.();
    inFlight.set(runId, flight);
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
      offCoreEvents();
      for (const runId of [...inFlight.keys()]) endFlight(runId);
      await sub.stop();
    },
  };
}
