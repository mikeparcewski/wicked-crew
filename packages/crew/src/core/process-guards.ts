/**
 * crew#1145: the daemon never ends without saying why.
 *
 * On 2026-10-26 a freshly upgraded daemon logged `WICKED_CREW_READY`, then exited about a second
 * later; its log ended with a blank line and `Node.js v26.11.1` — Node's fatal-exception trailer
 * with the error text itself missing. That fingerprint reproduces with a full disk: crew's logger
 * writes to stdout, the launcher points stdout at `daemon-stdout.log`, a write that gets ENOSPC (or
 * EPIPE, when stdout is a pipe whose reader went away) is emitted as an `'error'` on
 * `process.stdout`, and with no listener Node turns it into an uncaught exception, whose own report
 * goes to the same full file and is lost. The host was at 96% used and dipping at the time.
 *
 * So, for the daemon (`wicked-crew serve`) only:
 *
 *  - stdout / stderr `'error'` is HANDLED: the failure is reported once per stream and code
 *    (with the state-home volume's free space), and the daemon keeps serving. `GET /diagnostics`
 *    and the Nerve Center still work; the console log is what is lost.
 *  - `uncaughtException` is reported with its stack, then the process exits 1 (continuing after an
 *    arbitrary throw is not safe).
 *  - `unhandledRejection` is reported with its stack and the daemon keeps serving: a forgotten
 *    `.catch` on a background promise is a defect to fix, not a reason to drop every run's
 *    control plane.
 *  - `exit` always says the code and the recorded reason; with none recorded it adds the stack of
 *    the `exit` call, which names a `process.exit` caller (or shows the loop drained).
 *  - `SIGHUP` (a closed controlling terminal, `kill -HUP`) is reported and the daemon keeps serving.
 *    Node's default for it is to die with no `exit` event, so no reason could ever be written; a
 *    daemon is stopped with SIGTERM. Under `nohup` (how the rig launches it) SIGHUP was already
 *    ignored, so this changes nothing there. SIGKILL cannot be observed by any process.
 *
 * Every report is written SYNCHRONOUSLY to stderr (fd 2) and appended to `<state home>/daemon-exit.log`
 * (the registered `daemon-` prefix of the state-home fence), each write on its own try: when the
 * disk is full one of them may still land, and neither can throw. A stderr that is already known
 * to fail is not written again.
 */

import { appendFileSync, statfsSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The record every guard report is appended to, under the daemon's state home. */
export const EXIT_RECORD_FILENAME = 'daemon-exit.log';

export interface ProcessGuardOptions {
  /** The daemon's state home (where the exit record lives, and whose volume's free space is reported); `null` = unknown. */
  stateHome: () => string | null;
  /** The process to guard (tests hand a stand-in). */
  proc?: NodeJS.Process;
  /** Write one line to stderr synchronously (tests capture it). Default: `writeSync(2, …)`. */
  writeErr?: (line: string) => void;
  /** Append one line to the exit record (tests capture it). Default: `appendFileSync`. */
  appendRecord?: (path: string, line: string) => void;
  /** Free / total bytes of the volume holding `path` (tests stub it). Default: `statfsSync`. */
  freeSpace?: (path: string) => { free: number; total: number };
  /** End the process after a fatal report (tests stub it). Default: `proc.exit`. */
  exit?: (code: number) => void;
  /** Clock for the record's timestamp (tests). */
  now?: () => Date;
}

export interface ProcessGuards {
  /** Record why the process is about to end, for the `exit` line (a signal, a fatal boot error). */
  noteExitReason(reason: string): void;
  /** Report one line now (stderr + the exit record). */
  report(line: string): void;
  /** Remove every listener this installed (tests). */
  uninstall(): void;
}

/** `err` as text with its stack when it has one — never throws, whatever was thrown. */
export function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      const stack = typeof err.stack === 'string' && err.stack.trim() !== '' ? err.stack : `${err.name}: ${err.message}`;
      return code === undefined ? stack : `${stack} (code ${code})`;
    }
    if (typeof err === 'string') return err === '' ? '(an empty string was thrown)' : err;
    if (err === undefined) return '(undefined was thrown)';
    return JSON.stringify(err) ?? String(err);
  } catch {
    return '(the thrown value could not be described)';
  }
}

function defaultFreeSpace(path: string): { free: number; total: number } {
  const s = statfsSync(path);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

function gib(n: number): string {
  return `${Math.round((n / 2 ** 30) * 10) / 10} GiB`;
}

/**
 * Install the guards. Call once, early in `serve`. Answers the handle the shutdown path uses to
 * say why it is exiting.
 */
export function installProcessGuards(opts: ProcessGuardOptions): ProcessGuards {
  const proc = opts.proc ?? process;
  let stderrDead = false;
  const writeErr =
    opts.writeErr ??
    ((line: string): void => {
      writeSync(2, `${line}\n`);
    });
  const appendRecord = opts.appendRecord ?? ((path: string, line: string): void => appendFileSync(path, `${line}\n`));
  const freeSpace = opts.freeSpace ?? defaultFreeSpace;
  const exit = opts.exit ?? ((code: number): void => proc.exit(code));
  const now = opts.now ?? ((): Date => new Date());
  let exitReason: string | null = null;

  const stateHome = (): string | null => {
    try {
      return opts.stateHome();
    } catch {
      return null;
    }
  };

  const report = (line: string): void => {
    if (!stderrDead) {
      try {
        writeErr(line);
      } catch {
        /* stderr refused it; the record below may still land */
      }
    }
    const home = stateHome();
    if (home === null) return;
    try {
      appendRecord(join(home, EXIT_RECORD_FILENAME), `${now().toISOString()} pid=${proc.pid} ${line}`);
    } catch {
      /* the disk may be full: stderr above was the other chance */
    }
  };

  const spaceNote = (): string => {
    const home = stateHome();
    if (home === null) return 'free space unknown (no state home)';
    try {
      const { free, total } = freeSpace(home);
      const used = total > 0 ? Math.round(((total - free) / total) * 100) : 100;
      return `${gib(free)} free on the state-home volume (${home}, ${used}% used)`;
    } catch (err) {
      return `free space on ${home} unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const seen = new Set<string>();
  const onStreamError = (name: 'stdout' | 'stderr') => (err: unknown): void => {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'unknown';
    if (name === 'stderr') stderrDead = true;
    const key = `${name}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    report(
      `[daemon] ${name} write failed (${code}): ${err instanceof Error ? err.message : String(err)} — ` +
        `${spaceNote()}; the daemon keeps serving, its console log on ${name} is lost from here on (crew#1145)`,
    );
  };
  const onStdoutError = onStreamError('stdout');
  const onStderrError = onStreamError('stderr');

  const onUncaught = (err: unknown, origin: string): void => {
    exitReason = `${origin === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception'}: ${err instanceof Error ? err.message : describeThrown(err)}`;
    report(`[daemon] FATAL ${origin}: ${describeThrown(err)} — ${spaceNote()}; exiting 1 (crew#1145)`);
    exit(1);
  };
  const onRejection = (reason: unknown): void => {
    report(`[daemon] unhandled promise rejection (the daemon keeps serving; this is a defect to report): ${describeThrown(reason)} (crew#1145)`);
  };
  const onHangup = (): void => {
    report('[daemon] received SIGHUP (the terminal closed, or kill -HUP): ignored, the daemon keeps serving — stop it with SIGTERM (crew#1145)');
  };
  const onExit = (code: number): void => {
    if (exitReason !== null) {
      report(`[daemon] exiting with code ${code}: ${exitReason}`);
      return;
    }
    // Nothing recorded a reason: a bare `process.exit(n)` somewhere, or the event loop drained.
    // The 'exit' listener runs INSIDE `process.exit`, so this stack names its caller.
    const where = (new Error('exit').stack ?? '').split('\n').slice(2, 10).map((l) => l.trim()).join(' | ');
    report(`[daemon] exiting with code ${code}; no reason was recorded (a process.exit call, or the event loop drained) — at: ${where || 'no stack'} (crew#1145)`);
  };

  proc.stdout.on('error', onStdoutError);
  proc.stderr.on('error', onStderrError);
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  proc.on('exit', onExit);
  proc.on('SIGHUP', onHangup);

  return {
    noteExitReason(reason: string): void {
      exitReason = reason;
    },
    report,
    uninstall(): void {
      proc.stdout.off('error', onStdoutError);
      proc.stderr.off('error', onStderrError);
      proc.off('uncaughtException', onUncaught);
      proc.off('unhandledRejection', onRejection);
      proc.off('exit', onExit);
      proc.off('SIGHUP', onHangup);
    },
  };
}
