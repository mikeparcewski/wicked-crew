import { createRequire } from 'node:module';
import { mkdir, access, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Core as CoreHandle, LaunchOptions, Subscription } from 'wicked-core-ts';
import type {
  CoreEvent,
  LaunchRunInput,
  RepoEntry,
  RepoOnboardRef,
  SessionView,
  RecordedEvent,
  GovernancePolicy,
  ConformanceRule,
  GovernanceScoreboard,
  GovernanceClaim,
  SteeringImportEntry,
  SteeringImportResult,
  GovernanceEvalReport,
  GovernanceEvalSample,
  ImportEvalCorpusResponse,
  CoverageReport,
  GraphKind,
  WorkflowDef,
  CrewSystemSettings,
  Project,
  ProjectMember,
  InteractionRequest,
  Campaign,
  CampaignDef,
} from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { execCapped } from './exec.js';
import { composeDeliverWorkflow, DELIVER_PHASE_ID } from './deliver.js';
import { CAMPAIGN_WORKFLOW_PREFIX } from '../campaigns/plan.js';
import { composeDeliverableFloor } from './deliverable-floor.js';



/** Resolved path under the user's home directory. */
function wickedDir(...parts: string[]): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', ...parts);
}

/**
 * Parse a JSON string a napi binding returned. The bindings type their return loosely (`unknown`
 * until a `ts_return_type` regen), so guard BOTH a non-string return and invalid JSON with an error
 * that names the method — a bare `JSON.parse` throw is an unactionable "Unexpected token" (crew#227
 * review). At the current engine contract `raw` is always a valid JSON string.
 */
function parseEngineJson<T>(raw: unknown, method: string): T {
  if (typeof raw !== 'string') {
    throw new Error(`${method}: expected a JSON string from the engine, got ${typeof raw}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(
      `${method}: engine returned invalid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
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

/** Where the daemon persists system settings. Exported so tests write fixtures to the ONE
 *  spelling of this path (the tests/ tree is audited against spelling core paths itself). */
export function settingsFilePath(): string {
  return join(homedir(), '.config', 'wicked-core', 'settings.json');
}

/**
 * Per-key ceiling on a `studio.*` settings value, as the UTF-8 byte length of its JSON form.
 *
 * The same 512KiB limit `PUT /settings` enforces (`STUDIO_SETTINGS_MAX_BYTES`, api/routes.ts) —
 * restated rather than imported because routes.ts imports THIS module, so a shared constant here
 * would close an import cycle. The two spellings must stay in step; the read-path test restates
 * the number a third time so a change to either side breaks a test rather than a deployment.
 */
const STUDIO_SETTINGS_MAX_BYTES = 512 * 1024;

/** Read user-registered workflow overlays from `dir` (the same dir `registerWorkflow` writes to).
 *
 * Skips: files whose id matches a built-in (those are `_writeBuiltinOverlay` artifacts written FOR
 * the Rust actor, not user workflows — including them would duplicate a built-in in `listWorkflows`),
 * non-`.json` files, and any file that does not parse into a `{id, phases[]}` shape (the Rust actor
 * skips an unreadable overlay too, so crew must not surface one it can't). A missing dir yields `[]`.
 *
 * Exported so the FINDING-002 restart-hydration path is unit-testable without spawning a Core. */
export function readOverlayWorkflows(
  dir: string,
  builtinIds: ReadonlySet<string>,
): WorkflowDef[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // no overlay dir yet → nothing registered
  }
  const out: WorkflowDef[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (builtinIds.has(id)) continue; // a built-in overlay, not a user workflow
    // A composed campaign-node workflow (TH-9): persisted here so the Rust actor reloads it at
    // startup (a fresh-process resumeCampaign re-dispatches pending nodes by workflow id), but
    // it is one node's private plumbing, not a user workflow — keep it out of the catalog.
    if (id.startsWith(CAMPAIGN_WORKFLOW_PREFIX)) continue;
    try {
      const def = JSON.parse(readFileSync(join(dir, file), 'utf8')) as WorkflowDef;
      if (def && typeof def.id === 'string' && Array.isArray(def.phases)) out.push(def);
    } catch {
      // Unparseable overlay — core would skip it at load, so crew skips it too.
    }
  }
  return out;
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
  // FINDING-009: coverage for ONE registered repo, computed over that repo's OWN code graph (not the
  // vacuous daemon store). Returns a JSON string like `getCoverageReport`; an unknown repo REJECTS.
  getCoverageReportForRepo(repoRef: string): Promise<string>;
  // #122: node-count-by-kind summary of ONE repo's code graph, over that repo's OWN store. Returns a
  // JSON string (array of {kind,count}); an unknown repo REJECTS.
  getGraphKindsForRepo(repoRef: string): Promise<string>;
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
  // The AW-23 wiki population/connection scoreboard (wiki-mgmt). Resolves to a JSON
  // `Scoreboard` object; `docsRoot` (nullable) is the same docs root `rules ingest --dir` used,
  // without which the typing half reports `available: false` in-band. Optional for the same
  // reason as `retirePolicy` above: the binding ships in wicked-core-ts ≥ 0.7.4, so an installed
  // addon at ≤ 0.7.3 does not have it at runtime — a required declaration would type away the
  // presence gate `wikiScoreboardSupported` exists to keep meaningful.
  governanceScoreboard?(docsRoot?: string | null): Promise<string>;
  // RuleSet rows (the `NodeKind::RuleSet` doctrine parents, AW-13) as a JSON array — the wiki
  // meta's "is anything seeded" half. Optional and not hypothetically: NO released addon carries
  // it yet, so `countRuleSets` answers `null` ("cannot count") rather than a fabricated 0 until
  // one does.
  listRuleSets?(): Promise<string>;
  // STEERING batch import (the unified steering-rule model, wicked-core-ts ≥ 0.7.5). Takes a
  // JSON `{ default_type: string | null, entries: SteeringImportEntry[] }` batch, runs EVERY
  // entry — frontmattered markdown doc or ready rule JSON — through the engine's ingest
  // normalize/validate path on the single-writer actor (fail-closed PER ENTRY), and resolves to
  // a JSON array of per-entry `SteeringImportResult`s.
  //
  // Optional for the same reason as `retirePolicy` above, and it is also THE presence sentinel
  // for the whole steering seam (`steeringSupported()`): the 0.7.5 addon ships the unified model
  // (steering_type / applies_to / excludes / weight / effect on ConformanceRule, policy-row
  // migration) and this binding together, so its presence is what tells crew the engine will
  // round-trip the steering fields instead of silently dropping them (ConformanceRule has no
  // `deny_unknown_fields` — an old engine ACCEPTS a steering-field write and persists a rule
  // that enforces differently than the caller wrote).
  steeringImport?(batchJson: string): Promise<string>;
  // TESTING surface (crew-testing): governance EVALS over the steering-rule store. Takes a JSON
  // `{ type?, corpus?, knowledgeDb?, dbPath }` args object and resolves to the serde
  // `GovernanceEvalReport` JSON (snake_case — passed through to the wire verbatim).
  //
  // Optional for the same reason as `retirePolicy` above, and not hypothetically: the binding
  // ships with wicked-core-ts 0.7.5 which is UNRELEASED — the installed 0.7.4 addon does not
  // carry it, and this presence is THE sentinel for the whole evals seam
  // (`governanceEvalsSupported()`), corpus import included.
  governanceEvals?(argsJson: string): Promise<string>;
  // Companion write half: import a named eval corpus (`{ name, samples, knowledgeDb }` args
  // JSON) into the knowledge store under the `evals:<name>` scope. Resolves to a JSON
  // `{ imported, scope, embedded }` object. Ships with `governanceEvals` (0.7.5).
  governanceCorpusImport?(argsJson: string): Promise<string>;
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

/**
 * Projects + durable interaction requests (DES-PROJECT-001).
 *
 * ALL optional, deliberately: these bindings land with wicked-core-ts 0.6.0, so an installed
 * addon at ≤0.5.x has none of them at runtime. Required declarations would type away the
 * `typeof … !== 'function'` guards below — the FINDING-042 shape. Every method resolves a JSON
 * string (the addon's uniform marshalling).
 */
type ProjectMethods = {
  projectCreate?(name: string, description?: string | null): Promise<string>;
  projectUpdate?(
    id: string,
    name?: string | null,
    description?: string | null,
    status?: string | null,
  ): Promise<string>;
  projectList?(): Promise<string>;
  projectGet?(id: string): Promise<string>;
  projectMembers?(projectId: string): Promise<string>;
  projectMemberAttach?(
    projectId: string,
    memberKind: string,
    memberRef: string,
    metaJson?: string | null,
    attachedBy?: string | null,
  ): Promise<string>;
  projectMemberDetach?(projectId: string, memberId: string): Promise<string>;
  memberProjects?(memberKind: string, memberRef: string): Promise<string>;
  interactionRequests?(sessionId?: string | null, status?: string | null): Promise<string>;
  // The foundation-record seam (ADR §3.2): charter writes + record probes ride the actor's
  // existing memory/knowledge stores (single-writer sidecars the daemon must never open itself).
  captureMemory?(content: string, scope: string): Promise<string>;
  listMemories?(scope: string, limit: number): Promise<string>;
  ingestKnowledge?(title: string, chunksJson: string): Promise<string>;
  recallKnowledge?(query: string, k: number): Promise<string>;
};

/**
 * The campaign scheduler bindings (DES-CAMPAIGN-001 / TH-9). ALL optional, same doctrine as
 * `ProjectMethods`: they land after wicked-core-ts 0.7.2, so the installed addon may not carry
 * them at runtime, and required declarations would type away the `typeof … !== 'function'`
 * guards below (the FINDING-042 shape). Every method resolves a JSON string or a status token.
 */
type CampaignMethods = {
  /** `defJson` = engine-wire `CampaignDef` JSON (snake_case). Resolves to the campaign id. */
  launchCampaign?(defJson: string): Promise<string>;
  /** Resolves to the campaign status token (`running` | … | `cancelled`); rejects when unknown. */
  resumeCampaign?(id: string): Promise<string>;
  /** Resolves to the campaign status token; rejects when unknown. */
  cancelCampaign?(id: string): Promise<string>;
  /** Resolves to a `Campaign` JSON object, or the JSON literal `null` when unknown. */
  campaignDetail?(id: string): Promise<string>;
  /** Resolves to a JSON array of `Campaign` objects (read-only store connection). */
  campaignList?(): Promise<string>;
};

type CoreHandleFull = CoreHandle &
  GovernanceMethods &
  ChatMethods &
  EventLogMethods &
  ProjectMethods &
  CampaignMethods;

/** The napi constructor surface — the static factories live on the class object. */
interface CoreConstructor {
  spawn(path: string): CoreHandleFull;
  spawnStub(path: string): CoreHandleFull;
  registryRoster(): string;
}

const { Core } = require('wicked-core-ts') as { Core: CoreConstructor };

/**
 * Does the installed wicked-core-ts addon understand `LaunchOptions.extraWriteRoots` (≥ 0.6.1)?
 *
 * A napi object silently IGNORES fields the addon doesn't declare, so passing the option to an
 * older addon would launch a run whose boundary never widened — the worker then gets a boundary
 * deny on the very deliverable path the caller declared (the crew#263 failure, resurrected
 * silently). Fail CLOSED on version instead: same doctrine as the `projectId` guard below.
 */
function addonSupportsExtraWriteRoots(): boolean {
  return addonAtLeast(0, 6, 1);
}

/**
 * Does the installed addon understand `LaunchOptions.projectGraph` (≥ 0.7.1)?
 *
 * Same doctrine, different cost of being wrong. A silently-dropped binding does not deny anything —
 * it launches a run whose workers quietly see one repo while the launcher recorded that they see
 * the project. The daemon would then log "bound to the project graph as 'wicked-core'" for a run
 * that never was, which is worse than not binding at all: the operator's evidence about what the
 * run could see becomes false. Fail closed and keep the log honest.
 */
function addonSupportsProjectGraph(): boolean {
  return addonAtLeast(0, 7, 1);
}

/**
 * Is the installed `wicked-core-ts` at least `maj.min.pat`?
 *
 * ONE version reader for every capability gate, because the parsing rule here is load-bearing and
 * was already got wrong once: `split('.').map(Number)` returns NaN on a pre-release or build suffix
 * (`0.6.1-beta.1`), which fails a perfectly capable addon closed (Copilot on #263). Matching only
 * the numeric MAJOR.MINOR.PATCH prefix fixes that, and a second copy of the fix is a second chance
 * to lose it. No match ⇒ unparseable ⇒ fail closed.
 */
function addonAtLeast(maj: number, min: number, pat: number): boolean {
  try {
    const pkg = require('wicked-core-ts/package.json') as { version?: string };
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(pkg.version ?? '');
    if (!m) return false;
    const got = [Number(m[1]), Number(m[2]), Number(m[3])];
    const want = [maj, min, pat];
    for (let i = 0; i < 3; i += 1) {
      if (got[i]! > want[i]!) return true;
      if (got[i]! < want[i]!) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Built-in workflow definitions (crew#44) ──────────────────────────────────
// Static mirrors of wicked-core workflow defs: feature, bug, migration, survey-repo,
// domain-graph-slice, memories, collab, onboarding, chat, and domain-extraction.
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
 * The write exists for the ids core does NOT seed (chat, survey-repo, domain-graph-slice,
 * memories, domain-extraction): for those the overlay is the only reason they resolve at all, so
 * it stays.
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
const EVIDENCE_FLOOR_PIN = 'e2e7af1db9e48454';

export const BUILTIN_WORKFLOWS: WorkflowDef[] = [
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
      { id: 'index', executor: { type: 'tool', cmd: ['wicked-estate', 'index', '{repo_root}', '--db', '{code_graph_db}'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'annotate', executor: { type: 'tool', cmd: ['wicked-estate', 'clusters', '--annotate', '--db', '{code_graph_db}'] }, kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['index'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      // index → annotate, and NOT a third `domain` phase running `wicked-core domain-graph`. That
      // phase could never pass: domain-graph fails closed below 1.0 front-half coverage, and nothing
      // in this workflow annotates a single symbol, so coverage was 0.0 on every repo — every
      // registration ended sessionFailed after the two phases that matter had both succeeded
      // (FINDING-068). domain-graph belongs to `domain-extraction`, downstream of the agentic
      // extract+coverage phases that produce its precondition. Mirrors core's `onboarding_def()`.
      //
      // The `{repo_root}` / `{code_graph_db}` placeholders are core's, substituted per run from the
      // launch's `repoRef` (wicked-core#179). This package used to bake absolute paths in here and
      // write the result to one shared overlay file per launch — which concurrent registrations
      // raced, indexing one repo's tree under another repo's name (FINDING-075, #196).
    ],
  },
  {
    id: 'feature',
    phases: [
      { id: 'clarify', kind: 'recon', gate_type: 'value', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'design', kind: 'recon', gate_type: 'strategy', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['clarify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'build', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['design'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'adversarial-review', kind: 'review', gate_type: 'execution', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['build'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
      { id: 'test', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['build'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: EVIDENCE_FLOOR_PIN },
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
    // MUST stay byte-identical to wicked-core/workflows/survey-repo.json — crew's overlay write is the
    // ONLY def the engine resolves at runtime (core does not seed survey-repo), so a stale mirror here
    // silently runs the OLD def. The pre-fix mirror carried 3 phases with no `instructions` and no
    // `synthesize`, so survey-repo ran 3 near-identical prompts and produced no run-level synthesis —
    // exactly FINDING-011, still live because the fix only landed in the core JSON the runtime ignores.
    // Guarded by builtin-overlay-shadow.test.ts (survey-repo is now in MIRRORED_IDS).
    id: 'survey-repo',
    is_system: true,
    phases: [
      { id: 'structure', kind: 'recon', instructions: 'Map the repository layout only: top-level directories, entry points, and where source, tests, config, and docs live. Do not analyze languages, dependencies, or conventions — later phases cover those.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'stack', kind: 'recon', instructions: 'Identify the technology stack from the manifests (package.json, Cargo.toml, pyproject.toml, ...): languages, frameworks, build tools, key dependencies. Build on the structure summary provided as prior context; do not re-map the layout.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['structure'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'conventions', kind: 'recon', instructions: 'Identify the working conventions: naming, module boundaries, test placement and style, lint/format configuration, CI expectations. Build on the prior phases\' outputs provided as context; do not re-survey structure or stack.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['stack'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'synthesize', kind: 'recon', instructions: 'Do not re-survey the repository. Merge the three prior phase outputs provided as context into one coherent survey — structure, then stack, then conventions — resolving overlaps and flagging any contradictions between them.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['structure', 'stack', 'conventions'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
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
    // "Add with chat" for the Steering surface (STEERING program) — the dedicated entry point
    // behind POST /governance/steering/author. TH-12 propose-as-gate: the run analyzes the
    // operator's intent + the named files/dirs, then the TERMINAL `propose` phase emits the
    // PROPOSED steering rules and its unconditional human gate pauses the run `awaiting_human`
    // (core evaluates a terminal phase's own gate before finalize — seam finding #4), so the
    // operator approves/amends/rejects via the standard POST /runs/:id/gate. Approved rules land
    // through the governed rules CRUD with `provenance.source: "chat"` — the run itself must
    // never write the store, which is why both phases say so out loud.
    //
    // Crew-authored drop-in (like `chat`): NOT in CORE_SEEDED_WORKFLOWS, so launchRun's
    // `_writeBuiltinOverlay` write is the only way core resolves the id — the same delivery
    // mechanism every crew drop-in uses.
    id: 'steering-author',
    is_system: true,
    phases: [
      { id: 'analyze', kind: 'recon', instructions: 'Read the operator intent and every file or directory listed in the problem statement. Identify candidate steering rules: durable, prescriptive statements a coding agent must follow, each classified into one steering type (architecture, development, security, testing, operations, compliance, design-ux). For each candidate note the statement, steering type, severity, and the evidence in the source material. Analysis only — do not write any rule to any store, and do not emit final rule JSON yet.', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'propose', kind: 'recon', instructions: 'From the prior analysis, emit the PROPOSED steering rules as one JSON array. Each entry is a conformance-rule object: id (PAT-<digits> for rule_type "pattern", POL-<digits> for "policy"), rule_type, statement, severity (info|warn|error|critical), confidence (0..1), targets, steering_type (default to the type named in the problem statement), provenance {"source":"chat"}, and — only where the source material supports them — the enforcement fields applies_to, excludes, weight, effect, trigger, obligations, criteria. This output is a PROPOSAL for the human gate: rules land in the store only after approval, via the governance rules API — do not write them yourself.', gate_type: 'value', gate: { human_confirm: { unconditional: true } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['analyze'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
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
      // required_deliverables reconciled with core (wicked-core/workflows/domain-extraction.json):
      // survey/analyze/extract annotate the estate STORE and domain-graph now PERSISTS the graph
      // into the store (not a JSON file), so their evidence is DB state — verified by the coverage
      // gate (reads the store) and domain-graph's fail-closed-on-coverage<1.0 — not a worktree file.
      // Only coverage emits a genuine standalone report the deterministic floor reads. Declaring
      // phantom files failed every phase under core's FINDING-101 deliverable gate.
      { id: 'survey', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'analyze', kind: 'recon', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['survey'], role: 'neutral', skill_ref: 'wicked-garden-domain', allowed_skills: [], validator_pin: null },
      { id: 'extract', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['analyze'], role: 'creator', skill_ref: 'wicked-garden-domain-extractor', allowed_skills: [], validator_pin: null },
      { id: 'coverage', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: ['coverage-report.json'], depends_on: ['extract'], role: 'evaluator', skill_ref: 'wicked-garden-domain-coverage', allowed_skills: [], validator_pin: 'bfe4020a365c598b' },
      // domain-graph is a DETERMINISTIC Tool that runs `wicked-core domain-graph`, which PERSISTS the
      // domain/requirement/rule graph into the repo store (core#237) — not an LLM skill that could hit
      // a non-persisting hermetic fallback. Mirrors wicked-core/workflows/domain-extraction.json.
      { id: 'domain-graph', executor: { type: 'tool', cmd: ['wicked-core', 'domain-graph', '--db', '{code_graph_db}', '--out', 'requirements_graph.json'] }, kind: 'build', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['coverage'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
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

/**
 * The project surface (DES-PROJECT-001) is not available in this deployment — the installed
 * wicked-core-ts predates 0.6.0. Typed for the same reason as `ChatUnsupportedError`: the routes
 * answer 501 ("upgrade the engine") on this, never 400 ("fix your request").
 */
export class ProjectsUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not supported by this wicked-core build (needs wicked-core-ts >= 0.6.0)`);
    this.name = 'ProjectsUnsupportedError';
  }
}

/**
 * `resolveElicitation` is not available in this deployment — the NAPI binding has not
 * landed in the installed `wicked-core-ts` yet (DES-002 §4 P-1 stub).
 *
 * Routes map this to HTTP 501 so an operator knows to upgrade rather than to fix a
 * call that was already correct.
 */
export class ElicitationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElicitationUnsupportedError';
  }
}

/**
 * The campaign surface (DES-CAMPAIGN-001 / TH-9) is not available in this deployment — the
 * installed wicked-core-ts predates the campaign bindings. Typed for the same reason as
 * `ChatUnsupportedError`: the routes answer 501 ("upgrade the engine") on this, never 400
 * ("fix your request"). Gated on METHOD PRESENCE rather than a version floor because the
 * bindings ship in the next core-ts release whose number is the release train's to pick —
 * a presence check is true on whatever version actually carries them.
 */
export class CampaignsUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not supported by this wicked-core build (the installed wicked-core-ts has ` +
        'no campaign bindings — upgrade it to a release carrying launchCampaign)',
    );
    this.name = 'CampaignsUnsupportedError';
  }
}

/**
 * The wiki scoreboard (AW-23 / wiki-mgmt) is not available in this deployment — the installed
 * wicked-core-ts predates the `governanceScoreboard` binding (ships in ≥ 0.7.4). Typed for the
 * same reason as `ChatUnsupportedError`: the route answers 501 ("upgrade the engine") on this,
 * never 400 ("fix your request"). Gated on METHOD PRESENCE, the campaigns doctrine — true on
 * whatever release actually carries the binding.
 */
/**
 * The unified steering-rule model (STEERING program) is not available in this deployment —
 * wicked-core-ts predates the `steeringImport` binding (ships in ≥ 0.7.5, alongside the model
 * merge). Typed for the same reason as `ChatUnsupportedError`: the routes answer 501 ("upgrade
 * the engine") on this, never 400 ("fix your request") — and never the WORSE failure of passing
 * a steering-field write through to an engine that would silently drop the fields.
 */
export class SteeringUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not supported by this wicked-core build (the installed wicked-core-ts addon ` +
        'has no steeringImport binding — upgrade it to a release carrying the unified steering ' +
        'model, >= 0.7.5)',
    );
    this.name = 'SteeringUnsupportedError';
  }
}

/**
 * The installed engine addon predates the governance-evals surface (crew-testing; the
 * `governanceEvals` + `governanceCorpusImport` bindings ship with wicked-core-ts 0.7.5, which is
 * unreleased at the time this seam lands). Typed for the same reason as `SteeringUnsupportedError`:
 * the testing routes answer 501 ("upgrade the engine") on this, never 400 ("fix your request") —
 * and they must not crash a daemon running against the released 0.7.4 addon.
 */
export class GovernanceEvalsUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not supported by this wicked-core build (the installed wicked-core-ts addon ` +
        'has no governanceEvals binding — upgrade it to a release carrying the governance ' +
        'evals surface, >= 0.7.5)',
    );
    this.name = 'GovernanceEvalsUnsupportedError';
  }
}

export class GovernanceScoreboardUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not supported by this wicked-core build (the installed wicked-core-ts has ` +
        'no governanceScoreboard binding — upgrade it to a release carrying it, >= 0.7.4)',
    );
    this.name = 'GovernanceScoreboardUnsupportedError';
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
 * Quarantine a pre-#197 `onboarding.json` left in the overlay dir.
 *
 * This package used to write that file on every launch, baked with ONE repo's absolute paths. It no
 * longer does — core declares `{repo_root}` / `{code_graph_db}` and binds them per run
 * (wicked-core#179). But the overlay dir is PERSISTENT STATE, and the engine's `load_dir` registers
 * whatever it finds there, replacing a compiled def by id, wholesale.
 *
 * So an upgraded deployment keeps running the last file the old code wrote. Not intermittently:
 * EVERY onboarding run indexes whichever repo happened to be registered last before the upgrade.
 * Observed exactly that on this host after #197 merged — three fresh registrations in three
 * different orgs all indexed `agentic-products/eliza`, the last repo seeded before the fix.
 *
 * Renamed rather than deleted. The file is almost certainly machine-written, but the overlay dir is
 * an operator-facing extension point and silently destroying something out of it is not this
 * process's call. The rename is enough to stop the shadow, and leaves the evidence in place.
 */
function quarantineStaleOnboardingOverlay(): void {
  const stale = join(workflowOverlayDir(), 'onboarding.json');
  if (!existsSync(stale)) return; // the ordinary case on a clean install

  // Only a PRE-#197 artifact, never an operator's override. `registerWorkflow()` writes user
  // definitions into this same directory, and parking one on every boot would delete a deliberate
  // customization each time it was re-registered.
  //
  // The signature is specific: old crew baked one repo's ABSOLUTE paths into the tool commands. A
  // def carrying `{repo_root}` / `{code_graph_db}`, or agent phases, or relative commands, is not
  // what this is looking for and is left alone. An operator who hand-writes absolute paths into a
  // shared def has written the same bug, and gets the same treatment for the same reason.
  let bakedPaths: string[];
  try {
    const def = JSON.parse(readFileSync(stale, 'utf8')) as {
      phases?: { executor?: { type?: string; cmd?: string[] } }[];
    };
    bakedPaths = (def.phases ?? [])
      .flatMap((p) => (p.executor?.type === 'tool' ? (p.executor.cmd ?? []) : []))
      .filter((arg) => arg.startsWith('/'));
  } catch {
    // Unparseable: not ours to judge. The engine reports its own load failure.
    return;
  }
  if (bakedPaths.length === 0) return;

  const parked = `${stale}.superseded-by-crew197`;
  try {
    renameSync(stale, parked);
    console.warn(
      `[onboarding] removed a stale overlay that would have hijacked every onboarding run: ` +
        `${stale} → ${parked}. It baked ${bakedPaths[0]} into a def shared by every repo, which is ` +
        `what a pre-#197 crew wrote; the engine resolves it in preference to the built-in ` +
        `(FINDING-075).`,
    );
  } catch (err) {
    // Loud, and non-fatal: the daemon still starts, but every onboarding on this host is wrong
    // until the file goes, so the operator has to be told rather than left to discover it.
    console.error(
      `[onboarding] FAILED to remove the stale overlay at ${stale}: ${
        err instanceof Error ? err.message : String(err)
      }. Until it is removed by hand, every onboarding run will index the repo baked into it, ` +
        `whatever repo the run names (FINDING-075).`,
    );
  }
}

/** The ids of a workflow's phases that carry a HUMAN gate (`human_confirm` unconditional, or the
 * conditional `human_confirm_if`) — i.e. the phases that will PAUSE for a person.
 *
 * FINDING-023 (residual): core#208 made a workflow's phase gate deliberately WIN over a run-level
 * `humanConfirm: none` (it pauses, with a self-disclosing note), but there was no way to learn a
 * workflow's gates BEFORE launching it — an operator picking `none` for an unattended run only found
 * out when it paused. Surfacing this on `GET /workflows/:id` is that missing launch-time signal.
 * `'auto'` (the string form) is NOT a human gate. */
export function humanGatePhaseIds(wf: WorkflowDef): string[] {
  return wf.phases
    .filter(
      (p) =>
        typeof p.gate === 'object' &&
        p.gate !== null &&
        ('human_confirm' in p.gate || 'human_confirm_if' in p.gate),
    )
    .map((p) => p.id);
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

  /**
   * The estate db the Core actor was spawned over (`CoreAdapterOptions.dbPath` — the `--db`
   * flag / `~/.wicked-crew/core.db` default). Kept because some engine bindings take the db
   * path as an ARG rather than reading the actor's own handle (`governanceEvals` runs its evals
   * over a read-only connection to this same store); crew resolves it here, the one place the
   * path is already known, so no route grows a second spelling of where the store lives.
   */
  readonly dbPath: string;
  /** `true` when this adapter armed the event-driven exec seam (for readiness/reporting). */
  readonly engineExec: boolean;
  /** The bus db the exec seam runs over when armed (else `undefined`). */
  readonly busDbPath: string | undefined;
  /**
   * `true` when this adapter drives the DETERMINISTIC OFFLINE engine (`Core.spawnStub`) rather
   * than the production one — i.e. the `StubDispatcher` (every seat votes for the first roster
   * option, no subprocess) plus the `StubStepRunner` (fixed text, no CLI).
   *
   * Exposed, not private, because a stub engine is not a quieter production engine — it is a
   * FABRICATOR. Every phase resolves Ok in under a millisecond, so a run narrates its whole
   * governed lifecycle, gate approvals included, with no work behind any of it. Anything that
   * lets this daemon answer OTHER products' traffic has to be able to ask (see
   * `api/server.ts`, crew#309).
   */
  readonly stub: boolean;

  constructor(opts: CoreAdapterOptions) {
    // Arm the EVENT-DRIVEN execution-mediation seam BEFORE spawning the Core: the Rust actor reads
    // `WICKED_BUS_EXEC` + `WICKED_BUS_DB` from the process env at spawn time (wicked-core actor::run),
    // so they must be set before `Core.spawn()`/`Core.spawnStub()`. The seam is ENGINE-INDEPENDENT —
    // it publishes `task.dispatched` / consumes `task.completed` around WHATEVER step runner the engine
    // wires (the production wrapped-CLI runner OR the deterministic stub), so a stub engine can arm it
    // for a fast, offline, deterministic proof of the event path.
    // BEFORE the Core spawns: the actor reads the overlay dir at startup, so a stale
    // `onboarding.json` has to be out of the way by then or it shadows the built-in def.
    quarantineStaleOnboardingOverlay();

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

    this.stub = opts.stub === true;
    this.dbPath = opts.dbPath;
    this.core = this.stub ? Core.spawnStub(opts.dbPath) : Core.spawn(opts.dbPath);
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
    if (input.projectId !== undefined) {
      // Fail CLOSED on an old addon: silently dropping projectId would launch an unfiled run the
      // caller believed was filed — the exact failure §2.2 exists to prevent.
      if (typeof this.core.projectCreate !== 'function') {
        throw new ProjectsUnsupportedError('Filing a run into a project');
      }
      opts.projectId = input.projectId;
    }
    if (input.extraWriteRoots !== undefined && input.extraWriteRoots.length > 0) {
      // Fail CLOSED on an old addon (napi ignores undeclared fields): a silently-dropped
      // widening resurrects the crew#263 boundary deny on the declared deliverable path.
      if (!addonSupportsExtraWriteRoots()) {
        throw new Error(
          'extraWriteRoots needs wicked-core-ts >= 0.6.1; the installed addon would silently ' +
            'ignore it and the run would be denied writing its own deliverable',
        );
      }
      opts.extraWriteRoots = input.extraWriteRoots;
    }
    if (input.projectGraph !== undefined) {
      // Fail CLOSED on an old addon (napi ignores undeclared fields): the run would silently get
      // its repo's graph while everything on this side recorded that it got the project's.
      if (!addonSupportsProjectGraph()) {
        throw new Error(
          'projectGraph needs wicked-core-ts >= 0.7.1; the installed addon would silently ignore ' +
            'it and the run would see one repo while the daemon logged that it saw the project',
        );
      }
      // The two invariants the TYPE cannot express, enforced where the launch is actually
      // assembled (Copilot on #327). Both are cross-field, so `projectGraph`'s own shape can never
      // carry them, and `core/types.ts` says as much rather than pretending the compiler helps.
      //
      // Loud, not lenient. Every one of these is a CALLER bug, and the failure it would otherwise
      // produce is the silent kind this whole slice exists to end: a run that reports one thing
      // about what it could see and observes another. `resolveProjectGraphBinding` — the only
      // producer today — satisfies both on every arm, so a throw here means a new caller got it
      // wrong, which is exactly when you want to hear about it.
      if (input.projectId === undefined) {
        throw new Error(
          'projectGraph is the PROJECT\'s graph, so the run must be filed into that project: ' +
            'pass projectId alongside it, or omit projectGraph and let the run use its repo graph',
        );
      }
      if (input.repoRef !== undefined && input.projectGraph.repoLabel === undefined) {
        throw new Error(
          `a repo-bound run needs projectGraph.repoLabel: without it the engine cannot confirm the ` +
            `project graph holds '${input.repoRef}', and a graph that does not would answer ` +
            `"not found" about the run's own worktree`,
        );
      }
      opts.projectGraph = input.projectGraph;
    }
    if (input.workflow !== undefined) {
      let workflowId = input.workflow;
      // Both per-run compositions (deliver + deliverable floor) fold into ONE def and ONE
      // registration: composing twice would arm two ids and launch the second, leaving the
      // first as engine litter. `composed` stays null until something actually composes, which
      // is what keeps the undelivered/unfloored launch byte-for-byte the old path.
      const requireDeliverables = input.requireDeliverables ?? [];
      let composed: WorkflowDef | null = null;
      if (input.deliver === 'pr' || requireDeliverables.length > 0) {
        const base = this.getWorkflow(input.workflow);
        if (base === null) {
          throw new Error(
            input.deliver === 'pr'
              ? `deliver: "pr" needs a registered workflow to append the deliver phase to — ` +
                `'${input.workflow}' is not registered`
              : `requireDeliverables needs a registered workflow to append the deliverable ` +
                `floor to — '${input.workflow}' is not registered`,
          );
        }
        composed = base;
      }
      if (composed !== null && requireDeliverables.length > 0) {
        // THE DELIVERABLE FLOOR (crew#311): "done" is re-derived from the artifact. The
        // launcher declared what this run must produce, so a deterministic Tool phase appended
        // here re-verifies that those files EXIST, carry bytes, and were written by THIS RUN,
        // and fails the run naming what was expected and what was found when they do not.
        // Composed BEFORE the deliver phase below so the floor sits ahead of it: a run that
        // produced nothing must fail rather than open a pull request over an empty branch.
        //
        // The timestamp is taken HERE, at composition — the last moment before `core.launchRun`
        // below — and passed explicitly rather than left to the default, because the whole
        // freshness claim rests on it: nothing this run produces can predate this line, so an
        // artifact whose mtime does is a PRIOR run's leftover (crew#320). The interactive seams
        // copy their deliverable to `outPath` and never remove it, and their run dirs are keyed
        // by document id, so a re-run over the same key finds the previous file already there;
        // without this the floor would pass on it and "done" would be asserted by a leftover.
        composed = composeDeliverableFloor(
          composed,
          input.sessionId,
          requireDeliverables,
          Date.now(),
        );
      }
      if (composed !== null && input.deliver === 'pr') {
        // First-class delivery (crew#293): compose a PER-RUN def — the selected workflow's
        // phases plus the hardened deliver Tool phase appended last — and arm it with the
        // engine under a run-scoped id. The shared def is NEVER mutated, and the composed def
        // is hot-registered only (no overlay file, no userWorkflows entry): it exists for this
        // launch, not for the catalog.
        if (composed.phases.some((p) => p.id === DELIVER_PHASE_ID)) {
          // The def already delivers (an operator's own feature-pr-style overlay). Appending a
          // second `deliver` phase would collide on id — launch the def as-is; the intent
          // ("this run opens its PR") is already satisfied.
        } else {
          // The run's intent rides along so the commit the deliver phase makes NAMES what it
          // delivered (`wicked-crew run <id>: <intent>`, #318) instead of being an anonymous
          // blob. Composition stays DEFERRED (#319): deliver and the deliverable floor fold
          // into one def and one registration below, never two armed ids.
          composed = composeDeliverWorkflow(composed, input.sessionId, input.problem);
        }
      }
      if (composed !== null && composed.id !== input.workflow) {
        await this._armPerRunWorkflow(composed);
        workflowId = composed.id;
      }
      opts.workflow = workflowId;
      if (workflowId === input.workflow) {
        // Ensure DROP-IN workflow definitions are present in the Rust overlay dir on first use.
        // Uses a dedicated helper (not registerWorkflow) to avoid adding built-ins to userWorkflows,
        // which would duplicate them in listWorkflows(). The write is skipped after the first call
        // per process lifetime.
        //
        // Ids core seeds itself are excluded: writing them shadows the real def with this stale
        // mirror — see CORE_SEEDED_WORKFLOWS. Core resolves those from its own registry, so there is
        // nothing to write and never was.
        //
        // Skipped entirely on the per-run deliver path above (workflowId !== input.workflow):
        // the composed def carries the base's full phase list, so the run resolves its own
        // registration and the base drop-in is not consulted.
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
    } else if (input.deliver === 'pr') {
      // Fail loud, not silent: dropping the option would run to completion with the caller
      // believing a PR opens at the end — the exact operator gap crew#293 closes.
      throw new Error(
        'deliver: "pr" requires a workflow — a free-text run has no def to append the deliver phase to',
      );
    } else if ((input.requireDeliverables ?? []).length > 0) {
      // Same rule for the floor (Copilot, #319): a caller that declares what a run MUST produce
      // and gets no enforcement is worse off than one that never declared it — it would watch a
      // free-text run complete and believe the artifacts were re-derived. There is no def to
      // append the floor phase to, so refuse the launch instead of silently ignoring the option.
      throw new Error(
        'requireDeliverables requires a workflow — a free-text run has no def to append the ' +
          'deliverable floor to',
      );
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

  // ── Campaigns (DES-CAMPAIGN-001 / crew#342 + TH-9) ─────────────────────────
  // The engine is the campaign store — durable, single-writer, crash-resumable (its Campaign
  // rows persist beside AgentSessions on the same estate substrate). Crew keeps NO shadow copy:
  // every read below asks the engine, so a daemon restart or a second daemon over the same db
  // sees the same campaigns. `launchCampaign` is gated on METHOD PRESENCE (not a version floor)
  // because the bindings ship in whatever core-ts release the train cuts next.

  /** Whether the installed engine addon carries the campaign bindings. */
  campaignsSupported(): boolean {
    return typeof this.core.launchCampaign === 'function';
  }

  /** Guard: the campaign binding surface, or a typed 501-shaped refusal naming the action. */
  private _campaigns(what: string): Required<CampaignMethods> {
    if (
      typeof this.core.launchCampaign !== 'function' ||
      typeof this.core.resumeCampaign !== 'function' ||
      typeof this.core.cancelCampaign !== 'function' ||
      typeof this.core.campaignDetail !== 'function' ||
      typeof this.core.campaignList !== 'function'
    ) {
      throw new CampaignsUnsupportedError(what);
    }
    return this.core as Required<CampaignMethods>;
  }

  /** Validate + launch a campaign DAG → the campaign id. `def` is the ENGINE wire shape
   *  (snake_case) — `campaigns/plan.ts` is the one producer of it in this daemon.
   *
   *  `workflows` are the composed per-node Tool workflows the def's run_specs reference; they
   *  are armed FIRST (hot-register + overlay persist) so the engine can resolve them both now
   *  and after a restart — a campaign is durable, so its node workflows must be too. Unlike a
   *  deliver-composed def they are NOT purely ephemeral (`_armPerRunWorkflow`), and unlike a
   *  user workflow they never enter `userWorkflows` or the catalog (the hydration filter in
   *  `readOverlayWorkflows` skips the `campaign-` prefix). */
  async launchCampaign(def: CampaignDef, workflows: WorkflowDef[] = []): Promise<string> {
    const surface = this._campaigns('Launching a campaign');
    for (const wf of workflows) {
      await this._armCampaignWorkflow(wf);
    }
    return surface.launchCampaign(JSON.stringify(def));
  }

  /** Arm one composed campaign-node workflow: validate-then-persist (the FINDING-002 ordering —
   *  core's parser is the authority and runs BEFORE the overlay write), overlay file for
   *  restart durability, no `userWorkflows` entry. */
  private async _armCampaignWorkflow(def: WorkflowDef): Promise<void> {
    const core = this.core as unknown as Record<string, unknown>;
    const register = core['registerWorkflow'];
    if (typeof register !== 'function') {
      // Unreachable on any addon that carries launchCampaign (registerWorkflow predates it by
      // several releases), but the guard keeps the failure loud if that ever un-holds.
      throw new CampaignsUnsupportedError('Arming a campaign node workflow');
    }
    await (register as (j: string) => Promise<string>).call(this.core, JSON.stringify(def));
    const dir = workflowOverlayDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  }

  /** Resume a campaign from its persisted state → the campaign status token. */
  resumeCampaign(id: string): Promise<string> {
    return this._campaigns('Resuming a campaign').resumeCampaign(id);
  }

  /** Cancel a campaign (in-flight node Runs cancelled, the rest marked) → the status token. */
  cancelCampaign(id: string): Promise<string> {
    return this._campaigns('Cancelling a campaign').cancelCampaign(id);
  }

  /** A campaign's full persisted state (DAG + node statuses + run ids), or `null` when unknown. */
  async campaignDetail(id: string): Promise<Campaign | null> {
    const raw = await this._campaigns('Reading a campaign').campaignDetail(id);
    return parseEngineJson<Campaign | null>(raw, 'campaignDetail');
  }

  /** Every campaign on the store. */
  async campaignList(): Promise<Campaign[]> {
    const raw = await this._campaigns('Listing campaigns').campaignList();
    return parseEngineJson<Campaign[]>(raw, 'campaignList');
  }

  /**
   * Archive (or unarchive) a TERMINAL run (crew#265) — write-off, not delete. Resolves `true`
   * when the session existed, `false` for an unknown id (→ 404); REJECTS when the run is
   * non-terminal (the route answers 409). Fail-closed on an old addon: method-presence guard,
   * same doctrine as `injectWorkerMessage`.
   */
  async archiveRun(runId: string, archived: boolean, note?: string): Promise<boolean> {
    const archive = (this.core as { archiveRun?: (id: string, a: boolean, n?: string | null) => Promise<string> }).archiveRun;
    if (typeof archive !== 'function') {
      throw new Error('Run archival needs wicked-core-ts >= 0.6.2; this build does not support it');
    }
    // JSON-encoded bool by contract (parse, never truthiness-test — 'false' is truthy).
    return JSON.parse(await archive.call(this.core, runId, archived, note ?? null)) as boolean;
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
  async runEvents(runId: string): Promise<RecordedEvent[] | null> {
    if (typeof this.core.runEvents !== 'function') return null;
    // `RecordedEvent`, not `CoreEvent`: the binding's contract is the `/ws` frame PLUS a capture-time
    // `ts` and an ordering `seq`, and consumers (the evidence bundle) need both. Typing this as the
    // bare frame made every caller widen or cast to get at fields the engine always sends.
    return JSON.parse(await this.core.runEvents(runId)) as RecordedEvent[];
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

  // ── Projects (DES-PROJECT-001) ──────────────────────────────────────────────
  // 1:1 maps of the 0.6.0 engine surface. Writes ride the single-writer actor;
  // reads are read-only store opens inside the addon. Every method throws
  // ProjectsUnsupportedError on a pre-0.6.0 addon (routes answer 501).

  /** True when the installed addon carries the project surface (0.6.0+). */
  projectsSupported(): boolean {
    return typeof this.core.projectCreate === 'function';
  }

  private requireProjects<T>(fn: T | undefined, what: string): T {
    if (typeof fn !== 'function') throw new ProjectsUnsupportedError(what);
    return fn;
  }

  async projectCreate(name: string, description?: string): Promise<Project> {
    const fn = this.requireProjects(this.core.projectCreate, 'Creating a project');
    return JSON.parse(await fn.call(this.core, name, description ?? null)) as Project;
  }

  async projectUpdate(
    id: string,
    patch: { name?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): Promise<Project> {
    const fn = this.requireProjects(this.core.projectUpdate, 'Updating a project');
    return JSON.parse(
      await fn.call(this.core, id, patch.name ?? null, patch.description ?? null, patch.status ?? null),
    ) as Project;
  }

  /** Every stored project (all statuses, newest first). The `default` project is NOT here — the
   *  route layer synthesizes it (ADR §7: computed, never stored). */
  async projectList(): Promise<Project[]> {
    const fn = this.requireProjects(this.core.projectList, 'Listing projects');
    return JSON.parse(await fn.call(this.core)) as Project[];
  }

  async projectGet(id: string): Promise<Project | null> {
    const fn = this.requireProjects(this.core.projectGet, 'Reading a project');
    return JSON.parse(await fn.call(this.core, id)) as Project | null;
  }

  async projectMembers(projectId: string): Promise<ProjectMember[]> {
    const fn = this.requireProjects(this.core.projectMembers, 'Listing project members');
    return JSON.parse(await fn.call(this.core, projectId)) as ProjectMember[];
  }

  /** Attach a member. `created:false` = the idempotent duplicate hit (emit no event for it). */
  async projectMemberAttach(
    projectId: string,
    kind: string,
    ref: string,
    meta?: Record<string, unknown>,
    attachedBy?: string,
  ): Promise<{ member: ProjectMember; created: boolean }> {
    const fn = this.requireProjects(this.core.projectMemberAttach, 'Attaching a project member');
    return JSON.parse(
      await fn.call(
        this.core,
        projectId,
        kind,
        ref,
        meta !== undefined ? JSON.stringify(meta) : null,
        attachedBy ?? null,
      ),
    ) as { member: ProjectMember; created: boolean };
  }

  /** Detach (tombstone). `false` = no such live member on that project (the route's 404). */
  async projectMemberDetach(projectId: string, memberId: string): Promise<boolean> {
    const fn = this.requireProjects(this.core.projectMemberDetach, 'Detaching a project member');
    return JSON.parse(await fn.call(this.core, projectId, memberId)) as boolean;
  }

  /** The projects holding a live `(kind, ref)` membership — the run→project reverse read. */
  async memberProjects(kind: string, ref: string): Promise<string[]> {
    const fn = this.requireProjects(this.core.memberProjects, 'Resolving a member’s projects');
    return JSON.parse(await fn.call(this.core, kind, ref)) as string[];
  }

  /**
   * Durable interaction requests (ADR §5.3), newest first — or `null` when this addon predates
   * the binding (the `runEvents` convention: a missing capability must stay distinguishable from
   * "no open prompts", or the caches' fallback chain misreports upgrades as empty inboxes).
   */
  async interactionRequests(
    sessionId?: string,
    status?: string,
  ): Promise<InteractionRequest[] | null> {
    if (typeof this.core.interactionRequests !== 'function') return null;
    return JSON.parse(
      await this.core.interactionRequests(sessionId ?? null, status ?? null),
    ) as InteractionRequest[];
  }

  // ── The foundation record (ADR §3.2): charter writes + record probes ────────

  /** Capture a memory at a STRICT `kind:id[/…]` scope (the engine refuses malformed segments). */
  async captureMemory(content: string, scope: string): Promise<void> {
    const fn = this.requireProjects(this.core.captureMemory, 'Capturing a memory');
    await fn.call(this.core, content, scope);
  }

  /** Memories within `scope`'s subtree, newest first — the ADR's memory.coverage probe. */
  async listMemories(scope: string, limit: number): Promise<{ content: string; score: number; tier: string }[]> {
    const fn = this.requireProjects(this.core.listMemories, 'Listing memories');
    return JSON.parse(await fn.call(this.core, scope, limit)) as {
      content: string;
      score: number;
      tier: string;
    }[];
  }

  /** Ingest a document (title + chunks) into the knowledge store. Returns the chunk count. */
  async ingestKnowledge(title: string, chunks: string[]): Promise<number> {
    const fn = this.requireProjects(this.core.ingestKnowledge, 'Ingesting knowledge');
    return JSON.parse(await fn.call(this.core, title, JSON.stringify(chunks))) as number;
  }

  /** Recall up to `k` knowledge chunks relevant to `query`. */
  async recallKnowledge(query: string, k: number): Promise<{ content: string; score: number; source: string }[]> {
    const fn = this.requireProjects(this.core.recallKnowledge, 'Recalling knowledge');
    return JSON.parse(await fn.call(this.core, query, k)) as {
      content: string;
      score: number;
      source: string;
    }[];
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

  /**
   * Forward the operator's elicitation response to the actor (DES-002 §4 P-1).
   *
   * NAPI flat signature: `resolve_elicitation(run_id, elicitation_id, action, response)`.
   * `response` is `null` for `decline` and `cancel` actions; a non-empty string for `accept`.
   *
   * Throws `ElicitationUnsupportedError` until the NAPI binding is present in the installed
   * `wicked-core-ts`. Routes map that to HTTP 501.
   */
  async resolveElicitation(
    _runId: string,
    _elicitationId: string,
    _action: string,
    _response: string | null,
  ): Promise<void> {
    // Consume stub params to satisfy @typescript-eslint/no-unused-vars; the
    // parameter names are part of the public interface and must not be dropped.
    void _runId; void _elicitationId; void _action; void _response;
    // The NAPI binding (`this.core.resolveElicitation`) will land with the actor-side
    // work in a follow-on. Until then, every call throws so the route surfaces 501 and
    // an operator knows to upgrade rather than to keep retrying.
    throw new ElicitationUnsupportedError(
      'resolveElicitation is not yet bound in this wicked-core build; upgrade wicked-core-ts to enable it',
    );
  }

  /** repo id → onboarding run id (in-memory; graph persists on disk across restarts). */
  private readonly repoOnboardRunIds = new Map<string, string>();
  /**
   * repo id → the in-flight launch, so a concurrent caller joins it instead of starting a second.
   *
   * A `Set` of ids was not enough. The id was added here but the run id was only recorded in
   * `repoOnboardRunIds` AFTER the launch resolved, so a second caller arriving mid-flight saw
   * "in flight" with no run id to return, fell through, and launched a DUPLICATE run against the
   * same repo. Holding the promise makes the second caller await the first and receive its run id —
   * the dedup the `Set` was named for.
   */
  private readonly onboardingInFlight = new Map<string, Promise<string>>();

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
        await execCapped('git', ['clone', '--', gitUrl, cloneDir], {
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
    // Join an in-flight launch for THIS repo rather than starting a second one. Concurrency across
    // DIFFERENT repos is the point and is untouched; two launches for the SAME repo are a duplicate.
    const inFlight = this.onboardingInFlight.get(repoId);
    if (inFlight) return inFlight;
    const runId = randomUUID();
    // Launches are NOT serialized. They used to be, through an `_onboardingChain` promise, because
    // each rewrote the shared `onboarding` overlay before launching. That chain never worked: its
    // own comment claimed "after launch the def is baked into the run's units", and the def is
    // actually resolved at DISPATCH — after the launch call returns. So it serialized the writer and
    // left the reader racing, which is how three concurrent registrations indexed one repo under
    // three names (FINDING-075, #196).
    //
    // Nothing is shared now: core binds each run's repo into its own units from `repoRef`
    // (wicked-core#179). Concurrent registration is the point — it is a requirement of the corpus
    // this platform is tested against, not an optimisation.
    const launch = this._doOnboardingLaunch(repoId, repoName, runId).then(() => runId);
    this.onboardingInFlight.set(repoId, launch);
    try {
      return await launch;
    } finally {
      this.onboardingInFlight.delete(repoId);
    }
  }

  private async _doOnboardingLaunch(repoId: string, repoName: string, runId: string): Promise<void> {
    // No overlay write. This used to rewrite core's `onboarding` def with THIS repo's absolute paths
    // and persist it to one shared file (`~/.config/wicked-core/workflows/onboarding.json`), then
    // hot-register it — the one place a core-seeded id was deliberately shadowed.
    //
    // That shadow was the defect. The engine resolves a workflow at DISPATCH time, after this call
    // returns, so concurrent launches raced on the single file and the last writer won: two repos in
    // two different orgs had a third org's tree indexed into a third org's database, each reported
    // under its own name (FINDING-075, #196). Serializing the writes does not fix it — the chain
    // serializes the producer and leaves the consumer racing.
    //
    // Core now declares `{repo_root}` / `{code_graph_db}` on the phases and binds them per run from
    // `repoRef`, which this call already passes (wicked-core#179). Nothing is shared, so nothing can
    // be raced, and onboarding launches may run concurrently.
    await this.launchRun({
      problem: `Onboard repository: ${repoName}`,
      sessionId: runId,
      clisJson: JSON.stringify(CoreAdapter.roster()),
      workflow: 'onboarding',
      repoRef: repoId,
    });
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

  /**
   * Coverage for ONE registered repo, computed over that repo's OWN code graph (FINDING-009). Unlike
   * {@link getCoverageReport} — which reads the daemon store and reports a vacuous `coverage: 1.0` that
   * names no repo — this resolves `repoRef` in the registry and recomputes over its `code_graph_db`.
   * The core rejects an unknown repo (never a silent vacuous report), so this throws for a bad ref.
   */
  async getCoverageReportForRepo(repoRef: string): Promise<CoverageReport | null> {
    // The napi binding returns a JSON string (`serde_json::to_string`); parse it with a guard that
    // names the method on either a non-string return or invalid JSON (Copilot #227).
    return parseEngineJson<CoverageReport | null>(
      await this.core.getCoverageReportForRepo(repoRef),
      'getCoverageReportForRepo',
    );
  }

  /**
   * Node-count-by-kind summary of ONE registered repo's code graph, over that repo's OWN store
   * (#122) — what the estate graph actually holds for the repo, so an operator can see it was
   * populated. The core rejects an unknown repo, so this throws for a bad ref.
   */
  async getGraphKindsForRepo(repoRef: string): Promise<GraphKind[]> {
    return parseEngineJson<GraphKind[]>(
      await this.core.getGraphKindsForRepo(repoRef),
      'getGraphKindsForRepo',
    );
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

  // ── Governance wiki management (wiki-mgmt) ─────────────────────────────────

  /** Whether the installed engine addon carries the AW-23 scoreboard binding (core-ts ≥ 0.7.4). */
  wikiScoreboardSupported(): boolean {
    return typeof this.core.governanceScoreboard === 'function';
  }

  /**
   * The wiki population/connection scoreboard (AW-23 / arch-R23) — typed %, resolving %,
   * enforcement evidence, and an in-band honesty marker for what cannot be measured. Read-only
   * on the engine side (`open_store_ro`), so it never blocks the single-writer actor.
   *
   * `docsRoot` is the same docs root `rules ingest --dir` used; omitted, the typing half reports
   * `available: false` with the reason — an honest in-band answer, not an error.
   *
   * Presence-gated (the campaigns doctrine): throws {@link GovernanceScoreboardUnsupportedError}
   * on an addon that predates the binding, which the route maps to 501 ("upgrade the engine").
   */
  async governanceScoreboard(docsRoot?: string): Promise<GovernanceScoreboard> {
    const fn = this.core.governanceScoreboard;
    if (typeof fn !== 'function') {
      throw new GovernanceScoreboardUnsupportedError('Reading the governance wiki scoreboard');
    }
    return parseEngineJson<GovernanceScoreboard>(
      await fn.call(this.core, docsRoot ?? null),
      'governanceScoreboard',
    );
  }

  /**
   * How many `RuleSet` rows (doctrine domain parents, AW-13) the store holds — or `null` when
   * this engine build cannot count them (no `listRuleSets` binding yet).
   *
   * `null` rather than `0` on purpose (the `runEvents` doctrine): "no rulesets" is a real answer
   * about an unseeded store, and "I cannot count" must never impersonate it — the wiki meta's
   * empty state would otherwise report a seeded store as empty and point the operator at a
   * runbook they already ran.
   */
  async countRuleSets(): Promise<number | null> {
    const fn = this.core.listRuleSets;
    if (typeof fn !== 'function') return null;
    const rows = parseEngineJson<unknown>(await fn.call(this.core), 'listRuleSets');
    return Array.isArray(rows) ? rows.length : null;
  }

  // ── Steering (STEERING program — the unified steering-rule model) ───────────

  /**
   * Whether the installed engine addon carries the unified steering-rule model (core-ts ≥ 0.7.5).
   *
   * The sentinel is the `steeringImport` binding, which ships WITH the model merge — see the
   * `GovernanceMethods` comment. Consulted by the routes before: filtering rules by
   * `?type=` (rows on an old engine carry no `steering_type`, so an empty answer would
   * impersonate "no rules of that type"); accepting a rule write that carries steering fields
   * (an old engine would silently drop them — the extraWriteRoots doctrine); and folding the
   * legacy policy write surface (410 only once the unified store exists to point at).
   */
  steeringSupported(): boolean {
    return typeof this.core.steeringImport === 'function';
  }

  /**
   * Batch-import steering rules (frontmattered markdown docs and/or ready rule JSON) through the
   * engine's ingest normalize/validate path — the SAME path `rules ingest --dir` runs, on the
   * single-writer actor (the daemon must never open the store for writes itself). Fail-closed
   * PER ENTRY: one bad entry rejects alone with its reason in that entry's result row, the rest
   * still land. `defaultType` is the page's inferred steering type, applied to entries that
   * omit one.
   *
   * Presence-gated (the campaigns doctrine): throws {@link SteeringUnsupportedError} on an addon
   * that predates the binding, which the route maps to 501 ("upgrade the engine").
   */
  async importSteeringRules(
    entries: SteeringImportEntry[],
    defaultType?: string,
  ): Promise<SteeringImportResult[]> {
    const fn = this.core.steeringImport;
    if (typeof fn !== 'function') {
      throw new SteeringUnsupportedError('Importing steering rules');
    }
    const rows = parseEngineJson<SteeringImportResult[]>(
      await fn.call(this.core, JSON.stringify({ default_type: defaultType ?? null, entries })),
      'steeringImport',
    );
    // Rust spells an absent `Option` as `null` unless the engine adds `skip_serializing_if`;
    // crew's published wire type (`SteeringImportResult.name/ids/error?`) spells absence as an
    // ABSENT KEY. Pin the shape on OUR side of the seam — strip null-valued keys — so the HTTP
    // response honors the contract whichever spelling the installed addon ships.
    return rows.map(
      (r) =>
        Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as SteeringImportResult,
    );
  }

  // ── Testing (crew-testing) — governance evals over the steering-rule store ──

  /**
   * Whether the installed engine addon carries the governance-evals surface (core-ts ≥ 0.7.5,
   * unreleased at the time this seam lands). The sentinel is the `governanceEvals` binding —
   * for the WHOLE evals seam, corpus import included: the two bindings ship together, and a
   * daemon running against the released 0.7.4 addon must answer 501 on both routes, never crash.
   */
  governanceEvalsSupported(): boolean {
    return typeof this.core.governanceEvals === 'function';
  }

  /**
   * Run the governance evals: every sample of the corpus (`corpus` = an `evals:<name>` estate
   * scope minted by {@link importGovernanceCorpus}; omitted = the engine's built-in default
   * corpus) is pushed through the decide path and compared to what its `kind` says SHOULD have
   * happened. Resolves the engine's serde report — snake_case field names, passed to the wire
   * verbatim (the pinned crew/studio contract).
   *
   * `dbPath` rides the args because the eval run opens its own read-only connection to the
   * steering store — the SAME store this adapter's actor writes (`this.dbPath`, the one spelling
   * of where it lives). `knowledgeDb` is deliberately omitted: crew configures no separate
   * knowledge db (the knowledge store is the engine's single-writer sidecar, derived from its
   * own config exactly as the steering ingest path derives it).
   *
   * Presence-gated (the campaigns doctrine): throws {@link GovernanceEvalsUnsupportedError} on
   * an addon that predates the binding, which the route maps to 501 ("upgrade the engine").
   */
  async runGovernanceEvals(args: { type?: string; corpus?: string }): Promise<GovernanceEvalReport> {
    const fn = this.core.governanceEvals;
    if (typeof fn !== 'function') {
      throw new GovernanceEvalsUnsupportedError('Running governance evals');
    }
    const payload = {
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.corpus !== undefined ? { corpus: args.corpus } : {}),
      dbPath: this.dbPath,
    };
    return parseEngineJson<GovernanceEvalReport>(
      await fn.call(this.core, JSON.stringify(payload)),
      'governanceEvals',
    );
  }

  /**
   * Import a named eval corpus into the knowledge store under the `evals:<name>` scope (the
   * string a later {@link runGovernanceEvals} names as `corpus`). `knowledgeDb` is omitted for
   * the same reason as in {@link runGovernanceEvals} — the engine derives its own sidecar.
   *
   * Gated on the `governanceEvals` sentinel as well as the binding itself: the two ship
   * together, and importing a corpus no engine on this host can ever run would be a trap, not
   * a feature (the steering author-route doctrine).
   */
  async importGovernanceCorpus(
    name: string,
    samples: GovernanceEvalSample[],
  ): Promise<ImportEvalCorpusResponse> {
    const importFn = this.core.governanceCorpusImport;
    if (typeof this.core.governanceEvals !== 'function' || typeof importFn !== 'function') {
      throw new GovernanceEvalsUnsupportedError('Importing an eval corpus');
    }
    return parseEngineJson<ImportEvalCorpusResponse>(
      await importFn.call(this.core, JSON.stringify({ name, samples })),
      'governanceCorpusImport',
    );
  }

  // ── Workflow viewer + builder (crew#44) ────────────────────────────────────
  // Built-ins are static TypeScript mirrors of workflow.rs. User-registered
  // workflows are added to `userWorkflows` and persisted to disk; the Rust actor
  // picks them up via `register_workflow` NAPI (when available) for immediate use.

  private readonly userWorkflows = new Map<string, WorkflowDef>();

  /** Whether {@link hydrateFromOverlay} has run this process lifetime. */
  private overlayHydrated = false;

  /** Load user-registered workflows persisted to the overlay dir into `userWorkflows`, ONCE.
   *
   * FINDING-002 residual: `registerWorkflow` writes each def to the overlay dir AND to the in-memory
   * `userWorkflows` Map, but the Map is process-local and empty on every daemon restart, and nothing
   * read the dir back. So after a restart the Rust actor (which DOES load the overlay dir at startup)
   * would launch a user workflow that `listWorkflows()`/`GET /workflows` no longer showed — it
   * vanished from the registry while remaining runnable. Hydrating from the same dir the writer uses
   * makes the two views agree again. */
  private hydrateFromOverlay(): void {
    if (this.overlayHydrated) return;
    this.overlayHydrated = true;
    const builtinIds = new Set(BUILTIN_WORKFLOWS.map((w) => w.id));
    for (const def of readOverlayWorkflows(workflowOverlayDir(), builtinIds)) {
      if (!this.userWorkflows.has(def.id)) this.userWorkflows.set(def.id, def);
    }
  }

  listWorkflows(): WorkflowDef[] {
    this.hydrateFromOverlay();
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
    this.hydrateFromOverlay();
    return this.userWorkflows.get(id) ?? BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null;
  }

  /** Write a built-in workflow definition to the Rust overlay dir (and hot-register when possible).
   *  Unlike registerWorkflow(), this does NOT touch userWorkflows, avoiding duplicates in listWorkflows(). */
  private async _writeBuiltinOverlay(def: WorkflowDef): Promise<void> {
    const dir = workflowOverlayDir();
    await mkdir(dir, { recursive: true });
    const overlayDef = { ...(def as WorkflowDef & { is_system?: boolean }) };
    delete overlayDef.is_system;
    const json = JSON.stringify(overlayDef);
    const core = this.core as unknown as Record<string, unknown>;
    const register = core['registerWorkflow'];

    // Same validate-before-persist ordering as registerWorkflow (FINDING-002). This path had the
    // identical defect — write first, validate last — which is the P3 shape this campaign keeps
    // finding: N paths, one hardened. A mirror that drifted far enough for core to reject it would
    // otherwise leave an unparseable *.json in the dispatch overlay dir, and core would skip it at
    // the next load. Letting the rejection propagate instead fails the launch with core's own
    // reason, which beats dispatching against a workflow core will silently drop.
    if (typeof register === 'function') {
      await (register as (j: string) => Promise<string>).call(this.core, json);
    }
    // Deliberately NOT the refusal registerWorkflow makes when the binding is absent, and the
    // difference is the input, not the caller:
    //   - a user def is arbitrary runtime input no test has ever seen, so unvalidatable means
    //     unsafe to persist;
    //   - a built-in mirror is asserted field-for-field against wicked-core's own
    //     workflows/<id>.json by tests/builtin-overlay-shadow.test.ts, so its parseability is
    //     established at build time rather than needing a runtime check.
    // Refusing here would also break DELIVERY: this write is the only way core resolves a drop-in
    // id, so a refusal turns a silent ungating into a hard "unknown workflow" — exactly the
    // regression FINDING-084's first attempted fix caused.
    await writeFile(join(dir, `${def.id}.json`), JSON.stringify(overlayDef, null, 2), 'utf8');
  }

  /**
   * Arm a PER-RUN composed workflow def (crew#293 deliver, crew#311 deliverable floor) with the
   * engine — hot registration
   * ONLY. Deliberately neither of the other two paths:
   *   - not `registerWorkflow()`: the composed def must not enter `userWorkflows` or the overlay
   *     dir — it is launch input for one run, and persisting it would grow the catalog and the
   *     overlay dir by one entry per delivered run;
   *   - not `_writeBuiltinOverlay()`: same reason, no file.
   * The engine's `registerWorkflow` binding validates the def server-side and makes it visible
   * to the next `launchRun` with no restart — exactly the lifetime a per-run def needs. (The
   * def is consumed at PLANNING time; a later daemon restart resumes the run from its persisted
   * units, so the in-memory registration expiring with the process is fine.)
   */
  private async _armPerRunWorkflow(def: WorkflowDef): Promise<void> {
    const core = this.core as unknown as Record<string, unknown>;
    const register = core['registerWorkflow'];
    if (typeof register !== 'function') {
      // Same doctrine as registerWorkflow(): no validator ⇒ refuse loudly. Silently launching
      // the BASE workflow instead would drop the delivery the caller explicitly asked for —
      // and, for crew#311, would drop the deliverable floor, launching a run that can once
      // again report done over an artifact that was never written.
      throw new Error(
        'deliver: "pr" / requireDeliverables need a wicked-core build with the registerWorkflow ' +
          'binding — the per-run workflow cannot be armed',
      );
    }
    await (register as (j: string) => Promise<string>).call(this.core, JSON.stringify(def));
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
    const json = JSON.stringify(overlayDef);

    // VALIDATE BEFORE PERSISTING (FINDING-002). This ordering is the whole fix.
    //
    // The write used to come first and `registerWorkflow` last, so core's parser — the only thing
    // that actually knows the overlay schema — ran AFTER the state was already mutated. Observed
    // end to end: POST /api/v1/workflows answered
    //   400 invalid workflow JSON: unknown field `name`, expected `id` or `phases`
    // and the file was on disk anyway, `name` included, and served from `userWorkflows` as though
    // registered. On the next daemon start core could not deserialise its own overlay file:
    //   wicked-core: skipping workflow file .../probe-002-persist.json
    // and the workflow VANISHED while its file remained. That is FINDING-002's root cause: not
    // "registration is not durable" but "a rejected request persisted a def core cannot read".
    //
    // Core's parser is the authority, so it is what we ask. Enumerating the accepted fields in TS
    // instead would be a second copy of core's schema — the exact drift this codebase keeps paying
    // for, and `is_system` above is already one hand-maintained instance of it.
    const core = this.core as unknown as Record<string, unknown>;
    const register = core['registerWorkflow'];
    if (typeof register !== 'function') {
      // No validator, so no safe way to persist: an unvalidated def written here is a file core
      // may silently skip at load. Refusing is the honest outcome — and it is loud, unlike the
      // vanishing act it replaces. `registerWorkflow` has been declared (non-optional) in
      // wicked-core-ts since 0.4.0, so this is a real floor, not a routine path.
      throw new Error(
        'this wicked-core build exposes no registerWorkflow binding, so a workflow cannot be ' +
          'validated before it is written; refusing to persist an unvalidated definition',
      );
    }
    // Throws on a def core rejects — before anything is written or registered.
    await (register as (j: string) => Promise<string>).call(this.core, json);

    await writeFile(path, JSON.stringify(overlayDef, null, 2), 'utf8');
    this.userWorkflows.set(def.id, def);
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

  async getSettings(): Promise<CrewSystemSettings> {
    try {
      const raw = await readFile(settingsFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CrewSystemSettings>;
      // Validate numeric fields; drop anything out-of-range rather than propagate bad values.
      if ('graphNodeLimit' in parsed) {
        const v = parsed.graphNodeLimit;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10000) delete parsed.graphNodeLimit;
      }
      // workerStallMinutes (crew#287): positive minutes; a hand-edited zero/negative/NaN would
      // make the stall watchdog fire on every sweep, so drop it and fall back to the default.
      if ('workerStallMinutes' in parsed) {
        // Same bounds the PUT /settings route enforces (integer, 1..1440) — a hand-edited
        // settings.json must not enable values the API rejects (Copilot on #301).
        const v = parsed.workerStallMinutes;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1440) {
          delete parsed.workerStallMinutes;
        }
      }
      // worker_config_root (seat sign-in): absolute path or "" (= engine default). A hand-edited
      // relative path is dropped rather than exported as WICKED_WORKER_HOME, where the engine
      // would resolve it against an arbitrary spawn cwd.
      if ('worker_config_root' in parsed) {
        const r = parsed.worker_config_root;
        if (typeof r !== 'string' || (r !== '' && !isAbsolute(r))) delete parsed.worker_config_root;
      }
      // Skin-owned `studio.*` blobs (crew#325): the same per-key cap the PUT /settings route
      // enforces. The write cap alone cannot hold it — `updateSettings` reads through here, so a
      // value hand-edited past the cap is served in full AND carried forward by a later patch that
      // never names it, which makes the ceiling un-lowerable. Dropped LOUDLY: the daemon cannot
      // interpret these values, so an operator whose theme "reset itself" has nothing to go on
      // unless the drop names the key and the limit (silence is what made #323 invisible).
      // Namespace prefix, not the route's stricter key regex — the cap is about bytes in
      // settings.json, and a hand-edited `studio.Foo` the route would never have admitted costs
      // exactly as much to store and to propagate.
      const bag = parsed as Record<string, unknown>;
      for (const key of Object.keys(bag)) {
        if (!key.startsWith('studio.')) continue;
        const bytes = Buffer.byteLength(JSON.stringify(bag[key]), 'utf8');
        if (bytes > STUDIO_SETTINGS_MAX_BYTES) {
          delete bag[key];
          console.warn(
            `[settings] dropped ${key} from ${settingsFilePath()}: ${bytes} bytes of JSON, over ` +
              `the ${STUDIO_SETTINGS_MAX_BYTES}-byte per-key cap on studio.* settings. PUT ` +
              `/settings refuses a write this size, so this value was hand-edited in or predates ` +
              `the cap; it is dropped on read rather than served and rewritten forward. Shrink it ` +
              `in the file to get it back — nothing else in settings.json is affected (crew#325).`,
          );
        }
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(patch: Partial<CrewSystemSettings>): Promise<CrewSystemSettings> {
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
