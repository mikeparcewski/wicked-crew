/**
 * Tolerance regression tests (crew#290): unknown or malformed frames must NEVER
 * kill the bridge. The stream-json / ACP vocabulary grows over time, so the
 * dispatch has to be tolerant-by-default — unknown = log + ignore (or a JSON-RPC
 * error response when the frame was a request), and the session must keep
 * working afterwards, including a SECOND turn on the same session (the
 * crew#288 turn-2 wedge probe at this bridge's level).
 *
 * Test inventory:
 *   1.  unknown notification method → ignored; session still serves requests
 *   2.  unknown request method → -32601 response; session continues
 *   3.  non-JSON-RPC frame (raw stream-json system frame, e.g. vcs_state_changed)
 *       → ignored; no response; session continues; no exit
 *   4.  unparseable line → ignored; session continues
 *   5.  session/prompt with non-array prompt → -32602, no crash; a valid turn
 *       on the SAME session then completes with end_turn
 *   6.  prompt array with null / unknown-type / malformed blocks → turn still
 *       runs on the readable text blocks
 *   7.  handler exception (invocation throws) → -32603 response, bridge alive,
 *       still serves afterwards — never process death
 *   8.  two consecutive turns interleaved with hostile frames both complete
 *       (turn 2 works after unknown frames — crew#288 probe)
 *   9.  bare JSON primitive lines (null / number / string / bool) → ignored;
 *       destructuring a parsed `null` must not escape the dispatch guard
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runBridge } from '../bridge.mjs';

// ── Test harness (same pattern as bridge-elicitation.test.mjs) ────────────────

function createTestBridge(invocationFn = () => ({ bin: process.execPath, args: ['-e', 'console.log("ran")'] })) {
  const input = new PassThrough();
  const output = new PassThrough();
  const exitSpy = vi.fn();

  runBridge({
    name: 'test-bridge',
    version: '0.0.0',
    invocation: invocationFn,
    _streams: { input, output },
    _exit: exitSpy,
  });

  const received = [];
  const waiters = [];
  let buf = '';

  output.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(msg);
      else received.push(msg);
    }
  });

  function send(msg) {
    input.write(JSON.stringify(msg) + '\n');
  }

  function sendRaw(line) {
    input.write(line + '\n');
  }

  function next(timeoutMs = 5000) {
    if (received.length > 0) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx !== -1) {
          waiters.splice(idx, 1);
          reject(new Error('bridge next() timed out'));
        }
      }, timeoutMs);
      timer.unref();
    });
  }

  return { send, sendRaw, next, exitSpy };
}

/** initialize + session/new, returns sessionId. */
async function handshake(b) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const initRes = await b.next();
  expect(initRes.result).toBeDefined();

  b.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const newRes = await b.next();
  return newRes.result.sessionId;
}

/** Drive one session/prompt to its terminal response, collecting notifications. */
async function runTurn(b, id, promptBlocks) {
  b.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { prompt: promptBlocks } });
  const chunks = [];
  for (;;) {
    const msg = await b.next();
    if (msg.id === id) return { response: msg, chunks };
    if (msg.method === 'session/update') chunks.push(msg.params?.update?.content?.text ?? '');
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('bridge tolerance: unknown frames never kill the session (crew#290)', () => {
  it('1. unknown notification method is ignored; session still serves', async () => {
    const b = createTestBridge();
    const sid = await handshake(b);
    expect(sid).toBeDefined();

    // Notification (no id) with a method from the future.
    b.send({ jsonrpc: '2.0', method: 'session/some_future_notification', params: { anything: true } });

    // Bridge must not respond to it and must still answer the next request.
    b.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result.protocolVersion).toBe(1);
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('2. unknown request method → -32601 error response; session continues', async () => {
    const b = createTestBridge();
    await handshake(b);

    b.send({ jsonrpc: '2.0', id: 3, method: 'session/from_the_future', params: {} });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.error.code).toBe(-32601);

    b.send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
    const res2 = await b.next();
    expect(res2.id).toBe(4);
    expect(res2.result).toBeDefined();
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('3. raw stream-json frames (vcs_state_changed, unknown subtype) are ignored', async () => {
    const b = createTestBridge();
    await handshake(b);

    // Frames that are valid JSON but not JSON-RPC at all — the crew#290 shape.
    b.send({ type: 'system', subtype: 'vcs_state_changed', kind: 'commit', branch: 'main' });
    b.send({ type: 'system', subtype: 'totally_unknown_subtype', payload: {} });
    b.send({ type: 'totally_unknown_frame_type' });

    // No responses for any of them; the next request still works.
    b.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result).toBeDefined();
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('4. unparseable line is ignored; session continues', async () => {
    const b = createTestBridge();
    await handshake(b);

    b.sendRaw('this is not json {{{');
    b.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result).toBeDefined();
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('5. non-array prompt → -32602, then a valid turn on the SAME session completes', async () => {
    const b = createTestBridge();
    await handshake(b);

    // Before the crew#290 hardening this threw (promptBlocks.filter is not a
    // function) and the escaped exception killed the whole bridge process.
    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: 42 } });
    const bad = await b.next();
    expect(bad.id).toBe(3);
    expect(bad.error.code).toBe(-32602);
    expect(b.exitSpy).not.toHaveBeenCalled();

    const { response } = await runTurn(b, 4, [{ type: 'text', text: 'real turn' }]);
    expect(response.result.stopReason).toBe('end_turn');
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('6. prompt with null / unknown-type / malformed blocks still runs the turn', async () => {
    const prompts = [];
    const b = createTestBridge((prompt) => {
      prompts.push(prompt);
      return { bin: process.execPath, args: ['-e', 'console.log("ran")'] };
    });
    await handshake(b);

    const { response } = await runTurn(b, 3, [
      null,
      { type: 'future_block_kind', data: 'x' },
      { type: 'text', text: 'keep me' },
      { type: 'text', text: 123 }, // non-string text — skipped
      { type: 'text', text: 'and me' },
    ]);
    expect(response.result.stopReason).toBe('end_turn');
    expect(prompts).toEqual(['keep me\n\nand me']);
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('7. handler exception → -32603 response, bridge stays alive', async () => {
    const b = createTestBridge(() => {
      throw new Error('invocation exploded');
    });
    await handshake(b);

    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'x' }] } });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toMatch(/invocation exploded/);

    // Bridge survived and still serves.
    b.send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
    const res2 = await b.next();
    expect(res2.result).toBeDefined();
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('8. two turns interleaved with hostile frames both complete (crew#288 probe)', async () => {
    const b = createTestBridge();
    await handshake(b);

    b.send({ type: 'system', subtype: 'vcs_state_changed', kind: 'commit' });
    const turn1 = await runTurn(b, 3, [{ type: 'text', text: 'turn one' }]);
    expect(turn1.response.result.stopReason).toBe('end_turn');

    b.send({ type: 'system', subtype: 'vcs_state_changed', kind: 'commit' });
    b.send({ jsonrpc: '2.0', method: 'session/some_future_notification', params: {} });
    const turn2 = await runTurn(b, 4, [{ type: 'text', text: 'turn two' }]);
    expect(turn2.response.result.stopReason).toBe('end_turn');
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('9. bare JSON primitive lines (null, number, string, bool) are ignored', async () => {
    const b = createTestBridge();
    await handshake(b);

    // JSON.parse succeeds on these but they are not JSON-RPC objects. Before
    // the non-object guard, destructuring the parsed `null` threw OUTSIDE the
    // dispatch try/catch and killed the bridge (unhandled rejection in the
    // async line listener) — the crew#290 fatal class.
    b.sendRaw('null');
    b.sendRaw('42');
    b.sendRaw('"a stray string"');
    b.sendRaw('true');

    b.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result).toBeDefined();
    expect(b.exitSpy).not.toHaveBeenCalled();
  });
});
