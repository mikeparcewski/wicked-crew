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
 * Elicitation (DES-002, Path B): wicked-core sends session/create_elicitation when
 * an MCP server inside the ACP session requests elicitation/create. The bridge blocks
 * on the pending promise and replies only after session/elicitation_resolved arrives.
 *
 * `--settings <path>` is accepted and IGNORED: wicked-core prepends it when input
 * governance is armed, but the settings file declares Claude-format PreToolUse
 * hooks that these CLIs don't understand. Governance for them stays at the same
 * level as their single-shot path.
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

/**
 * Strip ANSI escape sequences so spinner/colour codes never pollute the transcript:
 * CSI sequences (colours, cursor movement) and OSC sequences (terminated by BEL or
 * ST). Written with explicit \u escapes so no literal control bytes live in source.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g;

/**
 * Run the bridge for one CLI.
 *
 * @param {object} config
 * @param {string} config.name    Bridge name reported in serverInfo (e.g. "codex-acp").
 * @param {string} config.version serverInfo version.
 * @param {(prompt: string, cwd: string) => { bin: string, args: string[] }} config.invocation
 *   Maps a turn's prompt text (and the session cwd) to the headless CLI invocation.
 * @param {{ input?: import('stream').Readable, output?: import('stream').Writable }} [config._streams]
 *   Injectable streams for testing. Defaults to process.stdin / process.stdout.
 * @param {(code: number) => void} [config._exit]
 *   Injectable exit function for testing. Defaults to process.exit.
 */
export function runBridge({ name, version, invocation, _streams, _exit }) {
  // ── Injectable I/O (testability seam, DES-002 §4 P-4) ───────────────────────
  const _input = _streams?.input ?? process.stdin;
  const _output = _streams?.output ?? process.stdout;
  const _exitFn = _exit ?? process.exit.bind(process);

  let sessionCwd = process.cwd();

  // ── Elicitation state (DES-002 §4 P-1) ─────────────────────────────────────
  // currentSessionId: the UUID minted by the last session/new. create_elicitation
  // requests that carry a different sessionId are rejected with -32602.
  let currentSessionId = null;

  // pendingElicitations: keyed by sessionId → { elicitationId, resolve }
  // There is at most one pending elicitation per session at a time. A new
  // create_elicitation cancels any prior slot before opening a new one.
  const pendingElicitations = new Map();

  // ── Wire protocol helpers ────────────────────────────────────────────────────
  function send(obj) {
    _output.write(JSON.stringify(obj) + '\n');
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

  // ── session/prompt execution ─────────────────────────────────────────────────
  function execTurn(rpcId, promptBlocks) {
    return new Promise((resolve) => {
      const promptText = promptBlocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n\n')
        .trim();

      const { bin, args } = invocation(promptText, sessionCwd);
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

      child.stdout.on('data', (data) => {
        const text = String(data).replace(ANSI, '');
        if (!text) return;
        notify('session/update', {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text },
          },
        });
      });

      child.on('close', (code) => {
        // Only a clean exit is a completed turn. `code === null` means the CLI was
        // killed by a signal (timeout, mid-stream kill) — reporting end_turn there
        // would mask a truncated response as a successful one.
        const stopReason = code === 0 ? 'end_turn' : 'error';
        respond(rpcId, { stopReason });
        resolve();
      });

      child.on('error', (err) => {
        respondError(rpcId, -32603, `${bin} spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  // ── readline ─────────────────────────────────────────────────────────────────
  const rl = createInterface({ input: _input, terminal: false });

  // Track in-flight async handlers so exit waits for running turns (stdin EOF can
  // arrive while a CLI subprocess is still working).
  let pending = 0;
  let stdinClosed = false;
  function maybeExit() {
    if (stdinClosed && pending === 0) _exitFn(0);
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

        case 'session/new': {
          // Cancel any pending elicitation before starting a new session.
          for (const slot of pendingElicitations.values()) slot.resolve({ action: 'cancel' });
          pendingElicitations.clear();
          currentSessionId = randomUUID();
          if (params?.cwd) sessionCwd = params.cwd;
          if (!isNotification) respond(id, { sessionId: currentSessionId });
          break;
        }

        case 'session/prompt':
          if (!isNotification) await execTurn(id, params?.prompt ?? []);
          break;

        case 'session/create_elicitation': {
          // Notifications on this method carry no id to respond to and make no sense
          // (the whole point is to await a resolution response). Silently ignore.
          if (isNotification) {
            console.error('[bridge] session/create_elicitation without an id; ignoring');
            break;
          }

          const { sessionId, message, mode, requestedSchema } = params ?? {};

          // ── Session guard ────────────────────────────────────────────────────
          if (!currentSessionId || sessionId !== currentSessionId) {
            respondError(id, -32602, `Unknown sessionId: ${String(sessionId)}`);
            break;
          }

          // ── Mode check ───────────────────────────────────────────────────────
          // Absent mode treated as 'form' (backward compat); reject non-null non-form only.
          if (mode != null && mode !== 'form') {
            respondError(id, -32602, `Unsupported mode: ${String(mode)}; only mode:'form' is supported in v1`);
            break;
          }

          // ── requestedSchema presence ─────────────────────────────────────────
          if (requestedSchema == null) {
            respondError(id, -32602, 'mode:form requires a requestedSchema');
            break;
          }

          // ── Top-level key check ──────────────────────────────────────────────
          const allowedTopKeys = new Set(['type', 'required', 'properties']);
          if (Object.keys(requestedSchema).some((k) => !allowedTopKeys.has(k))) {
            respondError(id, -32602, 'Unsupported requestedSchema: only type, required, and properties are supported at the top level in v1');
            break;
          }

          // ── type must be 'object' if present ────────────────────────────────
          if (requestedSchema.type != null && requestedSchema.type !== 'object') {
            respondError(id, -32602, 'Unsupported requestedSchema: top-level type must be "object" if present');
            break;
          }

          // ── required: array, and only 'response' allowed ─────────────────────
          if (requestedSchema.required != null) {
            if (!Array.isArray(requestedSchema.required)) {
              respondError(id, -32602, 'Unsupported requestedSchema: required must be an array if present');
              break;
            }
            if (requestedSchema.required.some((r) => r !== 'response')) {
              respondError(id, -32602, 'Unsupported requestedSchema: required may only list "response" in v1');
              break;
            }
          }

          // ── properties: exactly {response} ───────────────────────────────────
          const propKeys = Object.keys(requestedSchema?.properties ?? {});
          if (propKeys.length !== 1 || propKeys[0] !== 'response') {
            respondError(id, -32602, 'Unsupported requestedSchema: only single-property {response} schema is supported in v1');
            break;
          }

          // ── response property: type:string, only type+enum allowed ───────────
          const respSchema = requestedSchema.properties.response;
          if (respSchema?.type !== 'string') {
            respondError(id, -32602, 'Unsupported requestedSchema: response must be type:string');
            break;
          }
          const allowedRespKeys = new Set(['type', 'enum']);
          if (Object.keys(respSchema).some((k) => !allowedRespKeys.has(k))) {
            respondError(id, -32602, 'Unsupported requestedSchema: only type and enum keywords are supported on response property in v1');
            break;
          }

          // ── enum validation ───────────────────────────────────────────────────
          const rawEnum = respSchema.enum;
          if (rawEnum != null && !Array.isArray(rawEnum)) {
            respondError(id, -32602, 'Unsupported requestedSchema: enum must be an array of strings');
            break;
          }
          if (Array.isArray(rawEnum) && rawEnum.length === 0) {
            respondError(id, -32602, 'Unsupported requestedSchema: enum must be non-empty');
            break;
          }
          if (Array.isArray(rawEnum) && rawEnum.some((v) => typeof v !== 'string' || v === '')) {
            respondError(id, -32602, 'Unsupported requestedSchema: all enum members must be non-empty strings');
            break;
          }

          // ── Validated: open the elicitation ──────────────────────────────────
          const options = Array.isArray(rawEnum) ? rawEnum : null;

          // Cancel any prior pending elicitation for this session.
          const prior = pendingElicitations.get(String(sessionId));
          if (prior) prior.resolve({ action: 'cancel' });

          const elicitationId = randomUUID();
          let resolveElicitation;
          const p = new Promise((r) => { resolveElicitation = r; });
          pendingElicitations.set(String(sessionId), { elicitationId, resolve: resolveElicitation });

          // Notify the caller that an elicitation is pending (non-blocking).
          notify('session/elicitation_pending', { sessionId, elicitationId, message, options });

          // Block this handler until session/elicitation_resolved arrives.
          const result = await p;

          // Clean up the slot (the resolved one — a new session/new may have replaced it).
          const cur = pendingElicitations.get(String(sessionId));
          if (cur && cur.elicitationId === elicitationId) pendingElicitations.delete(String(sessionId));

          // Guard the resolved result shape before forwarding to the actor (DES-002 §4 P-1).
          // A wicked-core or client bug must surface as a protocol error, not silently propagate.
          if (!['accept', 'decline', 'cancel'].includes(result.action)) {
            respondError(id, -32603, `session/elicitation_resolved: unrecognised action: ${String(result.action)}`);
            break;
          }
          if (result.action === 'accept') {
            if (typeof result.content?.response !== 'string' || result.content.response === '') {
              respondError(id, -32603, 'session/elicitation_resolved: accept result must carry a non-empty content.response');
              break;
            }
          }

          // The actor expects a valid elicitation result object.
          respond(id, result);
          break;
        }

        case 'session/elicitation_resolved': {
          const { sessionId, elicitationId, action, content } = params ?? {};
          const slot = pendingElicitations.get(String(sessionId));
          if (slot && slot.elicitationId === String(elicitationId)) {
            slot.resolve(content == null ? { action } : { action, content });
          }
          if (!isNotification) respond(id, { ok: true });
          break;
        }

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
    // Cancel any pending elicitations so their awaiting handlers unblock and
    // the pending counter can reach zero, letting maybeExit fire.
    for (const slot of pendingElicitations.values()) slot.resolve({ action: 'cancel' });
    pendingElicitations.clear();
    maybeExit();
  });
}
