/**
 * `wicked-crew start` and the stand-in choice (DES-STANDIN-001 §4; coord round 2 F3 on crew#1888).
 *
 * The CLI launches through `POST /runs`, which asks the stand-in question when the roster can't check the job. A
 * person at the CLI answers it with `--stand-ins` (the launch's `standIns: true`: stand-ins for this job). A launch
 * refused with `409 stand_in_choice` prints the engine's words and the exact ways through.
 */

/** `--stand-ins` present AS AN OPTION (never the value of a preceding value-taking option, so `--problem
 *  --stand-ins` stays a problem text). */
export function startStandInsFlag(argv: readonly string[], valueFlags: ReadonlySet<string>): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stand-ins') return true;
    if (valueFlags.has(argv[i]!)) i++;
  }
  return false;
}

/** The line(s) `wicked-crew start` prints when the launch is refused. */
export function startLaunchFailure(status: number, body: unknown, statusText: string): string {
  const b = body !== null && typeof body === 'object' ? body as { code?: unknown; error?: unknown } : {};
  const head = `launch failed (${status}): ${typeof b.error === 'string' && b.error !== '' ? b.error : statusText}`;
  if (status !== 409 || b.code !== 'stand_in_choice') return head;
  return `${head}\n`
    + '  To use stand-ins for this job, run the same command again with --stand-ins.\n'
    + '  To use them for every job, choose "Use stand-ins for every job" in Settings (standInReview: always), then run it again.\n'
    + '  Or add another helper to the job, or run it with --reduced-assurance (the builder may review its own work, labelled).';
}
