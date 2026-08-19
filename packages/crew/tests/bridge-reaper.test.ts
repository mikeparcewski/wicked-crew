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

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_BINS,
  BRIDGE_KILL_GRACE_MS,
  BridgeReaper,
  discoverBridgeChildren,
  parseBridgeChildren,
} from '../src/core/bridge-reaper.js';

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

describe('bridge token boundaries (#300 post-merge review)', () => {
  it('pi-acp does not match inside api-acp', () => {
    const listing = [
      '  11 10 node /x/api-acp serve',        // NOT a bridge — contains pi-acp as substring
      '  12 10 node /x/bin/pi-acp',           // bridge, path-prefixed
      '  13 10 pi-acp --flag',                // bridge, bare token
      '  14 10 node copy-of-pi-acp-backup',   // NOT a bridge — embedded token
    ].join('\n');
    expect(parseBridgeChildren(listing, 10)).toEqual([12, 13]);
  });
});
