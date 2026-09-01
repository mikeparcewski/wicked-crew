/**
 * Opt-in governed answering of wicked-interactive's DEMO docs (CREW-UX-9 — the fourth
 * interactive leg, beside draft-events.ts, edit-events.ts, and chat-events.ts).
 *
 * wicked-interactive's demo pipeline (ADR-0018) is deliberately split: the SERVICE is the
 * model-free recorder — `recordDemo` (src/service/demo.js) launches Chromium, executes the
 * doc's `demo.spec.mjs` with Playwright, records video + storyboard, and lands the version —
 * while *something with intelligence* must AUTHOR that spec. A demo doc's creation emits
 * `wicked.interactive.doc.created` with `kind: "demo"` carrying the live target `url` and an
 * optional `brief` (recon: server.js `POST /api/docs`, the isDemo branch), and the doc then
 * sits on its "Learning <url>…" placeholder until someone writes `<docDir>/demo.spec.mjs` and
 * emits `wicked.interactive.demo.requested` — the retired assist agent's Step 8 (assist skill
 * SKILL.md). Since the assist session retired, NOTHING authored the spec: video generation had
 * hands (the recorder is proven working) but no brain. This module makes a crew-governed run
 * the answerer.
 *
 * Shape mirrors draft-events.ts (dynamic wicked-bus import, graceful degradation, durable
 * cursor `cursor_init: 'latest'` under a dedicated plugin name, durable replay-dedup ledger,
 * `wi-crew` narration via status.posted, heartbeat inside the UI's ~20s window). The
 * demo-specific deltas:
 *
 *  - THE DELIVERABLE IS A SPEC, NOT HTML. The worker authors `demo.spec.mjs` — a plain ES
 *    module exporting `meta` ({url, title, and optionally steps/captions/captionHoldMs}) and
 *    `async run({ page, step, meta })` wrapping every meaningful action in
 *    `step(label, fn, { say, holdMs })` — the exact contract `recordDemo` executes (recon:
 *    interactive's demo.js + assist SKILL.md Step 8a). Crew never records anything; the
 *    BRIDGE (interactive's service) owns Playwright + ffmpeg, and the storyboard version it
 *    lands is the proven, already-working half of the loop.
 *
 *  - THE WRITE-BOUNDARY LESSON (wicked-core#293/#294, learned the hard way on the draft leg):
 *    the governed worker CANNOT write into the doc workspace and CANNOT be repo-bound. A
 *    repoRef-bound run's tool-permission stream closes on the first prompt-needing call
 *    (wicked-core#293), and an UNBOUND worker's governance boundary is {sandbox,
 *    extraWriteRoots, ~/.claude/plugins} — reads/writes of the live doc workspace are DENIED
 *    (wicked-core#294). So the launch is UNBOUND with the per-run inbox as the SOLE extra
 *    write root; the task names `<inbox>/demo.spec.mjs` as the deliverable and carries the
 *    url + brief in the (PTY-capped, single-line) problem text. At finalize CREW copies the
 *    spec into the doc workspace — crew's own process is not the worker and is bound by no
 *    run boundary — THEN emits `demo.requested`, then narrates complete. Copy-then-emit,
 *    strictly: an emit before the copy would have the service record a missing/stale spec.
 *
 *  - EMIT ACCEPTANCE (recon): interactive's command loop consumes `demo.requested` into
 *    `materializeDemo` and drops ONLY frames produced by itself (`producer_id ===
 *    PRODUCERS.SERVICE`, server.js runCommand loop) — the events.js ownership table
 *    ([UI, AGENT] for demo.requested) is enforced on interactive's own emit paths, not at
 *    consume — so a `wi-crew`-produced demo.requested is executed. The additive CREW owner
 *    row in interactive's events.js is the same follow-up courtesy the draft/edit legs got.
 *
 *  - THE STEP-FEEDBACK LOOP (assist SKILL.md Step 8c): a demo refines by RE-AUTHORING the
 *    spec and re-emitting demo.requested — never by editing storyboard HTML. When the user
 *    highlights a storyboard step and asks for a change, the service applies the deterministic
 *    remainder to the storyboard and hands the structural items off on
 *    `wicked.interactive.feedback.processed` — the SAME frame the edit seam answers. That
 *    frame carries no `kind`, and until CREW-UX-9 the edit seam answered demo docs' handoffs
 *    too: it rewrote the storyboard FRAGMENT (chapter list text), landed it as a structural
 *    version, and the recording + spec never changed — the user's "change the demo" died as a
 *    cosmetic caption edit the next re-record would overwrite. Now both seams gate on the SAME
 *    disk truth (the doc manifest's `kind`, readable because interactive records kind for demo
 *    docs — chat-events.ts readDocHead): manifest says `demo` → THIS seam re-authors the spec
 *    per the feedback items, copies, re-emits demo.requested; anything else (including an
 *    unreadable manifest) → the edit seam keeps it. One reader each way = no double-answer.
 *    The edit seam's skip is conditional on THIS seam actually being armed (it is handed a
 *    `demoSeamArmed` probe): with the demo seam off, a demo doc's handoff would otherwise be
 *    answered by nobody, silently — so the edit seam posts an honest error status instead.
 *
 *  - THE PHASE SHAPE IS MEASURED, NOT CHOSEN (wicked-core#293). A tool-using turn poisons a
 *    later tool-permission request, which is never answered; the worker's turn then ends where
 *    it stood. The rule that survives on real seats: THE PHASE THAT INSPECTS THE APP MUST BE
 *    THE PHASE THAT WRITES THE SPEC, and nothing before it may touch a tool. So the first-spec
 *    workflow is a TOOL-FREE planning phase then an inspect-and-write phase, and the re-author
 *    workflow is one local-files-only writing phase. Both the "let recon look at the app" and
 *    the "collapse it all into one phase" shapes were run against a real seat and died. The
 *    numbers and the failure signatures are on INTERACTIVE_DEMO_WORKFLOW_DEF — read them
 *    before reshaping either def.
 */

import { resolveProjectGraphBinding, type ProjectGraphBinding } from '../projects/graph.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BusEvent } from 'wicked-bus';
import {
  DOC_CREATED,
  DOC_NAME,
  INTERACTIVE_DOMAIN,
  INTERACTIVE_PRODUCER,
  STATUS_POSTED,
  oneLine,
} from './draft-events.js';
import {
  FEEDBACK_PROCESSED,
  handoffKey,
  parseStructuralFeedback,
  type StructuralHandoff,
} from './edit-events.js';
import { readDocHead } from './chat-events.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import { InteractiveHandoffLedger } from './ledger.js';
import { crewStateHome } from '../projects/state-home.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent, WorkflowDef } from '../core/types.js';

// ── Vocabulary constants (interactive's, verbatim — src/service/events.js is the truth) ──────

export const DEMO_REQUESTED = 'wicked.interactive.demo.requested';

/** Exact-type filters with a domain guard — no wildcards. The seam listens on TWO topics:
 *  doc.created (kind:demo — author the first spec) and feedback.processed (demo-kind docs —
 *  re-author it). */
export const INTERACTIVE_DEMO_BUS_FILTER = `${DOC_CREATED}@${INTERACTIVE_DOMAIN}`;
export const INTERACTIVE_DEMO_FEEDBACK_BUS_FILTER = `${FEEDBACK_PROCESSED}@${INTERACTIVE_DOMAIN}`;

/** Dedicated durable-cursor identities — NOT the draft/edit/chat seams', so every interactive
 *  seam advances an independent cursor and stopping one never strands another. The two demo
 *  subscriptions get their own cursors too: they filter different types. */
export const INTERACTIVE_DEMO_BUS_PLUGIN = 'wicked-crew-interactive-demo';
export const INTERACTIVE_DEMO_FEEDBACK_BUS_PLUGIN = 'wicked-crew-interactive-demo-feedback';

/** The one file the whole demo pipeline pivots on (interactive demo.js `DEMO_SPEC`):
 *  `recordDemo` refuses to record until `<docDir>/demo.spec.mjs` exists. */
export const DEMO_SPEC_FILE = 'demo.spec.mjs';

// ── The workflows (workflows-as-data) ─────────────────────────────────────────────────────────

export const INTERACTIVE_DEMO_WORKFLOW = 'interactive-demo';
export const INTERACTIVE_DEMO_REAUTHOR_WORKFLOW = 'interactive-demo-reauthor';

/**
 * The governed workflow that authors a demo's FIRST spec. TWO agent phases — `scenes` (recon,
 * neutral: plan from the brief and the URL string, TOUCHING NOTHING) then `spec` (build,
 * creator: inspect the live app, write the Playwright spec, report).
 *
 * THE PHASE SPLIT IS LOAD-BEARING AND MEASURED — do not "simplify" it in either direction.
 * wicked-core#293: A TOOL-USING TURN POISONS A LATER TOOL-PERMISSION REQUEST — the request is
 * never answered, so the worker's turn ends where it stood. Three shapes have been run against
 * a real seat on a real stack (adversarial + build verification, 2026-08-24), and only one
 * survives:
 *
 *   1. recon phase that INSPECTS THE APP, then a spec phase — DEAD 4/4. The recon turn fetches
 *      the target, and the spec phase's first permission request goes unanswered; nothing is
 *      ever written.
 *   2. recon phase forbidden from using ANY TOOL, then a spec phase that curls the app and
 *      writes — GREEN 15/15 end-to-end: spec authored, installed, a 436KB webm recorded, the
 *      storyboard landed, `version.created kind:demo` on the bus. THIS IS THE SHAPE BELOW.
 *   3. ONE phase doing inspect + plan + write together (the obvious "no next turn to poison"
 *      simplification) — DEAD 3/3, and this is the counter-intuitive result worth writing down:
 *      the worker curls the pages, narrates "now writing the spec", and the turn ends AT the
 *      write. Two runs died with an empty inbox and 161-345 byte outputs (one rejected by the
 *      substance floor as `substanceRejected`, one "completed" with no deliverable and caught
 *      by finalize). Collapsing the phases does NOT dodge #293 — it just moves the unanswered
 *      permission request from the next turn into this one.
 *
 * A fourth data point narrows what "tool use" means here: the re-author leg's single phase
 * does `Read` + `Read` + `Write` in one turn and lands green (7/7, run 0704b910 — revised spec
 * installed, v2 re-recorded). So a turn that reads LOCAL FILES and then writes is fine; it is
 * the NETWORK fetch that costs the following write, whether that write is in the next turn
 * (shape 1) or the same one (shape 3). Treat that as the observed discriminator, not a proven
 * mechanism — #293 is wicked-core's to diagnose; this def only has to survive it.
 *
 * So the rule this workflow encodes is narrower than "one phase": THE PHASE THAT INSPECTS THE
 * APP MUST BE THE PHASE THAT WRITES THE DELIVERABLE, and nothing before it may touch a tool.
 * Phase 1 therefore plans from the brief and the URL STRING alone and is told so explicitly (a
 * soft constraint, and the model has broken a weaker one — the shipped wording said only "do
 * not write any files" and the worker fetched the app anyway — so the prohibition names tools
 * outright and says what it protects).
 *
 * The phase `instructions` adapt the demo-authoring contract from interactive's assist skill
 * (Step 8a/8b) and demo.js `recordDemo`'s executable contract: ESM exporting `meta` + `async
 * run({page, step, meta})`, every meaningful action wrapped in `step(label, fn, {say,
 * holdMs})`, capability narration, stable selectors, awaited waits, and NEVER credentials in
 * the file. SINGLE-LINE by contract (PTY seat runner, wicked-core FINDING-011).
 *
 * THE SUBSTANCE FLOOR (wicked-core `actor.rs`, "phase produced no reviewable substance"): a
 * governed creator/neutral phase whose fold carries neither a worktree diff nor >=200 trimmed
 * chars of prose is REJECTED and fails the run. These runs are UNBOUND — `workdir: null`, so
 * there is never a worktree diff by construction — and the deliverable is a FILE in the inbox,
 * invisible to that check. A worker told only to "end your reply with the absolute path" answers
 * in ~50 bytes and the whole demo dies at the gate (observed 3/3 on the real stack before this
 * wording). So both workflows' build phases demand a prose report of what they wrote: the
 * phase's own reviewable substance, not decoration.
 *
 * All gates are `auto` with `validator_pin: null` — no human gate — because the acceptance
 * gate for a demo is the RECORDING itself: the service executes the spec (a broken selector
 * fails the record with a step-precise error status) and the user judges the video on the
 * storyboard, then refines through the same loop. The assist skill's interactive scene-plan
 * confirmation (Step 8a.5) was an editorial affordance of a conversational session; the
 * governed loop's editorial channel is the step-feedback path below.
 */
export const INTERACTIVE_DEMO_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_DEMO_WORKFLOW,
  is_system: true,
  phases: [
    {
      id: 'scenes',
      kind: 'recon',
      instructions:
        'Plan the demo — and in this phase USE NO TOOLS AT ALL: no web fetch, no shell, no file reads, no writes. Work from the task text alone (the target application URL and the user\'s brief); inspecting the app is the NEXT phase\'s job, and a tool use here breaks that phase\'s ability to write the spec, which kills the whole demo. Decompose the brief into 3-6 named scenes — each a short capability label stating what the viewer should take away (good: "Create a document"; bad: "Click the New button"), covering setup/context beats, the main value moments, and the payoff. Merge trivial setup steps, split compound flows — a demo that is one scene for a multi-step brief is not a demo. For each scene note the click-path you EXPECT (navigation, the kind of control to look for, waits) and a one-sentence narration line that states the capability, not the on-screen data; say plainly that the selectors are expectations for the next phase to confirm against the live page. Never invent app features the brief and the URL do not support. Output the scene plan as plain text.',
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
      id: 'spec',
      kind: 'build',
      instructions:
        'FIRST inspect the live target application yourself: curl the HTML of the URL named in the task and of every further page the scene plan visits (use curl — the target is often a plain-HTTP or localhost app a web-fetch tool cannot reach), so every selector you use provably exists on the page; never guess a selector, and correct the scene plan wherever the real page contradicts it. THEN, using the scene plan from the prior phase, write the COMPLETE Playwright demo spec and SAVE it to the absolute output file named in the task (create parent directories if needed, overwrite if present) — the file on disk is the deliverable, so write it before you finish. THEN REPORT IN PROSE, in at least 120 words, what you inspected and what you wrote: name the pages you fetched and the selectors they gave you, walk the reader through every step in order (its label, the selectors and waits it uses, and the capability its narration states), call out any scene-plan beat you merged, split, or dropped and why, and end with the absolute path you wrote — a reply that is only the path is an unreviewable phase and will be rejected. Contract (wicked-interactive demo.spec.mjs): a plain, standalone ES module with NO imports that exports const meta = { url, title, and optionally steps, captions, captionHoldMs } and export async function run({ page, step, meta }) — the service supplies page (Playwright) and step; begin run() with await page.goto(meta.url); wrap EVERY meaningful action in await step(label, async () => { ... }, { say, holdMs }) with one step per scene and the scene\'s capability name as the label; narrate the meaningful beats via say (the capability, not the on-screen data); prefer stable selectors (roles, text, ids) and await your waits (waitForURL, waitForSelector) so the recording captures settled UI; NEVER write credentials or secrets into the spec — read them from process.env at run time.',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: ['scenes'],
      role: 'creator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
};

/**
 * The governed workflow that RE-authors a spec per step feedback (Step 8c). ONE agent phase —
 * `respec` (build, creator role) — the edit leg's rationale: the current spec and the user's
 * instructions are already extracted into files the task names, so a recon phase would only
 * burn a council turn re-reading what the build phase reads anyway.
 *
 * SAME v2 TREATMENT AS THE FIRST-SPEC WORKFLOW (wicked-core#293), which for this leg means
 * LEAVING IT ALONE and saying why. Nothing runs before the phase that writes, so no predecessor
 * turn can poison its permissions — and its own tool use is LOCAL FILE READS inside the run's
 * declared write root (the same shape as the interactive-edit workflow's single phase, which
 * reads a handoff JSON and writes fragments in one turn, in production, today). What this leg
 * must NOT grow is a live re-fetch of the app: the first-spec measurements above show a turn
 * that fetches the network and then writes losing the write outright (shape 3, dead 3/3),
 * while this leg's Read+Read+Write turn lands green (7/7 on a real seat, run 0704b910). If a
 * feedback item ever genuinely needs a selector the current spec lacks, the fix is a preceding
 * TOOL-FREE phase plus inspection moved into this one — the shape 2 arrangement — not a fetch
 * bolted onto the writing turn.
 */
export const INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF: WorkflowDef = {
  id: INTERACTIVE_DEMO_REAUTHOR_WORKFLOW,
  is_system: true,
  phases: [
    {
      id: 'respec',
      kind: 'build',
      instructions:
        'Read the current demo spec and the feedback JSON named in the task; re-author the spec so the recorded demo fulfils every feedback item, and SAVE the complete revised spec to the exact absolute output file named in the task (create parent directories if needed, overwrite if present) — the file on disk is the deliverable, so write it before you finish. Work from the two files and the current spec\'s own selectors — do NOT fetch the live application in this phase; if a feedback item needs a control the current spec never touches, choose the most robust selector the item\'s storyboard fragment supports and say so in your report rather than guessing silently. THEN REPORT IN PROSE, in at least 120 words, what changed: take each feedback item in turn, say which step(s) you altered and how the revised selectors/waits/narration answer it, note anything you deliberately left untouched, and end with the absolute path you wrote — a reply that is only the path is an unreviewable phase and will be rejected. Each feedback item carries the user\'s instruction plus the storyboard fragment of the step it targets (the step\'s label appears in the fragment text) — change the matching step(s) and leave unrelated steps untouched unless the instruction asks for a restructure. Keep the same executable contract as the current spec: a plain, standalone ES module with NO imports exporting const meta = { url, title, ... } and export async function run({ page, step, meta }); begin run() with await page.goto(meta.url); wrap every meaningful action in await step(label, fn, { say, holdMs }); narrate capabilities via say; prefer stable selectors and await your waits; NEVER write credentials or secrets into the spec — read them from process.env at run time.',
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

/** The demo-creation fields this seam acts on. */
export interface DemoDocCreated {
  documentId: string;
  /** The live app URL the demo records against (server-validated http(s) at doc creation). */
  url: string;
  brief: string;
  /** Present when the doc is project-bound; absent = unfiled (first-class, DES-UX-001 slice U). */
  projectId?: string;
}

/** URL budget for the problem statement: the URL must ride VERBATIM (a respelled URL targets
 *  the wrong app), so an over-budget one refuses the parse rather than truncating. */
export const DEMO_URL_MAX = 1000;

/**
 * Parse a bus frame into a {@link DemoDocCreated}, or `null` when it is not an actionable
 * demo creation: wrong type, non-`demo` kind (source/html docs are the draft seam's and the
 * user's own business), missing/malformed document_id, or an unusable URL. The URL must be a
 * parseable http(s) URL with no whitespace/control characters — it rides the single-line PTY
 * problem verbatim (interactive's server validates this at creation, so a violation here is
 * producer drift, not a user path).
 */
export function parseDemoDocCreated(eventType: string, payload: unknown): DemoDocCreated | null {
  if (eventType !== DOC_CREATED) return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p['kind'] !== 'demo') return null;
  const documentId = typeof p['document_id'] === 'string' ? p['document_id'] : '';
  if (!DOC_NAME.test(documentId)) return null;
  const url = typeof p['url'] === 'string' ? p['url'].trim() : '';
  if (url.length === 0 || url.length > DEMO_URL_MAX || /[\s\u0000-\u001f]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const brief = typeof p['brief'] === 'string' ? p['brief'] : '';
  const projectId =
    typeof p['project_id'] === 'string' && p['project_id'].length > 0 ? p['project_id'] : undefined;
  return { documentId, url, brief, ...(projectId !== undefined ? { projectId } : {}) };
}

/**
 * The first-spec run's problem statement (the engine scopes it per phase and folds each
 * phase's instructions on top). Carries the doc identity, the target URL VERBATIM, the brief
 * (flattened + capped: PTY, wicked-core FINDING-011), and the absolute inbox path the spec
 * must land at. Deliberately NO doc-workspace path: the unbound worker could not read or
 * write it anyway (wicked-core#294) — crew installs the spec at finalize.
 */
export function demoProblem(doc: DemoDocCreated, outPath: string): string {
  const brief =
    doc.brief.trim().length > 0
      ? oneLine(doc.brief, 2000)
      : "(no brief provided — demonstrate the app's core flow)";
  return (
    `Author the Playwright demo spec for the wicked-interactive demo document "${doc.documentId}". ` +
    `Target application URL: ${doc.url} The user's brief: ${brief} ` +
    `The finished spec MUST be written to exactly this absolute file path: ${outPath}`
  );
}

/**
 * The re-author run's problem statement. Single-line; the bulky parts (the current spec, the
 * feedback fragments) ride in FILES inside the inbox — write roots are readable
 * (wicked-core#259) — so only identity, the capped instruction gist, and the three paths ride
 * here (the edit leg's handoff-by-file discipline).
 */
export function demoReauthorProblem(
  handoff: StructuralHandoff,
  currentSpecPath: string,
  feedbackPath: string,
  outPath: string,
): string {
  const gist = oneLine(
    handoff.items.map((i) => i.instruction).filter((s) => s.length > 0).join('; '),
    600,
  );
  return (
    `Re-author the Playwright demo spec for the wicked-interactive demo document ` +
    `"${handoff.documentId}" per the user's step feedback (${handoff.items.length} item(s) on ` +
    `version ${handoff.version}). The CURRENT spec is the file at this absolute path — read it ` +
    `first: ${currentSpecPath} The feedback items (instruction + the targeted storyboard step's ` +
    `HTML fragment, per item) are in the JSON file at: ${feedbackPath} ` +
    `The user asked: ${gist.length > 0 ? gist : '(no instruction text)'} ` +
    `The revised spec MUST be written to exactly this absolute file path: ${outPath}`
  );
}

/** Deterministic bus idempotency key for the FIRST record request this seam may trigger per
 *  document. Distinct from every re-author key: a demo legitimately re-records many times, so
 *  the record trigger must never dedupe across authoring generations. */
export function demoIdempotencyKey(documentId: string): string {
  return `crew:interactive.demo:${documentId}:spec`;
}

/** Deterministic bus idempotency key for the one re-record a given feedback handoff earns. */
export function demoReauthorIdempotencyKey(documentId: string, version: number): string {
  return `crew:interactive.demo:${documentId}:v${version}`;
}

/**
 * Deterministic pre-install self-check on the worker's spec (the demo leg's sibling of the
 * edit leg's INV-2 check): `recordDemo` imports the file and throws on a missing `run` export
 * (interactive demo.js), which would surface as a recording error AFTER crew claimed success.
 * Fail honest crew-side instead: a spec that plainly cannot satisfy the module contract is
 * never installed. Returns the human-readable violation, or `null` when the spec looks like a
 * real module. Deliberately shallow — a static check cannot execute the module, so it pins
 * only the export shape the contract mandates; a wrong-but-well-formed spec is the recording's
 * (and the user's) to judge, exactly like a wrong-but-anchor-safe edit on the edit leg.
 */
export function specSelfCheck(spec: string): string | null {
  if (spec.trim().length === 0) return 'the spec file is empty';
  const exportsMeta =
    /export\s+(const|let|var)\s+meta\b/.test(spec) || /export\s*\{[^}]*\bmeta\b/.test(spec);
  if (!exportsMeta) return 'the spec does not export `meta`';
  // `run` must be AWAITABLE, not merely present (Copilot, #316): recordDemo awaits it, and a
  // synchronous `run` returns before its `step()` calls settle — the recorder would then film
  // an empty page and land a valid-looking but contentless video. A silent bad artifact is
  // exactly what this seam must not produce, so the async marker is part of the shape check
  // for the two forms a static read can see. The re-export form (`export { run }`) still
  // cannot be judged here — its asyncness lives at the declaration — so it stays accepted and
  // the recording remains its judge.
  const asyncRunDecl = /export\s+async\s+function\s+run\b/.test(spec);
  const asyncRunBinding = /export\s+(const|let|var)\s+run\s*=\s*async\b/.test(spec);
  const runReExport = /export\s*\{[^}]*\brun\b/.test(spec);
  const syncRunDecl = /export\s+function\s+run\b/.test(spec);
  const syncRunBinding =
    /export\s+(const|let|var)\s+run\s*=/.test(spec) && !asyncRunBinding;
  if (syncRunDecl || syncRunBinding) {
    return 'the spec exports `run` but not as an async function (the recorder awaits it)';
  }
  if (!asyncRunDecl && !asyncRunBinding && !runReExport) {
    return 'the spec does not export an async `run` function';
  }
  return null;
}

// ── The subscriber ────────────────────────────────────────────────────────────────────────────

/** Options for {@link startInteractiveDemoSubscriber}. */
export interface InteractiveDemoOptions {
  /** Bus SQLite db path. Omit to let wicked-bus resolve its own default
   *  (honors `WICKED_BUS_DATA_DIR`) — where interactive's service emits unless redirected. */
  dbPath?: string;
  /** Poll cadence, ms (default 2000; tests shorten it). */
  pollIntervalMs?: number;
  /** Heartbeat narration cadence while a run is in flight, ms (default 15000 — inside the
   *  UI's ~20s `status.requested` window so the canvas never reads frozen). */
  heartbeatMs?: number;
  /** Ledger file (default `~/.wicked-crew/interactive-demo-ledger.json`). */
  ledgerPath?: string;
  /** Root under which each launch gets its own per-run subdirectory (`<demoDir>/<docId>/` for
   *  a first spec, `<demoDir>/<docId>-v<version>/` for a re-author) holding the deliverable
   *  (and, on the re-author leg, the current-spec copy + feedback JSON); only that
   *  subdirectory is declared as the run's extra write root (per-run isolation — Copilot,
   *  crew#313). Default `~/.wicked-crew/interactive-demos`. */
  demoDir?: string;
  /** Seat roster JSON for the governed run (default: the production council roster).
   *  The functional-test harness passes a deterministic stub seat here. */
  clisJson?: string;
  /** The docs root a doc's workspace lives under — where the finished spec is INSTALLED and
   *  where the feedback leg reads the manifest kind + current spec. Default: the
   *  shared-default resolution (`WICKED_INTERACTIVE_ROOT` › `~/wicked-interactive/docs`);
   *  the server wires the per-project `interactiveRoot` setting through here. */
  resolveDocsRoot?: (projectId: string | undefined) => string;
  /** Called after a launch that FILED the run into a project (the trigger carried
   *  `project_id`). Same wiring as the sibling seams. */
  onRunFiled?: (runId: string, projectId: string) => void;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface InteractiveDemoSubscription {
  stop(): Promise<void> | void;
  /** The durable ledger (diagnostics / tests). Keys: `<doc>` = the first spec authoring,
   *  `<doc>:v<N>` = the re-author for the feedback handoff on version N. */
  ledger: InteractiveHandoffLedger;
  /** Documents with a demo run currently in flight (either leg). */
  inFlightDocs(): string[];
}

interface InFlight {
  /** Ledger key: `<doc>` (first spec) or `<doc>:v<N>` (re-author). */
  key: string;
  leg: 'spec' | 'reauthor';
  documentId: string;
  projectId?: string | undefined;
  /** Re-author only: the handoff version (idempotency key + narration). */
  version?: number | undefined;
  /** Where the worker must leave the spec (inside the per-run inbox). */
  outPath: string;
  /** The def's OWN phase count. The run executes one MORE unit — the crew#311 deliverable
   *  floor `launchRun` appends per-run from `requireDeliverables` — so this is what the
   *  "is this the writing phase" branches key on, and `agentPhaseCount + 1` is the run's
   *  real length for the "phase N/M" display. */
  agentPhaseCount: number;
  /** The most recent real narration line (phase transitions overwrite it; the heartbeat repeats it). */
  narration: string;
  heartbeat: ReturnType<typeof setInterval>;
  /** The engine's own reason for the most recent failed unit (`stepFailed.detail`). Carried so
   *  the terminal error status names WHY — in particular the crew#311 deliverable-floor report,
   *  which says the spec path that was expected and what was found. */
  failureDetail?: string | undefined;
}

/** The seam's durable state (handoff ledger + working dirs) follows the daemon's state home —
 *  the `--db` parent when configured, `~/.wicked-crew` otherwise (crew#353): an isolated
 *  daemon's interactive handoffs must not land in the operator's real home. */
function defaultStateDir(): string {
  return crewStateHome();
}

/** The production council roster, resolved lazily through the adapter's own class so this module
 *  never imports the native addon at runtime (unit tests pass `clisJson` and a fake adapter). */
function rosterOf(adapter: CoreAdapter): unknown[] {
  return (adapter.constructor as unknown as { roster(): unknown[] }).roster();
}

/**
 * Arm the seam: register the demo workflows, open durable subscriptions on
 * `wicked.interactive.doc.created` (kind:demo) and `wicked.interactive.feedback.processed`
 * (demo-kind docs), and answer each with a governed run that authors/installs
 * `demo.spec.mjs` and ends in `wicked.interactive.demo.requested` — the model-free service
 * then records the video and lands the storyboard version itself.
 *
 * Graceful degradation mirrors the sibling seams: a missing wicked-bus package or an
 * unopenable db LOGS and returns `null` — the daemon must still boot on a machine whose bus
 * is broken; the demo doc then simply keeps its placeholder (the pre-CREW-UX-9 state).
 */
export async function startInteractiveDemoSubscriber(
  adapter: CoreAdapter,
  opts: InteractiveDemoOptions = {},
): Promise<InteractiveDemoSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[interactive-demo] wicked-bus is not importable — governed demo authoring disabled: ${
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
      `[interactive-demo] could not open the bus db${
        opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''
      } — governed demo authoring disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Both workflows ride the normal registration path — core validates each def BEFORE it is
  // persisted/hot-registered (FINDING-002 ordering), so a drifted def fails the arm loudly
  // instead of failing the first launch obscurely.
  try {
    await adapter.registerWorkflow(INTERACTIVE_DEMO_WORKFLOW_DEF);
    await adapter.registerWorkflow(INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF);
  } catch (err) {
    log(
      `[interactive-demo] could not register the demo workflows — governed demo authoring ` +
        `disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const ledger = new InteractiveHandoffLedger(
    opts.ledgerPath ?? join(defaultStateDir(), 'interactive-demo-ledger.json'),
  );
  const demoDir = opts.demoDir ?? join(defaultStateDir(), 'interactive-demos');
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const resolveDocsRoot = opts.resolveDocsRoot ?? (() => resolveInteractiveRoot(null));
  const inFlight = new Map<string, InFlight>(); // runId → live state

  /** Emit onto interactive's vocabulary as the `wi-crew` producer. Never throws into the
   *  caller: narration/announce failures are logged — a lost status line must not kill the
   *  subscription, and a duplicate demo.requested (WB-002) is the idempotency key WORKING. */
  function emitInteractive(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): boolean {
    try {
      bus.emit(db, config, {
        event_type: type,
        // Subdomains per interactive's events.js table: demo.requested rides `demo`,
        // status.posted rides `status`.
        domain: INTERACTIVE_DOMAIN,
        subdomain: type === DEMO_REQUESTED ? 'demo' : 'status',
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
        `[interactive-demo] emit ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
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
   *  close the loop (copy spec → emit demo.requested) when the run lands. */
  const offCoreEvents = adapter.onEvent((event: CoreEvent) => {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    if (runId === undefined) return;
    const flight = inFlight.get(runId);
    if (flight === undefined) return;

    // Narration ladder — same rationale as the sibling folds: the heartbeat repeats the LATEST
    // line and the transcript dedups repeats, so advancing the line = visible progress.
    const authoring = flight.leg === 'spec' ? 'the click-path spec' : 'the revised click-path spec';

    // The crew#311 deliverable floor is a DETERMINISTIC tool phase — no seat, no council. Core
    // still emits the seat-selection events for it (its `cli` is the node interpreter's absolute
    // path), so narrating them verbatim put "Council picked /opt/homebrew/.../node to write the
    // click-path spec…" in the reader's thread. Drop those two lines for the floor ord; the
    // `unitDispatched` line that follows immediately says what the phase actually is.
    const isFloorOrd = (e: CoreEvent): boolean =>
      typeof (e as { ord?: unknown }).ord === 'number' &&
      (e as { ord: number }).ord > flight.agentPhaseCount;

    if (event.type === 'councilConvened') {
      if (isFloorOrd(event)) return;
      const seats = Array.isArray(event.clis) ? event.clis.length : 0;
      // "0-seat council" reads like a bug — generic phrasing whenever clis is missing or empty
      // (Copilot, #269).
      const council = seats > 0 ? `a ${seats}-seat council` : 'a council';
      narrate(flight, `Convening ${council} to pick who writes ${authoring}…`);
      return;
    }

    if (event.type === 'unitDistributed') {
      if (isFloorOrd(event)) return;
      const who = typeof event.cli === 'string' ? event.cli : 'a worker';
      const pct = typeof event.agreement_pct === 'number' ? ` (${event.agreement_pct}% agreement)` : '';
      narrate(flight, `Council picked ${who} to write ${authoring}${pct}…`);
      return;
    }

    if (event.type === 'unitDispatched') {
      // The first-spec leg plans (tool-free) then inspects-and-writes; the re-author leg is one
      // writing phase; both then run the crew#311 deliverable floor. Narrate whichever the ord
      // actually is rather than assuming a count.
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      const runPhaseCount = flight.agentPhaseCount + 1;
      const line =
        ord > flight.agentPhaseCount
          ? 'checking the spec file was actually written…'
          : ord >= flight.agentPhaseCount
            ? `inspecting the app and writing ${authoring}…`
            : 'planning the demo scenes…';
      narrate(flight, `Crew phase ${ord}/${runPhaseCount}: ${line}`);
      return;
    }

    if (event.type === 'toolInvoked') {
      const tools = Array.isArray(event.tools) ? [...new Set(event.tools)].join(', ') : '';
      if (tools) narrate(flight, `Worker is using ${tools} on your demo…`);
      return;
    }

    if (event.type === 'unitOutputCaptured') {
      narrate(flight, `Spec work finished — the governance gate is reviewing it…`);
      return;
    }

    if (event.type === 'gateDecided' && event.allow === true) {
      const ord = typeof event.ord === 'number' ? event.ord : 0;
      narrate(
        flight,
        ord > flight.agentPhaseCount
          ? 'Spec file verified on disk — installing it and starting the recording…'
          : 'Gate approved the spec — checking the file landed…',
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
        state: 'error',
        message:
          `The crew run authoring this demo's spec ${event.type === 'runCancelled' ? 'was cancelled' : 'failed'} ` +
          `(run ${runId}).${why} Inspect it via the crew API (GET /api/v1/runs/${runId}); no recording was triggered.`,
      });
      log(`[interactive-demo] run ${runId} for ${flight.key} ended: ${event.type}`);
    }
  });

  /**
   * The run is terminal: verify the spec (exists, non-empty, passes the static module
   * self-check), COPY it into the doc workspace, THEN emit demo.requested — strictly in that
   * order (the service reads `<docDir>/demo.spec.mjs` when the request arrives; an emit-first
   * ordering would record a missing or stale spec). Every failure is honest: error status,
   * failure row, and NO demo.requested — the doc keeps its current state instead of the
   * service throwing "no demo.spec.mjs authored yet" at a request crew knew was hollow.
   */
  function finalize(flight: InFlight, runId: string): void {
    const { documentId, outPath, key } = flight;
    const fail = (message: string): void => {
      ledger.recordFailure(key);
      emitInteractive(STATUS_POSTED, { document_id: documentId, state: 'error', message });
      log(`[interactive-demo] run ${runId} for ${key} failed at finalize: ${message}`);
    };

    let spec = '';
    try {
      spec = readFileSync(outPath, 'utf8');
    } catch {
      /* missing file → the empty-spec failure below */
    }
    if (spec.trim().length === 0) {
      fail(`The crew run completed but produced no demo spec at ${outPath} (run ${runId}); no recording was triggered.`);
      return;
    }
    const violation = specSelfCheck(spec);
    if (violation !== null) {
      // The pre-install self-check (recordDemo would reject the module at import time —
      // interactive demo.js: `demo.spec.mjs must export an async run(...)`). Fail loud crew-side
      // instead of letting the service fail the recording after crew claimed success.
      fail(
        `The crew's demo spec failed its pre-install self-check and was NOT installed — ${violation} ` +
          `(run ${runId}). The document is unchanged; resubmit the request.`,
      );
      return;
    }

    // Crew (not the worker) installs the spec: the worker's boundary cannot touch the doc
    // workspace (wicked-core#293/#294) — crew's own process can. The docs root resolves the
    // same way the chat seam and the interactive proxy resolve it (per-project setting via the
    // server wiring; shared default otherwise), so the copy lands where the service will look.
    const docsRoot = resolveDocsRoot(flight.projectId);
    const docDir = join(docsRoot, documentId);
    if (!existsSync(join(docDir, 'versions.json'))) {
      fail(
        `Crew authored the demo spec (at ${outPath}) but found no doc workspace at ${docDir} — ` +
          `the spec was NOT installed and no recording was triggered. Check the interactive docs root, then replay the request.`,
      );
      return;
    }
    try {
      copyFileSync(outPath, join(docDir, DEMO_SPEC_FILE));
    } catch (err) {
      fail(
        `Crew authored the demo spec but could not install it into ${docDir}: ${
          err instanceof Error ? err.message : String(err)
        } (run ${runId}). No recording was triggered.`,
      );
      return;
    }

    // Spec installed — NOW ask the (model-free) service to record it. The deterministic key
    // makes a re-announce a WB-002 no-op; distinct keys per authoring generation keep a
    // legitimate re-record from deduping against the first one.
    const idemKey =
      flight.leg === 'spec'
        ? demoIdempotencyKey(documentId)
        : demoReauthorIdempotencyKey(documentId, flight.version ?? 0);
    const emitted = emitInteractive(DEMO_REQUESTED, { document_id: documentId }, idemKey);
    if (!emitted) {
      // The bus refused the announce (non-WB-002): the spec IS installed but the recording was
      // never requested. Fail HONEST — and say exactly where things stand, because unlike the
      // sibling seams the doc is half-advanced (spec on disk, no video).
      ledger.recordFailure(key);
      emitInteractive(STATUS_POSTED, {
        document_id: documentId,
        state: 'error',
        message:
          `Crew installed the demo spec at ${join(docDir, DEMO_SPEC_FILE)} but could not request ` +
          `the recording on the bus (run ${runId}). Inspect the crew daemon log, then emit ` +
          `wicked.interactive.demo.requested for this document to record it.`,
      });
      log(`[interactive-demo] demo.requested emit FAILED for ${key} (run ${runId}) — recorded as failure`);
      return;
    }
    ledger.recordEmitted(key);
    emitInteractive(STATUS_POSTED, {
      document_id: documentId,
      state: 'complete',
      message:
        flight.leg === 'spec'
          ? 'Demo spec authored — recording now. Step-by-step progress will follow; highlight any step to refine it.'
          : 'Demo spec re-authored per your feedback — recording the new take now.',
    });
    log(`[interactive-demo] spec installed + demo.requested emitted for ${key} (run ${runId})`);
  }

  /** `true` when any run (either leg) is in flight for the doc — one demo doc gets one
   *  authoring run at a time, so a re-author can never race the spec it revises. */
  function docBusy(documentId: string): boolean {
    for (const f of inFlight.values()) if (f.documentId === documentId) return true;
    return false;
  }

  async function launchFlight(
    input: {
      key: string;
      leg: 'spec' | 'reauthor';
      documentId: string;
      projectId: string | undefined;
      version: number | undefined;
      problem: string;
      workflow: string;
      runDir: string;
      outPath: string;
      agentPhaseCount: number;
    },
  ): Promise<void> {
    const runId = randomUUID();
    // Resolved BEFORE the launch and never indexing — a refresh is `wicked-estate index` per
    // member at up to 600s EACH, so doing it here would turn "record a demo" into an
    // unannounced multi-repo job. Missing or stale degrades to no binding; the run is unaffected.
    //
    // The decision is RECORDED on both outcomes, like the API launch path (`api/routes.ts`):
    // "this demo sees the project" and "this demo sees nothing, because X" are equally facts about
    // what the run could observe. An unexpected failure degrades the same way but says so — a
    // silent `catch(() => null)` would make a broken binding look identical to a project that
    // simply has no graph yet.
    let projectGraphBinding: ProjectGraphBinding | null = null;
    if (input.projectId !== undefined) {
      const decision = await resolveProjectGraphBinding(adapter, input.projectId, undefined).catch(
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
    return adapter
      .launchRun({
        problem: input.problem,
        sessionId: runId,
        clisJson: opts.clisJson ?? JSON.stringify(rosterOf(adapter)),
        workflow: input.workflow,
        // A project-bound doc's governed run is FILED (the engine attaches the crew.run
        // membership atomically with the launch); an unfiled doc launches with the key OMITTED
        // — never a fabricated 'default' membership (CREW-UX-2).
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        // A project-filed run sees the PROJECT's graph, like any other (verification
        // found this seam launching filed but unbound). These launches are repo-LESS,
        // which is exactly the case that gets a graph where it previously got none.
        ...(projectGraphBinding !== null ? { projectGraph: projectGraphBinding } : {}),
        // THE WRITE-BOUNDARY LESSON, applied (wicked-core#293/#294): deliberately NO `repoRef`
        // and NO doc-workspace path — the run is UNBOUND and its worker can only read/write
        // the per-run inbox declared here (write roots are readable, wicked-core#259). The
        // task names `<inbox>/demo.spec.mjs` as the deliverable; crew copies it into the doc
        // workspace at finalize. Per-run isolation (Copilot, crew#313): ONLY this run's own
        // subdirectory, never the shared demoDir.
        extraWriteRoots: [input.runDir],
        // THE DELIVERABLE FLOOR (crew#311): the spec file IS the deliverable — and this leg is
        // the one that PROVED prose can stand in for it (the module doc above records a run
        // that "completed" with no deliverable at 161-345 bytes and was caught only by
        // finalize, after the gate had passed it). The floor fails the RUN instead.
        requireDeliverables: [input.outPath],
      })
      .then(() => {
        // Record AFTER the launch resolved: a failed launch leaves no ledger row, so a replayed
        // delivery retries. The crash window between launch and this write is the reason the
        // demo.requested emit ALSO carries a deterministic idempotency key.
        ledger.recordLaunch(input.key, runId);
        if (input.projectId !== undefined) opts.onRunFiled?.(runId, input.projectId);
        const flight: InFlight = {
          key: input.key,
          leg: input.leg,
          documentId: input.documentId,
          projectId: input.projectId,
          version: input.version,
          outPath: input.outPath,
          agentPhaseCount: input.agentPhaseCount,
          narration:
            input.leg === 'spec'
              ? 'Crew run launched — authoring your demo…'
              : 'Crew run launched — re-authoring your demo…',
          heartbeat: setInterval(() => {
            // Repeat the last real narration so the ~20s status.requested window is always
            // fed, even mid-phase when the engine is quiet.
            emitInteractive(STATUS_POSTED, {
              document_id: flight.documentId,
              state: 'working',
              message: flight.narration,
            });
          }, heartbeatMs),
        };
        // Do not keep the daemon alive for narration alone.
        flight.heartbeat.unref?.();
        inFlight.set(runId, flight);
        log(`[interactive-demo] ${input.key} → governed run ${runId} (${input.leg}, spec → ${input.outPath})`);
      })
      .catch((err: unknown) => {
        // The 'processing' status is already on the thread — close it out honestly so the
        // canvas never sits in an in-between state on a launch that went nowhere.
        const reason = err instanceof Error ? err.message : String(err);
        emitInteractive(STATUS_POSTED, {
          document_id: input.documentId,
          state: 'error',
          message: `Crew could not start a run for this demo: ${reason}.`,
        });
        // DELIBERATELY no ledger write: only an answered trigger earns a row, so an operator
        // can replay the dead-lettered frame after fixing the daemon and get a real retry.
        // Re-throw so the bus (maxRetries 0) dead-letters the frame — visible, replayable,
        // and incapable of hot-looping.
        throw err instanceof Error ? err : new Error(reason);
      });
  }

  async function handleDocCreated(event: BusEvent): Promise<void> {
    const doc = parseDemoDocCreated(event.event_type, event.payload);
    if (doc === null) return;

    // Replay-dedup: the ledger is the durable gate (redelivery after crash/restart), the
    // in-flight scan the live one. Keyed by DOCUMENT — one first spec per document lifetime
    // (refinement is the feedback leg's business).
    if (ledger.has(doc.documentId)) {
      log(
        `[interactive-demo] doc ${doc.documentId} already answered (run ${ledger.get(doc.documentId)?.runId}) — replay ignored`,
      );
      return;
    }
    if (docBusy(doc.documentId)) return;

    const runDir = join(demoDir, doc.documentId);
    const outPath = join(runDir, DEMO_SPEC_FILE);
    mkdirSync(runDir, { recursive: true });

    emitInteractive(STATUS_POSTED, {
      document_id: doc.documentId,
      state: 'processing',
      message: 'A governed crew picked up your demo brief — planning the scenes and authoring the click-path…',
    });

    await launchFlight({
      key: doc.documentId,
      leg: 'spec',
      documentId: doc.documentId,
      projectId: doc.projectId,
      version: undefined,
      problem: demoProblem(doc, outPath),
      workflow: INTERACTIVE_DEMO_WORKFLOW,
      runDir,
      outPath,
      agentPhaseCount: INTERACTIVE_DEMO_WORKFLOW_DEF.phases.length,
    });
  }

  async function handleFeedbackProcessed(event: BusEvent): Promise<void> {
    const handoff = parseStructuralFeedback(event.event_type, event.payload);
    if (handoff === null) return;

    // THE KIND GATE (the disk truth, shared with the edit seam): this leg answers ONLY docs
    // whose manifest says `kind: "demo"` — interactive records the kind for demo docs
    // (initWorkspace(dir, html, {kind:'demo'}), server.js). Everything else — including a doc
    // whose manifest this daemon cannot read — is the edit seam's business, and the edit seam
    // applies the same gate inverted, so exactly one seam answers any given handoff.
    const docsRoot = resolveDocsRoot(handoff.projectId);
    const head = readDocHead(docsRoot, handoff.documentId);
    if (head === null || head.kind !== 'demo') return;

    const key = handoffKey(handoff.documentId, handoff.version);
    if (ledger.has(key)) {
      log(
        `[interactive-demo] handoff ${key} already answered (run ${ledger.get(key)?.runId}) — replay ignored`,
      );
      return;
    }
    for (const f of inFlight.values()) {
      if (f.key === key) return;
    }
    if (docBusy(handoff.documentId)) {
      // Another authoring run (usually the FIRST spec) is still in flight for this doc — a
      // re-author launched now would revise a spec that is still being written. Dead-letter
      // the frame (throw → maxRetries 0 → DLQ) so it is visible and replayable once the
      // in-flight run lands, and say so on the thread instead of eating the user's feedback.
      const message =
        `Crew is still authoring this demo's spec — your step feedback was set aside; ` +
        `replay it (or resubmit) once the current run lands.`;
      emitInteractive(STATUS_POSTED, { document_id: handoff.documentId, state: 'error', message });
      log(`[interactive-demo] handoff ${key} arrived while doc ${handoff.documentId} is busy — dead-lettered`);
      throw new Error(message);
    }

    // The current spec is the re-author's ground truth: copy it INTO the inbox crew-side so
    // the unbound worker can read it (write roots are readable, wicked-core#259 — the doc
    // workspace itself is boundary-denied, wicked-core#294). No spec on disk = nothing to
    // re-author (a demo doc that never had its first spec authored): dead-letter, replayable
    // after the first authoring lands.
    const srcSpec = join(docsRoot, handoff.documentId, DEMO_SPEC_FILE);
    if (!existsSync(srcSpec)) {
      const message =
        `This demo has no ${DEMO_SPEC_FILE} to revise yet — the step feedback was set aside; ` +
        `replay it once the first spec is authored.`;
      emitInteractive(STATUS_POSTED, { document_id: handoff.documentId, state: 'error', message });
      log(`[interactive-demo] handoff ${key}: no spec at ${srcSpec} — dead-lettered`);
      throw new Error(message);
    }

    const runDir = join(demoDir, key.replace(':', '-'));
    const outPath = join(runDir, DEMO_SPEC_FILE);
    mkdirSync(runDir, { recursive: true });
    const currentSpecPath = join(runDir, 'current.spec.mjs');
    copyFileSync(srcSpec, currentSpecPath);
    // Handoff by file (the edit leg's discipline): fragments can be arbitrarily large and the
    // PTY prompt is single-line, so the items ride a JSON file in the inbox, not the problem.
    const feedbackPath = join(runDir, 'feedback.json');
    writeFileSync(
      feedbackPath,
      JSON.stringify(
        { document_id: handoff.documentId, version: handoff.version, items: handoff.items },
        null,
        2,
      ),
      'utf8',
    );

    emitInteractive(STATUS_POSTED, {
      document_id: handoff.documentId,
      state: 'processing',
      message: `A governed crew picked up your demo feedback — re-authoring the click-path (${handoff.items.length} change${handoff.items.length === 1 ? '' : 's'})…`,
    });

    await launchFlight({
      key,
      leg: 'reauthor',
      documentId: handoff.documentId,
      projectId: handoff.projectId,
      version: handoff.version,
      problem: demoReauthorProblem(handoff, currentSpecPath, feedbackPath, outPath),
      workflow: INTERACTIVE_DEMO_REAUTHOR_WORKFLOW,
      runDir,
      outPath,
      agentPhaseCount: INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF.phases.length,
    });
  }

  const subCreated = bus.subscribe({
    db,
    plugin: INTERACTIVE_DEMO_BUS_PLUGIN,
    filter: INTERACTIVE_DEMO_BUS_FILTER,
    // Live triggers only: replaying a bus backlog would answer docs whose demos the assist
    // loop long since produced. History reconciliation belongs to the state plane, not here.
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    // Our own ledger + idempotency key are the dedupe; a bus-level retry of a failed launch
    // would double-launch precisely because the ledger row is only written on success.
    maxRetries: 0,
    handler: (event: BusEvent) => handleDocCreated(event),
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[interactive-demo] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      );
    },
  });

  const subFeedback = bus.subscribe({
    db,
    plugin: INTERACTIVE_DEMO_FEEDBACK_BUS_PLUGIN,
    filter: INTERACTIVE_DEMO_FEEDBACK_BUS_FILTER,
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    maxRetries: 0,
    handler: (event: BusEvent) => handleFeedbackProcessed(event),
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[interactive-demo] feedback handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      );
    },
  });

  return {
    ledger,
    inFlightDocs: () => [...new Set([...inFlight.values()].map((f) => f.documentId))],
    stop: async () => {
      offCoreEvents();
      for (const runId of [...inFlight.keys()]) endFlight(runId);
      await subCreated.stop();
      await subFeedback.stop();
    },
  };
}
