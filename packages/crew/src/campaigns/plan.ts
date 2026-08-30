/**
 * Scenario → CampaignNode mapping (TH-9; DES-CAMPAIGN-001 §8).
 *
 * `POST /campaigns` accepts a batch of SCENARIOS (the qe-campaign vocabulary: garden's
 * campaign-recon rungs, or any caller's batch of checks) and this module maps them onto the
 * engine's `CampaignDef` — nodes, `on_success`/`on_terminal` edges, and one composed
 * single-phase workflow per deterministic scenario. Pure data-in/data-out: no engine handle,
 * no I/O, so every rule below is unit-testable without spawning a Core.
 *
 * ## The two scenario shapes, and where the work actually lives
 *
 *  - **`tool` (deterministic)** — the scenario is a spec FILE (garden's runner spec, a script,
 *    any argv-runnable check) and the node's workflow is one Tool-executor phase running that
 *    argv verbatim: no council, no LLM, near-zero cost. The engine's Tool path (`run_tool_cmd`)
 *    spawns the command directly.
 *  - **`agent` (exploratory / authoring)** — a governed agent run over a problem statement;
 *    seats are spent only where judgment is the work (test-R9).
 *
 * ## The 1022-byte rule (load-bearing, enforced here)
 *
 * PTY worker prompts longer than 1022 bytes are SILENTLY DISCARDED by the canonical line
 * discipline — the worker waits on input that never arrives and the unit burns its full
 * timeout (the S8 campaign finding; memory: "PTY canonical line limit"). The mapping
 * therefore refuses, loudly and per-token, anything that smells like a scenario BODY inlined
 * where a FILE PATH belongs: every Tool argv token and every agent problem statement must be
 * a single line of at most {@link MAX_INLINE_BYTES} bytes. The fix is always the same and the
 * error says it: persist the content as a file and pass its path.
 */

import type {
  CampaignDef,
  CampaignEdge,
  CampaignNode,
  CampaignScenario,
  LaunchCampaignBody,
  PhaseDef,
  WorkflowDef,
} from '../core/types.js';

/**
 * Byte ceiling for a single inline string handed to a node (a Tool argv token, an agent
 * problem). 1022 is the PTY canonical-line limit — the longest line a worker's stdin
 * accepts before the kernel silently discards it. Tool argv does not itself traverse a PTY,
 * but the ceiling is enforced uniformly because the failure it guards against is the same
 * SHAPE either way: scenario bodies belong in files, and a token this long is a body.
 */
export const MAX_INLINE_BYTES = 1022;

/** id rule for campaigns and scenarios: overlay-file-safe, run-id-safe (no `:` — the engine
 *  keys node run ids `{campaign}:{node}:a{attempt}`), and short enough that the composed
 *  workflow id (`campaign-<campaign>-<scenario>`) stays under core's 128-char id cap. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_CAMPAIGN_ID = 64;
const MAX_SCENARIO_ID = 48;

/** Composed node workflows carry this prefix — the adapter keeps them OUT of the workflow
 *  catalog (`listWorkflows`) while still persisting them to the overlay dir so a fresh-process
 *  `resumeCampaign` can re-dispatch pending nodes by workflow id. */
export const CAMPAIGN_WORKFLOW_PREFIX = 'campaign-';

/** The composed workflow id for one deterministic scenario node. */
export function scenarioWorkflowId(campaignId: string, scenarioId: string): string {
  return `${CAMPAIGN_WORKFLOW_PREFIX}${campaignId}-${scenarioId}`;
}

/** A built campaign: the engine def plus the per-node Tool workflows the adapter must arm
 *  (hot-register + overlay-persist) BEFORE the def launches. */
export interface BuiltCampaign {
  def: CampaignDef;
  workflows: WorkflowDef[];
}

/** Throw with the scenario + token named when an inline string breaks the single-line /
 *  byte-ceiling rule. One spelling of the rule for both scenario shapes. */
function assertInline(scenarioId: string, what: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `scenario '${scenarioId}': ${what} contains a newline — scenario bodies are never ` +
        'inlined; persist the content as a file and pass its path',
    );
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_INLINE_BYTES) {
    throw new Error(
      `scenario '${scenarioId}': ${what} is ${bytes} bytes — over the ${MAX_INLINE_BYTES}-byte ` +
        'PTY canonical-line limit (longer input is SILENTLY DISCARDED and the unit burns its ' +
        'timeout). Persist the content as a file and pass its path instead',
    );
  }
}

/** The single Tool-executor phase of a deterministic scenario node.
 *
 * `verified_evidence: false`, deliberately (contrast `core/deliver.ts`, which arms the built-in
 * evidence floor): that floor re-derives "done" from a WORKTREE DIFF, and a scenario run —
 * probing an API, reading state — legitimately leaves none, so arming it would deny every
 * honest PASS. The executor's exit status is an executor CLAIM, not a verdict; grading belongs
 * to the qe accept trio (garden TH-10) and the acceptance gate re-derives "done" from ledger
 * rows (TH-6). `executes_code: false` for the same reason as the deliver phase: deterministic
 * tooling, not governed agent work.
 */
function toolPhase(cmd: string[]): PhaseDef {
  return {
    id: 'execute',
    kind: 'test',
    executor: { type: 'tool', cmd },
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: false,
    required_deliverables: [],
    depends_on: [],
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: null,
  };
}

/**
 * Map a `POST /campaigns` body onto the engine's `CampaignDef` + the per-node workflows to arm.
 *
 * Throws a plain `Error` (the route answers 400 with the message) on: a malformed campaign or
 * scenario id, a duplicate scenario id, a scenario with neither/both of `tool`/`agent`, an
 * empty argv, an inline-rule break ({@link assertInline}), an unknown/self/duplicate dep, or an
 * `agent.workflow` that is itself a composed campaign workflow. Cycles are LEFT to the engine's
 * own launch validation — one authority for graph shape, and its reject arrives before anything
 * persists.
 *
 * `defaultClis` is the parsed council roster used for every node that does not carry its own —
 * Tool nodes never convene it (the phase bypasses the council), agent nodes do.
 */
export function buildCampaign(body: LaunchCampaignBody, defaultClis: unknown[]): BuiltCampaign {
  const campaignId = body.id ?? `campaign-${Date.now().toString(36)}`;
  if (!SAFE_ID.test(campaignId) || campaignId.length > MAX_CAMPAIGN_ID) {
    throw new Error(
      `campaign id '${campaignId}' must start with a letter/digit, contain only letters, ` +
        `digits, dots, hyphens, and underscores, and be at most ${MAX_CAMPAIGN_ID} chars`,
    );
  }
  if (body.scenarios.length === 0) {
    throw new Error('a campaign needs at least one scenario');
  }

  const ids = new Set<string>();
  for (const s of body.scenarios) {
    if (!SAFE_ID.test(s.id) || s.id.length > MAX_SCENARIO_ID) {
      throw new Error(
        `scenario id '${s.id}' must start with a letter/digit, contain only letters, digits, ` +
          `dots, hyphens, and underscores, and be at most ${MAX_SCENARIO_ID} chars`,
      );
    }
    if (ids.has(s.id)) throw new Error(`duplicate scenario id '${s.id}'`);
    ids.add(s.id);
  }

  const nodes: CampaignNode[] = [];
  const edges: CampaignEdge[] = [];
  const workflows: WorkflowDef[] = [];

  for (const s of body.scenarios) {
    nodes.push(buildNode(campaignId, s, defaultClis, workflows));

    const seenDeps = new Set<string>();
    for (const dep of s.deps ?? []) {
      if (dep === s.id) throw new Error(`scenario '${s.id}' depends on itself`);
      if (!ids.has(dep)) {
        throw new Error(`scenario '${s.id}' depends on unknown scenario '${dep}'`);
      }
      if (seenDeps.has(dep)) {
        throw new Error(`scenario '${s.id}' names dep '${dep}' twice`);
      }
      seenDeps.add(dep);
      edges.push({ from: dep, to: s.id, condition: s.depsCondition ?? 'on_success' });
    }
  }

  return {
    def: {
      id: campaignId,
      name: body.name ?? campaignId,
      nodes,
      edges,
      policy: body.policy ?? 'continue_independent',
      max_concurrency: body.maxConcurrency ?? 2,
    },
    workflows,
  };
}

/** One scenario → one node; a `tool` scenario also appends its composed workflow. */
function buildNode(
  campaignId: string,
  s: CampaignScenario,
  defaultClis: unknown[],
  workflows: WorkflowDef[],
): CampaignNode {
  if ((s.tool === undefined) === (s.agent === undefined)) {
    throw new Error(
      `scenario '${s.id}' must carry exactly one of 'tool' (deterministic argv) or 'agent' ` +
        '(governed problem statement)',
    );
  }

  // The node's problem is a LABEL — what the scoreboard and the run list show — never the work.
  const label = s.title ?? s.id;
  assertInline(s.id, 'title', label);

  if (s.tool !== undefined) {
    if (s.tool.cmd.length === 0) {
      throw new Error(`scenario '${s.id}': tool.cmd is empty — nothing to execute`);
    }
    s.tool.cmd.forEach((token, i) => assertInline(s.id, `tool.cmd[${i}]`, token));
    const wfId = scenarioWorkflowId(campaignId, s.id);
    workflows.push({ id: wfId, phases: [toolPhase(s.tool.cmd)] });
    return {
      node_id: s.id,
      run_spec: {
        problem: label,
        clis: defaultClis,
        entity_mode: 'shared',
        workflow_id: wfId,
        ...(s.repoRef !== undefined ? { repo_ref: s.repoRef } : {}),
      },
    };
  }

  const agent = s.agent as NonNullable<CampaignScenario['agent']>;
  assertInline(s.id, 'agent.problem', agent.problem);
  if (agent.workflow !== undefined && agent.workflow.startsWith(CAMPAIGN_WORKFLOW_PREFIX)) {
    // A composed node workflow is private to its node — pointing a second node at one would
    // couple two nodes through an artifact the catalog deliberately hides.
    throw new Error(
      `scenario '${s.id}': agent.workflow must name a registered workflow, not a composed ` +
        `'${CAMPAIGN_WORKFLOW_PREFIX}*' one`,
    );
  }
  return {
    node_id: s.id,
    run_spec: {
      problem: agent.problem,
      clis: defaultClis,
      entity_mode: 'shared',
      ...(agent.workflow !== undefined ? { workflow_id: agent.workflow } : {}),
      ...(s.repoRef !== undefined ? { repo_ref: s.repoRef } : {}),
    },
  };
}
