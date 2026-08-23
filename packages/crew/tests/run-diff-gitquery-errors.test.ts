// gitQuery's error taxonomy (CREW-UX-1 review follow-up, Copilot #307): only a git that RAN and
// answered "no" may become `null` (→ the route's 400). Operational failures — a timed-out/killed
// process, an output-cap overflow — must rethrow so they surface as a 500, never a misleading
// "unresolvable base". Exercised through `worktreeDiff` (gitQuery is internal) with `execCapped`
// mocked; the real-git behavior is covered in run-diff-base-route.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execCappedMock = vi.fn();
vi.mock('../src/core/exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/exec.js')>();
  return { ...real, execCapped: (...args: unknown[]) => execCappedMock(...args) };
});

import { ExecOutputTooLarge } from '../src/core/exec.js';
import { worktreeDiff } from '../src/api/run-files.js';

/** Node's execFile error shape for a process that did not run to completion. */
function killedError(signal: string): Error & { killed: boolean; signal: string } {
  return Object.assign(new Error(`Command failed: git rev-parse (killed)`), {
    killed: true,
    signal,
  });
}

/** Node's execFile error shape for git running fine and exiting non-zero. */
function exitError(stderr: string): Error & { killed: boolean; signal: null; code: number } {
  return Object.assign(new Error(`Command failed: git rev-parse\n${stderr}`), {
    killed: false,
    signal: null,
    code: 128,
  });
}

describe('gitQuery operational failures are never a 400 (via worktreeDiff base resolution)', () => {
  beforeEach(() => {
    execCappedMock.mockReset();
  });

  it('a timed-out (killed) git rethrows the exec error instead of UnresolvableDiffBaseError', async () => {
    execCappedMock.mockRejectedValue(killedError('SIGTERM'));
    await expect(worktreeDiff('/tmp/anywhere', undefined, 'main')).rejects.toMatchObject({
      killed: true,
      signal: 'SIGTERM',
    });
  });

  it('an output-cap overflow rethrows ExecOutputTooLarge', async () => {
    execCappedMock.mockRejectedValue(new ExecOutputTooLarge('git', 1024));
    await expect(worktreeDiff('/tmp/anywhere', undefined, 'main')).rejects.toBeInstanceOf(
      ExecOutputTooLarge,
    );
  });

  it("git's own non-zero 'no such ref' still resolves to the named 400 error", async () => {
    execCappedMock.mockRejectedValue(exitError('fatal: bad revision'));
    await expect(worktreeDiff('/tmp/anywhere', undefined, 'main')).rejects.toMatchObject({
      name: 'UnresolvableDiffBaseError',
    });
  });
});
