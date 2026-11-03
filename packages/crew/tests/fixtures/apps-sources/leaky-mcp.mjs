// A stdio MCP server whose one read tool FAILS with a JSON-RPC error that carries the secret crew
// injected (TOKEN_A or TOKEN_B, whichever the source's auth.env names): a test call's failure must
// reach the person scrubbed of it (DES-APPS-001 G6, codex r2 S7). Its tool schema widens when the
// file named by its first argument holds `wide`, so a test can change ONLY the schema and show a
// confirmation is bound to the saved schema (S13).
import { existsSync, readFileSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = process.env.TOKEN_A ?? process.env.TOKEN_B ?? '';
const flag = process.argv[2];
const wide = flag !== undefined && existsSync(flag) && readFileSync(flag, 'utf8').trim() === 'wide';
const properties = wide ? { q: { type: 'string' }, limit: { type: 'number' } } : { q: { type: 'string' } };
const server = new Server({ name: 'leaky', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'peek', description: 'peek', inputSchema: { type: 'object', properties }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  throw new Error(`the upstream refused the token ${token}`);
});
await server.connect(new StdioServerTransport());
