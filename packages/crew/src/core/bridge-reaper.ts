/**
 * ACP bridge child reaper — bridges must die with the daemon (crew#285).
 *
 * # The defect
 *
 * The engine spawns ACP bridge binaries as direct OS children of this daemon process,
 * and the only kill handles for them live in the engine's in-memory registry. When the
 * daemon dies — pkill during a restart, an operator's Ctrl-C, a plain `process.exit` —
 * that registry dies with it and nothing reaps the bridges: they linger detached until
 * their own session-idle logic (if any) gets around to exiting. Operators observed
 * three `claude-agent-acp` processes coexisting while exactly one unit was executing.
 *
 * Same defect family as crew#277's cancel-orphans, but for daemon death rather than
 * run cancellation.
 *
 * # The fix, in two halves
 *
 * 1. THIS MODULE (daemon side): a central registry of bridge child pids plus an OS
 *    process-table sweep, wired into the daemon's shutdown path. On SIGTERM/SIGINT the
 *    daemon SIGTERMs every bridge child, waits a short grace for them to exit, then
 *    SIGKILLs survivors. On plain `exit` (where no async work is possible) it fires a
 *    synchronous best-effort SIGTERM sweep.
 *
 *    `register()` exists for any JS-side spawn site (and for tests); the engine-spawned
 *    bridges are found by `discoverBridgeChildren()` — a scan of the OS process table
 *    for DIRECT children of this daemon whose command line names a bridge binary. The
 *    direct-child restriction is the safety rail: another daemon's bridges have a
 *    different parent pid and are never touched.
 *
 * 2. `packages/agent-acp-bridges` (bridge side): the bridge treats stdin EOF as the
 *    portable parent-death signal and reaps its own CLI child instead of lingering
 *    until the CLI finishes. See `bridge.mjs`. That half covers our own bridges even
 *    when the daemon dies too hard (SIGKILL) for this module to run at all.
 *
 * # Why a process-table sweep rather than tracked pids alone
 *
 * The spawn happens inside the engine (the native actor thread), which reports no pid
 * back to JS — there is nothing for the daemon to `register()`. The bridges ARE this
 * process's direct children though, and their command lines name the bridge binaries
 * (npm `.bin` shims exec `node .../<bridge-name>/...`), so a ppid-filtered scan
 * recovers exactly the set the in-memory kill handles would have covered. The sweep
 * fails OPEN (returns nothing) when the platform tooling is unavailable: a shutdown
 * that cannot enumerate children must still shut down.
 */

import { spawnSync } from 'node:child_process';

/**
 * The bridge binaries the engine spawns by bare name on PATH. Mirrors the set audited
 * by `bridge-names.test.ts` (declared dependencies of this package + the shims a real
 * install produces); `bridge-reaper.test.ts` cross-checks this list against those same
 * dependency manifests so a bridge added or dropped there cannot silently drift here.
 */
export const BRIDGE_BINS: readonly string[] = [
  'agy-acp',
  'claude-agent-acp',
  'codex-acp',
  'pi-acp',
];

/** How long a SIGTERM'd bridge gets to exit before the SIGKILL escalation. */
export const BRIDGE_KILL_GRACE_MS = 2000;

/** How often the grace window re-checks survivor liveness. */
const POLL_INTERVAL_MS = 100;

/**
 * One line of a `pid ppid command` process listing → the pids of DIRECT children of
 * `parentPid` whose command line names a bridge binary. Pure, so the parsing is
 * testable without a real process table.
 */
export function parseBridgeChildren(listing: string, parentPid: number): number[] {
  const pids: number[] = [];
  for (const line of listing.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3] as string;
    if (ppid !== parentPid || pid === parentPid) continue;
    // Substring match is enough: within the direct children of THIS daemon, a command
    // line mentioning a bridge binary (bare invocation or a path through the package
    // directory) is a bridge. The ppid filter is what prevents false positives.
    if (BRIDGE_BINS.some((bin) => command.includes(bin))) pids.push(pid);
  }
  return pids;
}

/** `pid ppid command` listing of every process, or null when the platform tooling fails. */
function listProcesses(): string | null {
  try {
    const out =
      process.platform === 'win32'
        ? // wmic is removed on current Windows; CIM via PowerShell is the stable surface.
          spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }",
            ],
            { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          )
        : // POSIX keywords (`args`, not the BSD/procps-specific `command`): same spelling
          // works on macOS and Linux.
          spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
          });
    if (out.error !== undefined || out.status !== 0 || typeof out.stdout !== 'string') return null;
    return out.stdout;
  } catch {
    return null;
  }
}

/**
 * Pids of every live bridge process that is a direct child of `parentPid`. Fails open:
 * an unreadable process table yields `[]`, never a throw — shutdown must proceed.
 */
export function discoverBridgeChildren(parentPid: number = process.pid): number[] {
  const listing = listProcesses();
  return listing === null ? [] : parseBridgeChildren(listing, parentPid);
}

/** Injectable seams so the reaper is testable without signalling real bridges. */
export interface BridgeReaperIo {
  /** Signal sender; must throw like `process.kill` (ESRCH when the pid is gone). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Bridge-child discovery; defaults to the process-table sweep above. */
  discover?: (parentPid: number) => number[];
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What `shutdown()` did, for logs and assertions. */
export interface ReapReport {
  /** Pids that exited within the grace window after SIGTERM. */
  terminated: number[];
  /** Pids that ignored SIGTERM and were SIGKILLed. */
  killed: number[];
}

/**
 * The central bridge-child registry plus the shutdown path that empties it.
 *
 * A single instance (`bridgeReaper`) is wired into the daemon's shutdown handlers;
 * tests construct their own with fake IO.
 */
export class BridgeReaper {
  private readonly tracked = new Set<number>();
  private readonly io: BridgeReaperIo;

  constructor(io: BridgeReaperIo = {}) {
    this.io = io;
  }

  /** Track a bridge child pid. Invalid pids (spawn failures yield `undefined`) are ignored. */
  register(pid: number | undefined): void {
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) this.tracked.add(pid);
  }

  /** Stop tracking a pid — call when the child's `close`/`exit` is observed. */
  unregister(pid: number): void {
    this.tracked.delete(pid);
  }

  /** Currently tracked pids (registered only; discovery happens at kill time). */
  pids(): number[] {
    return [...this.tracked];
  }

  /** Deliver `signal`; true while the pid exists (EPERM = alive but not ours). */
  private signal(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      (this.io.kill ?? process.kill)(pid, signal);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** Registered pids ∪ discovered direct-child bridges, deduplicated. */
  private targets(): number[] {
    const all = new Set<number>(this.tracked);
    for (const pid of (this.io.discover ?? discoverBridgeChildren)(process.pid)) all.add(pid);
    return [...all];
  }

  /**
   * Graceful reap: SIGTERM every target, poll liveness for the grace window, SIGKILL
   * survivors. Idempotent — dead pids are skipped, and the registry is cleared so a
   * second invocation (the `exit` sweep after a signal-path shutdown) finds nothing
   * registered and only re-discovers what actually still lives.
   */
  async shutdown(): Promise<ReapReport> {
    const graceMs = this.io.graceMs ?? BRIDGE_KILL_GRACE_MS;
    const sleep = this.io.sleep ?? defaultSleep;

    const targets = this.targets().filter((pid) => this.signal(pid, 0));
    for (const pid of targets) this.signal(pid, 'SIGTERM');

    const deadline = Date.now() + graceMs;
    let survivors = targets.filter((pid) => this.signal(pid, 0));
    while (survivors.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, graceMs));
      survivors = survivors.filter((pid) => this.signal(pid, 0));
    }

    for (const pid of survivors) this.signal(pid, 'SIGKILL');
    this.tracked.clear();
    return {
      terminated: targets.filter((pid) => !survivors.includes(pid)),
      killed: survivors,
    };
  }

  /**
   * Synchronous best-effort sweep for the `exit` event, where no async work (and so no
   * grace window) is possible. SIGTERM only — a synchronous SIGKILL would deny a bridge
   * the chance to reap ITS child CLI, recreating the orphan problem one level down.
   * The bridges' own stdin-EOF watchdog is the backstop for anything that ignores this.
   */
  sweepSync(): void {
    for (const pid of this.targets()) this.signal(pid, 'SIGTERM');
    this.tracked.clear();
  }
}

/** The daemon-wide reaper the CLI wires into its shutdown handlers. */
export const bridgeReaper = new BridgeReaper();
