/**
 * Parent-death watchdog tests (crew#285): the bridge must die when its client does.
 *
 * wicked-core holds the bridge's stdin open for the whole session and ends sessions by
 * killing the process, so stdin EOF from IT only ever means the parent is gone — daemon
 * death included, where the engine's in-memory kill handles can no longer reap anything.
 * A half-closing client (ndjson piped in from a shell; the crew integration suite) is
 * still legitimate though, so the watchdog escalates in stages:
 *
 *   1. with no turn in flight, EOF exits immediately (pre-existing behavior, pinned here);
 *   2. a turn that finishes within the completion grace still flushes its chunks and
 *      stopReason normally — half-close keeps working;
 *   3. a CLI that outlives the completion grace is SIGTERMed and the bridge exits once
 *      the child is gone, instead of lingering detached until the CLI finishes;
 *   4. a CLI that also ignores SIGTERM is SIGKILLed one more grace later and the bridge
 *      force-exits — exactly once, even though the killed child's 'close' also races
 *      toward the exit path.
 *
 * The CLI under the bridge is a real `node -e` process (the watchdog's whole subject is
 * OS process lifetime); the bridge itself runs in-process via the injectable-stream
 * harness, so no real process.exit fires.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runBridge } from '../bridge.mjs';

// ── Harness (same shape as bridge-elicitation.test.mjs) ────────────────────────

function createTestBridge(invocationFn, { killGraceMs } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const exitSpy = vi.fn();

  runBridge({
    name: 'test-bridge',
    version: '0.0.0',
    invocation: invocationFn,
    _streams: { input, output },
    _exit: exitSpy,
    _killGraceMs: killGraceMs,
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

  function next(timeoutMs = 5000) {
    if (received.length > 0) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx !== -1) {
          waiters.splice(idx, 1);
          reject(new Error('bridge next() timed out'));
        }
      }, timeoutMs);
    });
  }

  function close() {
    input.push(null);
  }

  return { send, next, close, exitSpy };
}

/** initialize + session/new. */
async function handshake(b) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await b.next();
  b.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  await b.next();
}

/** Signal-0 probe: alive (EPERM = alive but not ours) vs gone. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Start a session/prompt turn whose CLI announces its own pid and then hangs forever.
 * Resolves to the CLI child's pid once the announcement round-trips through the
 * bridge's agent_message_chunk notification — i.e. once the CLI has really exec'd and
 * installed whatever handlers its script sets up.
 */
async function startHangingTurn(b) {
  b.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { prompt: [{ type: 'text', text: 'go' }] },
  });
  const chunk = await b.next();
  expect(chunk.method).toBe('session/update');
  const match = /(\d+)/.exec(chunk.params.update.content.text);
  expect(match).not.toBeNull();
  const pid = Number(match[1]);
  expect(pidAlive(pid)).toBe(true);
  return pid;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('bridge parent-death watchdog (crew#285)', () => {
  it('exits when stdin closes with no turn in flight', async () => {
    const b = createTestBridge(() => ({ bin: process.execPath, args: ['-e', ''] }));
    b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await b.next();

    b.close();

    await waitFor(() => b.exitSpy.mock.calls.length > 0, 'bridge exit after idle EOF');
    expect(b.exitSpy).toHaveBeenCalledWith(0);
  });

  it('lets a turn that finishes within the completion grace flush normally after EOF', async () => {
    // Half-close contract: prompt sent, stdin ended, CLI completes quickly — its chunks
    // and end_turn must still reach the client, exactly as before the watchdog existed.
    const cli = "process.stdout.write('quick result\\n');";
    const b = createTestBridge(() => ({ bin: process.execPath, args: ['-e', cli] }), {
      killGraceMs: 2000,
    });
    await handshake(b);
    b.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'go' }] },
    });

    b.close();

    const chunk = await b.next();
    expect(chunk.method).toBe('session/update');
    expect(chunk.params.update.content.text).toContain('quick result');
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result.stopReason).toBe('end_turn');
    await waitFor(() => b.exitSpy.mock.calls.length > 0, 'bridge exit after flushed turn');
    expect(b.exitSpy).toHaveBeenCalledWith(0);
  });

  it('stdin EOF mid-turn SIGTERMs an overstaying CLI child and the bridge exits', async () => {
    const cli = "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000);";
    const b = createTestBridge(() => ({ bin: process.execPath, args: ['-e', cli] }), {
      killGraceMs: 200,
    });
    await handshake(b);
    const cliPid = await startHangingTurn(b);

    b.close();

    // The reaped turn still reports honestly: a signal-killed CLI is an error stop,
    // not a completed turn (the write is EPIPE-guarded, and here the pipe is open).
    const res = await b.next();
    expect(res.id).toBe(3);
    expect(res.result.stopReason).toBe('error');

    await waitFor(() => b.exitSpy.mock.calls.length > 0, 'bridge exit after mid-turn EOF');
    await waitFor(() => !pidAlive(cliPid), 'CLI child death');
    expect(b.exitSpy).toHaveBeenCalledWith(0);
  });

  // Windows has no ignorable SIGTERM — child.kill('SIGTERM') is already lethal there,
  // so the SIGKILL escalation is POSIX-only behavior.
  it.skipIf(process.platform === 'win32')(
    'a SIGTERM-ignoring CLI is SIGKILLed after the grace and the bridge force-exits once',
    async () => {
      const cli =
        "process.on('SIGTERM', () => {}); " +
        "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000);";
      const b = createTestBridge(() => ({ bin: process.execPath, args: ['-e', cli] }), {
        killGraceMs: 300,
      });
      await handshake(b);
      const cliPid = await startHangingTurn(b);

      b.close();

      await waitFor(() => b.exitSpy.mock.calls.length > 0, 'forced bridge exit');
      await waitFor(() => !pidAlive(cliPid), 'SIGKILLed CLI child death');
      // Escalation exit and the killed child's own close-drain both reach the exit
      // path; the exactly-once guard must collapse them.
      await new Promise((r) => setTimeout(r, 100));
      expect(b.exitSpy).toHaveBeenCalledTimes(1);
      expect(b.exitSpy).toHaveBeenCalledWith(0);
    },
  );
});
