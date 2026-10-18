/**
 * The estate relay (wicked-core#1018): a governed worker's estate calls, through the broker.
 *
 * # Why
 *
 * A seat on the container floor has no estate. The host's stores (`memory.db`, the knowledge
 * store, the run's code graph) are SQLite files that must not be mounted into the seat's Linux VM
 * (WAL `-shm` across the Docker Desktop file share, with the daemon writing the same file from the
 * host, is a corruption risk), the seat image ships no `wicked-estate-mcp`, and the container
 * passes only the variables the carrier set, so no store pin reaches it. Garden's estate shim
 * therefore failed closed in every container seat: no blast radius, hotspots or recall, and no
 * capture proposal (run b445).
 *
 * The seat already has one way out: the broker, `POST /api/v1/mcp/call {token, subject, args}`,
 * reached through its gateway with a token bound to its unit. So the shim sends its estate calls
 * there as the reserved subject `mcp:estate/<tool>`, and this module answers them on the host.
 *
 * # What it allows, and how it is scoped
 *
 * - **Who**: the unit the token is bound to, resolved by the engine (`Core.resolveEstateScope`),
 *   never anything the worker sends. An unknown or dead token is `invalid_token` (401).
 * - **What**: the read-only lookups garden's skills use ({@link ESTATE_READ_TOOLS}) and
 *   `proposal.submit`, which lands an INERT proposal: nothing is recalled or applied until a human
 *   approves it on the review queue. Every other estate tool is refused. The server is spawned
 *   `--readonly`, so even a tool missing from this list could not write.
 * - **Which store**: graph lookups open the run's own code graph (the one the engine vouched for
 *   and hands a host seat as `WICKED_ESTATE_DB`), and are refused when the run has none; memory,
 *   knowledge and proposals use this daemon's stores, as its own memory surface does.
 * - **Which project**: a recall's facet intent and a proposal's facets are set to the run's
 *   project and repo (and a project or repo the run does not have is removed), so a worker
 *   neither reads another project's faceted memories nor files a proposal under one. Provenance
 *   (`run_id`, `run_unit`, `run_agent`) is stamped by the server from the unit, never from args.
 * - **How much**: numeric size arguments are clamped ({@link ARG_CAPS}), each call has a deadline
 *   ({@link ESTATE_RELAY_TIMEOUT_MS}), at most {@link ESTATE_RELAY_CONCURRENCY} run at once, and
 *   a result over {@link ESTATE_RELAY_MAX_RESULT_BYTES} is withheld with a remedy. The broker's
 *   per-unit call budget covers relayed calls too.
 *
 * Every relayed call is recorded like any brokered call (`calls.ndjson`, `/ws`, the bus), and a
 * landed proposal is also written to the audit trail against its run.
 */

import { existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

import { callEstateToolRaw, estateMcpExe, resolveMemoryDbPath, type EstateMcpIo } from '../core/estate-mcp-client.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';

export { ESTATE_SERVER } from './classify.js';

/** The graph lookups a seat may make (read-only; each reads the run's code graph). */
export const ESTATE_GRAPH_TOOLS: ReadonlySet<string> = new Set([
  'SearchEntity',
  'RetrieveEntity',
  'TraverseGraph',
  'Path',
  'BlastRadius',
  'Lineage',
  'RankHotspots',
  'Communities',
  'RulesInventory',
  'rules.recall',
]);

/** Every read-only tool the relay answers: the graph lookups plus memory and knowledge recall. */
export const ESTATE_READ_TOOLS: ReadonlySet<string> = new Set([...ESTATE_GRAPH_TOOLS, 'memory.recall', 'knowledge.recall']);

/** The one write: an inert proposal for human review. */
export const ESTATE_PROPOSAL_TOOL = 'proposal.submit';

export const ESTATE_RELAY_TIMEOUT_MS = 30_000;
export const ESTATE_RELAY_CONCURRENCY = 4;
export const ESTATE_RELAY_MAX_RESULT_BYTES = 512 * 1024;

/** The upper bound for each numeric size argument a worker may pass; a larger value is lowered. */
export const ARG_CAPS: Readonly<Record<string, number>> = {
  limit: 200,
  depth: 12,
  max_depth: 12,
  top_k: 200,
  token_budget: 16_000,
  budget: 16_000,
};

/** What the engine resolved a token to (`Core.resolveEstateScope`). */
export interface EstateUnitScope {
  unit: { runId: string; ord: number; attempt: number; phase: string; seat: string };
  projectId: string | null;
  repoId: string | null;
  codeGraphDb: string | null;
}

/** One relayed call as the estate server answered it: its MCP envelope, or its JSON-RPC error. */
export type EstateRelayAnswer = { result: Record<string, unknown> } | { rpcError: { code: number | null; message: string } };

export interface EstateRelayInvocation {
  tool: string;
  args: Record<string, unknown>;
  scope: EstateUnitScope;
  timeoutMs: number;
}

/** Runs one call against the estate server. Throws on a transport fault or the deadline. */
export type EstateInvoker = (call: EstateRelayInvocation) => Promise<EstateRelayAnswer>;

/** Why a call is refused before it reaches estate. */
export interface EstateRefusal {
  ruleId: string;
  reason: string;
  remedy: string;
}

export function isEstateTool(tool: string): boolean {
  return ESTATE_READ_TOOLS.has(tool) || tool === ESTATE_PROPOSAL_TOOL;
}

/** Refuse a call the relay never makes, or one the run's scope cannot answer; `null` = relay it. */
export function estateRefusal(tool: string, scope: EstateUnitScope, memoryDb: string, exists: (p: string) => boolean = existsSync): EstateRefusal | null {
  if (!isEstateTool(tool)) {
    return {
      ruleId: 'estate:not-relayed',
      reason: `mcp:estate/${tool} is not relayed: a seat may make the read-only lookups ${[...ESTATE_READ_TOOLS].join(', ')} and ${ESTATE_PROPOSAL_TOOL}`,
      remedy: 'use one of those; anything else (a write, an approval) is the operator\'s, on the host',
    };
  }
  if (ESTATE_GRAPH_TOOLS.has(tool) && scope.codeGraphDb === null) {
    return {
      ruleId: 'estate:no-code-graph',
      reason: `this run has no code graph (its repo was never indexed, or it targets no repo), so mcp:estate/${tool} has nothing to read`,
      remedy: 'continue without graph lookups; the operator indexes the repo for later runs',
    };
  }
  if (tool === ESTATE_PROPOSAL_TOOL && !exists(memoryDb)) {
    return {
      ruleId: 'estate:no-memory-store',
      reason: 'this daemon has no memory store yet, so a proposal has no queue to land in',
      remedy: 'keep the proposal in your output; the operator opens Steering → Proposals once to create the store',
    };
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lower every capped numeric argument to its cap (top level only: that is where estate reads them). */
function clampArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [key, cap] of Object.entries(ARG_CAPS)) {
    const v = out[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > cap) out[key] = cap;
  }
  return out;
}

/** Set `project` / `repo` on a facet map to the run's, removing the axis the run has no value for. */
function scopeFacets(facets: unknown, scope: EstateUnitScope): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(facets) ? { ...facets } : {};
  for (const [axis, value] of [['project', scope.projectId], ['repo', scope.repoId]] as const) {
    if (value !== null) out[axis] = value;
    else delete out[axis];
  }
  return out;
}

/**
 * The arguments estate is actually sent: capped, and scoped to the run (module doc). A worker's own
 * `provenance` is dropped: the server stamps it from the unit.
 *
 * A proposal for a run with no project keeps the worker's own `facets.project` (garden requires
 * one), since there is no run project to set; only `repo` is then the run's.
 */
export function scopeEstateArgs(tool: string, args: Record<string, unknown>, scope: EstateUnitScope): Record<string, unknown> {
  const out = clampArgs(args);
  if (tool === 'memory.recall') {
    out['intent'] = scopeFacets(out['intent'], scope);
  } else if (tool === ESTATE_PROPOSAL_TOOL) {
    delete out['provenance'];
    const own = isRecord(out['facets']) ? out['facets']['project'] : undefined;
    const facets = scopeFacets(out['facets'], scope);
    if (scope.projectId === null && own !== undefined) facets['project'] = own;
    out['facets'] = facets;
  }
  return out;
}

/** The estate server's environment for one relayed call (module doc: which store, whose provenance). */
export function estateRelayEnv(scope: EstateUnitScope, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnvWithBootEstateDb(base);
  for (const k of Object.keys(env)) if (k.startsWith('WICKED_RUN_')) delete env[k];
  return {
    ...env,
    WICKED_MEMORY_DB: resolveMemoryDbPath(base),
    // Never the daemon's boot store (its governance store): the run's graph, or nothing.
    WICKED_ESTATE_DB: scope.codeGraphDb ?? ':memory:',
    WICKED_RUN_ID: scope.unit.runId,
    WICKED_RUN_UNIT: String(scope.unit.ord),
    WICKED_RUN_AGENT: scope.unit.seat,
  };
}

/** A counting gate: at most `max` callers hold it at once; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

/** The real invocation: a spawn-per-call `wicked-estate-mcp --readonly` with {@link estateRelayEnv}. */
export function defaultEstateInvoker(io: Pick<EstateMcpIo, 'spawn'> = {}): EstateInvoker {
  return async ({ tool, args, scope, timeoutMs }) => {
    const spawn =
      io.spawn ??
      (() =>
        nodeSpawn(estateMcpExe(), ['--readonly'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: estateRelayEnv(scope),
          windowsHide: true,
        }));
    const msg = await callEstateToolRaw(tool, args, { spawn, timeoutMs });
    const error = msg['error'];
    if (isRecord(error)) {
      return {
        rpcError: {
          code: typeof error['code'] === 'number' ? error['code'] : null,
          message: typeof error['message'] === 'string' ? error['message'].slice(0, 2000) : 'estate error',
        },
      };
    }
    const result = msg['result'];
    if (!isRecord(result)) throw new Error('estate answered with no result');
    return { result };
  };
}

/** A landed proposal, for the audit trail (run, unit, the queue id, never the payload). */
export interface EstateProposalLanded {
  runId: string;
  ord: number;
  attempt: number;
  seat: string;
  proposalId: string;
  kindType: string;
  callId: string;
}

export interface EstateRelayDeps {
  /** `Core.resolveEstateScope`, read per call; `null` = the linked engine predates it. */
  resolver: () => ((requestJson: string) => Promise<string>) | null;
  invoke?: EstateInvoker;
  /** The daemon's memory store path (proposals land there). Default {@link resolveMemoryDbPath}. */
  memoryDb?: () => string;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
  concurrency?: number;
  maxResultBytes?: number;
  /** Called once per landed proposal. Never throws into the call. */
  onProposal?: (landed: EstateProposalLanded) => void;
}

/** The relay's resolved dependencies, as the broker drives them. */
export class EstateRelay {
  readonly invoke: EstateInvoker;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  private readonly gate: Semaphore;

  constructor(private readonly deps: EstateRelayDeps) {
    this.invoke = deps.invoke ?? defaultEstateInvoker();
    this.timeoutMs = deps.timeoutMs ?? ESTATE_RELAY_TIMEOUT_MS;
    this.maxResultBytes = deps.maxResultBytes ?? ESTATE_RELAY_MAX_RESULT_BYTES;
    this.gate = new Semaphore(deps.concurrency ?? ESTATE_RELAY_CONCURRENCY);
  }

  /** The token's unit and scope. Throws the engine's `invalid_token:` / `bad_request:` / other errors. */
  async resolve(token: string): Promise<EstateUnitScope | null> {
    const resolver = this.deps.resolver();
    if (resolver === null) return null;
    const parsed = JSON.parse(await resolver(JSON.stringify({ token }))) as EstateUnitScope;
    return {
      unit: parsed.unit,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      repoId: typeof parsed.repoId === 'string' ? parsed.repoId : null,
      codeGraphDb: typeof parsed.codeGraphDb === 'string' ? parsed.codeGraphDb : null,
    };
  }

  refusal(tool: string, scope: EstateUnitScope): EstateRefusal | null {
    return estateRefusal(tool, scope, (this.deps.memoryDb ?? resolveMemoryDbPath)(), this.deps.exists);
  }

  run(call: EstateRelayInvocation): Promise<EstateRelayAnswer> {
    return this.gate.run(() => this.invoke(call));
  }

  landed(landed: EstateProposalLanded): void {
    try {
      this.deps.onProposal?.(landed);
    } catch {
      // The proposal landed; a failed audit write is the audit log's to report.
    }
  }
}

/** The MCP envelope a relayed JSON-RPC error is handed back as: a tool error carrying its code. */
export function rpcErrorEnvelope(error: { code: number | null; message: string }): Record<string, unknown> {
  return { content: [{ type: 'text', text: error.message }], isError: true, rpcError: error };
}

/** The proposal id in a `proposal.submit` envelope (`content[0].text` is `{"id": …}`), or `null`. */
export function proposalIdOf(result: Record<string, unknown>): string | null {
  const content = result['content'];
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(first) || typeof first['text'] !== 'string') return null;
  try {
    const payload = JSON.parse(first['text']) as unknown;
    return isRecord(payload) && typeof payload['id'] === 'string' && payload['id'] !== '' ? payload['id'] : null;
  } catch {
    return null;
  }
}
