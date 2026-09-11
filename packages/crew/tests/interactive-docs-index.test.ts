// Wave 6 (studio #263 review) — `GET /interactive/docs`: every interactive document across projects,
// listed by the daemon from DISK, without spawning a bridge. The per-project listing asks the
// project's bridge (one `wicked-interactive serve` per root, ≈60 s cold start) — the studio must
// never fan that out on mount. This lists what the bridge lists (slug children with a `versions.json`,
// the bridge's own `listDocs` rules) plus the seams/runs the handoff ledgers know about each doc.
import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { DocRunIndex } from '../src/interactive/doc-run-index.js';
import { listInteractiveDocs } from '../src/interactive/docs-index.js';
import { InteractiveHandoffLedger } from '../src/interactive/ledger.js';
import type { CoreAdapter } from '../src/core/adapter.js';

/** A doc dir the way the bridge writes it: `<root>/<name>/versions.json`. */
function writeDoc(root: string, name: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'versions.json'), JSON.stringify(manifest));
}
const v = (n: number, at: string) => ({ version: n, parent: n === 0 ? null : n - 1, feedback_file: null, html_file: `_v${n}.html`, created_at: at });

describe('GET /interactive/docs — daemon-wide, non-spawning', () => {
  let base: string;
  let defaultRoot: string;
  let p1Root: string;
  let app: FastifyInstance;
  let settings: ProjectSettingsStore;
  let docRuns: DocRunIndex;
  const savedRoot = process.env['WICKED_INTERACTIVE_ROOT'];
  const projectList = vi.fn(async () => [
    { id: 'p1', name: 'P1', description: null, status: 'active', scope: 'project:p1', created_at: 1, updated_at: 1 },
    { id: 'p2', name: 'P2', description: null, status: 'active', scope: 'project:p2', created_at: 1, updated_at: 1 },
  ]);

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'docs-index-'));
    // The DEFAULT project's root comes from the env binding; p1 binds its OWN root; p2 has no
    // binding of its own — it resolves to the same env root as default (a SHARED root, listed once).
    defaultRoot = join(base, 'shared-docs');
    p1Root = join(base, 'p1-docs');
    mkdirSync(defaultRoot, { recursive: true });
    mkdirSync(p1Root, { recursive: true });
    process.env['WICKED_INTERACTIVE_ROOT'] = defaultRoot;
    writeDoc(defaultRoot, 'overview', { head: 1, versions: [v(0, '2026-09-10T10:00:00.000Z'), v(1, '2026-09-11T09:00:00.000Z')] });
    writeDoc(defaultRoot, 'old-demo', { kind: 'demo', head: 0, versions: [v(0, '2026-09-01T00:00:00.000Z')], retired_at: '2026-09-02T00:00:00.000Z' });
    writeDoc(defaultRoot, 'broken', {}); // valid JSON, but no lineage → head null, versions 0
    writeFileSync(join(defaultRoot, 'garbage.json'), 'not a doc dir'); // a stray file, ignored
    mkdirSync(join(defaultRoot, 'Not-A-Slug'));
    writeFileSync(join(defaultRoot, 'Not-A-Slug', 'versions.json'), '{"head":0,"versions":[]}'); // fails the slug grammar
    mkdirSync(join(defaultRoot, 'malformed'));
    writeFileSync(join(defaultRoot, 'malformed', 'versions.json'), '{not json'); // skipped, as the bridge skips it
    mkdirSync(join(defaultRoot, 'projects', 'p9'), { recursive: true }); // the partitions dir is not a doc
    writeDoc(p1Root, 'brief', { kind: 'source', style: 'web', head: 2, versions: [v(0, '2026-09-11T11:00:00.000Z'), v(1, '2026-09-11T11:30:00.000Z'), v(2, '2026-09-11T12:00:00.000Z')] });

    settings = new ProjectSettingsStore(join(base, 'project-settings.json'), () => undefined);
    settings.set('p1', { interactiveRoot: p1Root });

    // The ledgers: overview was drafted then chatted about (two runs); brief was drafted once.
    const draft = new InteractiveHandoffLedger(join(base, 'draft-ledger.json'));
    draft.recordLaunch('overview', 'run-o1');
    draft.recordLaunch('brief', 'run-b1');
    const chat = new InteractiveHandoffLedger(join(base, 'chat-ledger.json'));
    chat.recordLaunch('overview:m:msg-1', 'run-o2');
    docRuns = new DocRunIndex(() => [
      { name: 'draft', ledger: draft, path: join(base, 'draft-ledger.json') },
      { name: 'chat', ledger: chat, path: join(base, 'chat-ledger.json') },
    ]);

    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([]),
      projectList,
      projectGet: vi.fn(async (id: string) => (id === 'p1' || id === 'p2' ? { id, status: 'active' } : null)),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      { bus: null, index: new MembershipIndex(), log: () => undefined, settings },
      undefined,
      { docRuns },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (savedRoot === undefined) delete process.env['WICKED_INTERACTIVE_ROOT'];
    else process.env['WICKED_INTERACTIVE_ROOT'] = savedRoot;
    rmSync(base, { recursive: true, force: true });
  });

  type Row = { projectId: string; name: string; kind: string; head: number | null; versions: number; updatedAt: string | null; retired?: true; kinds: string[]; runs: string[] };
  type Body = { docs: Row[]; unreachable: Array<{ projectId: string; root: string | null; error: string }> };

  it('lists every readable doc across the roots, newest first, with the seams and runs the ledgers know — and never spawns anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/interactive/docs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.unreachable).toEqual([]);
    expect(body.docs.map((d) => [d.projectId, d.name])).toEqual([
      ['p1', 'brief'], // 12:00 — newest
      ['default', 'overview'], // 09:00
      ['default', 'broken'], // no lineage → sorts last (null updatedAt)
    ]);
    expect(body.docs[0]).toMatchObject({ kind: 'source', head: 2, versions: 3, updatedAt: '2026-09-11T12:00:00.000Z', kinds: ['draft'], runs: ['run-b1'] });
    expect(body.docs[1]).toMatchObject({ kind: 'doc', head: 1, versions: 2, updatedAt: '2026-09-11T09:00:00.000Z', kinds: ['draft', 'chat'], runs: ['run-o1', 'run-o2'] });
    expect(body.docs[2]).toMatchObject({ kind: 'doc', head: null, versions: 0, updatedAt: null, kinds: [], runs: [] });
    // Retired rows, the non-slug dir, the malformed manifest and the partitions dir are not rows.
    expect(body.docs.some((d) => d.name === 'old-demo' || d.name === 'Not-A-Slug' || d.name === 'malformed' || d.name === 'projects')).toBe(false);
    // p2 shares the default root: listed ONCE (under default), not duplicated under p2.
    expect(body.docs.filter((d) => d.name === 'overview')).toHaveLength(1);
    expect(projectList).toHaveBeenCalled();
  });

  it('?includeRetired=1 lists tombstones too, marked', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/interactive/docs', query: { includeRetired: '1' } });
    const body = res.json() as Body;
    const retired = body.docs.find((d) => d.name === 'old-demo');
    expect(retired).toMatchObject({ projectId: 'default', kind: 'demo', retired: true, retiredAt: '2026-09-02T00:00:00.000Z' });
  });

  it('a root that exists but cannot be read is reported in `unreachable`, never dropped silently; a missing root is an empty project', async () => {
    const locked = join(base, 'locked-docs');
    mkdirSync(locked);
    writeDoc(locked, 'secret', { head: 0, versions: [v(0, '2026-09-11T00:00:00.000Z')] });
    chmodSync(locked, 0o000);
    const missing = join(base, 'never-created');
    const s2 = new ProjectSettingsStore(join(base, 'ps2.json'), () => undefined);
    s2.set('p1', { interactiveRoot: locked });
    s2.set('p2', { interactiveRoot: missing });
    try {
      const listing = await listInteractiveDocs({
        adapter: { projectList } as unknown as CoreAdapter,
        settings: s2,
        docRuns,
        env: { WICKED_INTERACTIVE_ROOT: defaultRoot },
      });
      if (process.getuid?.() === 0) {
        expect(listing.docs.some((d) => d.name === 'secret')).toBe(true); // root reads everything
      } else {
        expect(listing.unreachable).toEqual([expect.objectContaining({ projectId: 'p1', root: locked })]);
        expect(listing.unreachable[0]!.error).toMatch(/EACCES|permission/i);
      }
      // p2's missing root: no rows, no complaint.
      expect(listing.unreachable.some((u) => u.projectId === 'p2')).toBe(false);
      expect(listing.docs.some((d) => d.projectId === 'p2')).toBe(false);
      // The default root still lists.
      expect(listing.docs.some((d) => d.name === 'overview')).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('an engine without the project bindings lists the default root alone', async () => {
    const listing = await listInteractiveDocs({
      adapter: {} as unknown as CoreAdapter, // no projectList
      settings,
      docRuns,
      env: { WICKED_INTERACTIVE_ROOT: defaultRoot },
    });
    expect(listing.unreachable).toEqual([]);
    expect(listing.docs.map((d) => d.name)).toEqual(['overview', 'broken']);
  });
});
