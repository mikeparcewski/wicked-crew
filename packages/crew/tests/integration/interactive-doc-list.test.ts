// crew#472 — interactive docs are project-scoped: partitioned default roots + the attributed list.
//
// # The bug this file pins
//
// `/projects/:projectId/interactive/*` honored `:projectId` only to look up a per-project root
// setting that NO project ever had, so every project fell through to the same default root: one
// bridge, one registry, the identical doc list under every project's URL. The live recon that
// found it asked for exactly one check the client-side tests could not give — create a doc under
// project A, list under project B, assert absence — and that check is the spine of this file.
// The review of the fix (crew#474) added its sibling: a symlink planted at A's partition pointing
// at B's must be REFUSED, not followed — the id check alone said nothing about what was already
// sitting on disk at `projects/<id>`.
//
// # The shape under test
//
// The production route assembly for the interactive surface — the pure-transport proxy plus the
// attributed docs list, over ONE shared pool — against a REAL child-process bridge that lists and
// creates docs ON DISK under the root it was started for (interactive's `listDocs` contract: a
// slug-named child directory carrying a `versions.json`). Only the spawn is substituted, so root
// resolution, partition containment, pool keying, directory creation, and the static-over-wildcard
// routing all run on the production code paths.
//
// Every case gets a FRESH rig (`startRig`): its own scratch home (so the "default root" is a
// scratch dir and nothing touches the developer's `~/wicked-interactive`), settings file, pool,
// and server. Cases share nothing — no seeded doc, no cached bridge, no partition an earlier case
// created — so each states its whole precondition and can run alone or reordered. `env` is an
// explicit empty object so a shell's `WICKED_INTERACTIVE_ROOT` can neither leak in nor mask the
// partition.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveBridgePool } from '../../src/interactive/bridge-pool.js';
import { defaultInteractiveRoot, PROJECTS_DIR } from '../../src/interactive/bridge-root.js';
import { registerInteractiveDocList } from '../../src/interactive/doc-list-routes.js';
import { registerInteractiveProxy } from '../../src/interactive/proxy-routes.js';
import { ProjectSettingsStore } from '../../src/projects/settings.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Project } from '../../src/core/types.js';
import { canSymlink } from '../setup/can-symlink.js';
import { removeScratch } from '../setup/scratch.js';

/**
 * The fake bridge, as a standalone script — a genuine separate pid under `node -e`. It serves the
 * contract the pool depends on (`.wi-serve.json`, `GET /api/health` reporting its root) and the
 * two docs endpoints this file exercises, both backed by the ROOT DIRECTORY, not memory:
 *   - `GET /api/docs` mirrors interactive's `listDocs`: slug-named child dirs with a
 *     `versions.json`, retired rows only with `?includeRetired`;
 *   - `POST /api/docs {name}` creates `<root>/<name>/versions.json`.
 */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const send = (res, code, body) => res.writeHead(code, {'content-type':'application/json'}).end(JSON.stringify(body));
function listDocs(includeRetired) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DOC_NAME.test(entry.name)) continue;
    const v = join(root, entry.name, 'versions.json');
    if (!existsSync(v)) continue;
    const m = JSON.parse(readFileSync(v, 'utf8'));
    if (m.retired_at && !includeRetired) continue;
    const last = m.versions[m.versions.length - 1] || {};
    out.push({ name: entry.name, kind: m.kind || 'doc', head: m.head, versions: m.versions.length,
      updated_at: last.created_at || null, ...(m.retired_at ? { retired: true, retired_at: m.retired_at } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, root, pid: process.pid });
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    return send(res, 200, listDocs(/^(1|true)$/i.test(url.searchParams.get('includeRetired') ?? '')));
  }
  if (url.pathname === '/api/docs' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const { name } = JSON.parse(body);
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1, created_at: '2026-09-08T00:00:00Z' }] }));
      send(res, 201, { name, head: 1 });
    });
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

/** The fake bridge as a child process — a genuine separate pid. No `env:` option on purpose: the
 *  child inherits the parent env, which is how the hermetic arming (tests/setup/hermetic-home.ts)
 *  carries through; harness-hygiene.test.ts scans for the alternative. */
function spawnFake(root: string): ChildProcess {
  return spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore' });
}

/** A doc on disk exactly the way interactive leaves one: `<root>/<name>/versions.json`. */
function seedDoc(root: string, name: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'versions.json'),
    JSON.stringify({ head: 2, versions: [{ version: 1, created_at: '2026-09-01T00:00:00Z' }, { version: 2, created_at: '2026-09-02T00:00:00Z' }], ...extra }),
  );
}

/** Only existence matters to the routes; the rest is a well-formed engine row. */
function stubAdapter(known: Set<string>): CoreAdapter {
  return {
    projectGet: async (id: string): Promise<Project | null> =>
      known.has(id)
        ? { id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 0, updated_at: 0 }
        : null,
  } as unknown as CoreAdapter;
}

const KNOWN_PROJECTS = ['p-a', 'p-b', 'p-bound'];
const SYMLINKS = canSymlink();

interface Listed {
  status: number;
  /** The parsed body, whatever its status. */
  body: unknown;
  /** The rows on a 200; empty otherwise. */
  rows: Record<string, unknown>[];
}

interface Rig {
  /** The legacy shared root — `default`'s, and the parent of `projects/`. */
  legacyRoot: string;
  /** The explicit root `p-bound` is bound to through its settings row. */
  boundRoot: string;
  pool: InteractiveBridgePool;
  partitionOf(projectId: string): string;
  listDocs(projectId: string, query?: string): Promise<Listed>;
  /** `POST /api/docs` — streams through the pure-transport proxy, not the listed GET. */
  createDoc(projectId: string, name: string): Promise<Response>;
  close(): Promise<void>;
}

async function startRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'wi-doc-list-'));
  const home = join(dir, 'home');
  const legacyRoot = defaultInteractiveRoot(home);
  const boundRoot = join(dir, 'bound-docs');
  const settingsPath = join(dir, 'project-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ projects: { 'p-bound': { interactiveRoot: boundRoot } } }));

  const children: ChildProcess[] = [];
  const pool = new InteractiveBridgePool({
    spawn: (root) => {
      const child = spawnFake(root);
      children.push(child);
      return child;
    },
    startTimeoutMs: 15_000,
    healthTimeoutMs: 1_000,
  });
  const app = Fastify({ logger: false });
  const adapter = stubAdapter(new Set(KNOWN_PROJECTS));
  const deps = { settings: new ProjectSettingsStore(settingsPath), pool, env: {}, home };
  registerInteractiveProxy(app, adapter, deps);
  registerInteractiveDocList(app, adapter, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  return {
    legacyRoot,
    boundRoot,
    pool,
    partitionOf: (projectId) => join(legacyRoot, PROJECTS_DIR, projectId),
    async listDocs(projectId, query = '') {
      const res = await fetch(`${base}/api/v1/projects/${projectId}/interactive/api/docs${query}`);
      const body: unknown = await res.json();
      return { status: res.status, body, rows: res.status === 200 ? (body as Record<string, unknown>[]) : [] };
    },
    createDoc: (projectId, name) =>
      fetch(`${base}/api/v1/projects/${projectId}/interactive/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    async close() {
      await app.close();
      for (const c of children) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      removeScratch(dir);
    },
  };
}

let rig: Rig;

beforeEach(async () => {
  rig = await startRig();
}, 30_000);

afterEach(async () => {
  await rig.close();
});

describe('project-partitioned default roots (crew#472)', () => {
  it('`default` lists the LEGACY set from the legacy shared root — every row attributed to it', async () => {
    // The pre-partition world: the legacy shared root already holds documents — the "31 docs" of
    // the live recon — including a retired one that lists only on request.
    seedDoc(rig.legacyRoot, 'legacy-brief');
    seedDoc(rig.legacyRoot, 'legacy-deck', { kind: 'demo' });
    seedDoc(rig.legacyRoot, 'legacy-retired', { retired_at: '2026-09-03T00:00:00Z' });

    const { status, rows } = await rig.listDocs('default');
    expect(status).toBe(200);
    expect(rows.map((r) => r['name'])).toEqual(['legacy-brief', 'legacy-deck']);
    expect(rows.every((r) => r['projectId'] === 'default')).toBe(true);
    // The bridge serving Unfiled is keyed by the legacy root — byte-identical to interactive's own default.
    expect(rig.pool.keys()).toEqual([rig.legacyRoot]);
  }, 30_000);

  it('the DTO is the bridge row field-for-field plus `projectId`', async () => {
    seedDoc(rig.legacyRoot, 'legacy-deck', { kind: 'demo' });
    const { rows } = await rig.listDocs('default');
    expect(rows).toEqual([
      {
        name: 'legacy-deck',
        kind: 'demo',
        head: 2,
        versions: 2,
        updated_at: '2026-09-02T00:00:00Z',
        projectId: 'default',
      },
    ]);
  }, 30_000);

  it('an unbound NON-default project resolves to its own partition, created on first use, and starts empty', async () => {
    expect(existsSync(rig.partitionOf('p-a'))).toBe(false);
    const { status, rows } = await rig.listDocs('p-a');
    expect(status).toBe(200);
    expect(rows).toEqual([]);
    expect(existsSync(rig.partitionOf('p-a'))).toBe(true);
    // Its OWN bridge on its own root — the legacy root was never even asked for a bridge.
    expect(rig.pool.keys()).toEqual([rig.partitionOf('p-a')]);
  }, 30_000);

  it('create under A, list under B → absent; A lists it attributed; `default` is untouched', async () => {
    seedDoc(rig.legacyRoot, 'legacy-brief');

    const created = await rig.createDoc('p-a', 'a-only');
    expect(created.status).toBe(201);
    expect(existsSync(join(rig.partitionOf('p-a'), 'a-only', 'versions.json'))).toBe(true);

    const a = await rig.listDocs('p-a');
    expect(a.rows.map((r) => r['name'])).toEqual(['a-only']);
    expect(a.rows[0]?.['projectId']).toBe('p-a');

    const b = await rig.listDocs('p-b');
    expect(b.status).toBe(200);
    expect(b.rows).toEqual([]);
    expect(existsSync(rig.partitionOf('p-b'))).toBe(true);

    // The partitions nest under the legacy root, and the legacy bridge's list does not see them:
    // `projects/` is neither slug-named nor a doc (no `versions.json`).
    const unfiled = await rig.listDocs('default');
    expect(unfiled.rows.map((r) => r['name'])).toEqual(['legacy-brief']);
    expect(new Set(rig.pool.keys())).toEqual(new Set([rig.legacyRoot, rig.partitionOf('p-a'), rig.partitionOf('p-b')]));
  }, 45_000);

  it('an explicit own root is honored exactly as before — no partition for a bound project', async () => {
    seedDoc(rig.boundRoot, 'bound-brief');
    const { rows } = await rig.listDocs('p-bound');
    expect(rows.map((r) => r['name'])).toEqual(['bound-brief']);
    expect(rows[0]?.['projectId']).toBe('p-bound');
    expect(existsSync(rig.partitionOf('p-bound'))).toBe(false);
    expect(rig.pool.keys()).toEqual([rig.boundRoot]);
  }, 30_000);

  it('forwards the query string verbatim (`?includeRetired=1` surfaces the tombstoned row)', async () => {
    seedDoc(rig.legacyRoot, 'legacy-brief');
    seedDoc(rig.legacyRoot, 'legacy-retired', { retired_at: '2026-09-03T00:00:00Z' });

    const plain = await rig.listDocs('default');
    expect(plain.rows.map((r) => r['name'])).toEqual(['legacy-brief']);

    const { rows } = await rig.listDocs('default', '?includeRetired=1');
    expect(rows.map((r) => r['name'])).toEqual(['legacy-brief', 'legacy-retired']);
    const retired = rows.find((r) => r['name'] === 'legacy-retired');
    expect(retired?.['retired']).toBe(true);
    expect(retired?.['retired_at']).toBe('2026-09-03T00:00:00Z');
    expect(retired?.['projectId']).toBe('default');
  }, 30_000);

  it('404s an unknown project instead of manufacturing a partition for it', async () => {
    const { status } = await rig.listDocs('p-nope');
    expect(status).toBe(404);
    expect(existsSync(rig.partitionOf('p-nope'))).toBe(false);
    expect(rig.pool.keys()).toEqual([]);
  });
});

describe('partition containment (crew#474 — a symlinked projects/<id> is refused, never followed)', () => {
  it.skipIf(!SYMLINKS)(
    "a symlink planted at projects/A → B's partition: A is refused with a 500 naming the link; B's docs stay B's",
    async () => {
      // B exists and holds a doc — the thing a link at A would expose under A's URL.
      const first = await rig.listDocs('p-b');
      expect(first.status).toBe(200);
      seedDoc(rig.partitionOf('p-b'), 'b-secret');
      symlinkSync(rig.partitionOf('p-b'), rig.partitionOf('p-a'), 'dir');

      const a = await rig.listDocs('p-a');
      expect(a.status).toBe(500);
      const message = String((a.body as { message?: unknown }).message);
      expect(message).toMatch(/is a symbolic link/);
      expect(message).toContain(rig.partitionOf('p-a'));
      expect(message).toContain('"p-a"');
      // No bridge was ever started on the link: the pool knows B's real partition only.
      expect(rig.pool.keys()).toEqual([rig.partitionOf('p-b')]);

      // The proxy shares the resolution, so a create under A is refused the same way — nothing
      // lands in B through A's URL.
      const created = await rig.createDoc('p-a', 'a-into-b');
      expect(created.status).toBe(500);
      expect(existsSync(join(rig.partitionOf('p-b'), 'a-into-b'))).toBe(false);

      // B itself is unaffected.
      const again = await rig.listDocs('p-b');
      expect(again.rows.map((r) => r['name'])).toEqual(['b-secret']);
      expect(again.rows[0]?.['projectId']).toBe('p-b');
    },
    30_000,
  );

  it('a REAL directory already at projects/<id> is served as before — the guard costs a normal project nothing', async () => {
    mkdirSync(rig.partitionOf('p-a'), { recursive: true });
    seedDoc(rig.partitionOf('p-a'), 'a-brief');
    const a = await rig.listDocs('p-a');
    expect(a.status).toBe(200);
    expect(a.rows.map((r) => r['name'])).toEqual(['a-brief']);
    expect(a.rows[0]?.['projectId']).toBe('p-a');
    expect(rig.pool.keys()).toEqual([rig.partitionOf('p-a')]);
  }, 30_000);
});
