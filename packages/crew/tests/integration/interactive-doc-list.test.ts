// crew#472 — interactive docs are project-scoped: partitioned default roots + the attributed list.
//
// # The bug this file pins
//
// `/projects/:projectId/interactive/*` honored `:projectId` only to look up a per-project root
// setting that NO project ever had, so every project fell through to the same default root: one
// bridge, one registry, the identical doc list under every project's URL. The live recon that
// found it asked for exactly one check the client-side tests could not give — create a doc under
// project A, list under project B, assert absence — and that check is the spine of this file.
//
// # The shape under test
//
// The production route assembly for the interactive surface — the pure-transport proxy plus the
// attributed docs list, over ONE shared pool — against a REAL child-process bridge that lists and
// creates docs ON DISK under the root it was started for (interactive's `listDocs` contract: a
// slug-named child directory carrying a `versions.json`). Only the spawn is substituted, so root
// resolution, pool keying, directory creation, and the static-over-wildcard routing all run on
// the production code paths. `home` is injected so the "default root" is a scratch dir and nothing
// touches the developer's `~/wicked-interactive`; `env` is an explicit empty object so a shell's
// `WICKED_INTERACTIVE_ROOT` can neither leak in nor mask the partition.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveBridgePool } from '../../src/interactive/bridge-pool.js';
import { defaultInteractiveRoot, PROJECTS_DIR } from '../../src/interactive/bridge-root.js';
import { registerInteractiveDocList } from '../../src/interactive/doc-list-routes.js';
import { registerInteractiveProxy } from '../../src/interactive/proxy-routes.js';
import { ProjectSettingsStore } from '../../src/projects/settings.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Project } from '../../src/core/types.js';
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

let dir: string;
let home: string;
let legacyRoot: string;
let boundRoot: string;
let app: FastifyInstance;
let base: string;
let pool: InteractiveBridgePool;
const children: ChildProcess[] = [];

function spawnFake(root: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore' });
  children.push(child);
  return child;
}

const partitionOf = (projectId: string): string => join(legacyRoot, PROJECTS_DIR, projectId);

async function listDocs(projectId: string, query = ''): Promise<{ status: number; rows: Record<string, unknown>[] }> {
  const res = await fetch(`${base}/api/v1/projects/${projectId}/interactive/api/docs${query}`);
  return { status: res.status, rows: res.status === 200 ? ((await res.json()) as Record<string, unknown>[]) : [] };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wi-doc-list-'));
  home = join(dir, 'home');
  legacyRoot = defaultInteractiveRoot(home);
  boundRoot = join(dir, 'bound-docs');

  // The pre-partition world: the legacy shared root already holds documents — the "31 docs" of
  // the live recon — including a retired one that lists only on request.
  seedDoc(legacyRoot, 'legacy-brief');
  seedDoc(legacyRoot, 'legacy-deck', { kind: 'demo' });
  seedDoc(legacyRoot, 'legacy-retired', { retired_at: '2026-09-03T00:00:00Z' });
  // A project bound to its OWN root, with a doc of its own.
  seedDoc(boundRoot, 'bound-brief');

  const settingsPath = join(dir, 'project-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ projects: { 'p-bound': { interactiveRoot: boundRoot } } }));

  pool = new InteractiveBridgePool({ spawn: spawnFake, startTimeoutMs: 15_000, healthTimeoutMs: 1_000 });
  app = Fastify({ logger: false });
  const adapter = stubAdapter(new Set(['p-a', 'p-b', 'p-bound']));
  const settings = new ProjectSettingsStore(settingsPath);
  const deps = { settings, pool, env: {}, home };
  registerInteractiveProxy(app, adapter, deps);
  registerInteractiveDocList(app, adapter, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  removeScratch(dir);
});

describe('project-partitioned default roots (crew#472)', () => {
  it('`default` lists the LEGACY set from the legacy shared root — every row attributed to it', async () => {
    const { status, rows } = await listDocs('default');
    expect(status).toBe(200);
    expect(rows.map((r) => r['name'])).toEqual(['legacy-brief', 'legacy-deck']);
    expect(rows.every((r) => r['projectId'] === 'default')).toBe(true);
    // The bridge serving Unfiled is keyed by the legacy root — byte-identical to interactive's own default.
    expect(pool.keys()).toEqual([legacyRoot]);
  }, 30_000);

  it('the DTO is the bridge row field-for-field plus `projectId`', async () => {
    const { rows } = await listDocs('default');
    const deck = rows.find((r) => r['name'] === 'legacy-deck');
    expect(deck).toEqual({
      name: 'legacy-deck',
      kind: 'demo',
      head: 2,
      versions: 2,
      updated_at: '2026-09-02T00:00:00Z',
      projectId: 'default',
    });
  });

  it('an unbound NON-default project resolves to its own partition, created on first use, and starts empty', async () => {
    expect(existsSync(partitionOf('p-a'))).toBe(false);
    const { status, rows } = await listDocs('p-a');
    expect(status).toBe(200);
    expect(rows).toEqual([]);
    expect(existsSync(partitionOf('p-a'))).toBe(true);
    // Its OWN bridge, on its own root — not the legacy bridge answering under a different URL.
    expect(new Set(pool.keys())).toEqual(new Set([legacyRoot, partitionOf('p-a')]));
  }, 30_000);

  it('create under A, list under B → absent; A lists it attributed; `default` is untouched', async () => {
    // The create still streams through the pure-transport proxy (POST is not the listed GET).
    const created = await fetch(`${base}/api/v1/projects/p-a/interactive/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a-only' }),
    });
    expect(created.status).toBe(201);
    expect(existsSync(join(partitionOf('p-a'), 'a-only', 'versions.json'))).toBe(true);

    const a = await listDocs('p-a');
    expect(a.rows.map((r) => r['name'])).toEqual(['a-only']);
    expect(a.rows[0]?.['projectId']).toBe('p-a');

    const b = await listDocs('p-b');
    expect(b.status).toBe(200);
    expect(b.rows).toEqual([]);
    expect(existsSync(partitionOf('p-b'))).toBe(true);

    // The partitions nest under the legacy root, and the legacy bridge's list does not see them:
    // `projects/` is neither slug-named nor a doc (no `versions.json`).
    const unfiled = await listDocs('default');
    expect(unfiled.rows.map((r) => r['name'])).toEqual(['legacy-brief', 'legacy-deck']);
    expect(new Set(pool.keys())).toEqual(new Set([legacyRoot, partitionOf('p-a'), partitionOf('p-b')]));
  }, 30_000);

  it('an explicit own root is honored exactly as before — no partition for a bound project', async () => {
    const { rows } = await listDocs('p-bound');
    expect(rows.map((r) => r['name'])).toEqual(['bound-brief']);
    expect(rows[0]?.['projectId']).toBe('p-bound');
    expect(existsSync(partitionOf('p-bound'))).toBe(false);
    expect(pool.keys()).toContain(boundRoot);
  }, 30_000);

  it('forwards the query string verbatim (`?includeRetired=1` surfaces the tombstoned row)', async () => {
    const { rows } = await listDocs('default', '?includeRetired=1');
    expect(rows.map((r) => r['name'])).toEqual(['legacy-brief', 'legacy-deck', 'legacy-retired']);
    const retired = rows.find((r) => r['name'] === 'legacy-retired');
    expect(retired?.['retired']).toBe(true);
    expect(retired?.['retired_at']).toBe('2026-09-03T00:00:00Z');
    expect(retired?.['projectId']).toBe('default');
  });

  it('404s an unknown project instead of manufacturing a partition for it', async () => {
    const { status } = await listDocs('p-nope');
    expect(status).toBe(404);
    expect(existsSync(partitionOf('p-nope'))).toBe(false);
  });
});
