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
//   - `busDataDirOf` maps a bus.db path to its directory and any other spelling to null.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREW_SIDECAR_NAME,
  InteractiveBridgePool,
  LOCK_NAME,
  bridgeEnvFor,
  bridgeEnvMatches,
  busDataDirOf,
  pidAlive,
  readCrewSidecar,
} from '../../src/interactive/bridge-pool.js';
import { removeScratch } from '../setup/scratch.js';

/** The fake bridge: lockfile + /api/health reporting its root, plus a peek at the env it got. */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
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

function poolWith(env: { origin: string | null; bus: string | null }, log?: (m: string) => void): InteractiveBridgePool {
  return new InteractiveBridgePool({
    spawn: spawnFake,
    startTimeoutMs: 15_000,
    healthTimeoutMs: 1_000,
    studioOrigin: () => env.origin,
    busDataDir: env.bus,
    ...(log !== undefined ? { log } : {}),
  });
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

  it('ADOPTS a crew-started bridge whose recorded pair matches (no spawn), and RECYCLES one recorded with a DIFFERENT pair — killed, restarted with the right env, sidecar rewritten', async () => {
    const root = join(dir, 'root-b');
    const first = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') });
    const b1 = await first.ensure(root);
    const spawnsAfterFirst = spawns.length;

    // A second daemon with the SAME pair (a restart of this one) adopts silently.
    const logged: string[] = [];
    const same = poolWith({ origin: 'http://127.0.0.1:60785', bus: join(dir, 'state', 'bus') }, (m) => logged.push(m));
    const b2 = await same.ensure(root);
    expect(b2.pid).toBe(b1.pid);
    expect(spawns.length).toBe(spawnsAfterFirst);
    expect(logged).toEqual([]);

    // A daemon on ANOTHER port with ANOTHER bus (F-043's two-daemon host) must not share it:
    // the pool recycles the bridge instead of adopting a bridge that emits elsewhere.
    const sibling = poolWith({ origin: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') }, (m) => logged.push(m));
    const b3 = await sibling.ensure(root);
    expect(b3.pid).not.toBe(b1.pid);
    expect(spawns.length).toBe(spawnsAfterFirst + 1);
    await waitFor(() => !pidAlive(b1.pid));
    expect(logged.some((m) => m.includes('recycling'))).toBe(true);
    expect(await envSeenBy(root)).toEqual({ crew: 'http://127.0.0.1:7701', bus: join(dir, 'other', 'bus') });
    expect(readCrewSidecar(root)?.pid).toBe(b3.pid);
    expect(readCrewSidecar(root)?.env.WICKED_CREW_API).toBe('http://127.0.0.1:7701');
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
