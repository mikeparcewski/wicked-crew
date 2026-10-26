// crew#1145: the daemon logged READY, then exited about a second later with no error text — the
// log ended with a blank line and `Node.js v26.11.1`, Node's fatal trailer with the report itself
// missing. The host's disk was nearly full; an ENOSPC on stdout (crew's log) emitted as an
// unhandled `'error'` reproduces it. These guards make every such end say why — or not end at all.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { describeThrown, EXIT_RECORD_FILENAME, installProcessGuards, type ProcessGuards } from '../src/core/process-guards.js';
import { removeScratch } from './setup/scratch.js';

/** A stdout whose every write fails the way a full disk fails it. */
function fullDiskStream(): Writable {
  return new Writable({
    write(_chunk, _enc, cb): void {
      cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' }));
    },
  });
}

interface FakeProcess extends EventEmitter {
  pid: number;
  stdout: Writable;
  stderr: Writable;
  exit: (code: number) => void;
}

function fakeProcess(stdout: Writable = new Writable({ write: (_c, _e, cb) => cb() })): FakeProcess {
  const p = new EventEmitter() as FakeProcess;
  p.pid = 4242;
  p.stdout = stdout;
  p.stderr = new Writable({ write: (_c, _e, cb) => cb() });
  p.exit = () => {
    throw new Error('the guard must exit through the injected exit');
  };
  return p;
}

describe('process guards (crew#1145)', () => {
  const dirs: string[] = [];
  const installed: ProcessGuards[] = [];
  afterEach(() => {
    for (const g of installed.splice(0)) g.uninstall();
    for (const d of dirs.splice(0)) removeScratch(d);
  });

  const setup = (proc: FakeProcess) => {
    const home = mkdtempSync(join(tmpdir(), 'crew-guards-'));
    dirs.push(home);
    const stderr: string[] = [];
    const exits: number[] = [];
    const guards = installProcessGuards({
      stateHome: () => home,
      proc: proc as unknown as NodeJS.Process,
      writeErr: (line) => stderr.push(line),
      freeSpace: () => ({ free: 3 * 2 ** 30, total: 460 * 2 ** 30 }),
      exit: (code) => exits.push(code),
      now: () => new Date('2026-10-26T00:22:28.000Z'),
    });
    installed.push(guards);
    const record = (): string => {
      try {
        return readFileSync(join(home, EXIT_RECORD_FILENAME), 'utf8');
      } catch {
        return '';
      }
    };
    return { home, stderr, exits, guards, record };
  };

  it('a stdout write that fails with ENOSPC is reported once — code, the state-home volume and its free space — and the daemon does NOT exit', async () => {
    const proc = fakeProcess(fullDiskStream());
    const { home, stderr, exits, record } = setup(proc);
    // What pino does for every log line after ready.
    proc.stdout.write('{"level":30,"msg":"watch registry armed (watch rows → watchEvent)"}\n');
    await new Promise((r) => setImmediate(r));
    proc.stdout.write('{"level":30,"msg":"a second line"}\n');
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([]);
    expect(stderr).toHaveLength(1); // once per stream and code, not once per log line
    expect(stderr[0]).toMatch(/^\[daemon\] stdout write failed \(ENOSPC\): ENOSPC: no space left on device/);
    expect(stderr[0]).toContain(`3 GiB free on the state-home volume (${home}, 99% used)`);
    expect(stderr[0]).toMatch(/the daemon keeps serving/);
    expect(record()).toContain('2026-10-26T00:22:28.000Z pid=4242 [daemon] stdout write failed (ENOSPC)');
  });

  it('without the guard the same ENOSPC is an uncaught error — the exit #1145 saw', async () => {
    const proc = fakeProcess(fullDiskStream());
    const unhandled = await new Promise<unknown>((resolve) => {
      proc.stdout.once('error', resolve); // stands in for Node's "no listener → uncaught exception"
      proc.stdout.write('x\n');
    });
    expect((unhandled as NodeJS.ErrnoException).code).toBe('ENOSPC');
  });

  it('when stderr is the stream that fails, the record still lands and stderr is not written again', async () => {
    const proc = fakeProcess();
    proc.stderr = fullDiskStream();
    const { stderr, record } = setup(proc);
    proc.stderr.write('x\n');
    await new Promise((r) => setImmediate(r));
    expect(stderr).toEqual([]); // the guard knows stderr is dead
    expect(record()).toContain('[daemon] stderr write failed (ENOSPC)');
  });

  it('an uncaught exception is reported with its stack and the process exits 1; the exit line names it', () => {
    const proc = fakeProcess();
    const { stderr, exits, record } = setup(proc);
    proc.emit('uncaughtException', new Error('boom after ready'), 'uncaughtException');
    expect(exits).toEqual([1]);
    expect(stderr[0]).toMatch(/^\[daemon\] FATAL uncaughtException: Error: boom after ready\n\s+at /);
    proc.emit('exit', 1);
    expect(stderr[1]).toBe('[daemon] exiting with code 1: uncaught exception: boom after ready');
    expect(record()).toContain('exiting with code 1: uncaught exception: boom after ready');
  });

  it('an unhandled rejection is reported with its stack and the daemon keeps serving', () => {
    const proc = fakeProcess();
    const { stderr, exits } = setup(proc);
    proc.emit('unhandledRejection', new Error('forgotten catch'), Promise.resolve());
    expect(exits).toEqual([]);
    expect(stderr[0]).toMatch(/^\[daemon\] unhandled promise rejection \(the daemon keeps serving.*\): Error: forgotten catch\n\s+at /s);
  });

  it('every exit says why: a recorded reason, else the stack of the exit call', () => {
    const proc = fakeProcess();
    const { stderr, guards } = setup(proc);
    proc.emit('exit', 0);
    expect(stderr[0]).toMatch(/^\[daemon\] exiting with code 0; no reason was recorded \(a process\.exit call, or the event loop drained\) — at: \S/);
    guards.noteExitReason('received SIGTERM at 2026-10-26T00:21:03.000Z');
    proc.emit('exit', 0);
    expect(stderr[1]).toBe('[daemon] exiting with code 0: received SIGTERM at 2026-10-26T00:21:03.000Z');
  });

  it('describes anything thrown, including the values Node prints as nothing', () => {
    expect(describeThrown('')).toBe('(an empty string was thrown)');
    expect(describeThrown(undefined)).toBe('(undefined was thrown)');
    expect(describeThrown({ a: 1 })).toBe('{"a":1}');
    const noStack = Object.assign(new Error('x'), { stack: '', code: 'EIO' });
    expect(describeThrown(noStack)).toBe('Error: x (code EIO)');
  });
});
