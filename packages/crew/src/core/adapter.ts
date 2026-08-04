import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdir, access, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Core as CoreHandle, LaunchOptions, Subscription } from 'wicked-core-ts';
import type {
  CoreEvent,
  LaunchRunInput,
  RepoEntry,
  RepoOnboardRef,
  SessionView,
  GovernancePolicy,
  ConformanceRule,
  GovernanceClaim,
  CoverageReport,
  WorkflowDef,
  SystemSettings,
} from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { codeGraphDb } from './repoPaths.js';

const execFileAsync = promisify(execFile);


/** Resolved path under the user's home directory. */
function wickedDir(...parts: string[]): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', ...parts);
}

/**
 * Workflow overlay directory — mirrors the Rust `workflow_overlay_dir()` logic in
 * `pipeline.rs`. The Rust actor reads drop-in workflow JSONs from this path at startup
 * and (with registerWorkflow NAPI) at runtime. TS must write to the same location so
 * the files are picked up on the next daemon start.
 *   • `$WICKED_WORKFLOWS_DIR`  — explicit override (matches Rust env check)
 *   • `~/.config/wicked-core/workflows`  — default (matches Rust default)
 */
function workflowOverlayDir(): string {
  if (process.env.WICKED_WORKFLOWS_DIR) return process.env.WICKED_WORKFLOWS_DIR;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.config', 'wicked-core', 'workflows');
}

function settingsFilePath(): string {
  return join(homedir(), '.config', 'wicked-core', 'settings.json');
}

/** Find the wicked-core standalone binary for the gate-hook command.
 * Checks common install locations so the Rust actor can build a correct
 * hook command even when loaded as a napi addon (where current_exe() = node).
 */
function locateWickedCoreExe(): string | undefined {
  const exeName = process.platform === 'win32' ? 'wicked-core.exe' : 'wicked-core';
  const candidates: string[] = [];
  // User-local install (cargo install / manual).
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    candidates.push(join(home, '.local', 'bin', exeName));
    candidates.push(join(home, '.cargo', 'bin', exeName));
  }
  // Monorepo dev build.
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '../../..', 'wicked-core', 'target', 'release', exeName));
  // PATH lookup.
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathDirs) {
    candidates.push(join(dir, exeName));
  }
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  return candidates.find((p) => existsSync(p));
}

// The native addon is a CommonJS cdylib (`index.node`); load it with a CJS
// require even though this daemon is ESM. This module is the ONLY place that
// touches wicked-core-ts (DES-STUDIO-001 §5.2/§5.3), so the FINALIZING
// `subscribe` seam has a blast radius of exactly one file.
const require = createRequire(import.meta.url);

// ── Governance methods (crew#40/42) ──────────────────────────────────────────
// These instance methods are present on the napi `Core` class after the Rust
// crate is rebuilt with the crew#40/42 governance seam. The intersection type
// below satisfies the TypeScript compiler until node_modules is updated.
type GovernanceMethods = {
  listPolicies(): Promise<string>;
  listConformanceRules(): Promise<string>;
  listConformanceClaims(): Promise<string>;
  getCoverageReport(): Promise<string>;
  // crew#42 write seam
  upsertPolicy(policyJson: string): Promise<string>;
  upsertConformanceRule(ruleJson: string): Promise<string>;
  recallRulesPreview(queryJson: string): Promise<string>;
  // FINDING-038 retire seam. Resolve to the JSON boolean `true` when a record with that id
  // existed, `false` when none did.
  //
  // Optional on purpose: these two are the newest bindings, so a node_modules still holding a
  // pre-crew#42 `wicked-core-ts` will not have them at runtime. Declaring them required would
  // make the `typeof … !== 'function'` guards below read as unreachable and invite a later
  // cleanup to delete them — the FINDING-042 failure shape, where a type asserted more than the
  // runtime could guarantee. Optional keeps the guard type-meaningful.
  retirePolicy?(id: string): Promise<string>;
  retireConformanceRule?(id: string): Promise<string>;
};

/** Chat sessions (core#134): warm ACP seat pool + group fan-out. */
type ChatMethods = {
  chatOpen(chatId: string, clisJson: string, cwd?: string | null): Promise<string>;
  chatSend(chatId: string, text: string, targetsJson?: string | null, cwd?: string | null): Promise<string>;
  chatSeats(chatId: string): Promise<string>;
  chatClose(chatId: string): Promise<string>;
  /** Optional for the same reason as `retirePolicy` above — the enumerate surface landed after
   *  wicked-core-ts 0.3.0, so an installed binding at that version does not carry it. Declaring it
   *  required would type away the very case the guard in `chatList` exists to handle. */
  chatList?(): Promise<string>;
};

/** The durable event log's read half (core#139 / FINDING-014). */
type EventLogMethods = {
  /**
   * A run's recorded events, oldest first, as a JSON array. Each entry is the same tagged object
   * `/ws` carries plus a capture-time `ts` and an ordering `seq`.
   *
   * Optional for the same reason as `retirePolicy` above, and not hypothetically: the addon
   * currently installed in `node_modules` predates this binding, so a required declaration would
   * type away the guard that keeps this daemon running against it.
   */
  runEvents?(runId: string): Promise<string>;
};

type CoreHandleFull = CoreHandle & GovernanceMethods & ChatMethods & EventLogMethods;

/** The napi constructor surface — the static factories live on the class object. */
interface CoreConstructor {
  spawn(path: string): CoreHandleFull;
  spawnStub(path: string): CoreHandleFull;
  registryRoster(): string;
}

const { Core } = require('wicked-core-ts') as { Core: CoreConstructor };

// ── Built-in workflow definitions (crew#44) ──────────────────────────────────
// Static mirrors of wicked-core workflow defs: feature, bug, migration, survey-repo,
// repo-graph, domain-graph-slice, memories, collab, onboarding, chat, and domain-extraction.
// Swap for `this.core.listWorkflowsJson()` / `this.core.getWorkflowJson(id)` once
// the wicked-core-ts NAPI methods land.
/**
 * The ids wicked-core seeds itself, in `WorkflowRegistry::with_defaults()`.
 *
 * `launchRun`'s generic drop-in overlay write SKIPS every id in this set (`onboarding` is written
 * by the onboarding path instead — see the end of this comment, it is the one deliberate exception).
 * A file in that dir shadows the compiled built-in
 * *wholesale* — `register` overwrites by id and `load_dir` runs after `with_defaults` — so writing
 * this hand-transcribed mirror over the real def silently replaces it with a copy missing whatever
 * the def has grown since the mirror was transcribed. That is not hypothetical: the mirror predated
 * the evidence floors, so the write took `validator_pin` back off `feature.adversarial-review`,
 * `bug.verify` and `migration.verify` — the entire content of core's gate-floor change, undone by a
 * file write, with no error and a workflow still reporting the right id and phases (FINDING-049).
 *
 * The write exists for the ids core does NOT seed (chat, repo-graph, survey-repo,
 * domain-graph-slice, memories, domain-extraction): for those the overlay is the only reason they
 * resolve at all, so it stays.
 *
 * The exception: `onboarding` is core-seeded AND still written, by the onboarding path rather than
 * by the generic one. Deliberate — that def's executor cmds are baked with runtime `--db` paths, so
 * it shadows core's copy with a real customization rather than a stale transcription. It is the one
 * shadow that earns its keep, and the reason this set gates the generic write specifically.
 */
const CORE_SEEDED_WORKFLOWS = new Set(['feature', 'bug', 'migration', 'onboarding', 'collab']);

/**
 * The content-address of core's built-in evidence floor (`builtin_floors::EVIDENCE_FLOOR_PIN`),
 * carried on the Evaluator phase of feature/bug/migration.
 *
 * Duplicating a hash is a real cost, paid because the alternative is worse. What `listWorkflows()`
 * serves IS what `GET /api/v1/workflows` and the work-mode selector show, and a `null` here reads
 * as "this phase is ungated" — the opposite of the truth for the three phases core gates. Reporting
 * a gate that exists is the honest failure direction; the drift guard in
 * `tests/armed-workflow-served.test.ts` fails loudly on a developer machine the moment core's value
 * moves. This is display only: as of FINDING-049 these defs are never written to core's overlay dir
 * (see CORE_SEEDED_WORKFLOWS), so a stale value here cannot reach the engine.
 */
const EVIDENCE_FLOOR_PIN = '2fcde907d57f3ee2';

const BUILTIN_WORKFLOWS: WorkflowDef[] = [
  {
    id: 'chat',
    is_system: true,
    phases: [
      { id: 'explore', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'onboarding',
    is_system: true,
    phases: [
      { id: 'index', executor: { type: 'tool', cmd: ['wicked-estate', 'index'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'annotate', executor: { type: 'tool', cmd: ['wicked-estate', 'clusters', '--annotate'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['index'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      // index → annotate, and NOT a third `domain` phase running `wicked-core domain-graph`. That
      // phase could never pass: domain-graph fails closed below 1.0 front-half coverage, and nothing
      // in this workflow annotates a single symbol, so coverage was 0.0 on every repo — every
      // registration ended sessionFailed after the two phases that matter had both succeeded
      // (FINDING-068). domain-graph belongs to `domain-extraction`, downstream of the agentic
      // extract+coverage phases that produce its precondition. Mirrors core's `onboarding_def()`.
    ],
  },
  {
    id: 'feature',
    phases: [
      { id: 'clarify', kind: 'recon', gate_type: 'value', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'design', kind: 'recon', gate_type: 'strategy', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['clarify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'build', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['design'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'adversarial-review', kind: 'review', gate_type: 'execution', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['build'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'test', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['build'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'review', kind: 'review', gate_type: 'execution', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['test'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'bug',
    phases: [
      { id: 'triage', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'reproduce', kind: 'test', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['triage'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'fix', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['reproduce'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['fix'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
    ],
  },
  {
    id: 'migration',
    phases: [
      { id: 'plan', kind: 'recon', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'execute', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['plan'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'cutover', kind: 'build', gate_type: 'execution', gate: { human_confirm: { unconditional: true } }, executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['execute'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['cutover'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'cleanup', kind: 'build', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['verify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'repo-graph',
    is_system: true,
    phases: [
      { id: 'index', executor: { type: 'tool', cmd: ['wicked-estate', 'index'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'annotate', executor: { type: 'tool', cmd: ['wicked-estate', 'clusters', '--annotate'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['index'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'survey-repo',
    is_system: true,
    phases: [
      { id: 'structure', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'stack', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['structure'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'conventions', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['stack'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'domain-graph-slice',
    is_system: true,
    phases: [
      { id: 'identify', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'extract', kind: 'build', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['identify'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'validate', kind: 'review', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['extract'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'memories',
    is_system: true,
    phases: [
      { id: 'gather', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'store', kind: 'build', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['gather'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'collab',
    is_system: true,
    phases: [
      { id: 'propose', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'critique', kind: 'review', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['propose'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'revise', kind: 'recon', gate_type: 'strategy', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['critique'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'verdict', kind: 'review', gate_type: 'value', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['revise'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
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
      { id: 'survey', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: ['legacy-graph.digest.txt'], depends_on: [], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'analyze', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: ['analysis-report.json'], depends_on: ['survey'], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'extract', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: ['annotations.jsonl'], depends_on: ['analyze'], role: 'creator', skill_ref: 'wicked-garden-domain-extractor', allowed_skills: [], validator_pin: null },
      { id: 'coverage', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: ['coverage-report.json'], depends_on: ['extract'], role: 'evaluator', skill_ref: 'wicked-garden-domain-coverage', allowed_skills: [], validator_pin: '4a4b10bf4277bd34' },
      { id: 'domain-graph', kind: 'build', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: ['requirements_graph.json'], depends_on: ['coverage'], role: 'neutral', skill_ref: 'wicked-garden-domain-modeler', allowed_skills: [], validator_pin: null },
    ],
  },
];

/**
 * Chat is not available in this deployment at all — a capability gap, never a bad request.
 *
 * It arrives two ways and both mean the same thing to an operator: the addon predates the binding
 * (no method to call), or the engine was spawned without the ACP runner and says so when called.
 * Only the first is knowable before the call, which is why this is a thrown type rather than a
 * capability flag.
 *
 * Typed rather than left to the caller to sniff out of the message text: the route used to regex
 * the message for one of the two phrasings, so the other fell through to `400` and told an operator
 * to fix a request that was already correct.
 */
export class ChatUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatUnsupportedError';
  }
}

/** The engine's own way of reporting a build that cannot do chat, raised at call time. */
const ENGINE_CHAT_UNSUPPORTED = /chat unsupported/i;

/** One live chat on the enumerate surface — see {@link CoreAdapter.chatList}. */
export interface ChatSummary {
  chatId: string;
  /** The seats currently warm, sorted. */
  seats: string[];
  /** Seconds since the chat's last open/ensure/turn; `null` when it has no activity stamp. */
  idleSecs: number | null;
}

/** A parsed-CoreEvent listener. */
export type CoreEventListener = (event: CoreEvent) => void;

export interface CoreAdapterOptions {
  /** Estate db path the core actor writes to (single writer). */
  dbPath: string;
  /** `true` → deterministic offline stub engine (tests); `false` → production engine. */
  stub?: boolean;
  /**
   * Arm the Law 1 EVENT-DRIVEN execution-mediation seam (DES-EXEC-001 §2.3). When `true` (and NOT
   * stub), the actor PUBLISHES `wicked.task.dispatched` and an off-actor `cli-runner` subscriber
   * executes the CLI over events, publishing `wicked.task.completed` back — instead of the default
   * in-process stdin/stdout subprocess path. OFF by default: existing callers keep the in-process path.
   *
   * Mechanism: the Rust actor honours `WICKED_BUS_EXEC` + `WICKED_BUS_DB` from the process
   * environment even on the plain `Core.spawn()` path (wicked-core `actor::run`), so we set those two
   * env vars BEFORE constructing the Core (the actor thread reads them at spawn time). If the
   * `cli-runner` cannot initialize (bus db unopenable / cursor unreadable) the engine logs and falls
   * back to the in-process path — it never silently wedges (wicked-core seam finding #4).
   */
  engineExec?: boolean;
  /** The wicked-bus SQLite db the exec seam publishes/consumes over. Required when `engineExec` is on. */
  busDbPath?: string;
}

/**
 * The `onboarding` def as the engine will actually resolve it for THIS repo.
 *
 * Bakes the repo's absolute paths into the static def (core#120). The static def's relative commands
 * are wrong at runtime: the run's workdir is the per-run WORKTREE, not the root the graph endpoint
 * reads, and estate's default db location (`.wicked-estate/graph.db`) is not where the engine looks.
 * The caller rewrites this per launch and hot-registers it, so a running actor sees it without a
 * restart. The db path comes from the ENGINE's record — hand-joining it here is what made the indexed
 * graph and the graph the worker queried two different files (FINDING-069).
 *
 * Pure, exported, and taking the repo record rather than an id, so the def it produces can be
 * asserted on without an engine handle. That matters beyond tidiness: this package's CI installs
 * `wicked-core-ts` from npm, whose published build predates `code_graph_db`, so anything reaching the
 * live launch path there dies on `codeGraphDb`'s (correct, loud) throw rather than on the property
 * under test. See `tests/onboarding-phases.test.ts` and FINDING-072.
 */
export function onboardingDefFor(repo: RepoEntry): WorkflowDef {
  const dbPath = codeGraphDb(repo);
  const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'onboarding')!;
  // Keyed by phase id. A phase with no entry here is left UNTOUCHED — which means it stays an agent
  // phase, silently turning a deterministic tool step into a council-less LLM one. That divergence is
  // what `onboarding-phases.test.ts` pins; keep this map and `base.phases` in step.
  const CMDS: Record<string, string[]> = {
    index: ['wicked-estate', 'index', repo.root_path, '--db', dbPath],
    annotate: ['wicked-estate', 'clusters', '--annotate', '--db', dbPath],
  };
  return {
    ...base,
    phases: base.phases.map((ph) =>
      CMDS[ph.id] ? { ...ph, executor: { type: 'tool', cmd: CMDS[ph.id]! } } : ph,
    ),
  };
}

/**
 * The single isolation boundary over wicked-core-ts. It holds the ONE `Core`
 * handle, makes the ONE `subscribe()` call for the whole process, parses each
 * CoreEvent, and re-emits it to registered in-daemon listeners. Every REST
 * endpoint and the WS fan-out funnel through this stable API — so when the
 * in-flight core-ts subscribe/teardown signature lands, only this file changes.
 */
export class CoreAdapter {
  private readonly core: CoreHandleFull;
  private readonly subscription: Subscription;
  private readonly listeners = new Set<CoreEventListener>();
  private closed = false;
  /** Built-in workflow ids whose overlay JSON has been written this process lifetime. */
  private readonly _builtinOverlayWritten = new Set<string>();

  /** `true` when this adapter armed the event-driven exec seam (for readiness/reporting). */
  readonly engineExec: boolean;
  /** The bus db the exec seam runs over when armed (else `undefined`). */
  readonly busDbPath: string | undefined;

  constructor(opts: CoreAdapterOptions) {
    // Arm the EVENT-DRIVEN execution-mediation seam BEFORE spawning the Core: the Rust actor reads
    // `WICKED_BUS_EXEC` + `WICKED_BUS_DB` from the process env at spawn time (wicked-core actor::run),
    // so they must be set before `Core.spawn()`/`Core.spawnStub()`. The seam is ENGINE-INDEPENDENT —
    // it publishes `task.dispatched` / consumes `task.completed` around WHATEVER step runner the engine
    // wires (the production wrapped-CLI runner OR the deterministic stub), so a stub engine can arm it
    // for a fast, offline, deterministic proof of the event path.
    const armExec = opts.engineExec === true;
    if (armExec) {
      if (!opts.busDbPath || opts.busDbPath.length === 0) {
        throw new Error('engineExec requires busDbPath (the wicked-bus db to mediate execution over)');
      }
      process.env['WICKED_BUS_EXEC'] = '1';
      process.env['WICKED_BUS_DB'] = opts.busDbPath;
    }
    this.engineExec = armExec;
    this.busDbPath = armExec ? opts.busDbPath : undefined;

    // Give the Rust actor the path to the wicked-core standalone binary so the gate-hook
    // command works when wicked-core is loaded as a napi-rs addon (where current_exe()
    // returns the Node.js interpreter, not wicked-core). The actor checks WICKED_CORE_EXE
    // first, so this env wins over the current_exe() fallback.
    if (!process.env['WICKED_CORE_EXE']) {
      const wcExe = locateWickedCoreExe();
      if (wcExe) process.env['WICKED_CORE_EXE'] = wcExe;
    }

    this.core = opts.stub ? Core.spawnStub(opts.dbPath) : Core.spawn(opts.dbPath);
    // The ONE subscribe() for the process. Error-first callback (index.d.ts:56):
    // one JSON string per CoreEvent, in emission order. A throw in a listener is
    // isolated so one bad consumer can never stall the pump or the others.
    this.subscription = this.core.subscribe((err, json) => {
      if (err) return;
      let event: CoreEvent;
      try {
        event = JSON.parse(json) as CoreEvent;
      } catch {
        return; // malformed frame — drop it rather than crash the pump
      }
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          /* isolate a faulty listener */
        }
      }
    });
  }

  /** Register a CoreEvent listener. Returns an unsubscribe function. */
  onEvent(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The production council roster (static), parsed to seats. */
  static roster(): unknown[] {
    return JSON.parse(Core.registryRoster()) as unknown[];
  }

  /** Liveness probe → `"ok"` (also proves the event pump). */
  ping(): Promise<string> {
    return this.core.ping();
  }

  /** Launch an interactive, resumable run → the run id. */
  async launchRun(input: LaunchRunInput): Promise<string> {
    const opts: LaunchOptions = {
      problem: input.problem,
      sessionId: input.sessionId,
      clisJson: input.clisJson,
    };
    if (input.entityMode !== undefined) opts.entityMode = input.entityMode;
    if (input.humanConfirm !== undefined) opts.humanConfirm = input.humanConfirm;
    if (input.repoRef !== undefined) opts.repoRef = input.repoRef;
    if (input.workflow !== undefined) {
      opts.workflow = input.workflow;
      // Ensure DROP-IN workflow definitions are present in the Rust overlay dir on first use.
      // Uses a dedicated helper (not registerWorkflow) to avoid adding built-ins to userWorkflows,
      // which would duplicate them in listWorkflows(). The write is skipped after the first call
      // per process lifetime.
      //
      // Ids core seeds itself are excluded: writing them shadows the real def with this stale
      // mirror — see CORE_SEEDED_WORKFLOWS. Core resolves those from its own registry, so there is
      // nothing to write and never was.
      const builtinDef = CORE_SEEDED_WORKFLOWS.has(input.workflow)
        ? undefined
        : BUILTIN_WORKFLOWS.find((w) => w.id === input.workflow);
      if (builtinDef && !this._builtinOverlayWritten.has(input.workflow)) {
        // Mark before await so concurrent launchRun() calls for the same builtin
        // don't both pass the has() check and race to write the same file.
        this._builtinOverlayWritten.add(input.workflow);
        await this._writeBuiltinOverlay(builtinDef);
      }
    }
    return this.core.launchRun(opts);
  }

  /** Resume a run from its persisted cursor → the status token. */
  resumeRun(runId: string): Promise<string> {
    return this.core.resumeRun(runId);
  }

  /** Resolve a human gate: approve (optional amend) or reject → the status token. */
  confirmGate(runId: string, approve: boolean, amend?: string): Promise<string> {
    return this.core.confirmGate(runId, approve, amend);
  }

  /** Cancel a run → the status token. */
  cancelRun(runId: string): Promise<string> {
    return this.core.cancelRun(runId);
  }

  /** Inject an operator message into a run's active PTY worker(s). target="all" or a CLI key. */
  injectWorkerMessage(runId: string, message: string, target: string): Promise<string> {
    if (typeof this.core.injectWorkerMessage !== 'function') {
      return Promise.reject(new Error('Operator message injection is not yet supported by this wicked-core build'));
    }
    return this.core.injectWorkerMessage(runId, message, target);
  }

  /**
   * A run's recorded event history, oldest first — or `null` when this wicked-core build has no
   * event-log read binding.
   *
   * `null` rather than `[]` on purpose. An empty history is a real, ordinary answer (a run that
   * emitted nothing, or one predating the log), and collapsing "nothing happened" into "I cannot
   * tell you what happened" is how a missing capability gets reported to an operator as an absent
   * gate — the FINDING-050 shape, distinct causes wearing one message. Callers branch on it.
   */
  async runEvents(runId: string): Promise<CoreEvent[] | null> {
    if (typeof this.core.runEvents !== 'function') return null;
    return JSON.parse(await this.core.runEvents(runId)) as CoreEvent[];
  }

  /** Run ids on the store. */
  async sessions(): Promise<string[]> {
    return JSON.parse(await this.core.sessions()) as string[];
  }

  /** Every run + its ordered units. */
  async sessionsDetail(): Promise<SessionView[]> {
    const views = JSON.parse(await this.core.sessionsDetail()) as SessionView[];
    // The Rust core always stores workflow_id as 'wf-<session-uuid>' (an instance ID, not the
    // definition name). Patch it back to the definition name so the studio's chat/work filters work.
    // phase_ref is only set on executed units and uses format 'wf-<uuid>:unit-N' (not the phase id).
    // The phase id is reliably embedded in the unit id as '<session-uuid>:<phase-id>'.
    for (const view of views) {
      if (view.session.workflow_id?.startsWith('wf-')) {
        const phases = [...view.units].sort((a, b) => a.ord - b.ord).map((u) => {
          const colonIdx = u.id.indexOf(':');
          return colonIdx >= 0 ? u.id.slice(colonIdx + 1) : '';
        });
        if (view.units.length === 1) {
          // Single-unit chat sessions have phase id 'explore' (from the chat workflow def).
          // 'u1' is ambiguous — it appears on any single-unit run without an explicit workflow,
          // including Do Work runs, so we leave those unpatched rather than misclassify them.
          const phase = phases[0] ?? '';
          if (phase === 'explore') view.session.workflow_id = 'chat';
        } else {
          // Multi-unit: match against builtin workflow defs by phase sequence
          const match = BUILTIN_WORKFLOWS.find(
            (def) => def.phases.length === phases.length &&
              def.phases.every((p, i) => p.id === phases[i]),
          );
          if (match) view.session.workflow_id = match.id;
        }
      }
    }
    return views;
  }

  /** A unit's captured transcript (string, or `null`). */
  async workOutput(unitId: string): Promise<string | null> {
    return JSON.parse(await this.core.workOutput(unitId)) as string | null;
  }

  // ── Chat sessions (core#134 / crew#165) ────────────────────────────────────

  async chatOpen(
    chatId: string,
    clis: string[],
    cwd?: string,
  ): Promise<{ cliKey: string; ok: boolean; error?: string }[]> {
    const raw = await this.core.chatOpen(chatId, JSON.stringify(clis), cwd ?? null);
    return JSON.parse(raw) as { cliKey: string; ok: boolean; error?: string }[];
  }

  async chatSend(
    chatId: string,
    text: string,
    targets?: string[],
    cwd?: string,
  ): Promise<string[]> {
    const raw = await this.core.chatSend(
      chatId,
      text,
      targets === undefined ? null : JSON.stringify(targets),
      cwd ?? null,
    );
    return JSON.parse(raw) as string[];
  }

  async chatSeats(chatId: string): Promise<string[]> {
    return JSON.parse(await this.core.chatSeats(chatId)) as string[];
  }

  /**
   * Every live chat, so an operator can find the ones nothing is going to close (FINDING-027).
   *
   * Chat sessions are a warm pool that deliberately outlives the page, and the only client that
   * knew a chat's id is the tab that minted it. Without this an orphaned seat is unreclaimable
   * short of restarting the daemon — the leak is real but invisible, which is the worse half.
   *
   * `idleSecs` is `number | null`, not `number`. The Rust side uses `u64::MAX` for "no activity
   * timestamp"; as an f64 that arrives as 18446744073709552000, which no caller can test for by
   * equality and every caller can accidentally do arithmetic on. The binding maps it to `null`.
   */
  async chatList(): Promise<ChatSummary[]> {
    const list = this.core.chatList;
    if (typeof list !== 'function') {
      throw new ChatUnsupportedError('Listing chats is not yet supported by this wicked-core build');
    }
    try {
      return JSON.parse(await list.call(this.core)) as ChatSummary[];
    } catch (err) {
      // A build without the ACP runner has the binding and refuses at call time, so the presence
      // check above cannot catch it. Classified here rather than at the route because this file is
      // the only one that touches the addon (DES-STUDIO-001 §5.2) — matching engine wording anywhere
      // else would spread that coupling.
      const text = err instanceof Error ? err.message : String(err);
      if (ENGINE_CHAT_UNSUPPORTED.test(text)) throw new ChatUnsupportedError(text);
      throw err;
    }
  }

  async chatClose(chatId: string): Promise<void> {
    await this.core.chatClose(chatId);
  }

  /** repo id → onboarding run id (in-memory; graph persists on disk across restarts). */
  private readonly repoOnboardRunIds = new Map<string, string>();
  /** repo ids with an onboarding run in flight — guards against concurrent double-launch. */
  private readonly onboardingInFlight = new Set<string>();
  /** Serializes onboarding launches: they rewrite the SHARED 'onboarding' overlay with
   *  repo-specific paths, so two repos launching concurrently must not interleave between
   *  overlay registration and launchRun (after launch the def is baked into the run's units). */
  private _onboardingChain: Promise<unknown> = Promise.resolve();

  /** Register a local git repo → the persisted `RepoEntry`. */
  async registerRepo(name: string, rootPath: string): Promise<RepoEntry> {
    return JSON.parse(await this.core.registerRepo(name, rootPath)) as RepoEntry;
  }

  /**
   * Clone a remote git URL, register it, then launch an `onboarding` workflow run.
   * `checkoutPath` overrides the default clone destination (`~/.wicked/repos/<name>`).
   */
  async cloneAndRegisterRepo(name: string, gitUrl: string, checkoutPath?: string): Promise<RepoOnboardRef> {
    const reposRoot = wickedDir('repos');
    let cloneDir: string;
    if (checkoutPath) {
      // Expand leading ~/ so callers can use home-relative paths.
      const expanded = checkoutPath.startsWith('~/')
        ? join(homedir(), checkoutPath.slice(2))
        : checkoutPath;
      if (!isAbsolute(expanded)) {
        throw new Error('checkoutPath must be an absolute path (or start with ~/)');
      }
      cloneDir = resolve(expanded);
    } else {
      cloneDir = join(reposRoot, name);
      // Defense-in-depth: name validated by schema, but guard direct calls too.
      // Use relative() instead of startsWith(root+'/') so this works cross-platform
      // (Windows uses backslash separators, making a literal '/' suffix check unreliable).
      const rel = relative(reposRoot, cloneDir);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        throw new Error('Unsafe repo name: would escape the repos directory');
      }
    }
    // Ensure the parent exists (first-run, nested checkoutPath, etc.) before the
    // atomic create below — recursive mkdir is safe for parents since we are not
    // the intended owner of those directories.
    await mkdir(resolve(cloneDir, '..'), { recursive: true });

    // Atomic exclusive mkdir: succeeds only if we created the directory, throws
    // EEXIST if it already existed. This is race-safe — recursive mkdir would
    // silently succeed for existing dirs, making weMadeDir unreliable.
    let weMadeDir = false;
    try {
      await mkdir(cloneDir);
      weMadeDir = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Directory already existed — verify it is actually a directory (not a file).
      await access(join(cloneDir, '.'));
    }

    let needsClone = true;
    try {
      await access(join(cloneDir, '.git'));
      needsClone = false;
    } catch { /* not yet cloned */ }

    if (needsClone) {
      try {
        await execFileAsync('git', ['clone', '--', gitUrl, cloneDir], {
          timeout: 5 * 60 * 1000,
        });
      } catch (err) {
        // Cleanup is best-effort: swallow any cleanup error so the original
        // clone failure is what the caller sees.
        if (weMadeDir) {
          await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
        } else {
          // Pre-existing dir: remove a partially-written .git so the next call
          // doesn't incorrectly skip cloning against a broken working tree.
          await rm(join(cloneDir, '.git'), { recursive: true, force: true }).catch(() => {});
        }
        throw err;
      }
    }

    const entry = await this.registerRepo(name, cloneDir);
    const runId = await this.launchOnboardingRun(entry.id, name);
    return { repoId: entry.id, runId };
  }

  /**
   * Launch the built-in `onboarding` workflow for a registered repo.
   * The run's `workdir` = the repo root; Tool phases run estate commands there.
   * Returns the run id so the UI can navigate directly to it.
   */
  async launchOnboardingRun(repoId: string, repoName: string): Promise<string> {
    if (this.onboardingInFlight.has(repoId)) {
      const existing = this.repoOnboardRunIds.get(repoId);
      if (existing) return existing;
    }
    this.onboardingInFlight.add(repoId);
    const runId = randomUUID();
    const chained = this._onboardingChain.then(() => this._doOnboardingLaunch(repoId, repoName, runId));
    this._onboardingChain = chained.catch(() => undefined);
    try {
      await chained;
      return runId;
    } finally {
      this.onboardingInFlight.delete(repoId);
    }
  }

  private async _doOnboardingLaunch(repoId: string, repoName: string, runId: string): Promise<void> {
    {
      const repoEntries = await this.listRepos();
      const repoEntry = repoEntries.find((r) => r.id === repoId);
      if (!repoEntry) throw new Error(`repo ${repoId} not registered`);
      const def = onboardingDefFor(repoEntry);
      // _writeBuiltinOverlay persists the overlay AND hot-registers it in the actor.
      //
      // This is the one place a core-seeded id is deliberately shadowed, and the shadow is the
      // point: `def` differs from core's `onboarding` only in carrying executor cmds baked with
      // this repo's resolved `--db` path. `launchRun` below no longer writes core-seeded ids
      // (CORE_SEEDED_WORKFLOWS), so nothing clobbers this write with the static mirror afterwards —
      // which it previously did, in the window between here and the engine resolving the workflow.
      await this._writeBuiltinOverlay(def);
      await this.launchRun({
        problem: `Onboard repository: ${repoName}`,
        sessionId: runId,
        clisJson: JSON.stringify(CoreAdapter.roster()),
        workflow: 'onboarding',
        repoRef: repoId,
      });
    }
    this.repoOnboardRunIds.set(repoId, runId);
  }

  /** Return the onboarding run id for a repo (undefined if not launched this session). */
  getOnboardRunId(repoId: string): string | undefined {
    return this.repoOnboardRunIds.get(repoId);
  }

  /** List every registered repo. */
  async listRepos(): Promise<RepoEntry[]> {
    return JSON.parse(await this.core.listRepos()) as RepoEntry[];
  }

  // ── Governance reads (crew#40) ──────────────────────────────────────────────

  /** All registered governance policies. */
  async listPolicies(): Promise<GovernancePolicy[]> {
    return JSON.parse(await this.core.listPolicies()) as GovernancePolicy[];
  }

  /** All conformance rules on the store. */
  async listConformanceRules(): Promise<ConformanceRule[]> {
    return JSON.parse(await this.core.listConformanceRules()) as ConformanceRule[];
  }

  /** All recorded conformance claims (governance decisions). */
  async listConformanceClaims(): Promise<GovernanceClaim[]> {
    return JSON.parse(await this.core.listConformanceClaims()) as GovernanceClaim[];
  }

  /** Front-half coverage gate report; null when the store has no graph nodes. */
  async getCoverageReport(): Promise<CoverageReport | null> {
    return JSON.parse(await this.core.getCoverageReport()) as CoverageReport | null;
  }

  // ── Governance writes (crew#42) ────────────────────────────────────────────

  /** Upsert a governance policy via the single-writer actor. */
  async upsertPolicy(policy: GovernancePolicy): Promise<void> {
    await this.core.upsertPolicy(JSON.stringify(policy));
  }

  /** Upsert a conformance rule via the single-writer actor. */
  async upsertConformanceRule(rule: ConformanceRule): Promise<void> {
    await this.core.upsertConformanceRule(JSON.stringify(rule));
  }

  /**
   * Withdraw a policy from enforcement. Resolves `true` if a policy with that id existed.
   *
   * Retire, not delete (FINDING-038): the node stays readable so a past decision citing this id is
   * still explicable, but governance stops selecting it. The boolean is what lets the route answer
   * 404 instead of reporting a success that removed nothing.
   */
  async retirePolicy(id: string): Promise<boolean> {
    const retire = this.core.retirePolicy;
    if (typeof retire !== 'function') {
      throw new Error('Retiring a policy is not yet supported by this wicked-core build');
    }
    return JSON.parse(await retire.call(this.core, id)) as boolean;
  }

  /** Withdraw a conformance rule from recall. Same contract as {@link retirePolicy}. */
  async retireConformanceRule(id: string): Promise<boolean> {
    const retire = this.core.retireConformanceRule;
    if (typeof retire !== 'function') {
      throw new Error('Retiring a conformance rule is not yet supported by this wicked-core build');
    }
    return JSON.parse(await retire.call(this.core, id)) as boolean;
  }

  /** Recall conformance rules matching a facet query (read-only, does not block actor). */
  async recallRulesPreview(query: Record<string, string | string[] | undefined>): Promise<ConformanceRule[]> {
    const cleanQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      // Fastify may parse duplicate params as arrays — take the first string value only.
      const scalar = Array.isArray(v) ? v[0] : v;
      if (typeof scalar === 'string' && scalar.length > 0) cleanQuery[k] = scalar;
    }
    const json = await this.core.recallRulesPreview(JSON.stringify(cleanQuery));
    return JSON.parse(json) as ConformanceRule[];
  }

  // ── Workflow viewer + builder (crew#44) ────────────────────────────────────
  // Built-ins are static TypeScript mirrors of workflow.rs. User-registered
  // workflows are added to `userWorkflows` and persisted to disk; the Rust actor
  // picks them up via `register_workflow` NAPI (when available) for immediate use.

  private readonly userWorkflows = new Map<string, WorkflowDef>();

  listWorkflows(): WorkflowDef[] {
    // Builtins first (stable ordering), but user-registered workflows take precedence when
    // ids conflict — consistent with getWorkflow() which prefers userWorkflows.get().
    const seen = new Set<string>();
    const result: WorkflowDef[] = [];
    for (const w of BUILTIN_WORKFLOWS) {
      const override = this.userWorkflows.get(w.id);
      if (!seen.has(w.id)) { seen.add(w.id); result.push(override ?? w); }
    }
    for (const w of this.userWorkflows.values()) {
      if (!seen.has(w.id)) { seen.add(w.id); result.push(w); }
    }
    return result;
  }

  getWorkflow(id: string): WorkflowDef | null {
    return this.userWorkflows.get(id) ?? BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null;
  }

  /** Write a built-in workflow definition to the Rust overlay dir (and hot-register when possible).
   *  Unlike registerWorkflow(), this does NOT touch userWorkflows, avoiding duplicates in listWorkflows(). */
  private async _writeBuiltinOverlay(def: WorkflowDef): Promise<void> {
    const dir = workflowOverlayDir();
    await mkdir(dir, { recursive: true });
    const overlayDef = { ...(def as WorkflowDef & { is_system?: boolean }) };
    delete overlayDef.is_system;
    await writeFile(join(dir, `${def.id}.json`), JSON.stringify(overlayDef, null, 2), 'utf8');
    const core = this.core as unknown as Record<string, unknown>;
    if (typeof core['registerWorkflow'] === 'function') {
      await (core['registerWorkflow'] as (j: string) => Promise<string>)(JSON.stringify(overlayDef));
    }
  }

  /**
   * Register a user-authored workflow: persist to the Rust workflow overlay dir
   * (`~/.config/wicked-core/workflows/<id>.json` or `$WICKED_WORKFLOWS_DIR`),
   * update the in-memory registry, and (when core supports it) register in the
   * Rust actor so runs using this workflow work immediately without a restart.
   */
  async registerWorkflow(def: WorkflowDef): Promise<string> {
    const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    if (!SAFE_ID.test(def.id) || def.id.length > 128) {
      throw new Error('workflow id must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores');
    }
    const dir = workflowOverlayDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${def.id}.json`);
    // Strip `is_system` before writing — the Rust core's overlay format does not recognise that
    // field and silently drops any workflow whose JSON it cannot fully deserialise.
    const overlayDef = { ...(def as WorkflowDef & { is_system?: boolean }) };
    delete overlayDef.is_system;
    await writeFile(path, JSON.stringify(overlayDef, null, 2), 'utf8');
    this.userWorkflows.set(def.id, def);

    // Hot-register in the Rust actor when the NAPI method is available.
    // Falls back gracefully if running against an older core build.
    const core = this.core as unknown as Record<string, unknown>;
    if (typeof core['registerWorkflow'] === 'function') {
      await (core['registerWorkflow'] as (j: string) => Promise<string>)(JSON.stringify(overlayDef));
    }
    return def.id;
  }

  /**
   * Save an inline script to `~/.wicked/scripts/<name>.<ext>`, make it executable,
   * and return the absolute path. Tool-executor phases use this path as their command.
   */
  async saveScript(name: string, content: string, lang: 'bash' | 'python' | 'sh'): Promise<string> {
    const ext = lang === 'python' ? 'py' : 'sh';
    const dir = wickedDir('scripts');
    await mkdir(dir, { recursive: true });
    const filename = `${name.replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
    const path = join(dir, filename);
    const shebang = lang === 'python' ? '#!/usr/bin/env python3\n' : '#!/usr/bin/env bash\n';
    await writeFile(path, shebang + content, 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  // ── PTY terminal sessions (DES-TERMINAL-001 §6) ────────────────────────────
  // Thin wrappers over the four core-ts terminal methods. Output does NOT return
  // here — it arrives as `terminalOutput` CoreEvents on the single subscription
  // (routed to the owning browser socket by the WS layer, keyed on the id these
  // resolve). Callers must already be attached via onEvent to catch the bytes.

  /**
   * Open a PTY terminal session in `cwd` running `cmd` (or the login shell when
   * omitted), sized `cols`x`rows`. `governed:true` keeps tool-calls routed through
   * the gate-hook (the default); `governed:false` is the loud, opt-in **ungoverned
   * operator shell** (DES-TERMINAL-001 §7). Resolves the new terminal id.
   */
  openTerminal(
    cwd: string,
    cmd: string[] | undefined,
    cols: number,
    rows: number,
    governed: boolean,
  ): Promise<string> {
    return this.core.openTerminal(cwd, cmd ?? null, cols, rows, governed);
  }

  /** Write raw input bytes (keystrokes) to a terminal → `"ok"`. Rejects on an unknown id. */
  writeTerminal(id: string, bytes: Buffer): Promise<string> {
    return this.core.writeTerminal(id, bytes);
  }

  /** Resize a terminal's PTY to `cols`x`rows` → `"ok"`. Rejects on an unknown id. */
  resizeTerminal(id: string, cols: number, rows: number): Promise<string> {
    return this.core.resizeTerminal(id, cols, rows);
  }

  /** Close a terminal (kill child, join reader) → `"ok"` after a `terminalExited` event. */
  closeTerminal(id: string): Promise<string> {
    return this.core.closeTerminal(id);
  }

  // ── System settings ───────────────────────────────────────────────────────

  async getSettings(): Promise<SystemSettings> {
    try {
      const raw = await readFile(settingsFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<SystemSettings>;
      // Validate numeric fields; drop anything out-of-range rather than propagate bad values.
      if ('graphNodeLimit' in parsed) {
        const v = parsed.graphNodeLimit;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10000) delete parsed.graphNodeLimit;
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    const path = settingsFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /**
   * Tear down the single subscription (stop delivery, release the pump thread +
   * callback) so the process can exit cleanly. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.subscription.close();
  }
}
