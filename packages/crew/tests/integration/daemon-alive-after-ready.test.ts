// crew#1145 (PRODUCT-WORKS J1): the operator's daemon logged WICKED_CREW_READY and then vanished
// about a second later with no error text. Through the REAL dist CLI:
//
//  A. the daemon is still alive 5 s after ready, answers /health, and a SIGTERM exit is recorded
//     with its reason in `<state home>/daemon-exit.log`;
//  B. the reader of its stdout goes away (EPIPE — the pipe twin of the ENOSPC that killed it on a
//     full disk): the daemon says so on stderr and keeps serving, still alive 5 s later.
//
// Runs only when dist is built (CI builds before test; locally `npm run build -w packages/crew`).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { baseSkillOff } from '../setup/base-skill-off.js';
import { removeScratch } from '../setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'dist', 'cli', 'index.js');
const BOOT_TIMEOUT_MS = 90_000;
const ALIVE_AFTER_READY_MS = 5_000;

interface Daemon {
  proc: ChildProcess;
  port: number;
  stderr: () => string;
  stop: () => Promise<number | null>;
}

async function bootDaemon(dir: string): Promise<Daemon> {
  baseSkillOff();
  const proc = spawn(process.execPath, [CLI, 'serve', '--stub', '--port', '0', '--db', join(dir, 'core.db')], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (c: string) => {
    stderr += c;
  });
  const port = await new Promise<number>((resolveReady, reject) => {
    const timer = setTimeout(() => done(new Error(`no ready line in ${BOOT_TIMEOUT_MS}ms\n${stderr}`)), BOOT_TIMEOUT_MS);
    const onData = (chunk: string): void => {
      stdout += chunk;
      const line = stdout.split('\n').find((l) => l.startsWith('WICKED_CREW_READY '));
      if (line !== undefined) done(null, (JSON.parse(line.slice('WICKED_CREW_READY '.length)) as { port: number }).port);
    };
    const onExit = (code: number | null): void => done(new Error(`daemon exited (${code}) before ready\n${stderr}`));
    function done(err: Error | null, p?: number): void {
      clearTimeout(timer);
      proc.stdout!.off('data', onData);
      proc.off('exit', onExit);
      if (err !== null) {
        if (proc.exitCode === null) proc.kill('SIGKILL');
        reject(err);
      } else resolveReady(p as number);
    }
    proc.stdout!.on('data', onData);
    proc.on('exit', onExit);
  });
  return {
    proc,
    port,
    stderr: () => stderr,
    stop: () =>
      new Promise<number | null>((done) => {
        if (proc.exitCode !== null) return done(proc.exitCode);
        proc.once('exit', (code) => done(code));
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 10_000).unref();
      }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.runIf(existsSync(CLI))('the daemon stays up after ready (crew#1145)', () => {
  let dir: string | undefined;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (dir !== undefined) removeScratch(dir);
    dir = undefined;
  });

  it('A. alive and serving 5 s after ready; a SIGTERM exit is recorded with its reason', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-alive-'));
    daemon = await bootDaemon(dir);
    await sleep(ALIVE_AFTER_READY_MS);
    expect(daemon.proc.exitCode, daemon.stderr()).toBeNull();
    expect(daemon.proc.signalCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`);
    expect(health.status).toBe(200);
    const code = await daemon.stop();
    expect(code).toBe(0);
    const record = readFileSync(join(dir, 'daemon-exit.log'), 'utf8');
    expect(record).toMatch(/\[daemon\] exiting with code 0: received SIGTERM at /);
  }, BOOT_TIMEOUT_MS + 30_000);

  it('B. stdout breaks after ready (EPIPE): one stderr line says so, and the daemon keeps serving', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-alive-epipe-'));
    daemon = await bootDaemon(dir);
    daemon.proc.stdout!.destroy(); // the reader of the daemon's log goes away
    // Each request writes pino lines to the broken stdout.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`);
      expect(res.status).toBe(200);
      await sleep(100);
    }
    await sleep(ALIVE_AFTER_READY_MS);
    expect(daemon.proc.exitCode, daemon.stderr()).toBeNull();
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`)).status).toBe(200);
    expect(daemon.stderr()).toMatch(/\[daemon\] stdout write failed \(EPIPE\)/);
  }, BOOT_TIMEOUT_MS + 30_000);
});
