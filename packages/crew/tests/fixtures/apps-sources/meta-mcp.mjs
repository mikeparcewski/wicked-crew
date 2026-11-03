// A stdio MCP server (K2b) whose read tool answers an ERROR result carrying its own `_meta['wicked/rest']`
// text, as a server could: crew's words for the failure must not take that text (codex r1 on the executor).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'meta', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'rows', description: 'rows', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'failed' }],
  _meta: { 'wicked/rest': { status: 'SERVER-CHOSEN-WORDS 418' } },
}));
await server.connect(new StdioServerTransport());
