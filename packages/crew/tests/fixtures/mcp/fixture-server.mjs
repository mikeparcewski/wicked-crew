// A harmless stdio MCP server for the registry tests (DES-MCP-TOOLS-001 S2).
//
//   node fixture-server.mjs <spec.json>
//
// The spec file is re-read at every start, so a test changes what the SAME registered command
// lists by rewriting it. `${TOKEN}` anywhere in the spec is replaced by the FIXTURE_TOKEN env
// value (the injected secret), and `${LEAK}` by WICKED_PROBE_LEAK (a daemon variable the hardened
// env must NOT pass through; "absent" when it did not). The server also writes the token to
// stderr, and `crash: true` exits at start with it in stderr, so a leak has every path to escape.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const token = process.env.FIXTURE_TOKEN ?? '';
const leak = process.env.WICKED_PROBE_LEAK ?? 'absent';
const fill = (value) => JSON.parse(JSON.stringify(value).split('${TOKEN}').join(token).split('${LEAK}').join(leak));

process.stderr.write(`fixture starting, token=${token}\n`);
if (spec.crash === true) process.exit(3);

const server = new Server({ name: fill(spec.serverName ?? 'fixture'), version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fill(spec.tools ?? []) }));
await server.connect(new StdioServerTransport());
