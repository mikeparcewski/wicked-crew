// Every child process this daemon shells out to runs through here (FINDING-016).
//
// # The defect
//
// Six `execFileAsync` call sites, none of which set `maxBuffer`. Node's default is 1 MiB: exceed it
// and the child is KILLED and the promise rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. On a
// large repo `wicked-estate blast-radius` produces far more than that, so the endpoint answered
// HTTP 500 — and the 500 said nothing about output size, so it read as "the tool crashed".
//
// The size that breaks it is a property of the REPO, not of the request, which is the worst shape
// for a bug: it works in every test and on every small repo, and fails permanently on exactly the
// large ones the feature exists for.
//
// # Why a helper rather than six `maxBuffer:` arguments
//
// Adding the option at each call site covers exactly the sites someone remembered — the pattern
// this codebase keeps paying for, and the reason `wicked-core`'s spawn seam is a `hardened()`
// method with a workspace-scanning audit test rather than a convention. Same argument, same shape:
// one chokepoint, and a test that fails when a new raw call site appears.
//
// # Why the cap is finite
//
// `Infinity` is a real option and the wrong one: it turns a large repo into an unbounded heap
// allocation in the daemon process. A finite cap with an ACTIONABLE error beats both a 1 MiB
// silent kill and an OOM.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 64 MiB. Chosen to clear the largest `blast-radius` output observed in the corpus by a wide
 *  margin while still bounding the daemon's heap. Raise it deliberately, not reflexively — if a
 *  tool needs more than this, streaming is the answer rather than a bigger buffer. */
export const EXEC_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** A child produced more output than the cap allows.
 *
 *  Distinct from a generic failure ON PURPOSE: "this repo is too big for the current cap" and "the
 *  tool crashed" need different responses from an operator, and collapsing them into one 500 is
 *  the defect FINDING-050 describes in the gate. */
export class ExecOutputTooLarge extends Error {
  constructor(
    readonly file: string,
    readonly limitBytes: number,
  ) {
    super(
      `${file} produced more than ${Math.round(limitBytes / (1024 * 1024))} MiB of output and was ` +
        `stopped. This is a limit of this daemon, not a failure of ${file}; the output size scales ` +
        `with repo size, so a larger repo can hit it where a smaller one does not.`,
    );
    this.name = 'ExecOutputTooLarge';
  }
}

/** Node reports the overflow through `code`, not the message. */
export function isMaxBufferError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

type ExecOpts = { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number };

/** `execFile`, with a bounded output buffer and an overflow that says what it was.
 *
 *  Callers may override `maxBuffer`, but not by forgetting it. */
export async function execCapped(
  file: string,
  args: string[],
  opts: ExecOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(file, args, { maxBuffer: EXEC_MAX_BUFFER_BYTES, ...opts });
  } catch (err) {
    if (isMaxBufferError(err)) {
      throw new ExecOutputTooLarge(file, opts.maxBuffer ?? EXEC_MAX_BUFFER_BYTES);
    }
    throw err;
  }
}
