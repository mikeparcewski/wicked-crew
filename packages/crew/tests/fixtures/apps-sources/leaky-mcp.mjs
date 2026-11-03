// A stdio MCP server whose one read tool FAILS with a JSON-RPC error that carries the secret crew
// injected (TOKEN_A or TOKEN_B, whichever the source's auth.env names): a test call's failure must
// reach the person scrubbed of it (DES-APPS-001 G6, codex r2 S7). Its tool schema can be changed with
// LEAKY_SCHEMA=wide, so a test can show a confirmation is bound to the saved schema (S13).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = process.env.TOKEN_A ?? process.env.TOKEN_B ?? '';
const server = new Server({ name: 'leaky', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'peek', description: 'peek', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  throw new Error(`the upstream refused the token ${token}`);
});
await server.connect(new StdioServerTransport());
