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
 * - **What it may see** (DES-KNOWLEDGE-DATA-001 §4.3): a knowledge read ({@link ESTATE_VISIBLE_TOOLS})
 *   carries `visible`, the `source:<id>` / `repo:<id>` set crew computes for the unit's project from
 *   the registry (the data gate's predicate, `agentMay`); a worker's own `visible` is replaced. Estate
 *   filters before it ranks; the relay then re-checks every item against a FRESH read before release
 *   ({@link releaseVisible}): an item is kept only when every one of its deps is in the set (an item
 *   with no deps is dep-free knowledge, and is kept); one whose deps cannot be read is dropped; a
 *   source catalog outside the set is withheld; a block that is not a JSON object is dropped; the
 *   envelope is rebuilt from the checked blocks alone; and an answer with nothing it can check is
 *   withheld (fail closed).
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

import { callEstateToolRaw, estateKnowledgeEnv, estateMcpExe, resolveMemoryDbPath, type EstateMcpIo } from '../core/estate-mcp-client.js';
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

/**
 * The knowledge reads that carry `visible` (DES-KNOWLEDGE-DATA-001 §4.3): recall, a source's typed catalog and
 * the combined view's neighbourhood. Each is filtered by estate before ranking and re-checked here before release.
 */
export const ESTATE_VISIBLE_TOOLS: ReadonlySet<string> = new Set(['knowledge.recall', 'knowledge.source_catalog', 'knowledge.neighbors']);

/** Every read-only tool the relay answers: the graph lookups, memory recall and the knowledge reads. */
export const ESTATE_READ_TOOLS: ReadonlySet<string> = new Set([...ESTATE_GRAPH_TOOLS, 'memory.recall', ...ESTATE_VISIBLE_TOOLS]);

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
export function scopeEstateArgs(tool: string, args: Record<string, unknown>, scope: EstateUnitScope, visible: readonly string[] = []): Record<string, unknown> {
  const out = clampArgs(args);
  // crew's set, never the worker's (an absent set is estate's empty one: dep-free knowledge only).
  if (ESTATE_VISIBLE_TOOLS.has(tool)) out['visible'] = [...visible];
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

/**
 * The estate server's environment for one relayed call (module doc: which store, whose provenance),
 * built on `base`, the daemon's env as every crew child gets it (`childEnvWithBootEstateDb`).
 */
export function estateRelayEnv(scope: EstateUnitScope, base: NodeJS.ProcessEnv = childEnvWithBootEstateDb(process.env)): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('WICKED_RUN_')) delete env[k];
  return {
    ...env,
    WICKED_MEMORY_DB: resolveMemoryDbPath(base),
    // The knowledge store the describe projector writes (an isolated state home's own; DES-KNOWLEDGE-DATA-001 §4.1).
    ...estateKnowledgeEnv(base),
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
          env: estateRelayEnv(scope, childEnvWithBootEstateDb(process.env)),
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
  /**
   * (DES-KNOWLEDGE-DATA-001 §4.3) The deps the unit may see (`source:<id>`, `repo:<id>`), read anew per call from
   * the registry. Absent = the empty set: only dep-free knowledge reaches a worker. Throws = the call is refused.
   */
  visible?: (scope: EstateUnitScope) => Promise<string[]>;
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

  /** The unit's visible set (module doc), read now. */
  async visibleFor(scope: EstateUnitScope): Promise<string[]> {
    return this.deps.visible === undefined ? [] : [...(await this.deps.visible(scope))];
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

/** A dep no visible set holds: a record whose `deps` the relay cannot read is never released. */
export const UNREADABLE_DEPS = 'deps:unreadable';

/**
 * The deps an estate knowledge record stands on: its own `deps`, plus the source its scope or its citation names
 * (`source:<id>`, `source:<id>/<key>…`). Only `source:` is reconstructed from a scope or a citation.
 *
 * `deps` present but not an array of strings is unreadable, so the record is withheld. `deps` ABSENT is an estate
 * that predates the knowledge plane (estate#389 always writes the field), which can hold no dep-bearing record of
 * its own: its records are gated by the source their scope or citation names, and are otherwise dep-free. (A store
 * a knowledge-plane estate wrote shapes into, read back by an older binary, is the one case this cannot see; crew
 * ships with the knowledge-plane estate.)
 */
export function effectiveDeps(rec: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const deps = rec['deps'];
  if (deps !== undefined) {
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) return [UNREADABLE_DEPS];
    for (const d of deps as string[]) out.add(d);
  }
  for (const field of ['scope', 'source']) {
    const v = rec[field];
    if (typeof v !== 'string' || !v.startsWith('source:')) continue;
    const id = v.slice('source:'.length).split(/[/#]/, 1)[0] ?? '';
    if (id !== '') out.add(`source:${id}`);
  }
  return [...out];
}

const within = (rec: Record<string, unknown>, visible: ReadonlySet<string>): boolean => effectiveDeps(rec).every((d) => visible.has(d));

/** What {@link releaseVisible} decided: the result to hand back (possibly narrowed), or a withhold. */
export type VisibleRelease = { ok: true; result: Record<string, unknown>; dropped: number } | { ok: false; reason: string };

/**
 * The release re-check of a knowledge read (module doc): every record is checked against `visible`, read again just
 * before release. A tool error (estate's own words, no record) passes as it is.
 */
export function releaseVisible(tool: string, result: Record<string, unknown>, visible: ReadonlySet<string>): VisibleRelease {
  if (!ESTATE_VISIBLE_TOOLS.has(tool) || result['isError'] === true) return { ok: true, result, dropped: 0 };
  const content = result['content'];
  if (!Array.isArray(content)) return { ok: false, reason: `mcp:estate/${tool} answered no content the relay can check` };
  let dropped = 0;
  const checked: unknown[] = [];
  for (const block of content) {
    // A block the relay cannot check (not JSON text, or not an object: a diagnostics line) is dropped, never passed.
    let payload: unknown = null;
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      try {
        payload = JSON.parse(block['text']);
      } catch {
        payload = null;
      }
    }
    if (!isRecord(payload)) {
      dropped += 1;
      continue;
    }
    if (tool === 'knowledge.recall') {
      const items = Array.isArray(payload['items']) ? payload['items'] : null;
      if (items === null) return { ok: false, reason: 'mcp:estate/knowledge.recall answered no items list, so the answer is withheld' };
      const kept = items.filter((i) => isRecord(i) && within(i, visible));
      dropped += items.length - kept.length;
      // Only the checked list leaves: any other field estate might add is not passed unchecked.
      payload = { items: kept };
    } else if (tool === 'knowledge.source_catalog') {
      const id = payload['sourceId'];
      if (typeof id !== 'string' || !visible.has(`source:${id}`)) {
        return { ok: false, reason: 'no visible catalog for that source: a person has not let this project see it' };
      }
    } else {
      const nodes = Array.isArray(payload['nodes']) ? payload['nodes'] : null;
      const edges = Array.isArray(payload['edges']) ? payload['edges'] : null;
      if (nodes === null || edges === null) return { ok: false, reason: 'mcp:estate/knowledge.neighbors answered no nodes and edges, so the answer is withheld' };
      // A node is addressed by (store, id); one with either missing is dropped, never aliased.
      const key = (n: unknown): string | null => (isRecord(n) && typeof n['store'] === 'string' && typeof n['id'] === 'string' ? `${n['store']}\u0000${n['id']}` : null);
      const keptNodes = nodes.filter((n) => isRecord(n) && key(n) !== null && within(n, visible));
      const ids = new Set(keptNodes.map((n) => key(n) as string));
      const linked = (e: unknown): boolean => {
        const k = key(e);
        return k !== null && ids.has(k);
      };
      const keptEdges = edges.filter((e) => isRecord(e) && linked(e['from']) && linked(e['to']) && (!isRecord(e['meta']) || within({ deps: e['meta']['deps'] ?? [] }, visible)));
      dropped += nodes.length - keptNodes.length + edges.length - keptEdges.length;
      payload = { nodes: keptNodes, edges: keptEdges, truncated: payload['truncated'] === true };
    }
    checked.push({ type: 'text', text: JSON.stringify(payload) });
  }
  if (checked.length === 0) return { ok: false, reason: `mcp:estate/${tool} answered nothing the relay can check, so the answer is withheld` };
  // The released envelope is built, not copied: a second copy of the records (`structuredContent`, or any field
  // the relay does not know) never rides along unchecked.
  return { ok: true, result: { content: checked, isError: false }, dropped };
}
