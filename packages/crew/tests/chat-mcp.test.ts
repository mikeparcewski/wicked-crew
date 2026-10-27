// crew#1155: the installed-MCP-tools block a chat answer step carries (src/api/chat-mcp.ts).
import { describe, expect, it } from 'vitest';

import { CHAT_MCP_DESCRIPTION_CHARS, CHAT_MCP_SHIM, CHAT_MCP_TOOLS_SHOWN, chatMcpToolsFor, chatMcpToolsStatement } from '../src/api/chat-mcp.js';
import type { McpCallableTool } from '../src/mcp/registry.js';

const tool = (server: string, name: string, extra: Partial<McpCallableTool> = {}): McpCallableTool => ({
  server, tool: name, kind: 'mcp-stdio', annotations: { readOnlyHint: true }, classOverride: null, description: `${name} does it`, inputSchema: null, ...extra,
});

describe('chatMcpToolsStatement', () => {
  it('is absent when nothing is callable, so a chat with nothing installed reads as before', () => {
    expect(chatMcpToolsStatement([])).toBeNull();
  });

  it("names each tool's subject and class (annotations, or the operator's override) and the shim commands", () => {
    const text = chatMcpToolsStatement([
      tool('unit-convert', 'convert_length'),
      tool('jira', 'create_issue', { annotations: null }),
      tool('jira', 'get_issue', { annotations: null, classOverride: 'read' }),
    ])!;
    expect(text).toContain('- `mcp:jira/create_issue` (write): create_issue does it');
    expect(text).toContain('- `mcp:jira/get_issue` (read)');
    expect(text).toContain('- `mcp:unit-convert/convert_length` (read)');
    // Sorted by subject.
    expect(text.indexOf('mcp:jira/create_issue')).toBeLessThan(text.indexOf('mcp:unit-convert/convert_length'));
    expect(text).toContain(`    ${CHAT_MCP_SHIM} list`);
    expect(text).toContain(`    ${CHAT_MCP_SHIM} call mcp:<server>/<tool> --args`);
    expect(text).toContain('pending_approval');
  });

  it('keeps a description to one bounded line with no backticks', () => {
    const long = `line one\n\`rm -rf\` ${'x'.repeat(400)}`;
    const text = chatMcpToolsStatement([tool('s', 't', { description: long })])!;
    const line = text.split('\n').find((l) => l.startsWith('- `mcp:s/t`'))!;
    const desc = line.slice(line.indexOf(': ') + 2);
    expect(desc.length).toBe(CHAT_MCP_DESCRIPTION_CHARS);
    expect(desc).not.toContain('`');
    expect(desc.startsWith('line one rm -rf x')).toBe(true);
  });

  it('names at most the cap and counts the rest', () => {
    const many = Array.from({ length: CHAT_MCP_TOOLS_SHOWN + 5 }, (_, i) => tool('s', `t${String(i).padStart(3, '0')}`));
    const text = chatMcpToolsStatement(many)!;
    expect(text.split('\n').filter((l) => l.startsWith('- `mcp:')).length).toBe(CHAT_MCP_TOOLS_SHOWN);
    expect(text).toContain('- …and 5 more');
  });

  it('leaves the block out when the registry cannot be read, or there is none', async () => {
    expect(await chatMcpToolsFor(undefined)).toBeNull();
    expect(await chatMcpToolsFor({ callableTools: async () => { throw new Error('corrupt'); } })).toBeNull();
    expect(await chatMcpToolsFor({ callableTools: async () => [tool('a', 'b')] })).toContain('mcp:a/b');
  });
});
