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

// Older claude CLIs reject unknown flags at startup, so probe --help once per
// bridge process and only pass --include-partial-messages when supported.
// Async (this process is an RPC server — a synchronous probe would stall the
// event loop) and cached as a promise so concurrent turns share one probe.
// Both stdout and stderr are checked: some CLIs write help text to stderr.
let partialMessagesProbe = null;

function supportsPartialMessages() {
  if (!partialMessagesProbe) {
    partialMessagesProbe = new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn('claude', ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 10_000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out.includes('--include-partial-messages'));
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }
  return partialMessagesProbe;
}

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
async function execTurn(rpcId, promptBlocks) {
  const partialMessages = await supportsPartialMessages();
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
    // --include-partial-messages adds stream_event frames (token deltas) so text
    // reaches the client AS it is generated, not once per completed message —
    // probed once because older CLIs reject unknown flags at startup.
    // Tool use / tool result frames are skipped — only text is forwarded.
    claudeArgs.push('--output-format', 'stream-json', '--verbose');
    if (partialMessages) claudeArgs.push('--include-partial-messages');
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
    // Chars emitted via stream_event deltas for the in-flight message. When >0 the
    // complete `assistant` frame's text is a duplicate of what already streamed.
    let deltaChars = 0;

    function emitChunk(text) {
      notify('session/update', {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text },
        },
      });
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      const type = msg.type;

      if (type === 'stream_event') {
        // Token-level delta (--include-partial-messages): forward text as it is generated.
        const ev = msg.event;
        if (ev?.type === 'message_start') deltaChars = 0;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          deltaChars += ev.delta.text.length;
          emitChunk(ev.delta.text);
        }
      } else if (type === 'assistant') {
        // Complete-message frame. Emit its text only if no deltas streamed for it
        // (older CLI without stream_event support, or a delta gap) — else it would double.
        const content = msg.message?.content ?? [];
        if (deltaChars === 0) {
          for (const block of content) {
            if (block.type === 'text' && block.text) emitChunk(block.text);
          }
        }
        deltaChars = 0;
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

  // JSON-RPC 2.0: messages without an id are notifications — never send a response.
  const isNotification = id == null;

  pending++;
  try {
    switch (method) {
      case 'initialize':
        if (!isNotification) respond(id, {
          protocolVersion: 1,
          serverCapabilities: {},
          serverInfo: { name: 'claude-agent-acp', version: '1.0.0' },
        });
        break;

      case 'session/new':
        if (params?.cwd) sessionCwd = params.cwd;
        if (!isNotification) respond(id, { sessionId: randomUUID() });
        break;

      case 'session/prompt':
        if (!isNotification) await execTurn(id, params?.prompt ?? []);
        break;

      default:
        if (!isNotification) {
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
