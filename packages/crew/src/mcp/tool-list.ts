/**
 * The unit's MCP tool list (DES-MCP-TOOLS-001 §8; slice S4): what the garden shim's `list` shows a
 * worker. The registry's callable tools are judged by the engine (`Core.listMcpTools`) for the unit
 * the worker's `WICKED_MCP_TOKEN` is bound to, with the same evaluation a call gets and no
 * arguments; a certain deny (an evaluator's write tool, a policy deny) is left out, and nothing is
 * recorded, so a list is never mistaken for a call.
 */

import type { McpToolsResponse, McpVisibleTool } from '../core/types.js';
import { type DataGate, firstUseOnly } from '../knowledge/gate/gate.js';
import { mcpSubject } from './classify.js';
import type { McpCallableTool } from './registry.js';

export interface McpToolListDeps {
  registry: { callableTools(): Promise<McpCallableTool[]> };
  /** `Core.listMcpTools`, read per request; `null` = the linked engine has none. */
  lister: () => ((requestJson: string) => Promise<string>) | null;
  /**
   * (DES-KNOWLEDGE-DATA-001 §7.1, §8.1) The data gate: a live source's tools are listed for a unit only as its
   * switches allow for the unit's project (see -> structure tools; query -> rows tools), judged by the engine
   * with the registry's tools. A source's own registry rows are never listed raw.
   */
  gate?: Pick<DataGate, 'resolve' | 'reach' | 'sources'>;
}

/** The gated tools a unit's project reaches, as registry-shaped tools (judged like the rest), and every gated server's name. */
async function gatedToolsFor(gate: McpToolListDeps['gate'], token: string): Promise<{ tools: McpCallableTool[]; servers: Set<string> }> {
  if (gate === undefined) return { tools: [], servers: new Set() };
  const servers = new Set((await gate.sources()).map((s) => s.name));
  try {
    const scope = await gate.resolve(token);
    if (scope === null) return { tools: [], servers };
    const reach = await gate.reach(scope.projectId);
    return {
      servers,
      tools: reach.map((t): McpCallableTool => ({ server: t.server, id: t.id, tool: t.tool, disclosure: t.disclosure, kind: 'mcp-stdio', annotations: { readOnlyHint: true }, classOverride: 'read', description: t.description, inputSchema: t.inputSchema })),
    };
  } catch {
    // A token the engine does not know is the lister's to answer (401); anything else leaves them out.
    return { tools: [], servers };
  }
}

export interface McpToolListAnswer {
  status: number;
  body: McpToolsResponse | { error: string; code: 'invalid_token' | 'bad_request' | 'guard_error' | 'mcp_unavailable' };
}

interface EngineList {
  unit: McpToolsResponse['unit'];
  tools: Array<Pick<McpVisibleTool, 'subject' | 'class' | 'decision' | 'ruleIds' | 'reason'>>;
}

export async function listUnitTools(deps: McpToolListDeps, token: string): Promise<McpToolListAnswer> {
  const lister = deps.lister();
  if (lister === null) {
    return { status: 503, body: { error: 'the linked engine cannot list MCP tools (wicked-core-ts predates listMcpTools)', code: 'mcp_unavailable' } };
  }
  let callable: McpCallableTool[];
  // The gate's tools, by exact subject: the person's switches are their consent, so no first-use ask.
  const gated = new Set<string>();
  try {
    const g = await gatedToolsFor(deps.gate, token);
    for (const t of g.tools) gated.add(mcpSubject(t.server, t.tool));
    callable = [...(await deps.registry.callableTools()).filter((t) => !g.servers.has(t.server)), ...g.tools];
  } catch (err) {
    return { status: 500, body: { error: `the MCP registry could not be read: ${message(err)}`, code: 'guard_error' } };
  }
  const calls = callable.map((t) => ({
    server: t.server,
    tool: t.tool,
    annotations: t.annotations,
    classOverride: t.classOverride,
    registered: true,
    kind: t.kind,
  }));
  let judged: EngineList;
  try {
    judged = JSON.parse(await lister(JSON.stringify({ token, calls }))) as EngineList;
  } catch (err) {
    const msg = message(err);
    if (msg.startsWith('invalid_token')) return { status: 401, body: { error: msg, code: 'invalid_token' } };
    if (msg.startsWith('bad_request')) return { status: 400, body: { error: msg, code: 'bad_request' } };
    return { status: 500, body: { error: `the tools could not be judged: ${msg}`, code: 'guard_error' } };
  }
  const bySubject = new Map(callable.map((t) => [mcpSubject(t.server, t.tool), t]));
  const tools: McpVisibleTool[] = [];
  for (const j of judged.tools) {
    const t = bySubject.get(j.subject);
    if (t === undefined) continue;
    // A gated tool's first-use ask is the switch's to answer (it is already on); any other ask stands.
    const firstUse = gated.has(j.subject) && j.decision === 'ask' && firstUseOnly(j.ruleIds);
    tools.push({
      subject: j.subject,
      class: j.class,
      decision: firstUse ? 'allow' : j.decision,
      ruleIds: firstUse ? [] : j.ruleIds,
      ...(j.reason !== undefined && !firstUse ? { reason: j.reason } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return { status: 200, body: { unit: judged.unit, tools } };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
