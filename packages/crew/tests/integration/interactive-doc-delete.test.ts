// `DELETE /api/v1/projects/:projectId/interactive/docs/:doc` end to end (crew#338 — the crew
// half of studio#119; the bridge half is interactive#189).
//
// The bridge here is a REAL child process implementing interactive#189's retire wire — retire
// with tombstone semantics, idempotent repeat, 404 unknown, 409 build-in-flight, list excluding
// retired docs — because the behaviors under test are cross-STORE: after one governed DELETE,
// interactive's store must say retired AND crew's handoff ledgers must have dropped their rows,
// and every divergence between those halves must be loud in the response.
//
// What this pins, in contract order:
//   - governed DELETE → 200: the bridge's retire body relayed verbatim + crew's ledger report;
//     both key grammars dropped (draft `<doc>`, edit `<doc>:v<n>`); the doc gone from the
//     proxied list, still visible with ?includeRetired=1; the action audited
//   - repeat DELETE → 200 {already_retired:true}, no event_id, empty sweep (idempotent)
//   - the bridge's 404 is relayed TRUTHFULLY — and ghost ledger rows are still swept
//     (a hand-rm'd workspace is exactly a 404 with rows to drop)
//   - the bridge's 409 (build in flight) is relayed verbatim and NOTHING is swept
//   - a bridge 5xx → 502, ledger deliberately untouched (`skipped: true` — nothing diverged)
//   - PARTIAL failure is LOUD: retire succeeded but the sweep failed → 500 naming both halves
//   - an invalid slug and an unknown project 404 without a bridge call
//   - the raw proxy path (`DELETE .../interactive/api/docs/:doc`) still flows VERBATIM through
//     the pure-transport proxy — the governed route shadows only its own static segment

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveBridgePool } from '../../src/interactive/bridge-pool.js';
import { registerInteractiveProxy } from '../../src/interactive/proxy-routes.js';
import { registerInteractiveDocDelete } from '../../src/interactive/doc-delete-routes.js';
import { InteractiveHandoffLedger } from '../../src/interactive/ledger.js';
import { sweepDocLedgers, type DocLedgerSweep } from '../../src/interactive/doc-ledger-sweep.js';
import { ProjectSettingsStore } from '../../src/projects/settings.js';
import { AuditLog } from '../../src/api/audit.js';
import { LOCAL_ACTOR } from '../../src/api/auth.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Actor, Project } from '../../src/core/types.js';

/**
 * The fake bridge: interactive#189's retire wire over a genuine separate pid. Docs live in
 * memory (`docs` map name → {kind, head, versions, retired_at|null}); the lockfile + /api/health
 * contract is what the pool discovers it by.
 */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
const docs = new Map([
  ['doc-live',  { kind: 'doc',  head: 3, versions: 4, retired_at: null }],
  ['doc-live-2',{ kind: 'html', head: 1, versions: 2, retired_at: null }],
  ['doc-raw',   { kind: 'doc',  head: 0, versions: 1, retired_at: null }],
  ['doc-busy',  { kind: 'source', head: 2, versions: 3, retired_at: null }],
  ['doc-500',   { kind: 'doc',  head: 0, versions: 1, retired_at: null }],
]);
let nextEventId = 77;
const send = (res, code, body) => res.writeHead(code, {'content-type':'application/json'}).end(JSON.stringify(body));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, root, pid: process.pid });
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    const includeRetired = /^(1|true)$/i.test(url.searchParams.get('includeRetired') ?? '');
    const rows = [];
    for (const [name, d] of docs) {
      if (d.retired_at !== null && !includeRetired) continue;
      rows.push({ name, kind: d.kind, head: d.head, versions: d.versions, updated_at: '2026-09-01T00:00:00Z',
        ...(d.retired_at !== null ? { retired: true, retired_at: d.retired_at } : {}) });
    }
    return send(res, 200, rows);
  }
  const m = url.pathname.match(/^\\/api\\/docs\\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const name = m[1];
    const d = docs.get(name);
    if (!d) return send(res, 404, { error: 'unknown doc' });
    if (name === 'doc-busy') return send(res, 409, {
      error: 'doc has a build in flight — wait for it to finish (or cancel the run in crew), then retire',
      document_id: name, active: true, run: { id: 'run-9', workflow_id: 'interactive-draft', status: 'executing' }, status: null,
    });
    if (name === 'doc-500') return send(res, 500, { error: 'tombstone write failed (simulated)' });
    if (d.retired_at !== null) return send(res, 200, {
      name, kind: d.kind, retired: true, already_retired: true, retired_at: d.retired_at,
      head: d.head, versions: d.versions,
    });
    d.retired_at = new Date().toISOString();
    return send(res, 200, {
      name, kind: d.kind, retired: true, already_retired: false, retired_at: d.retired_at,
      head: d.head, versions: d.versions, event_id: nextEventId++,
    });
  }
  send(res, 404, { error: 'not found' });
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(root, '.wi-serve.json'), JSON.stringify({
    port: server.address().port, host: '127.0.0.1', pid: process.pid,
    startedAt: new Date().toISOString(), version: 'fake-189',
  }));
});
`;

let dir: string;
let app: FastifyInstance;
let base: string;
let audit: AuditLog;
let draftLedgerPath: string;
let editLedgerPath: string;
let chatLedgerPath: string;
let demoLedgerPath: string;
const children: ChildProcess[] = [];

function spawnFake(root: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function stubAdapter(known: Set<string>): CoreAdapter {
  return {
    projectGet: async (id: string): Promise<Project | null> =>
      known.has(id)
        ? { id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 0, updated_at: 0 }
        : null,
  } as unknown as CoreAdapter;
}

const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

/** The REAL four-ledger sweep over this test's temp files — what createServer wires in prod. */
function realSweep(documentId: string): DocLedgerSweep {
  return sweepDocLedgers(documentId, [
    { name: 'draft', path: draftLedgerPath },
    { name: 'edit', path: editLedgerPath },
    { name: 'chat', path: chatLedgerPath },
    { name: 'demo', path: demoLedgerPath },
  ]);
}

function ledgerKeys(path: string): string[] {
  try {
    return Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { docs: Record<string, unknown> }).docs);
  } catch {
    return [];
  }
}

async function del(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: 'DELETE' });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function listDocs(query = ''): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/v1/projects/p-a/interactive/api/docs${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wi-docdel-'));
  const sharedRoot = join(dir, 'shared-docs');
  draftLedgerPath = join(dir, 'draft-ledger.json');
  editLedgerPath = join(dir, 'edit-ledger.json');
  chatLedgerPath = join(dir, 'chat-ledger.json');
  demoLedgerPath = join(dir, 'demo-ledger.json');

  // Crew's rows for the docs under test, in their REAL grammars: the draft leg keyed by doc id,
  // the edit leg by `<doc>:v<version>`, the chat leg by `<doc>:m:<msgId>`.
  const draft = new InteractiveHandoffLedger(draftLedgerPath);
  draft.recordLaunch('doc-live', 'run-d1');
  draft.recordLaunch('ghost-doc', 'run-d2'); // workspace hand-rm'd — the studio#119 mess
  draft.recordLaunch('doc-busy', 'run-d3');
  draft.recordLaunch('doc-500', 'run-d4');
  const edit = new InteractiveHandoffLedger(editLedgerPath);
  edit.recordLaunch('doc-live:v2', 'run-e1');
  edit.recordLaunch('doc-busy:v1', 'run-e2');
  const chat = new InteractiveHandoffLedger(chatLedgerPath);
  chat.recordLaunch('doc-live:m:msg-1', 'run-c1');

  const pool = new InteractiveBridgePool({ spawn: spawnFake, startTimeoutMs: 15_000, healthTimeoutMs: 1_000 });
  audit = new AuditLog(join(dir, 'audit.log'));
  app = Fastify({ logger: false });
  const adapter = stubAdapter(new Set(['p-a']));
  const settings = new ProjectSettingsStore(join(dir, 'project-settings.json'));
  const env = { WICKED_INTERACTIVE_ROOT: sharedRoot };
  registerInteractiveProxy(app, adapter, { settings, pool, env });
  registerInteractiveDocDelete(app, adapter, {
    settings,
    pool,
    audit,
    actorOf,
    dropDocLedgerRows: realSweep,
    env,
  });
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
  rmSync(dir, { recursive: true, force: true });
});

describe('governed doc delete — the happy path changes BOTH stores', () => {
  it('DELETE → 200: bridge retire body + ledger report; both stores prove it', async () => {
    // Before: on crew's docs wire (the proxied list)…
    expect((await listDocs()).map((d) => d['name'])).toContain('doc-live');
    // …and in crew's ledgers under both grammars.
    expect(ledgerKeys(draftLedgerPath)).toContain('doc-live');
    expect(ledgerKeys(editLedgerPath)).toContain('doc-live:v2');

    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/doc-live');
    expect(status).toBe(200);
    // The bridge's own retire answer, relayed verbatim…
    expect(json['name']).toBe('doc-live');
    expect(json['retired']).toBe(true);
    expect(json['already_retired']).toBe(false);
    expect(typeof json['retired_at']).toBe('string');
    expect(json['head']).toBe(3);
    expect(json['versions']).toBe(4);
    expect(typeof json['event_id']).toBe('number');
    // …plus crew's half, named: every grammar's row dropped.
    const ledger = json['ledger'] as { ok: boolean; removed_keys: string[] };
    expect(ledger.ok).toBe(true);
    expect(ledger.removed_keys.sort()).toEqual(['doc-live', 'doc-live:m:msg-1', 'doc-live:v2']);

    // STORE 1 (interactive): gone from the live list, present as retired when asked for.
    expect((await listDocs()).map((d) => d['name'])).not.toContain('doc-live');
    const retiredRow = (await listDocs('?includeRetired=1')).find((d) => d['name'] === 'doc-live');
    expect(retiredRow?.['retired']).toBe(true);
    expect(typeof retiredRow?.['retired_at']).toBe('string');

    // STORE 2 (crew): the ledger files no longer hold any row for the doc.
    expect(ledgerKeys(draftLedgerPath)).not.toContain('doc-live');
    expect(ledgerKeys(editLedgerPath)).not.toContain('doc-live:v2');
    expect(ledgerKeys(chatLedgerPath)).toEqual([]);

    // And the action is on the audit trail with the caller's actor.
    await audit.flush();
    const entries = await audit.read({ action: 'interactive.doc.deleted' });
    const entry = entries.find((e) => (e.detail as { doc?: string })?.doc === 'doc-live');
    expect(entry).toBeDefined();
    expect((entry?.detail as { outcome?: string })?.outcome).toBe('retired');
    expect(entry?.actor.id).toBe(LOCAL_ACTOR.id);
  }, 30_000);

  it('repeat DELETE → 200 already_retired, ORIGINAL retired_at semantics, empty sweep', async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/doc-live');
    expect(status).toBe(200);
    expect(json['already_retired']).toBe(true);
    expect(json['event_id']).toBeUndefined(); // no re-emit on repeat
    expect((json['ledger'] as { removed_keys: string[] }).removed_keys).toEqual([]);
  });
});

describe('truthful relays', () => {
  it("relays the bridge's 404 truthfully — and STILL sweeps ghost ledger rows", async () => {
    expect(ledgerKeys(draftLedgerPath)).toContain('ghost-doc');
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/ghost-doc');
    expect(status).toBe(404);
    expect(json['error']).toBe('unknown doc'); // the bridge's own words
    expect((json['ledger'] as { ok: boolean; removed_keys: string[] }).removed_keys).toEqual(['ghost-doc']);
    expect(ledgerKeys(draftLedgerPath)).not.toContain('ghost-doc');

    await audit.flush();
    const entries = await audit.read({ action: 'interactive.doc.deleted' });
    const entry = entries.find((e) => (e.detail as { doc?: string })?.doc === 'ghost-doc');
    expect((entry?.detail as { outcome?: string })?.outcome).toBe('ledger-only');
  });

  it('a plain unknown doc (no ghost rows) is a clean 404 with an empty sweep', async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/never-existed');
    expect(status).toBe(404);
    expect(json['error']).toBe('unknown doc');
    expect((json['ledger'] as { removed_keys: string[] }).removed_keys).toEqual([]);
  });

  it("relays the bridge's 409 (build in flight) verbatim and sweeps NOTHING", async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/doc-busy');
    expect(status).toBe(409);
    expect(json['error']).toContain('build in flight');
    expect(json['document_id']).toBe('doc-busy');
    expect(json['active']).toBe(true);
    expect((json['run'] as { id?: string })?.id).toBe('run-9');
    // The doc is alive — its replay-dedup rows must keep doing their job.
    expect(ledgerKeys(draftLedgerPath)).toContain('doc-busy');
    expect(ledgerKeys(editLedgerPath)).toContain('doc-busy:v1');
  });

  it('a bridge 5xx → 502, ledger deliberately untouched (nothing diverged)', async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/doc-500');
    expect(status).toBe(502);
    expect(json['error']).toContain('did not retire');
    expect(json['upstream_status']).toBe(500);
    expect((json['upstream'] as { error?: string })?.error).toContain('simulated');
    expect(json['ledger']).toEqual({ ok: false, removed_keys: [], skipped: true });
    expect(ledgerKeys(draftLedgerPath)).toContain('doc-500');
  });

  it('an invalid slug 404s as "unknown doc" without a bridge call or a sweep', async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/docs/NOT-a-slug');
    expect(status).toBe(404);
    expect(json['error']).toBe('unknown doc');
    expect(json['ledger']).toEqual({ ok: true, removed_keys: [] });
  });

  it('an unknown project 404s without starting a bridge', async () => {
    const { status, json } = await del('/api/v1/projects/p-nope/interactive/docs/doc-live');
    expect(status).toBe(404);
    expect(json['error']).toContain('p-nope');
  });
});

describe('partial failure is LOUD', () => {
  it('retire succeeded but the sweep failed → 500 naming BOTH halves + the retry instruction', async () => {
    // Same bridge, second app: only the sweep differs — it fails the way an unwritable
    // ~/.wicked-crew fails, with one ledger swept and one not.
    const failingApp = Fastify({ logger: false });
    const adapter = stubAdapter(new Set(['p-a']));
    const settings = new ProjectSettingsStore(join(dir, 'project-settings.json'));
    registerInteractiveDocDelete(failingApp, adapter, {
      settings,
      pool: new InteractiveBridgePool({ spawn: spawnFake, startTimeoutMs: 15_000, healthTimeoutMs: 1_000 }),
      audit,
      actorOf,
      dropDocLedgerRows: () => ({
        ok: false,
        removed_keys: ['doc-live-2'],
        errors: [{ ledger: 'edit', error: 'EACCES: permission denied' }],
      }),
      env: { WICKED_INTERACTIVE_ROOT: join(dir, 'shared-docs') },
    });
    const res = await failingApp.inject({
      method: 'DELETE',
      url: '/api/v1/projects/p-a/interactive/docs/doc-live-2',
    });
    await failingApp.close();

    expect(res.statusCode).toBe(500);
    const body = res.json() as Record<string, unknown>;
    // The error names which half happened, which didn't, and what to do about it.
    expect(body['error']).toContain('partial delete');
    expect(body['error']).toContain("wicked-interactive retired 'doc-live-2'");
    expect(body['error']).toContain('could not drop');
    expect(body['error']).toContain('Re-issue this DELETE');
    // Both halves attached in full.
    expect((body['interactive'] as { retired?: boolean })?.retired).toBe(true);
    expect(body['ledger']).toEqual({
      ok: false,
      removed_keys: ['doc-live-2'],
      errors: [{ ledger: 'edit', error: 'EACCES: permission denied' }],
    });
    // …and interactive's store DID retire it — the truth the 500 is loud about.
    expect((await listDocs()).map((d) => d['name'])).not.toContain('doc-live-2');

    await audit.flush();
    const entries = await audit.read({ action: 'interactive.doc.deleted' });
    const entry = entries.find((e) => (e.detail as { doc?: string })?.doc === 'doc-live-2');
    expect((entry?.detail as { outcome?: string })?.outcome).toBe('partial');
  }, 30_000);
});

describe('the pure-transport proxy is untouched', () => {
  it('a DELETE on the RAW proxied path still flows verbatim (no ledger field, no sweep)', async () => {
    const { status, json } = await del('/api/v1/projects/p-a/interactive/api/docs/doc-raw');
    expect(status).toBe(200);
    expect(json['name']).toBe('doc-raw');
    expect(json['retired']).toBe(true);
    expect(json['ledger']).toBeUndefined(); // pure transport: the bridge's body, nothing added
  });
});
