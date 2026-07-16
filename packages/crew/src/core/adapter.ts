import { createRequire } from 'node:module';
import type { Core as CoreHandle, LaunchOptions, Subscription } from 'wicked-core-ts';
import type {
  CoreEvent,
  LaunchRunInput,
  RepoEntry,
  SessionView,
  GovernancePolicy,
  ConformanceRule,
  GovernanceClaim,
  CoverageReport,
} from './types.js';

// The native addon is a CommonJS cdylib (`index.node`); load it with a CJS
// require even though this daemon is ESM. This module is the ONLY place that
// touches wicked-core-ts (DES-STUDIO-001 §5.2/§5.3), so the FINALIZING
// `subscribe` seam has a blast radius of exactly one file.
const require = createRequire(import.meta.url);

// ── Governance methods (crew#40) ─────────────────────────────────────────────
// These instance methods are present on the napi `Core` class after the Rust
// crate is rebuilt with the crew#40 governance seam. The intersection type
// below satisfies the TypeScript compiler until node_modules is updated.
type GovernanceMethods = {
  listPolicies(): Promise<string>;
  listConformanceRules(): Promise<string>;
  listConformanceClaims(): Promise<string>;
  getCoverageReport(): Promise<string>;
};

type CoreHandleFull = CoreHandle & GovernanceMethods;

/** The napi constructor surface — the static factories live on the class object. */
interface CoreConstructor {
  spawn(path: string): CoreHandleFull;
  spawnStub(path: string): CoreHandleFull;
  registryRoster(): string;
}

const { Core } = require('wicked-core-ts') as { Core: CoreConstructor };

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

  /** Register a git repo → the persisted `RepoEntry`. */
  async registerRepo(name: string, rootPath: string): Promise<RepoEntry> {
    return JSON.parse(await this.core.registerRepo(name, rootPath)) as RepoEntry;
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
