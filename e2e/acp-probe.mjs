#!/usr/bin/env node
// Interactive ACP probe: initialize → session/new → session/prompt with a real sessionId.
// Usage: node acp-probe.mjs <binary> [args...]
import { spawn } from 'child_process';
import { createInterface } from 'readline';

const [bin, ...args] = process.argv.slice(2);
const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

let sessionId = null;
const t0 = Date.now();

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const ts = ((Date.now() - t0) / 1000).toFixed(1);
  if (msg.method === 'session/update') {
    const u = msg.params?.update;
    if (u?.sessionUpdate === 'agent_message_chunk') {
      console.log(`[${ts}s] chunk: ${JSON.stringify(u.content?.text ?? u.content).slice(0, 120)}`);
      return;
    }
    console.log(`[${ts}s] update: ${u?.sessionUpdate}`);
    return;
  }
  if (msg.id === 1) {
    console.log(`[${ts}s] initialize ok: ${msg.result?.agentInfo?.name ?? msg.result?.serverInfo?.name ?? 'unknown'}`);
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    return;
  }
  if (msg.id === 2) {
    if (msg.error) { console.log(`[${ts}s] session/new ERROR: ${JSON.stringify(msg.error).slice(0, 200)}`); process.exit(1); }
    sessionId = msg.result.sessionId;
    console.log(`[${ts}s] session: ${sessionId}`);
    send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: acp bridge ok' }] },
    });
    return;
  }
  if (msg.id === 3) {
    console.log(`[${ts}s] prompt result: ${JSON.stringify(msg.result ?? msg.error).slice(0, 200)}`);
    child.kill();
    process.exit(msg.error ? 1 : 0);
  }
  // Agent-initiated requests (permission asks etc.) — log and reject politely.
  if (msg.method && msg.id != null) {
    console.log(`[${ts}s] agent request: ${msg.method}`);
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
  }
});

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false }, clientInfo: { name: 'wicked-probe', version: '0' } },
});

setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(2); }, 120_000);
