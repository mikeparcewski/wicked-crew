/**
 * The unit's MCP tool list (DES-MCP-TOOLS-001 §8; slice S4): what the garden shim's `list` shows a
 * worker. The registry's callable tools are judged by the engine (`Core.listMcpTools`) for the unit
 * the worker's `WICKED_MCP_TOKEN` is bound to, with the same evaluation a call gets and no
 * arguments; a certain deny (an evaluator's write tool, a policy deny) is left out, and nothing is
 * recorded, so a list is never mistaken for a call.
 */

import type { McpToolsResponse, McpVisibleTool } from '../core/types.js';
import { mcpSubject } from './classify.js';
import type { McpCallableTool } from './registry.js';

export interface McpToolListDeps {
  registry: { callableTools(): Promise<McpCallableTool[]> };
  /** `Core.listMcpTools`, read per request; `null` = the linked engine has none. */
  lister: () => ((requestJson: string) => Promise<string>) | null;
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
  try {
    callable = await deps.registry.callableTools();
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
    tools.push({
      subject: j.subject,
      class: j.class,
      decision: j.decision,
      ruleIds: j.ruleIds,
      ...(j.reason !== undefined ? { reason: j.reason } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return { status: 200, body: { unit: judged.unit, tools } };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
