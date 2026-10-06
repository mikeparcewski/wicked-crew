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
 * A third concern joined in crew#340: `kill -9` on a BRIDGE reparents its in-flight
 * worker CLI (`claude`, `codex`, …) to init — invisible to both halves above — and the
 * orphan keeps the engine-minted shared worker config home busy, wedging subsequent
 * `session/new` handshakes until the daemon restarts. The orphan sweeps below (one at
 * boot, one periodic while the daemon lives) reap those under a conservative triple
 * gate: ppid == 1, a token-boundary command match, and a cwd inside a run worktree.
 *
 * A fourth joined with F-W1-103 (FIX-IT-ALL wave 1): the INTERACTIVE document bridge the pool
 * spawns per docs root (`npx wicked-interactive serve --root …`, `interactive/bridge-pool.ts`,
 * detached and unref'd) was outside every sweep — it is not a `*-acp` binary, and its server is
 * this daemon's GRANDCHILD (an `npm exec` wrapper is the child) — so it outlived every daemon that
 * started it: two such pairs were found ~20 h after their daemon had exited, on ports nothing
 * would ever look up again. Now (1) the shutdown sweep reaps the wrapper AND its server child
 * (npm does not forward a signal to it), and (2) both orphan sweeps reap a ppid-1 interactive tree
 * whose docs root carries crew's own sidecar (`.wi-serve.crew.json`) naming one of its pids with
 * an owning daemon that is gone. Adopting a bridge stamps the adopter as its owner, so a bridge in
 * use by a LIVE daemon — spawner or adopter — is never matched; a bridge nobody recorded (an
 * operator's own `serve`) is never matched either. Crew-spawned bridges therefore live exactly as
 * long as a crew daemon owns them: adopt-or-kill, never leak.
 *
 * A fifth (crew#806): the orphan sweeps probed each candidate's cwd with a SYNCHRONOUS per-pid
 * `lsof` inside a timer callback, with no timeout. On a loaded macOS host one `lsof -p <pid>` of a
 * crashpad handler took over 80 s, and the candidate set included processes that are not ours at
 * all (`Claude.app`, its crashpad handlers, ChatGPT's "Codex Framework", the `codex app-server
 * daemon`) — five such probes per 30 s tick, so the tick never finished before the next was due and
 * the event loop starved: `/health` never answered, a fresh daemon never reached `listen`, SIGTERM
 * was not honoured (the handler cannot run inside `spawnSync`). Now the sweeps are ASYNC, the cwd of
 * every candidate is read with ONE batched `lsof` (`/proc` on Linux) under a hard timeout that
 * SIGKILLs the probe, a tick whose predecessor is still in flight is skipped, a probe that fails or
 * times out reads as "cwd unknown → do not reap", the boot sweep no longer blocks the boot, and the
 * candidate match is narrowed to the PROGRAM region of a command line (before its first `-flag`
 * token, quote-aware), is case-sensitive on POSIX, and a pid is re-checked against a fresh
 * listing after the probe's await (a recycled pid is nobody's orphan) — a path segment deep in a
 * `--database=…/Claude/…` flag, or `/Applications/Claude.app/Contents/MacOS/Claude`, is not a
 * worker CLI.
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

import { execFile, spawnSync } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  ownerAlive,
  readCrewSidecar,
  readLock,
  sidecarNamesBridge,
  type CrewSidecar,
  type LiveBridge,
} from '../interactive/bridge-pool.js';
import { childEnvWithBootEstateDb } from './governance-store.js';

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

/**
 * The worker CLIs those bridges spawn as their OWN children — grandchildren of the daemon.
 *
 * `kill -9` on a bridge (crew#340) orphans its in-flight CLI child to init, where the
 * ppid-filtered direct-child sweep can never see it. The orphan keeps running under the
 * engine-minted shared worker config home (`~/.wicked-worker/<cli>`), which subsequent
 * `session/new` handshakes contend on — the evidenced "ACP wedged until daemon restart"
 * failure. These tokens identify exactly those orphans under the SAME conservative triple
 * gate as orphaned bridges: ppid == 1, a token-boundary command match, AND a cwd inside an
 * engine run worktree — an operator's own `claude`/`codex` never runs from one of those.
 */
export const WORKER_CLI_BINS: readonly string[] = ['agy', 'claude', 'codex', 'pi', 'wicked-pi'];
// `wicked-pi` is the launcher pi-acp starts as pi (F-079; `PI_ACP_PI_COMMAND`) — a grandchild that
// sits BETWEEN the bridge and pi. Through the npm shim it runs as `node …/wicked-pi.mjs …`, so
// the token matcher below also accepts a `.mjs` launcher extension.

/**
 * The interactive document bridge the pool spawns per docs root (F-W1-103): `npx --yes
 * wicked-interactive@<spec> serve --root <root>`, detached. It runs as an `npm exec` WRAPPER whose
 * child is the `node …/wicked-interactive serve --root <root>` that holds the port — the wrapper is
 * this daemon's child, the server its grandchild, and SIGTERM to the wrapper alone leaves the
 * server running (npm does not forward it). Every matcher below treats the pair as one tree.
 */
export const INTERACTIVE_BIN = 'wicked-interactive';

/** How long a SIGTERM'd bridge gets to exit before the SIGKILL escalation. */
export const BRIDGE_KILL_GRACE_MS = 2000;

/** How often the grace window re-checks survivor liveness. */
const POLL_INTERVAL_MS = 100;

/**
 * Matches `bin` as a whole command token, never a substring: start/whitespace/path-sep/
 * quote before; an optional launcher extension (.cmd/.exe/.bat on Windows; .mjs for the
 * node-run `wicked-pi` launcher) and then
 * end/whitespace/path-sep/quote after — so `pi-acp`, `/x/pi-acp`, `"C:\\x\\pi-acp.cmd"`
 * all match while `api-acp` and `copy-of-pi-acp-backup` never do.
 */
function bridgeTokenRe(bin: string): RegExp {
  const esc = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Case-insensitive only where the filesystem is (Windows launchers): on POSIX the CLIs are
  // installed in lower case, and `…/Claude.app/Contents/MacOS/Claude` is a desktop app (crew#806).
  return new RegExp(`(?:^|[\\s/\\\\"'])${esc}(?:\\.(?:cmd|exe|bat|mjs))?(?:[\\s/\\\\"']|$)`, TOKEN_FLAGS);
}

/** Regex flags of every token matcher: `i` on Windows (case-insensitive launchers), none elsewhere. */
const TOKEN_FLAGS = process.platform === 'win32' ? 'i' : '';

/**
 * The PROGRAM region of a command line — everything before its first `-flag` token (the whole
 * line when there is none). The orphan matchers test this region alone (crew#806): an
 * engine-spawned bridge or worker CLI names its binary THERE (`/x/.bin/claude-agent-acp`,
 * `node …/wicked-pi.mjs --mode rpc`, `claude -p …`, `sh /x/.bin/pi-acp`, a quoted Windows `.cmd`,
 * and a path with spaces — POSIX `ps` prints argv unquoted, so no split on whitespace), while
 * `chrome_crashpad_handler --database=/…/Claude/Crashpad` names ours only inside a flag of a process
 * that is nobody's worker. A node option before the script (`node --inspect …/claude`) ends the
 * region early; the engine spawns its bridges and workers with none.
 */
export function programRegionOf(command: string): string {
  // Quote-aware (codex r2 on crew#806): a ` -` inside a quoted executable (`"/x/My - Project/claude"`)
  // is part of the path, not the first flag.
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    // A quote opens only at a token start (codex r3): POSIX `ps` prints argv unquoted, so the
    // apostrophe in `/home/op/John's/bin/helper` is a character, not a quote.
    if ((ch === '"' || ch === "'") && (i === 0 || /\s/.test(command[i - 1] as string))) {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) && command[i + 1] === '-') return command.slice(0, i).trimEnd();
  }
  return command.trimEnd();
}

/** Precompiled per-bin matchers — the scan loops run one test per line, no per-line RegExp churn. */
const BRIDGE_TOKEN_RES: readonly RegExp[] = BRIDGE_BINS.map((bin) => bridgeTokenRe(bin));

/** Bridges ∪ worker CLIs — the full set of engine-descended run processes the ORPHAN sweeps
 *  match. The direct-child shutdown sweep stays bridges-only: worker CLIs are grandchildren
 *  by construction, and a `claude` that IS our direct child is the operator's own business. */
const ORPHAN_TOKEN_RES: readonly RegExp[] = [...BRIDGE_BINS, ...WORKER_CLI_BINS].map((bin) =>
  bridgeTokenRe(bin),
);

/**
 * `wicked-interactive` as a whole token — the npx spec spelling (`wicked-interactive@^0.9.3`), the
 * npm shim (`…/.bin/wicked-interactive`), a Windows launcher (`wicked-interactive.cmd`) and the
 * package path (`…/wicked-interactive/dist/cli.js`) all count, `wicked-interactive-export` never
 * does — followed IMMEDIATELY by the `serve` subcommand (interactive's options come after the
 * subcommand: `serve --root <dir> [--port N]`). `render --mode serve` is not a bridge, and neither
 * is anything with another token between the bin and `serve` — review NIT on crew #606: the
 * shutdown path has no sidecar gate, so the subcommand must be the anchor.
 */
const INTERACTIVE_SERVE_RE = new RegExp(
  `(?:^|[\\s/\\\\"'])${INTERACTIVE_BIN}(?:@[^\\s"'/\\\\]*)?(?:\\.(?:cmd|exe|bat|mjs|js))?(?:[/\\\\][^\\s"']*)?["']?\\s+serve(?:\\s|$)`,
  'i',
);

/** Is `command` an interactive bridge `serve` — the npm wrapper or the server itself? */
export function isInteractiveServe(command: string): boolean {
  return INTERACTIVE_SERVE_RE.test(command);
}

/**
 * The `--root <path>` of an interactive `serve` command line, or null when absent or not absolute.
 * A quoted value is unquoted; an unquoted one runs to the next `--flag` or the end of the line, so a
 * root with a space in it survives and the blanks `ps` pads a line with are dropped.
 */
export function rootArgOf(command: string): string | null {
  const m = /(?:^|\s)--root(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s+--[a-z]|\s*$)/i.exec(command);
  if (m === null) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return raw !== '' && isAbsolute(raw) ? raw : null;
}

/** One `pid ppid command` row of a process listing. */
interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** The parseable rows of a `pid ppid command` listing; garbage lines a real `ps` never quite spares us are skipped. */
function parseListing(listing: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of listing.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] as string });
  }
  return rows;
}

/**
 * A `pid ppid command` process listing → the pids of the DIRECT children of `parentPid` whose
 * command line names a bridge binary or an interactive `serve`, plus the `serve` children of those
 * interactive wrappers (this daemon's grandchildren, F-W1-103). Pure, so the parsing is testable
 * without a real process table.
 */
export function parseBridgeChildren(listing: string, parentPid: number): number[] {
  const rows = parseListing(listing);
  const pids: number[] = [];
  const wrappers: number[] = [];
  for (const { pid, ppid, command } of rows) {
    if (ppid !== parentPid || pid === parentPid) continue;
    // Token-boundary match: `pi-acp` must not match inside `api-acp` (Copilot review
    // on #300 post-merge). A bridge binary appears as its own token — start-of-line,
    // whitespace, or a path separator before it; end-of-token after.
    if (BRIDGE_TOKEN_RES.some((re) => re.test(command))) pids.push(pid);
    else if (isInteractiveServe(command)) {
      pids.push(pid);
      wrappers.push(pid);
    }
  }
  // The interactive server is the npm wrapper's child — this daemon's GRANDCHILD — and a SIGTERM
  // to the wrapper alone orphans it (F-W1-103). The pair is one tree; reap both.
  for (const { pid, ppid, command } of rows) {
    if (wrappers.includes(ppid) && pid !== parentPid && !pids.includes(pid) && isInteractiveServe(command)) pids.push(pid);
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
            {
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 16 * 1024 * 1024,
              // Bounded like the POSIX listing (crew#806); CIM is slower than `ps`, so four caps.
              timeout: PROBE_TIMEOUT_MS * 4,
              killSignal: 'SIGKILL',
              env: childEnvWithBootEstateDb(),
            },
          )
        : // POSIX keywords (`args`, not the BSD/procps-specific `command`): same spelling
          // works on macOS and Linux. Bounded (crew#806): this sync listing serves the `exit`
          // sweep, which has no async option — a `ps` that hangs must not hang the exit.
          spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: PROBE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            env: childEnvWithBootEstateDb(),
          });
    if (out.error !== undefined || out.status !== 0 || typeof out.stdout !== 'string') return null;
    return out.stdout;
  } catch {
    return null;
  }
}

/** Hard ceiling on any one process probe (`ps`, `lsof`) the sweeps run (crew#806). A probe past it
 *  is SIGKILLed and reads as "unknown" — the sweeps fail open on it (nothing is reaped on a guess). */
export const PROBE_TIMEOUT_MS = 5_000;

/** Run a probe off the event loop: its stdout on success, `null` when it failed, was signalled
 *  (our SIGKILL at {@link PROBE_TIMEOUT_MS}, or anyone else's) or could not start. `lsof` exits 1
 *  when one of the pids has already gone and still prints the rest, so with `okOnNonZero` a plain
 *  non-zero EXIT STATUS with output is output — a signal never is (codex on crew#806: a probe cut
 *  short by a signal has partial output, and partial output must not license a kill). */
function probe(file: string, args: string[], okOnNonZero: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: childEnvWithBootEstateDb(),
        },
        (err, stdout) => {
          if (err !== null) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number | null };
            const exitedNonZero = e.killed !== true && (e.signal === null || e.signal === undefined) && typeof e.code === 'number';
            if (!(okOnNonZero && exitedNonZero)) return resolve(null);
          }
          resolve(typeof stdout === 'string' ? stdout : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** The async `pid ppid command` listing the orphan sweeps use — never on the event loop (crew#806). */
async function listProcessesAsync(): Promise<string | null> {
  if (process.platform === 'win32') return listProcesses();
  return probe('ps', ['-A', '-o', 'pid=,ppid=,args='], false);
}

/**
 * Pids of every live bridge process that is a direct child of `parentPid`. Fails open:
 * an unreadable process table yields `[]`, never a throw — shutdown must proceed.
 */
export function discoverBridgeChildren(parentPid: number = process.pid): number[] {
  const listing = listProcesses();
  return listing === null ? [] : parseBridgeChildren(listing, parentPid);
}

/**
 * Pids of engine-descended run processes ORPHANED to init (ppid 1): bridges left behind
 * by a previous daemon generation (#285), AND worker CLIs left behind by a bridge that
 * died too hard to reap its own child — `kill -9` on the bridge reparents its in-flight
 * `claude`/`codex`/… to init, where it clings to the shared worker config home until
 * something reaps it (crew#340). Deliberately conservative — a process owned by another
 * LIVE daemon (or bridge) still has that parent and is never matched, so neither the boot
 * sweep nor the periodic sweep can shoot a neighbour's workers (#285, Copilot review:
 * shutdown-only reaping leaves pre-existing orphans alive forever).
 */
export function parseOrphanedRunProcesses(listing: string): number[] {
  const pids: number[] = [];
  for (const { pid, ppid, command } of parseListing(listing)) {
    // Never this daemon's OWN children (codex r2 on crew#806): a daemon running as pid 1 (a
    // container's init) sees every child of its own with ppid 1 — those are the shutdown reaper's
    // business, never an orphan's.
    if (ppid !== 1 || pid === process.pid || ppid === process.pid) continue;
    // The PROGRAM region only (crew#806): a desktop app whose crash handler names `Claude` inside
    // a `--database=` flag is not a candidate, so it is never probed.
    const program = programRegionOf(command);
    if (ORPHAN_TOKEN_RES.some((re) => re.test(program))) pids.push(pid);
  }
  return pids;
}

/** An interactive bridge tree reparented to init: the docs root its command line names and the
 *  pids to reap — the ppid-1 process first (the npm wrapper, or the server itself once its wrapper
 *  is gone), then any `serve` child of it. */
export interface OrphanedInteractiveBridge {
  root: string;
  pids: number[];
}

/**
 * Every interactive bridge tree whose parent is init (F-W1-103): a ppid-1 `wicked-interactive …
 * serve --root <root>` plus its own `serve` children. Pure — the OWNERSHIP gate (crew's sidecar in
 * `root` naming one of these pids, with an owner daemon that is gone) is applied by the sweeps,
 * so a shell-parented or nohup'd operator bridge is parsed here but never reaped there.
 */
export function parseOrphanedInteractiveBridges(listing: string): OrphanedInteractiveBridge[] {
  const rows = parseListing(listing);
  const trees: OrphanedInteractiveBridge[] = [];
  for (const { pid, ppid, command } of rows) {
    if (ppid !== 1 || pid === process.pid || !isInteractiveServe(command)) continue;
    const root = rootArgOf(command);
    if (root === null) continue;
    const pids = [pid];
    for (const child of rows) {
      if (child.ppid === pid && child.pid !== process.pid && isInteractiveServe(child.command)) pids.push(child.pid);
    }
    trees.push({ root, pids });
  }
  return trees;
}

/**
 * The ownership gate for an orphaned interactive tree, mirroring the pool's own adopt-or-recycle
 * rules (`interactive/bridge-pool.ts`, codex on crew#506): crew's `.wi-serve.crew.json` in the root
 * the command line names must record one of the tree's pids — the proof crew spawned it; an
 * operator's `wicked-interactive serve` has no sidecar and is never matched — and the daemon it
 * records as owner must be GONE: not in the process table, or a DIFFERENT incarnation of that pid
 * (`ownerStartedAt` no longer matches — a recycled pid must not keep a bridge alive for weeks). A
 * live owner (the spawner, or a daemon that adopted the bridge and stamped itself) is using it; a
 * sidecar without an owner is of unproven ownership and left alone.
 *
 * A recorded pid is not a recorded BRIDGE (crew#510, codex review): the sidecar must also be about
 * the bridge whose lockfile is live in that root — `sidecarNamesBridge`, the same judgement the
 * pool's adopt path makes. Without it a record left by crew's own bridge that died licensed a kill
 * of whatever process later inherited its pid under that root (an operator's
 * `wicked-interactive serve`, another daemon's pool), which is the one rule this gate exists to
 * hold. A root whose lockfile is gone or names another pid keeps today's behaviour: the pid is
 * judged on the record alone, because there is no live bridge to compare it with.
 */
function orphanedInteractiveTargets(listing: string, io: BridgeReaperIo): number[] {
  const sidecarOf = io.sidecar ?? readCrewSidecar;
  const lockOf = io.lock ?? readLock;
  const isOwnerAlive = io.ownerAlive ?? ownerAlive;
  const targets: number[] = [];
  for (const { root, pids } of parseOrphanedInteractiveBridges(listing)) {
    const sidecar = sidecarOf(root);
    if (sidecar === null || !pids.includes(sidecar.pid)) continue;
    const live = lockOf(root);
    // The live bridge on that pid is a DIFFERENT instance than the one crew recorded: the record
    // is stale and licenses nothing.
    if (live !== null && live.pid === sidecar.pid && sidecarNamesBridge(sidecar, live) !== 'names-it') continue;
    const owner = sidecar.ownerPid;
    if (owner === undefined || !Number.isInteger(owner) || owner <= 0) continue; // unproven ownership: not ours to kill
    if (isOwnerAlive(sidecar)) continue; // the same daemon incarnation still owns it
    targets.push(...pids);
  }
  return targets;
}

/** The cwd contract of every engine-spawned bridge and worker CLI: a run worktree. */
export function inRunWorktree(cwd: string | undefined): boolean {
  return cwd !== undefined && cwd.includes('wicked-worktrees');
}

/**
 * The working directory of each of `pids` that has a readable one — ONE batched read for the whole
 * candidate set (crew#806): `/proc/<pid>/cwd` on Linux, a single `lsof -a -d cwd -p <p1,p2,…> -Fpn -w`
 * elsewhere on POSIX (the same shape `api/run-liveness.ts` reads), bounded by {@link PROBE_TIMEOUT_MS}
 * and SIGKILLed past it. A pid the probe could not answer for is simply absent — the sweeps treat
 * absence as "cwd unknown → do not reap". Windows has no reading (an empty map): never kill on
 * uncertainty. A user's own nohup'd `*-acp` also reparents to init but runs from an arbitrary cwd,
 * so the cwd is the discriminator that keeps the sweeps from shooting it (Copilot review on #300).
 */
export async function probeCwds(pids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0 || process.platform === 'win32') return out;
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // gone, or not ours to read
        }
      }),
    );
    return out;
  }
  const text = await probe('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn', '-w'], true);
  if (text === null) return out;
  let pid: number | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) out.set(pid, line.slice(1));
  }
  return out;
}

/** `value` settled within `ms`, else a rejection — the timer never holds the process open. */
function withDeadline<T>(value: T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process probe did not settle within ${ms} ms`)), ms);
    timer.unref?.();
    Promise.resolve(value).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Every orphan this sweep may signal — run processes (ppid 1, program-region token, cwd inside a run
 * worktree) and crew-recorded interactive trees (ppid 1, sidecar names the pid, owner gone) — judged
 * on ONE listing, then CONFIRMED against a fresh listing after the cwd probe's await (codex r2/r3 on
 * crew#806): the await is a window in which an orphan can exit and its pid be reused, and a
 * recycled pid is nobody's orphan. A target is confirmed when the fresh listing shows the same pid
 * with the same command line and the same parent. Both arms go through the re-check, so an
 * interactive wrapper that died during the probe is never signalled by its pid's new owner.
 */
async function orphanTargets(listing: string, io: BridgeReaperIo): Promise<number[]> {
  const runCandidates = parseOrphanedRunProcesses(listing);
  const interactive = orphanedInteractiveTargets(listing, io);
  if (runCandidates.length === 0 && interactive.length === 0) return [];
  let inWorktree: number[] = [];
  if (runCandidates.length > 0) {
    try {
      // The default reader is bounded by its own probe timeout; the race bounds an injected one
      // too, so the sweep's in-flight guard can never be held open by a read that does not settle.
      const cwds = await withDeadline((io.cwds ?? probeCwds)(runCandidates), PROBE_TIMEOUT_MS + 1_000);
      inWorktree = runCandidates.filter((pid) => inRunWorktree(cwds.get(pid)));
    } catch {
      inWorktree = []; // a probe that failed or timed out answers nothing — never kill on uncertainty
    }
  }
  const targets = [...new Set([...inWorktree, ...interactive])];
  if (targets.length === 0) return [];
  const again = await (io.list ?? listProcessesAsync)();
  if (again === null) return []; // cannot confirm → do not reap
  // Same pid, same command line, same parent as when it was judged: a run orphan keeps ppid 1, an
  // interactive server keeps its (orphaned) wrapper as parent — a recycled pid matches neither.
  const before = new Map(parseListing(listing).map((r) => [r.pid, r]));
  const now = new Map(parseListing(again).map((r) => [r.pid, r]));
  return targets.filter((pid) => {
    const was = before.get(pid);
    const row = now.get(pid);
    return was !== undefined && row !== undefined && row.ppid === was.ppid && row.command === was.command;
  });
}

/**
 * Boot-time sweep: SIGTERM orphaned bridges from a prior daemon generation AND orphaned
 * worker CLIs from any bridge that died too hard to reap them — ppid 1 AND cwd inside a
 * run worktree, so user-started processes are never matched — AND crew-spawned interactive
 * bridge trees whose owning daemon is gone (ppid 1 AND crew's sidecar names them, F-W1-103).
 */
export async function reapOrphansAtBoot(io: BridgeReaperIo = {}): Promise<number[]> {
  const listing = await (io.list ?? listProcessesAsync)();
  if (listing === null) return [];
  const orphans = await orphanTargets(listing, io);
  const reaped: number[] = [];
  for (const pid of orphans) {
    try {
      (io.kill ?? process.kill)(pid, 'SIGTERM');
      reaped.push(pid);
    } catch {
      // ESRCH (already gone) / EPERM (not ours): skip silently — fail open.
    }
  }
  return reaped;
}

// ── Periodic orphan sweep (crew#340) ─────────────────────────────────────────────
//
// The boot sweep only helps the NEXT daemon generation. The crew#340 wedge happens while
// this daemon lives: `kill -9` on a bridge mid-run orphans its worker CLI immediately, and
// that orphan keeps the engine-minted shared worker config home busy — the next
// `session/new` contends on it until something reaps the orphan or the daemon restarts.
// So the daemon keeps sweeping, on an unref'd timer, with the SAME conservative triple
// gate as the boot sweep (ppid 1 + token match + cwd inside a run worktree) — and, for
// interactive bridge trees, the same sidecar gate (ppid 1 + crew's sidecar names the pid +
// its owning daemon is gone), so a sibling daemon that dies hard cannot leak its bridges past
// the next tick either (F-W1-103).

/** How often the live daemon re-scans for orphaned run processes. */
export const ORPHAN_SWEEP_DEFAULT_MS = 30_000;

/** The sweep interval: `WICKED_CREW_ORPHAN_SWEEP_SECS` (0 disables), else 30s. */
export function orphanSweepMs(raw: string | undefined = process.env['WICKED_CREW_ORPHAN_SWEEP_SECS']): number {
  if (raw === undefined || raw === '') return ORPHAN_SWEEP_DEFAULT_MS;
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 0) return ORPHAN_SWEEP_DEFAULT_MS;
  return secs * 1000;
}

/**
 * One sweep tick. `pendingKill` carries the pids SIGTERMed on a previous tick: one that is
 * STILL in the table now ignored its SIGTERM for a whole interval and gets SIGKILL — the
 * same escalation `shutdown()` runs, at sweep-interval granularity. Exported for tests.
 */
export async function sweepOrphanedRunProcesses(
  pendingKill: Set<number>,
  io: BridgeReaperIo = {},
): Promise<{ terminated: number[]; killed: number[] }> {
  const listing = await (io.list ?? listProcessesAsync)();
  if (listing === null) return { terminated: [], killed: [] };
  const alive = new Set(await orphanTargets(listing, io));
  const kill = io.kill ?? process.kill;
  const terminated: number[] = [];
  const killed: number[] = [];
  for (const pid of [...pendingKill]) {
    pendingKill.delete(pid); // one escalation per pid — never a SIGKILL loop
    if (!alive.has(pid)) continue; // exited during the grace interval
    alive.delete(pid); // never SIGTERM what was just SIGKILLed
    try {
      kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // ESRCH / EPERM: fail open.
    }
  }
  for (const pid of alive) {
    try {
      kill(pid, 'SIGTERM');
      terminated.push(pid);
      pendingKill.add(pid);
    } catch {
      // ESRCH / EPERM: fail open.
    }
  }
  return { terminated, killed };
}

/**
 * Start the periodic orphan sweep. Returns a stop function. The timer is unref'd — it
 * must never hold an exiting daemon open — and each reap is logged LOUDLY with the pids
 * and the issue that motivated it, so an operator can connect a recovered wedge to what
 * was reaped.
 */
export function startOrphanSweep(intervalMs: number = orphanSweepMs(), io: BridgeReaperIo = {}): () => void {
  if (intervalMs <= 0) return () => {};
  const pendingKill = new Set<number>();
  let inFlight = false;
  let stopped = false;
  const timer = setInterval(() => {
    // One sweep at a time (crew#806): a tick whose predecessor is still probing is skipped, so a
    // slow host can never stack sweeps — the stall-watchdog's own rule.
    if (inFlight) {
      console.warn('[bridge-reaper] orphan sweep SKIPPED — the previous sweep is still in flight (a slow process probe?)');
      return;
    }
    inFlight = true;
    sweepOrphanedRunProcesses(pendingKill, io)
      .then(({ terminated, killed }) => {
        if (stopped || (terminated.length === 0 && killed.length === 0)) return;
        const killNote = killed.length > 0 ? `; SIGKILLed unresponsive: ${killed.join(', ')}` : '';
        console.warn(
          `[bridge-reaper] reaped orphaned worker/bridge process(es) (crew#340): ` +
            `SIGTERMed ${terminated.join(', ') || '(none)'}${killNote}`,
        );
      })
      .catch(() => {
        /* a sweep never throws by contract; a surprise is not worth a crashed daemon */
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Injectable seams so the reaper is testable without signalling real bridges. */
export interface BridgeReaperIo {
  /** Signal sender; must throw like `process.kill` (ESRCH when the pid is gone). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Bridge-child discovery; defaults to the process-table sweep above. */
  discover?: (parentPid: number) => number[];
  /** Orphan-sweep cwd reader — ONE call per sweep with every candidate pid (crew#806); injectable so
   *  tests avoid a real lsof. Defaults to {@link probeCwds}. */
  cwds?: (pids: number[]) => Promise<Map<number, string>> | Map<number, string>;
  /** Orphan-sweep process listing (`pid ppid command` lines); defaults to the real table (async). */
  list?: () => string | null | Promise<string | null>;
  /** Interactive-orphan gate: crew's sidecar for a docs root (F-W1-103); injectable so tests avoid real files. */
  sidecar?: (root: string) => CrewSidecar | null;
  /** Interactive-orphan gate: the live `.wi-serve.json` for a docs root, so a sidecar is checked
   *  against the bridge INSTANCE and not just its pid (crew#510). Injectable for tests. */
  lock?: (root: string) => LiveBridge | null;
  /** Interactive-orphan gate: is the daemon the sidecar names as owner still THAT daemon — pid AND
   *  start time ({@link ownerAlive}), so a recycled pid reads as "owner gone"? Injectable for tests. */
  ownerAlive?: (sidecar: CrewSidecar) => boolean;
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
  /** Pids whose SIGKILL could not be delivered (e.g. EPERM) — still possibly alive. */
  undeliverable?: number[];
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

  /**
   * Deliver `signal`. For the signal-0 liveness probe, EPERM means "alive but not
   * ours" and counts as existing; for real signals EPERM means the kill was NOT
   * delivered and must not be reported as success (Copilot review on #300).
   */
  private signal(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      (this.io.kill ?? process.kill)(pid, signal);
      return true;
    } catch (err) {
      const eperm = (err as NodeJS.ErrnoException).code === 'EPERM';
      return signal === 0 ? eperm : false;
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

    const killed = survivors.filter((pid) => this.signal(pid, 'SIGKILL'));
    this.tracked.clear();
    return {
      terminated: targets.filter((pid) => !survivors.includes(pid)),
      killed,
      undeliverable: survivors.filter((pid) => !killed.includes(pid)),
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
