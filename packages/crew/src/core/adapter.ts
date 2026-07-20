import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdir, access, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
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
} from './types.js';

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
};

type CoreHandleFull = CoreHandle & GovernanceMethods;

/** The napi constructor surface — the static factories live on the class object. */
interface CoreConstructor {
  spawn(path: string): CoreHandleFull;
  spawnStub(path: string): CoreHandleFull;
  registryRoster(): string;
}

const { Core } = require('wicked-core-ts') as { Core: CoreConstructor };

// ── Built-in workflow definitions (crew#44) ──────────────────────────────────
// Static mirrors of workflow.rs feature_def / bug_def / migration_def.
// Swap for `this.core.listWorkflowsJson()` / `this.core.getWorkflowJson(id)` once
// the wicked-core-ts NAPI methods land.
const BUILTIN_WORKFLOWS: WorkflowDef[] = [
  {
    id: 'onboarding',
    phases: [
      { id: 'index', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'annotate', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['index'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'domain', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['annotate'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'feature',
    phases: [
      { id: 'clarify', kind: 'recon', gate_type: 'value', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'design', kind: 'recon', gate_type: 'strategy', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['clarify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'build', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['design'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'adversarial-review', kind: 'review', gate_type: 'execution', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['build'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
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
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['fix'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
  {
    id: 'migration',
    phases: [
      { id: 'plan', kind: 'recon', gate_type: 'strategy', gate: { human_confirm: { unconditional: false } }, executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'execute', kind: 'build', gate_type: 'execution', gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['plan'], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'cutover', kind: 'build', gate_type: 'execution', gate: { human_confirm: { unconditional: true } }, executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: ['execute'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'verify', kind: 'test', gate_type: 'execution', gate: { human_confirm_if: 'verdict_not_pass' }, executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['cutover'], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
      { id: 'cleanup', kind: 'build', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: ['verify'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  },
];

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
  launchRun(input: LaunchRunInput): Promise<string> {
    const opts: LaunchOptions = {
      problem: input.problem,
      sessionId: input.sessionId,
      clisJson: input.clisJson,
    };
    if (input.entityMode !== undefined) opts.entityMode = input.entityMode;
    if (input.humanConfirm !== undefined) opts.humanConfirm = input.humanConfirm;
    if (input.repoRef !== undefined) opts.repoRef = input.repoRef;
    if (input.workflow !== undefined) opts.workflow = input.workflow;
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

  /** Run ids on the store. */
  async sessions(): Promise<string[]> {
    return JSON.parse(await this.core.sessions()) as string[];
  }

  /** Every run + its ordered units. */
  async sessionsDetail(): Promise<SessionView[]> {
    return JSON.parse(await this.core.sessionsDetail()) as SessionView[];
  }

  /** A unit's captured transcript (string, or `null`). */
  async workOutput(unitId: string): Promise<string | null> {
    return JSON.parse(await this.core.workOutput(unitId)) as string | null;
  }

  /** repo id → onboarding run id (in-memory; graph persists on disk across restarts). */
  private readonly repoOnboardRunIds = new Map<string, string>();
  /** repo ids with an onboarding run in flight — guards against concurrent double-launch. */
  private readonly onboardingInFlight = new Set<string>();

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
    const rawDir = checkoutPath ?? join(reposRoot, name);

    // Resolve both paths to remove any `..` segments before comparing.
    // This prevents path-traversal attacks via checkoutPath (e.g. "../../etc").
    // Both user-supplied and default-derived paths must stay inside the repos root.
    const resolvedRoot = resolve(reposRoot);
    const cloneDir = resolve(rawDir);
    // Windows paths are case-insensitive (drive letter C: vs c:) — use lower-case
    // comparison there; keep exact comparison on case-sensitive filesystems (Linux/macOS).
    const isWindows = process.platform === 'win32';
    const compareRoot = isWindows ? resolvedRoot.toLowerCase() : resolvedRoot;
    const compareClone = isWindows ? cloneDir.toLowerCase() : cloneDir;
    if (compareClone !== compareRoot && !compareClone.startsWith(compareRoot + sep)) {
      throw new Error(
        `checkoutPath must be within the repos directory (~/.wicked/repos). ` +
        `Resolved "${cloneDir}" escapes "${resolvedRoot}".`,
      );
    }

    // Track whether we create this directory so cleanup only removes it when
    // this operation created it — not a pre-existing directory with unrelated data.
    // We probe with access() and set dirCreatedByUs only on ENOENT; other errors
    // (e.g. EACCES) mean the directory exists but is unreadable, so we leave it alone.
    let dirCreatedByUs = false;
    try {
      await access(cloneDir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        dirCreatedByUs = true;
      }
    }
    await mkdir(cloneDir, { recursive: true });

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
        // Clean up the partial clone so a retry starts fresh, but only remove
        // the directory if this operation created it — never delete a pre-existing
        // directory that may contain unrelated user data.
        if (dirCreatedByUs) {
          await rm(cloneDir, { recursive: true, force: true });
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
    try {
      // Write onboarding.json to the Rust overlay dir so the actor picks it up on (re)start.
      // When registerWorkflow NAPI is present, also hot-registers it for immediate use.
      await this.registerWorkflow(BUILTIN_WORKFLOWS.find((w) => w.id === 'onboarding')!);
      await this.launchRun({
        problem: `Onboard repository: ${repoName}`,
        sessionId: runId,
        clisJson: JSON.stringify(CoreAdapter.roster()),
        workflow: 'onboarding',
        repoRef: repoId,
      });
    } finally {
      this.onboardingInFlight.delete(repoId);
    }
    this.repoOnboardRunIds.set(repoId, runId);
    return runId;
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
    return [...BUILTIN_WORKFLOWS, ...this.userWorkflows.values()];
  }

  getWorkflow(id: string): WorkflowDef | null {
    return this.userWorkflows.get(id) ?? BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null;
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
    await writeFile(path, JSON.stringify(def, null, 2), 'utf8');
    this.userWorkflows.set(def.id, def);

    // Hot-register in the Rust actor when the NAPI method is available.
    // Falls back gracefully if running against an older core build.
    const core = this.core as unknown as Record<string, unknown>;
    if (typeof core['registerWorkflow'] === 'function') {
      await (core['registerWorkflow'] as (j: string) => Promise<string>)(JSON.stringify(def));
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
