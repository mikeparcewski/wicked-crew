#!/usr/bin/env node
// A tiny stdio MCP server for the inspector bridge tests (newline-delimited JSON-RPC, no deps).
// tools: echo {text}, boom (a JSON-RPC error), whoami (echoes INSPECT_TOKEN), slow (never answers).
// After `notifications/initialized` it asks the client `roots/list` (a server request the bridge refuses).
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
process.stderr.write('inspect-server: starting\n');
const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'whoami', description: 'Says the token', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { process.stderr.write(`bad line: ${line}\n`); return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'inspect-fixture', version: '1.2.3' }, instructions: 'a fixture' } });
  } else if (m.method === 'notifications/initialized') {
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  } else if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (name === 'echo') {
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `echoing ${args.text}` } });
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: args.text }] } });
    } else if (name === 'boom') {
      process.stderr.write('boom: about to fail\n');
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'boom failed on purpose' } });
    } else if (name === 'whoami') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `token=${process.env.INSPECT_TOKEN} home=${process.env.HOME ? 'set' : 'unset'} leak=${process.env.WICKED_LEAK ?? 'none'}` }] } });
    } else if (name === 'slow') {
      // never answers
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
  } else if (m.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { resources: [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }] } });
  } else if (m.method === 'resources/read') {
    send({ jsonrpc: '2.0', id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'hello from the fixture' }] } });
  } else if (m.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }] } });
  } else if (m.method === 'prompts/get') {
    send({ jsonrpc: '2.0', id: m.id, result: { messages: [{ role: 'user', content: { type: 'text', text: `hello ${m.params.arguments?.who}` } }] } });
  } else if (m.method === 'ping') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  } else if (m.id !== undefined && m.method !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
