// Wave 6 (F-4R2-006 root fix) — the document ↔ run binding as a direct read: `AgentSession.document_id`
// on the run DTO and `GET /runs?doc=`, derived from the interactive seams' handoff ledgers (whose
// keys start with the document id) instead of a skin parsing `extra_write_roots`.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { DocRunIndex, documentIdOfKey } from '../src/interactive/doc-run-index.js';
import { InteractiveHandoffLedger } from '../src/interactive/ledger.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

function view(id: string) {
  return {
    session: {
      id,
      workflow_id: 'wf-x',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

describe('documentIdOfKey — every seam key grammar starts with the document id', () => {
  it('draft `<doc>`, edit/demo `<doc>:v<N>`, chat `<doc>:m:<msg>` / `<doc>:e:<event>`', () => {
    expect(documentIdOfKey('my-doc')).toBe('my-doc');
    expect(documentIdOfKey('my-doc:v3')).toBe('my-doc');
    expect(documentIdOfKey('my-doc:m:msg-9')).toBe('my-doc');
    expect(documentIdOfKey('my-doc:e:41')).toBe('my-doc');
  });
});

describe('DocRunIndex over the handoff ledgers', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-run-index-'));
  });
  afterAll(() => removeScratch(dir));

  it('reads the binding off every seam ledger (live instance or file), merges live stamps, and refreshes after the TTL', () => {
    const draftPath = join(dir, 'draft.json');
    const draft = new InteractiveHandoffLedger(draftPath);
    draft.recordLaunch('doc-a', 'run-1');
    const editPath = join(dir, 'edit.json');
    new InteractiveHandoffLedger(editPath).recordLaunch('doc-a:v2', 'run-2');
    const chatPath = join(dir, 'chat.json');
    new InteractiveHandoffLedger(chatPath).recordLaunch('doc-b:m:msg-1', 'run-3');
    // rows() is a snapshot of `[key, entry]`.
    expect(draft.rows().map(([k, e]) => [k, e.runId])).toEqual([['doc-a', 'run-1']]);

    let now = 1_000;
    const logs: string[] = [];
    const index = new DocRunIndex(
      () => [
        { name: 'draft', ledger: draft, path: draftPath },
        { name: 'edit', path: editPath },
        { name: 'chat', path: chatPath },
        { name: 'demo', path: join(dir, 'missing-demo.json') }, // a missing file = an empty ledger
      ],
      { ttlMs: 50, now: () => now, log: (m) => logs.push(m) },
    );
    expect(index.documentOf('run-1')).toBe('doc-a');
    expect(index.documentOf('run-2')).toBe('doc-a');
    expect(index.documentOf('run-3')).toBe('doc-b');
    expect(index.documentOf('run-unbound')).toBeUndefined();
    expect(index.runsOf('doc-a')).toEqual(['run-1', 'run-2']);
    expect(logs).toEqual([]);

    // A launch that just landed: the live stamp is visible immediately…
    index.set('run-4', 'doc-c');
    expect(index.documentOf('run-4')).toBe('doc-c');
    // …and a row another process wrote is seen once the TTL elapses, not before.
    new InteractiveHandoffLedger(editPath).recordLaunch('doc-d:v1', 'run-5');
    expect(index.documentOf('run-5')).toBeUndefined();
    now += 100;
    expect(index.documentOf('run-5')).toBe('doc-d');
  });

  it('a corrupt ledger file costs ITS runs only, and is logged', () => {
    const good = join(dir, 'good.json');
    new InteractiveHandoffLedger(good).recordLaunch('doc-x', 'run-x');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"docs": {"doc-y": {"runId": "run-y", "launchedAt": "t"}}}'); // parses fine — a REAL bad one below
    const logs: string[] = [];
    // A throwing source (simulated by a ledger whose rows() throws).
    const throwing = { rows: () => { throw new Error('disk on fire'); } } as unknown as InteractiveHandoffLedger;
    const index = new DocRunIndex(
      () => [
        { name: 'draft', path: good },
        { name: 'edit', ledger: throwing, path: bad },
        { name: 'chat', path: bad },
      ],
      { log: (m) => logs.push(m) },
    );
    expect(index.documentOf('run-x')).toBe('doc-x');
    expect(index.documentOf('run-y')).toBe('doc-y'); // the chat source read the same file fine
    expect(logs.join('\n')).toContain('could not read the edit ledger');
    expect(logs.join('\n')).toContain('disk on fire');
  });
});

describe('GET /runs — document_id on the DTO and the ?doc= filter', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const docRuns = new DocRunIndex(() => []);
    docRuns.set('run-1', 'doc-a');
    docRuns.set('run-2', 'doc-a');
    docRuns.set('run-3', 'doc-b');
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-1'), view('run-2'), view('run-3'), view('run-plain')]),
      listRepos: vi.fn().mockResolvedValue([]),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
      docRuns,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const runsOf = (body: unknown) => (body as { runs: Array<{ session: { id: string; document_id?: string | null } }> }).runs;

  it('every served run carries document_id — the doc for a seam-launched run, null for any other run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode).toBe(200);
    const byId = new Map(runsOf(res.json()).map((r) => [r.session.id, r.session.document_id]));
    expect(byId.get('run-1')).toBe('doc-a');
    expect(byId.get('run-3')).toBe('doc-b');
    expect(byId.get('run-plain')).toBeNull();
    const one = await app.inject({ method: 'GET', url: '/api/v1/runs/run-2' });
    expect((one.json() as { run: { session: { document_id: string } } }).run.session.document_id).toBe('doc-a');
  });

  it('?doc= narrows to that document’s runs; a repeated or empty ?doc is a 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs', query: { doc: 'doc-a' } });
    expect(res.statusCode).toBe(200);
    expect(runsOf(res.json()).map((r) => r.session.id).sort()).toEqual(['run-1', 'run-2']);
    const none = await app.inject({ method: 'GET', url: '/api/v1/runs', query: { doc: 'doc-none' } });
    expect(runsOf(none.json())).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs', query: { doc: ['a', 'b'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs', query: { doc: ' ' } })).statusCode).toBe(400);
  });
});
