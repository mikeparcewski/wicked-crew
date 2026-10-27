/**
 * crew#1155 (PRODUCT-WORKS J6): the installed MCP tools a chat seat may use, and the ONE way it
 * reaches them.
 *
 * A chat turn is a governed answer step. Like every governed worker, its seat holds a capability
 * token bound to its unit (`WICKED_MCP_TOKEN`) and the broker's address (`WICKED_CREW_URL`), and it
 * reaches an upstream MCP tool only through garden's shim (`scripts/mcp/shim.py`), which sends the
 * token to `POST /mcp/tools` / `POST /mcp/call`. The broker judges every call for the unit (phase
 * role, seat, the run's mode, first use), runs it, scrubs and records it. Nothing here grants
 * anything: a write tool, or a server's first use, still waits for the operator.
 *
 * What was missing was the seat KNOWING that. Its only native MCP tool is the engine's `ask` (every
 * other `mcp__*` tool is fenced by the gate hook, core#657), so asked to "use unit-convert's
 * convert_length" it looked at its native tools and answered that none existed. Every answer step
 * now carries this block: what is installed, and the exact command (a command, not a noun).
 */

import { deriveToolClass, mcpSubject } from '../mcp/classify.js';
import type { McpCallableTool } from '../mcp/registry.js';

/** At most this many tools are named; the rest are counted (the shim's `list` has them all). */
export const CHAT_MCP_TOOLS_SHOWN = 30;
/** A tool description is cut to this many characters, on one line. */
export const CHAT_MCP_DESCRIPTION_CHARS = 160;

/** The launcher every governed seat has (garden's skills say the same). */
export const CHAT_MCP_SHIM = '"$WICKED_GARDEN_ROOT/scripts/wicked-garden" run scripts/mcp/shim.py';

function oneLine(text: string | null): string {
  const flat = (text ?? '').replace(/[`\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= CHAT_MCP_DESCRIPTION_CHARS ? flat : `${flat.slice(0, CHAT_MCP_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * The block for an answer step's instructions, or `null` when no tool is callable (no server
 * installed, or every one disabled): a chat with nothing installed reads exactly as before.
 */
export function chatMcpToolsStatement(tools: readonly McpCallableTool[]): string | null {
  if (tools.length === 0) return null;
  const sorted = [...tools].sort((a, b) => mcpSubject(a.server, a.tool).localeCompare(mcpSubject(b.server, b.tool)));
  const shown = sorted.slice(0, CHAT_MCP_TOOLS_SHOWN);
  const lines: string[] = [
    '## MCP tools installed on this daemon',
    '',
    'The operator installed these MCP tools. They are NOT native tools in your session (your only',
    "native MCP tool is `ask`), so they do not appear in your tool list. You reach them through",
    "wicked-crew's broker with a shell command; the broker judges each call by policy, runs it and",
    'records it. Never compute or invent a tool\'s answer: call it, and quote what it returned.',
    '',
  ];
  for (const t of shown) {
    const cls = t.classOverride ?? deriveToolClass(t.annotations);
    const desc = oneLine(t.description);
    lines.push(`- \`${mcpSubject(t.server, t.tool)}\` (${cls})${desc === '' ? '' : `: ${desc}`}`);
  }
  if (sorted.length > shown.length) lines.push(`- …and ${sorted.length - shown.length} more (the list command shows them all).`);
  lines.push(
    '',
    "List what this step may call, with each tool's input schema and whether a call runs now:",
    '',
    `    ${CHAT_MCP_SHIM} list`,
    '',
    'Call one, with arguments built from its inputSchema:',
    '',
    `    ${CHAT_MCP_SHIM} call mcp:<server>/<tool> --args '{"name": "value"}'`,
    '',
    'It prints one JSON object. Exit 0: the call ran; its `result` holds the tool\'s answer (which can',
    'itself be a tool error, `result.isError`). Exit 4 (`pending_approval`): the operator has not',
    'approved that tool yet, so it did not run; do not retry, tell the operator to approve it in',
    'studio (MCP, Approvals) and ask again. Exit 3: a policy refused it; say so. Exit 2 means this',
    'step has no broker channel; exit 5 means the tool is unavailable for now; say which.',
    'The wicked-garden-mcp skill has the full guide.',
  );
  return lines.join('\n');
}

/**
 * The block for the daemon's registry, read now. A registry that cannot be read leaves the block
 * out (the chat still answers; the shim's own `list` reports the registry error to the seat).
 */
export async function chatMcpToolsFor(
  registry: { callableTools(): Promise<McpCallableTool[]> } | undefined,
): Promise<string | null> {
  if (registry === undefined) return null;
  try {
    return chatMcpToolsStatement(await registry.callableTools());
  } catch {
    return null;
  }
}
