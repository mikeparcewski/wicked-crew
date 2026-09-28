// A harmless stdio MCP server for the broker tests (DES-MCP-TOOLS-001 S3).
//
//   node call-server.mjs <counter-dir>
//
// Every tools/call appends one line to `<counter-dir>/<tool>.count` BEFORE it answers, so a test
// counts exactly how many times the upstream was invoked (a retry is a second line). The injected
// secret (FIXTURE_TOKEN) is echoed back by `wt_echo`, together with credential-shaped strings, so a
// scrub that misses anything shows.
//
//   wt_echo        readOnlyHint   answers the secret, an AWS key id and a password= pair
//   wt_note        destructive    answers "noted"
//   wt_flaky_read  readOnlyHint   drops the connection (exits) on its first `fail` calls, then answers
//   wt_crash_write destructive    always drops the connection (exits) mid-call
//   wt_tool_error  readOnlyHint   answers isError: true
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const dir = process.argv[2];
const token = process.env.FIXTURE_TOKEN ?? '';
const count = (tool) => {
  const file = join(dir, `${tool}.count`);
  appendFileSync(file, 'x\n');
  return readFileSync(file, 'utf8').trim().split('\n').length;
};
const obj = { type: 'object', properties: { text: { type: 'string' }, fail: { type: 'number' } } };
const tools = [
  { name: 'wt_echo', description: 'echo', inputSchema: obj, annotations: { readOnlyHint: true } },
  { name: 'wt_note', description: 'note', inputSchema: obj, annotations: { destructiveHint: true } },
  { name: 'wt_flaky_read', description: 'flaky read', inputSchema: obj, annotations: { readOnlyHint: true } },
  { name: 'wt_crash_write', description: 'crashing write', inputSchema: obj, annotations: { destructiveHint: true } },
  { name: 'wt_tool_error', description: 'tool error', inputSchema: obj, annotations: { readOnlyHint: true } },
];

const server = new Server({ name: 'call-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  const n = count(name);
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  switch (name) {
    case 'wt_echo':
      return {
        ...text(`you said ${String(args.text ?? '')}; my token is ${token}; key AKIAABCDEFGHIJKLMNOP; password=hunter22x`),
        structuredContent: { key: 'ABC-1', api_key: 'not-for-you', echoedToken: token },
      };
    case 'wt_note':
      return text('noted');
    case 'wt_flaky_read':
      if (n <= Number(args.fail ?? 0)) process.exit(7);
      return text(`read ok after ${n} calls`);
    case 'wt_crash_write':
      process.exit(9);
      break;
    case 'wt_tool_error':
      return { ...text('the tool said no'), isError: true };
    default:
      throw new Error(`unknown tool ${name}`);
  }
});
await server.connect(new StdioServerTransport());
