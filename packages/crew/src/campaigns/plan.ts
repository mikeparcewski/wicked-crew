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

// ── Multi-repo fan-out (the pinned multiscope wire) ─────────────────────────────────────────
//
// One campaign node = one engine Run = ONE repo (`run_spec.repo_ref` is a single ref — checked
// against `LaunchOptions.repoRef` in core/adapter.ts, wicked-core#179). A launch scoped to
// several codebases therefore FANS: every scenario that does not pin its own `repoRef` becomes
// one node per resolved repo, all inside the SAME campaign (the campaign IS the shared label),
// and the route answers with the fanned nodes' attempt-0 run ids (`{campaign}:{node}:a0` — the
// engine's documented run-id scheme) in repo-major input order.

/** A resolved repo the fan targets — `id` rides `run_spec.repo_ref`, `name` labels titles. */
export interface FanRepo {
  id: string;
  name: string;
}

/** The fanned scenario list plus the node-id order the route's `runIds` answer follows. */
export interface FannedScenarios {
  scenarios: CampaignScenario[];
  /**
   * Node ids in the PINNED `runIds` order: repo-major over the fanned scenarios (repos in the
   * caller's resolved order, scenarios in input order within each repo), then the scenarios
   * that pinned their own `repoRef` (never fanned — an explicit per-scenario pin wins over the
   * launch-level scope) in input order. Empty exactly when `repos` was empty (legacy launch).
   */
  runOrder: string[];
}

/** The lane suffix a fanned copy carries: `<scenario>--r<1-based repo index>`. */
function laneId(scenarioId: string, repoIndex: number): string {
  return `${scenarioId}--r${repoIndex + 1}`;
}

/**
 * Fan a scenario batch across the launch's resolved repos (multiscope `projectId`/`repoRefs`).
 *
 *  - `repos` empty ⇒ the batch is returned untouched (`runOrder: []`) — the legacy launch.
 *  - one repo ⇒ no copies: scenarios without their own `repoRef` are assigned it, ids
 *    unchanged (a single-codebase launch must look exactly like today's per-scenario spelling).
 *  - several repos ⇒ each unpinned scenario becomes one copy per repo (`<id>--r<n>`, titled
 *    `<label> [<repo name>]`), with dep edges rewritten to stay INSIDE a repo lane: a dep on a
 *    fanned sibling follows the lane, a dep on a pinned scenario points at its single node,
 *    and a pinned scenario depending on a fanned one waits for EVERY lane's copy.
 *
 * Throws a plain `Error` (the route answers 400 with the message) when a fanned id would break
 * the {@link MAX_SCENARIO_ID} cap or collide with an id the caller already used.
 */
export function fanScenarios(scenarios: CampaignScenario[], repos: FanRepo[]): FannedScenarios {
  if (repos.length === 0) {
    return { scenarios, runOrder: [] };
  }

  const fanned = scenarios.filter((s) => s.repoRef === undefined);
  const pinnedIds = new Set(scenarios.filter((s) => s.repoRef !== undefined).map((s) => s.id));

  if (repos.length === 1) {
    const repo = repos[0]!;
    return {
      scenarios: scenarios.map((s) =>
        s.repoRef === undefined ? { ...s, repoRef: repo.id } : s,
      ),
      // The SAME documented order the multi-repo fan answers with — fanned scenarios first
      // (one repo ⇒ repo-major degenerates to input order), then the pinned ones — so a
      // consumer mapping `runIds` to lanes never needs a repo-count special case.
      runOrder: [...fanned.map((s) => s.id), ...scenarios.filter((s) => pinnedIds.has(s.id)).map((s) => s.id)],
    };
  }

  const fannedIds = new Set(fanned.map((s) => s.id));
  const inputIds = new Set(scenarios.map((s) => s.id));
  for (const s of fanned) {
    const widest = laneId(s.id, repos.length - 1);
    if (widest.length > MAX_SCENARIO_ID) {
      throw new Error(
        `scenario id '${s.id}' is too long to fan across ${repos.length} repos — the fanned ` +
          `id '${widest}' exceeds ${MAX_SCENARIO_ID} chars; shorten the scenario id to at ` +
          `most ${MAX_SCENARIO_ID - (widest.length - s.id.length)} chars`,
      );
    }
    for (let i = 0; i < repos.length; i++) {
      if (inputIds.has(laneId(s.id, i))) {
        throw new Error(
          `scenario id '${laneId(s.id, i)}' collides with the fanned copies of '${s.id}' — ` +
            `rename one of them`,
        );
      }
    }
  }

  /** Rewrite one dep for the lane a copy lives in (pinned deps keep their single node). */
  const laneDep = (dep: string, repoIndex: number): string =>
    fannedIds.has(dep) ? laneId(dep, repoIndex) : dep;

  const out: CampaignScenario[] = [];
  for (const s of scenarios) {
    if (s.repoRef !== undefined) {
      // Pinned: one node, but a dep on a fanned sibling must wait for EVERY lane's copy —
      // dropping lanes silently would let this node run over half-checked ground.
      const deps = (s.deps ?? []).flatMap((d) =>
        fannedIds.has(d) ? repos.map((_r, i) => laneId(d, i)) : [d],
      );
      out.push({ ...s, ...(s.deps !== undefined ? { deps } : {}) });
      continue;
    }
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]!;
      const copy: CampaignScenario = {
        ...s,
        id: laneId(s.id, i),
        title: `${s.title ?? s.id} [${repo.name}]`,
        repoRef: repo.id,
      };
      if (s.deps !== undefined) copy.deps = s.deps.map((d) => laneDep(d, i));
      out.push(copy);
    }
  }

  // The pinned runIds order: repo-major over the fanned scenarios, then the pinned ones.
  const runOrder: string[] = [];
  for (let i = 0; i < repos.length; i++) {
    for (const s of fanned) runOrder.push(laneId(s.id, i));
  }
  for (const s of scenarios) {
    if (pinnedIds.has(s.id)) runOrder.push(s.id);
  }
  return { scenarios: out, runOrder };
}

// ── The recon fan-out's campaign (crew#390/#391) ─────────────────────────────────────────────
//
// `POST /testing/recon` over ≥ 2 resolved repos used to launch N independent runs under a
// LABEL-ONLY campaign — invisible to `GET /campaigns` (crew#390) and, worse, launched with
// `human_confirm: none` while the launch banner promised a per-sibling intake gate (crew#391).
// This builder converges the fan with the campaign-launch path: ONE engine `CampaignDef` whose
// nodes are the siblings, so the engine schedules, persists, and reports the fan like any other
// campaign, and every sibling carries the gate the banner advertises.

/** The intake gate every recon sibling pauses at (engine serde shape of `HumanConfirm::Before(1)`):
 *  pause before unit 1 — the plan is on the table, nothing has run. The same posture as the
 *  studio composer's shipped default (`before:1` on the launch wire). */
export const RECON_INTAKE_GATE = { before: 1 } as const;

/** The `LaunchRunInput.humanConfirm` wire token for the same gate — the per-run fan path
 *  (single repo / unscoped / no campaign bindings) must pause at the identical seam. */
export const RECON_INTAKE_GATE_TOKEN = 'before:1';

export interface ReconCampaignInput {
  /** Campaign id = the shared recon label (`recon-<ts36>-<hex8>` — {@link SAFE_ID}-safe by
   *  construction, and what `TestingReconResponse.campaign` already carries). */
  id: string;
  /** The operator's brief, VERBATIM — each sibling node's Run decomposes exactly this, the same
   *  text the per-run fan passed to `launchRun`. Deliberately NOT held to the 1022-byte inline
   *  rule: that rule stops scenario BODIES being smuggled into argv/label slots, whereas this IS
   *  the run's problem statement — the same field a plain `POST /runs` launch carries uncapped. */
  problem: string;
  /** The resolved fan targets, in the caller's resolved order (≥ 2 — a smaller scope stays on
   *  the per-run path so the single-repo/unscoped recon keeps today's shape). */
  repos: FanRepo[];
  /** The parsed council roster every sibling convenes. */
  clis: unknown[];
  /** `true` = the caller EXPLICITLY asked for an unattended fan (`ungated: true` on the wire —
   *  never a silent default): nodes carry no gate. `false` = the intake gate per sibling. */
  ungated: boolean;
}

/** A built recon fan: the engine def plus the attempt-0 node run ids in repo order — the
 *  `runIds` the route answers with (`{campaign}:{node}:a0`, the engine's documented scheme). */
export interface ReconCampaign {
  def: CampaignDef;
  runIds: string[];
}

/** One repo's node id: the repo NAME squeezed into the {@link SAFE_ID} alphabet (readable in
 *  run ids and on the campaign detail), deduped by repo position when two names collide. */
function reconNodeId(name: string, index: number, taken: Set<string>): string {
  const base =
    name
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[^a-zA-Z0-9]+/, '')
      .slice(0, 40) || `r${index + 1}`;
  const id = taken.has(base) ? `${base}-r${index + 1}` : base;
  taken.add(id);
  return id;
}

/**
 * Build the recon fan-out's `CampaignDef`: one AGENT node per resolved repo — no edges (siblings
 * are independent, exactly as the per-run fan launched them), `continue_independent` (one honest
 * failure never cancels the others), and `max_concurrency` = the fan width (the per-run fan
 * launched everything at once; the campaign must not silently serialize it). Each node's
 * run_spec carries the caller's brief, the shared roster, its repo, and — unless the caller
 * explicitly said `ungated` — the {@link RECON_INTAKE_GATE}.
 *
 * Throws a plain `Error` (the route's 500 — the inputs are daemon-resolved, not caller text)
 * when called with fewer than 2 repos or a label that breaks the campaign-id rule.
 */
export function buildReconCampaign(input: ReconCampaignInput): ReconCampaign {
  if (input.repos.length < 2) {
    throw new Error(
      `buildReconCampaign needs at least 2 resolved repos (got ${input.repos.length}) — ` +
        'a single-repo or unscoped recon stays on the per-run launch path',
    );
  }
  if (!SAFE_ID.test(input.id) || input.id.length > MAX_CAMPAIGN_ID) {
    throw new Error(`recon campaign label '${input.id}' breaks the campaign-id rule`);
  }
  const taken = new Set<string>();
  const nodes: CampaignNode[] = [];
  const runIds: string[] = [];
  for (const [i, repo] of input.repos.entries()) {
    const nodeId = reconNodeId(repo.name, i, taken);
    nodes.push({
      node_id: nodeId,
      run_spec: {
        problem: input.problem,
        clis: input.clis,
        entity_mode: 'shared',
        // Absent = the engine's `HumanConfirm::None` — the EXPLICITLY requested unattended fan.
        ...(input.ungated ? {} : { human_confirm: RECON_INTAKE_GATE }),
        repo_ref: repo.id,
      },
    });
    runIds.push(`${input.id}:${nodeId}:a0`);
  }
  // The campaign NAME is the brief's first line (what the dashboard card shows), the label as
  // the fallback for an all-whitespace first line.
  const firstLine = input.problem.split('\n', 1)[0]!.trim();
  const name = firstLine === '' ? input.id : firstLine.slice(0, 140);
  return {
    def: {
      id: input.id,
      name,
      nodes,
      edges: [],
      policy: 'continue_independent',
      max_concurrency: Math.min(input.repos.length, 64),
    },
    runIds,
  };
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
