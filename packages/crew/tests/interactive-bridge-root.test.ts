// Root resolution + bridge-pool KEYING (DES-MERGE-001 §7.1/§7.2).
//
// These two are tested together on purpose: the resolved root IS the pool key, so a resolution
// bug and a keying bug have the same symptom — a second `wicked-interactive serve` on a second
// port for a directory that already has one. The pool tests below never spawn anything real;
// they substitute a fake spawn and a fake lockfile so the discovery/health/reuse logic is
// exercised without a child process.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import {
  defaultInteractiveRoot,
  resolveInteractiveRoot,
  ROOT_ENV,
} from '../src/interactive/bridge-root.js';
import {
  BridgeUnavailableError,
  InteractiveBridgePool,
  LOCK_NAME,
  pidAlive,
  readLock,
  INTERACTIVE_SPEC,
} from '../src/interactive/bridge-pool.js';

const NO_ENV: Record<string, string | undefined> = {};
const HOME = '/home/tester';

describe('resolveInteractiveRoot (§7.1)', () => {
  it("defaults to wicked-interactive serve's own canonical root", () => {
    // Byte-identical to bin/wicked-interactive.js:181 — this is what makes an operator's
    // already-running default bridge ADOPTABLE instead of duplicated.
    expect(defaultInteractiveRoot(HOME)).toBe(resolve(HOME, 'wicked-interactive', 'docs'));
    expect(resolveInteractiveRoot(null, NO_ENV, HOME)).toBe(defaultInteractiveRoot(HOME));
  });

  it('treats null / absent / blank as "use the shared default"', () => {
    for (const setting of [null, undefined, '', '   ']) {
      expect(resolveInteractiveRoot({ interactiveRoot: setting }, NO_ENV, HOME)).toBe(
        defaultInteractiveRoot(HOME),
      );
    }
    expect(resolveInteractiveRoot({}, NO_ENV, HOME)).toBe(defaultInteractiveRoot(HOME));
  });

  it('honors an explicit per-project root, expanding ~', () => {
    expect(resolveInteractiveRoot({ interactiveRoot: '/srv/decks' }, NO_ENV, HOME)).toBe('/srv/decks');
    expect(resolveInteractiveRoot({ interactiveRoot: '~/decks' }, NO_ENV, HOME)).toBe(join(HOME, 'decks'));
    expect(resolveInteractiveRoot({ interactiveRoot: '~' }, NO_ENV, HOME)).toBe(resolve(HOME));
  });

  it('collapses every spelling of one directory to ONE key', () => {
    // The anti-"why is it on 5 ports" guard: if these diverged, each spelling would start its
    // own bridge for the same docs.
    const spellings = ['~/decks', join(HOME, 'decks'), `${join(HOME, 'decks')}/`, join(HOME, 'x', '..', 'decks')];
    const keys = new Set(spellings.map((r) => resolveInteractiveRoot({ interactiveRoot: r }, NO_ENV, HOME)));
    expect([...keys]).toEqual([join(HOME, 'decks')]);
  });

  it('lets WICKED_INTERACTIVE_ROOT move the SHARED DEFAULT but never override a project', () => {
    const env = { [ROOT_ENV]: '/scratch/docs' };
    expect(resolveInteractiveRoot(null, env, HOME)).toBe('/scratch/docs');
    expect(resolveInteractiveRoot({ interactiveRoot: null }, env, HOME)).toBe('/scratch/docs');
    // An explicit project binding still wins — the env only names the default.
    expect(resolveInteractiveRoot({ interactiveRoot: '/srv/decks' }, env, HOME)).toBe('/srv/decks');
  });
});

describe('bridge pool keying + discovery (§7.2)', () => {
  let dir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wi-pool-'));
  });
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal stand-in for a live bridge: answers `/api/health` reporting `root`. */
  async function fakeBridge(root: string, reportRoot = root): Promise<number> {
    const server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, root: reportRoot, pid: process.pid }));
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    // The lockfile is written by the bridge itself in production; here we write it for the fake.
    writeFileSync(
      join(root, LOCK_NAME),
      JSON.stringify({ port, host: '127.0.0.1', pid: process.pid, startedAt: new Date().toISOString() }),
    );
    return port;
  }

  it('reads a well-formed lockfile and rejects a malformed one', () => {
    expect(readLock(dir)).toBeNull(); // absent
    writeFileSync(join(dir, LOCK_NAME), 'not json');
    expect(readLock(dir)).toBeNull();
    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ port: 4400 })); // no pid
    expect(readLock(dir)).toBeNull();
    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ port: 4400, pid: 42 }));
    expect(readLock(dir)).toEqual({ host: '127.0.0.1', port: 4400, pid: 42 });
  });

  it('pidAlive is honest about this process and about a pid that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });

  it('adopts an already-running bridge without spawning anything', async () => {
    const port = await fakeBridge(dir);
    let spawned = 0;
    const pool = new InteractiveBridgePool({
      spawn: () => {
        spawned++;
        return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
      },
    });
    const bridge = await pool.ensure(dir);
    expect(bridge.port).toBe(port);
    expect(spawned).toBe(0); // reuse-or-start chose REUSE
  });

  it('two projects sharing the resolved root share ONE bridge; a distinct root does not', async () => {
    const other = mkdtempSync(join(tmpdir(), 'wi-pool-other-'));
    try {
      const sharedPort = await fakeBridge(dir);
      const otherPort = await fakeBridge(other);
      const pool = new InteractiveBridgePool({});

      // Two projects, both unbound → both resolve to the same root → the same bridge.
      const env = { [ROOT_ENV]: dir };
      const a = await pool.ensure(resolveInteractiveRoot({ interactiveRoot: null }, env, HOME));
      const b = await pool.ensure(resolveInteractiveRoot({}, env, HOME));
      expect(a.port).toBe(sharedPort);
      expect(b.port).toBe(sharedPort);
      expect(b.pid).toBe(a.pid);
      expect(pool.keys()).toEqual([dir]);

      // A project bound elsewhere gets its OWN bridge — multi-root is in scope from slice 1.
      const c = await pool.ensure(resolveInteractiveRoot({ interactiveRoot: other }, env, HOME));
      expect(c.port).toBe(otherPort);
      expect(c.port).not.toBe(sharedPort);
      expect(new Set(pool.keys())).toEqual(new Set([dir, other]));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses to adopt a bridge that reports a DIFFERENT root (recycled port)', async () => {
    // Identity check, ADR-0025: the port in our lockfile now belongs to somebody else's service.
    await fakeBridge(dir, '/some/other/root');
    const pool = new InteractiveBridgePool({
      spawn: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
      startTimeoutMs: 200,
      healthTimeoutMs: 100,
    });
    await expect(pool.ensure(dir)).rejects.toThrow();
  });

  it('a burst of concurrent first requests starts ONE bridge, not N', async () => {
    let spawned = 0;
    const pool = new InteractiveBridgePool({
      spawn: () => {
        spawned++;
        // Become discoverable only after the callers have all queued up.
        void fakeBridge(dir);
        return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
      },
      startTimeoutMs: 5_000,
      healthTimeoutMs: 500,
    });
    const all = await Promise.all([pool.ensure(dir), pool.ensure(dir), pool.ensure(dir)]);
    expect(spawned).toBe(1);
    expect(new Set(all.map((b) => b.port)).size).toBe(1);
  });

  it('fails to a BridgeUnavailableError naming a REAL command when start is impossible', async () => {
    const pool = new InteractiveBridgePool({
      spawn: () => {
        const child = { on: (ev: string, fn: (e: Error) => void) => { if (ev === 'error') setTimeout(() => fn(new Error('spawn npx ENOENT')), 5); }, unref: () => undefined };
        return child as unknown as ChildProcess;
      },
      startTimeoutMs: 2_000,
      healthTimeoutMs: 100,
    });
    const err = await pool.ensure(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    // The hint has to be runnable, not "try again".
    expect((err as BridgeUnavailableError).hint).toContain(`npx ${INTERACTIVE_SPEC} serve --root ${dir}`);
  });

  it('creates a missing docs root rather than failing the spawn opaquely', async () => {
    const missing = join(dir, 'nested', 'docs');
    expect(existsSync(missing)).toBe(false);
    const pool = new InteractiveBridgePool({
      spawn: () => {
        void fakeBridge(missing);
        return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
      },
      startTimeoutMs: 5_000,
      healthTimeoutMs: 500,
    });
    await pool.ensure(missing);
    expect(existsSync(join(missing, LOCK_NAME))).toBe(true);
  });
});
