#!/usr/bin/env node
/**
 * claude-agent-acp — ACP (Agent Client Protocol) stdio wrapper for Claude Code CLI.
 *
 * Protocol: JSON-RPC 2.0 ndjson over stdin/stdout. wicked-core is the client;
 * this binary is the server. Each session/prompt call runs `claude -p` and streams
 * its output back as session/update notifications before sending the final response.
 *
 * Handshake (wicked-core → this binary):
 *   1. initialize  → result: { protocolVersion, serverCapabilities, serverInfo }
 *   2. session/new → result: { sessionId }
 *   3. session/prompt (repeated) → notifications + result: { stopReason }
 *
 * Governance: when wicked-core arms input governance it spawns this binary as:
 *   claude-agent-acp --settings <path>
 * and sets WICKED_GATE_* env vars. We forward --settings to `claude -p` so
 * Claude's PreToolUse gate-hook fires on every tool call.
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

// ── CLI arg parsing ───────────────────────────────────────────────────────────

let settingsPath = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--settings' && argv[i + 1]) {
    settingsPath = argv[i + 1];
    i++;
  }
}

// ── Session state ─────────────────────────────────────────────────────────────

let sessionCwd = process.cwd();

// ── JSON-RPC output helpers ───────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Turn execution ────────────────────────────────────────────────────────────

/**
 * Execute one session/prompt turn: run `claude -p` with the concatenated
 * prompt blocks, stream agent_message_chunk notifications for each text
 * block, then send the final session/prompt response.
 */
function execTurn(rpcId, promptBlocks) {
  return new Promise((resolve) => {
    const promptText = promptBlocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n\n')
      .trim();

    // Build argv for `claude -p`
    const claudeArgs = ['-p'];
    if (settingsPath) {
      claudeArgs.push('--settings', settingsPath);
    }
    // stream-json --verbose: gives us structured JSON we can parse per-line.
    // Each assistant turn arrives as one JSON object; tool use events also arrive
    // as JSON objects so we can emit them as agent_message_chunk text.
    claudeArgs.push('--output-format', 'stream-json', '--verbose');
    claudeArgs.push(promptText);

    const child = spawn('claude', claudeArgs, {
      cwd: sessionCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const rl = createInterface({ input: child.stdout });
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      const type = msg.type;

      if (type === 'assistant') {
        // Emit text content as agent_message_chunk notifications.
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            notify('session/update', {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: block.text },
              },
            });
          }
        }
        // Accumulate usage from assistant turns (last wins).
        const u = msg.message?.usage;
        if (u) {
          inputTokens = (u.input_tokens ?? 0) +
                        (u.cache_read_input_tokens ?? 0) +
                        (u.cache_creation_input_tokens ?? 0);
          outputTokens = u.output_tokens ?? 0;
        }
      } else if (type === 'result') {
        stopReason = msg.stop_reason === 'end_turn' ? 'end_turn' : (msg.stop_reason ?? 'end_turn');
        if (msg.is_error) stopReason = 'error';
        // Prefer final result usage stats — more complete than per-turn.
        const u = msg.usage;
        if (u) {
          inputTokens = (u.input_tokens ?? 0) +
                        (u.cache_read_input_tokens ?? 0) +
                        (u.cache_creation_input_tokens ?? 0);
          outputTokens = u.output_tokens ?? 0;
        }
      }
      // Skip: system/init, rate_limit_event, tool_use, tool_result, user — not needed.
    });

    child.on('close', (code) => {
      // Emit usage so wicked-core can track burn.
      if (inputTokens > 0 || outputTokens > 0) {
        notify('session/update', {
          update: {
            sessionUpdate: 'usage_update',
            inputTokens,
            outputTokens,
          },
        });
      }

      if (code !== 0 && stopReason === 'end_turn') {
        stopReason = 'error';
      }

      respond(rpcId, { stopReason });
      resolve();
    });

    child.on('error', (err) => {
      // claude binary not found or failed to spawn.
      respondError(rpcId, -32603, `claude spawn error: ${err.message}`);
      resolve();
    });
  });
}

// ── Main RPC loop ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

// Track in-flight async handlers so we can delay exit until all turns finish.
let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;

  pending++;
  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: 1,
          serverCapabilities: {},
          serverInfo: { name: 'claude-agent-acp', version: '1.0.0' },
        });
        break;

      case 'session/new':
        if (params?.cwd) sessionCwd = params.cwd;
        respond(id, { sessionId: randomUUID() });
        break;

      case 'session/prompt':
        await execTurn(id, params?.prompt ?? []);
        break;

      default:
        if (id != null) {
          respondError(id, -32601, `Method not found: ${method}`);
        }
    }
  } finally {
    pending--;
    maybeExit();
  }
});

rl.on('close', () => {
  stdinClosed = true;
  maybeExit();
});
