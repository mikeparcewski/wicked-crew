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
 *    preservation at scale) is the LATER structural leg, after the Project-model ADR.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
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

/** The producer identity stamped on every event this module emits. Must appear in interactive's
 *  events.js ownership table for DRAFT_COMPLETED and STATUS_POSTED (the one interactive change
 *  this spike is allowed). */
export const INTERACTIVE_PRODUCER = 'wi-crew';

/** Interactive's doc-name grammar (server.js DOC_NAME) — re-checked before any launch so a
 *  malformed document_id can't name a ledger key or a draft file path. */
const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
}

/**
 * Parse a bus frame into a {@link SourceDocCreated}, or `null` when it is not an actionable
 * `doc.created` (wrong type, non-`source` kind, missing/malformed document_id). `kind: "demo"`
 * and plain html docs are the assist loop's business, not this seam's.
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
  return { documentId, brief, sourcePaths, style };
}

/** Collapse whitespace/newlines to single spaces and cap length — the intent must stay a
 *  single line (the PTY seat runner refuses embedded newlines) and a pasted-novel brief must
 *  not balloon the worker prompt. */
function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * The run's problem statement (the engine scopes it per phase and folds each phase's
 * instructions on top). Carries everything doc-specific: identity, brief, sources, style, and
 * the absolute path the finished HTML must land at.
 */
export function draftProblem(doc: SourceDocCreated, outPath: string): string {
  const sources =
    doc.sourcePaths.length > 0
      ? `Source materials to read: ${doc.sourcePaths.join(', ')}.`
      : 'There are no source files — the brief alone is the spec.';
  const brief = doc.brief.length > 0 ? oneLine(doc.brief, 2000) : '(no brief provided)';
  return (
    `Produce the first draft of the wicked-interactive document "${doc.documentId}" ` +
    `(requested style: ${doc.style}). The user's brief: ${brief} ${sources} ` +
    `The finished draft MUST be written to exactly this absolute file path: ${outPath}`
  );
}

/** Deterministic bus idempotency key for the one draft this seam may land per document. */
export function draftIdempotencyKey(documentId: string): string {
  return `crew:interactive.draft:${documentId}:v1`;
}

// ── Durable per-doc ledger (replay-dedup across redelivery AND daemon restarts) ──────────────

/** One ledger row — the lifecycle of a doc this seam answered. */
export interface DraftLedgerEntry {
  runId: string;
  launchedAt: string;
  /** Set once `draft.completed` was emitted (or the run failed — see `failedAt`). */
  draftEmittedAt?: string;
  /** Set when the governed run ended without a usable draft; kept so a redelivered
   *  `doc.created` does not silently relaunch a run an operator should look at first. */
  failedAt?: string;
}

/**
 * Durable map `document_id → DraftLedgerEntry`, JSON on disk, written atomically
 * (tmp + rename). The bus cursor alone cannot carry this: at-least-once delivery means the
 * same `doc.created` can arrive again after a crash between handling and cursor advance, and
 * `emitted-hash` state in memory dies with the process. The ledger is the system of record for
 * "this doc was answered"; the cache-like in-flight map is just the live half.
 */
export class InteractiveDraftLedger {
  private readonly path: string;
  private docs: Record<string, DraftLedgerEntry>;

  constructor(path: string) {
    this.path = path;
    this.docs = {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { docs?: Record<string, DraftLedgerEntry> };
      if (parsed && typeof parsed === 'object' && parsed.docs && typeof parsed.docs === 'object') {
        this.docs = parsed.docs;
      }
    } catch {
      // Missing or malformed ledger — start empty. Malformed is deliberately NOT fatal: a
      // corrupt ledger must not stop the daemon, and the worst case is one duplicate draft
      // emit, which the deterministic bus idempotency key still dedupes.
    }
  }

  has(documentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.docs, documentId);
  }

  get(documentId: string): DraftLedgerEntry | undefined {
    return this.docs[documentId];
  }

  recordLaunch(documentId: string, runId: string): void {
    this.docs[documentId] = { runId, launchedAt: new Date().toISOString() };
    this.persist();
  }

  recordDraftEmitted(documentId: string): void {
    const entry = this.docs[documentId];
    if (entry) {
      entry.draftEmittedAt = new Date().toISOString();
      this.persist();
    }
  }

  recordFailure(documentId: string): void {
    const entry = this.docs[documentId];
    if (entry) {
      entry.failedAt = new Date().toISOString();
      this.persist();
    }
  }

  size(): number {
    return Object.keys(this.docs).length;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ docs: this.docs }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

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
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface InteractiveDraftSubscription {
  stop(): Promise<void> | void;
  /** The durable ledger (diagnostics / tests). */
  ledger: InteractiveDraftLedger;
}

interface InFlight {
  documentId: string;
  outPath: string;
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
  return (adapter.constructor as typeof CoreAdapter).roster();
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

  const ledger = new InteractiveDraftLedger(
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

    if (event.type === 'unitDispatched') {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const phase = INTERACTIVE_DRAFT_WORKFLOW_DEF.phases[ord - 1]?.id ?? `phase ${ord}`;
      narrate(
        flight,
        ord >= phaseCount
          ? `Crew phase ${ord}/${phaseCount}: writing the draft (${phase})…`
          : `Crew phase ${ord}/${phaseCount}: ${phase} — planning the document…`,
      );
      return;
    }

    if (event.type === 'sessionCompleted') {
      endFlight(runId);
      finalize(flight, runId);
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

  function finalize(flight: InFlight, runId: string): void {
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
    if (emitted) {
      ledger.recordDraftEmitted(documentId);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'complete',
        message: 'First draft is in — landing it on the canvas now. Click any block to refine it.',
      });
      log(`[interactive-draft] draft.completed emitted for doc ${documentId} (run ${runId})`);
    }
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

    emitInteractive(STATUS_POSTED, {
      document_id: doc.documentId,
      state: 'processing',
      message: 'A governed crew picked up your brief — planning the draft…',
    });

    await adapter.launchRun({
      problem: draftProblem(doc, outPath),
      sessionId: runId,
      clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter)),
      workflow: INTERACTIVE_DRAFT_WORKFLOW,
    });
    // Record AFTER the launch resolved: a failed launch leaves no ledger row, so the next
    // delivery retries. The crash window between launch and this write is the reason the
    // draft emit ALSO carries a deterministic idempotency key.
    ledger.recordLaunch(doc.documentId, runId);

    const flight: InFlight = {
      documentId: doc.documentId,
      outPath,
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
    stop: async () => {
      offCoreEvents();
      for (const runId of [...inFlight.keys()]) endFlight(runId);
      await sub.stop();
    },
  };
}
