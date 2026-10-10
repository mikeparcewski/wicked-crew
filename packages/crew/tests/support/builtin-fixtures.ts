// Test fixtures (X-MIG M11): the built-in workflows' defs as crew served them from its mirrors
// until the mirrors were deleted. Crew now serves the built-ins DERIVED from the engine's presets
// (`src/core/builtin-catalog.ts`); these literals stay only as stable test data for the unit tests
// that need a def of that shape (the deliver text, delivery candidacy, acceptance, gates). They are
// not a contract with the engine — nothing compares them to it.
import { EVIDENCE_FLOOR_PIN } from '../../src/core/deliver.js';
import { withSystemFlag } from '../../src/core/run-identity.js';
import type { WorkflowDef } from '../../src/core/types.js';

/** The `bug` def's `fix` instructions (the literal core's preset carries). */
export const BUG_FIX_SWEEP_INSTRUCTIONS =
  'Update every consumer of behaviour this fix retires or changes: tests, docs, comments.';

const APP_CHANGE_INSTRUMENTS = ['distinct_evaluator', 'judge', 'qe_acceptance'];

const agent = (id: string, kind: 'recon' | 'build' | 'review', extra: Partial<WorkflowDef['phases'][number]> = {}): WorkflowDef['phases'][number] => ({
  id, kind, instructions: `${id} (orientation)`, gate_type: 'execution', gate: 'auto', executes_code: false,
  verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: 'wicked-garden-qe',
  allowed_skills: [], validator_pin: null, ...extra,
});

/** `qe-author-tests` as crew served it: recon → author (creator) → verify (Tool) → review (evaluator). */
export const QE_AUTHOR_TESTS_FIXTURE: WorkflowDef = {
  id: 'qe-author-tests',
  phases: [
    agent('recon', 'recon', { gate_type: 'strategy' }),
    agent('author', 'build', { depends_on: ['recon'], role: 'creator', executes_code: true, validator_pin: EVIDENCE_FLOOR_PIN }),
    {
      id: 'verify', kind: 'test', executor: { type: 'tool', cmd: ['bash', '-lc', 'echo QE-VERIFY-SUMMARY: produced=0'] }, gate_type: 'execution',
      gate: 'auto', executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['author'], role: 'neutral',
      skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN,
    },
    agent('review', 'review', { depends_on: ['verify'], role: 'evaluator', gate: { human_confirm_if: 'verdict_not_pass' }, validator_pin: EVIDENCE_FLOOR_PIN }),
  ],
};

export const BUILTIN_WORKFLOWS: WorkflowDef[] = ([
  {
    id: 'feature',
    phases: [
      { id: 'clarify', kind: 'recon', gate_type: 'value', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'design', kind: 'recon', gate_type: 'strategy', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['clarify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'build', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['design'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'adversarial-review', kind: 'review', gate_type: 'execution', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['build'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'test', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['build'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'review', kind: 'review', gate_type: 'execution', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['test'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
    required_instruments: APP_CHANGE_INSTRUMENTS,
  },
  {
    id: 'bug',
    phases: [
      { id: 'triage', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'reproduce', kind: 'test', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['triage'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      // DES-L9 (BC-60, core#432): the retired-behaviour sweep — the SAME literal core's `bug_def()` carries (wicked-core #522); pinned by a test
      // so the two carriers cannot drift. `builtin-overlay-shadow.test.ts` tolerates exactly this one field while core MAIN has not merged #522
      // (crew CI compares this mirror with core main); row 6.9 (the `^0.7.27` pin) removes that tolerance.
      { id: 'fix', kind: 'build', instructions: BUG_FIX_SWEEP_INSTRUCTIONS, gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['reproduce'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['fix'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
    ],
    required_instruments: APP_CHANGE_INSTRUMENTS,
  },
  {
    id: 'migration',
    phases: [
      { id: 'plan', kind: 'recon', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'execute', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['plan'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'cutover', kind: 'build', gate_type: 'execution', gate: { human_confirm: { unconditional: true } }, executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['execute'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['cutover'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'cleanup', kind: 'build', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['verify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
    required_instruments: APP_CHANGE_INSTRUMENTS,
  },
  {
    // capture-learnings (DES-MEM-FACETED-001 write side, onboarding): survey a just-indexed repo,
    // then propose its durable learnings — BOTH faceted MEMORIES and repo POLICIES — as inert estate
    // `proposal.submit` proposals (through garden's estate shim) a human later reviews.
    //
    // ONE workflow, not four. "Go multi-workflow" is realized as multi-PHASE composition inside a
    // single governed run, NOT as separate churn-analysis / hotspot-read / derive-memories /
    // derive-policies RUNS, because:
    //   • Context threading: the learning method is a dependent chain (churn ranking → hotspot
    //     cross-reference → capture). Crew threads each phase's output into the next phase's prompt
    //     automatically (plan.rs folds prior context); separate runs share NOTHING, so a split would
    //     sever that thread and each run would re-establish repo understanding from scratch.
    //   • Council cost: every phase convenes a ~6-seat council (the ecosystem's spikiest operation,
    //     serialized on purpose). Four runs multiply that; three phases in one run pay it once each.
    //   • The Memories-vs-Policies review split is a proposal-KIND concern, not a workflow-identity
    //     one: `kind_type` routes memory→studio Memories and policy:<type>→Steering downstream, so a
    //     SINGLE `capture` phase emits both from the one shared understanding — splitting derive-
    //     memories / derive-policies would re-run a council over the same context for no new evidence.
    //   • Reuse already lives below the run: the reusable unit is the SKILL (and hotspot-read is
    //     already a reusable capability via `wicked-garden-search`).
    //
    // The METHOD lives in the garden skill `wicked-garden-repo-learn`, referenced per-phase by
    // `skill_ref` — the engine emits only a short `Invoke your skill "wicked-garden:repo-learn"…`
    // directive and the worker loads SKILL.md from the installed plugin. The bounded git-churn
    // sampling, the estate tool names (reached through the shim), and the proposal payload schemas that used to sit inline as
    // ~600-column prose now live in that skill; the inline `instructions` here are a one-line phase
    // ORIENTATION only. That matters because a governed worker's prompt rides a single PTY line capped
    // at 1022 bytes (>=1023B is SILENTLY discarded — wicked-core execute_wrapped.rs), and the planner
    // folds this text onto that line alongside the run intent, so long inline prose here would blow
    // the line. Crew-only (NOT core-seeded), so the overlay write is the only def the engine resolves
    // — no core mirror, and deliberately NOT in builtin-overlay-shadow's MIRRORED_IDS.
    //
    // The shim's `wicked-estate-mcp --readonly` opens the operator GLOBAL memory store and permits
    // `proposal.submit` (a safe write, provenance server-stamped from the WICKED_RUN_* markers on the
    // worker env — DES-L4 PR-③/⑦; there is no CLI-registered estate MCP on the worker any more),
    // so proposals land in the same queue the studio Memories/Policies surfaces review. Onboarding IS
    // about the repo, so the skill tags learnings `repo:`/`project:`.
    id: 'capture-learnings',
    phases: [
      { id: 'churn', kind: 'recon', instructions: "Phase 1/3 CHURN: produce a ranked list of this repo's most actively-changed files and directories over the last ~12 months, plus the repo's real name (manifest or git remote) and parent project. Use the skill's bounded/sampled git-churn method — never stream the whole history. Do not read code deeply yet; the next phase targets these areas.", gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: 'wicked-garden-repo-learn', allowed_skills: [], validator_pin: null },
      { id: 'hotspots', kind: 'recon', instructions: "Phase 2/3 HOTSPOTS: cross-reference the prior churn ranking with wicked-estate hotspot / blast-radius signals to find the load-bearing code, then READ it through the estate shim (`wicked-garden run scripts/_estate_client.py --readonly call …`, the skill's grounding path) to build a real technical understanding of how the system fits together — not a file listing. Reuse wicked-garden-search for the hotspot signals; follow the skill.", gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['churn'], role: 'neutral', skill_ref: 'wicked-garden-repo-learn', allowed_skills: [], validator_pin: null },
      // (BC-80, wicked-core#535) `requires_capture_report`: the engine's capture-report floor reads
      // the phase's output marker, so a capture run whose skill loaded and never ran can no longer
      // report `completed` with 0 proposals — a missing marker, a failed submission and proposals
      // derived but never submitted each deny into the human gate. An honest 0 passes. The
      // instruction MANDATES the marker; garden's repo-learn skill carries the same contract, and
      // the counts land on the unit (`capture_report`), which `GET /runs/:id` serves.
      { id: 'capture', kind: 'build', instructions: "Phase 3/3 CAPTURE: from the prior churn + hotspot understanding, submit durable learnings as estate proposals through the shim's `propose` per the skill's capture contract — BOTH memories (facts / how-it-works) and policies (enforced conventions), one proposal per item, tagged repo/project. Each is inert until human review; never include secrets or personal data. END with `wicked-capture-report {\"derived\": N, \"submitted\": M, \"failed\": K}` — always, even on a degrade or a legitimate 0 (which is acceptable).", gate_type: 'value', gate: 'auto', executes_code: false, requires_capture_report: true, verified_evidence: false, required_deliverables: [], depends_on: ['hotspots'], role: 'creator', skill_ref: 'wicked-garden-repo-learn', allowed_skills: [], validator_pin: null },
    ],
  },
  {
    // "Add with chat" for the Steering surface (STEERING program) — the dedicated entry point
    // behind POST /governance/steering/author. TH-12 propose-as-gate: the run analyzes the
    // operator's intent + the named files/dirs, then the TERMINAL `propose` phase emits the
    // PROPOSED steering rules and its unconditional human gate pauses the run `awaiting_human`
    // (core evaluates a terminal phase's own gate before finalize — seam finding #4), so the
    // operator approves/amends/rejects via the standard POST /runs/:id/gate. Approved rules land
    // CREW-SIDE on that approve: the gate handler writes them through the governed rules seam
    // with `provenance.source: "chat"` (api/steering-landing.ts, crew#388) — the run itself must
    // never write the store, which is why both phases say so out loud. The propose phase hands
    // the rules back in its REPLY — one ```json fenced array — and the landing reads them from the
    // unit's stored output (#789). It used to be told to write the array to a file in the per-run
    // inbox under the home config; a seat's sandbox refuses a write outside its workspace (codex's
    // "approval request failed"), so every author run reported a failed write and the rules only
    // landed through the transcript anyway. The reply is now the designed path, not a fallback.
    //
    // Crew-authored drop-in: NOT in CORE_SEEDED_WORKFLOWS, so launchRun's
    // `_writeBuiltinOverlay` write is the only way core resolves the id — the same delivery
    // mechanism every crew drop-in uses.
    id: 'steering-author',
    phases: [
      { id: 'analyze', kind: 'recon', instructions: 'Read the operator intent and every file or directory listed in the problem statement. Identify candidate steering rules: durable, prescriptive statements a coding agent must follow, each classified into one steering type (architecture, development, security, testing, operations, compliance, design-ux). For each candidate note the statement, steering type, severity, and the evidence in the source material. Analysis only — do not write any rule to any store, and do not emit final rule JSON yet.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'propose', kind: 'recon', instructions: 'From the prior analysis, emit the PROPOSED steering rules as one JSON array. Each entry is a conformance-rule object: id (PAT-<digits> for rule_type "pattern", POL-<digits> for "policy"), rule_type, statement, severity (info|warn|error|critical), confidence (a NUMBER 0..1), steering_type (default to the type named in the problem statement), provenance {"source":"chat"}, and — only where the source material supports them — the enforcement fields applies_to (array of phase tokens or globs), excludes, weight, obligations (array of strings), criteria (ONE string, never a list). Omit targets, effect and trigger unless you can express them in the store schema exactly: targets is a {language, layer, framework} facet OBJECT (never a file list — files belong in applies_to), and trigger is a structured condition object (never prose). Put that JSON array in your reply, ONCE, as a single ```json fenced block (the whole array, valid JSON): your reply IS the proposal — crew reads the array from it when the human approves. Do not write it to any file and do not create files for it. This output is a PROPOSAL for the human gate: rules land in the governance store only after approval, written crew-side — do not write any rule to any store yourself.', gate_type: 'value', gate: { human_confirm: { unconditional: true } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['analyze'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  // The governed test-authoring workflow (wave 6 — F-7R2-003/004/005/012/014/015, R4-r2): recon →
  // author (creator, evidence-floor pinned) → verify (a TOOL phase that RUNS every produced test
  // under the repository's own harness and fails the unit when one fails or never ran) → review
  // (evaluator ≠ creator). Delivery is appended per run by the engine-side composition (`deliver:
  // "pr"`), never performed by a worker. Def + verify script live in `qe/author-workflow.ts` so the
  // e2e can assert the script's behaviour without reaching into this array. Crew-only drop-in (NOT
  // core-seeded); the `wicked-garden-qe` skill carries the method (plan/author/review actions).
  // The one workflow that ARMS the dual-validator gate: `coverage` carries an approved
  // `validator_pin`, so layer 1 is live here and inert in every entry above. Transcribed
  // field-for-field from the source of truth, `wicked-core/workflows/domain-extraction.json`
  // (core ships it as a *drop-in*, not a seeded built-in, and exposes no dump command — hence a
  // hand-transcribed mirror, like every other entry in this array).
  //
  // The pin is a content hash over the validator's criterion + script + approved flag. Core
  // re-derives it in `domain_extraction.rs` and fails its own test if it drifts; if that test ever
  // forces core's constant to change, THIS literal must change with it or crew will write an
  // overlay that fails closed at plan time.
  //
  // Running it needs a one-time, idempotent `wicked-core seed-domain-validators` to vault + approve
  // that validator. That step is deliberately manual — approval is an audited act a human/council
  // owns, not something a daemon does unattended — and until it is run, a launch fails CLOSED at
  // plan time rather than running the phase ungated. Not `is_system`: this is an operator-selectable
  // work mode, unlike the dedicated-entry-point workflows above.
  {
    id: 'domain-extraction',
    phases: [
      // required_deliverables reconciled with core (wicked-core/workflows/domain-extraction.json):
      // survey/analyze/extract annotate the estate STORE and domain-graph now PERSISTS the graph
      // into the store (not a JSON file), so their evidence is DB state — verified by the coverage
      // gate (reads the store) and domain-graph's fail-closed-on-coverage<1.0 — not a worktree file.
      // Only coverage emits a genuine standalone report the deterministic floor reads. Declaring
      // phantom files failed every phase under core's FINDING-101 deliverable gate.
      //
      // `coverage` is `executes_code: true` (wicked-core#414): it WRITES `coverage-report.json`
      // into the worktree for its pinned validator to read, and an `executes_code: false` phase
      // may write nothing there — the worktree guard has no exemptions, declared deliverables
      // included. Its role stays `evaluator`; the deliver default keys off code-writing
      // NON-EVALUATOR phases (`executes_code && role !== 'evaluator'`), so this def never delivers.
      { id: 'survey', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'analyze', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['survey'], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'extract', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['analyze'], role: 'creator', skill_ref: 'wicked-garden-domain-extractor', allowed_skills: [], validator_pin: null },
      { id: 'coverage', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: true, verified_evidence: true, required_deliverables: ['coverage-report.json'], depends_on: ['extract'], role: 'evaluator', skill_ref: 'wicked-garden-domain-coverage', allowed_skills: [], validator_pin: 'bfe4020a365c598b' },
      // domain-graph is a DETERMINISTIC Tool that runs `wicked-core domain-graph`, which PERSISTS the
      // domain/requirement/rule graph into the repo store (core#237) — not an LLM skill that could hit
      // a non-persisting hermetic fallback. Mirrors wicked-core/workflows/domain-extraction.json.
      { id: 'domain-graph', executor: { type: 'tool', cmd: ['wicked-core', 'domain-graph', '--db', '{code_graph_db}', '--out', 'requirements_graph.json'] }, kind: 'build', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['coverage'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  // The MCP-server drop-in (DES-mcp-server-workflow): transcribed field for field — every
  // `instructions` string verbatim, the gates, pins, roles, skill_refs, depends_on and the install
  // phase's `executor` — from the source of truth, `wicked-core/workflows/mcp-server.json` (core ships
  // it as a drop-in, not a seeded built-in, so it is NOT in CORE_SEEDED_WORKFLOWS: launchRun writes
  // this mirror to the overlay and hot-registers it, as for domain-extraction). It carries only the
  // evidence-floor pin, so no seed step is needed. Deliver is composed per run and placed BEFORE
  // `install` (`composeDeliverWorkflow` / `placeDeliverBeforeInstall`), so the pull request exists
  // when the install gate asks. The install gate is `consent_before` (core#801, crew#888): the engine
  // pauses with `gateKind: 'consent'` BEFORE the install runs and nothing pauses after it; the
  // command execs the admitted garden at `WICKED_GARDEN_ROOT` (core#802), never PATH. The install
  // Tool phase runs on the daemon host as the daemon user (the garden install script builds into
  // ~/.wicked/mcp-servers/<key>, registers the server in this daemon's MCP tools and writes the CLI
  // configurations through wicked-installer). core#820: an `install-plan` Tool phase dry-runs the
  // install first (`--dry-run --json`, one plan line), the gate offers its choices
  // (`consent:worker` default, `consent:operator`, `reject`) with each one's write targets, and the
  // install runs with the chosen `--target "$WICKED_CONSENT_CHOICE"`. Field-for-field equal to
  // core's `workflows/mcp-server.json` (tests/builtin-overlay-shadow.test.ts).
  // Not `is_system`: an operator-selectable work mode.
  {
    id: 'mcp-server',
    phases: [
      { id: "scope", kind: "recon", gate_type: "value", gate: {"human_confirm": {"unconditional": false}}, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: "neutral", skill_ref: "wicked-garden-mcp-scaffold", allowed_skills: [], validator_pin: null, instructions: "Decide what this MCP server exposes (tools, resources, prompts), the upstream's authentication scheme (bearer, API key, basic, OAuth2 client credentials — the server reads ONE secret variable <SERVER>_TOKEN and every other auth parameter from its committed mcp-server.config.json), the transport (stdio by default; httpStream only when the intent asks for a hosted server), and the target: this run's repository, at its root when the repository is new and near-empty, or in a named subdirectory when it already holds code. Say whether an OpenAPI document was given (URL or file), and whether the operator wants the server installed for running when the run completes (the install phase asks again at its gate). If the intent names a repository that is not this run's, say that the operator must create it with an initial commit and register it before a run can deliver into it; do not try to create one." },
      { id: "source-discovery", kind: "recon", gate_type: null, gate: "auto", executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["scope"], role: "neutral", skill_ref: "wicked-garden-mcp-scaffold", allowed_skills: [], validator_pin: null, instructions: "With an OpenAPI document: run the skill's openapi action against the conversion service and report every tool it yields with its class (read, write, destructive), its input schema summary and its request mapping, plus the skipped operations and why. Without one: inventory the integration surface (SDK calls, CLI, database, events) into a candidate tool list with the same columns. Do not write code in this phase." },
      { id: "design", kind: "recon", gate_type: "strategy", gate: {"human_confirm": {"unconditional": false}}, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["source-discovery"], role: "neutral", skill_ref: "wicked-garden-mcp-scaffold", allowed_skills: [], validator_pin: null, instructions: "Produce the design: the final tool table (name, description, input schema, annotations, class), the resources and prompts if any, the authentication plan (the one secret variable, the committed non-secret parameters, which header, what fails at startup), and the observability plan (span names and attributes, the three instruments, log fields, what leaves the process and only when). Check each against the MCP-server steering rules MCPS-1001 to MCPS-1007 (recall them with rules.recall, scope wiki:governance, when an estate store is present; otherwise use the checklist in the skill) and against MCP-D2 and MCP-D4. If a rule cannot be recalled, say so, cite the skill's checklist instead, and never state what a rule id means when you could not read it. Name every deviation and why." },
      { id: "build", kind: "build", gate_type: "execution", gate: "auto", executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ["design"], role: "creator", skill_ref: "wicked-garden-mcp-scaffold", allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN, instructions: "Scaffold the TypeScript server with the skill (--lang typescript) into the target directory. Branch A, with a tools.json from the conversion service: the generated tools ride the skeleton's REST runtime; adapt names, descriptions and annotations to the design. Branch B, without one: write each tool by hand with a zod schema on the same skeleton. Either way: the one secret variable and the committed mcp-server.config.json the design named, the conformance smoke and one contract test per tool under npm test, the typecheck, lint and test scripts present, an SPDX header on every source file, telemetry exporters armed only by OTEL_EXPORTER_OTLP_ENDPOINT. Build it and run the skill's probe; put the probe JSON in your output." },
      { id: "test", kind: "test", gate_type: "execution", gate: {"human_confirm_if": "verdict_not_pass"}, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ["build"], role: "neutral", skill_ref: "wicked-garden-qe-contract-testing-engineer", allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN, instructions: "Judge the verify floor's report of the repository's own checks (typecheck, lint, test) and the tests themselves: every tool in the design has a contract test, the conformance smoke covers initialize, tools/list, tools/call, the missing-credential startup failure and the httpStream 401 path, and nothing in the tree holds a secret value. A tool without a test, or a smoke that does not exercise the failure paths, is a FAIL with the tool named." },
      { id: "security-review", kind: "review", gate_type: "execution", gate: {"human_confirm": {"unconditional": false}}, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["test"], role: "evaluator", skill_ref: "wicked-garden-platform-security-engineer", allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN, instructions: "Review the diff cold against MCPS-1004 and MCPS-1005 and MCP-D2: the one secret read from the environment only and never logged, returned or accepted as an argument; non-secret auth parameters in the committed config; authentication on every tool and resource (authenticate on httpStream, canAccess on every tool); input validated before the handler runs; upstream requests pinned to the configured base URL with allowlisted arguments and no redirects; a rate limit that answers a user error. Cite file and line for every finding." },
      { id: "observability-review", kind: "review", gate_type: "execution", gate: {"human_confirm_if": "verdict_not_pass"}, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["test"], role: "evaluator", skill_ref: "wicked-garden-qe-observability-test-engineer", allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN, instructions: "Review the diff cold against MCPS-1002 and MCPS-1003: one span per tool call with the server, tool, request id and outcome attributes and a child span per upstream request; the three instruments recorded; logs through loglayer with trace and span ids stamped, a request-scoped child logger per call, console output on stderr only; nothing exported unless the operator sets an OTLP endpoint. Cite file and line for every finding." },
      { id: "install-plan", kind: "build", gate_type: "execution", gate: "auto", executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["security-review", "observability-review"], role: "neutral", skill_ref: null, allowed_skills: [], validator_pin: null, executor: {"type": "tool", "cmd": ["bash", "-c", "exec \"${WICKED_GARDEN_ROOT:?the engine handed this Tool phase no garden root; refusing to resolve wicked-garden from PATH}/scripts/wicked-garden\" run scripts/mcp/install.py --from-run --dry-run --json"]}, instructions: "Plan the install without writing anything: resolve, on this host and as the daemon user, every file and directory each install choice would write — Install for workers (the default: the staged copy under ~/.wicked/mcp-servers/<key>/current, the wicked-crew MCP tools registry and the worker homes' CLI configurations under ~/.wicked-worker) and Also install into my CLIs (the worker set plus your own CLI configurations, such as ~/.claude.json, ~/.codex/config.toml and the opencode configuration) — and print them as one JSON plan line, so the install's consent gate can list them before you answer." },
      { id: "install", kind: "build", gate_type: "execution", gate: "consent_before", executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ["install-plan"], role: "neutral", skill_ref: null, allowed_skills: [], validator_pin: null, executor: {"type": "tool", "cmd": ["bash", "-c", "exec \"${WICKED_GARDEN_ROOT:?the engine handed this Tool phase no garden root; refusing to resolve wicked-garden from PATH}/scripts/wicked-garden\" run scripts/mcp/install.py --from-run --target \"${WICKED_CONSENT_CHOICE:?the consent gate recorded no install choice}\" --json"]}, instructions: "Install for running — or update the installed copy when this server key is already installed. Nothing has been installed yet: this asks before the install runs, and each answer lists exactly the files it would write (from the install-plan dry run). Install for workers (the default) builds the server from this run's tree into ~/.wicked/mcp-servers/<key>/current, registers it in wicked-crew's MCP tools under its key (an existing entry is re-registered in place; the first use of a changed tool still asks) and writes it into the worker homes' CLI MCP configurations — program-owned files only. Also install into my CLIs does the same and also writes it into your own CLI MCP configurations through wicked-installer (one entry per key, never a second copy; CLI entries carry no secret). Both probe tools/list. The one secret variable <SERVER>_TOKEN is named, never written: when the daemon cannot resolve it the registration is reported as pending with the remedy. Writes happen on the daemon host as the daemon user. Decline for not now — the pull request already delivered stays as it is." },
    ],
    required_instruments: APP_CHANGE_INSTRUMENTS,
  },
  QE_AUTHOR_TESTS_FIXTURE,
] satisfies WorkflowDef[]).map(withSystemFlag);
