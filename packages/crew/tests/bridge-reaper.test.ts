/**
 * BridgeReaper tests (crew#285): ACP bridge children must die with the daemon.
 *
 * The engine's kill handles for its spawned bridges live in process memory, so daemon
 * death used to orphan every bridge child. The reaper is the daemon-side half of the
 * fix: a central pid registry + a direct-child process-table sweep, run on shutdown
 * with SIGTERM → grace → SIGKILL escalation.
 *
 * Two layers of test:
 *   - REAL children (spawned `node -e` processes) prove the actual signal path: a
 *     registered fake child dies when the manager runs its shutdown path, and a
 *     SIGTERM-ignoring child is SIGKILLed after the grace.
 *   - FAKE IO proves the policy: discovery ∪ registry targeting, escalation order,
 *     report contents — without racing real process lifecycles.
 *
 * Plus the drift guard: `BRIDGE_BINS` must equal the `*-acp` bins the declared
 * dependencies provide (the same ground truth `bridge-names.test.ts` audits), so a
 * bridge added or removed there cannot silently escape the reaper here.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_BINS,
  BRIDGE_KILL_GRACE_MS,
  BridgeReaper,
  INTERACTIVE_BIN,
  ORPHAN_SWEEP_DEFAULT_MS,
  WORKER_CLI_BINS,
  discoverBridgeChildren,
  isInteractiveServe,
  orphanSweepMs,
  parseBridgeChildren,
  parseOrphanedInteractiveBridges,
  parseOrphanedRunProcesses,
  reapOrphansAtBoot,
  rootArgOf,
  startOrphanSweep,
  sweepOrphanedRunProcesses,
} from '../src/core/bridge-reaper.js';
import { CREW_SIDECAR_NAME, parentPidOf, pidAlive, readCrewSidecar, type CrewSidecar } from '../src/interactive/bridge-pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');

/** ESRCH the way `process.kill` raises it for a pid that no longer exists. */
const esrch = (): Error => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

const byNumber = (a: number, b: number): number => a - b;

/**
 * Spawn a disposable `node -e` child and resolve once it has produced its first
 * stdout byte — i.e. once it has really exec'd (its signal handlers are installed and
 * its command line is what `ps` will report, not a fork-in-progress).
 */
function spawnFakeChild(script: string, extraArgs: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', script, ...extraArgs], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', () => resolve(child));
  });
}

function pidOf(child: ChildProcess): number {
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn returned no pid');
  return pid;
}

describe('parseBridgeChildren', () => {
  it('picks exactly the direct children whose command line names a bridge', () => {
    const listing = [
      // Direct children of pid 50 running bridges — the shim spelling and the
      // package-path spelling both count.
      `  101    50 node /repo/node_modules/.bin/${BRIDGE_BINS[1]}`,
      `  102    50 node /repo/node_modules/@scope/${BRIDGE_BINS[2]}/dist/index.js`,
      // Direct child, not a bridge.
      '  103    50 vim README.md',
      // A bridge, but some OTHER daemon’s child — must never be touched.
      `  104    99 node /repo/node_modules/.bin/${BRIDGE_BINS[1]}`,
      // The daemon itself.
      '   50     1 node dist/cli/index.js serve',
      // Garbage lines a real ps never quite spares us.
      '',
      'not a process line',
    ].join('\n');
    expect(parseBridgeChildren(listing, 50)).toEqual([101, 102]);
  });

  it('never returns the parent itself, whatever its command line claims', () => {
    const listing = `   50    50 node ${BRIDGE_BINS[0]}`;
    expect(parseBridgeChildren(listing, 50)).toEqual([]);
  });
});

describe('BRIDGE_BINS drift guard', () => {
  /** Every `*-acp` bin key provided by a DECLARED dependency of packages/crew —
   *  the same two-source ground truth `bridge-names.test.ts` audits prose against. */
  function bridgeNamesFromDeclaredDeps(): Set<string> {
    const suffix = '-' + 'acp';
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const roots = [join(PKG_ROOT, 'node_modules'), join(PKG_ROOT, '..', '..', 'node_modules')];
    const names = new Set<string>();
    let resolvedAny = false;
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const found = roots.map((r) => join(r, dep, 'package.json')).find((p) => existsSync(p));
      if (found === undefined) continue;
      resolvedAny = true;
      const bin = (
        JSON.parse(readFileSync(found, 'utf8')) as { bin?: string | Record<string, string> }
      ).bin;
      if (typeof bin === 'string') {
        const base = dep.includes('/') ? (dep.split('/').pop() as string) : dep;
        if (base.endsWith(suffix)) names.add(base);
      } else if (bin !== undefined) {
        for (const key of Object.keys(bin)) if (key.endsWith(suffix)) names.add(key);
      }
    }
    expect(resolvedAny, 'no declared dependency resolved — run npm install before the suite').toBe(
      true,
    );
    return names;
  }

  it('BRIDGE_BINS equals the *-acp bins the declared dependencies provide', () => {
    expect([...BRIDGE_BINS].sort()).toEqual([...bridgeNamesFromDeclaredDeps()].sort());
  });

  it('the grace window is the ~2s the shutdown contract promises', () => {
    expect(BRIDGE_KILL_GRACE_MS).toBe(2000);
  });
});

describe('BridgeReaper registry', () => {
  it('register accepts only plausible pids and unregister removes them', () => {
    const reaper = new BridgeReaper({ discover: () => [] });
    reaper.register(undefined);
    reaper.register(0);
    reaper.register(-4);
    reaper.register(3.5);
    expect(reaper.pids()).toEqual([]);
    reaper.register(4242);
    expect(reaper.pids()).toEqual([4242]);
    reaper.unregister(4242);
    expect(reaper.pids()).toEqual([]);
  });
});

describe('BridgeReaper shutdown (real children)', () => {
  it('a registered fake child dies when the manager runs its shutdown path', async () => {
    const child = await spawnFakeChild("console.log('up'); setInterval(() => {}, 1000);");
    const pid = pidOf(child);
    const exited = once(child, 'exit');
    try {
      const reaper = new BridgeReaper({ discover: () => [] });
      reaper.register(pid);
      expect(reaper.pids()).toEqual([pid]);

      const report = await reaper.shutdown();

      const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
      expect(signal).toBe('SIGTERM');
      expect(report.terminated).toEqual([pid]);
      expect(report.killed).toEqual([]);
      expect(reaper.pids()).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  // Windows has no ignorable SIGTERM — `process.kill(pid, 'SIGTERM')` is already lethal
  // there, so the escalation path is POSIX-only behavior.
  it.skipIf(process.platform === 'win32')(
    'a SIGTERM-ignoring child is SIGKILLed after the grace',
    async () => {
      const child = await spawnFakeChild(
        "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);",
      );
      const pid = pidOf(child);
      const exited = once(child, 'exit');
      try {
        const reaper = new BridgeReaper({ discover: () => [], graceMs: 250 });
        reaper.register(pid);

        const report = await reaper.shutdown();

        const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
        expect(signal).toBe('SIGKILL');
        expect(report.killed).toEqual([pid]);
        expect(report.terminated).toEqual([]);
      } finally {
        child.kill('SIGKILL');
      }
    },
  );
});

describe('BridgeReaper shutdown (policy, fake IO)', () => {
  it('SIGTERMs registered ∪ discovered pids and reports them terminated', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const dead = new Set<number>();
    const reaper = new BridgeReaper({
      kill: (pid, sig) => {
        if (sig === 0) {
          if (dead.has(pid)) throw esrch();
          return;
        }
        signals.push([pid, sig]);
        dead.add(pid); // every signalled pid dies immediately — no escalation expected
      },
      discover: () => [301, 302],
      sleep: () => Promise.resolve(),
      graceMs: 40,
    });
    reaper.register(300);
    reaper.register(301); // overlaps discovery — must be signalled once, not twice

    const report = await reaper.shutdown();

    expect(signals.map(([p]) => p).sort(byNumber)).toEqual([300, 301, 302]);
    expect(signals.every(([, s]) => s === 'SIGTERM')).toBe(true);
    expect([...report.terminated].sort(byNumber)).toEqual([300, 301, 302]);
    expect(report.killed).toEqual([]);
  });

  it('escalates to SIGKILL for a pid that survives the whole grace window', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaper = new BridgeReaper({
      // Liveness probes always succeed: the pid never dies on its own.
      kill: (pid, sig) => {
        if (sig !== 0) signals.push([pid, sig]);
      },
      discover: () => [],
      sleep: () => Promise.resolve(),
      graceMs: 30,
    });
    reaper.register(500);

    const report = await reaper.shutdown();

    expect(signals).toEqual([
      [500, 'SIGTERM'],
      [500, 'SIGKILL'],
    ]);
    expect(report.killed).toEqual([500]);
    expect(report.terminated).toEqual([]);
  });

  it('skips pids that are already gone before any signal is sent', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaper = new BridgeReaper({
      kill: () => {
        throw esrch();
      },
      discover: () => [700],
      sleep: () => Promise.resolve(),
      graceMs: 30,
    });
    reaper.register(701);

    const report = await reaper.shutdown();

    expect(signals).toEqual([]);
    expect(report.terminated).toEqual([]);
    expect(report.killed).toEqual([]);
  });

  it('sweepSync SIGTERMs registered ∪ discovered synchronously and clears the registry', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaper = new BridgeReaper({
      kill: (pid, sig) => {
        signals.push([pid, sig]);
      },
      discover: () => [601, 602],
    });
    reaper.register(600);
    reaper.register(601);

    reaper.sweepSync();

    expect(signals.map(([p]) => p).sort(byNumber)).toEqual([600, 601, 602]);
    expect(signals.every(([, s]) => s === 'SIGTERM')).toBe(true);
    expect(reaper.pids()).toEqual([]);
  });
});

describe('discoverBridgeChildren (real process table)', () => {
  it('finds a direct child whose command line names a bridge, and only that one', async () => {
    const marker = BRIDGE_BINS[1];
    if (marker === undefined) throw new Error('BRIDGE_BINS is empty');
    // Both children are plain `node -e` loops; one carries a bridge-named argv marker.
    const bridgey = await spawnFakeChild("console.log('up'); setInterval(() => {}, 1000);", [
      marker,
    ]);
    const plain = await spawnFakeChild("console.log('up'); setInterval(() => {}, 1000);");
    const bridgeyExit = once(bridgey, 'exit');
    const plainExit = once(plain, 'exit');
    try {
      const found = discoverBridgeChildren();
      expect(found).toContain(pidOf(bridgey));
      expect(found).not.toContain(pidOf(plain));
    } finally {
      bridgey.kill('SIGKILL');
      plain.kill('SIGKILL');
      await Promise.all([bridgeyExit, plainExit]);
    }
  });
});

describe('orphaned run-process sweep (crew#340)', () => {
  // A worker CLI orphaned by `kill -9` on its bridge: ppid 1, cwd inside a run worktree.
  const ORPHANED_CLAUDE = '  901     1 node /opt/homebrew/bin/claude --output-format stream-json';
  const ORPHANED_BRIDGE = `  902     1 node /repo/node_modules/.bin/${BRIDGE_BINS[1]}`;
  // A worker CLI whose BRIDGE is alive (ppid != 1) — some other daemon's live business.
  const PARENTED_CLAUDE = '  903   700 node /opt/homebrew/bin/claude --output-format stream-json';
  // An orphan that is neither a bridge nor a worker CLI.
  const ORPHANED_VIM = '  904     1 vim README.md';
  // The operator's own interactive claude, orphaned by a dead terminal — token matches,
  // but its cwd (checked separately) is NOT a run worktree.
  const OPERATOR_CLAUDE = '  905     1 claude';

  it('parseOrphanedRunProcesses matches orphaned bridges AND worker CLIs, nothing parented', () => {
    const listing = [ORPHANED_CLAUDE, ORPHANED_BRIDGE, PARENTED_CLAUDE, ORPHANED_VIM, OPERATOR_CLAUDE].join('\n');
    expect(parseOrphanedRunProcesses(listing).sort(byNumber)).toEqual([901, 902, 905]);
  });

  it('worker tokens never match inside bridge names (claude ≠ claude-agent-acp)', () => {
    // claude-agent-acp CONTAINS "claude" — the token-boundary rule must still count the
    // line exactly once (as a bridge), and a hyphen-adjacent token must not leak.
    const listing = ['  910     1 node /x/claude-agent-acp', '  911     1 node /x/api-acp'].join('\n');
    expect(parseOrphanedRunProcesses(listing)).toEqual([910]);
  });

  it('WORKER_CLI_BINS names the CLIs the declared bridges drive', () => {
    // agy-acp→agy, claude-agent-acp→claude, codex-acp→codex, pi-acp→pi (through the wicked-pi
    // launcher, F-079). A bridge added to BRIDGE_BINS whose CLI is missing here escapes the
    // orphan sweep — keep them in step.
    expect([...WORKER_CLI_BINS].sort()).toEqual(['agy', 'claude', 'codex', 'pi', 'wicked-pi']);
  });

  it('the wicked-pi launcher (pi-acp → wicked-pi → pi) is an orphan the sweep sees — as the npm shim runs it (`node …/wicked-pi.mjs`) and as a bare bin; `wicked-pi` never matches inside another token', () => {
    const listing = [
      '  920     1 node /repo/node_modules/agent-acp-bridges/wicked-pi.mjs --mode rpc --no-themes',
      '  921     1 /repo/node_modules/.bin/wicked-pi --mode rpc',
      String.raw`  922     1 "C:\repo\node_modules\.bin\wicked-pi.cmd" --mode rpc`,
      '  923   700 node /repo/node_modules/agent-acp-bridges/wicked-pi.mjs --mode rpc', // parented: pi-acp alive
      '  924     1 node /x/not-wicked-pi.mjs', // embedded token
      '  925     1 node /x/wicked-pi-backup.mjs', // hyphen-adjacent
    ].join('\n');
    expect(parseOrphanedRunProcesses(listing).sort(byNumber)).toEqual([920, 921, 922]);
  });

  it('reapOrphansAtBoot SIGTERMs only worktree-cwd orphans (worker CLIs included)', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaped = reapOrphansAtBoot({
      list: () => [ORPHANED_CLAUDE, ORPHANED_BRIDGE, OPERATOR_CLAUDE, ORPHANED_VIM].join('\n'),
      cwdInWorktree: (pid) => pid !== 905, // the operator's own claude runs elsewhere
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    expect(reaped.sort(byNumber)).toEqual([901, 902]);
    expect(signals.every(([, s]) => s === 'SIGTERM')).toBe(true);
  });

  it('sweepOrphanedRunProcesses escalates: SIGTERM on sight, SIGKILL one tick later', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const io = {
      list: () => [ORPHANED_CLAUDE].join('\n'),
      cwdInWorktree: () => true,
      kill: (pid: number, sig: NodeJS.Signals | 0) => signals.push([pid, sig]),
    };
    const pending = new Set<number>();

    const tick1 = sweepOrphanedRunProcesses(pending, io);
    expect(tick1).toEqual({ terminated: [901], killed: [] });
    expect([...pending]).toEqual([901]);

    // Still in the table a whole interval later — it ignored SIGTERM; escalate.
    const tick2 = sweepOrphanedRunProcesses(pending, io);
    expect(tick2).toEqual({ terminated: [], killed: [901] });
    // One escalation per pid, then the slot clears: a stale table that keeps listing a
    // SIGKILLed zombie re-enters at SIGTERM, never a SIGKILL loop.
    expect(pending.size).toBe(0);
    expect(signals).toEqual([
      [901, 'SIGTERM'],
      [901, 'SIGKILL'],
    ]);
  });

  it('an orphan that exits during the grace interval is never SIGKILLed', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    let alive = true;
    const io = {
      list: () => (alive ? ORPHANED_CLAUDE : '   1     0 launchd'),
      cwdInWorktree: () => true,
      kill: (pid: number, sig: NodeJS.Signals | 0) => signals.push([pid, sig]),
    };
    const pending = new Set<number>();
    expect(sweepOrphanedRunProcesses(pending, io).terminated).toEqual([901]);
    alive = false; // the SIGTERM worked
    expect(sweepOrphanedRunProcesses(pending, io)).toEqual({ terminated: [], killed: [] });
    expect(pending.size).toBe(0);
    expect(signals).toEqual([[901, 'SIGTERM']]);
  });

  it('a non-worktree cwd is the hard gate: token-matching orphans elsewhere are untouched', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = sweepOrphanedRunProcesses(new Set(), {
      list: () => [ORPHANED_CLAUDE, OPERATOR_CLAUDE].join('\n'),
      cwdInWorktree: (pid) => pid === 901,
      kill: (pid: number, sig: NodeJS.Signals | 0) => signals.push([pid, sig]),
    });
    expect(result.terminated).toEqual([901]);
    expect(signals.map(([p]) => p)).toEqual([901]);
  });

  it('an unreadable process table is a no-op, never a throw', () => {
    expect(sweepOrphanedRunProcesses(new Set(), { list: () => null })).toEqual({
      terminated: [],
      killed: [],
    });
  });

  it('orphanSweepMs: default 30s; seconds override; 0 disables; garbage falls back', () => {
    expect(orphanSweepMs(undefined)).toBe(ORPHAN_SWEEP_DEFAULT_MS);
    expect(orphanSweepMs('')).toBe(ORPHAN_SWEEP_DEFAULT_MS);
    expect(orphanSweepMs('45')).toBe(45_000);
    expect(orphanSweepMs('0')).toBe(0);
    expect(orphanSweepMs('never')).toBe(ORPHAN_SWEEP_DEFAULT_MS);
    expect(orphanSweepMs('-5')).toBe(ORPHAN_SWEEP_DEFAULT_MS);
  });

  it('startOrphanSweep ticks on its interval and stop() ends it', async () => {
    let lists = 0;
    const stop = startOrphanSweep(10, {
      list: () => {
        lists++;
        return '';
      },
      cwdInWorktree: () => true,
      kill: () => {},
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    const after = lists;
    expect(lists).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(lists).toBe(after); // stopped means stopped
  });

  it('startOrphanSweep with a 0 interval (disabled) starts nothing', async () => {
    let lists = 0;
    const stop = startOrphanSweep(0, {
      list: () => {
        lists++;
        return '';
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(lists).toBe(0);
  });
});

describe('bridge token boundaries (#300 post-merge review)', () => {
  it('pi-acp does not match inside api-acp', () => {
    const listing = [
      '  11 10 node /x/api-acp serve',        // NOT a bridge — contains pi-acp as substring
      '  12 10 node /x/bin/pi-acp',           // bridge, path-prefixed
      '  13 10 pi-acp --flag',                // bridge, bare token
      '  14 10 node copy-of-pi-acp-backup',   // NOT a bridge — embedded token
      String.raw`  15 10 "C:\shims\pi-acp.cmd" serve`, // bridge — quoted Windows shim
      String.raw`  16 10 C:\bin\pi-acp.exe`,           // bridge — launcher extension
      '  17 10 node api-acp.cmd',              // NOT a bridge — api-acp with extension
    ].join('\n');
    expect(parseBridgeChildren(listing, 10)).toEqual([12, 13, 15, 16]);
  });
});

// ── Interactive bridge trees (F-W1-103, FIX-IT-ALL wave 1) ──────────────────────────────
//
// The shapes below are the two orphans the WAVE-1 gate found (~20 h old, ports :4400/:4402,
// paths anonymised): an `npm exec` wrapper reparented to init whose child is the server that
// holds the port. A live daemon's pair (ppid = the daemon) and an operator's own `serve` (shell-
// parented, or nohup'd with NO crew sidecar) sit beside them and must never be touched.
describe('interactive bridge trees (F-W1-103)', () => {
  const DOCS = '/home/op/wicked-interactive/docs';
  const PROJ = `${DOCS}/projects/proj_178933212081900000`;
  const STATE = '/home/op/.wicked-crew/interactive/docs/proj_2';
  // ps pads the wrapper line with trailing blanks — real output, kept.
  const WRAPPER_4400 = ` 96633     1 npm exec ${INTERACTIVE_BIN}@^0.9.2 serve --root ${PROJ}      `;
  const SERVER_4400 = ` 98034 96633 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root ${PROJ}`;
  const WRAPPER_4402 = `  8687     1 npm exec ${INTERACTIVE_BIN}@^0.9.2 serve --root ${DOCS}`;
  const SERVER_4402 = `  9488  8687 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root ${DOCS}`;
  // The live daemon (pid 6556) and the pair it spawned.
  const DAEMON = '  6556     1 node /opt/homebrew/bin/wicked-crew serve';
  const LIVE_WRAPPER = ` 84428  6556 npm exec ${INTERACTIVE_BIN}@^0.9.3 serve --root ${STATE}`;
  const LIVE_SERVER = ` 84710 84428 node /home/op/.npm/_npx/d9b4/node_modules/.bin/${INTERACTIVE_BIN} serve --root ${STATE}`;
  const LIVE_PLAIN_CHILD = ' 84711 84428 node /some/helper.js'; // a wrapper child that is NOT a serve
  // A server whose wrapper already died (the pre-fix shutdown sweep never signalled either, but a
  // wrapper can die alone): reparented to init on its own.
  const BARE_SERVER = ` 91000     1 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root /home/op/.wicked-crew/interactive/docs`;
  // The operator's own bridges: from a terminal (shell-parented), and nohup'd (ppid 1, no sidecar).
  const OPERATOR_SERVE = ` 77001 51000 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root /home/op/notes`;
  const NOHUP_SERVE = ` 77002     1 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root /home/op/notes`;
  // Lookalikes: a different package that starts with the same letters; the same package doing
  // something other than serving; a serve with a relative root (never spawned by crew).
  const LOOKALIKE = ` 77003     1 node /opt/bin/${INTERACTIVE_BIN}-export serve --root /x`;
  const NOT_SERVE = ` 77004     1 npm exec ${INTERACTIVE_BIN}@^0.9.3 render --root /x`;
  const RELATIVE_ROOT = ` 77005     1 node /opt/npm/bin/${INTERACTIVE_BIN} serve --root docs`;
  const ALL = [
    WRAPPER_4400, SERVER_4400, WRAPPER_4402, SERVER_4402, DAEMON, LIVE_WRAPPER, LIVE_SERVER, LIVE_PLAIN_CHILD,
    BARE_SERVER, OPERATOR_SERVE, NOHUP_SERVE, LOOKALIKE, NOT_SERVE, RELATIVE_ROOT, '', 'not a process line',
  ].join('\n');

  it('isInteractiveServe: the npx spec, the shim and the package path all count; a lookalike package or a non-serve subcommand never does', () => {
    expect(isInteractiveServe(`npm exec ${INTERACTIVE_BIN}@^0.9.2 serve --root /x`)).toBe(true);
    expect(isInteractiveServe(`node /opt/npm/bin/${INTERACTIVE_BIN} serve --root /x`)).toBe(true);
    expect(isInteractiveServe(`node /repo/node_modules/${INTERACTIVE_BIN}/dist/cli.js serve --root /x`)).toBe(true);
    expect(isInteractiveServe(`"C:\\Users\\op\\AppData\\npm\\${INTERACTIVE_BIN}.cmd" serve --root C:\\docs`)).toBe(true);
    // Interactive's options come AFTER the subcommand (`serve --root <dir> [--port N]`); a token
    // between the bin and `serve` is not how any bridge is spawned, so it is not a bridge.
    expect(isInteractiveServe(`node /opt/npm/bin/${INTERACTIVE_BIN} --port 4400 serve --root /x`)).toBe(false);
    expect(isInteractiveServe(`node /opt/bin/${INTERACTIVE_BIN}-export serve --root /x`)).toBe(false);
    expect(isInteractiveServe(`npm exec ${INTERACTIVE_BIN}@^0.9.3 render --root /x`)).toBe(false);
    // `serve` must be the token right after the bin (review NIT): a render whose option VALUE is
    // `serve` is not a bridge — the shutdown path has no sidecar gate to catch it.
    expect(isInteractiveServe(`npm exec ${INTERACTIVE_BIN}@^0.9.3 render --mode serve --root /x`)).toBe(false);
    expect(isInteractiveServe(`node /opt/npm/bin/${INTERACTIVE_BIN} --root /x`)).toBe(false);
    expect(isInteractiveServe('node /opt/homebrew/bin/wicked-crew serve')).toBe(false);
  });

  it('rootArgOf: absolute roots only; `--root=`, quoted and space-bearing values; trailing ps padding dropped', () => {
    expect(rootArgOf(`npm exec x serve --root ${PROJ}      `)).toBe(PROJ);
    expect(rootArgOf('node x serve --root=/a/b --port 4400')).toBe('/a/b');
    expect(rootArgOf('node x serve --root /a/b c --port 4400')).toBe('/a/b c');
    expect(rootArgOf('node x serve --root "/a/b c"')).toBe('/a/b c');
    expect(rootArgOf("node x serve --root '/a/b c' --host 127.0.0.1")).toBe('/a/b c');
    expect(rootArgOf('node x serve --root docs')).toBeNull();
    expect(rootArgOf('node x serve')).toBeNull();
    expect(rootArgOf('node x serve --root')).toBeNull();
  });

  it('parseBridgeChildren reaps the wrapper the daemon spawned AND its server child (the grandchild npm never signals); a plain grandchild and other trees are untouched', () => {
    expect(parseBridgeChildren(ALL, 6556)).toEqual([84428, 84710]);
    // The wrapper alone, when the server has not exec\'d yet, is still a target.
    expect(parseBridgeChildren([DAEMON, LIVE_WRAPPER].join('\n'), 6556)).toEqual([84428]);
    // The existing bridge-binary rule is unchanged beside it.
    const acp = `  700  6556 node /repo/node_modules/.bin/${BRIDGE_BINS[1]}`;
    expect(parseBridgeChildren([DAEMON, acp, LIVE_WRAPPER, LIVE_SERVER].join('\n'), 6556)).toEqual([700, 84428, 84710]);
  });

  it('parseOrphanedInteractiveBridges: every ppid-1 tree with an absolute --root, wrapper first then its serve children; parented trees and lookalikes excluded', () => {
    expect(parseOrphanedInteractiveBridges(ALL)).toEqual([
      { root: PROJ, pids: [96633, 98034] },
      { root: DOCS, pids: [8687, 9488] },
      { root: '/home/op/.wicked-crew/interactive/docs', pids: [91000] },
      { root: '/home/op/notes', pids: [77002] }, // the nohup'd operator bridge is PARSED — the sidecar gate below refuses it
    ]);
    // Interactive processes are not run processes: the worktree-gated sweep never sees them.
    expect(parseOrphanedRunProcesses(ALL)).toEqual([]);
  });

  /** A fake sidecar store: docs root → what crew recorded there. */
  const sidecars = (table: Record<string, Partial<CrewSidecar> & { pid: number }>) =>
    (root: string): CrewSidecar | null => {
      const s = table[root];
      return s === undefined ? null : { env: {}, startedBy: 'wicked-crew', startedAt: '', ...s };
    };
  const DEAD_OWNER = 30379; // the daemon both recorded orphans named — long gone
  /** A fake owner check: every recorded owner is alive except the listed pids. */
  const ownerGone = (...dead: number[]) => (s: CrewSidecar): boolean => !dead.includes(s.ownerPid ?? -1);

  it('reapOrphansAtBoot reaps a crew-recorded tree whose owner daemon is gone — the wrapper AND the server; run-process orphans still need their worktree cwd', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const reaped = reapOrphansAtBoot({
      list: () => ALL,
      cwdInWorktree: () => false,
      sidecar: sidecars({
        [PROJ]: { pid: 98034, ownerPid: DEAD_OWNER },
        [DOCS]: { pid: 9488, ownerPid: DEAD_OWNER },
      }),
      ownerAlive: ownerGone(DEAD_OWNER),
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    expect(reaped.sort(byNumber)).toEqual([8687, 9488, 96633, 98034]);
    expect(signals.every(([, s]) => s === 'SIGTERM')).toBe(true);
    // The live daemon's pair, the operator's bridges and the lookalikes were never signalled.
    expect(signals.map(([p]) => p).sort(byNumber)).toEqual([8687, 9488, 96633, 98034]);
  });

  it('the sidecar gate: no sidecar (operator / nohup), a sidecar naming ANOTHER pid, no proven owner, or a LIVE owner all leave the tree alone', () => {
    const signals: number[] = [];
    const reaped = reapOrphansAtBoot({
      list: () => ALL,
      cwdInWorktree: () => false,
      sidecar: sidecars({
        // PROJ: no sidecar at all — nobody recorded it (an operator's own serve).
        [DOCS]: { pid: 4242, ownerPid: DEAD_OWNER }, // names a pid that is not in this tree — a stale record
        ['/home/op/.wicked-crew/interactive/docs']: { pid: 91000 }, // a pre-#506 sidecar: no proven owner
        ['/home/op/notes']: { pid: 77002, ownerPid: 6556 }, // owner alive — that daemon adopted it and stamped itself
      }),
      ownerAlive: ownerGone(DEAD_OWNER),
      kill: (pid) => signals.push(pid),
    });
    expect(reaped).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('the live sweep escalates an interactive tree like any orphan: SIGTERM on sight, SIGKILL for whatever is still listed one tick later', () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const io = {
      list: () => [WRAPPER_4400, SERVER_4400].join('\n'),
      cwdInWorktree: () => false,
      sidecar: sidecars({ [PROJ]: { pid: 98034, ownerPid: DEAD_OWNER } }),
      ownerAlive: ownerGone(DEAD_OWNER),
      kill: (pid: number, sig: NodeJS.Signals | 0) => signals.push([pid, sig]),
    };
    const pending = new Set<number>();
    expect(sweepOrphanedRunProcesses(pending, io)).toEqual({ terminated: [96633, 98034], killed: [] });
    expect(sweepOrphanedRunProcesses(pending, io)).toEqual({ terminated: [], killed: [96633, 98034] });
    expect(signals).toEqual([[96633, 'SIGTERM'], [98034, 'SIGTERM'], [96633, 'SIGKILL'], [98034, 'SIGKILL']]);
    expect(pending.size).toBe(0);
  });

  // Review finding 4 (crew #606): the DEFAULT seams wired end to end — real `ps`, the real sidecar
  // reader, the real owner check (pid + start time) and a real SIGTERM. A wrapper spawns its "server"
  // and EXITS, so the server is reparented to init exactly like the recorded orphans; a real
  // `.wi-serve.crew.json` in the fixture root names it with an owner pid that is gone.
  it.skipIf(process.platform === 'win32')(
    'end to end with the default seams: a serve orphaned by its dead wrapper, recorded by a dead owner, is reaped at boot — fenced to the fixture root',
    async (ctx) => {
      const root = mkdtempSync(join(tmpdir(), 'wi-reap-e2e-'));
      const WRAPPER = `
        const { spawn } = require('node:child_process');
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...process.argv.slice(1)], { detached: true, stdio: 'ignore' });
        c.unref();
        process.stdout.write(String(c.pid) + '\\n');
      `;
      const wrapper = spawn(process.execPath, ['-e', WRAPPER, INTERACTIVE_BIN, 'serve', '--root', root], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const serverPid = Number(
        await new Promise<string>((resolve, reject) => {
          wrapper.once('error', reject);
          wrapper.stdout?.once('data', (d: Buffer) => resolve(String(d).trim()));
        }),
      );
      await once(wrapper, 'exit');
      try {
        expect(Number.isInteger(serverPid) && serverPid > 0).toBe(true);
        // Reparenting to init is the precondition the production sweep keys on. A subreaper
        // environment (some containers) keeps a different parent — there the case is skipped, never faked.
        await waitUntil(() => parentPidOf(serverPid) === 1, 5_000).catch(() => undefined);
        if (parentPidOf(serverPid) !== 1) ctx.skip();
        const deadOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid ?? 999_999;
        expect(pidAlive(deadOwner)).toBe(false);
        writeFileSync(
          join(root, CREW_SIDECAR_NAME),
          JSON.stringify({ pid: serverPid, env: {}, startedBy: 'wicked-crew', startedAt: new Date().toISOString(), ownerPid: deadOwner, ownerStartedAt: 'Thu Jan  1 00:00:00 1970' }),
          'utf8',
        );
        expect(readCrewSidecar(root)?.pid).toBe(serverPid);
        // Default `list`, `ownerAlive` and `kill`. The sidecar READER is fenced to the fixture root
        // and the run-process arm is switched off: a test must never reap a process outside its own
        // fixture — the host it runs on may carry real orphans the production sweep exists for.
        const reaped = reapOrphansAtBoot({
          cwdInWorktree: () => false,
          sidecar: (r) => (r === root ? readCrewSidecar(r) : null),
        });
        expect(reaped).toEqual([serverPid]);
        await waitUntil(() => !pidAlive(serverPid), 5_000);
        expect(pidAlive(serverPid)).toBe(false);
      } finally {
        try {
          process.kill(serverPid, 'SIGKILL');
        } catch {
          /* gone */
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  // The proof the hand-off asked for: start a bridge-shaped tree (wrapper → server), hold no handle
  // to the server, and show the daemon's shutdown path finds and reaps BOTH through the real
  // process table. Before this change the wrapper was not a target and the server was invisible.
  it.skipIf(process.platform === 'win32')(
    'shutdown reaps a real wrapper → server tree spawned like the pool does, server included',
    async () => {
      // The wrapper: spawns its "server" (same token, same --root), prints the server pid, idles.
      const WRAPPER = `
        const { spawn } = require('node:child_process');
        const args = process.argv.slice(1);
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
        process.stdout.write(String(c.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const root = join(PKG_ROOT, 'never-created-f-w1-103');
      const wrapper = spawn(process.execPath, ['-e', WRAPPER, INTERACTIVE_BIN, 'serve', '--root', root], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const serverPid = Number(
        await new Promise<string>((resolve, reject) => {
          wrapper.once('error', reject);
          wrapper.stdout?.once('data', (d: Buffer) => resolve(String(d).trim()));
        }),
      );
      const wrapperPid = pidOf(wrapper);
      const wrapperExited = once(wrapper, 'exit');
      try {
        expect(Number.isInteger(serverPid) && serverPid > 0).toBe(true);
        // Real process table: both generations are discovered as this process's bridge children.
        await waitUntil(() => discoverBridgeChildren(process.pid).includes(serverPid), 5_000);
        expect(discoverBridgeChildren(process.pid)).toEqual(expect.arrayContaining([wrapperPid, serverPid]));
        expect(pidAlive(serverPid)).toBe(true);

        const report = await new BridgeReaper({ graceMs: 2_000 }).shutdown();

        const [, signal] = (await wrapperExited) as [number | null, NodeJS.Signals | null];
        expect(signal).toBe('SIGTERM');
        expect(report.terminated).toEqual(expect.arrayContaining([wrapperPid, serverPid]));
        expect(report.killed).toEqual([]);
        // The server — nobody's child now — is gone too, not merely reparented to init.
        await waitUntil(() => !pidAlive(serverPid), 5_000);
        expect(pidAlive(serverPid)).toBe(false);
      } finally {
        for (const pid of [serverPid, wrapperPid]) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
    },
    20_000,
  );
});

async function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
