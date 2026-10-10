import { createRequire } from 'node:module';
import type { BusUnavailable } from './engine-bus.js';
import { attachEngineBus, detachEngineBus, type EngineBus } from './bus.js';
import { mkdir, access, readFile, writeFile, chmod, rm, link, rename, realpath, stat } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { isPlainRunId, WALKTHROUGH_AUTHOR_SUBDIR, walkthroughRootDir } from './walkthrough-root.js';
import { crewStateHome, isDefaultStateHome } from '../projects/state-home.js';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Core as CoreHandle, LaunchOptions, Subscription } from 'wicked-core-ts';
import type {
  EditorGrantsResponse,
  CoreEvent,
  LaunchRunInput,
  LaunchPlan,
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
  PhaseDef,
  CrewSystemSettings,
  Preset,
  PresetStep,
  CatalogEntry,
  PlanPreviewResponse,
  PlanProposalResponse,
  RunTeamView,
  TeamOutboxReplayReport,
  Project,
  ProjectMember,
  InteractionRequest,
  Campaign,
  CampaignDef,
} from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { BASE_SKILL_REF_SHAPE } from '../skills/base-skill.js';
import { execCapped } from './exec.js';
import { BUG_FIX_SWEEP_INSTRUCTIONS, composeDeliverWorkflow, DELIVER_PHASE_ID, deliverPresetStep, deliverIdentityFor, deliverRepoFor, EVIDENCE_FLOOR_PIN, ghSignedInLogins, isGitHubLogin, readDeliverOriginUrl } from './deliver.js';
import { engineCampaignDef, engineRosterJson } from './engine-roster.js';
import { QE_AUTHOR_TESTS_WORKFLOW_DEF } from '../qe/author-workflow.js';
import { CAMPAIGN_WORKFLOW_PREFIX } from '../campaigns/plan.js';
import { composeDeliverableFloor } from './deliverable-floor.js';
import { deliverCredentialsProbe, type DeliverCredentials } from './deliver-credentials.js';
import {
  isSyntheticWorkflowId,
  resolveRunIdentity,
  verifiedEvidenceCatalog,
  wireIdentity,
  withPresetSystemFlag,
  withSystemFlag,
} from './run-identity.js';

/** A run in one of these statuses never records another launch frame. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
import { resolveProjectGraphBinding, type ProjectGraphBinding } from '../projects/graph.js';
import { applyGovernanceStoreEnv, isStoreSpec, type GovernanceStoreLocation } from './governance-store.js';



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
 *  spelling of this path (the tests/ tree is audited against spelling core paths itself).
 *
 *  `WICKED_CREW_SYSTEM_SETTINGS` overrides the file — the same escape hatch
 *  `WICKED_CREW_PROJECT_SETTINGS` gives the project-settings store (projects/settings.ts). The
 *  test harness arms it (tests/setup/hermetic-home.ts) so the suite never reads the operator's
 *  real `~/.config/wicked-core/settings.json` at `createServer` boot — where a real
 *  `worker_config_root` would be exported as `WICKED_WORKER_HOME` into the hermetic env — and a
 *  `PUT /settings` test never rewrites it (crew#396). Read at call time, not import time, so a
 *  test may re-aim it per fixture. */
export function settingsFilePath(): string {
  const override = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  if (override !== undefined && override !== '') return override;
  // crew#756: a daemon on a NON-default state home (a proof lane, a second install) keeps its
  // settings beside its other stores, so changing its theme never rewrites the operator's real file.
  // `daemon-settings.json` is a `daemon-*` name the state-home registry already classifies
  // (operator-owned, no worker read), so the worker Read fence needs no change. The default state
  // home keeps the historical location.
  if (!isDefaultStateHome()) return join(crewStateHome(), 'daemon-settings.json');
  return sharedSettingsFilePath();
}

/** The historical machine-wide settings file — the default state home's, and the one-time seed of any other (crew#756). */
function sharedSettingsFilePath(): string {
  return join(homedir(), '.config', 'wicked-core', 'settings.json');
}

/**
 * crew#756 migration, once: a non-default state home with no settings file of its own starts from a
 * COPY of the shared file, so a daemon upgraded onto this rule keeps its configuration while every
 * later write stays in its own state home. Exclusive copy (never overwrites); a missing shared file
 * is no seed. A daemon with an explicit `WICKED_CREW_SYSTEM_SETTINGS` or on the default home skips it.
 */
async function seedStateHomeSettings(path: string): Promise<void> {
  const override = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  if ((override !== undefined && override !== '') || isDefaultStateHome() || existsSync(path)) return;
  // The seed is a VALIDATED snapshot: the shared file's text only when it parses as a JSON object,
  // else an empty object — so a missing, partial or corrupt shared file starts the home empty and is
  // never retried (Copilot on #760). Published with `link`, which is atomic and never replaces an
  // existing file: a racing first read either publishes or finds a complete file.
  let body = '{}';
  try {
    const raw = await readFile(sharedSettingsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = raw;
  } catch {
    /* absent or not JSON: start empty */
  }
  await publishSettingsFile(path, body, false);
}

/**
 * Write a settings file WHOLE: the text goes to a sibling temp file, then is published — by
 * `rename` (replacing) or `link` (only when absent). A reader never sees a partial file. The temp
 * name keeps the target's name as its prefix, so inside a state home it stays a registered
 * `daemon-*` entry while it exists.
 */
async function publishSettingsFile(linkPath: string, body: string, replace: boolean): Promise<void> {
  // A replacing write goes THROUGH a settings-file link to its target and keeps the file's mode, as
  // the in-place `writeFile` it replaces did (Copilot r2 on #760): `rename` would swap the link for a
  // plain file and publish the temp file's default (umask) mode over a 0600 file.
  let path = linkPath;
  let mode: number | undefined;
  if (replace) {
    try {
      path = await realpath(linkPath);
      mode = (await stat(path)).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  // Created exclusively and owner-only, so the text is never readable by others while it is a
  // temp file; the existing file's mode is applied before it is published (codex on #760).
  await writeFile(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    if (mode !== undefined) await chmod(tmp, mode);
    if (replace) {
      await rename(tmp, path);
    } else {
      try {
        await link(tmp, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
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

/** A drop-in workflow definition the ENGINE refused, with the engine's own reason (crew#718). */
export interface RefusedWorkflow {
  /** The def's id, as the file named it. */
  id: string;
  /** Core's refusal, verbatim — e.g. `gate evaluates nothing: write-a-note — the phase declares
   *  executes_code but pins no validator and has no human gate …`. */
  reason: string;
}

/** Ask CORE's parser which drop-in defs it will actually honour (crew#718).
 *
 * {@link readOverlayWorkflows} checks a `{id, phases[]}` shape, which is not the engine's contract:
 * `WorkflowRegistry::load_dir` runs `refuse_reserved_id` + `WorkflowDef::validate()` and SKIPS the
 * file it rejects, loudly, on the daemon's stderr. So the catalog listed defs the engine had thrown
 * away at boot and the launch then 400'd `unknown workflow` — the MCP S8 dogfood's F-3, on a
 * hand-authored drop-in whose `executes_code` phase pinned no validator ("gate evaluates nothing").
 *
 * The same doctrine {@link CoreAdapter.registerWorkflow} states for the WRITE path applies here:
 * core's parser is the authority, so it is what we ask. Enumerating `validate()`'s rules in
 * TypeScript would be a second copy of core's schema — the drift that produced this defect.
 * `register` is the engine's `registerWorkflow` binding, which validates before it registers and
 * is idempotent on id, so re-offering a def the engine already loaded at boot is a same-content
 * overwrite; a def added to the dir after boot becomes launchable rather than being listed and
 * refused.
 *
 * `is_system` is stripped first, exactly as the two write paths do: it is crew's own display flag
 * and core's strict def parser rejects the key.
 *
 * Pure (no adapter state) so it is unit-testable without spawning a Core, like
 * {@link readOverlayWorkflows}.
 */
export async function judgeOverlayWorkflows(
  defs: readonly WorkflowDef[],
  register: (json: string) => Promise<string>,
): Promise<{ accepted: WorkflowDef[]; refused: RefusedWorkflow[] }> {
  const accepted: WorkflowDef[] = [];
  const refused: RefusedWorkflow[] = [];
  for (const def of defs) {
    const overlayDef = { ...(def as WorkflowDef & { is_system?: boolean }) };
    delete overlayDef.is_system;
    try {
      await register(JSON.stringify(overlayDef));
      accepted.push(def);
    } catch (err) {
      refused.push({ id: def.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { accepted, refused };
}

// The native addon is a CommonJS cdylib (`index.node`); load it with a CJS
// require even though this daemon is ESM. This module is the ONLY place that
// touches wicked-core-ts (DES-STUDIO-001 §5.2/§5.3), so the FINALIZING
// `subscribe` seam has a blast radius of exactly one file. Declared ABOVE the
// helpers that use it (review-L10-593 nit 3: a default parameter read it before
// its declaration in source order — fine at call time, a reader trap).
const require = createRequire(import.meta.url);

/** The gate-hook binary's file name on this host. */
export const WICKED_CORE_EXE_NAME = process.platform === 'win32' ? 'wicked-core.exe' : 'wicked-core';

/**
 * The `wicked-core-ts` platform package for this host — the five names `napi-release.yml` publishes
 * (`wicked-core-ts-darwin-arm64`, `-darwin-x64`, `-linux-x64-gnu`, `-linux-arm64-gnu`,
 * `-win32-x64-msvc`); `undefined` for a platform/arch pair no package exists for.
 */
export function wickedCoreTsPlatformPackage(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const abi =
    platform === 'darwin' && arch === 'arm64' ? 'darwin-arm64'
    : platform === 'darwin' && arch === 'x64' ? 'darwin-x64'
    : platform === 'linux' && arch === 'x64' ? 'linux-x64-gnu'
    : platform === 'linux' && arch === 'arm64' ? 'linux-arm64-gnu'
    : platform === 'win32' && arch === 'x64' ? 'win32-x64-msvc'
    : undefined;
  return abi === undefined ? undefined : `wicked-core-ts-${abi}`;
}

/**
 * The `wicked-core` hook binary BUNDLED inside this install's platform package (core#405, F-009 —
 * FIX-IT-ALL L10-9 crew half; core-ts ≥ 0.7.26 ships it beside the `.node`, stamped
 * `wickedCoreVersion` = the engine semver the addon's gate compares against `--version`). ONE lookup
 * (review-L10-593 nit 2, D2): the resolver's candidate `node_modules` dirs for this module — the
 * same sidestep `installedPackageVersion` uses, because a platform package's exports map may not
 * expose `./package.json` — checked for `<dir>/<pkg>/<exe>`. The binary found is the one that shipped
 * WITH this addon, never a stale copy in the operator's home. `undefined` when no platform package
 * resolves or it carries no binary (a pre-0.7.26 package).
 */
export function bundledWickedCoreExe(
  exeName: string = WICKED_CORE_EXE_NAME,
  pkg: string | undefined = wickedCoreTsPlatformPackage(),
  resolvePaths: (id: string) => string[] | null = (id) => require.resolve.paths(id),
): string | undefined {
  if (pkg === undefined) return undefined;
  for (const dir of resolvePaths(pkg) ?? []) {
    const p = join(dir, pkg, exeName);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Find the wicked-core standalone binary for the gate-hook command.
 * Checks common install locations so the Rust actor can build a correct
 * hook command even when loaded as a napi addon (where current_exe() = node).
 * Order (core#405): the binary bundled in THIS install's platform package first — it shipped with
 * the addon that will check its semver — then the home-dir installs (the stale-copy class: a
 * `.local/bin` symlink once held an old build), the monorepo dev build, PATH. `WICKED_CORE_EXE`
 * set by the operator still wins (the caller only fills it when unset).
 */
function locateWickedCoreExe(): string | undefined {
  const exeName = WICKED_CORE_EXE_NAME;
  const bundled = bundledWickedCoreExe(exeName);
  if (bundled !== undefined) return bundled;
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
  return candidates.find((p) => existsSync(p));
}


// ── Governance methods (crew#40/42) ──────────────────────────────────────────
// These instance methods are present on the napi `Core` class after the Rust
// crate is rebuilt with the crew#40/42 governance seam. The intersection type
// below satisfies the TypeScript compiler until node_modules is updated.
type GovernanceMethods = {
  listPolicies(): Promise<string>;
  // Positional steering facets (0.7.5): (steeringType?, includeRetired?). Older bindings declare
  // zero params and IGNORE extra args — calling with them is safe on every generation.
  listConformanceRules(steeringType?: string | null, includeRetired?: boolean | null): Promise<string>;
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
  // DC-S1 (wicked-core-ts >= 0.7.35): the project-aware rule query. Optional, and THE presence
  // sentinel for project rules (`projectRulesSupported()`): the same addon added `Targets.project`
  // and `supersedes`, so an engine without this binding would accept a rule carrying them and drop
  // them (`Targets` has no `deny_unknown_fields`), landing a project rule as a global one.
  considerRules?(queryJson: string): Promise<string>;
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
  // DES-MCP-TOOLS-001 S6: the MCP policy preview over synthetic unit cells, recorded nowhere.
  // Optional: no released addon carries it yet (it lands after core-ts 0.7.30).
  previewMcpCalls?(requestJson: string): Promise<string>;
};

/** Chat sessions (core#134): what is left of the warm ACP seat pool after ASK-C1/C4 — crew only
 *  lists and closes engine chats (an ask is a team path, a standing-order parse a one-step path);
 *  the pool itself goes with core ASK-K4. */
type ChatMethods = {
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

/**
 * The preset bindings (DES-TEAMING-002 §8.4, seam C2). ALL optional, same doctrine as
 * `ProjectMethods`: they land after wicked-core-ts 0.7.30, so the installed addon may not carry
 * them at runtime. Every method resolves a JSON string.
 */
type PresetMethods = {
  /** `stepsJson` = JSON array of plan steps. Resolves to the stored `Preset` JSON. */
  putPreset?(name: string, stepsJson: string, projectId?: string | null, createdBy?: string | null): Promise<string>;
  /** Resolves to the JSON literal `true`, or `false` when no such live preset exists. */
  deletePreset?(name: string, projectId?: string | null): Promise<string>;
  /** Resolves to a JSON array of `Preset` objects (the set a launch in `projectId` sees). */
  listPresets?(projectId?: string | null): Promise<string>;
};

/**
 * The team bindings (DES-TEAMING-002 T8). ALL optional: `runTeam` / `replayTeamOutbox` land with
 * seam P1; `catalog` / `previewPlan` / `proposePlan` with core#630 (the engine's catalog, the
 * launch's own decision as a dry run, the mid-run plan edit). Each resolves a JSON string; an
 * addon without one answers 501.
 */
type TeamMethods = {
  /** `RunTeamView` JSON, or the literal `null` for a run that is not a team run; rejects for an unknown run. */
  runTeam?(runId: string): Promise<string>;
  /** The outbox replay report JSON; rejects when the engine has no bus or no state home. */
  replayTeamOutbox?(): Promise<string>;
  /** The phase catalog: a JSON array of `CatalogEntry` rows, in catalog order. */
  catalog?(): Promise<string>;
  /** The launch's decision over a draft plan as `PlanPreview` JSON; rejects with the launch's refusal. */
  previewPlan?(
    planJson: string,
    projectId?: string | null,
    humanConfirm?: string | null,
    repoRef?: string | null,
    deliverStepJson?: string | null,
  ): Promise<string>;
  /** A mid-run plan edit, held for the next step boundary: `PlanProposal` JSON; idempotent by `requestId`. */
  proposePlan?(runId: string, planJson: string, requestId: string): Promise<string>;
};

/** DES-TEAMING-002 T0 (wicked-core-ts ≥ the release carrying it): what arming the engine's bus
 *  bridge came to at spawn — JSON `{state:"none"|"armed"|"not-armed", floor?, reason?}`. Optional:
 *  an older addon has no such method. */
interface BusBridgeMethods {
  busBridgeState?(): string;
  /** wicked-core#631 (wicked-core-ts ≥ the release carrying it): emit one wicked-bus row on the
   *  engine's bus; resolves to its event id (a key already on the bus → the existing row's id). */
  busEmit?(eventJson: string): Promise<number>;
  /** wicked-core#631: rows after a cursor, filtered by type prefix (live ones unless
   *  `includeExpired`) — JSON `{ next, rows }`. */
  busRead?(afterId: number, limit: number, typePrefix?: string | null, includeExpired?: boolean | null): Promise<string>;
}

type CoreHandleFull = CoreHandle &
  BusBridgeMethods &
  GovernanceMethods &
  ChatMethods &
  EventLogMethods &
  ProjectMethods &
  PresetMethods &
  TeamMethods &
  CampaignMethods;

/** The napi constructor surface — the static factories live on the class object. */
interface CoreConstructor {
  spawn(path: string): CoreHandleFull;
  spawnStub(path: string): CoreHandleFull;
  registryRoster(): string;
  // crew#495 companion statics (wicked-core-ts ≥ the release carrying them). Optional for the same
  // reason as `GovernanceMethods.retirePolicy`, and not hypothetically: NO released addon carries
  // them yet, so `/diagnostics.governance.records` answers `null` ("cannot count") rather than a
  // fabricated 0 and `wicked-crew governance replay` says "upgrade the engine" until one does.
  /** EVENT nodes on the estate store at `dbPath` (a read-only connection), as a JSON number string. */
  eventStoreCount?(dbPath: string): Promise<string>;
  /** Replay a dead-letter outbox (the engine's NDJSON spool records) into the estate store at
   *  `dbPath`; resolves to a JSON `{ read, replayed, failed: [{ line, reason }] }` report. */
  replayEmitOutbox?(outboxPath: string, dbPath: string): Promise<string>;
  /** The state-home PREFLIGHT (wicked-core#411 / crew#497; wicked-core-ts ≥ the release carrying
   *  it): survey the state home the worker Read fence classifies and report every entry its
   *  registry cannot classify — resolves to the JSON `{ stateHome, derivedFrom, unregistered,
   *  refusesLaunches, error, remedy }`. Optional for the same reason as the statics above: the
   *  pinned addon predates it, and crew classifies with its own registry copy until it lands
   *  (`projects/state-home-preflight.ts`). */
  preflightStateHome?(snapshotPath: string | null, dbPath: string): Promise<string>;
  /** DES-TEAMING-002 T0 (wicked-core-ts ≥ the release carrying it): the engine's ONE connection to
   *  the bus file at `path` — JSON `{ opens, opener }`, or `null` when it never opened that file.
   *  Its PRESENCE is the capability: an engine carrying it opens the bus off its actor thread, holds
   *  one connection per bus file for the life of the process and routes the gate judge to the bus
   *  only under exec. One without it opens-and-closes its bus connections, which on a file crew's
   *  seams also hold drops their locks (F-E2E-021), so crew does not hand such an engine the bus. */
  busConnectionStats?(path: string): string | null;
  /** DES-TEAMING-002 T3 (wicked-core-ts ≥ the release carrying it): the addon carries the plan
   *  approval gate — `LaunchOptions.planJson` / `deliverStepJson` and `confirmGate(…, planJson)`.
   *  Its PRESENCE is the capability: napi ignores an undeclared object field, so an older addon
   *  would drop a plan and run the launch unplanned and UNGATED. */
  supportsPlanLaunch?(): boolean;
  /** DES-MCP-TOOLS-001 S1 (wicked-core-ts ≥ the release carrying it): judge and record ONE brokered
   *  MCP call for the unit a worker's `WICKED_MCP_TOKEN` is bound to. Rejects with `invalid_token:`,
   *  `bad_request:` or `guard_error:`. */
  evaluateMcpCall?(requestJson: string): Promise<string>;
  /** DES-MCP-TOOLS-001 S3: the output decision over a brokered call's scrubbed result. */
  evaluateMcpOutput?(requestJson: string): Promise<string>;
  /** DES-MCP-TOOLS-001 S4: the token's unit's visible tool list, judged and recorded nowhere. */
  listMcpTools?(requestJson: string): Promise<string>;
}

/** The engine's two MCP broker calls (`Core.evaluateMcpCall` / `Core.evaluateMcpOutput`). */
export interface McpEngineGate {
  evaluateCall(requestJson: string): Promise<string>;
  evaluateOutput(requestJson: string): Promise<string>;
}

/** The engine's replay report (`Core.replayEmitOutbox`), parsed. */
export interface EmitOutboxReplayReport {
  /** Non-empty lines read from the outbox. */
  read: number;
  /** Entries written to the store as EVENT nodes. */
  replayed: number;
  /** Entries that did not land — the ORIGINAL line verbatim (so the caller can keep it dead-lettered) and why. */
  failed: Array<{ line: string; reason: string }>;
  /** Entries already on the store from an earlier replay (deterministic replay ids make a re-replay a
   *  no-op); absent on an engine that predates the field. */
  already_present?: number;
}

const { Core } = require('wicked-core-ts') as { Core: CoreConstructor };

/**
 * Does the linked engine carry DES-TEAMING-002 T3's plan launch (`Core.supportsPlanLaunch`)? A
 * plan handed to an addon without it would be silently ignored — the run launches as free text,
 * with no `plan.proposed` and no `plan_approval` gate — so every plan path fails CLOSED on this.
 * Read at call time (not cached): the addon is resolved once, but tests swap the static.
 */
export function engineSupportsPlanLaunch(): boolean {
  return typeof Core.supportsPlanLaunch === 'function' && Core.supportsPlanLaunch() === true;
}

/** A plan path on an engine without the plan approval gate (maps to 501 at the HTTP boundary). */
export class PlanLaunchUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} needs a wicked-core-ts that carries the plan approval gate (Core.supportsPlanLaunch, ` +
        `DES-TEAMING-002 T3); the installed addon would drop the plan and run the launch ungated`,
    );
    this.name = 'PlanLaunchUnsupportedError';
  }
}

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

/** Does the installed addon understand `LaunchOptions.excludeSeats` (EP-K3, >= 0.7.35)? Same doctrine. */
function addonSupportsExcludeSeats(): boolean {
  return addonAtLeast(0, 7, 35);
}

/** Does the installed addon judge a plan or preset launch's declared deliverables
 *  (`LaunchOptions.deliverables`, wicked-core#858, >= 0.7.48)? Same doctrine: an older addon
 *  ignores the field, and the run would never be held to its deliverable. */
export function addonSupportsLaunchDeliverables(): boolean {
  return addonAtLeast(0, 7, 48);
}

/** Does the installed addon carry the assurance contract (`LaunchOptions.reducedAssurance`,
 *  wicked-core#850, >= 0.7.46)? Same doctrine. */
export function addonSupportsReducedAssurance(): boolean {
  return addonAtLeast(0, 7, 46);
}

/** Does the installed addon carry the QE acceptance decision (`LaunchOptions.skipQeAcceptanceReason`
 *  / `forceQeAcceptance`, `assurance.qe`; QE-IN-APP-WORKFLOWS, >= 0.7.48)? Same doctrine. */
export function addonSupportsQeOverride(): boolean {
  return addonAtLeast(0, 7, 48);
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
/**
 * The wave-3 arms (wicked-core PR-1B `action` / `amendScope`, PR-1D `denial_gate`) need an addon of
 * at least 0.7.27. ONE fail-closed rule for all of them (review-L1-598 M1): a napi call silently
 * DROPS a field the addon does not declare — a `request_changes` would run as a plain reject, an
 * `auto_reject` campaign would `hold` forever exactly when told not to — so a caller that asked for
 * an arm the installed engine lacks is REFUSED with a named reason (the routes answer 409), never
 * served a silent no-op. `null` ⇒ the addon carries the arms. `supported` is injectable so the
 * old-addon path is unit-testable without booting an engine.
 */
export function armsUnsupportedReason(
  feature: string,
  remedy: string,
  supported: boolean = addonAtLeast(0, 7, 27),
): string | null {
  return supported
    ? null
    : `${feature} needs wicked-core-ts >= 0.7.27 (installed engine is older) — ${remedy}`;
}

/** The recogniser the routes map to 409: the engine-too-old refusal above, by its fixed phrase. */
export const ENGINE_TOO_OLD_RE = /needs wicked-core-ts >= /;

/**
 * Does the installed engine bench a seat whose ballots fail PERSISTENTLY without a recognised
 * reason (wicked-core #523's unclassified arm, 3D')? From 0.7.27 only. crew deleted its own
 * cross-run bench in the same release (BC-15) on the strength of that arm, and the runtime pin
 * still allows 0.7.26 — so the one place that matters (the daemon's boot log) says which engine it
 * has. `supported` is injectable so the old-engine path is unit-testable without an addon.
 */
export function engineBenchesUnclassifiedSeats(supported: boolean = addonAtLeast(0, 7, 27)): boolean {
  return supported;
}

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
// Static mirrors of wicked-core workflow defs: feature, bug, migration and domain-extraction, plus
// crew's own defs. `chat` and `onboarding` are engine built-in PRESETS (DES-TEAMING-002 M3/M4),
// launched by the same name with no def here; `survey-repo`, `memories`, `domain-graph-slice` and
// `collab` are deleted (nothing launched them).
// Swap for `this.core.listWorkflowsJson()` / `this.core.getWorkflowJson(id)` once
// the wicked-core-ts NAPI methods land.
/**
 * The ids wicked-core seeds itself, in `WorkflowRegistry::with_defaults()`.
 *
 * `launchRun`'s generic drop-in overlay write SKIPS every id in this set.
 * A file in that dir shadows the compiled built-in
 * *wholesale* — `register` overwrites by id and `load_dir` runs after `with_defaults` — so writing
 * this hand-transcribed mirror over the real def silently replaces it with a copy missing whatever
 * the def has grown since the mirror was transcribed. That is not hypothetical: the mirror predated
 * the evidence floors, so the write took `validator_pin` back off `feature.adversarial-review`,
 * `bug.verify` and `migration.verify` — the entire content of core's gate-floor change, undone by a
 * file write, with no error and a workflow still reporting the right id and phases (FINDING-049).
 *
 * The write exists for the ids core does NOT seed (domain-extraction and crew's own defs): for
 * those the overlay is the only reason they resolve at all, so it stays.
 */
const CORE_SEEDED_WORKFLOWS = new Set(['feature', 'bug', 'migration']);

// `EVIDENCE_FLOOR_PIN` (imported from ./deliver.js, defined once) is carried on the Evaluator phase
// of feature/bug/migration AND, since wicked-core F-039, on their code-writing Creator phases
// (`build`/`fix`/`execute`) — so the gate that was supposed to make the change re-derives its diff
// and a distinct seat judges it, instead of approving nothing. What `listWorkflows()` serves IS what
// `GET /api/v1/workflows` and the work-mode selector show, and a `null` here reads as "this phase
// is ungated" — the opposite of the truth. Since wicked-core#414 the engine also REFUSES a mirror
// that lags (a code phase whose gate evaluates nothing is rejected as authored), so these values
// are part of the contract with the engine, not display only: the drift guards in
// `tests/armed-workflow-served.test.ts` and `tests/builtin-overlay-shadow.test.ts` fail loudly
// the moment core's defs move. As of FINDING-049 these defs are never written to core's overlay dir
// (see CORE_SEEDED_WORKFLOWS).

// `is_system` is NOT spelled on these defs: `withSystemFlag` stamps it from `SYSTEM_WORKFLOWS`
// (core/run-identity.ts), the one list keyed by name that also classifies served runs (seam X2).
/** QE-IN-APP-WORKFLOWS (operator ruling 2026-10-10): what a workflow that makes application changes
 *  requires — the defaults plus `qe_acceptance` — exactly as core's `feature`/`bug`/`migration`/
 *  `mcp-server` defs declare it (the mirror guards compare field for field). */
const APP_CHANGE_INSTRUMENTS = ['distinct_evaluator', 'judge', 'qe_acceptance'];

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
  QE_AUTHOR_TESTS_WORKFLOW_DEF,
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
] satisfies WorkflowDef[]).map(withSystemFlag);

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
 * The preset bindings (DES-TEAMING-002 seam C2) are not in the installed `wicked-core-ts`. The
 * routes answer 501 ("upgrade the engine"), never 400.
 */
export class PresetsUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not supported by this wicked-core build (needs the wicked-core-ts release carrying presets)`);
    this.name = 'PresetsUnsupportedError';
  }
}

/**
 * A team binding (DES-TEAMING-002 T8) is not in the installed `wicked-core-ts`. The routes answer
 * 501 ("upgrade the engine"), never 400.
 */
export class TeamUnsupportedError extends Error {
  constructor(what: string, binding: string) {
    super(`${what} is not supported by this wicked-core build (needs the wicked-core-ts binding Core.${binding})`);
    this.name = 'TeamUnsupportedError';
  }
}

/**
 * `resolveElicitation` is not available in this deployment — the installed `wicked-core-ts`
 * predates the binding (< 0.7.2). Feature-detected by method presence, the
 * `interactionRequests`/`runEvents` convention (crew#357/#358 wired the live path; this
 * error is now only the older-addon detect, no longer an always-throw stub).
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

/**
 * Replaying a dead-letter outbox is not available in this deployment — the installed
 * wicked-core-ts predates the `Core.replayEmitOutbox` static (crew#495's engine companion). Typed
 * for the same reason as `SteeringUnsupportedError`: the CLI says "upgrade the engine" (exit 2) and
 * never pretends the entries landed. Gated on METHOD PRESENCE, the campaigns doctrine.
 */
export class GovernanceReplayUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not supported by this wicked-core build (the installed wicked-core-ts has no ` +
        'replayEmitOutbox binding — upgrade it to a release carrying the crew#495 governance ' +
        'store companion)',
    );
    this.name = 'GovernanceReplayUnsupportedError';
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
  /** The scope the engine recorded at open (wicked-core#410 / crew#502): where the seats run, the
   *  graph their read-only estate MCP is bound to, the roots in scope. ABSENT (not null) on an
   *  engine predating chat scope. */
  cwd?: string | null;
  codeGraphDb?: string | null;
  readRoots?: string[];
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
  /**
   * The wicked-bus SQLite db handed to the engine as `WICKED_BUS_DB` (DES-TEAMING-002 T0): the
   * daemon's OWN cross-product bus, the file crew's seams use, on EVERY boot — not only under
   * `engineExec`. The engine opens it off its actor thread; exec mediation, when armed, runs over
   * the same file. Required when `engineExec` is on. Absent (a library boot, a unit test, or a
   * daemon whose bus could not open — see `busUnavailable`) exports nothing.
   */
  busDbPath?: string;
  /**
   * Why the daemon hands the engine NO bus (its boot probe could not open the resolved file). The
   * engine then runs without a bus, and `/health.warnings` carries a `bus.unavailable` notice
   * naming this reason (T0: a daemon-level notice; a per-run `transport:"none"` lands with P1).
   */
  busUnavailable?: BusUnavailable;
  /**
   * The governance store + dead-letter outbox this daemon hands the engine (crew#495 / F-022) —
   * resolved by the CLI (`core/governance-store.ts`), exported to `process.env` HERE, before the
   * Core exists, as `WICKED_ESTATE_DB` + `WICKED_APPS_EMIT_DEADLETTER` (the emit seam reads both at
   * emit time). Absent — a library boot, a unit test — exports nothing: the engine keeps whatever
   * the process carried (the hermetic test arming included) and `/diagnostics` reports `store: null`.
   */
  governanceStore?: GovernanceStoreLocation;
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

/**
 * The drop-in ids crew wrote into the overlay dir before DES-TEAMING-002 wave 1 retired them:
 * `chat` is the engine's built-in preset now, and `survey-repo`, `memories` and
 * `domain-graph-slice` are deleted. Exported for the quarantine test.
 */
export const RETIRED_OVERLAY_IDS = ['chat', 'survey-repo', 'memories', 'domain-graph-slice'] as const;

/**
 * Park the overlay files older crews wrote for {@link RETIRED_OVERLAY_IDS}.
 *
 * `_writeBuiltinOverlay` wrote each of these on first launch, and the overlay dir is PERSISTENT: on
 * an upgraded host the engine's startup `load_dir` would keep the deleted workflows launchable, and
 * `hydrateFromOverlay` would serve them on `GET /workflows` as user workflows, where they are no
 * longer on the system list (review of wicked-crew#688). Renamed, not deleted, like the onboarding
 * quarantine above: the evidence stays, and a name retired by operator decision (2026-09-26) is
 * not a workflow any more — save a preset instead.
 */
function quarantineRetiredOverlays(): void {
  for (const id of RETIRED_OVERLAY_IDS) {
    const stale = join(workflowOverlayDir(), `${id}.json`);
    if (!existsSync(stale)) continue;
    const parked = `${stale}.retired-des-teaming-002`;
    try {
      renameSync(stale, parked);
      console.warn(
        `[workflows] parked ${stale} → ${parked}: \`${id}\` is retired (DES-TEAMING-002 wave 1` +
          `${id === 'chat' ? '; chat is the engine\'s built-in preset' : '; the workflow is deleted'}).`,
      );
    } catch (err) {
      console.error(
        `[workflows] FAILED to park the retired overlay ${stale}: ${
          err instanceof Error ? err.message : String(err)
        }. The engine will keep resolving \`${id}\` from it until it is removed by hand.`,
      );
    }
  }
}

/** The ids of a workflow's phases that carry a HUMAN gate (`human_confirm` unconditional, the
 * conditional `human_confirm_if`, or `consent_before` — crew#888, which pauses BEFORE the phase
 * runs) — i.e. the phases that will PAUSE for a person.
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
        p.gate === 'consent_before' ||
        (typeof p.gate === 'object' &&
          p.gate !== null &&
          ('human_confirm' in p.gate || 'human_confirm_if' in p.gate)),
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
/**
 * A launch the daemon hands the engine — or one the engine refused. `handed` is notified BEFORE the
 * engine call (the skills seam opens a generation pin for the launch, so no worker spawn can read
 * `WICKED_SKILLS_SNAPSHOT` ahead of the pin — live-generations.ts); `rejected` follows a call that
 * threw (nothing will ever spawn for it); `accepted` follows a call that RESOLVED (the engine took
 * it — the only notice a durable per-run record may key on, crew#661). Every path a spawn can originate from goes through here:
 * `launchRun` (POST /runs, onboarding, testing, steering), `resumeRun`, `confirmGate`,
 * `launchCampaign`, `resumeCampaign`.
 */
export interface LaunchNotice {
  kind: 'run' | 'campaign';
  /** The run's session id (`LaunchRunInput.sessionId` / the run id) or the campaign's `CampaignDef.id`. */
  id: string;
  status: 'handed' | 'accepted' | 'rejected';
  /** The workflow id a NEW run launches (`LaunchRunInput.workflow` — the base id, before any per-run
   *  composition). Absent on a resume, a gate answer, a campaign, and a launch naming no workflow. */
  workflow?: string;
}
export type LaunchListener = (notice: LaunchNotice) => void;

/**
 * The engine serializes a rule's serde DEFAULTS as absent keys (`steering_type` architecture,
 * `weight` 1.0, empty `applies_to` / `excludes` — `skip_serializing_if` in wicked-governance's
 * `conformance.rs`). The import kept those values, but the browse wire then carried no key, and a
 * client that reads absence as null showed the first entry of an `architecture` import as untyped
 * and every 1.0 weight / empty scope as missing (#776). The read side materializes the four
 * defaults so every row says what the engine stored. Values the engine did serialize pass through.
 */
export function withRuleDefaults(rule: ConformanceRule): ConformanceRule {
  return {
    ...rule,
    steering_type: rule.steering_type ?? 'architecture',
    weight: rule.weight ?? 1,
    applies_to: rule.applies_to ?? [],
    excludes: rule.excludes ?? [],
  };
}

export class CoreAdapter {
  private readonly core: CoreHandleFull;
  private readonly subscription: Subscription;
  private readonly listeners = new Set<CoreEventListener>();
  private readonly launchListeners = new Set<LaunchListener>();
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
  /** The bus db handed to the engine (`WICKED_BUS_DB`; exec mediation runs over it when armed), or
   *  `undefined` when this adapter handed none. */
  readonly busDbPath: string | undefined;
  /** Why the engine has no usable bus — the boot probe's failure, or the engine could not arm its
   *  bus bridge on the handed bus within its bound — else `null`. */
  readonly busUnavailable: BusUnavailable | null;
  /** The bus file whose seams are off because the linked engine has no `Core.busEmit`/`busRead`
   *  (wicked-core#631) — `/health.warnings` says so — else `null`. */
  readonly busSeamsOff: string | null = null;
  /** The engine's bus calls, attached for `busDbPath` (core/bus.ts); `null` without a bus. */
  private engineBus: EngineBus | null = null;
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
  /** The governance store this adapter exported to the engine (crew#495), or `null` when none was resolved. */
  readonly governanceStore: GovernanceStoreLocation | null;
  /**
   * This daemon's own bound origin, resolved LAZILY (crew#524): the adapter exists before the
   * server listens, so `registerRoutes` hands a getter rather than a value. The deliver phase
   * composed for a run bakes the origin in, so its script can ask `GET /runs/:id/deliver-text`
   * for the run-derived PR text at delivery time and the PR body can link the run. `null` (a
   * CLI-driven adapter with no daemon) ⇒ the script carries only its launch-time text.
   */
  private deliverApiOrigin: (() => string | null) | null = null;

  /** Hand the adapter the way to learn this daemon's own origin (see `deliverApiOrigin`). */
  setDeliverApiOrigin(get: () => string | null): void {
    this.deliverApiOrigin = get;
  }

  /**
   * Called once per run THIS adapter launches OFF the `POST /runs` path — today the onboarding run
   * (`_doOnboardingLaunch`, the one site `POST /repos`, `POST /repos/:id/onboard` and the
   * clone-then-register path all reach; the last is adapter-internal, which is why this cannot live
   * in the routes) — after the engine accepted the launch. `createServer` wires it to
   * `recordRunLaunched`, so those runs gain a `run.launched` trail entry and a `created_at`
   * (crew#496 / studio#230; DES-L8 §5 PR-8B). `null` = a CLI-driven adapter with no daemon:
   * nothing recorded, the pre-field answer. Best-effort: a recorder that throws never fails the
   * launch the engine already accepted.
   */
  private onRunLaunched: ((runId: string, detail: Record<string, unknown>) => void) | null = null;

  /** Hand the adapter the daemon's launch recorder (see `onRunLaunched`). */
  setOnRunLaunched(record: (runId: string, detail: Record<string, unknown>) => void): void {
    this.onRunLaunched = record;
  }

  /**
   * The roster a launch THIS adapter originates should carry — the daemon's roster WITH crew's
   * standing (`api/roster-standing.ts`) once `createServer` wires it, else the raw registry.
   * F-RECON-002/003: the onboarding launch (`seatsForWorkflow`) and `wicked-crew start` handed the
   * engine `CoreAdapter.roster()` undecorated, so `launchRun`'s `engineRosterJson` had no
   * `council_eligible` to bench on and signed-out seats were convened. Resolved LAZILY, like the
   * origin above: the adapter exists before the tracker that knows the seats' standing does.
   */
  private rosterProvider: ((() => unknown[]) & { ready?: () => Promise<void> }) | null = null;

  /** Hand the adapter the daemon's standing roster accessor (see `launchRoster`). */
  setRosterProvider(get: (() => unknown[]) & { ready?: () => Promise<void> }): void {
    this.rosterProvider = get;
  }

  /** The seat pool a launch from this adapter carries: standing-decorated when wired, else raw. */
  launchRoster(): unknown[] {
    return this.rosterProvider !== null ? this.rosterProvider() : CoreAdapter.roster();
  }

  /** {@link launchRoster} after the seats' login checks answered (bounded, crew#645): an expired
   *  login reads signed out before the launch routes work to it. */
  async readyLaunchRoster(): Promise<unknown[]> {
    await this.rosterProvider?.ready?.();
    return this.launchRoster();
  }

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
    quarantineRetiredOverlays();

    // DES-TEAMING-002 T0: the engine gets the daemon's bus on EVERY boot (`WICKED_BUS_DB`); exec
    // mediation stays a separate switch (`WICKED_BUS_EXEC`), set only under `engineExec`, and the
    // engine's bus gate-judge path follows that switch — never the mere presence of a bus.
    const armExec = opts.engineExec === true;
    const busDbPath = opts.busDbPath !== undefined && opts.busDbPath.length > 0 ? opts.busDbPath : undefined;
    if (armExec && busDbPath === undefined) {
      throw new Error('engineExec requires busDbPath (the wicked-bus db to mediate execution over)');
    }
    // process.env matches the decision EXACTLY before the engine spawns: the engine reads both
    // variables itself, so an inherited value the decision did not hand it (an unopenable bus crew
    // declined, an exec switch crew did not arm) would otherwise reach it anyway — fail-open.
    if (busDbPath !== undefined) process.env['WICKED_BUS_DB'] = busDbPath;
    else delete process.env['WICKED_BUS_DB'];
    if (armExec) process.env['WICKED_BUS_EXEC'] = '1';
    else delete process.env['WICKED_BUS_EXEC'];
    this.engineExec = armExec;
    this.busDbPath = busDbPath;
    this.busUnavailable = busDbPath === undefined ? (opts.busUnavailable ?? null) : null;

    // Give the Rust actor the path to the wicked-core standalone binary so the gate-hook
    // command works when wicked-core is loaded as a napi-rs addon (where current_exe()
    // returns the Node.js interpreter, not wicked-core). The actor checks WICKED_CORE_EXE
    // first, so this env wins over the current_exe() fallback.
    if (!process.env['WICKED_CORE_EXE']) {
      const wcExe = locateWickedCoreExe();
      if (wcExe) process.env['WICKED_CORE_EXE'] = wcExe;
    }

    // The governance store (crew#495): export the engine's store + outbox variables and create the
    // sidecar BEFORE the engine exists, in the same breath as the other engine env above. Without
    // this, every `wicked.*` governance event the engine emits dead-letters under the operator's
    // HOME — silently, on every default install.
    this.governanceStore = opts.governanceStore ?? null;
    if (this.governanceStore !== null) applyGovernanceStoreEnv(this.governanceStore);

    this.stub = opts.stub === true;
    this.dbPath = opts.dbPath;
    this.core = this.stub ? Core.spawnStub(opts.dbPath) : Core.spawn(opts.dbPath);
    // DES-TEAMING-002 T0: `spawn` returns only once the engine's bus bridge is armed, or has given up
    // within its bound. Not armed = the engine launches nothing from the bus: say so on the same
    // `bus.unavailable` path as a bus crew could not open.
    if (this.busDbPath !== undefined && typeof this.core.busBridgeState === 'function') {
      const state = JSON.parse(this.core.busBridgeState()) as { state: string; reason?: string };
      if (state.state === 'not-armed') {
        const reason = `the engine could not arm its bus bridge: ${state.reason ?? 'no reason given'}`;
        this.busUnavailable = { dbPath: this.busDbPath, reason: state.reason ?? 'no reason given', kind: 'bridge_not_armed' };
        console.error(`[crew] bus unavailable: ${this.busDbPath} (${reason}) — the engine launches nothing from the bus`);
      }
    }
    // wicked-core#631: crew's seams write and read this bus through the engine that holds it —
    // crew opens no SQLite of its own (core/bus.ts). An engine without the bus calls leaves every
    // seam unarmed (each logs why); crew does not fall back to a second library.
    if (this.busDbPath !== undefined) {
      const core = this.core;
      if (typeof core.busEmit === 'function' && typeof core.busRead === 'function') {
        this.engineBus = {
          busEmit: (eventJson) => core.busEmit!(eventJson),
          busRead: (afterId, limit, typePrefix, includeExpired) => core.busRead!(afterId, limit, typePrefix, includeExpired),
        };
        attachEngineBus(this.busDbPath, this.engineBus);
      } else {
        (this as { busSeamsOff: string | null }).busSeamsOff = this.busDbPath;
        console.error(
          `[crew] the linked wicked-core-ts has no Core.busEmit/busRead (wicked-core#631) — crew's bus seams on ${this.busDbPath} stay off; upgrade the engine`,
        );
      }
    }
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

  /**
   * The engine's EVENT-node counter over an estate store (`Core.eventStoreCount`, crew#495's
   * companion binding), or `null` when the installed addon predates it — `/diagnostics.governance`
   * then reports `records: { total: null, sinceBoot: null }`, honestly, never a fabricated 0. A
   * store FILE that does not exist yet counts as 0: nothing has landed, which is a number, not an
   * unknown (the engine's read-only open refuses a missing file, and that refusal is not "unknown").
   */
  /**
   * The engine's MCP broker gate (DES-MCP-TOOLS-001 §6 steps 3 and 8), or `null` on an addon without
   * BOTH `Core.evaluateMcpCall` and `Core.evaluateMcpOutput`: the broker then refuses every call
   * (`guard_error`), never runs one unjudged. Read at call time: tests swap the statics.
   */
  static mcpEngineGate(): McpEngineGate | null {
    const call = Core.evaluateMcpCall;
    const output = Core.evaluateMcpOutput;
    if (typeof call !== 'function' || typeof output !== 'function') return null;
    return {
      evaluateCall: (requestJson: string) => call.call(Core, requestJson),
      evaluateOutput: (requestJson: string) => output.call(Core, requestJson),
    };
  }

  /**
   * The engine's tool list for a token's unit (`Core.listMcpTools`, DES-MCP-TOOLS-001 §8, slice S4),
   * or `null` on an addon without it: `POST /mcp/tools` then answers 503, never an unjudged list.
   * Read at call time: tests swap the static.
   */
  static mcpToolLister(): ((requestJson: string) => Promise<string>) | null {
    const list = Core.listMcpTools;
    if (typeof list !== 'function') return null;
    return (requestJson: string) => list.call(Core, requestJson);
  }

  /** Whether the linked engine follows the one-connection bus rule (`Core.busConnectionStats`,
   *  DES-TEAMING-002 T0) and may therefore be handed the daemon's bus on every boot. */
  static engineHoldsBusConnection(): boolean {
    return typeof Core.busConnectionStats === 'function';
  }

  static eventStoreCounter(): ((dbPath: string) => Promise<number>) | null {
    const fn = Core.eventStoreCount;
    if (typeof fn !== 'function') return null;
    return async (dbPath: string): Promise<number> => {
      if (!isStoreSpec(dbPath) && !existsSync(dbPath)) return 0;
      const raw = await fn.call(Core, dbPath);
      const n = Number(JSON.parse(raw));
      if (!Number.isInteger(n) || n < 0) throw new Error(`eventStoreCount answered a non-count: ${raw}`);
      return n;
    };
  }

  /**
   * The engine's state-home preflight (wicked-core#411 / crew#497), or `null` on an addon without
   * `Core.preflightStateHome` — crew's `StateHomeWatch` then classifies with its own registry copy
   * and says so (`source: 'crew'`), never a fabricated clean answer.
   */
  static stateHomePreflighter(): ((snapshotPath: string | null, dbPath: string) => Promise<string>) | null {
    const fn = Core.preflightStateHome;
    if (typeof fn !== 'function') return null;
    return (snapshotPath: string | null, dbPath: string): Promise<string> => fn.call(Core, snapshotPath, dbPath);
  }

  /** Whether the installed addon can replay a dead-letter outbox (`Core.replayEmitOutbox`, crew#495). */
  static replayEmitOutboxSupported(): boolean {
    return typeof Core.replayEmitOutbox === 'function';
  }

  /**
   * Replay the engine's NDJSON spool records at `outboxPath` into the estate store at `dbPath` —
   * the engine writes each as the EVENT node it should have been (its original `ts` restored where
   * the record carries one). Throws {@link GovernanceReplayUnsupportedError} on an older addon.
   */
  static async replayEmitOutbox(outboxPath: string, dbPath: string): Promise<EmitOutboxReplayReport> {
    const fn = Core.replayEmitOutbox;
    if (typeof fn !== 'function') {
      throw new GovernanceReplayUnsupportedError('Replaying a dead-letter outbox');
    }
    const raw = await fn.call(Core, outboxPath, dbPath);
    const parsed = JSON.parse(raw) as Partial<EmitOutboxReplayReport>;
    if (
      typeof parsed.read !== 'number' ||
      typeof parsed.replayed !== 'number' ||
      !Array.isArray(parsed.failed)
    ) {
      throw new Error(`replayEmitOutbox answered an unexpected report: ${raw.slice(0, 200)}`);
    }
    return {
      read: parsed.read,
      replayed: parsed.replayed,
      failed: parsed.failed,
      ...(typeof parsed.already_present === 'number' ? { already_present: parsed.already_present } : {}),
    };
  }

  /** Register a CoreEvent listener. Returns an unsubscribe function. */
  onEvent(listener: CoreEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register a launch listener (`LaunchNotice`). Returns an unsubscribe function. */
  onLaunch(listener: LaunchListener): () => void {
    this.launchListeners.add(listener);
    return () => {
      this.launchListeners.delete(listener);
    };
  }

  /**
   * Deliver a launch notice to EVERY listener; a listener's failure PROPAGATES (codex round 6 on
   * crew#480 — the notices used to be delivered under a swallowing try/catch). The `handed` notice is
   * what pins the skills generation the launch is about to read (skills/runtime.ts →
   * live-generations.ts): a pin that could not be recorded means the generation could be reaped
   * under the spawn, so the launch must not proceed and the failure is the launch's failure. Every
   * listener is still notified (a later one is not skipped because an earlier one threw); the FIRST
   * error is what propagates.
   */
  private notifyLaunch(notice: LaunchNotice): void {
    let failure: { err: unknown } | null = null;
    for (const listener of this.launchListeners) {
      try {
        listener(notice);
      } catch (err) {
        if (failure === null) failure = { err };
      }
    }
    if (failure !== null) throw failure.err instanceof Error ? failure.err : new Error(String(failure.err));
  }

  /**
   * Hand a launch to the engine with its notices: `handed` BEFORE the call (the pin is open before
   * any spawn can read the env), `rejected` when the call throws (nothing will spawn — the pin is
   * released). The result and the error pass through untouched.
   *
   * A listener that FAILS on `handed` fails the launch: the engine is never called (nothing spawns
   * against a generation nobody pinned), the other listeners get `rejected` so whatever they did
   * record is released, and the listener's error surfaces to the caller as the launch error —
   * never swallowed (codex round 6). A listener failing on `rejected` cannot un-launch anything;
   * the primary error keeps precedence and the secondary one is logged, not lost.
   */
  private async handedToEngine<T>(
    kind: LaunchNotice['kind'],
    id: string,
    call: () => Promise<T>,
    workflow?: string,
  ): Promise<T> {
    try {
      this.notifyLaunch({ kind, id, status: 'handed', ...(workflow !== undefined ? { workflow } : {}) });
    } catch (err) {
      this.releaseAfterFailure(kind, id, err);
      throw err;
    }
    let out: T;
    try {
      out = await call();
    } catch (err) {
      this.releaseAfterFailure(kind, id, err);
      throw err;
    }
    this.announceAccepted({ kind, id, status: 'accepted', ...(workflow !== undefined ? { workflow } : {}) });
    return out;
  }

  /** Deliver `accepted` once the engine TOOK the launch. Never propagates: the launch already happened,
   *  so a listener failure is logged and must not turn an accepted run into a rejected call. */
  private announceAccepted(notice: LaunchNotice): void {
    for (const listener of this.launchListeners) {
      try {
        listener(notice);
      } catch (err) {
        console.warn(`[crew] launch ${notice.kind}:${notice.id} accepted, but a launch listener failed on it: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Deliver `rejected` while a launch is already failing with `primary`: a secondary listener failure is logged, never masks the primary. */
  private releaseAfterFailure(kind: LaunchNotice['kind'], id: string, primary: unknown): void {
    try {
      this.notifyLaunch({ kind, id, status: 'rejected' });
    } catch (secondary) {
      console.warn(
        `[crew] launch ${kind}:${id} failed (${primary instanceof Error ? primary.message : String(primary)}) and a launch listener ALSO failed while releasing its pin: ${secondary instanceof Error ? secondary.message : String(secondary)} — the pin may be held until the run's terminal frame`,
      );
    }
  }

  /** The production council roster (static), parsed to seats. */
  static roster(): unknown[] {
    return JSON.parse(Core.registryRoster()) as unknown[];
  }

  /** Liveness probe → `"ok"` (also proves the event pump). */
  ping(): Promise<string> {
    return this.core.ping();
  }

  /**
   * What THIS daemon's engine addon can do — served on `GET /health.capabilities` so a client
   * (the studio composer) promises only what the deployment keeps. `deliverGate`: the engine
   * pauses before the composed `deliver` phase unless the launch opted out (F-E2E-030,
   * wicked-core-ts ≥ 0.7.24). Version-derived like the other addon probes above — a napi object
   * silently ignores fields an older addon does not declare, so the version is the only honest
   * signal until the field lands.
   */
  engineCapabilities(): {
    deliverGate: boolean;
    revisesPr: boolean;
    chatIdOnLaunch: boolean;
    seatChipOnCreate: boolean;
    askPath: boolean;
  } {
    return {
      deliverGate: addonAtLeast(0, 7, 24),
      // DES-ASK-TEAM-CHAT-001 §5.1: the WHOLE ask-path contract (primary pick, per-step budget,
      // Approve applying held revisions, first-creator row, output review, the renderer) is the
      // core-ts release that carries ASK-K1a–K3c; launch fields alone cannot prove the second
      // message or the review will work, so the floor is the release, not a field.
      askPath: addonAtLeast(0, 7, 38),
      // DES-L9 / crew#550: `LaunchRunBody.revisesPr` needs the engine's `LaunchSpec.base_ref`
      // (wicked-core-ts ≥ 0.7.27) — an older addon would base on the default branch and push a
      // duplicate PR, so the route fails closed and the composer hides the affordance.
      revisesPr: addonAtLeast(0, 7, 27),
      // crew#619: `LaunchRequest.chatId` is crew-side; always available once this daemon is deployed.
      chatIdOnLaunch: true,
      // crew#631: per-doc `clisJson` on interactive create bodies; always available once deployed.
      seatChipOnCreate: true,
    };
  }

  /** Whether this engine carries the plan approval gate (DES-TEAMING-002 T3) — see
   *  [`engineSupportsPlanLaunch`]. An instance method so a partial-stub adapter can say either. */
  /**
   * (wicked-core#858, X-MIG M9) Hand a plan or preset launch's declared deliverables to the engine
   * (`LaunchOptions.deliverables`). Fails CLOSED on an addon before the field (napi ignores it, so
   * the run would never be held to them).
   */
  private passLaunchDeliverables(opts: LaunchOptions, deliverables: string[], what: string): void {
    if (deliverables.length === 0) return;
    if (!addonSupportsLaunchDeliverables()) {
      throw new Error(
        `requireDeliverables on ${what} needs wicked-core-ts >= 0.7.48 (LaunchOptions.deliverables, ` +
          'wicked-core#858); the installed addon would drop them and the run would not be held to them',
      );
    }
    (opts as LaunchOptions & { deliverables?: string[] }).deliverables = deliverables;
  }

  supportsPlanLaunch(): boolean {
    return engineSupportsPlanLaunch();
  }

  /**
   * (crew#549, crew#737) The CONFIGURED deliver identity for a launch: the repository's own pin
   * (`deliverIdentityByRepo[repoRef]`) else the daemon-wide `deliverIdentityLogin`, and — for a
   * delivering launch — whether that login is signed in to gh on this machine (a bounded
   * `gh auth status`). RETURNED, never stashed on the adapter: two concurrent delivering launches
   * on different repositories must not read each other's identity (the F2 origin rule). A LOGIN
   * only: no token is ever read here. `login: ''` ⇒ nothing configured (`GH_ACCOUNT` decides).
   */
  private async resolveDeliverIdentity(
    repoRef: string | null | undefined,
    probe: boolean,
  ): Promise<{ login: string; source: 'repo' | 'setting'; signedIn: boolean | null }> {
    let login = '';
    let source: 'repo' | 'setting' = 'setting';
    try {
      ({ login, source } = deliverIdentityFor(await this.getSettings(), repoRef));
    } catch {
      // A settings file that cannot be read leaves the identity unconfigured rather than
      // failing the launch — the deliver script still cross-checks gh against git's credential.
      login = '';
    }
    let signedIn: boolean | null = null;
    if (probe && login !== '') {
      const logins = await ghSignedInLogins().catch(() => null);
      signedIn = logins === null ? null : logins.includes(login);
    }
    return { login, source, signedIn };
  }

  /**
   * The origin the deliver push will actually go to (F2) so the deliver GATE CARD says what will
   * actually happen. The card used to promise "pushes its branch and opens a pull request"
   * whatever the origin was — on a local path, an SSH, GitLab, ADO or Gitea remote, the phase
   * pushed the branch and then died on `gh pr create`, so the operator had consented to a pull
   * request that could not exist.
   *
   * RETURNED, never stashed on the adapter (codex review of the F2 PR, HIGH): two concurrent
   * delivering launches on different repos would otherwise interleave their `await` with the
   * synchronous composition that reads it, and one launch's card would name the other repo's
   * origin. The value is launch-local from here on.
   *
   * ONE `git remote get-url --push` per delivering launch, in the registered repo's root (a run
   * worktree shares its repo's remotes, and the worktree does not exist yet at compose time).
   * `null` for everything that can go wrong — "could not read it" is not a licence to claim
   * anything about it either way, and the card keeps its generic sentence. Only git's own "no such
   * remote" becomes `''`, the one answer that licenses "there is no origin".
   */
  private async resolveDeliverOrigin(repoRef: string | null | undefined): Promise<string | null> {
    if (repoRef === null || repoRef === undefined || repoRef === '') return null;
    try {
      const repos = await this.listRepos();
      const hit = deliverRepoFor(repos, repoRef);
      if (hit === undefined || hit.root_path === '') return null;
      return await readDeliverOriginUrl(hit.root_path);
    } catch {
      // An engine that cannot list repos leaves the origin UNKNOWN — the card keeps its generic
      // sentence rather than claim anything. `readDeliverOriginUrl` owns the git-side verdicts.
      return null;
    }
  }

  /** The launcher's `deliver` step for a plan (`name` null) or a preset launch (DES-TEAMING-002
   *  §8.5): the engine appends it to the plan and puts it in the floor. */
  private deliverStep(
    name: string | null,
    phases: PhaseDef[],
    input: LaunchRunInput,
    /** (F2) The origin this launch resolved — launch-local, never adapter state. */
    originUrl: string | null,
    /** (crew#737) The identity this launch resolved — launch-local, never adapter state. */
    identity: { login: string; source: 'repo' | 'setting'; signedIn: boolean | null },
    /** (crew#720) The provider credential preflight this launch read. */
    credentials: DeliverCredentials | null,
  ): ReturnType<typeof deliverPresetStep> {
    return deliverPresetStep(name, phases, input.sessionId, input.problem, {
      repoRef: input.repoRef ?? null,
      apiOrigin: this.deliverApiOrigin?.() ?? null,
      revisesPr: input.revisesPr ?? null,
      ghAccount: process.env['GH_ACCOUNT'] ?? null,
      ghTokenPinned: typeof process.env['GH_TOKEN'] === 'string' && process.env['GH_TOKEN'] !== '',
      originUrl,
      deliverIdentity: identity.login,
      deliverIdentitySource: identity.source,
      deliverIdentitySignedIn: identity.signedIn,
      credentials,
    });
  }

  /** Launch an interactive, resumable run → the run id. */
  async launchRun(input: LaunchRunInput): Promise<string> {
    // (crew#549, crew#737) Read the configured deliver identity BEFORE anything composes the deliver
    // phase: the compose paths below are synchronous and bake it into the script. Launch-local.
    const deliverIdentity = await this.resolveDeliverIdentity(input.repoRef, input.deliver === 'pr');
    // (F2) And the origin the push would go to — read once, for the gate card's target sentence.
    // Only a delivering launch composes a deliver phase, so only a delivering launch pays for it.
    const deliverOriginUrl = input.deliver === 'pr' ? await this.resolveDeliverOrigin(input.repoRef) : null;
    // (crew#720) And whether the provider credential is there — presence only, read once.
    const deliverCredentials = input.deliver === 'pr' ? await deliverCredentialsProbe(deliverOriginUrl, process.env) : null;
    const opts: LaunchOptions = {
      problem: input.problem,
      sessionId: input.sessionId,
      // The roster crew hands the ENGINE (wave 6, `core/engine-roster.ts`): the studio round-trips
      // `GET /roster` seats — decorated with crew's own `health {status}`, `auth`, `council_eligible`
      // readings — into `clisJson`; the wave-6 engine grew `AgenticCli.health {usable, reason}` under
      // the SAME key, so the readings are stripped and `council_eligible` becomes the engine's
      // bench verdict. An older engine ignores the stamp; a newer one benches the seat for the run.
      clisJson: engineRosterJson(input.clisJson),
    };
    if (input.entityMode !== undefined) opts.entityMode = input.entityMode;
    if (input.humanConfirm !== undefined) opts.humanConfirm = input.humanConfirm;
    // ASK-K1a: `LaunchSpec.primary`. napi ignores an undeclared object field on an older addon.
    if (input.primary !== undefined) (opts as LaunchOptions & { primary?: string }).primary = input.primary;
    if (input.autoDeliver === true) {
      // F-E2E-030: the explicit deliver-gate opt-out (`LaunchOptions.autoDeliver`, wicked-core-ts
      // ≥ 0.7.24). Sent ONLY when true — the engine's default is the gate, and an addon that
      // predates the field ignores it (such an engine has no deliver gate to opt out of, so the
      // launch behaves exactly as it did before this field existed). Typed through a widening so
      // this compiles against the pinned addon's typings until the pin moves.
      (opts as LaunchOptions & { autoDeliver?: boolean }).autoDeliver = true;
    }
    if (input.repoRef !== undefined) opts.repoRef = input.repoRef;
    if (input.baseRef !== undefined) {
      // DES-L9 / crew#550: the revised PR's head branch as the run's base (`LaunchSpec.base_ref`,
      // wicked-core-ts ≥ 0.7.27). Fail CLOSED on an older addon — napi ignores undeclared fields,
      // and a run silently based on the default branch would push a DUPLICATE pull request.
      if (!addonAtLeast(0, 7, 27)) {
        throw new Error(
          'revisesPr needs wicked-core-ts >= 0.7.27; the installed addon would silently ignore the ' +
            'base and the run would open a second pull request instead of revising the first',
        );
      }
      (opts as LaunchOptions & { baseRef?: string }).baseRef = input.baseRef;
    }
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
    if (input.excludeSeats !== undefined && input.excludeSeats.length > 0) {
      // Fail CLOSED on an old addon (napi ignores undeclared fields): a silently-dropped exclusion
      // would let the seat that wrote the work judge it — the one thing the caller asked to rule out.
      if (!addonSupportsExcludeSeats()) {
        throw new Error(
          'excludeSeats needs wicked-core-ts >= 0.7.35; the installed addon would silently ignore it ' +
            'and a seat the launch excluded could judge the run',
        );
      }
      opts.excludeSeats = input.excludeSeats;
    }
    if (input.reducedAssurance === true) {
      // Fail CLOSED on an old addon (napi ignores undeclared fields): an addon before the assurance
      // contract has no refusal to opt out of, so the caller's explicit waiver would be recorded
      // against a run the engine never knew was reduced — the receipt and the run would disagree.
      if (!addonSupportsReducedAssurance()) {
        throw new Error(
          'reducedAssurance needs wicked-core-ts >= 0.7.46; the installed addon has no assurance ' +
            'contract to reduce, and would record nothing of the waiver the launch asked for',
        );
      }
      opts.reducedAssurance = true;
    }
    if (input.skipQeAcceptanceReason !== undefined || input.forceQeAcceptance === true) {
      // Fail CLOSED on an old addon (napi ignores undeclared fields): a dropped skip would leave a
      // run the operator meant to skip refusing its delivery, and a dropped force would let a score
      // waive what the operator required — either way the record and the run would disagree.
      if (!addonSupportsQeOverride()) {
        throw new Error(
          'skipQeAcceptance / forceQeAcceptance need wicked-core-ts >= 0.7.48; the installed addon ' +
            'has no QE acceptance decision to apply them to',
        );
      }
      if (input.skipQeAcceptanceReason !== undefined) opts.skipQeAcceptanceReason = input.skipQeAcceptanceReason;
      if (input.forceQeAcceptance === true) opts.forceQeAcceptance = true;
    }
    // SAFETY NET (grounding follow-on #1): ANY project-filed launch that did not already resolve a
    // project-graph binding gets one here, so no future project-filed caller can silently ship a run
    // that sees only its own repo — the exact gap the chat/edit seams had (projectId filed WITHOUT
    // projectGraph → `run_code_graph_db → None` → no estate MCP). The `=== undefined` guard means the
    // seams that ALREADY resolved (draft/demo/chat/edit — and POST /runs via routes.ts) pass their
    // own `projectGraph` and are NOT re-resolved here. `repoRef` is threaded through so a repo-bound
    // launch gets the `repoLabel` the cross-field validation below requires; a repo-less one binds
    // with no label. Resolving reads the on-disk manifest and NEVER indexes; any failure degrades to
    // no binding (the launch is unaffected). Whatever it sets flows into the SAME version-guard +
    // cross-field validation below — capability-only, never a prompt/repo/snapshot change. The
    // graph.ts→adapter import is type-only on graph.ts's side, so this value import is no runtime cycle.
    if (input.projectId !== undefined && input.projectGraph === undefined) {
      const decision = await resolveProjectGraphBinding(this, input.projectId, input.repoRef).catch(
        (): { binding: ProjectGraphBinding | null } => ({ binding: null }),
      );
      if (decision.binding !== null) input.projectGraph = decision.binding;
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
    if (input.plan !== undefined) {
      // DES-TEAMING-002 T3: a user-composed plan is a COMMAND the engine owns end to end — it
      // publishes `plan.proposed`, scores, floor-fills and gates it. Crew only forwards it, and
      // refuses what it cannot forward faithfully rather than dropping it.
      if (input.workflow !== undefined) {
        throw new Error('a launch carries a plan or names a workflow (a preset), not both');
      }
      if (!this.supportsPlanLaunch()) throw new PlanLaunchUnsupportedError('A plan launch');
      (opts as LaunchOptions & { planJson?: string }).planJson = JSON.stringify(input.plan);
      // (wicked-core#858, X-MIG M9) The engine judges a plan's declared deliverables itself.
      this.passLaunchDeliverables(opts, input.requireDeliverables ?? [], 'a plan');
      // T8: a delivering plan hands the engine its deliver step, exactly as a preset launch does.
      if (input.deliver === 'pr') {
        (opts as LaunchOptions & { deliverStepJson?: string }).deliverStepJson = JSON.stringify(
          this.deliverStep(null, [], input, deliverOriginUrl, deliverIdentity, deliverCredentials),
        );
      }
    }
    // DES-TEAMING-002 T3: a workflow that names a PRESET is a plan the engine floor-fills and gates.
    // Crew never composes a per-run def over one (that def is no preset, so the launch would skip
    // `plan_approval`): delivery rides the launch as the deliver STEP (`deliverStepJson`), and a
    // deliverable floor — which has no engine-side step yet — is refused rather than composed.
    const requireDeliverablesAll = input.requireDeliverables ?? [];
    const namesPreset =
      input.workflow !== undefined &&
      (input.deliver === 'pr' || requireDeliverablesAll.length > 0) &&
      (await this.presetNamed(input.workflow, input.projectId)) !== null;
    if (namesPreset && input.workflow !== undefined) {
      if (!this.supportsPlanLaunch()) throw new PlanLaunchUnsupportedError('Delivering a preset launch');
      // (wicked-core#858, X-MIG M9) A preset launch's deliverables ride the launch: the engine joins
      // them to the plan's last creator step and its deliverable floor judges them — never a per-run
      // def composed past the plan_approval gate.
      this.passLaunchDeliverables(opts, requireDeliverablesAll, `a preset launch ('${input.workflow}')`);
      // Only a DELIVERING preset gets the deliver step: a preset launched for its deliverables alone
      // pushes nothing (codex r1 on #930).
      if (input.deliver === 'pr') {
        const step = this.deliverStep(input.workflow, this.getWorkflow(input.workflow)?.phases ?? [], input, deliverOriginUrl, deliverIdentity, deliverCredentials);
        (opts as LaunchOptions & { deliverStepJson?: string }).deliverStepJson = JSON.stringify(step);
      }
      opts.workflow = input.workflow;
    } else if (input.workflow !== undefined) {
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
          // The run's intent rides along so the PR title and the commit subject NAME what was
          // delivered (#318 — composed from the intent, never `--fill`, crew#524) instead of an
          // anonymous blob; the repo and this daemon's origin ride too, so the phase's fallback
          // text names the run and its script knows which daemon to ask for the run record.
          // Composition stays DEFERRED (#319): deliver and the deliverable floor fold into one
          // def and one registration below, never two armed ids.
          composed = composeDeliverWorkflow(composed, input.sessionId, input.problem, {
            repoRef: input.repoRef ?? null,
            apiOrigin: this.deliverApiOrigin?.() ?? null,
            // DES-L9: the revised PR (push target) and the push identity for the gate card —
            // GH_ACCOUNT's value and whether GH_TOKEN is exported (presence only, never the value).
            revisesPr: input.revisesPr ?? null,
            ghAccount: process.env['GH_ACCOUNT'] ?? null,
            ghTokenPinned: typeof process.env['GH_TOKEN'] === 'string' && process.env['GH_TOKEN'] !== '',
            // F2 — the origin the push will actually go to, so the gate card cannot promise a
            // pull request on a remote that can never carry one.
            originUrl: deliverOriginUrl,
            // crew#549 — the configured deliver identity, baked into the script so the refusal
            // holds on a daemon started without GH_ACCOUNT exported; crew#737 — the repository's
            // own pin wins, and the card says when it is not signed in here.
            deliverIdentity: deliverIdentity.login,
            deliverIdentitySource: deliverIdentity.source,
            deliverIdentitySignedIn: deliverIdentity.signedIn,
            // crew#720 — the provider credential preflight, said on the card before approval.
            credentials: deliverCredentials,
          });
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
    } else if (input.deliver === 'pr' && input.plan === undefined) {
      // (A plan carries its deliver step above.) Fail loud, not silent: dropping the option would run to completion with the caller
      // believing a PR opens at the end — the exact operator gap crew#293 closes.
      throw new Error(
        'deliver: "pr" requires a workflow — a free-text run has no def to append the deliver phase to',
      );
    } else if ((input.requireDeliverables ?? []).length > 0 && input.plan === undefined) {
      // (A plan hands its deliverables to the engine above, wicked-core#858.)
      // Same rule for the floor (Copilot, #319): a caller that declares what a run MUST produce
      // and gets no enforcement is worse off than one that never declared it — it would watch a
      // free-text run complete and believe the artifacts were re-derived. There is no def to
      // append the floor phase to, so refuse the launch instead of silently ignoring the option.
      throw new Error(
        'requireDeliverables requires a workflow — a free-text run has no def to append the ' +
          'deliverable floor to',
      );
    }
    // WT-W1 (DES-walkthrough-proof §4.2, O7): every REPO-BOUND run gets an evidence root, minted
    // here so every launch path (POST /runs, onboarding, the interactive seams) gets one. Write roots
    // are launch-declared only, so a walkthrough the ratchet inserts mid-run needs its author dir to
    // exist from the start. Only `<root>/author` widens the boundary: the proof roots under the
    // evidence root are the jailed recorder's alone. On an addon that cannot take the field nothing
    // is minted (napi would drop it silently, and a walkthrough step on such a run fails closed at
    // its pinned validator); a launch the engine refuses removes the root only when THIS launch
    // created it — a duplicate run id must never delete the first run's evidence (codex on #758). A
    // caller-chosen run id that is not one plain path segment gets no root at all.
    const evidenceRoot =
      input.repoRef !== undefined && isPlainRunId(input.sessionId) && this.evidenceRootsSupported()
        ? walkthroughRootDir(input.sessionId)
        : null;
    let mintedHere = false;
    if (evidenceRoot !== null) {
      // Created EXCLUSIVELY, so ownership is decided by the filesystem, not by a check before it:
      // two launches racing on one id cannot both believe they made the root (Copilot on #758).
      await mkdir(dirname(evidenceRoot), { recursive: true });
      try {
        await mkdir(evidenceRoot);
        mintedHere = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const author = join(evidenceRoot, WALKTHROUGH_AUTHOR_SUBDIR);
      (opts as LaunchOptions & { evidenceRoot?: string }).evidenceRoot = evidenceRoot;
      opts.extraWriteRoots = [...(opts.extraWriteRoots ?? []), author];
    }
    try {
      if (evidenceRoot !== null) await mkdir(join(evidenceRoot, WALKTHROUGH_AUTHOR_SUBDIR), { recursive: true });
      return await this.handedToEngine('run', input.sessionId, () => this.core.launchRun(opts), input.workflow);
    } catch (err) {
      if (evidenceRoot !== null && mintedHere) await rm(evidenceRoot, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Does the installed addon take `LaunchOptions.evidenceRoot` (WT-C2, wicked-core-ts ≥ 0.7.35)?
   * Fail closed on version: napi ignores an undeclared field, so an older addon would launch a run
   * whose walkthrough could never pass while crew believed it had a root. Also `/health.capabilities.walkthroughRoots`.
   */
  evidenceRootsSupported(): boolean {
    return addonAtLeast(0, 7, 35);
  }

  /** Resume a run from its persisted cursor → the status token. */
  resumeRun(runId: string): Promise<string> {
    return this.handedToEngine('run', runId, () => this.core.resumeRun(runId));
  }

  /** Resolve a human gate: approve (optional amend) / request changes / reject → the status token.
   *  (DES-L1 PR-2) `action` and `amendScope` are the 0.7.27 arms: on an older addon a napi call
   *  would silently DROP them — a `request_changes` would run as a plain reject — so they fail
   *  CLOSED on version (the `extraWriteRoots` / `projectGraph` doctrine); absent, the call is the
   *  three-arg one every engine understands. */
  confirmGate(
    runId: string,
    approve: boolean,
    amend?: string,
    action?: string,
    amendScope?: string,
    plan?: LaunchPlan,
  ): Promise<string> {
    return this.handedToEngine('run', runId, () => {
      if (plan !== undefined) {
        // DES-TEAMING-002 T3: approve a `plan_approval` gate WITH AN EDIT — the engine proposes,
        // floor-fills and accepts it (or refuses it and re-opens the gate). Fail CLOSED on an
        // addon without the gate: it would drop the edit and approve the held plan unedited.
        if (!this.supportsPlanLaunch()) {
          return Promise.reject(new PlanLaunchUnsupportedError('An edited plan at the gate'));
        }
        const core = this.core as unknown as {
          confirmGate(
            runId: string,
            approve: boolean,
            amend?: string,
            action?: string,
            amendScope?: string,
            planJson?: string,
          ): Promise<string>;
        };
        return core.confirmGate(runId, true, undefined, 'edit_plan', undefined, JSON.stringify(plan));
      }
      if (action === undefined && amendScope === undefined) {
        return this.core.confirmGate(runId, approve, amend);
      }
      const why = armsUnsupportedReason('the gate arms `action` / `amendScope`', 'approve or reject without them');
      if (why !== null) throw new Error(why);
      // The 0.7.27 binding takes the two trailing optionals; typed here until the pin moves.
      const core = this.core as unknown as {
        confirmGate(runId: string, approve: boolean, amend?: string, action?: string, amendScope?: string): Promise<string>;
      };
      return core.confirmGate(runId, approve, amend, action, amendScope);
    });
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
    // (review-L1-598 M1) `denial_gate` is a 0.7.27 def field; an older addon's serde IGNORES it and
    // the operator who asked for `auto_reject` would get `hold` — refuse by name instead (same rule
    // as the gate arms), before any workflow is armed.
    if ((def as { denial_gate?: unknown }).denial_gate !== undefined) {
      const why = armsUnsupportedReason(
        'the campaign knob `denialGate`',
        'launch without it (the engine then holds every escalation gate for a human)',
      );
      if (why !== null) throw new Error(why);
    }
    for (const wf of workflows) {
      await this._armCampaignWorkflow(wf);
    }
    // The roster crew hands the ENGINE (F-086, the campaign half of wave 6's `core/engine-roster.ts`):
    // a def built from `rosterWithStanding()` carries crew's `health {status}` / `auth` /
    // `council_eligible` readings on every node's `run_spec.clis`; core-ts ≥ 0.7.22 parses `health`
    // as `{usable, reason?}` and refuses the def ("missing field `usable`"). Translate per node
    // exactly as `launchRun` does — on a copy, never the caller's def (the route reads it after this).
    const engineDef = engineCampaignDef(def);
    // The campaign's DAG-node runs are launched INSIDE the engine (their ids are minted there), so
    // the campaign is what the daemon can account for: pinned under `def.id` until its terminal frame.
    return this.handedToEngine('campaign', def.id, () => surface.launchCampaign(JSON.stringify(engineDef)));
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
    const surface = this._campaigns('Resuming a campaign');
    return this.handedToEngine('campaign', id, () => surface.resumeCampaign(id));
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
   * Recycle the CURSOR unit of an Executing run (crew#341; wicked-core-ts ≥ 0.7.6): the engine
   * supersedes the stale turn (cancels its epoch — never folded as a step failure), closes the
   * worker session, bumps the attempt, and re-dispatches. Queued operator injects survive into
   * the fresh turn. `newCli` set = re-dispatch to that seat (pass the unit's CURRENT seat to
   * recycle in place); absent/null = the engine re-runs the council and lets it pick.
   *
   * REJECTS (engine-validated) when the run is unknown, not Executing, or `ord` is not the
   * cursor unit — the caller must treat that as "the run moved on", not retry blindly.
   * Fail-closed on an old addon: method-presence guard, same doctrine as `injectWorkerMessage`.
   */
  async reassignUnit(runId: string, ord: number, newCli?: string | null): Promise<void> {
    if (typeof this.core.reassignUnit !== 'function') {
      throw new Error('Unit reassignment needs wicked-core-ts >= 0.7.6; this build does not support it');
    }
    await this.core.reassignUnit(runId, ord, newCli ?? null);
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

  /**
   * Each run's launch name as the engine RECORDED it — `sessionStarted.workflowId` from its event
   * log (the preset, the registered def, `<run>:plan-<rev>`, or `null` for free text). Immutable
   * once written, so it is read once per run: a run whose log holds no `sessionStarted` is memoized
   * only once it is terminal (a live run's frame may not be flushed yet; a finished run's never
   * will be). Seam X2 — the one input `resolveRunIdentity` needs that the session record lacks.
   */
  private readonly launchedWorkflows = new Map<string, string | null | undefined>();

  private async launchedWorkflowOf(view: SessionView): Promise<string | null | undefined> {
    const id = view.session.id;
    if (this.launchedWorkflows.has(id)) return this.launchedWorkflows.get(id);
    let events: RecordedEvent[] | null;
    try {
      events = await this.runEvents(id);
    } catch {
      return undefined;
    }
    if (events === null) return undefined;
    const started = events.find((e) => e.type === 'sessionStarted') as Record<string, unknown> | undefined;
    // The engine spells it `workflowId` on the frame (core-ts `CoreEventJson`).
    const raw = started?.['workflowId'];
    const launched = started === undefined ? undefined : typeof raw === 'string' ? raw : null;
    if (launched !== undefined || TERMINAL_RUN_STATUSES.has(view.session.status)) {
      this.launchedWorkflows.set(id, launched);
    }
    return launched;
  }

  /**
   * Every run + its ordered units, each with its `run_identity` (seam X2) resolved from the engine's
   * record — its plan state, else its recorded launch — never from its phase sequence.
   *
   * `workflow_id` is still rewritten from the engine's synthetic `wf-<run>` to the resolved NAME
   * for skins that read it (studio's run-kind list, until it reads `run_identity.system`); a run
   * with no name (a user plan, free text, unknown) keeps the engine's id.
   */
  async sessionsDetail(): Promise<SessionView[]> {
    const views = JSON.parse(await this.core.sessionsDetail()) as SessionView[];
    const needsLaunch = (v: SessionView): boolean =>
      (v.session as { team_plan?: unknown }).team_plan == null &&
      typeof v.session.workflow_id === 'string' &&
      isSyntheticWorkflowId(v.session.workflow_id);
    const pending = views.filter(needsLaunch);
    const launched = new Map<string, string | null | undefined>();
    // Bounded fan-out: the first read after boot visits each such run's log once (memoized after).
    for (let i = 0; i < pending.length; i += 8) {
      const batch = pending.slice(i, i + 8);
      const got = await Promise.all(batch.map((v) => this.launchedWorkflowOf(v)));
      batch.forEach((v, k) => launched.set(v.session.id, got[k]));
    }
    for (const view of views) {
      const identity = wireIdentity(resolveRunIdentity(view, launched.get(view.session.id)));
      view.session.run_identity = identity;
      if (identity.name !== null && isSyntheticWorkflowId(view.session.workflow_id ?? '')) {
        view.session.workflow_id = identity.name;
      }
    }
    return views;
  }

  /** A unit's captured transcript (string, or `null`). */
  async workOutput(unitId: string): Promise<string | null> {
    return JSON.parse(await this.core.workOutput(unitId)) as string | null;
  }

  // ── Presets (DES-TEAMING-002 §8.4, seam C2) ─────────────────────────────────
  // 1:1 maps of the engine's preset commands. The engine owns the store AND resolution: a launch
  // naming a preset (`workflow`) is resolved inside the engine, so crew never expands one itself.
  // Every method throws PresetsUnsupportedError on an addon without the bindings (routes: 501).

  /** True when the installed addon carries the preset bindings. */
  presetsSupported(): boolean {
    return typeof this.core.putPreset === 'function';
  }

  private requirePresets<T>(fn: T | undefined, what: string): T {
    if (typeof fn !== 'function') throw new PresetsUnsupportedError(what);
    return fn;
  }

  async putPreset(name: string, steps: PresetStep[], projectId?: string, createdBy?: string): Promise<Preset> {
    const fn = this.requirePresets(this.core.putPreset, 'Saving a preset');
    return withPresetSystemFlag(
      JSON.parse(await fn.call(this.core, name, JSON.stringify(steps), projectId ?? null, createdBy ?? null)) as Preset,
    );
  }

  async deletePreset(name: string, projectId?: string): Promise<boolean> {
    const fn = this.requirePresets(this.core.deletePreset, 'Deleting a preset');
    return JSON.parse(await fn.call(this.core, name, projectId ?? null)) as boolean;
  }

  /** The preset `name` resolves to for a launch in `projectId` (the project's row shadows the
   *  global one), or `null` — including on an addon without presets, whose engine resolves every
   *  workflow id as a registered def. */
  async presetNamed(name: string, projectId?: string): Promise<Preset | null> {
    try {
      return (await this.listPresets(projectId)).find((p) => p.name === name) ?? null;
    } catch (err) {
      if (err instanceof PresetsUnsupportedError) return null;
      throw err;
    }
  }

  async listPresets(projectId?: string): Promise<Preset[]> {
    const fn = this.requirePresets(this.core.listPresets, 'Listing presets');
    return (JSON.parse(await fn.call(this.core, projectId ?? null)) as Preset[]).map(withPresetSystemFlag);
  }

  // ── Team (DES-TEAMING-002 T8) ───────────────────────────────────────────────
  // Reads and commands over the engine; crew publishes no team fact (§4.0). Every method throws
  // TeamUnsupportedError on an addon without its binding (routes: 501).

  private requireTeam<T>(fn: T | undefined, what: string, binding: string): T {
    if (typeof fn !== 'function') throw new TeamUnsupportedError(what, binding);
    return fn;
  }

  /** The run's team transport and per-unit snapshots, or `null` for a run that is not a team run. */
  async runTeam(runId: string): Promise<RunTeamView | null> {
    const fn = this.requireTeam(this.core.runTeam, 'Reading a run\'s team', 'runTeam');
    return JSON.parse(await fn.call(this.core, runId)) as RunTeamView | null;
  }

  /** Replay `<state home>/team-outbox.ndjson` onto the bus. */
  async replayTeamOutbox(): Promise<TeamOutboxReplayReport> {
    const fn = this.requireTeam(this.core.replayTeamOutbox, 'Replaying the team outbox', 'replayTeamOutbox');
    return JSON.parse(await fn.call(this.core)) as TeamOutboxReplayReport;
  }

  /**
   * The catalog ids whose entry declares `verified_evidence` (seam X2: a plan run's acceptance is
   * the steps it contains that re-verify evidence). `null` when the engine has no catalog binding
   * or its catalog does not carry the flag — callers fail closed on it. The catalog is compiled
   * into the engine, so a known answer is read once.
   */
  async verifiedEvidenceCatalog(): Promise<ReadonlySet<string> | null> {
    if (this._verifiedEvidenceCatalog !== undefined) return this._verifiedEvidenceCatalog;
    let entries: CatalogEntry[];
    try {
      entries = await this.catalog();
    } catch {
      return null;
    }
    const set = verifiedEvidenceCatalog(entries);
    if (set !== null) this._verifiedEvidenceCatalog = set;
    return set;
  }

  private _verifiedEvidenceCatalog: ReadonlySet<string> | undefined;

  /**
   * Every catalog id the engine defines (WT-W2): a plan step naming one outside it fails its
   * acceptance requirement closed. `null` when the catalog cannot be read. Cached once read.
   */
  async catalogIds(): Promise<ReadonlySet<string> | null> {
    if (this._catalogIds !== undefined) return this._catalogIds;
    try {
      const entries = await this.catalog();
      this._catalogIds = new Set(entries.map((e) => e.id));
      return this._catalogIds;
    } catch {
      return null;
    }
  }

  private _catalogIds: ReadonlySet<string> | undefined;

  /** The engine's phase catalog. */
  async catalog(): Promise<CatalogEntry[]> {
    const fn = this.requireTeam(this.core.catalog, 'Reading the phase catalog', 'catalog');
    return JSON.parse(await fn.call(this.core)) as CatalogEntry[];
  }

  /** What a `POST /runs {plan}` launch with the same fields would decide, persisting nothing
   *  (`Core.previewPlan`): `repoRef` is the repo the launch runs on (its graph scores the touch
   *  set), and `deliver` hands the engine the launch's deliver step, as `launchRun` does. */
  async previewPlan(
    plan: LaunchPlan,
    opts: { projectId?: string; humanConfirm?: string; repoRef?: string; deliver?: boolean } = {},
  ): Promise<PlanPreviewResponse> {
    const fn = this.requireTeam(this.core.previewPlan, 'Previewing a plan', 'previewPlan');
    // (F2) The preview shows the deliver step's gate-card text, so it reads the same origin the
    // launch would. Local to this call, like the launch's.
    const previewOriginUrl = opts.deliver === true ? await this.resolveDeliverOrigin(opts.repoRef) : null;
    const previewIdentity = await this.resolveDeliverIdentity(opts.repoRef, opts.deliver === true);
    const previewCredentials = opts.deliver === true ? await deliverCredentialsProbe(previewOriginUrl, process.env) : null;
    const deliverStep =
      opts.deliver === true
        ? JSON.stringify(
            // The launch's own step for a plan (`deliverStep(null, [], input)`); the run id is a
            // placeholder: it only shapes the push command, which a preview never runs.
            this.deliverStep(
              null,
              [],
              {
                sessionId: 'plan-preview',
                problem: '',
                clisJson: '[]',
                ...(opts.repoRef !== undefined ? { repoRef: opts.repoRef } : {}),
              },
              previewOriginUrl,
              previewIdentity,
              previewCredentials,
            ),
          )
        : null;
    return JSON.parse(
      await fn.call(
        this.core,
        JSON.stringify(plan),
        opts.projectId ?? null,
        opts.humanConfirm ?? null,
        opts.repoRef ?? null,
        deliverStep,
      ),
    ) as PlanPreviewResponse;
  }

  /** A mid-run plan edit (`Core.proposePlan`): the steps to add, held for the run's next step
   *  boundary and approved by its author. Idempotent by `requestId`; rejects with the engine's
   *  refusal (a plan awaiting approval, a started deliver step, a finished or unplanned run, …). */
  async proposePlan(runId: string, plan: LaunchPlan, requestId: string): Promise<PlanProposalResponse> {
    const fn = this.requireTeam(this.core.proposePlan, 'Editing a running plan', 'proposePlan');
    return JSON.parse(await fn.call(this.core, runId, JSON.stringify(plan), requestId)) as PlanProposalResponse;
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
   * Forward the operator's elicitation response to the actor (DES-002 §4 P-1; crew#357/#358).
   *
   * NAPI flat signature: `resolve_elicitation(run_id, elicitation_id, action, response)`.
   * `response` is `null` for `decline` and `cancel` actions; a non-empty string for `accept`
   * (the engine takes any JSON value — crew's route validates a string, so a string is what
   * crosses the boundary).
   *
   * Guarded on METHOD PRESENCE the way `interactionRequests`/`runEvents` are: the binding
   * ships in wicked-core-ts ≥ 0.7.2, so an older installed addon has no method at runtime.
   * That case throws `ElicitationUnsupportedError`, which the route maps to HTTP 501 —
   * "upgrade the engine", never "fix your request". On a binding-bearing build the call is
   * forwarded and the engine's own rejection ("no matching elicitation", "elicitation not
   * supported for this runner") propagates as a plain error (route: 500, prompt restored).
   */
  async resolveElicitation(
    runId: string,
    elicitationId: string,
    action: string,
    response: string | null,
  ): Promise<void> {
    const resolve = this.core.resolveElicitation;
    if (typeof resolve !== 'function') {
      throw new ElicitationUnsupportedError(
        'resolveElicitation is not bound in the installed wicked-core-ts; upgrade it (>= 0.7.2) to enable elicitation',
      );
    }
    await resolve.call(this.core, runId, elicitationId, action, response);
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

  /**
   * Register a local git repo → the persisted `RepoEntry`. The path is resolved to its REAL path
   * first (crew#778): the engine mints run worktrees under the registered root, and codex's Seatbelt
   * sandbox refuses a writable root with a symlink component — a repo registered as `/tmp/link-repo`
   * (or anything under macOS's `/tmp`, itself a symlink) was accepted and then failed every codex
   * unit. A path that does not resolve is handed on as typed, so the engine's own refusal names it.
   */
  async registerRepo(name: string, rootPath: string): Promise<RepoEntry> {
    const real = await realpath(rootPath).catch(() => rootPath);
    return JSON.parse(await this.core.registerRepo(name, real)) as RepoEntry;
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
      // The run's seat pool is the seats the WORKFLOW can use (F-2R2-010): onboarding is two tool
      // steps routed to the `wicked-estate` executor, so its pool is empty — not the whole roster
      // dressed up as a 5-seat run with four signed-out seats. `onboarding` is the engine's
      // built-in PRESET (DES-TEAMING-002 M4), read from the engine's store.
      clisJson: JSON.stringify(await this.seatsForWorkflow('onboarding')),
      workflow: 'onboarding',
      repoRef: repoId,
    });
    this.repoOnboardRunIds.set(repoId, runId);
    // The launch record the daemon keeps for every POST /runs launch, for THIS path too (crew#496):
    // it dates the run (`created_at`) and files it with the others. After the engine accepted the
    // launch, never before; a failing recorder is logged, not a launch failure.
    if (this.onRunLaunched !== null) {
      try {
        this.onRunLaunched(runId, { workflow: 'onboarding', repoRef: repoId, repoName, deliver: 'none' });
      } catch (err) {
        console.warn(
          `[crew] onboarding run ${runId} launched but its launch record failed (reads undated): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * The roster a run of `workflowId` should carry as its seat pool. A workflow or preset whose
   * every phase (step) runs a TOOL executor convenes no council and dispatches no seat, so its pool
   * is `[]` — the engine routes each unit `tool` without consulting the pool (verified against the
   * engine: an onboarding launch with `clis: []` distributes both units to `wicked-estate`). Any
   * one with an agent phase — or one this daemon cannot read — gets the full roster, as before.
   * A registered def is read first; otherwise the preset the name launches (the engine resolves a
   * launch the same way: DES-TEAMING-002 §8.4).
   */
  async seatsForWorkflow(workflowId: string): Promise<unknown[]> {
    const def = this.getWorkflow(workflowId);
    const executors: Array<{ type?: unknown } | undefined> =
      def !== null
        ? def.phases.map((p) => p.executor)
        : ((await this.presetNamed(workflowId))?.steps ?? []).map(
            (s) => s['executor'] as { type?: unknown } | undefined,
          );
    // The roster WITH standing when the daemon wired one (F-RECON-002/003) — `launchRun` then
    // benches `council_eligible: false` seats through `engineRosterJson`.
    if (executors.length === 0) return this.readyLaunchRoster();
    return executors.every((e) => e?.type === 'tool') ? [] : this.readyLaunchRoster();
  }

  /** Return the onboarding run id for a repo (undefined if not launched this session). */
  getOnboardRunId(repoId: string): string | undefined {
    return this.repoOnboardRunIds.get(repoId);
  }

  /** The repo an onboarding run launched by THIS daemon process was for (undefined for any other run). */
  onboardedRepoOf(runId: string): string | undefined {
    for (const [repoId, id] of this.repoOnboardRunIds) {
      if (id === runId) return repoId;
    }
    return undefined;
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
    // includeRetired=true: the BROWSE surface defaults to status=all and filters in the route, so
    // the fetch must not silently withdraw retired rows (a steering engine's default excludes
    // them — with the bare call, `?status=retired` / `include_retired=true` answered [] for every
    // engine-retired rule, a vacuous facet). Pre-0.7.5 bindings ignore the extra args.
    return (JSON.parse(await this.core.listConformanceRules(null, true)) as ConformanceRule[]).map(withRuleDefaults);
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
    return (JSON.parse(json) as ConformanceRule[]).map(withRuleDefaults);
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
   * DC-S3 (DES-decision-capture §5.3): does the engine keep a rule's `targets.project`? The same
   * presence pattern as {@link steeringSupported}: `considerRules` shipped with the field. Without
   * it a project-scoped landing fails loud instead of landing everywhere.
   */
  projectRulesSupported(): boolean {
    return typeof this.core.considerRules === 'function';
  }

  /**
   * DC-S1 "considered · set aside" (DES-decision-capture §4.2.2): the in-force rules for a query
   * carrying `projects`, and the ones set aside with the reason. Throws on an engine without the
   * binding — callers probe {@link projectRulesSupported} first (an old `RuleQuery` rejects `projects`).
   */
  async considerRules(query: { projects?: string[]; steering_type?: string }): Promise<{
    in_force: ConformanceRule[];
    set_aside: Array<{ id: string; statement: string; reason: 'out_of_scope' | 'replaced' | 'retired' }>;
  }> {
    const consider = this.core.considerRules;
    if (typeof consider !== 'function') {
      throw new Error('considerRules is not supported by this wicked-core build (needs wicked-core-ts >= 0.7.35)');
    }
    return parseEngineJson(await consider.call(this.core, JSON.stringify(query)), 'considerRules');
  }

  /** One conformance rule as the store holds it now (retired rows included); `null` when absent. */
  async readConformanceRule(id: string): Promise<ConformanceRule | null> {
    return (await this.listConformanceRules()).find((r) => r.id === id) ?? null;
  }

  /**
   * The MCP policy preview (DES-MCP-TOOLS-001 S6): `{calls, cells}` → `[{subject, cells}]` JSON,
   * judged by the same evaluation the broker's `evaluateMcpCall` runs, and recorded nowhere.
   * Throws `mcp_preview_unsupported` on an addon that predates the binding (the route answers 501).
   */
  async previewMcpCalls(requestJson: string): Promise<string> {
    const preview = this.core.previewMcpCalls;
    if (typeof preview !== 'function') {
      throw new Error('mcp_preview_unsupported: the installed wicked-core-ts predates the MCP policy preview; upgrade the engine');
    }
    return preview.call(this.core, requestJson);
  }

  /** EP-C1: does the engine carry `evaluate_editor_grants` (EP-K1; wicked-core-ts >= 0.7.35)? */
  editorGrantsSupported(): boolean {
    return typeof this.core.evaluateEditorGrants === 'function';
  }

  /**
   * EP-C1 (DES-artifact-editor-plugins §6.2): the engine's decided permission set for one editor —
   * the EDITOR-GRANTS ledger + the EDITOR-BUILTIN posture over the subject tokens, deny dominates,
   * recording nothing. Throws on an engine without the binding (the route answers 501).
   */
  async evaluateEditorGrants(request: {
    editorId: string;
    version: string;
    sha256: string;
    permissions: string[];
    project?: string;
    firstParty: boolean;
  }): Promise<EditorGrantsResponse> {
    const evaluate = this.core.evaluateEditorGrants;
    if (typeof evaluate !== 'function') {
      throw new Error('editor_grants_unsupported: the installed wicked-core-ts predates editor grants (EP-K1); upgrade the engine');
    }
    return parseEngineJson(await evaluate.call(this.core, JSON.stringify(request)), 'evaluateEditorGrants');
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
   * `WICKED_CREW_KNOWLEDGE_DB` overrides the estate knowledge db the evals seams hand the
   * engine — the same escape hatch `WICKED_CREW_SYSTEM_SETTINGS` gives {@link settingsFilePath}.
   * Unset/empty (production) omits `knowledgeDb` from the args so the engine resolves its own
   * default — which is `~/.wicked-estate/knowledge.db` (evals.rs `default_knowledge_db()`, HOME-
   * derived), NOT a dbPath-derived sidecar. That home default is exactly why the test harness
   * arms this seam (tests/setup/hermetic-home.ts): an un-armed corpus-import test writes
   * `evals:` junk into the OPERATOR's real estate knowledge store — the store the mem/search
   * domains answer from (crew#396). Read at call time, not construction time, so a test may
   * re-aim it per fixture.
   */
  private static knowledgeDbOverride(): string | undefined {
    const override = process.env['WICKED_CREW_KNOWLEDGE_DB'];
    return override !== undefined && override !== '' ? override : undefined;
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
   * of where it lives). `knowledgeDb` is normally omitted so the engine resolves its own default
   * (`~/.wicked-estate/knowledge.db`) — {@link knowledgeDbOverride} is the env escape hatch.
   *
   * Presence-gated (the campaigns doctrine): throws {@link GovernanceEvalsUnsupportedError} on
   * an addon that predates the binding, which the route maps to 501 ("upgrade the engine").
   */
  async runGovernanceEvals(args: { type?: string; corpus?: string }): Promise<GovernanceEvalReport> {
    const fn = this.core.governanceEvals;
    if (typeof fn !== 'function') {
      throw new GovernanceEvalsUnsupportedError('Running governance evals');
    }
    const knowledgeDb = CoreAdapter.knowledgeDbOverride();
    const payload = {
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.corpus !== undefined ? { corpus: args.corpus } : {}),
      ...(knowledgeDb !== undefined ? { knowledgeDb } : {}),
      dbPath: this.dbPath,
    };
    return parseEngineJson<GovernanceEvalReport>(
      await fn.call(this.core, JSON.stringify(payload)),
      'governanceEvals',
    );
  }

  /**
   * Import a named eval corpus into the knowledge store under the `evals:<name>` scope (the
   * string a later {@link runGovernanceEvals} names as `corpus`). `knowledgeDb` resolves the
   * same way as in {@link runGovernanceEvals} — normally omitted (engine default:
   * `~/.wicked-estate/knowledge.db`), {@link knowledgeDbOverride} wins when set.
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
    const knowledgeDb = CoreAdapter.knowledgeDbOverride();
    return parseEngineJson<ImportEvalCorpusResponse>(
      await importFn.call(
        this.core,
        JSON.stringify({ name, samples, ...(knowledgeDb !== undefined ? { knowledgeDb } : {}) }),
      ),
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

  /** Core's verdict on each hydrated drop-in, run ONCE per process (the same lifetime as
   *  {@link hydrateFromOverlay} and as core's own boot-time `load_dir`). */
  private overlayVerdicts: Promise<void> | null = null;

  /** id → core's refusal reason, for the drop-ins `judgeOverlayOnce` dropped. */
  private readonly overlayRefusals = new Map<string, string>();

  /** Drop the refused defs from `userWorkflows` and remember why, asking core's parser (crew#718).
   *
   * A build with no `registerWorkflow` binding has no validator to ask, so nothing is judged and
   * the catalog reads exactly as it did before — the same floor {@link registerWorkflow} draws,
   * on the read side where there is no state to corrupt. `registerWorkflow` has been declared
   * (non-optional) in wicked-core-ts since 0.4.0. */
  private judgeOverlayOnce(): Promise<void> {
    this.overlayVerdicts ??= (async (): Promise<void> => {
      this.hydrateFromOverlay();
      const core = this.core as unknown as Record<string, unknown>;
      const register = core['registerWorkflow'];
      if (typeof register !== 'function') return;
      const { refused } = await judgeOverlayWorkflows(
        [...this.userWorkflows.values()],
        (json) => (register as (j: string) => Promise<string>).call(this.core, json),
      );
      for (const r of refused) {
        this.userWorkflows.delete(r.id);
        this.overlayRefusals.set(r.id, r.reason);
        console.warn(
          `wicked-crew: drop-in workflow '${r.id}' is NOT in the catalog — the engine refused it: ${r.reason}`,
        );
      }
    })();
    return this.overlayVerdicts;
  }

  /** The workflow catalog `GET /workflows` serves: the defs the ENGINE accepted, plus the drop-ins
   *  it refused with its own reason, so an unlaunchable def is named instead of offered (crew#718). */
  async workflowCatalog(): Promise<{ workflows: WorkflowDef[]; unavailable: RefusedWorkflow[] }> {
    await this.judgeOverlayOnce();
    return {
      workflows: this.listWorkflows(),
      unavailable: [...this.overlayRefusals].map(([id, reason]) => ({ id, reason })),
    };
  }

  /** Core's refusal reason for `id`, or `null` when the engine never refused it (crew#718). */
  async workflowRefusal(id: string): Promise<string | null> {
    await this.judgeOverlayOnce();
    return this.overlayRefusals.get(id) ?? null;
  }

  listWorkflows(): WorkflowDef[] {
    this.hydrateFromOverlay();
    // Builtins first (stable ordering), but user-registered workflows take precedence when
    // ids conflict — consistent with getWorkflow() which prefers userWorkflows.get().
    const seen = new Set<string>();
    const result: WorkflowDef[] = [];
    for (const w of BUILTIN_WORKFLOWS) {
      const override = this.userWorkflows.get(w.id);
      if (!seen.has(w.id)) { seen.add(w.id); result.push(withSystemFlag(override ?? w)); }
    }
    for (const w of this.userWorkflows.values()) {
      if (!seen.has(w.id)) { seen.add(w.id); result.push(withSystemFlag(w)); }
    }
    return result;
  }

  getWorkflow(id: string): WorkflowDef | null {
    this.hydrateFromOverlay();
    const def = this.userWorkflows.get(id) ?? BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null;
    return def === null ? null : withSystemFlag(def);
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
    // (crew#718) This def just passed core's own validator, so any earlier refusal under the same
    // id is stale — the catalog must offer the replacement, not keep naming the version it refused.
    this.overlayRefusals.delete(def.id);
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
    await seedStateHomeSettings(settingsFilePath());
    try {
      const raw = await readFile(settingsFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CrewSystemSettings>;
      // Validate numeric fields; drop anything out-of-range rather than propagate bad values.
      if ('graphNodeLimit' in parsed) {
        const v = parsed.graphNodeLimit;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10000) delete parsed.graphNodeLimit;
      }
      // deliverIdentityLogin (crew#549): a LOGIN, and the same charset PUT /settings enforces —
      // a hand-edited settings.json must not enable a value the API rejects (and must never be
      // able to put anything but a login into the deliver script's shell literal). Anything else
      // is dropped, which leaves the identity unconfigured rather than unpinned-and-unsaid.
      if ('deliverIdentityLogin' in parsed) {
        const v = parsed.deliverIdentityLogin;
        if (typeof v !== 'string' || (v.trim() !== '' && !isGitHubLogin(v.trim()))) {
          delete parsed.deliverIdentityLogin;
        } else {
          parsed.deliverIdentityLogin = v.trim();
        }
      }
      // deliverIdentityByRepo (crew#737): repo id → a LOGIN, the same rule as deliverIdentityLogin
      // per entry; a malformed entry is dropped, never spliced into the deliver script.
      if ('deliverIdentityByRepo' in parsed) {
        const m = parsed.deliverIdentityByRepo as unknown;
        if (m === null || typeof m !== 'object' || Array.isArray(m)) {
          delete parsed.deliverIdentityByRepo;
        } else {
          const kept: Record<string, string> = {};
          for (const [repo, login] of Object.entries(m as Record<string, unknown>)) {
            if (typeof login === 'string' && login.trim() !== '' && isGitHubLogin(login.trim())) kept[repo] = login.trim();
          }
          parsed.deliverIdentityByRepo = kept;
        }
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
      // workerStallEscalateMinutes (crew#341): 0 = escalation OFF (the default), else the same
      // integer-minutes bounds the PUT /settings route enforces. A hand-edited invalid value
      // must fall back to OFF — this knob lets the platform TOUCH runs, so garbage reads as
      // "disarmed", never as "escalate on every sweep".
      if ('workerStallEscalateMinutes' in parsed) {
        const v = parsed.workerStallEscalateMinutes;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) {
          delete parsed.workerStallEscalateMinutes;
        }
      }
      // workerStallEscalateAction (crew#341): 'reassign' | 'notify' only — same values the PUT
      // route admits. Anything else falls back to the default ('reassign', applied where the
      // watchdog resolves its config) rather than becoming an unparseable third action.
      if ('workerStallEscalateAction' in parsed) {
        const a = parsed.workerStallEscalateAction;
        if (a !== 'reassign' && a !== 'notify') delete parsed.workerStallEscalateAction;
      }
      // workerStallMaxEscalations (crew#341): integer 1..10 — same bounds as the PUT route. A
      // hand-edited zero would silently disarm recovery while claiming it armed; a huge value
      // would let the watchdog churn a deterministically-wedging worker for hours.
      if ('workerStallMaxEscalations' in parsed) {
        const v = parsed.workerStallMaxEscalations;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10) {
          delete parsed.workerStallMaxEscalations;
        }
      }
      // worker_config_root (seat sign-in): absolute path or "" (= engine default). A hand-edited
      // relative path is dropped rather than exported as WICKED_WORKER_HOME, where the engine
      // would resolve it against an arbitrary spawn cwd.
      if ('worker_config_root' in parsed) {
        const r = parsed.worker_config_root;
        if (typeof r !== 'string' || (r !== '' && !isAbsolute(r))) delete parsed.worker_config_root;
      }
      // The skills root is NOT a setting (skills keystone, codex round 5): `<state home>/skills`,
      // full stop. A `skills_root` left in a pre-release settings.json is dropped on read, never
      // honored — like the v3 `skills_mirror` knob withdrawn before it (design v3.2 §1 — wicked
      // never writes into the user's CLI directories).
      if ('skills_root' in parsed) delete (parsed as Record<string, unknown>)['skills_root'];
      if ('skills_mirror' in parsed) delete (parsed as Record<string, unknown>)['skills_mirror'];
      // deliverDefault (crew#393): 'pr' | 'none' only — same values PUT /settings admits. A
      // hand-edited anything-else falls back to the shipped default ('pr') rather than turning
      // the repo-scoped delivery default into an unparseable third state.
      if ('deliverDefault' in parsed) {
        const d = parsed.deliverDefault;
        if (d !== 'pr' && d !== 'none') delete parsed.deliverDefault;
      }
      // onboardingAutoCapture (crew#552): a boolean only; anything else reads as the shipped default.
      if ('onboardingAutoCapture' in parsed && typeof parsed.onboardingAutoCapture !== 'boolean') delete parsed.onboardingAutoCapture;
      // baseSkillRef / baseSkillPolicy (crew#554): the same shapes PUT /settings admits — a string
      // skill name (`""` = off) and `'require'`, the ONLY policy. A hand-edited baseSkillRef of any
      // other shape falls back to the shipped default rather than exporting garbage as the engine's
      // `WICKED_BASE_SKILL_REF` (which would refuse every launch at intake by a name nobody typed).
      // baseSkillPolicy is different: the `'warn'` rung is DELETED, not disabled (DES-L4 PR-⑧, D-8b),
      // and a settings.json written by crew ≤ 0.7.34 carries `warn` once its first PUT /settings
      // merged the old default into the file. That value is REFUSED by name, loudly — the daemon must
      // never boot reporting `warn` while behaving `require` — and the shipped default applies.
      if ('baseSkillRef' in parsed) {
        const r = parsed.baseSkillRef;
        if (typeof r !== 'string' || !BASE_SKILL_REF_SHAPE.test(r.trim())) delete parsed.baseSkillRef;
      }
      if ('baseSkillPolicy' in parsed) {
        const p: unknown = parsed.baseSkillPolicy;
        if (p !== 'require') {
          delete parsed.baseSkillPolicy;
          console.error(
            `[settings] refused baseSkillPolicy ${JSON.stringify(p)} in ${settingsFilePath()}: 'require' is the ` +
              `only accepted value. The 'warn' rung was deleted in crew 0.7.35 — it ran seats UNGROUNDED — and a ` +
              `settings.json written by an earlier crew carries it once PUT /settings merged the old default in. ` +
              `The daemon reads 'require' (the base skill is required at intake); remove the key from the file, ` +
              `or set baseSkillRef "" to turn the base skill off explicitly. Nothing else in settings.json is affected.`,
          );
        }
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
    await publishSettingsFile(settingsFilePath(), JSON.stringify(next, null, 2), true);
    return next;
  }

  /**
   * Tear down the single subscription (stop delivery, release the pump thread +
   * callback) so the process can exit cleanly. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.engineBus !== null && this.busDbPath !== undefined) detachEngineBus(this.busDbPath, this.engineBus);
    this.listeners.clear();
    this.subscription.close();
  }
}
