/**
 * Opt-in governed answering of wicked-interactive's conversational ITERATION asks (CREW-UX-5 —
 * the third interactive leg, beside draft-events.ts and edit-events.ts).
 *
 * A finished doc's thread send in wicked-studio does `postFork` (mints a version) and injects
 * `wicked.interactive.chat.posted` — and NOTHING consumed that topic since the ad-hoc assist
 * agent retired: crew answers `doc.created` (the first draft) and `feedback.processed` (the
 * structural handoff), but the plain conversational ask ("make the intro punchier") had no
 * answerer, so BRIEF-UX-001 J3's "iterate twice" was impossible. This module makes a
 * crew-governed run the answerer: understand-the-ask → revise, announced back on the SAME
 * `draft.completed` wire the first draft rides — the service lands the revised full HTML as a
 * generated version (`materializeDraft` → `applyGeneratedHtml`), which is exactly what an
 * iteration is.
 *
 * Shape mirrors draft-events.ts (dynamic wicked-bus import, graceful degradation, durable
 * cursor `cursor_init: 'latest'` under a dedicated plugin name, durable replay-dedup ledger,
 * `wi-crew` narration via status.posted). The chat-specific deltas:
 *
 *  - THE TRIGGER IS A CONVERSATION LINE, so the actionable filter is layered (the contract):
 *    (a) `role: "user"` only — agent narration echoes also ride chat.posted;
 *    (b) the doc must EXIST under the resolved docs root and not belong to a foreign loop —
 *        and the disk truth here is subtle: interactive's `initManifest` only ever RECORDS a
 *        `kind` for demo docs (a real `kind: "source"` doc's versions.json carries NO kind
 *        field at all — the "source" spelling rides the doc.created EVENT only; verified
 *        against interactive 0.8.0 and main, src/service/server.js `initWorkspace(dir, html)`).
 *        So the gate accepts `source` (future manifests may record it) and the absent-default
 *        `doc`, and rejects explicit foreign kinds (`demo`) — a doc we cannot see is not ours
 *        to answer either;
 *    (c) per-doc serialization — an ask on a doc whose draft/edit/chat run is still in flight
 *        is QUEUED (FIFO per doc), never raced: two concurrent revisions of one doc would
 *        land as two forks of the same parent and the second would silently drop the first;
 *    (d) the text must be an ASK, not an echo of a machine-composed message — the feedback
 *        overlay injects its batch as a chat.posted TOO (same `source_message_id` as its
 *        `feedback.submitted`), and that batch is already the edit seam's business.
 *  - VERSION SNAPSHOT AT LAUNCH: the seam copies the doc's CURRENT HEAD html into the chat
 *    inbox and names the COPY in the task, so (1) the worker never needs read access to the
 *    doc workspace (the one declared write root covers input + deliverable — crew#263 /
 *    wicked-core#259: write roots are readable) and (2) a queued second ask snapshots the
 *    head AFTER the first revision landed — which is what "iterate twice" means.
 *  - THE LANDING GATE: `draft.completed` is announced by path and the service lands the new
 *    version ASYNCHRONOUSLY. A queued ask drained the instant our run completes would snapshot
 *    the stale head and silently drop the revision the user just watched land. So a successful
 *    completion arms a per-doc gate — drain only once the manifest head ADVANCES past the head
 *    we launched from, or a timeout passes (the service may be down; waiting forever would
 *    strand the queue).
 *  - IDEMPOTENCY KEYING: one doc legitimately produces many asks over its life, so the dedupe
 *    unit is the ASK — `source_message_id` when the frame carries one (the studio reuses the
 *    SAME message id on a user-driven resend, so a retry that reached the bus twice dedupes),
 *    else the bus `event_id` (pure redelivery). Never the doc lifetime.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
import {
  DOC_NAME,
  DRAFT_COMPLETED,
  INTERACTIVE_DOMAIN,
  INTERACTIVE_PRODUCER,
  STATUS_POSTED,
  oneLine,
} from './draft-events.js';
import { InteractiveHandoffLedger } from './ledger.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent, WorkflowDef } from '../core/types.js';

// ── Vocabulary constants (interactive's, verbatim — src/service/events.js is the truth) ──────

export const CHAT_POSTED = 'wicked.interactive.chat.posted';

/** Exact-type filter with a domain guard — no wildcard, one event type is the whole trigger. */
export const INTERACTIVE_CHAT_BUS_FILTER = `${CHAT_POSTED}@${INTERACTIVE_DOMAIN}`;

/** Dedicated durable-cursor identity — NOT the draft/edit seams', so the three interactive
 *  seams advance independent cursors and stopping one never strands another. */
export const INTERACTIVE_CHAT_BUS_PLUGIN = 'wicked-crew-interactive-chat';

// ── The workflow (workflows-as-data) ─────────────────────────────────────────────────────────

export const INTERACTIVE_CHAT_WORKFLOW = 'interactive-chat';

/**
 * The governed workflow that fulfils an iteration ask. Two agent phases — understand (recon)
 * then revise (build, creator role) — the draft leg's sibling: the reviser builds on a stated
 * plan instead of one-shotting a rewrite, and the run narrates a real phase transition.
 *
 * The phase `instructions` carry the ITERATION contract: start from the CURRENT document (the
 * snapshot path named in the task), change only what the ask touches, KEEP every existing
 * `data-wid` on kept elements (interactive's instrument pass preserves pre-existing anchors —
 * INV-1 — so feedback deep-links survive the iteration) and mint none on added ones. They are
 * SINGLE-LINE by contract (PTY seat runner, wicked-core FINDING-011).
 *
 * All gates are `auto` with `validator_pin: null` — same rationale as the draft leg: the
 * acceptance gate for a revision is interactive's instrument+theme pipeline and the user's own
 * eyes on the canvas.
 */
export const INTERACTIVE_CHAT_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_CHAT_WORKFLOW,
  is_system: true,
  phases: [
    {
      id: 'understand',
      kind: 'recon',
      instructions:
        'Understand the revision ask, do not write anything yet: read the CURRENT document — the absolute HTML file path named in the task — and the user\'s ask, then produce a concise revision plan as plain text: which sections change, what gets added or removed, and what stays untouched (the default is untouched — this is an iteration on a document the user already accepted, not a rewrite). Never invent facts, numbers, or claims the current document and the ask do not support; where the ask needs material the document lacks, plan honest placeholder copy that says what belongs there. Do NOT write HTML and do NOT create any files in this phase.',
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
      id: 'revise',
      kind: 'build',
      instructions:
        'Using the plan from the prior phase, write the COMPLETE revised HTML document and SAVE it to the absolute output file named in the task (create parent directories if needed, overwrite if present) — the file on disk is the deliverable, so write it before you finish and end your reply with the absolute path you wrote. Contract: start from the CURRENT document (the absolute input path named in the task) and apply the user\'s ask — change only what the ask touches and keep everything else, including the document\'s style and structure; produce a full self-contained HTML document (inline CSS, no external network resources, no build step); KEEP every existing data-wid attribute byte-for-byte on elements you keep, and add NO data-wid to elements you create (the wicked-interactive service instruments its own anchors); never fabricate facts or figures; keep the markup semantic and well-formed (balanced tags) so the instrumentation pass lands cleanly.',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: ['understand'],
      role: 'creator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
};

// ── Pure helpers (unit-tested without a bus or an engine) ─────────────────────────────────────

/** The chat-posted fields this seam acts on. */
export interface ChatAsk {
  documentId: string;
  /** The user's ask, verbatim (flattened later — the problem statement is single-line). */
  text: string;
  /** The thread message behind the ask (studio inject wire, §7.7). The studio REUSES the same
   *  id on a user-driven resend, so this is the dedupe unit when present. */
  sourceMessageId?: string;
  /** Present when the doc is project-bound (interactive's DES-PROJECT-001 enrichment). */
  projectId?: string;
}

/**
 * Parse a bus frame into a {@link ChatAsk}, or `null` when it is not an actionable ask:
 * wrong type, malformed payload, non-`user` role (contract (a) — agent narration and any
 * transcript echo ride the same topic), slug-invalid document_id, or empty text. Kind and
 * existence checks (contract (b)) happen against the filesystem, not the payload — the frame
 * does not carry `kind`.
 */
export function parseChatPosted(eventType: string, payload: unknown): ChatAsk | null {
  if (eventType !== CHAT_POSTED) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p['role'] !== 'user') return null;
  const documentId = typeof p['document_id'] === 'string' ? p['document_id'] : '';
  if (!DOC_NAME.test(documentId)) return null;
  const text = typeof p['text'] === 'string' ? p['text'].trim() : '';
  if (text.length === 0) return null;
  const sourceMessageId =
    typeof p['source_message_id'] === 'string' && p['source_message_id'].length > 0
      ? p['source_message_id']
      : undefined;
  const projectId =
    typeof p['project_id'] === 'string' && p['project_id'].length > 0 ? p['project_id'] : undefined;
  return {
    documentId,
    text,
    ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/** The feedback overlay's machine-composed batch header (studio `composeBatchMessage`): the
 *  batch is injected as a chat.posted for TRANSCRIPT fidelity, but the document work it names
 *  already rides `feedback.submitted` → the deterministic apply / the edit seam. */
const FEEDBACK_BATCH_ECHO = /^feedback on \d+ places? in /i;

/** Contract (d): `true` when the text is a conversational ask this seam should answer —
 *  not the feedback overlay's batch echo (already answered elsewhere). */
export function isIterationAsk(text: string): boolean {
  return !FEEDBACK_BATCH_ECHO.test(text.trim());
}

/** The one dedupe unit of this seam: the ASK — the studio's message id when the frame carries
 *  one (a resend reuses it), else the bus event id (pure redelivery). Never the doc lifetime. */
export function chatKey(documentId: string, eventId: number, sourceMessageId?: string): string {
  return sourceMessageId !== undefined ? `${documentId}:m:${sourceMessageId}` : `${documentId}:e:${eventId}`;
}

/** Deterministic bus idempotency key for the one revision this seam may land per ask. */
export function chatIdempotencyKey(documentId: string, eventId: number, sourceMessageId?: string): string {
  return `crew:interactive.chat:${chatKey(documentId, eventId, sourceMessageId)}`;
}

/** What the versions.json read yields — enough to gate (kind) and snapshot (head html path). */
export interface DocHead {
  kind: string;
  head: number;
  /** Absolute path of the head version's html artifact. */
  headHtmlPath: string;
}

/**
 * Read a doc workspace's manifest (interactive's `versions.json`, fsstore.js shape) and resolve
 * its head html path. `null` when the doc does not exist under this root or the manifest is
 * unreadable — not ours to answer, per contract (b). Follows interactive's own tolerant read:
 * `kind` defaults to `"doc"` when absent (listDocs does the same) — and ABSENT is what a real
 * source doc looks like on disk (interactive records kind only for demo docs), so the caller
 * gates through {@link isAnswerableDocKind}, never a `=== 'source'` comparison.
 */
export function readDocHead(docsRoot: string, documentId: string): DocHead | null {
  if (!DOC_NAME.test(documentId)) return null;
  const dir = join(docsRoot, documentId);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as {
      kind?: unknown;
      head?: unknown;
      versions?: Array<{ version?: unknown; html_file?: unknown }>;
    };
    const head = manifest.head;
    if (typeof head !== 'number' || !Number.isInteger(head) || head < 0) return null;
    const entry = Array.isArray(manifest.versions)
      ? manifest.versions.find((v) => v?.version === head)
      : undefined;
    // Containment (Copilot, #310): `html_file` comes from a manifest on disk — a corrupted or
    // hostile value carrying path separators or `..` must never escape the doc dir. Only a plain
    // basename is accepted; anything else falls back to the version's canonical spelling.
    const rawHtmlFile =
      typeof entry?.html_file === 'string' && entry.html_file.length > 0
        ? entry.html_file
        : `_v${head}.html`;
    const htmlFile =
      basename(rawHtmlFile) === rawHtmlFile && !rawHtmlFile.includes('..')
        ? rawHtmlFile
        : `_v${head}.html`;
    return {
      kind: typeof manifest.kind === 'string' && manifest.kind.length > 0 ? manifest.kind : 'doc',
      head,
      headHtmlPath: join(dir, htmlFile),
    };
  } catch {
    return null;
  }
}

/**
 * Contract (b)'s kind half: `true` when a doc of this manifest kind is this seam's to answer.
 * `source` is the spec's spelling (recorded by no released interactive yet, accepted for the
 * day a manifest carries it); `doc` is the absent-default every REAL source (and plain html)
 * doc reads as — interactive's initManifest keeps non-demo kinds implicit. Explicit foreign
 * kinds (`demo`, anything future) belong to their own loops.
 */
export function isAnswerableDocKind(kind: string): boolean {
  return kind === 'source' || kind === 'doc';
}

/**
 * The run's problem statement (the engine scopes it per phase and folds each phase's
 * instructions on top). Carries everything ask-specific: identity, the flattened ask, the
 * CURRENT-version snapshot to read, and the absolute path the revised HTML must land at.
 */
export function chatProblem(ask: ChatAsk, currentPath: string, outPath: string): string {
  return (
    `Revise the wicked-interactive document "${ask.documentId}" per the user's ask. ` +
    `The user's ask: ${oneLine(ask.text, 2000)} ` +
    `The document's CURRENT version is the HTML file at this absolute path — read it first: ${currentPath} ` +
    `The revised COMPLETE document MUST be written to exactly this absolute file path: ${outPath}`
  );
}

// ── The subscriber ────────────────────────────────────────────────────────────────────────────

/** Options for {@link startInteractiveChatSubscriber}. */
export interface InteractiveChatOptions {
  /** Bus SQLite db path. Omit to let wicked-bus resolve its own default
   *  (honors `WICKED_BUS_DATA_DIR`) — where interactive's service emits unless redirected. */
  dbPath?: string;
  /** Poll cadence, ms (default 2000; tests shorten it). */
  pollIntervalMs?: number;
  /** Heartbeat narration cadence while a run is in flight, ms (default 15000 — inside the
   *  UI's ~20s `status.requested` window so the canvas never reads frozen; the studio's own
   *  90s silence budget makes the FIRST pickup narration the load-bearing one). */
  heartbeatMs?: number;
  /** Ledger file (default `~/.wicked-crew/interactive-chat-ledger.json`). */
  ledgerPath?: string;
  /** Where head snapshots land and workers write revised documents
   *  (default `~/.wicked-crew/interactive-chats`). */
  chatDir?: string;
  /** Seat roster JSON for the governed run (default: the production council roster).
   *  The functional-test harness passes a deterministic stub seat here. */
  clisJson?: string;
  /** The docs root an ask's doc is read from. Default: the shared-default resolution
   *  (`WICKED_INTERACTIVE_ROOT` › `~/wicked-interactive/docs`); the server wires the
   *  per-project `interactiveRoot` setting through here so a project on its own root
   *  resolves correctly. */
  resolveDocsRoot?: (projectId: string | undefined) => string;
  /** Contract (c)'s cross-seam half: `true` while a DRAFT or EDIT run is in flight for the
   *  doc. The server wires the sibling subscriptions' in-flight sets through here; the chat
   *  seam's own in-flight runs are tracked internally. */
  isDocBusy?: (documentId: string) => boolean;
  /** Queue-drain sweep cadence, ms (default 1000; tests shorten it). */
  queueSweepMs?: number;
  /** How long a drained ask waits for the PREVIOUS revision's version to land before
   *  proceeding on the stale head anyway, ms (default 60000; tests shorten it). */
  landingGateMs?: number;
  /** Called after a launch that FILED the run into a project (chat.posted carried
   *  `project_id`). Same wiring as the sibling seams: the server points this at the launch
   *  route's post-commit half (membership index tag + membership.attached emit). */
  onRunFiled?: (runId: string, projectId: string) => void;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface InteractiveChatSubscription {
  stop(): Promise<void> | void;
  /** The durable ledger (diagnostics / tests). */
  ledger: InteractiveHandoffLedger;
  /** Documents with a chat run currently in flight (diagnostics / cross-seam wiring). */
  inFlightDocs(): string[];
  /** Asks queued behind a busy doc, per doc (diagnostics / tests). */
  queuedCount(documentId: string): number;
}

interface InFlight {
  key: string;
  documentId: string;
  outPath: string;
  /** The manifest head the launch snapshotted — the landing gate's baseline. */
  headAtLaunch: number;
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  heartbeat: ReturnType<typeof setInterval>;
}

/** One ask parked behind a busy doc (contract (c): FIFO per doc). In-memory on purpose: the
 *  bus cursor has already advanced, so a daemon restart drops the parked tail — the thread
 *  shows the queued narration and the user resends; a durable queue is not this slice. */
interface QueuedAsk {
  key: string;
  ask: ChatAsk;
  eventId: number;
}

/** A successful revision's landing gate: hold the doc's queue until the manifest head passes
 *  `minHead` (the service landed our version) or `until` passes (the service is not landing —
 *  proceed on what is there rather than stranding the queue). */
interface LandingGate {
  minHead: number;
  until: number;
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
 * Arm the seam: register the `interactive-chat` workflow, open a durable
 * `wicked.interactive.chat.posted` subscription, and answer each user ask on an existing
 * answerable doc (contract (b)) with a governed run that ends in `wicked.interactive.draft.completed`
 * (the service lands the revised full HTML as a generated version).
 *
 * Graceful degradation mirrors the sibling seams: a missing wicked-bus package or an
 * unopenable db LOGS and returns `null` — the daemon must still boot on a machine whose bus
 * is broken.
 */
export async function startInteractiveChatSubscriber(
  adapter: CoreAdapter,
  opts: InteractiveChatOptions = {},
): Promise<InteractiveChatSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[interactive-chat] wicked-bus is not importable — governed iteration disabled: ${
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
      `[interactive-chat] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — governed iteration disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // The workflow rides the normal registration path — core validates the def BEFORE it is
  // persisted/hot-registered (FINDING-002 ordering), so a drifted def fails the arm loudly
  // instead of failing the first launch obscurely.
  try {
    await adapter.registerWorkflow(INTERACTIVE_CHAT_WORKFLOW_DEF);
  } catch (err) {
    log(
      `[interactive-chat] could not register the '${INTERACTIVE_CHAT_WORKFLOW}' workflow — ` +
        `governed iteration disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const ledger = new InteractiveHandoffLedger(
    opts.ledgerPath ?? join(defaultStateDir(), 'interactive-chat-ledger.json'),
  );
  const chatDir = opts.chatDir ?? join(defaultStateDir(), 'interactive-chats');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const landingGateMs = opts.landingGateMs ?? 60_000;
  const resolveDocsRoot = opts.resolveDocsRoot ?? (() => resolveInteractiveRoot(null));
  const phaseCount = INTERACTIVE_CHAT_WORKFLOW_DEF.phases.length;
  const inFlight = new Map<string, InFlight>(); // runId → live state
  const queues = new Map<string, QueuedAsk[]>(); // documentId → parked asks, FIFO
  const landingGates = new Map<string, LandingGate>(); // documentId → post-completion gate

  /** Emit onto interactive's vocabulary as the `wi-crew` producer. Never throws into the
   *  caller: narration/announce failures are logged — a lost status line must not kill the
   *  subscription, and a duplicate announce (WB-002) is the idempotency key WORKING. */
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
        `[interactive-chat] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
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

  function docHasFlight(documentId: string): boolean {
    for (const f of inFlight.values()) {
      if (f.documentId === documentId) return true;
    }
    return false;
  }

  /** Contract (c): the doc is busy while ANY governed run is working it — our own chat runs
   *  plus whatever the sibling draft/edit seams report through `isDocBusy`. */
  function docBusy(documentId: string): boolean {
    return docHasFlight(documentId) || opts.isDocBusy?.(documentId) === true;
  }

  /** Terminal-event fold: turn the governed run's own events into interactive narration, and
   *  close the loop with `draft.completed` when the run lands. */
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;

    // Narration ladder — same rationale as the draft fold: the heartbeat repeats the LATEST
    // line and the transcript dedups repeats, so advancing the line = visible progress.
    const phaseName = (ord: number): string =>
      INTERACTIVE_CHAT_WORKFLOW_DEF.phases[ord - 1]?.id ?? `phase ${ord}`;

    if (event.type === 'councilConvened') {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(
        flight,
        `Convening ${council} to pick who ${ord >= phaseCount ? 'revises the document' : 'reads your ask'}…`,
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
          ? `Crew phase ${ord}/${phaseCount}: revising the document (${phase})…`
          : `Crew phase ${ord}/${phaseCount}: ${phase} — reading the current version and your ask…`,
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
          ? 'Gate approved the revision — landing it now…'
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
      drainDoc(flight.documentId);
      return;
    }

    if (event.type === 'sessionFailed' || event.type === 'runCancelled') {
      endFlight(runId);
      ledger.recordFailure(flight.key);
      emitInteractive(STATUS_POSTED, {
        document_id: flight.documentId,
        state: 'error',
        message:
          `The crew run answering your ask ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}). Inspect it via the crew API (GET /api/v1/runs/${runId}), then resend the message.`,
      });
      log(`[interactive-chat] run ${runId} for ask ${flight.key} ended: ${event.type}`);
      // No landing gate on failure — nothing new is landing; the next queued ask (if any)
      // proceeds on the head that is there.
      drainDoc(flight.documentId);
    }
  });

  function finalize(flight: InFlight, runId: string): void {
    const { key, documentId, outPath } = flight;
    let ok = false;
    try {
      ok = existsSync(outPath) && statSync(outPath).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      ledger.recordFailure(key);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'error',
        message: `The crew run completed but produced no revised document at ${outPath} (run ${runId}). Resend the message to retry.`,
      });
      log(`[interactive-chat] run ${runId} completed but ${outPath} is missing/empty`);
      return;
    }
    // Announce on the SAME wire the first draft rides (ADR-0019 D5: by path — the service
    // reads the file and lands it as a generated version). The deterministic per-ask key
    // makes a re-announce a WB-002 no-op.
    const emitted = emitInteractive(
      DRAFT_COMPLETED,
      { document_id: documentId, html_path: outPath },
      `crew:interactive.chat:${key}`,
    );
    if (!emitted) {
      // The bus refused the announce (non-WB-002): the revision exists on disk but never
      // reached the service. Fail HONEST — leaving the row launched-but-never-closed would
      // silently eat a redelivery of this ask (the launch gate is `ledger.has`).
      ledger.recordFailure(key);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'error',
        message:
          `Crew finished the revision but could not announce it on the bus (run ${runId}); ` +
          `the file is at ${outPath}. Inspect the crew daemon log, then resend the message.`,
      });
      log(`[interactive-chat] draft.completed emit FAILED for ask ${key} (run ${runId}) — recorded as failure`);
      return;
    }
    ledger.recordEmitted(key);
    // The landing gate (see module header): the SERVICE lands the announced file as a new
    // version asynchronously — a queued ask drained right now would snapshot the pre-revision
    // head and silently drop the revision that just finished. Hold this doc's queue until the
    // manifest head advances past what this run launched from, or the timeout passes.
    landingGates.set(documentId, {
      minHead: flight.headAtLaunch + 1,
      until: Date.now() + landingGateMs,
    });
    emitInteractive(STATUS_POSTED, {
      document_id: documentId,
      state: 'complete',
      message: 'Revision is in — landing the new version on the canvas now.',
    });
    log(`[interactive-chat] draft.completed emitted for ask ${key} (run ${runId})`);
  }

  /** Launch the governed run for one ask. The head snapshot happens HERE — launch time, not
   *  parse time — so a queued ask iterates on the version its predecessor landed. Throws on
   *  launch failure (the caller decides: dead-letter for a live delivery, log for a drain). */
  async function launchAsk(queued: QueuedAsk): Promise<void> {
    const { ask, key } = queued;
    const docsRoot = resolveDocsRoot(ask.projectId);
    const doc = readDocHead(docsRoot, ask.documentId);
    if (doc === null || !isAnswerableDocKind(doc.kind)) {
      // The doc moved out from under a parked ask (deleted / never ours). Not an error the
      // thread needs — contract (b) simply stopped holding.
      log(
        `[interactive-chat] ask ${key} dropped at launch: doc ${ask.documentId} ${
          doc === null ? 'not found' : `has kind '${doc.kind}'`
        } under ${docsRoot}`,
      );
      return;
    }
    let headOk = false;
    try {
      headOk = existsSync(doc.headHtmlPath) && statSync(doc.headHtmlPath).size > 0;
    } catch {
      headOk = false;
    }
    if (!headOk) {
      emitInteractive(STATUS_POSTED, {
        document_id: ask.documentId,
        state: 'error',
        message: `Crew could not read the document's current version (missing ${doc.headHtmlPath}) — the ask was not answered.`,
      });
      log(`[interactive-chat] ask ${key}: head html ${doc.headHtmlPath} is missing/empty`);
      return;
    }

    mkdirSync(chatDir, { recursive: true });
    // Both files live under the ONE declared write root: the worker reads the snapshot and
    // writes the deliverable without ever touching the doc workspace (crew#263 shape; write
    // roots are readable, wicked-core#259). Names derive from the validated slug + our own
    // key grammar — never from free bus text.
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '-');
    const currentPath = join(chatDir, `${safeKey}-current.html`);
    const outPath = join(chatDir, `${safeKey}-revised.html`);
    copyFileSync(doc.headHtmlPath, currentPath);
    const runId = randomUUID();

    // The studio's 90s silence budget: this pickup line is what keeps the thread honest, so
    // it fires BEFORE the launch resolves.
    emitInteractive(STATUS_POSTED, {
      document_id: ask.documentId,
      state: 'processing',
      message: 'A governed crew picked up your ask — revising the document…',
    });

    try {
      await adapter.launchRun({
        problem: chatProblem(ask, currentPath, outPath),
        sessionId: runId,
        clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter)),
        workflow: INTERACTIVE_CHAT_WORKFLOW,
        // A project-bound doc's governed revision is FILED (same contract as the sibling
        // seams); an unbound doc launches with the key OMITTED — an unfiled governed run,
        // never a fabricated 'default' membership.
        ...(ask.projectId !== undefined ? { projectId: ask.projectId } : {}),
        extraWriteRoots: [chatDir],
      });
    } catch (err) {
      // The 'processing' status is already on the thread — close it out honestly so the
      // canvas never sits in an in-between state on a launch that went nowhere.
      const reason = err instanceof Error ? err.message : String(err);
      emitInteractive(STATUS_POSTED, {
        document_id: ask.documentId,
        state: 'error',
        message: `Crew could not start a run for your ask: ${reason}. Resend the message to retry.`,
      });
      // DELIBERATELY no ledger write: only an answered ask earns a row, so a replay of the
      // frame (live path: dead-letter + operator redrive) gets a real retry.
      throw err;
    }
    // Record AFTER the launch resolved: a failed launch leaves no ledger row, so a replayed
    // delivery retries. The crash window between launch and this write is the reason the
    // announce ALSO carries a deterministic idempotency key.
    ledger.recordLaunch(key, runId);
    if (ask.projectId !== undefined) opts.onRunFiled?.(runId, ask.projectId);

    const flight: InFlight = {
      key,
      documentId: ask.documentId,
      outPath,
      headAtLaunch: doc.head,
      narration: 'Crew run launched — working on your revision…',
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
    log(`[interactive-chat] ask ${key} → governed run ${runId} (v${doc.head} → ${outPath})`);
  }

  /** `true` when the doc's landing gate (if any) still holds its queue shut. A satisfied or
   *  expired gate is removed. `projectId` (when the caller has an ask in hand) beats the
   *  queue-head lookup — an empty queue must still resolve the right per-project root. */
  function gateHolds(documentId: string, projectId?: string): boolean {
    const gate = landingGates.get(documentId);
    if (gate === undefined) return false;
    if (Date.now() > gate.until) {
      landingGates.delete(documentId);
      log(`[interactive-chat] landing gate for ${documentId} timed out — draining on the current head`);
      return false;
    }
    // Resolve the root through the ask at hand, else the FIRST queued ask (all asks on one
    // doc resolve the same way).
    const next = queues.get(documentId)?.[0];
    const docsRoot = resolveDocsRoot(projectId ?? next?.ask.projectId);
    const doc = readDocHead(docsRoot, documentId);
    if (doc !== null && doc.head >= gate.minHead) {
      landingGates.delete(documentId);
      return false;
    }
    return true;
  }

  /** Drain one doc's queue head if nothing holds it (busy run, landing gate). Fire-and-forget:
   *  a drain-time launch failure is narrated + logged, never thrown (there is no live bus
   *  frame left to dead-letter). */
  function drainDoc(documentId: string): void {
    const queue = queues.get(documentId);
    if (queue === undefined || queue.length === 0) {
      queues.delete(documentId);
      return;
    }
    if (docBusy(documentId) || gateHolds(documentId)) return;
    const next = queue.shift()!;
    if (queue.length === 0) queues.delete(documentId);
    void launchAsk(next).catch((err) => {
      log(
        `[interactive-chat] drained ask ${next.key} failed to launch: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // The failed drain must not strand the rest of the queue.
      drainDoc(documentId);
    });
  }

  // The sweep: foreign runs (draft/edit seams) and landing gates clear OUTSIDE our event flow,
  // so a timer retries parked queues. Unref'd — parked asks never keep the daemon alive.
  // Expired landing gates are reaped here too (Copilot, #310): gateHolds() only removes a
  // gate when a queued ask drains, so a doc revised once and never asked again would hold
  // its entry forever — the map must stay bounded by each gate's own timeout.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [documentId, gate] of landingGates) {
      if (now > gate.until && (queues.get(documentId)?.length ?? 0) === 0) {
        landingGates.delete(documentId);
      }
    }
    for (const documentId of [...queues.keys()]) drainDoc(documentId);
  }, opts.queueSweepMs ?? 1000);
  sweep.unref?.();

  async function handleChatPosted(event: BusEvent): Promise<void> {
    const ask = parseChatPosted(event.event_type, event.payload);
    if (ask === null) return;
    // Contract (d): the feedback overlay's batch echo is transcript fidelity, not an ask —
    // its document work already rides feedback.submitted (deterministic apply / edit seam).
    if (!isIterationAsk(ask.text)) {
      log(`[interactive-chat] chat.posted on ${ask.documentId} is a feedback-batch echo — not this seam's`);
      return;
    }
    const key = chatKey(ask.documentId, event.event_id, ask.sourceMessageId);

    // Replay-dedup: the ledger is the durable gate (redelivery after crash/restart, and a
    // studio resend that reused its message id), the in-flight/queue scan the live one.
    if (ledger.has(key)) {
      log(`[interactive-chat] ask ${key} already answered (run ${ledger.get(key)?.runId}) — replay ignored`);
      return;
    }
    for (const f of inFlight.values()) {
      if (f.key === key) return;
    }
    for (const q of queues.values()) {
      if (q.some((entry) => entry.key === key)) return;
    }

    // Contract (b): the doc must exist under the resolved root with an answerable kind. Checked at
    // DELIVERY so a demo doc's chat or an unknown doc never even parks; re-checked at launch
    // (the snapshot read) because a parked ask can outlive its doc.
    const docsRoot = resolveDocsRoot(ask.projectId);
    const doc = readDocHead(docsRoot, ask.documentId);
    if (doc === null) {
      log(`[interactive-chat] chat.posted for unknown doc ${ask.documentId} under ${docsRoot} — ignored`);
      return;
    }
    if (!isAnswerableDocKind(doc.kind)) {
      log(
        `[interactive-chat] doc ${ask.documentId} has kind '${doc.kind}' — demo (and other foreign-kind) docs are not this seam's to answer`,
      );
      return;
    }

    const queued: QueuedAsk = { key, ask, eventId: event.event_id };

    // Contract (c): per-doc serialization, FIFO. A busy doc parks the ask — with an IMMEDIATE
    // narration so the thread never sits silent inside the studio's 90s budget.
    if (docBusy(ask.documentId) || gateHolds(ask.documentId, ask.projectId) || queues.has(ask.documentId)) {
      const queue = queues.get(ask.documentId) ?? [];
      queue.push(queued);
      queues.set(ask.documentId, queue);
      emitInteractive(STATUS_POSTED, {
        document_id: ask.documentId,
        state: 'processing',
        message:
          'Crew has your ask — a run is already working this document, so it is queued and will start as soon as the current work lands.',
      });
      log(`[interactive-chat] ask ${key} queued behind busy doc ${ask.documentId} (${queue.length} waiting)`);
      return;
    }

    // Re-throwing a launch failure lets the bus (maxRetries 0) dead-letter the frame —
    // visible, replayable, incapable of hot-looping.
    await launchAsk(queued);
  }

  const sub = bus.subscribe({
    db,
    plugin: INTERACTIVE_CHAT_BUS_PLUGIN,
    filter: INTERACTIVE_CHAT_BUS_FILTER,
    // Live triggers only: replaying a bus backlog would answer asks whose moment has passed.
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    // Our own ledger + idempotency key are the dedupe; a bus-level retry of a failed launch
    // would double-launch precisely because the ledger row is only written on success.
    maxRetries: 0,
    handler: (event: BusEvent) => handleChatPosted(event),
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[interactive-chat] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      );
    },
  });

  return {
    ledger,
    inFlightDocs: () => [...new Set([...inFlight.values()].map((f) => f.documentId))],
    queuedCount: (documentId: string) => queues.get(documentId)?.length ?? 0,
    stop: async () => {
      offCoreEvents();
      clearInterval(sweep);
      for (const runId of [...inFlight.keys()]) endFlight(runId);
      queues.clear();
      await sub.stop();
    },
  };
}
