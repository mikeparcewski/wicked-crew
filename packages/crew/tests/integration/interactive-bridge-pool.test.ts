// The bridge pool's spawn env + adopt-or-recycle (acceptance findings F-042 / F-043).
//
// A bridge is only useful to the daemon whose bus it emits to and whose crew API it registers
// against. These pin, with a REAL child process behind a REAL lockfile (only the spawn is faked):
//   - the spawn env carries WICKED_CREW_API (this daemon's origin) and WICKED_BUS_DATA_DIR (the
//     interactive seams' bus dir) on top of the daemon's own env, and the pair is recorded beside
//     the lockfile;
//   - a crew-started bridge whose recorded pair matches is ADOPTED; one recorded with a DIFFERENT
//     pair (a sibling daemon's) is RECYCLED — killed and restarted with the right env;
//   - a bridge nobody recorded (operator-run, pre-upgrade) is adopted with a warning, never killed;
//   - recycling FAILS CLOSED (codex r4 on #506): a refused signal or a pid that survives the wait
//     refuses the start with the sidecar untouched; the replacement must be a different pid AND
//     descend from the child this daemon spawned before it is recorded as crew's;
//   - `busDataDirOf` maps a bus.db path to its directory and any other spelling to null.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeUnavailableError,
  CREW_SIDECAR_NAME,
  InteractiveBridgePool,
  LOCK_NAME,
  bridgeEnvFor,
  bridgeEnvMatches,
  busDataDirOf,
  parentPidOf,
  pidAlive,
  readCrewSidecar,
  spawnLineage,
  type BridgePoolIo,
} from '../../src/interactive/bridge-pool.js';
import { removeScratch } from '../setup/scratch.js';

/** The fake bridge: lockfile + /api/health reporting its root, plus a peek at the env it got. */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
// A bridge that shrugs off SIGTERM (a hung materialisation, a debugger attached): the recycle's
// grace must run out and SIGKILL — or the refusal — must follow.
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ ok: true, root, pid: process.pid }));
  }
  if (url.pathname === '/api/env') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ crew: process.env.WICKED_CREW_API ?? null, bus: process.env.WICKED_BUS_DATA_DIR ?? null }));
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(root, '.wi-serve.json'), JSON.stringify({
    port: server.address().port, host: '127.0.0.1', pid: process.pid,
    startedAt: new Date().toISOString(), version: 'fake',
  }));
});
`;

let dir: string;
const children: ChildProcess[] = [];
const spawns: Array<{ root: string; env: NodeJS.ProcessEnv }> = [];

function spawnFake(root: string, env: NodeJS.ProcessEnv): ChildProcess {
  spawns.push({ root, env });
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore', env });
  children.push(child);
  return child;
}

function lock(root: string): { pid: number; port: number } {
  return JSON.parse(readFileSync(join(root, LOCK_NAME), 'utf8')) as { pid: number; port: number };
}

async function envSeenBy(root: string): Promise<{ crew: string | null; bus: string | null }> {
  const res = await fetch(`http://127.0.0.1:${lock(root).port}/api/env`);
  return (await res.json()) as { crew: string | null; bus: string | null };
}

async function waitFor(cond: () => boolean, ms = 10_000, step = 50): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

function poolWith(
  env: { origin: string | null; bus: string | null },
  log?: (m: string) => void,
  extra: Partial<BridgePoolIo> = {},
): InteractiveBridgePool {
  return new InteractiveBridgePool({
    spawn: spawnFake,
    startTimeoutMs: 15_000,
    healthTimeoutMs: 1_000,
    studioOrigin: () => env.origin,
    busDataDir: env.bus,
    ...(log !== undefined ? { log } : {}),
    ...extra,
  });
}

/** A child that is NOT a bridge (never writes a lockfile) — stands in for a spawn that is still booting. */
function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** Launch a bridge into `root` OUTSIDE the pool (an operator's own `wicked-interactive serve`). */
async function operatorBridge(root: string, env: NodeJS.ProcessEnv = { ...process.env }): Promise<number> {
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore', env });
  children.push(child);
  await waitFor(() => existsSync(join(root, LOCK_NAME)));
  return child.pid!;
}

function sidecarBytes(root: string): string | null {
  return existsSync(join(root, CREW_SIDECAR_NAME)) ? readFileSync(join(root, CREW_SIDECAR_NAME), 'utf8') : null;
}

/** A crew-started bridge whose sidecar names a DIFFERENT env pair and an owner daemon that is gone. */
async function orphanedMismatch(root: string, env: NodeJS.ProcessEnv = process.env): Promise<{ pid: number; owner: number; sidecar: string }> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let first: { pid: number };
  try {
    first = await poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') }).ensure(root);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const owner = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid ?? 999_999;
  expect(pidAlive(owner)).toBe(false);
  const sidecar = JSON.stringify({ ...readCrewSidecar(root)!, ownerPid: owner });
  writeFileSync(join(root, CREW_SIDECAR_NAME), sidecar, 'utf8');
  return { pid: first.pid, owner, sidecar };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wi-pool-'));
});

afterAll(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  removeScratch(dir);
});

describe('busDataDirOf (F-043)', () => {
  it('maps a bus.db path to its directory and any other file name to null', () => {
    expect(busDataDirOf('/state/bus/bus.db')).toBe('/state/bus');
    expect(busDataDirOf('/state/custom.db')).toBeNull();
    expect(busDataDirOf('rel/bus.db')).toBe(join(process.cwd(), 'rel'));
  });
});

describe('bridgeEnvFor / bridgeEnvMatches', () => {
  it('carries only the DEFINED halves, and compares both variables', () => {
    expect(bridgeEnvFor({})).toEqual({});
    expect(bridgeEnvFor({ studioOrigin: () => 'http://127.0.0.1:60785', busDataDir: '/fresh/bus' })).toEqual({
      WICKED_CREW_API: 'http://127.0.0.1:60785',
      WICKED_BUS_DATA_DIR: '/fresh/bus',
    });
    expect(bridgeEnvFor({ studioOrigin: () => null, busDataDir: null })).toEqual({});
    expect(bridgeEnvMatches({ WICKED_CREW_API: 'a' }, { WICKED_CREW_API: 'a' })).toBe(true);
    expect(bridgeEnvMatches({ WICKED_CREW_API: 'a' }, { WICKED_CREW_API: 'a', WICKED_BUS_DATA_DIR: '/b' })).toBe(false);
    expect(bridgeEnvMatches({}, {})).toBe(true);
  });
});

describe('the spawn env + the sidecar (F-042 / F-043)', () => {
  it('spawns the bridge with THIS daemon\'s WICKED_CREW_API and WICKED_BUS_DATA_DIR on top of the daemon env, and records the pair beside the lockfile', async () => {
    const root = join(dir, 'root-a');
    const pool = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    const bridge = await pool.ensure(root);
    expect(spawns.length).toBe(1);
    const env = spawns[0]!.env;
    expect(env.WICKED_CREW_API).toBe('http://127.0.0.1:60785');
    expect(env.WICKED_BUS_DATA_DIR).toBe(join(dir, 'state', 'bus'));
    expect(env.PATH).toBe(process.env.PATH); // the daemon's own env rides underneath
    // The child really sees them (the F-042 failure was the bridge defaulting to :7701).
    expect(await envSeenBy(root)).toEqual({ crew: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    // The sidecar names the LIVE pid (the bridge's, not npx's) and the pair.
    const sidecar = readCrewSidecar(root);
    expect(sidecar?.pid).toBe(bridge.pid);
    expect(sidecar?.pid).toBe(lock(root).pid);
    expect(sidecar?.env).toEqual({ WICKED_CREW_API: 'http://127.0.0.1:60785', WICKED_BUS_DATA_DIR: join(dir, 'state', 'bus') });
    expect(sidecar?.startedBy).toBe('wicked-crew');
    expect(existsSync(join(root, CREW_SIDECAR_NAME))).toBe(true);
  }, 30_000);

  it('ADOPTS a crew-started bridge whose recorded pair matches (no spawn); a DIFFERENT pair whose owner daemon is GONE is recycled — killed, restarted with the right env, sidecar rewritten', async () => {
    const root = join(dir, 'root-b');
    const first = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    const b1 = await first.ensure(root);
    const spawnsAfterFirst = spawns.length;
    expect(readCrewSidecar(root)?.ownerPid).toBe(process.pid);

    // A second daemon with the SAME pair (a restart of this one) adopts silently.
    const logged: string[] = [];
    const same = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') }, (m) => logged.push(m));
    const b2 = await same.ensure(root);
    expect(b2.pid).toBe(b1.pid);
    expect(spawns.length).toBe(spawnsAfterFirst);
    expect(logged).toEqual([]);

    // The owning daemon EXITED (a previous daemon on this root): its bridge, recorded with a
    // different pair, is nobody's — recycle it so the new daemon's events reach the new daemon.
    const deadOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid ?? 999_999;
    const sidecar = readCrewSidecar(root)!;
    writeFileSync(join(root, CREW_SIDECAR_NAME), JSON.stringify({ ...sidecar, ownerPid: deadOwner }), 'utf8');
    expect(pidAlive(deadOwner)).toBe(false);
    let oldAliveAtSpawn: boolean | null = null;
    const successor = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m), {
      spawn: (r, e) => {
        oldAliveAtSpawn = pidAlive(b1.pid); // the replacement is spawned only once the old pid is PROVEN gone
        return spawnFake(r, e);
      },
    });
    const b3 = await successor.ensure(root);
    expect(b3.pid).not.toBe(b1.pid);
    expect(spawns.length).toBe(spawnsAfterFirst + 1);
    expect(oldAliveAtSpawn, 'the recycled pid must be gone before its replacement is spawned').toBe(false);
    expect(pidAlive(b1.pid)).toBe(false);
    expect(logged.some((m) => m.includes('recycling'))).toBe(true);
    expect(readCrewSidecar(root)?.ownerPid).toBe(process.pid);
    expect(await envSeenBy(root)).toEqual({ crew: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') });
    expect(readCrewSidecar(root)?.pid).toBe(b3.pid);
    expect(readCrewSidecar(root)?.env.WICKED_CREW_API).toBe('http://127.0.0.1:7701');
  }, 60_000);

  it('NEVER recycles a mismatched bridge of UNPROVEN ownership — a pre-upgrade sidecar without ownerPid is refused, the bridge left running (codex r3 on #506)', async () => {
    const root = join(dir, 'root-e');
    const owner = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    const theirs = await owner.ensure(root);
    const sidecar = readCrewSidecar(root)!;
    const { ownerPid: _dropped, ...legacy } = sidecar as typeof sidecar & { ownerPid?: number };
    void _dropped;
    writeFileSync(join(root, CREW_SIDECAR_NAME), JSON.stringify(legacy), 'utf8');
    expect(readCrewSidecar(root)?.ownerPid).toBeUndefined();
    const logged: string[] = [];
    const spawnsBefore = spawns.length;
    const other = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m));
    await expect(other.ensure(root)).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(other.ensure(root)).rejects.toThrow(/cannot identify/);
    expect(pidAlive(theirs.pid), 'a bridge of unproven ownership must never be killed').toBe(true);
    expect(spawns.length).toBe(spawnsBefore);
    expect(logged.some((m) => m.includes('unproven ownership'))).toBe(true);
    const hint = await other.ensure(root).catch((e: BridgeUnavailableError) => e.hint);
    expect(String(hint)).toContain(`kill ${theirs.pid}`);
  }, 60_000);

  it('NEVER kills a bridge another LIVE daemon owns (codex on #506): a foreign healthy bridge is left running and this daemon is refused with the fix named', async () => {
    const root = join(dir, 'root-d');
    const owner = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    const theirs = await owner.ensure(root);
    // The sidecar names a DIFFERENT daemon that is still alive (this very test process stands in
    // for it — any live pid that is not `process.pid` of the adopting daemon would do; we spoof
    // the owner as a live helper process).
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(helper);
    const sidecar = readCrewSidecar(root)!;
    writeFileSync(join(root, CREW_SIDECAR_NAME), JSON.stringify({ ...sidecar, ownerPid: helper.pid }), 'utf8');
    const logged: string[] = [];
    const spawnsBefore = spawns.length;
    const intruder = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m));
    await expect(intruder.ensure(root)).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(intruder.ensure(root)).rejects.toThrow(/owned by another running crew daemon/);
    expect(pidAlive(theirs.pid), 'the foreign bridge must still be running').toBe(true);
    expect(spawns.length).toBe(spawnsBefore);
    expect(logged.some((m) => m.includes('NOT recycling'))).toBe(true);
    const hint = await intruder.ensure(root).catch((e: BridgeUnavailableError) => e.hint);
    expect(String(hint)).toContain('WICKED_INTERACTIVE_ROOT');
    expect(readCrewSidecar(root)?.pid).toBe(theirs.pid); // untouched
    helper.kill('SIGKILL');
  }, 60_000);

  it('ADOPTS a bridge nobody recorded (operator-run / pre-upgrade) with a warning that names the pid and the fix — never kills it', async () => {
    const root = join(dir, 'root-c');
    // An operator's own `wicked-interactive serve`: no sidecar, no crew env.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root, { recursive: true });
    const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore', env: { ...process.env } });
    children.push(child);
    await waitFor(() => existsSync(join(root, LOCK_NAME)));
    const operatorPid = lock(root).pid;
    expect(existsSync(join(root, CREW_SIDECAR_NAME))).toBe(false);

    const logged: string[] = [];
    const spawnsBefore = spawns.length;
    const pool = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') }, (m) => logged.push(m));
    const adopted = await pool.ensure(root);
    expect(adopted.pid).toBe(operatorPid);
    expect(pidAlive(operatorPid)).toBe(true);
    expect(spawns.length).toBe(spawnsBefore);
    const warning = logged.find((m) => m.includes('did not start'));
    expect(warning).toBeDefined();
    expect(warning).toContain(`kill ${operatorPid}`);
    expect(warning).toContain('WICKED_CREW_API=http://127.0.0.1:60785');
  }, 30_000);
});

describe('recycling fails closed (codex r4 on #506)', () => {
  const EPERM = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };

  it('a REFUSED signal (EPERM) refuses the start: the error names the pid and its owner, nothing is spawned, the sidecar is untouched, the bridge lives', async () => {
    const root = join(dir, 'root-eperm');
    const { pid, owner, sidecar } = await orphanedMismatch(root);
    const spawnsBefore = spawns.length;
    const logged: string[] = [];
    const successor = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m), { kill: EPERM });
    const err = await successor.ensure(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    const { message, hint } = err as BridgeUnavailableError;
    expect(message).toContain(`pid ${pid}`);
    expect(message).toContain(`daemon pid ${owner}`);
    expect(message).toContain('EPERM');
    expect(hint).toContain(`kill ${pid}`);
    expect(spawns.length, 'no replacement beside a bridge that may still be running').toBe(spawnsBefore);
    expect(sidecarBytes(root), 'the sidecar is never relabelled on a failed stop').toBe(sidecar);
    expect(pidAlive(pid)).toBe(true);
    expect(logged.some((m) => m.includes('could not stop'))).toBe(true);
  }, 30_000);

  it('a bridge STILL ALIVE after SIGTERM, the grace and SIGKILL refuses the start — bounded wait, sidecar untouched, nothing spawned', async () => {
    const root = join(dir, 'root-immortal');
    const { pid, owner, sidecar } = await orphanedMismatch(root, { FAKE_IGNORE_SIGTERM: '1' });
    const signals: string[] = [];
    const spawnsBefore = spawns.length;
    const successor = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, undefined, {
      // SIGTERM is delivered (and ignored by the bridge); SIGKILL is swallowed — an ineffective kill.
      kill: (p, sig) => {
        signals.push(sig);
        if (sig !== 'SIGKILL') process.kill(p, sig);
      },
      recycleGraceMs: 200,
      recycleHardMs: 200,
    });
    const t0 = Date.now();
    const err = await successor.ensure(root).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(5_000); // bounded, not the 3 s + 1 s production budget either
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as Error).message).toContain(`pid ${pid}`);
    expect((err as Error).message).toContain(`daemon pid ${owner}`);
    expect((err as Error).message).toContain('still running');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(spawns.length).toBe(spawnsBefore);
    expect(sidecarBytes(root)).toBe(sidecar);
    expect(pidAlive(pid), 'the immortal bridge is still there — and we said so instead of relabelling it').toBe(true);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
  }, 30_000);

  it('a replacement that answers with the RECYCLED pid is refused (the liveness probe lied), our own spawn is abandoned, the sidecar untouched', async () => {
    const root = join(dir, 'root-same-pid');
    const { pid, sidecar } = await orphanedMismatch(root, { FAKE_IGNORE_SIGTERM: '1' });
    let sleeper: ChildProcess | null = null;
    const successor = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, undefined, {
      kill: () => {}, // signals go nowhere
      alive: (p) => (p === pid ? false : pidAlive(p)), // ...and the process table claims it left
      recycleGraceMs: 50,
      recycleHardMs: 50,
      spawn: () => (sleeper = spawnSleeper()), // the "replacement" never takes the lockfile
    });
    const err = await successor.ensure(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as Error).message).toContain(`pid ${pid}`);
    expect((err as Error).message).toContain('still answering');
    expect(sidecarBytes(root)).toBe(sidecar);
    expect(sleeper).not.toBeNull();
    await waitFor(() => !pidAlive(sleeper!.pid!)); // ours, so it is stopped
    expect(pidAlive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
  }, 30_000);

  it('a FOREIGN bridge that takes the lockfile while we start is refused and never written into the sidecar; our spawn is abandoned; the foreign bridge is left alone', async () => {
    const root = join(dir, 'root-foreign');
    let sleeper: ChildProcess | null = null;
    const pool = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, undefined, {
      spawn: () => {
        sleeper = spawnSleeper();
        void operatorBridge(root); // races our start and wins the lockfile
        return sleeper;
      },
      // The lookup says: that pid's parent is some shell (4242), whose parent is the init process.
      parentOf: (p) => (p === 4242 ? 1 : 4242),
    });
    const err = await pool.ensure(root).catch((e: unknown) => e);
    const foreignPid = lock(root).pid;
    expect(foreignPid).not.toBe(sleeper!.pid);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as Error).message).toContain('did not start');
    expect((err as Error).message).toContain(`pid ${foreignPid}`);
    expect(sidecarBytes(root), 'a sidecar is a claim of ownership; none for a pid we did not spawn').toBeNull();
    await waitFor(() => !pidAlive(sleeper!.pid!));
    expect(pidAlive(foreignPid)).toBe(true);
  }, 30_000);

  it('a lineage that cannot be read is USED but not recorded — no sidecar, a log line saying so', async () => {
    const root = join(dir, 'root-unknown-lineage');
    const logged: string[] = [];
    const pool = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m), {
      spawn: (r, e) => {
        // The lockfile ends up naming a pid that is NOT the child handle we got back (an `npx` wrapper
        // would look like this) and the platform cannot tell us who its parent is.
        spawnFake(r, e);
        return spawnSleeper();
      },
      parentOf: () => null,
    });
    const bridge = await pool.ensure(root);
    expect(pidAlive(bridge.pid)).toBe(true);
    expect(sidecarBytes(root)).toBeNull();
    expect(logged.some((m) => m.includes('NOT recording'))).toBe(true);
  }, 30_000);

  it('spawnLineage: the child itself or a descendant is ours; the init process or a cycle is foreign; an unreadable hop or too many hops is unknown', () => {
    const tree = new Map<number, number>([
      [300, 200], // node ← sh
      [200, 100], // sh ← npx (the child we spawned)
      [100, 50], // npx ← this daemon
      [50, 1],
      [900, 800], // somebody else's: ← their shell
      [800, 1],
    ]);
    const parentOf = (p: number): number | null => tree.get(p) ?? null;
    expect(spawnLineage(100, 100, parentOf)).toBe('ours');
    expect(spawnLineage(300, 100, parentOf)).toBe('ours');
    expect(spawnLineage(900, 100, parentOf)).toBe('foreign');
    expect(spawnLineage(50, 100, parentOf)).toBe('foreign'); // our own ancestor is not our child
    expect(spawnLineage(777, 100, parentOf)).toBe('unknown'); // no such hop
    expect(spawnLineage(300, 100, () => null)).toBe('unknown');
    const cycle = (p: number): number | null => (p === 5 ? 6 : 5);
    expect(spawnLineage(5, 100, cycle)).toBe('foreign');
    expect(spawnLineage(1000, 100, (p) => p + 1)).toBe('unknown'); // never reaches the child within the hop budget
  });

  it('parentPidOf reads the real process table: a grandchild\'s parent is our child, our child\'s parent is this process, nonsense is null', async () => {
    // node -e spawns a sleeper and prints ITS pid, then idles — a two-hop chain like npx → node.
    const child = spawn(
      process.execPath,
      ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await waitFor(() => /^\d+$/.test(out.trim()));
    const grandchild = Number(out.trim());
    try {
      expect(parentPidOf(grandchild)).toBe(child.pid);
      expect(parentPidOf(child.pid!)).toBe(process.pid);
      expect(spawnLineage(grandchild, child.pid!, parentPidOf)).toBe('ours');
      expect(spawnLineage(process.pid, child.pid!, parentPidOf)).toBe('foreign');
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    expect(parentPidOf(0)).toBeNull();
    expect(parentPidOf(-1)).toBeNull();
    expect(parentPidOf(2 ** 22 + 12345)).toBeNull();
  }, 30_000);
});
