// Root resolution + bridge-pool KEYING (DES-MERGE-001 §7.1/§7.2).
//
// These two are tested together on purpose: the resolved root IS the pool key, so a resolution
// bug and a keying bug have the same symptom — a second `wicked-interactive serve` on a second
// port for a directory that already has one. The pool tests below never spawn anything real;
// they substitute a fake spawn and a fake lockfile so the discovery/health/reuse logic is
// exercised without a child process.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import {
  checkPartitionedInteractiveRoot,
  defaultInteractiveRoot,
  ensureProjectInteractiveRoot,
  InteractivePartitionRefusedError,
  partitionedInteractiveRoot,
  partitionsBase,
  preparePartitionedInteractiveRoot,
  PROJECTS_DIR,
  resolveInteractiveRoot,
  resolveProjectInteractiveRoot,
  ROOT_ENV,
} from '../src/interactive/bridge-root.js';
import { canSymlink } from './setup/can-symlink.js';
import { readDocHead } from '../src/interactive/chat-events.js';
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

describe('resolveProjectInteractiveRoot (crew#472 — the default root is partitioned by project)', () => {
  const LEGACY = defaultInteractiveRoot(HOME);

  it('the synthesized `default` project keeps the LEGACY shared root — no data migration', () => {
    for (const setting of [null, undefined, {}, { interactiveRoot: null }, { interactiveRoot: '  ' }]) {
      expect(resolveProjectInteractiveRoot('default', setting, NO_ENV, HOME)).toBe(LEGACY);
    }
    // No project identity at all (an event carrying no `project_id`) belongs to Unfiled too.
    expect(resolveProjectInteractiveRoot(undefined, null, NO_ENV, HOME)).toBe(LEGACY);
  });

  it('every other unbound project gets its OWN partition under the default root', () => {
    expect(resolveProjectInteractiveRoot('p-1', null, NO_ENV, HOME)).toBe(join(LEGACY, PROJECTS_DIR, 'p-1'));
    expect(resolveProjectInteractiveRoot('p-1', {}, NO_ENV, HOME)).toBe(partitionedInteractiveRoot('p-1', HOME));
    // An engine-minted id is a plain path segment.
    expect(resolveProjectInteractiveRoot('proj_000000000000100001', null, NO_ENV, HOME)).toBe(
      join(LEGACY, PROJECTS_DIR, 'proj_000000000000100001'),
    );
    // Two projects ⇒ two pool keys, neither of them the legacy root: the leak this closes was
    // three spellings of one directory.
    const keys = new Set(
      ['default', 'p-1', 'p-2'].map((id) => resolveProjectInteractiveRoot(id, null, NO_ENV, HOME)),
    );
    expect(keys.size).toBe(3);
  });

  it('an explicit own root still wins for every project, `default` included', () => {
    expect(resolveProjectInteractiveRoot('p-1', { interactiveRoot: '/srv/decks' }, NO_ENV, HOME)).toBe('/srv/decks');
    expect(resolveProjectInteractiveRoot('p-1', { interactiveRoot: '~/decks' }, NO_ENV, HOME)).toBe(join(HOME, 'decks'));
    expect(resolveProjectInteractiveRoot('default', { interactiveRoot: '/srv/unfiled' }, NO_ENV, HOME)).toBe(
      '/srv/unfiled',
    );
  });

  it('WICKED_INTERACTIVE_ROOT is an explicit SHARED binding — while set, nothing partitions', () => {
    // Exactly the pre-#472 behavior: the env names one root for every unbound project (the e2e
    // rigs point crew at the bridge root they started), so it takes precedence over the partition.
    const env = { [ROOT_ENV]: '/scratch/docs' };
    expect(resolveProjectInteractiveRoot('default', null, env, HOME)).toBe('/scratch/docs');
    expect(resolveProjectInteractiveRoot('p-1', null, env, HOME)).toBe('/scratch/docs');
    // ...and an explicit project binding still beats the env.
    expect(resolveProjectInteractiveRoot('p-1', { interactiveRoot: '/srv/decks' }, env, HOME)).toBe('/srv/decks');
  });

  it('refuses an id that cannot name a directory instead of falling back to the shared root', () => {
    // A silent fallback here would quietly re-open the cross-project leak; loud is the only option.
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', ' ', '-x', '.hidden']) {
      expect(() => partitionedInteractiveRoot(bad, HOME)).toThrow(/cannot name an interactive docs partition/);
      expect(() => resolveProjectInteractiveRoot(bad, null, NO_ENV, HOME)).toThrow();
    }
    // The partition never escapes the projects dir.
    expect(partitionedInteractiveRoot('a..', HOME)).toBe(join(LEGACY, PROJECTS_DIR, 'a..'));
  });
});

describe('partition containment on REAL paths (a symlinked projects/<id> is refused, never followed)', () => {
  // The lexical check above proves an ID cannot spell its way out of `projects/`. It says nothing
  // about what is already sitting at `projects/<id>`: a symlink there would be followed by the
  // bridge into whatever it points at — another project's partition included. These cases run on
  // a real scratch home because the guard is about the disk, not the string.
  const SYMLINKS = canSymlink();
  let home: string;
  let base: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wi-partition-'));
    base = partitionsBase(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('materializes a missing partition as a REAL directory and returns the lexical path (the pool key)', () => {
    const root = preparePartitionedInteractiveRoot('p-a', home);
    expect(root).toBe(partitionedInteractiveRoot('p-a', home));
    expect(root).toBe(join(base, 'p-a'));
    const st = lstatSync(root);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    // Idempotent: a second resolution finds the directory and keeps what is in it.
    writeFileSync(join(root, 'marker'), '');
    expect(preparePartitionedInteractiveRoot('p-a', home)).toBe(root);
    expect(existsSync(join(root, 'marker'))).toBe(true);
    // The guarded project-level resolver gives the same answer for an unbound non-default project.
    expect(ensureProjectInteractiveRoot('p-a', null, NO_ENV, home)).toBe(root);
  });

  it.skipIf(!SYMLINKS)("refuses a symlink planted at projects/A that points at ANOTHER project's partition", () => {
    // B exists and holds a doc — the thing a link at A would expose to A's URL.
    const b = preparePartitionedInteractiveRoot('p-b', home);
    mkdirSync(join(b, 'b-secret'), { recursive: true });
    writeFileSync(join(b, 'b-secret', 'versions.json'), '{}');
    symlinkSync(b, join(base, 'p-a'), 'dir');

    const attempt = (): string => preparePartitionedInteractiveRoot('p-a', home);
    expect(attempt).toThrow(InteractivePartitionRefusedError);
    expect(attempt).toThrow(/is a symbolic link/);
    expect(attempt).toThrow(join(base, 'p-a'));
    expect(() => ensureProjectInteractiveRoot('p-a', null, NO_ENV, home)).toThrow(InteractivePartitionRefusedError);
    // The seams' resolver refuses the SAME link (Copilot on #474): it used to answer lexically,
    // which left the event seams following a link the routes refused. One walk, both callers.
    expect(() => resolveProjectInteractiveRoot('p-a', null, NO_ENV, home)).toThrow(InteractivePartitionRefusedError);
    expect(() => checkPartitionedInteractiveRoot('p-a', home)).toThrow(/is a symbolic link/);
    // B is untouched, and the refusal is a server-side 500 that names the path — not a client error.
    expect(existsSync(join(b, 'b-secret', 'versions.json'))).toBe(true);
    let err: unknown;
    try {
      attempt();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InteractivePartitionRefusedError);
    expect((err as InteractivePartitionRefusedError).statusCode).toBe(500);
    expect((err as InteractivePartitionRefusedError).path).toBe(join(base, 'p-a'));
    expect((err as InteractivePartitionRefusedError).projectId).toBe('p-a');
  });

  it.skipIf(!SYMLINKS)('refuses a symlink that leaves the projects base entirely', () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(base, { recursive: true });
    symlinkSync(elsewhere, join(base, 'p-a'), 'dir');
    expect(() => preparePartitionedInteractiveRoot('p-a', home)).toThrow(/is a symbolic link/);
  });

  it.skipIf(!SYMLINKS)('refuses a DANGLING symlink too — nothing is ever created through it', () => {
    mkdirSync(base, { recursive: true });
    symlinkSync(join(home, 'never-there'), join(base, 'p-a'), 'dir');
    expect(() => preparePartitionedInteractiveRoot('p-a', home)).toThrow(/is a symbolic link/);
    expect(existsSync(join(home, 'never-there'))).toBe(false);
  });

  it('refuses a regular file squatting on the partition path', () => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'p-a'), 'not a directory');
    expect(() => preparePartitionedInteractiveRoot('p-a', home)).toThrow(/is not a directory/);
  });

  it("never touches the disk for `default` or an explicit root — those are the operator's to place", () => {
    // A home that does not exist: any fs work on these paths would throw or create it.
    const ghost = join(home, 'ghost-home');
    expect(ensureProjectInteractiveRoot('default', null, NO_ENV, ghost)).toBe(defaultInteractiveRoot(ghost));
    expect(ensureProjectInteractiveRoot(undefined, null, NO_ENV, ghost)).toBe(defaultInteractiveRoot(ghost));
    expect(ensureProjectInteractiveRoot('p-a', { interactiveRoot: '/srv/decks' }, NO_ENV, ghost)).toBe('/srv/decks');
    expect(ensureProjectInteractiveRoot('p-a', null, { [ROOT_ENV]: '/scratch/docs' }, ghost)).toBe('/scratch/docs');
    expect(existsSync(ghost)).toBe(false);
  });
});

describe('the event seams resolve through the SAME containment, creating nothing (crew#474, Copilot)', () => {
  // `server.ts` wires the edit/demo/chat seams' `resolveDocsRoot` to `resolveProjectInteractiveRoot`
  // over the project's setting. Before this fix that resolver was lexical: the routes refused a
  // symlinked `projects/<id>` while the seams followed it. These cases wire the closure exactly
  // as the server does (`interactiveDocsRoot`), over a real scratch home.
  const SYMLINKS = canSymlink();
  let home: string;
  let base: string;
  const settings = { get: (): null => null };
  const interactiveDocsRoot = (projectId: string | undefined): string =>
    resolveProjectInteractiveRoot(projectId, projectId !== undefined ? settings.get(projectId) : null, NO_ENV, home);
  const manifest = JSON.stringify({ kind: 'demo', head: 0, versions: [{ version: 0, html_file: '_v0.html' }] });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wi-seam-'));
    base = partitionsBase(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('a partition that does not exist yet is returned as spelled and NOT created — a reader mints nothing', () => {
    expect(interactiveDocsRoot('p-a')).toBe(join(base, 'p-a'));
    expect(existsSync(join(base, 'p-a'))).toBe(false);
    expect(existsSync(base)).toBe(false);
    // …and once the routes materialized it, the seam sees the same directory.
    const root = ensureProjectInteractiveRoot('p-a', null, NO_ENV, home);
    expect(interactiveDocsRoot('p-a')).toBe(root);
    expect(lstatSync(root).isDirectory()).toBe(true);
  });

  it.skipIf(!SYMLINKS)("a symlinked projects/A → B's partition is REFUSED on the seam path — B's manifest is never read through A", () => {
    const b = ensureProjectInteractiveRoot('p-b', null, NO_ENV, home);
    mkdirSync(join(b, 'b-secret'));
    writeFileSync(join(b, 'b-secret', 'versions.json'), manifest);
    symlinkSync(b, join(base, 'p-a'), 'dir');

    // What the lexical answer exposed: A's spelled partition reads B's doc.
    expect(readDocHead(partitionedInteractiveRoot('p-a', home), 'b-secret')?.kind).toBe('demo');
    // The seam's resolver refuses before any read can happen, naming the link.
    let err: unknown;
    try {
      interactiveDocsRoot('p-a');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InteractivePartitionRefusedError);
    expect((err as InteractivePartitionRefusedError).path).toBe(join(base, 'p-a'));
    expect((err as InteractivePartitionRefusedError).projectId).toBe('p-a');
    expect((err as Error).message).toMatch(/is a symbolic link/);
    // B's own project still resolves to B, and B's doc is readable there; B is untouched.
    expect(interactiveDocsRoot('p-b')).toBe(b);
    expect(readDocHead(interactiveDocsRoot('p-b'), 'b-secret')?.kind).toBe('demo');
    expect(existsSync(join(b, 'b-secret', 'versions.json'))).toBe(true);
  });

  it.skipIf(!SYMLINKS)('a link that leaves the projects base and a DANGLING link are refused on the seam path too', () => {
    mkdirSync(base, { recursive: true });
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(base, 'p-out'), 'dir');
    symlinkSync(join(home, 'never-there'), join(base, 'p-dangling'), 'dir');
    expect(() => interactiveDocsRoot('p-out')).toThrow(/is a symbolic link/);
    expect(() => interactiveDocsRoot('p-dangling')).toThrow(/is a symbolic link/);
    expect(existsSync(join(home, 'never-there'))).toBe(false);
  });

  it('a regular file squatting on the partition path is refused on the seam path', () => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'p-file'), 'not a directory');
    expect(() => interactiveDocsRoot('p-file')).toThrow(/is not a directory/);
  });

  it('`default`, an absent project id and an explicit root never touch the disk on the seam path either', () => {
    const ghost = join(home, 'ghost-home');
    expect(resolveProjectInteractiveRoot('default', null, NO_ENV, ghost)).toBe(defaultInteractiveRoot(ghost));
    expect(resolveProjectInteractiveRoot(undefined, null, NO_ENV, ghost)).toBe(defaultInteractiveRoot(ghost));
    expect(resolveProjectInteractiveRoot('p-a', { interactiveRoot: '/srv/decks' }, NO_ENV, ghost)).toBe('/srv/decks');
    expect(resolveProjectInteractiveRoot('p-a', null, NO_ENV, ghost)).toBe(partitionedInteractiveRoot('p-a', ghost));
    expect(existsSync(ghost)).toBe(false);
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
