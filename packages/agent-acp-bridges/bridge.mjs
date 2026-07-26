/**
 * Shared ACP (Agent Client Protocol) stdio bridge for headless coding CLIs.
 *
 * Protocol: JSON-RPC 2.0 ndjson over stdin/stdout. wicked-core is the client; the
 * per-CLI bin (codex-acp, pi-acp, agy-acp, opencode-acp) is the server. Each
 * session/prompt turn runs one headless CLI invocation and streams its stdout back
 * as agent_message_chunk notifications before sending the final response.
 *
 * Handshake (wicked-core → bridge):
 *   1. initialize  → result: { protocolVersion, serverCapabilities, serverInfo }
 *   2. session/new → result: { sessionId }
 *   3. session/prompt (repeated) → notifications + result: { stopReason }
 *
 * `--settings <path>` is accepted and IGNORED: wicked-core prepends it when input
 * governance is armed, but the settings file declares Claude-format PreToolUse
 * hooks that these CLIs don't understand. Governance for them stays at the same
 * level as their single-shot path.
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

/** Strip ANSI escape sequences so spinner/colour codes never pollute the transcript. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[A-Za-z]|\][^]*/g;

/**
 * Run the bridge for one CLI.
 *
 * @param {object} config
 * @param {string} config.name    Bridge name reported in serverInfo (e.g. "codex-acp").
 * @param {string} config.version serverInfo version.
 * @param {(prompt: string) => { bin: string, args: string[] }} config.invocation
 *   Maps a turn's prompt text to the headless CLI invocation.
 */
export function runBridge({ name, version, invocation }) {
  let sessionCwd = process.cwd();

  function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }
  function respondError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  function execTurn(rpcId, promptBlocks) {
    return new Promise((resolve) => {
      const promptText = promptBlocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n\n')
        .trim();

      const { bin, args } = invocation(promptText);
      let child;
      try {
        child = spawn(bin, args, {
          cwd: sessionCwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (err) {
        respondError(rpcId, -32603, `${bin} spawn error: ${err.message}`);
        resolve();
        return;
      }

      let sawOutput = false;
      child.stdout.on('data', (data) => {
        const text = String(data).replace(ANSI, '');
        if (!text) return;
        sawOutput = true;
        notify('session/update', {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text },
          },
        });
      });

      child.on('close', (code) => {
        const stopReason = code === 0 || (code === null && sawOutput) ? 'end_turn' : 'error';
        respond(rpcId, { stopReason });
        resolve();
      });

      child.on('error', (err) => {
        respondError(rpcId, -32603, `${bin} spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  // Track in-flight async handlers so exit waits for running turns (stdin EOF can
  // arrive while a CLI subprocess is still working).
  let pending = 0;
  let stdinClosed = false;
  function maybeExit() {
    if (stdinClosed && pending === 0) process.exit(0);
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = msg;
    // JSON-RPC 2.0: messages without an id are notifications — never respond.
    const isNotification = id == null;

    pending++;
    try {
      switch (method) {
        case 'initialize':
          if (!isNotification)
            respond(id, {
              protocolVersion: 1,
              serverCapabilities: {},
              serverInfo: { name, version },
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
          if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
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
}
