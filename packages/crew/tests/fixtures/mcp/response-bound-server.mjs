// crew#1297: the SDK server pattern, with one oversized response before parsing on the client.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'response-bound', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'answer', annotations: { readOnlyHint: true }, description: process.argv.includes('big-list') ? 'x'.repeat(12 * 1024 * 1024) : 'small', inputSchema: { type: 'object', properties: { big: { type: 'boolean' } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: req.params.arguments?.big === true ? 'x'.repeat(12 * 1024 * 1024) : 'ok' }],
}));
await server.connect(new StdioServerTransport());
