/**
 * Opt-in governed answering of wicked-interactive's STRUCTURAL edits (task #86, Phase 7c
 * final leg — the draft leg's sibling, see draft-events.ts).
 *
 * wicked-interactive's service is model-free: a feedback batch's deterministic items
 * (content/style/remove) are applied instantly by the service and NEVER reach this seam —
 * only `structural-change` items climb. The service lands the deterministic partial as
 * `_v{N}.html`, then emits `wicked.interactive.feedback.processed` with `awaiting_structural > 0`
 * and the structural items INLINE (selector + instruction + the element's CURRENT fragment),
 * expecting *something with intelligence* to answer with `wicked.interactive.edit.completed`
 * carrying the edited fragments. Today that answerer is an ad-hoc `assist` agent session
 * (assist skill Step 3); this module makes a crew-governed run the answerer instead.
 *
 * Same shape as the draft leg, with the structural deltas:
 *
 *  - VERSIONED TARGETING: the dedupe unit is the HANDOFF — `<doc>:v<version>` — not the doc
 *    (one doc produces many structural handoffs over its life). The durable ledger keys on the
 *    handoff, and the closing emit's idempotency key carries doc+version.
 *  - INV-2 AT SCALE: unlike a first draft (no pre-existing anchors), an edited fragment MUST
 *    retain every pre-existing `data-wid` BYTE-EXACT — the service silently rejects violations
 *    (regenerate.js Inv2Error → the user's edit dies with no version landed). So this seam runs
 *    a deterministic PRE-EMIT SELF-CHECK mirroring the assist skill's Step 2/Step 3c discipline:
 *    parse the handed-off fragment's data-wids, verify the worker's fragment retains all of
 *    them, and fail HONEST (error status, no emit) on any violation — a loud crew-side rejection
 *    instead of a silent service-side one.
 *  - HANDOFF BY FILE: fragments can be arbitrarily large and the PTY seat runner's prompt is
 *    single-line, so the seam writes the items to a handoff JSON on disk and names its path in
 *    the problem; the worker writes each edited fragment to a per-item output file (never JSON
 *    with hand-escaped HTML — the exact failure the assist skill's Step 3c warns about).
 *  - PROJECT ATTRIBUTION (the 7b surface): a project-bound doc's events carry `project_id`
 *    (interactive's DES-PROJECT-001 enrichment); the governed run is launched with
 *    `LaunchOptions.projectId` so the edit shows up in the project's activity feed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
import {
  DOC_NAME,
  INTERACTIVE_DOMAIN,
  INTERACTIVE_PRODUCER,
  STATUS_POSTED,
  oneLine,
} from './draft-events.js';
import { InteractiveHandoffLedger } from './ledger.js';
import { readDocHead } from './chat-events.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../core/types.js';

// ── Vocabulary constants (interactive's, verbatim — src/service/events.js is the truth) ──────

export const FEEDBACK_PROCESSED = 'wicked.interactive.feedback.processed';
export const EDIT_COMPLETED = 'wicked.interactive.edit.completed';

/** Exact-type filter with a domain guard — no wildcard, one event type is the whole trigger. */
export const INTERACTIVE_EDIT_BUS_FILTER = `${FEEDBACK_PROCESSED}@${INTERACTIVE_DOMAIN}`;

/** Dedicated durable-cursor identity — NOT the draft seam's, so the two interactive seams
 *  advance independent cursors and stopping one never strands the other. */
export const INTERACTIVE_EDIT_BUS_PLUGIN = 'wicked-crew-interactive-edit';

// ── The workflow (workflows-as-data) ─────────────────────────────────────────────────────────

export const INTERACTIVE_EDIT_WORKFLOW = 'interactive-edit';

/**
 * The governed workflow that fulfils a structural handoff. ONE agent phase — `edit` (build,
 * creator role): the target fragments are already extracted and the instructions already
 * written, so unlike the draft leg there is nothing left to plan; a recon phase would only
 * burn a council turn re-reading a handoff the edit phase reads anyway.
 *
 * The phase `instructions` adapt the fragment-edit contract from interactive's assist skill
 * (Step 2 + Step 3): rewrite each handed-off fragment per its instruction, preserve every
 * pre-existing `data-wid` byte-for-byte, never mint new anchors, keep the markup well-formed,
 * and never fabricate facts. SINGLE-LINE by contract (PTY seat runner, wicked-core FINDING-011).
 *
 * The gate is `auto` with `validator_pin: null` — no human gate, no deterministic floor —
 * because this seam runs its own deterministic pre-emit self-check (INV-2) and interactive's
 * apply path re-checks the same invariant; a wrong-but-anchor-safe edit is the user's to judge
 * on the canvas, exactly as with the assist session it replaces.
 */
export const INTERACTIVE_EDIT_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_EDIT_WORKFLOW,
  is_system: true,
  phases: [
    {
      id: 'edit',
      kind: 'build',
      instructions:
        'Read the handoff JSON file named in the task; for EACH entry of its items array: rewrite that item\'s "fragment" (the current outerHTML of one document element) to fulfil the item\'s "instruction", and SAVE the complete edited fragment — the element\'s full outerHTML only, no document wrapper, no markdown fences — to the item\'s exact absolute "output_path" (create parent directories if needed, overwrite if present). NON-NEGOTIABLE (INV-2): every data-wid attribute in the input fragment MUST survive in your edited fragment byte-for-byte — never remove, rename, or re-value a data-wid, and keep the root element\'s own data-wid on the root; elements you ADD must carry no data-wid at all (the wicked-interactive service instruments its own anchors). Keep the markup well-formed (balanced tags), change only what the instruction asks, and never fabricate facts or figures. Write every output file before you finish and end your reply with the absolute paths you wrote.',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: [],
      role: 'creator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
};

// ── Pure helpers (unit-tested without a bus or an engine) ─────────────────────────────────────

/** One structural item as handed off by the service (fragment = current outerHTML). */
export interface StructuralItem {
  selector: string;
  instruction: string;
  fragment: string;
}

/** The feedback-processed fields this seam acts on. */
export interface StructuralHandoff {
  documentId: string;
  /** The partial version the service just landed — the PARENT of the version this edit makes. */
  version: number;
  items: StructuralItem[];
  /** Present when the doc is project-bound (interactive's DES-PROJECT-001 enrichment). */
  projectId?: string;
}

/**
 * Parse a bus frame into a {@link StructuralHandoff}, or `null` when it is not an actionable
 * structural handoff: wrong type, malformed payload, slug-invalid document_id, non-integer
 * version, or NO usable structural items. Deterministic-only batches (`awaiting_structural: 0`)
 * return `null` by construction — those edits already landed inside the service (edit-routing
 * rung 1) and must never climb to a crew. Items whose `fragment` is missing/null (the service
 * could not extract the element) are dropped: there is no current markup to edit.
 */
export function parseStructuralFeedback(eventType: string, payload: unknown): StructuralHandoff | null {
  if (eventType !== FEEDBACK_PROCESSED) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  // The declared handoff size is the explicit gate: a frame carrying structural_items while
  // announcing `awaiting_structural: 0` (or omitting it) is producer drift, not a handoff —
  // never launch a governed run off an inconsistent frame.
  const awaiting = p['awaiting_structural'];
  if (typeof awaiting !== 'number' || !Number.isInteger(awaiting) || awaiting <= 0) return null;
  const documentId = typeof p['document_id'] === 'string' ? p['document_id'] : '';
  if (!DOC_NAME.test(documentId)) return null;
  const version = p['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  const rawItems = Array.isArray(p['structural_items']) ? p['structural_items'] : [];
  const items: StructuralItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const selector = typeof r['selector'] === 'string' ? r['selector'] : '';
    const fragment = typeof r['fragment'] === 'string' ? r['fragment'] : '';
    if (selector.length === 0 || fragment.length === 0) continue;
    items.push({
      selector,
      instruction: typeof r['instruction'] === 'string' ? r['instruction'] : '',
      fragment,
    });
  }
  if (items.length === 0) return null;
  const projectId =
    typeof p['project_id'] === 'string' && p['project_id'].length > 0 ? p['project_id'] : undefined;
  return { documentId, version, items, ...(projectId !== undefined ? { projectId } : {}) };
}

/** The one dedupe unit of this seam: a handoff is doc+version, NOT doc-lifetime. */
export function handoffKey(documentId: string, version: number): string {
  return `${documentId}:v${version}`;
}

/** Deterministic bus idempotency key for the one edit this seam may land per handoff. */
export function editIdempotencyKey(documentId: string, version: number): string {
  return `crew:interactive.edit:${documentId}:v${version}`;
}

/** One row of the on-disk handoff file the worker reads. */
export interface HandoffFileItem extends StructuralItem {
  /** Absolute path the worker must write the edited fragment to. */
  output_path: string;
}

/** Per-item output paths are INDEX-named (`fragment-1.html`, …), never selector-named — a
 *  selector is bus-supplied data and must not name a filesystem path. */
export function handoffFileItems(handoff: StructuralHandoff, outDir: string): HandoffFileItem[] {
  return handoff.items.map((item, i) => ({
    ...item,
    output_path: join(outDir, `fragment-${i + 1}.html`),
  }));
}

/**
 * The run's problem statement. Single-line (PTY contract); the bulky fragments ride in the
 * handoff FILE, so only identity, the capped instruction gist, and the file path ride here.
 */
export function editProblem(handoff: StructuralHandoff, handoffPath: string): string {
  const gist = oneLine(handoff.items.map((i) => i.instruction).filter((s) => s.length > 0).join('; '), 600);
  return (
    `Fulfil ${handoff.items.length} structural edit(s) on the wicked-interactive document ` +
    `"${handoff.documentId}" (editing version ${handoff.version}). Read the handoff file at ` +
    `${handoffPath} — a JSON file whose items array carries, per edit: the user's instruction, ` +
    `the element's current HTML fragment, and the exact absolute output_path where the edited ` +
    `fragment must be saved. The user asked: ${gist.length > 0 ? gist : '(no instruction text)'}`
  );
}

// ── The pre-emit INV-2 self-check (deterministic; mirrors assist skill Step 3c) ──────────────

/** Every `data-wid` value in a fragment, in document order (duplicates preserved). */
export function fragmentWids(fragment: string): string[] {
  return [...fragment.matchAll(/data-wid="([^"]*)"/g)].map((m) => m[1] as string);
}

/** The data-wids of `before` missing from `after`, byte-exact. Non-empty = INV-2 violation.
 *  Deliberately conservative: a wid that survives with different quoting/escaping counts as
 *  dropped — the service compares exact attribute values, and fail-closed here beats a silent
 *  Inv2Error rejection there. */
export function droppedWids(before: string, after: string): string[] {
  const kept = new Set(fragmentWids(after));
  return [...new Set(fragmentWids(before))].filter((w) => !kept.has(w));
}

/** One rejected item of a self-check. */
export interface EditViolation {
  selector: string;
  reason: string;
}

/** The self-check verdict over a whole handoff's worker output. */
export interface EditCollection {
  results: Array<{ selector: string; fragment: string }>;
  violations: EditViolation[];
}

/**
 * Read the worker's per-item output files and verify each against the handed-off fragment:
 * the file must exist non-empty, and every pre-existing `data-wid` must survive byte-exact.
 * ANY violation fails the whole handoff (all-or-nothing): a partial apply would land a version
 * the user believes complete, and the violating item would die silently service-side.
 */
export function collectEditResults(items: HandoffFileItem[]): EditCollection {
  const results: Array<{ selector: string; fragment: string }> = [];
  const violations: EditViolation[] = [];
  for (const item of items) {
    let fragment = '';
    try {
      fragment = readFileSync(item.output_path, 'utf8').trim();
    } catch {
      /* missing file → the empty-fragment violation below */
    }
    if (fragment.length === 0) {
      violations.push({ selector: item.selector, reason: `no edited fragment at ${item.output_path}` });
      continue;
    }
    const dropped = droppedWids(item.fragment, fragment);
    if (dropped.length > 0) {
      violations.push({
        selector: item.selector,
        reason: `INV-2 violation — data-wid(s) dropped: ${dropped.join(', ')}`,
      });
      continue;
    }
    results.push({ selector: item.selector, fragment });
  }
  return { results, violations };
}

// ── The subscriber ────────────────────────────────────────────────────────────────────────────

/** Options for {@link startInteractiveEditSubscriber}. */
export interface InteractiveEditOptions {
  /** Bus SQLite db path. Omit to let wicked-bus resolve its own default
   *  (honors `WICKED_BUS_DATA_DIR`) — where interactive's service emits unless redirected. */
  dbPath?: string;
  /** Poll cadence, ms (default 2000; tests shorten it). */
  pollIntervalMs?: number;
  /** Heartbeat narration cadence while a run is in flight, ms (default 15000 — inside the
   *  UI's ~20s `status.requested` window so the canvas never reads frozen). */
  heartbeatMs?: number;
  /** Ledger file (default `~/.wicked-crew/interactive-edit-ledger.json`). */
  ledgerPath?: string;
  /** Where handoff files land and workers write edited fragments
   *  (default `~/.wicked-crew/interactive-edits`). */
  editDir?: string;
  /** Seat roster JSON for the governed run (default: the production council roster).
   *  The functional-test harness passes a deterministic stub seat here. */
  clisJson?: string;
  /** The docs root a handoff's doc manifest is read from — the KIND GATE only (CREW-UX-9):
   *  a doc whose manifest says `kind: "demo"` is the demo seam's to answer (a demo refines by
   *  re-authoring `demo.spec.mjs` + re-recording, assist SKILL.md Step 8c — a storyboard
   *  fragment edit would change the chapter list, not the recording). A doc this daemon
   *  cannot see (missing/unreadable manifest) stays THIS seam's, exactly as before CREW-UX-9
   *  — and the demo seam requires a readable `kind: "demo"` manifest, so exactly one seam
   *  answers any handoff. Default: the shared-default resolution
   *  (`WICKED_INTERACTIVE_ROOT` › `~/wicked-interactive/docs`); the server wires the
   *  per-project `interactiveRoot` setting through here. */
  resolveDocsRoot?: (projectId: string | undefined) => string;
  /** Is the DEMO seam actually armed in this process? Probed per event (the demo seam arms
   *  after this one, and can fail to arm at all — bus missing, workflow registration refused).
   *  The kind gate above hands demo docs to that seam; when it is NOT there, handing off is
   *  handing off to NOBODY — the canvas would sit on a handoff no seam ever answers and no
   *  status ever closes. So an un-armed demo seam turns the silent skip into an honest error
   *  status (see `handleFeedbackProcessed`). Default: `() => false` — a caller that does not
   *  wire the probe has no demo seam to hand anything to, and saying so out loud beats
   *  guessing. */
  demoSeamArmed?: () => boolean;
  /** Called after a launch that FILED the run into a project (the handoff carried
   *  `project_id`). The server wires this to the same post-commit half the launch route
   *  performs: tag the run in the live membership index + emit `wicked.crew.membership.attached`
   *  (the engine already attached the crew.run membership atomically with the launch). */
  onRunFiled?: (runId: string, projectId: string) => void;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface InteractiveEditSubscription {
  stop(): Promise<void> | void;
  /** The durable ledger (diagnostics / tests). */
  ledger: InteractiveHandoffLedger;
  /** Documents with an edit run currently in flight — the chat seam's per-doc serialization
   *  (CREW-UX-5 contract (c)) consults this so an iteration ask never races a structural edit. */
  inFlightDocs(): string[];
}

interface InFlight {
  key: string;
  documentId: string;
  version: number;
  items: HandoffFileItem[];
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  heartbeat: ReturnType<typeof setInterval>;
  /** The engine's own reason for the most recent failed unit (`stepFailed.detail`). Carried so
   *  the terminal error status names WHY — in particular the crew#311 deliverable-floor report,
   *  which says which fragment files were expected and what was found. */
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
 * Arm the seam: register the `interactive-edit` workflow, open a durable
 * `wicked.interactive.feedback.processed` subscription, and answer each handoff carrying
 * structural items with a governed run that ends in `wicked.interactive.edit.completed`.
 *
 * Graceful degradation mirrors the draft seam: a missing wicked-bus package or an unopenable
 * db LOGS and returns `null` — the daemon must still boot on a machine whose bus is broken;
 * interactive's assist loop remains the (always-available) fallback answerer.
 */
export async function startInteractiveEditSubscriber(
  adapter: CoreAdapter,
  opts: InteractiveEditOptions = {},
): Promise<InteractiveEditSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[interactive-edit] wicked-bus is not importable — governed structural edits disabled: ${
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
      `[interactive-edit] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — governed structural edits disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // The workflow rides the normal registration path — core validates the def BEFORE it is
  // persisted/hot-registered (FINDING-002 ordering), so a drifted def fails the arm loudly
  // instead of failing the first launch obscurely.
  try {
    await adapter.registerWorkflow(INTERACTIVE_EDIT_WORKFLOW_DEF);
  } catch (err) {
    log(
      `[interactive-edit] could not register the '${INTERACTIVE_EDIT_WORKFLOW}' workflow — ` +
        `governed structural edits disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const ledger = new InteractiveHandoffLedger(
    opts.ledgerPath ?? join(defaultStateDir(), 'interactive-edit-ledger.json'),
  );
  const editDir = opts.editDir ?? join(defaultStateDir(), 'interactive-edits');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  // The run executes ONE MORE unit than the def declares: the crew#311 deliverable floor,
  // appended per-run by `launchRun` from `requireDeliverables`. Narration keys off this so the
  // "landing the new version" line fires when the FILES are verified, not when the worker
  // merely stopped talking.
  const agentPhaseCount = INTERACTIVE_EDIT_WORKFLOW_DEF.phases.length;
  const inFlight = new Map<string, InFlight>(); // runId → live state

  /** Emit onto interactive's vocabulary as the `wi-crew` producer. Never throws into the
   *  caller: narration/announce failures are logged — a lost status line must not kill the
   *  subscription, and a duplicate edit emit (WB-002) is the idempotency key WORKING. */
  function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): boolean {
    try {
      bus.emit(db, config, {
        event_type: type,
        domain: INTERACTIVE_DOMAIN,
        subdomain: type === EDIT_COMPLETED ? 'feedback' : 'status',
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
        `[interactive-edit] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  function narrate(flight: InFlight, message: string): void {
    flight.narration = message;
    emitInteractive(STATUS_POSTED, {
      document_id: flight.documentId,
      version: flight.version,
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
   *  close the loop with `edit.completed` when the run lands AND the self-check passes. */
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;

    // Narration ladder — same rationale as the draft fold: the heartbeat repeats the LATEST
    // line and the transcript dedups repeats, so advancing the line = visible progress.
    const blocks =
      flight.items.length === 1 ? 'the targeted block' : `${flight.items.length} targeted blocks`;

    // The crew#311 deliverable floor is a DETERMINISTIC tool phase — no seat, no council. Core
    // still emits the seat-selection events for it (its `cli` is the node interpreter's absolute
    // path), so narrating them verbatim put "Council picked /opt/homebrew/.../node to rework…"
    // in the reader's thread. Drop those two lines for the floor ord.
    const isFloorOrd = (e: CoreEvent): boolean =>
      typeof (e as { ord?: unknown }).ord === 'number' && (e as { ord: number }).ord > agentPhaseCount;

    if (event.type === 'councilConvened') {
      if (isFloorOrd(event)) return;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      // "0-seat council" reads like a bug — generic phrasing whenever clis is missing or empty
      // (Copilot, #269).
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(flight, `Convening ${council} to pick who reworks ${blocks}…`);
      return;
    }

    if (event.type === 'unitDistributed') {
      if (isFloorOrd(event)) return;
      const who = typeof event.cli === 'string' ? event.cli : 'a worker';
      const pct = typeof event.agreement_pct === 'number' ? ` (${event.agreement_pct}% agreement)` : '';
      narrate(flight, `Council picked ${who} to rework ${blocks}${pct}…`);
      return;
    }

    if (event.type === 'unitDispatched') {
      if (isFloorOrd(event)) {
        narrate(flight, 'Checking the edited fragment files were actually written…');
        return;
      }
      narrate(flight, `Crew is reworking ${blocks}…`);
      return;
    }

    if (event.type === 'toolInvoked') {
      const tools = Array.isArray(event.tools) ? [...new Set(event.tools)].join(', ') : '';
      if (tools) narrate(flight, `Worker is using ${tools} on ${blocks}…`);
      return;
    }

    if (event.type === 'unitOutputCaptured') {
      narrate(flight, `Rework finished — the governance gate is reviewing it…`);
      return;
    }

    if (event.type === 'gateDecided' && event.allow === true) {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      // ord > the def's own phase count = the crew#311 deliverable floor, appended per-run.
      narrate(
        flight,
        ord > agentPhaseCount
          ? 'Edited fragments verified on disk — landing the new version now…'
          : 'Gate approved the edit — checking the fragment files landed…',
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
      // Remember the engine's own reason (crew#311) so the terminal status can name it.
      const detail = typeof event.detail === 'string' ? event.detail.trim() : '';
      if (detail.length > 0) flight.failureDetail = detail;
      return;
    }

    if (event.type === 'sessionFailed' || event.type === 'runCancelled') {
      endFlight(runId);
      ledger.recordFailure(flight.key);
      const why =
        flight.failureDetail !== undefined ? ` Reason: ${oneLine(flight.failureDetail, 600)}` : '';
      emitInteractive(STATUS_POSTED, {
        document_id: flight.documentId,
        version: flight.version,
        state: 'error',
        message:
          `The crew run answering this edit ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}).${why} Inspect it via the crew API (GET /api/v1/runs/${runId}); the assist loop can still take over.`,
      });
      log(`[interactive-edit] run ${runId} for handoff ${flight.key} ended: ${event.type}`);
    }
  });

  function finalize(flight: InFlight, runId: string): void {
    const { documentId, version, key, items } = flight;
    // The deterministic pre-emit self-check (INV-2 at scale): a violating fragment would be
    // rejected SILENTLY by the service (regenerate.js Inv2Error) — the user's edit would just
    // die. Fail honest here instead: error status, failure row, no emit.
    const { results, violations } = collectEditResults(items);
    if (violations.length > 0) {
      ledger.recordFailure(key);
      const detail = violations.map((v) => `${v.selector}: ${v.reason}`).join('; ');
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        version,
        state: 'error',
        message:
          `The crew's edit failed its pre-emit self-check and was NOT applied — ${detail} ` +
          `(run ${runId}). The document is unchanged; resubmit the edit or let the assist loop take over.`,
      });
      log(`[interactive-edit] run ${runId} rejected by self-check for ${key}: ${detail}`);
      return;
    }
    // Announce with the handoff's version (the parent the service forks from) and the
    // deterministic doc+version key — a re-announce is a WB-002 no-op.
    const emitted = emitInteractive(
      EDIT_COMPLETED,
      { document_id: documentId, version, results },
      editIdempotencyKey(documentId, version),
    );
    if (!emitted) {
      // The bus refused the announce (non-WB-002): the edit exists on disk but never reached
      // the service. Fail HONEST — leaving the ledger row launched-but-never-closed would
      // silently eat every replay of this handoff (the launch gate is `ledger.has`).
      ledger.recordFailure(key);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        version,
        state: 'error',
        message:
          `Crew finished the edit but could not announce it on the bus (run ${runId}); ` +
          `the document is unchanged. Inspect the crew daemon log, then resubmit the edit.`,
      });
      log(`[interactive-edit] edit.completed emit FAILED for ${key} (run ${runId}) — recorded as failure`);
      return;
    }
    ledger.recordEmitted(key);
    emitInteractive(STATUS_POSTED, {
      document_id: documentId,
      version,
      state: 'complete',
      message: 'Edit is in — landing the new version on the canvas now.',
    });
    log(`[interactive-edit] edit.completed emitted for ${key} (run ${runId}, ${results.length} fragment(s))`);
  }

  async function handleFeedbackProcessed(event: BusEvent): Promise<void> {
    const handoff = parseStructuralFeedback(event.event_type, event.payload);
    if (handoff === null) return;

    // THE KIND GATE (CREW-UX-9): the frame carries no `kind`, so the doc's own manifest is
    // the truth. A demo doc's step feedback means "re-author demo.spec.mjs and re-record"
    // (assist SKILL.md Step 8c) — the demo seam's business; answering it here would land a
    // storyboard-text edit the next re-record overwrites, while the user's actual ask (change
    // the demo) dies. Fail-open on an unreadable manifest: that is this seam's pre-CREW-UX-9
    // behavior, and the demo seam requires a READABLE demo manifest — one answerer either way.
    const docsRoot = (opts.resolveDocsRoot ?? (() => resolveInteractiveRoot(null)))(
      handoff.projectId,
    );
    const head = readDocHead(docsRoot, handoff.documentId);
    if (head !== null && head.kind === 'demo') {
      // …but ONLY when the demo seam is actually there to take it. Skipping into a seam that
      // never armed is a silent drop: no run, no status, a canvas that waits forever. Say so.
      if (!(opts.demoSeamArmed ?? (() => false))()) {
        emitInteractive(STATUS_POSTED, {
          document_id: handoff.documentId,
          version: handoff.version,
          state: 'error',
          message:
            `This is a demo document: changing it means re-authoring its demo spec and ` +
            `re-recording, which the crew's demo seam does — and that seam is not running on ` +
            `this daemon. Nothing was changed. Start crew with the interactive demo events ` +
            `enabled (drop --no-interactive-demo-events / WICKED_INTERACTIVE_DEMO_EVENTS), then ` +
            `resubmit this feedback.`,
        });
        // DELIBERATELY no ledger row: this handoff was NOT answered, it was declined. An
        // operator who arms the demo seam and replays the frame must get a real re-author run,
        // and the launch gate is `ledger.has` — a row here would eat that replay forever.
        log(
          `[interactive-edit] doc ${handoff.documentId} is a demo but the demo seam is NOT armed ` +
            `— handoff v${handoff.version} answered with an honest error status, not silently dropped`,
        );
        return;
      }
      log(
        `[interactive-edit] doc ${handoff.documentId} is a demo — its step feedback re-authors ` +
          `the spec (demo seam), not the storyboard; handoff v${handoff.version} skipped here`,
      );
      return;
    }

    const key = handoffKey(handoff.documentId, handoff.version);

    // Replay-dedup: the ledger is the durable gate (redelivery after crash/restart), the
    // in-flight scan the live one (redelivery inside a single process lifetime). Keyed by
    // HANDOFF — a later feedback batch on the same doc is a new key and launches normally.
    if (ledger.has(key)) {
      log(
        `[interactive-edit] handoff ${key} already answered (run ${ledger.get(key)?.runId}) — replay ignored`,
      );
      return;
    }
    for (const f of inFlight.values()) {
      if (f.key === key) return;
    }

    const outDir = join(editDir, key.replace(':', '-'));
    mkdirSync(outDir, { recursive: true });
    const items = handoffFileItems(handoff, outDir);
    const handoffPath = join(editDir, `${key.replace(':', '-')}-handoff.json`);
    writeFileSync(
      handoffPath,
      JSON.stringify({ document_id: handoff.documentId, version: handoff.version, items }, null, 2),
      'utf8',
    );
    const runId = randomUUID();

    emitInteractive(STATUS_POSTED, {
      document_id: handoff.documentId,
      version: handoff.version,
      state: 'processing',
      message: `A governed crew picked up your edit — reworking ${items.length === 1 ? 'the block' : `${items.length} blocks`}…`,
    });

    try {
      const input: LaunchRunInput = {
        problem: editProblem(handoff, handoffPath),
        sessionId: runId,
        clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter)),
        workflow: INTERACTIVE_EDIT_WORKFLOW,
        // The 7b surface: a project-bound doc's governed edits are FILED — the run lands in
        // the project's activity feed instead of floating unattributed.
        ...(handoff.projectId !== undefined ? { projectId: handoff.projectId } : {}),
        // The task names the handoff JSON + per-block output files under `editDir`, which sits
        // OUTSIDE the unit's sandbox — the wrapped-CLI boundary would deny both the reads and
        // the deliverable writes (crew#263, same shape as the draft path). One declared root
        // covers both: write roots are readable (wicked-core#259).
        extraWriteRoots: [editDir],
        // THE DELIVERABLE FLOOR (crew#311): EVERY handed-off fragment file is a deliverable, so
        // a run that rewrote three blocks and wrote one file fails too — the floor is per-path,
        // not "did anything land". Without it the engine's substance floor passes a worker
        // whose Writes were denied as long as it narrated ~200 characters first.
        requireDeliverables: items.map((i) => i.output_path),
      };
      await adapter.launchRun(input);
    } catch (err) {
      // The 'processing' status is already on the thread — close it out honestly so the
      // canvas never sits in an in-between state on a launch that went nowhere.
      const reason = err instanceof Error ? err.message : String(err);
      emitInteractive(STATUS_POSTED, {
        document_id: handoff.documentId,
        version: handoff.version,
        state: 'error',
        message: `Crew could not start a run for this edit: ${reason}. The assist loop can still take over.`,
      });
      // DELIBERATELY no ledger write: only an answered handoff earns a row, so an operator can
      // replay the dead-lettered feedback.processed after fixing the daemon and get a real
      // retry. Re-throw so the bus (maxRetries 0) dead-letters the frame — visible, replayable,
      // and incapable of hot-looping.
      throw err;
    }
    // Record AFTER the launch resolved: a failed launch leaves no ledger row, so a replayed
    // delivery retries. The crash window between launch and this write is the reason the
    // edit emit ALSO carries a deterministic idempotency key.
    ledger.recordLaunch(key, runId);
    if (handoff.projectId !== undefined) opts.onRunFiled?.(runId, handoff.projectId);

    const flight: InFlight = {
      key,
      documentId: handoff.documentId,
      version: handoff.version,
      items,
      narration: 'Crew run launched — working on your edit…',
      heartbeat: setInterval(() => {
        // Repeat the last real narration so the ~20s status.requested window is always fed,
        // even mid-phase when the engine is quiet.
        emitInteractive(STATUS_POSTED, {
          document_id: flight.documentId,
          version: flight.version,
          state: 'working',
          message: flight.narration,
        });
      }, heartbeatMs),
      // Do not keep the daemon alive for narration alone.
    };
    flight.heartbeat.unref?.();
    inFlight.set(runId, flight);
    log(`[interactive-edit] handoff ${key} → governed run ${runId} (${items.length} item(s), handoff ${handoffPath})`);
  }

  const sub = bus.subscribe({
    db,
    plugin: INTERACTIVE_EDIT_BUS_PLUGIN,
    filter: INTERACTIVE_EDIT_BUS_FILTER,
    // Live triggers only: replaying a bus backlog would answer handoffs whose edits the assist
    // loop long since produced. History reconciliation belongs to the state plane, not here.
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    // Our own ledger + idempotency key are the dedupe; a bus-level retry of a failed launch
    // would double-launch precisely because the ledger row is only written on success.
    maxRetries: 0,
    handler: (event: BusEvent) => handleFeedbackProcessed(event),
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[interactive-edit] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
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
