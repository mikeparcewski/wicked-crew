// Campaign budget/runtime governance (TH-20 / test-R22): the crew-side supervision layer
// that makes campaign spend BOUNDED and every abort VISIBLE.
//
// Why this exists: core's `CampaignDef` carries exactly one resource knob — `max_concurrency`
// (DES-CAMPAIGN-001 §2) — and the engine's per-unit wall-clock default is 2 HOURS
// (wicked-core `execute_wrapped.rs` `unit_timeout()`, override `WICKED_UNIT_TIMEOUT_SECS`).
// A nightly 20+-node governed campaign with no ceiling is an unbounded spend commitment.
//
// KNOB PLACEMENT — the P-9 interim decision, recorded here on purpose:
//   Budget/timeout/kill knobs live CREW-SIDE (this module), NOT as `CampaignDef` fields in
//   core. Crew supervision ships without a core release and rides the cancel path that
//   already exists (`CancelRun` via the adapter). The accepted cost: supervision state does
//   not survive an ENGINE-ONLY resume — resume a campaign without the crew daemon and
//   nothing enforces the budget. Moving the knobs into `CampaignDef` (where they would
//   survive resume) stays open as P-9's core-maintainer call; this module is written so the
//   policy type can migrate onto the def without changing its semantics.
//   Doctrine + operator docs: `docs/campaign-budgets.md`.
//
// What the supervisor enforces, sweep-driven like `api/stall-watchdog.ts` (same
// deps-injected/fake-clock idiom) but ENFORCING where the watchdog is detection-only:
//   1. Per-node timeout — a node RUNNING longer than `nodeTimeoutMs` is cancelled with an
//      explicit `node-timeout` exclusion. `awaiting-human` never counts against it (a gate
//      is quiet by design and burns no worker spend).
//   2. Campaign wall-clock budget — when `elapsed > wallClockBudgetMs`, remaining nodes are
//      aborted with EXCLUDED-WITH-REASON status: never-launched nodes are excluded at the
//      scheduler so they can never dispatch; in-flight nodes follow the kill policy
//      (`kill-running` cancels them, `abandon-running` lets them finish while launching
//      nothing new). Exclusion is NEVER silent: it lands in supervision state, in the
//      evidence report, on the /ws fan-out as synthetic frames, and in the warn log.
//   3. Campaign cost budget (opt-in) — same exhaustion path keyed on recorded USD cost.
//   4. Nightly cap — `assertWithinNightlyCap` fail-closed preflight on node count, so the
//      TH-23 nightly recipe cannot launch an uncapped campaign by omission.
//
// Cost per node is recorded in evidence: the supervisor stamps wall-clock per node itself
// (always available) and accepts token/USD figures via `recordNodeCost` when the worker CLI
// reports them; `buildSupervisionReport`/`writeSupervisionReport` emit the
// `campaign-supervision.json` evidence artifact whose per-node rows the TH-14 scoreboard
// cost column diffs — cost regressions become visible exactly like verdict regressions.
// (Deliberately an ARTIFACT, not new ledger-manifest fields: manifest 2.1 is wicked-ledger's
// contract and moves through its owner's release train, never ad hoc — ADR 0006.)

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Policy + TH-8-style environment pins
// ---------------------------------------------------------------------------

/** Kill policy applied to IN-FLIGHT nodes when a campaign-level budget exhausts. */
export type CampaignKillPolicy = 'kill-running' | 'abandon-running';

/**
 * The resolved budget policy a campaign runs under. All ceilings are explicit values —
 * resolution (`resolveBudgetPolicy`) fails closed on malformed input rather than silently
 * falling back, because a typo'd budget must never mean "unbounded".
 */
export interface CampaignBudgetPolicy {
  /** Campaign-level wall-clock budget, ms. Includes time spent waiting on humans. */
  wallClockBudgetMs: number;
  /** Per-node wall-clock timeout, ms, counted while the node is `running` only. */
  nodeTimeoutMs: number;
  /**
   * The TH-8-style `WICKED_UNIT_TIMEOUT_SECS` pin every node environment must carry.
   * An ambient value is HONORED (it is the pin); only when the environment says nothing
   * does the campaign default apply. Unpinned means the engine's 2-hour default — the
   * exact unbounded-spend hazard this module exists to close.
   */
  unitTimeoutSecs: number;
  /** Nightly cap: hard ceiling on schedulable nodes per campaign (fail-closed preflight). */
  maxNodes: number;
  /** Optional campaign cost ceiling, USD. Absent ⇒ wall-clock stays the only hard ceiling. */
  maxCostUsd?: number;
  /** What happens to in-flight nodes at budget exhaustion. */
  killPolicy: CampaignKillPolicy;
}

/** Campaign-proven pin (the 2026-08 studio E2E campaign ran `WICKED_UNIT_TIMEOUT_SECS=900`). */
export const DEFAULT_UNIT_TIMEOUT_SECS = 900;
/** Default per-node timeout: 30 min ≈ 4× the observed 7m41s governed feature run. */
export const DEFAULT_NODE_TIMEOUT_SECS = 1_800;
/** Default campaign wall-clock budget: 4 h (a 21-node ladder ≈ 2.7 h serial at observed rate). */
export const DEFAULT_WALL_CLOCK_BUDGET_SECS = 14_400;
/** Default nightly node cap (the proven ladder was 21 scenarios; 25 leaves headroom). */
export const DEFAULT_MAX_NODES = 25;
export const DEFAULT_KILL_POLICY: CampaignKillPolicy = 'kill-running';

/** The env knobs `resolveBudgetPolicy` reads. All crew-side; documented in docs/campaign-budgets.md. */
export const ENV_BUDGET_SECS = 'WICKED_CAMPAIGN_BUDGET_SECS';
export const ENV_NODE_TIMEOUT_SECS = 'WICKED_CAMPAIGN_NODE_TIMEOUT_SECS';
export const ENV_UNIT_TIMEOUT_SECS = 'WICKED_UNIT_TIMEOUT_SECS';
export const ENV_MAX_NODES = 'WICKED_CAMPAIGN_MAX_NODES';
export const ENV_MAX_COST_USD = 'WICKED_CAMPAIGN_MAX_COST_USD';
export const ENV_KILL_POLICY = 'WICKED_CAMPAIGN_KILL_POLICY';

/** Strict positive-number parse: rejects '', '4h', '-1', '0', NaN — never a silent fallback. */
function parsePositive(name: string, raw: string): number {
  const trimmed = raw.trim();
  const n = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `campaign budget policy: ${name}=${JSON.stringify(raw)} is not a positive number — ` +
        `refusing to guess (a malformed ceiling must never mean "unbounded")`,
    );
  }
  return n;
}

/**
 * Resolve the budget policy from an environment (defaults ↦ documented ceilings; malformed
 * values throw — fail closed, TH-8 posture). Pass `process.env` in the daemon; tests pass
 * a literal.
 */
export function resolveBudgetPolicy(
  env: Record<string, string | undefined> = process.env,
): CampaignBudgetPolicy {
  const budgetSecs =
    env[ENV_BUDGET_SECS] !== undefined && env[ENV_BUDGET_SECS] !== ''
      ? parsePositive(ENV_BUDGET_SECS, env[ENV_BUDGET_SECS])
      : DEFAULT_WALL_CLOCK_BUDGET_SECS;
  const nodeTimeoutSecs =
    env[ENV_NODE_TIMEOUT_SECS] !== undefined && env[ENV_NODE_TIMEOUT_SECS] !== ''
      ? parsePositive(ENV_NODE_TIMEOUT_SECS, env[ENV_NODE_TIMEOUT_SECS])
      : DEFAULT_NODE_TIMEOUT_SECS;
  // The ambient WICKED_UNIT_TIMEOUT_SECS is HONORED as the pin (integer seconds — the
  // engine's own u64 parse would reject a fraction, so we must too).
  const rawUnit = env[ENV_UNIT_TIMEOUT_SECS];
  let unitTimeoutSecs = DEFAULT_UNIT_TIMEOUT_SECS;
  if (rawUnit !== undefined && rawUnit !== '') {
    unitTimeoutSecs = parsePositive(ENV_UNIT_TIMEOUT_SECS, rawUnit);
    if (!Number.isInteger(unitTimeoutSecs)) {
      throw new Error(
        `campaign budget policy: ${ENV_UNIT_TIMEOUT_SECS}=${JSON.stringify(rawUnit)} must be ` +
          `an integer number of seconds (the engine parses it as u64 and would silently ` +
          `ignore this value, falling back to its 2-hour default)`,
      );
    }
  }
  const maxNodes =
    env[ENV_MAX_NODES] !== undefined && env[ENV_MAX_NODES] !== ''
      ? parsePositive(ENV_MAX_NODES, env[ENV_MAX_NODES])
      : DEFAULT_MAX_NODES;
  if (!Number.isInteger(maxNodes)) {
    throw new Error(
      `campaign budget policy: ${ENV_MAX_NODES} must be an integer node count, got ` +
        JSON.stringify(env[ENV_MAX_NODES]),
    );
  }
  const rawKill = env[ENV_KILL_POLICY];
  let killPolicy: CampaignKillPolicy = DEFAULT_KILL_POLICY;
  if (rawKill !== undefined && rawKill !== '') {
    if (rawKill !== 'kill-running' && rawKill !== 'abandon-running') {
      throw new Error(
        `campaign budget policy: ${ENV_KILL_POLICY}=${JSON.stringify(rawKill)} — expected ` +
          `"kill-running" or "abandon-running"`,
      );
    }
    killPolicy = rawKill;
  }
  const policy: CampaignBudgetPolicy = {
    wallClockBudgetMs: budgetSecs * 1_000,
    nodeTimeoutMs: nodeTimeoutSecs * 1_000,
    unitTimeoutSecs,
    maxNodes,
    killPolicy,
  };
  const rawCost = env[ENV_MAX_COST_USD];
  if (rawCost !== undefined && rawCost !== '') {
    policy.maxCostUsd = parsePositive(ENV_MAX_COST_USD, rawCost);
  }
  return policy;
}

/**
 * The TH-8-style environment pins every campaign node MUST launch with. Until the full
 * TH-8 environment manifest lands, this is the manifest's budget block: the interim
 * mitigation test-R22 names ("the environment manifest must pin WICKED_UNIT_TIMEOUT_SECS").
 */
export function nodeEnvPins(policy: CampaignBudgetPolicy): Record<string, string> {
  return { [ENV_UNIT_TIMEOUT_SECS]: String(policy.unitTimeoutSecs) };
}

/**
 * Fail-closed preflight: a node environment must carry the exact `WICKED_UNIT_TIMEOUT_SECS`
 * pin the policy resolved. Missing ⇒ the engine's 2-hour default applies silently;
 * mismatched ⇒ the manifest lies about the environment. Both refuse.
 */
export function assertNodeEnvPinned(
  nodeEnv: Record<string, string | undefined>,
  policy: CampaignBudgetPolicy,
): void {
  const pin = nodeEnv[ENV_UNIT_TIMEOUT_SECS];
  if (pin === undefined || pin.trim() === '') {
    throw new Error(
      `campaign preflight: node environment is missing the ${ENV_UNIT_TIMEOUT_SECS} pin ` +
        `(expected "${policy.unitTimeoutSecs}"). Unpinned, the engine defaults to 7200 s ` +
        `per unit — refusing to launch an effectively unbounded node`,
    );
  }
  if (pin.trim() !== String(policy.unitTimeoutSecs)) {
    throw new Error(
      `campaign preflight: ${ENV_UNIT_TIMEOUT_SECS} pin mismatch — node environment says ` +
        `${JSON.stringify(pin)}, the budget policy pinned "${policy.unitTimeoutSecs}". ` +
        `Fail-closed: fix the environment or the policy, never both silently`,
    );
  }
}

/**
 * Nightly cap, fail-closed (test-R22 interim: "the nightly recipe must cap campaign size
 * explicitly"). Called with the campaign's node count BEFORE launch; over-cap refuses with
 * both numbers so the operator sees exactly what to trim or raise.
 */
export function assertWithinNightlyCap(nodeCount: number, policy: CampaignBudgetPolicy): void {
  if (!Number.isInteger(nodeCount) || nodeCount < 0) {
    throw new Error(`campaign preflight: node count must be a non-negative integer, got ${nodeCount}`);
  }
  if (nodeCount > policy.maxNodes) {
    throw new Error(
      `campaign preflight: ${nodeCount} nodes exceeds the nightly cap of ${policy.maxNodes} ` +
        `(${ENV_MAX_NODES}). Refusing to launch — split the campaign or raise the cap ` +
        `explicitly; an uncapped nightly is an unbounded spend commitment`,
    );
  }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/**
 * The scheduler-facing phase vocabulary, deliberately COARSER than core's `NodeStatus`
 * (DES-CAMPAIGN-001 §2): supervision needs to know spend posture, not scheduling detail.
 * `pending` = never launched (Pending/Ready); `running` = consuming a worker slot
 * (Running); `awaiting-human` = quiet by design, no slot (AwaitingHuman/ReadyToResume);
 * `terminal` = Completed/Failed/Blocked/Cancelled.
 */
export type SupervisedNodePhase = 'pending' | 'running' | 'awaiting-human' | 'terminal';

/** One node as the scheduler reports it to a sweep. */
export interface SchedulerNodeView {
  nodeId: string;
  phase: SupervisedNodePhase;
  /** The node's live run id, when one was dispatched (core `node_run_id`). */
  runId?: string;
}

/**
 * The seam TH-9's campaign adapter implements (over core's `CancelRun` + the TS-bridge
 * campaign state). Tests drive a fake. Every mutation carries the human-readable reason
 * so the abort is visible AT THE SCHEDULER too, not only in supervision state.
 */
export interface SupervisedScheduler {
  /** The campaign's nodes, right now. Read per sweep, never cached. */
  listNodes(campaignId: string): Promise<SchedulerNodeView[]>;
  /** Abort one live node (⇒ core CancelRun on its run). */
  cancelNode(campaignId: string, nodeId: string, runId: string | undefined, reason: string): Promise<void>;
  /** Prevent a never-launched node from ever dispatching. */
  excludeNode(campaignId: string, nodeId: string, reason: string): Promise<void>;
}

/** Why a node was excluded/aborted by supervision. */
export type ExclusionKind = 'campaign-budget' | 'cost-budget' | 'node-timeout';

/** The excluded-with-reason record — the AC's "never silent" is this object existing. */
export interface NodeExclusion {
  kind: ExclusionKind;
  reason: string;
  /** ISO-8601 exclusion time (supervisor clock). */
  at: string;
  /**
   * How the exclusion was effected: `excluded` = never launched, blocked at dispatch;
   * `cancelled` = in-flight, killed; `abandoned` = in-flight, left to finish under
   * `abandon-running` (still excluded from any post-budget launch, still reported).
   */
  applied: 'excluded' | 'cancelled' | 'abandoned';
}

/** Per-node cost as recorded in evidence. Wall-clock is supervisor-stamped, always present. */
export interface NodeCost {
  /** Wall-clock the node spent `running` (ms), summed across observations. */
  wallMs: number;
  /** USD figure reported by the pipeline for this node, when its CLI exposes one. */
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Supervision's view of one node. */
export interface NodeSupervision {
  nodeId: string;
  phase: SupervisedNodePhase;
  runId?: string;
  /** Epoch ms the node was first observed `running`. */
  startedAt?: number;
  cost: NodeCost;
  exclusion?: NodeExclusion;
}

/** Internal tracking row: NodeSupervision plus the open running-interval bookkeeping. */
interface TrackedNode extends NodeSupervision {
  /** Epoch ms the CURRENT `running` interval began; undefined while not running. */
  runningSince?: number | undefined;
}

/** Campaign-level budget exhaustion record. */
export interface BudgetExhaustion {
  kind: 'wall-clock' | 'cost';
  /** ISO-8601. */
  at: string;
  /** What was spent when the ceiling tripped (ms for wall-clock, USD for cost). */
  spent: number;
  /** The ceiling that tripped (ms for wall-clock, USD for cost). */
  budget: number;
  policyApplied: CampaignKillPolicy;
}

/** The full supervision state for one campaign — TH-9's `GET /campaigns/:id` merges this. */
export interface CampaignSupervisionState {
  campaignId: string;
  policy: CampaignBudgetPolicy;
  /** Epoch ms supervision began (campaign launch). */
  startedAt: number;
  /** Wall-clock elapsed at the last sweep, ms. */
  elapsedMs: number;
  /** Total recorded USD cost across nodes (absent until any node reports one). */
  totalCostUsd?: number;
  /** Set exactly once, when a campaign-level budget exhausts. The abort IS visible here. */
  exhausted?: BudgetExhaustion;
  nodes: NodeSupervision[];
}

/**
 * Synthetic /ws frame: a campaign-level budget exhausted. LOCAL type like
 * `WorkerStalledFrame` — NOTE for the next `wicked-crew-api-types` release: add this frame
 * and `campaignNodeExcluded` to the published contract (forward-additive on the wire).
 */
export type CampaignBudgetExceededFrame = {
  type: 'campaignBudgetExceeded';
  campaign: string;
  kind: 'wall-clock' | 'cost';
  /** ms for wall-clock, USD for cost. */
  budget: number;
  spent: number;
  policyApplied: CampaignKillPolicy;
  /** Node ids excluded/aborted by this exhaustion, for the scoreboard's immediate redraw. */
  nodes: string[];
};

/** Synthetic /ws frame: one node was excluded/aborted by supervision (incl. node timeouts). */
export type CampaignNodeExcludedFrame = {
  type: 'campaignNodeExcluded';
  campaign: string;
  node: string;
  kind: ExclusionKind;
  reason: string;
  applied: NodeExclusion['applied'];
};

export interface CampaignSupervisorDeps {
  scheduler: SupervisedScheduler;
  /** The /ws fan-out for synthetic frames (`events/bus.ts` `broadcast` in the daemon). */
  broadcast: (frame: CampaignBudgetExceededFrame | CampaignNodeExcludedFrame) => void;
  /** Clock (tests stub it). */
  now?: () => number;
  /** Wired to the daemon's warn logger — an abort is an operator-attention signal. */
  log?: (m: string) => void;
}

/** Default sweep cadence: budgets are minutes-scale; 15 s keeps overshoot ≪ any ceiling. */
export const DEFAULT_SUPERVISION_SWEEP_INTERVAL_MS = 15_000;

interface CampaignTracking {
  policy: CampaignBudgetPolicy;
  startedAt: number;
  elapsedMs: number;
  exhausted?: BudgetExhaustion;
  /** True once the campaign is over (explicit release, or every node observed terminal): the
   * sweep stops enforcing so a FINISHED campaign can never spuriously trip its budget. */
  released: boolean;
  nodes: Map<string, TrackedNode>;
}

export class CampaignSupervisor {
  private readonly campaigns = new Map<string, CampaignTracking>();
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private handle: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(private readonly deps: CampaignSupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((): void => undefined);
  }

  /**
   * Begin supervising a campaign under a policy. Call at launch — the wall clock starts
   * HERE, not at the first sweep. Re-registering an id is a bug (two clocks, one spend).
   */
  supervise(campaignId: string, policy: CampaignBudgetPolicy): void {
    if (this.campaigns.has(campaignId)) {
      throw new Error(`campaign ${campaignId} is already supervised — refusing a second clock`);
    }
    this.campaigns.set(campaignId, {
      policy,
      startedAt: this.now(),
      elapsedMs: 0,
      released: false,
      nodes: new Map(),
    });
  }

  /**
   * Stop ENFORCING (campaign reached a terminal status). State stays readable — deliberately
   * no delete, or a post-terminal report would be irrecoverable. Also reached automatically
   * when a sweep observes every node terminal.
   */
  release(campaignId: string): void {
    const c = this.campaigns.get(campaignId);
    if (c !== undefined) c.released = true;
  }

  /** Record pipeline-reported cost for a node (tokens/USD — wall-clock is supervisor-owned). */
  recordNodeCost(
    campaignId: string,
    nodeId: string,
    cost: { usd?: number; inputTokens?: number; outputTokens?: number },
  ): void {
    const c = this.campaigns.get(campaignId);
    if (c === undefined) return; // unknown campaign: cost with no supervision to attribute it to
    const node = this.trackNode(c, nodeId);
    if (cost.usd !== undefined) node.cost.usd = (node.cost.usd ?? 0) + cost.usd;
    if (cost.inputTokens !== undefined) {
      node.cost.inputTokens = (node.cost.inputTokens ?? 0) + cost.inputTokens;
    }
    if (cost.outputTokens !== undefined) {
      node.cost.outputTokens = (node.cost.outputTokens ?? 0) + cost.outputTokens;
    }
  }

  /** The supervision state for one campaign, or undefined when it was never supervised. */
  state(campaignId: string): CampaignSupervisionState | undefined {
    const c = this.campaigns.get(campaignId);
    if (c === undefined) return undefined;
    const totalCostUsd = this.totalCostUsd(c);
    const state: CampaignSupervisionState = {
      campaignId,
      policy: c.policy,
      startedAt: c.startedAt,
      elapsedMs: c.elapsedMs,
      // Explicit copy: the internal `runningSince` bookkeeping never leaves the supervisor.
      nodes: [...c.nodes.values()].map((n) => {
        const row: NodeSupervision = { nodeId: n.nodeId, phase: n.phase, cost: { ...n.cost } };
        if (n.runId !== undefined) row.runId = n.runId;
        if (n.startedAt !== undefined) row.startedAt = n.startedAt;
        if (n.exclusion !== undefined) row.exclusion = { ...n.exclusion };
        return row;
      }),
    };
    if (totalCostUsd !== undefined) state.totalCostUsd = totalCostUsd;
    if (c.exhausted !== undefined) state.exhausted = { ...c.exhausted };
    return state;
  }

  /** One enforcement pass over every supervised campaign. Tests drive it directly. */
  async sweep(): Promise<void> {
    if (this.sweeping) return; // a slow scheduler read must never stack sweeps
    this.sweeping = true;
    try {
      for (const [campaignId, c] of this.campaigns) {
        try {
          await this.sweepCampaign(campaignId, c);
        } catch (err) {
          this.log(`[campaign-supervision] sweep of ${campaignId} failed: ${String(err)}`);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** Arm the periodic sweep. Unref'd — the daemon's server lifecycle owns shutdown. */
  start(intervalMs = DEFAULT_SUPERVISION_SWEEP_INTERVAL_MS): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      this.sweep().catch((err: unknown) => {
        this.log(`[campaign-supervision] sweep failed: ${String(err)}`);
      });
    }, intervalMs);
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle !== null) clearInterval(this.handle);
    this.handle = null;
  }

  // -------------------------------------------------------------------------

  private async sweepCampaign(campaignId: string, c: CampaignTracking): Promise<void> {
    if (c.released) return; // over: nothing left to enforce, state stays as it ended
    const nodes = await this.deps.scheduler.listNodes(campaignId);
    const now = this.now();
    c.elapsedMs = now - c.startedAt;

    // Reconcile observed phases + accumulate per-node RUNNING wall clocks. `cost.wallMs`
    // counts running intervals only — an awaiting-human interlude neither bills the node
    // nor counts against its timeout (a gate is quiet by design; sweep granularity bounds
    // the error at one interval).
    for (const view of nodes) {
      const node = this.trackNode(c, view.nodeId);
      if (view.runId !== undefined) node.runId = view.runId;
      if (view.phase === 'running') {
        if (node.runningSince === undefined) {
          node.runningSince = now; // (re-)entered running
          node.startedAt ??= now;
        } else {
          node.cost.wallMs += now - node.runningSince; // extend the open interval
          node.runningSince = now;
        }
      } else if (node.runningSince !== undefined) {
        // Left `running` since the last sweep — close the interval at this observation.
        node.cost.wallMs += now - node.runningSince;
        node.runningSince = undefined;
      }
      node.phase = view.phase;
    }

    // A campaign whose every node is terminal is OVER — a later sweep must never trip its
    // budget on wall time nobody is spending.
    if (nodes.length > 0 && nodes.every((n) => n.phase === 'terminal')) {
      c.released = true;
      return;
    }

    if (c.exhausted !== undefined) return; // exhaustion is enforced exactly once

    // 1) Per-node timeout (accumulated RUNNING time only; awaiting-human never counts).
    for (const node of c.nodes.values()) {
      if (node.phase !== 'running' || node.exclusion !== undefined) continue;
      if (node.cost.wallMs <= c.policy.nodeTimeoutMs) continue;
      const reason =
        `node-timeout: ran ${Math.round(node.cost.wallMs / 1000)}s, per-node timeout is ` +
        `${Math.round(c.policy.nodeTimeoutMs / 1000)}s (${ENV_NODE_TIMEOUT_SECS})`;
      await this.excludeOne(campaignId, c, node, 'node-timeout', reason, 'cancelled');
    }

    // 2) Campaign-level ceilings — wall-clock first (always armed), then cost (opt-in).
    if (c.elapsedMs > c.policy.wallClockBudgetMs) {
      await this.exhaust(campaignId, c, {
        kind: 'wall-clock',
        at: new Date(now).toISOString(),
        spent: c.elapsedMs,
        budget: c.policy.wallClockBudgetMs,
        policyApplied: c.policy.killPolicy,
      });
      return;
    }
    const totalCostUsd = this.totalCostUsd(c);
    if (
      c.policy.maxCostUsd !== undefined &&
      totalCostUsd !== undefined &&
      totalCostUsd > c.policy.maxCostUsd
    ) {
      await this.exhaust(campaignId, c, {
        kind: 'cost',
        at: new Date(now).toISOString(),
        spent: totalCostUsd,
        budget: c.policy.maxCostUsd,
        policyApplied: c.policy.killPolicy,
      });
    }
  }

  /**
   * Abort everything the budget no longer covers. Every touched node gets an
   * excluded-with-reason record; one campaignBudgetExceeded frame + one
   * campaignNodeExcluded frame per node ride the /ws fan-out; the warn log names them all.
   */
  private async exhaust(
    campaignId: string,
    c: CampaignTracking,
    exhaustion: BudgetExhaustion,
  ): Promise<void> {
    c.exhausted = exhaustion;
    const kind: ExclusionKind = exhaustion.kind === 'wall-clock' ? 'campaign-budget' : 'cost-budget';
    const ceiling =
      exhaustion.kind === 'wall-clock'
        ? `wall-clock budget ${Math.round(exhaustion.budget / 1000)}s exceeded ` +
          `(elapsed ${Math.round(exhaustion.spent / 1000)}s)`
        : `cost budget $${exhaustion.budget} exceeded (spent $${exhaustion.spent.toFixed(2)})`;
    const touched: string[] = [];
    for (const node of c.nodes.values()) {
      if (node.phase === 'terminal' || node.exclusion !== undefined) continue;
      if (node.phase === 'pending') {
        await this.excludeOne(campaignId, c, node, kind, `${ceiling}; node never launched`, 'excluded');
        touched.push(node.nodeId);
      } else if (c.policy.killPolicy === 'kill-running') {
        await this.excludeOne(campaignId, c, node, kind, `${ceiling}; in-flight node killed`, 'cancelled');
        touched.push(node.nodeId);
      } else {
        // abandon-running: the node may finish, but it is on record as budget-breached and
        // nothing new launches after it. Recorded + broadcast — never silent.
        await this.excludeOne(
          campaignId,
          c,
          node,
          kind,
          `${ceiling}; in-flight node abandoned to finish (abandon-running)`,
          'abandoned',
        );
        touched.push(node.nodeId);
      }
    }
    this.deps.broadcast({
      type: 'campaignBudgetExceeded',
      campaign: campaignId,
      kind: exhaustion.kind,
      budget: exhaustion.budget,
      spent: exhaustion.spent,
      policyApplied: exhaustion.policyApplied,
      nodes: touched,
    });
    this.log(
      `[campaign-supervision] campaign ${campaignId}: ${ceiling} — policy ` +
        `${exhaustion.policyApplied} applied to ${touched.length} node(s): ` +
        `${touched.join(', ') || '(none left to touch)'}`,
    );
  }

  private async excludeOne(
    campaignId: string,
    c: CampaignTracking,
    node: NodeSupervision,
    kind: ExclusionKind,
    reason: string,
    applied: NodeExclusion['applied'],
  ): Promise<void> {
    node.exclusion = { kind, reason, at: new Date(this.now()).toISOString(), applied };
    if (applied === 'cancelled') {
      await this.deps.scheduler.cancelNode(campaignId, node.nodeId, node.runId, reason);
    } else if (applied === 'excluded') {
      await this.deps.scheduler.excludeNode(campaignId, node.nodeId, reason);
    }
    this.deps.broadcast({
      type: 'campaignNodeExcluded',
      campaign: campaignId,
      node: node.nodeId,
      kind,
      reason,
      applied,
    });
    this.log(
      `[campaign-supervision] campaign ${campaignId} node ${node.nodeId}: ${applied} — ${reason}`,
    );
  }

  private trackNode(c: CampaignTracking, nodeId: string): TrackedNode {
    let node = c.nodes.get(nodeId);
    if (node === undefined) {
      node = { nodeId, phase: 'pending', cost: { wallMs: 0 } };
      c.nodes.set(nodeId, node);
    }
    return node;
  }

  private totalCostUsd(c: CampaignTracking): number | undefined {
    let total: number | undefined;
    for (const node of c.nodes.values()) {
      if (node.cost.usd !== undefined) total = (total ?? 0) + node.cost.usd;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Evidence: the campaign-supervision report artifact
// ---------------------------------------------------------------------------

/** Filename of the supervision evidence artifact inside a campaign's evidence dir. */
export const SUPERVISION_REPORT_FILENAME = 'campaign-supervision.json';

/**
 * The `campaign-supervision.json` evidence artifact (snake_case like the ledger's
 * manifests). Per-node cost rows are what the TH-14 scoreboard's cost column diffs
 * between campaigns — a cost regression shows up exactly like a verdict regression.
 * Deliberately NOT new fields on wicked-ledger's manifest 2.1: that schema moves through
 * its owner's release train (ADR 0006); this artifact rides in the same evidence dir.
 */
export interface CampaignSupervisionReport {
  report: 'campaign-supervision';
  version: 1;
  campaign_id: string;
  generated_at: string;
  policy: {
    wall_clock_budget_secs: number;
    node_timeout_secs: number;
    /** The TH-8-style WICKED_UNIT_TIMEOUT_SECS pin nodes ran under. */
    unit_timeout_pin_secs: number;
    max_nodes: number;
    max_cost_usd?: number;
    kill_policy: CampaignKillPolicy;
  };
  started_at: string;
  elapsed_ms: number;
  budget: {
    exhausted: boolean;
    kind?: 'wall-clock' | 'cost';
    at?: string;
    policy_applied?: CampaignKillPolicy;
  };
  totals: {
    wall_ms: number;
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  nodes: Array<{
    node_id: string;
    phase: SupervisedNodePhase;
    run_id?: string;
    cost: {
      wall_ms: number;
      usd?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    excluded?: {
      kind: ExclusionKind;
      reason: string;
      at: string;
      applied: NodeExclusion['applied'];
    };
  }>;
}

/** Build the evidence report from live supervision state. */
export function buildSupervisionReport(state: CampaignSupervisionState): CampaignSupervisionReport {
  let wallMs = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const n of state.nodes) {
    wallMs += n.cost.wallMs;
    if (n.cost.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + n.cost.inputTokens;
    if (n.cost.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + n.cost.outputTokens;
  }
  const report: CampaignSupervisionReport = {
    report: 'campaign-supervision',
    version: 1,
    campaign_id: state.campaignId,
    generated_at: new Date().toISOString(),
    policy: {
      wall_clock_budget_secs: Math.round(state.policy.wallClockBudgetMs / 1000),
      node_timeout_secs: Math.round(state.policy.nodeTimeoutMs / 1000),
      unit_timeout_pin_secs: state.policy.unitTimeoutSecs,
      max_nodes: state.policy.maxNodes,
      ...(state.policy.maxCostUsd !== undefined ? { max_cost_usd: state.policy.maxCostUsd } : {}),
      kill_policy: state.policy.killPolicy,
    },
    started_at: new Date(state.startedAt).toISOString(),
    elapsed_ms: state.elapsedMs,
    budget:
      state.exhausted !== undefined
        ? {
            exhausted: true,
            kind: state.exhausted.kind,
            at: state.exhausted.at,
            policy_applied: state.exhausted.policyApplied,
          }
        : { exhausted: false },
    totals: {
      wall_ms: wallMs,
      ...(state.totalCostUsd !== undefined ? { cost_usd: state.totalCostUsd } : {}),
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    },
    nodes: state.nodes.map((n) => ({
      node_id: n.nodeId,
      phase: n.phase,
      ...(n.runId !== undefined ? { run_id: n.runId } : {}),
      cost: {
        wall_ms: n.cost.wallMs,
        ...(n.cost.usd !== undefined ? { usd: n.cost.usd } : {}),
        ...(n.cost.inputTokens !== undefined ? { input_tokens: n.cost.inputTokens } : {}),
        ...(n.cost.outputTokens !== undefined ? { output_tokens: n.cost.outputTokens } : {}),
      },
      ...(n.exclusion !== undefined
        ? {
            excluded: {
              kind: n.exclusion.kind,
              reason: n.exclusion.reason,
              at: n.exclusion.at,
              applied: n.exclusion.applied,
            },
          }
        : {}),
    })),
  };
  return report;
}

/**
 * Write the report into a campaign's evidence directory (caller resolves the dir — the
 * QE pipeline owns evidence placement; crew never writes ledger DOMAIN records, and this
 * is an artifact file, not a runs/verdicts row). Returns the absolute path written.
 */
export async function writeSupervisionReport(
  evidenceDir: string,
  report: CampaignSupervisionReport,
): Promise<string> {
  const path = join(evidenceDir, SUPERVISION_REPORT_FILENAME);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
