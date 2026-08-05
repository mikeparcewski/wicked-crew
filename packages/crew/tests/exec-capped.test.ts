// FINDING-016: six execFileAsync call sites, none setting `maxBuffer`.
//
// Node's default is 1 MiB. Exceed it and the child is KILLED and the promise rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER. `wicked-estate blast-radius` on a large repo produces far
// more than that, so the endpoint answered HTTP 500 — and the 500 said nothing about output size,
// so it read as "the tool crashed".
//
// The size that breaks it is a property of the REPO, not of the request. That is the worst shape a
// bug can have: it passes every test and every small repo, and fails permanently on exactly the
// large ones the feature exists for.
//
// The audit test below is the one that matters long-term. Adding `maxBuffer:` at six call sites
// covers exactly the sites someone remembered; this fails the build when a SEVENTH appears. Same
// argument as wicked-core's spawn_audit, which is the precedent it is modelled on.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEC_MAX_BUFFER_BYTES, ExecOutputTooLarge, execCapped, isMaxBufferError } from '../src/core/exec.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CHOKEPOINT = join(SRC, 'core', 'exec.ts');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('every child process goes through the capped helper (FINDING-016)', () => {
  /// The audit. A new raw call site is a build failure, not a review note.
  it('no source file calls execFileAsync directly except the chokepoint', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => f !== CHOKEPOINT)
      .filter((f) => /\bexecFileAsync\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      'these bypass the output cap — route them through execCapped() in src/core/exec.ts, which ' +
        'is what keeps a large repo from turning into an opaque HTTP 500',
    ).toEqual([]);
  });

  it('caps output well above 1 MiB, the default that caused this', () => {
    expect(EXEC_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024);
  });

  /// A REAL overflow, not a mocked one: node prints more than the cap and the helper must convert
  /// the raw ERR_CHILD_PROCESS_STDIO_MAXBUFFER into something an operator can act on.
  it('turns an overflow into a named, actionable error', async () => {
    await expect(
      execCapped(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], {
        maxBuffer: 1024,
      }),
    ).rejects.toBeInstanceOf(ExecOutputTooLarge);

    // It must say WHAT happened and that the limit is ours, or the operator debugs the wrong tool.
    let message = '';
    try {
      await execCapped(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], {
        maxBuffer: 1024,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/output/i);
    expect(message).toMatch(/limit of this daemon/i);
  });

  /// Output UNDER the cap must be untouched — a fix that broke the ordinary path would be worse
  /// than the defect.
  it('passes ordinary output straight through', async () => {
    const { stdout } = await execCapped(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(stdout).toBe('ok');
  });

  /// A non-overflow failure must NOT be relabelled as an overflow.
  it('does not mistake an ordinary failure for an overflow', async () => {
    let caught: unknown;
    try {
      await execCapped(process.execPath, ['-e', 'process.exit(3)']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ExecOutputTooLarge);
    expect(isMaxBufferError(caught)).toBe(false);
  });
});
