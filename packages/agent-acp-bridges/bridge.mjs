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
 * Parent death (crew#285): stdin EOF is the portable parent-death signal — wicked-core
 * holds this bridge's stdin open for the whole session and ends it only by killing the
 * process, so EOF means the daemon is gone. A half-closing client (ndjson piped in from
 * a shell, the integration suite) is still legitimate though, so the watchdog is
 * two-stage: an in-flight turn first gets a short grace to finish and flush normally;
 * one that outlives it is SIGTERMed, then SIGKILLed after a second grace, and the
 * bridge exits itself rather than lingering as a detached orphan until the CLI is done.
 *
 * Parent-initiated termination (also crew#285): the daemon's shutdown reaper ends
 * bridges with SIGTERM → grace → SIGKILL. Node's default SIGTERM disposition would
 * kill this process WITHOUT reaping the in-flight CLI child — the same orphan one
 * level down — so a handler reaps immediately (no completion grace; the parent is
 * leaving now) and exits within the reaper's escalation budget.
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
 * Per-stage grace window for the parent-death watchdog (crew#285). When stdin closes
 * while a CLI turn is executing, the turn gets this long to complete and flush
 * normally; a CLI that outlives it is SIGTERMed, gets this long again to exit, and is
 * then SIGKILLed as the bridge force-exits. Worst-case bridge lifetime after parent
 * death is therefore ~2 windows, not the CLI's own (potentially unbounded) runtime.
 */
export const PARENT_DEATH_KILL_GRACE_MS = 2000;

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
 * @param {number} [config._killGraceMs]
 *   Injectable per-stage watchdog grace (completion wait, then SIGTERM→SIGKILL) for
 *   testing. Defaults to PARENT_DEATH_KILL_GRACE_MS.
 */
export function runBridge({ name, version, invocation, _streams, _exit, _killGraceMs }) {
  // ── Injectable I/O (testability seam, DES-002 §4 P-4) ───────────────────────
  const _input = _streams?.input ?? process.stdin;
  const _output = _streams?.output ?? process.stdout;
  const _exitFn = _exit ?? process.exit.bind(process);
  const killGraceMs = _killGraceMs ?? PARENT_DEATH_KILL_GRACE_MS;

  // Parent death (crew#285) breaks the stdout pipe as well as stdin. Without a
  // listener the resulting EPIPE surfaces as an uncaught exception that kills the
  // bridge WITHOUT reaping its CLI child — the exact orphan this watchdog exists to
  // prevent. Exit is handled deliberately by the stdin-EOF path below.
  _output.on?.('error', () => {});

  // In-flight CLI children, so parent death can reap them instead of waiting them out.
  const liveChildren = new Set();
  /** Pending watchdog stage (completion grace, then SIGTERM→SIGKILL); cleared when
   *  the bridge drains and exits cleanly first. */
  let reapTimer = null;

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
  // A dying peer surfaces as an async 'error' on the output stream (EPIPE);
  // without a listener that throws and crashes the bridge instead of letting
  // the stdin-close path drive a clean exit (crew#290 tolerance audit).
  _output.on('error', (err) => {
    console.error(`[bridge] output stream error: ${err?.code ?? String(err)}`);
  });
  function send(obj) {
    // A write after parent death can throw EPIPE synchronously; there is nobody left
    // to read the reply, so swallow it — exit is the stdin-EOF watchdog's job.
    try {
      _output.write(JSON.stringify(obj) + '\n');
    } catch {
      /* broken pipe after parent death */
    }
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
      // Tolerant block filter (crew#290): the prompt vocabulary grows over time
      // (new content-block types, null padding from buggy clients). Unknown or
      // malformed entries are skipped, not fatal — the turn runs on whatever
      // text blocks are readable.
      const promptText = promptBlocks
        .filter((b) => b != null && b.type === 'text' && typeof b.text === 'string' && b.text)
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

      liveChildren.add(child);

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
        liveChildren.delete(child);
        // Only a clean exit is a completed turn. `code === null` means the CLI was
        // killed by a signal (timeout, mid-stream kill) — reporting end_turn there
        // would mask a truncated response as a successful one.
        const stopReason = code === 0 ? 'end_turn' : 'error';
        respond(rpcId, { stopReason });
        resolve();
      });

      child.on('error', (err) => {
        liveChildren.delete(child);
        respondError(rpcId, -32603, `${bin} spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  // ── readline ─────────────────────────────────────────────────────────────────
  const rl = createInterface({ input: _input, terminal: false });

  // Track in-flight async handlers so exit waits for running turns (stdin EOF can
  // arrive while a CLI subprocess is still working). The parent-death watchdog in the
  // rl 'close' handler bounds that wait — it no longer stretches to the CLI's runtime.
  let pending = 0;
  let stdinClosed = false;
  let exited = false;
  // Exactly-once exit: the watchdog escalation and the normal drain path can both
  // reach exit (a SIGKILLed child still emits 'close', draining `pending` after the
  // timer already fired). Real `process.exit` makes the second call moot; injected
  // test exits do not.
  function exitOnce(code) {
    if (exited) return;
    exited = true;
    _exitFn(code);
  }
  function maybeExit() {
    if (stdinClosed && pending === 0) {
      // Turns drained before the escalation fired — don't SIGKILL dead pids later.
      if (reapTimer !== null) clearTimeout(reapTimer);
      exitOnce(0);
    }
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON — a stray log line or partial frame. Ignore and keep serving
      // (crew#290: nothing on this stream may be fatal).
      console.error('[bridge] ignoring unparseable input line');
      return;
    }

    // Valid JSON but not an object (a bare `null`, number, string, or boolean
    // literal) is not a JSON-RPC frame. Guard before destructuring: `null`
    // would throw OUTSIDE the dispatch try/catch below and kill the bridge
    // (crew#290: nothing on this stream may be fatal).
    if (msg === null || typeof msg !== 'object') {
      console.error('[bridge] ignoring non-object input frame');
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
          if (!isNotification) {
            // A non-array prompt is a client bug: answer with invalid-params
            // instead of throwing (the throw would kill the bridge and take the
            // whole session down with it — crew#290's failure class).
            if (params?.prompt != null && !Array.isArray(params.prompt)) {
              respondError(id, -32602, 'session/prompt: params.prompt must be an array of content blocks');
              break;
            }
            await execTurn(id, params?.prompt ?? []);
          }
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
          // Tolerant-by-default (crew#290): the frame vocabulary grows over
          // time. An unknown REQUEST gets a JSON-RPC error response (the
          // caller needs a terminal answer); an unknown notification — or a
          // frame that isn't JSON-RPC at all, e.g. a stream-json frame piped
          // here by mistake — is logged and dropped. Neither may exit.
          if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
          else console.error(`[bridge] ignoring unknown frame (method: ${String(method)})`);
      }
    } catch (err) {
      // No handler error may escape this callback: readline neither awaits nor
      // guards its listeners, so an escaped throw becomes an uncaught
      // exception (or unhandled rejection) and kills the bridge mid-session —
      // the engine then sees Broken pipe and degrades to single-shot
      // (crew#290). Answer requests with -32603 and keep serving.
      console.error(`[bridge] error handling ${String(method)}: ${err?.stack ?? String(err)}`);
      if (!isNotification) {
        try {
          respondError(id, -32603, `Internal error handling ${String(method)}: ${err?.message ?? String(err)}`);
        } catch {
          // Output stream is gone; stdin close will drive the exit path.
        }
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
    // Parent-death watchdog (crew#285): stdin EOF is the portable parent-death signal —
    // wicked-core holds this bridge's stdin open for the whole session and ends it only
    // by killing the process. But EOF is ALSO how a half-closing client (ndjson piped in
    // from a shell) says "no more requests", and that client still expects the in-flight
    // turn to flush. Two-stage escalation serves both: the turn gets one grace window to
    // complete normally (a fast CLI drains `pending` and maybeExit clears the timers); a
    // CLI that outlives it is presumed orphan-bound — SIGTERM first so it can clean up
    // its own children, SIGKILL + force-exit one more window later for anything that
    // ignored that. The bridge must never outlive its parent by more than ~2 windows.
    if (liveChildren.size > 0) {
      reapTimer = setTimeout(() => {
        for (const child of liveChildren) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
        reapTimer = setTimeout(() => {
          for (const child of liveChildren) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
          exitOnce(0);
        }, killGraceMs);
        reapTimer.unref?.();
      }, killGraceMs);
      // The escalation must never hold an otherwise-finished bridge process open.
      reapTimer.unref?.();
    }
    maybeExit();
  });

  // ── Parent-initiated termination (crew#285) ─────────────────────────────────
  // The daemon-side reaper (wicked-crew's BridgeReaper) shuts bridges down with
  // SIGTERM → ~2s grace → SIGKILL. Node's default SIGTERM disposition kills this
  // process WITHOUT running any JS — the in-flight CLI child would be orphaned for
  // its whole remaining runtime, exactly the defect class this file exists to close.
  // So: reap the children NOW (no completion grace — the parent chose to terminate
  // us and its own SIGKILL lands in ~one window), SIGKILL + exit half a window later
  // so the whole escalation finishes inside the reaper's budget. A drained child
  // exits us earlier via maybeExit (stdinClosed is forced true — after SIGTERM no
  // further input will be served).
  //
  // Real-process mode only: in-process test bridges must not stack live listeners on
  // the shared test process. Windows never delivers a catchable SIGTERM (process.kill
  // is already lethal there), so the handler is inert by construction on win32.
  if (_streams === undefined) {
    process.once('SIGTERM', () => {
      stdinClosed = true;
      for (const slot of pendingElicitations.values()) slot.resolve({ action: 'cancel' });
      pendingElicitations.clear();
      if (liveChildren.size > 0) {
        for (const child of liveChildren) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
        // Supersede any pending stdin-EOF stage: termination is already escalating.
        if (reapTimer !== null) clearTimeout(reapTimer);
        reapTimer = setTimeout(() => {
          for (const child of liveChildren) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
          exitOnce(0);
        }, Math.max(1, Math.floor(killGraceMs / 2)));
        reapTimer.unref?.();
      }
      maybeExit();
    });
  }
}
