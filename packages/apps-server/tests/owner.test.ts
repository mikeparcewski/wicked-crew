// Real processes contend for one temporary data volume; the kernel must release its lock even on SIGKILL.

import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { type Claim, claimDataDir } from '../src/owner.js';
import { FencedActionStore } from '../src/main.js';

interface Result { status: 'held' | 'refused'; error?: string }

describe('the volume claim', () => {
  const dirs: string[] = [];
  const claims: Claim[] = [];
  const children: ChildProcess[] = [];
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    for (const c of claims.splice(0)) c.release();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fresh = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'k6-owner-'));
    dirs.push(d);
    return d;
  };
  const contender = async (dir: string) => {
    const script = join(fresh(), 'claim.mjs');
    // Bundle the real owner implementation so Node children need no TypeScript loader or test runner.
    buildSync({
      stdin: {
        contents: `
          import { claimDataDir } from ${JSON.stringify(fileURLToPath(new URL('../src/owner.ts', import.meta.url)))};
          process.once('message', async () => {
            try {
              const claim = await claimDataDir(process.argv[2]);
              process.on('message', () => { claim.release(); process.disconnect(); });
              process.send({ status: 'held' });
            } catch (error) {
              process.send({ status: 'refused', error: String(error) });
              process.disconnect();
            }
          });
          process.send({ status: 'ready' });
        `,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        sourcefile: 'claim-child.mjs',
      },
      outfile: script,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const child = fork(script, [dir], { execArgv: ['--disable-warning=ExperimentalWarning'], silent: true });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const nextMessage = (): Promise<unknown> => new Promise((resolve, reject) => {
      const cleanup = (): void => {
        child.off('message', message);
        child.off('exit', exit);
        child.off('error', error);
      };
      const message = (value: unknown): void => { cleanup(); resolve(value); };
      const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`claim child exited (${code ?? signal}): ${stderr}`));
      };
      const error = (err: Error): void => { cleanup(); reject(err); };
      child.once('message', message);
      child.once('exit', exit);
      child.once('error', error);
    });
    expect(await nextMessage()).toEqual({ status: 'ready' });
    return {
      child,
      start: async (): Promise<Result> => {
        const result = nextMessage();
        child.send('start');
        return await result as Result;
      },
    };
  };

  it('refuses a second process, naming the owner, then allows an immediate restart after SIGKILL', async () => {
    const dir = fresh();
    const first = await contender(dir);
    expect(await first.start()).toEqual({ status: 'held' });
    const second = await contender(dir);
    const refused = await second.start();
    expect(refused.status).toBe('refused');
    expect(refused.error).toContain(`another wicked-apps-server owns ${dir} (`);
    expect(refused.error).toContain('): one server per app with actions; stop the other first');

    const exited = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
    // No advancing timestamps or waiting out a stale window: start as soon as the kernel reports death.
    const restarted = await contender(dir);
    expect(await restarted.start()).toEqual({ status: 'held' });
  });

  it('of two processes racing to start exactly one wins', async () => {
    const dir = fresh();
    const racers = await Promise.all([contender(dir), contender(dir)]);
    const results = await Promise.all(racers.map((racer) => racer.start()));
    expect(results.filter((r) => r.status === 'held')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error).toMatch(/another wicked-apps-server owns/);
  });

  it('a graceful release lets another process start immediately', async () => {
    const dir = fresh();
    const first = await contender(dir);
    expect(await first.start()).toEqual({ status: 'held' });
    const exited = once(first.child, 'exit');
    first.child.send('release');
    expect(await exited).toEqual([0, null]);
    const next = await contender(dir);
    expect(await next.start()).toEqual({ status: 'held' });
  });

  it.each(['deleted', 'replaced'])('a %s lock file fences its owner immediately', async (change) => {
    const dir = fresh();
    const claim = await claimDataDir(dir);
    claims.push(claim);
    expect(claim.held()).toBe(true);
    const file = join(dir, 'apps-actions.json');
    writeFileSync(file, JSON.stringify({ version: 1, grants: {}, records: {} }));
    const store = new FencedActionStore(file, () => claim.held());
    await store.locked(() => undefined);
    const before = readFileSync(file, 'utf8');
    const lock = join(dir, '.owner.lock');
    if (change === 'deleted') rmSync(lock, { force: true });
    else {
      const replacement = join(dir, 'replacement');
      writeFileSync(replacement, 'replacement');
      renameSync(replacement, lock);
    }
    expect(claim.held()).toBe(false);
    let ran = false;
    await expect(store.locked(() => { ran = true; })).rejects.toMatchObject({ code: 'actions_off', status: 409 });
    expect(ran).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    claim.release();
    claim.release();
    expect(claim.held()).toBe(false);
    if (change === 'replaced') expect(readFileSync(lock, 'utf8')).toBe('replacement');
  });

  it('release is idempotent and leaves the claim unheld', async () => {
    const claim = await claimDataDir(fresh());
    claims.push(claim);
    claim.release();
    claim.release();
    expect(claim.held()).toBe(false);
  });
});
