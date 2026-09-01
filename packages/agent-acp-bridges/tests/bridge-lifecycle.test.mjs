/**
 * Bridge lifecycle regression tests (crew#290 + crew#340): hostile events arriving
 * WHILE A TURN IS IN FLIGHT must neither kill the bridge nor wedge the turn.
 *
 * bridge-tolerance.test.mjs pins the tolerant dispatch for frames arriving BETWEEN
 * turns. Both field defects happened MID-turn though — the engine's stream-json
 * `vcs_state_changed` lands while the CLI is still working (crew#290: workers commit
 * incrementally, so the frame arrives during every governed turn), and `kill -9` takes
 * the worker down in the middle of its work (crew#340). readline's listeners run
 * concurrently with the awaited turn, so mid-turn dispatch is a genuinely different
 * code path than the drained-queue case.
 *
 * Test inventory:
 *   1. vcs_state_changed injected mid-turn (slow CLI still running) → the turn
 *      COMPLETES with end_turn; no response is emitted for the injected frame; the
 *      bridge stays alive and serves a second turn.
 *   2. REAL `kill -9` of the CLI child mid-turn → the turn resolves LOUDLY with
 *      stopReason "error" (never end_turn, never silence), the bridge stays alive,
 *      and a second turn on the SAME session completes. The bridge-level half of
 *      crew#340: a dead worker becomes a named terminal answer, not a wedge.
 */

import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBridge } from '../bridge.mjs';

// ── Test harness (same pattern as bridge-tolerance.test.mjs) ──────────────────

function createTestBridge(invocationFn) {
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

  function next(timeoutMs = 10_000) {
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

  return { send, next, exitSpy };
}

async function handshake(b) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const initRes = await b.next();
  expect(initRes.result).toBeDefined();
  b.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  const newRes = await b.next();
  return newRes.result.sessionId;
}

/** Collect frames until the response for `id` arrives; returns { response, chunks }. */
async function collectTurn(b, id) {
  const chunks = [];
  for (;;) {
    const msg = await b.next();
    if (msg.id === id) return { response: msg, chunks };
    if (msg.method === 'session/update') chunks.push(msg.params?.update?.content?.text ?? '');
  }
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('bridge lifecycle under mid-turn hostility (crew#290 / crew#340)', () => {
  it('1. vcs_state_changed injected MID-TURN: the turn completes, the bridge lives', async () => {
    // A CLI slow enough that the injection demonstrably lands while it still runs:
    // it emits a first marker, waits 400ms, then emits the closing marker.
    const b = createTestBridge(() => ({
      bin: process.execPath,
      args: [
        '-e',
        "process.stdout.write('turn started\\n'); setTimeout(() => { process.stdout.write('turn finished\\n'); }, 400);",
      ],
    }));
    await handshake(b);

    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'work' }] } });

    // Wait for the FIRST streamed chunk — the turn is provably in flight now.
    const first = await b.next();
    expect(first.method).toBe('session/update');
    expect(first.params?.update?.content?.text ?? '').toContain('turn started');

    // The crew#290 killer frame, mid-turn — plus an unknown sibling for good measure.
    b.send({ type: 'system', subtype: 'vcs_state_changed', kind: 'commit', branch: 'main' });
    b.send({ type: 'system', subtype: 'subtype_from_the_future', payload: {} });

    // The turn must still complete normally, with the post-injection output streamed.
    const { response, chunks } = await collectTurn(b, 3);
    expect(response.result.stopReason).toBe('end_turn');
    expect(chunks.join('')).toContain('turn finished');
    expect(b.exitSpy).not.toHaveBeenCalled();

    // And the session still serves a second turn (the crew#288 probe, mid-turn edition).
    b.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'again' }] } });
    const turn2 = await collectTurn(b, 4);
    expect(turn2.response.result.stopReason).toBe('end_turn');
    expect(b.exitSpy).not.toHaveBeenCalled();
  });

  it('2. REAL kill -9 of the CLI child mid-turn: a LOUD error result, never a wedge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-kill-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'cli.pid');

    // Turn 1's CLI writes its own pid to stdout as its first chunk, then hangs (the
    // mid-turn window the kill lands in). Turn 2's CLI completes immediately — the
    // recovery probe must be able to succeed.
    let calls = 0;
    const b = createTestBridge(() => {
      calls++;
      return calls === 1
        ? {
            bin: process.execPath,
            args: [
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('PID:' + process.pid + '\\n'); setInterval(() => {}, 1000);`,
            ],
          }
        : { bin: process.execPath, args: ['-e', "process.stdout.write('recovered\\n');"] };
    });
    await handshake(b);

    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'work' }] } });

    // The worker is provably alive and mid-turn.
    const first = await b.next();
    expect(first.method).toBe('session/update');
    const pid = Number((first.params?.update?.content?.text ?? '').replace(/^PID:/, '').trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);

    // The real kill: SIGKILL, no cleanup, exactly the crew#340 field event.
    process.kill(pid, 'SIGKILL');

    // The unit resolves LOUDLY: a signal death is `code === null`, and the bridge
    // reports stopReason "error" — masking it as end_turn would hide a truncated
    // response, and silence would wedge the engine until its unit timeout.
    const { response } = await collectTurn(b, 3);
    expect(response.result.stopReason).toBe('error');
    expect(b.exitSpy).not.toHaveBeenCalled();

    // The bridge survived its worker: the SAME session serves the next turn, which
    // spawns a FRESH worker and completes — full recovery, no daemon restart, no wedge.
    b.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'again' }] } });
    const turn2 = await collectTurn(b, 4);
    expect(turn2.response.result.stopReason).toBe('end_turn');
    expect(turn2.chunks.join('')).toContain('recovered');
    expect(b.exitSpy).not.toHaveBeenCalled();
  });
});
