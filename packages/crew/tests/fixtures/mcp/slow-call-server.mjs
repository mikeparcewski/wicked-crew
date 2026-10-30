// A stdio MCP server that starts at once but never answers a tools/call (crew#1212): a timeout
// that catches it must say the server was up and the TOOL did not answer, not that it was starting.
//
//   node slow-call-server.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'slow-call-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'wt_never', description: 'never answers', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => undefined));
await server.connect(new StdioServerTransport());
