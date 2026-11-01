// domain-graph-3: a repository whose requirements graph is not built yet still says how much is
// mapped so far — "3% of behaviours mapped · target 80%" — so the requirements view can show the
// generation's progress before the graph exists. The share comes from the same engine read the page
// used (`getRequirementsGraphForRepo`, cached), never a second store read.
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { forgetRequirementsReads } from '../src/api/requirements.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

describe('GET /repos/:id/requirements — not generated yet, with the share mapped so far', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    forgetRequirementsReads();
    if (dir !== undefined) removeScratch(dir);
    dir = undefined;
  });

  async function build(coverage: unknown): Promise<ReturnType<typeof vi.fn>> {
    dir = mkdtempSync(join(tmpdir(), 'req-not-generated-'));
    const db = join(dir, 'estate.db');
    writeFileSync(db, '');
    const repo: RepoEntry = {
      id: 'wicked-crew', name: 'wicked-crew', root_path: join(dir, 'repo'),
      default_branch: 'main', registered_at: 0, code_graph_db: db,
    };
    const read = vi.fn().mockResolvedValue(JSON.parse(JSON.stringify({ graph: null, coverage })));
    const adapter = {
      listRepos: vi.fn().mockResolvedValue([repo]),
      getRequirementsGraphForRepo: read,
    } as unknown as CoreAdapter;
    app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, {});
    await app.ready();
    return read;
  }

  it('carries the coverage beside the typed notGenerated state, from one engine read', async () => {
    const read = await build({
      real_pct: 23, min_pct: 80, behavior_bearing: 5786, real: 1362, placeholders: 4397, unmapped: 27, not_product: 2380,
    });
    const res = await app!.inject({ method: 'GET', url: '/api/v1/repos/wicked-crew/requirements' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'No requirements graph yet for this repository',
      code: 'notGenerated',
      workflow: 'domain-extraction',
      coverage: { realPct: 23, minPct: 80, behaviorBearing: 5786, real: 1362, placeholders: 4397, unmapped: 27, notProduct: 2380 },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('each answer carries the coverage of its own read, never another request\'s (codex r2 on #1250)', async () => {
    const read = await build(null);
    const cov = (pct: number) => ({ real_pct: pct, min_pct: 80, behavior_bearing: 1000, real: pct * 10, placeholders: 1, unmapped: 999 - pct * 10, not_product: 0 });
    let resolveA: (v: unknown) => void = () => {};
    let resolveB: (v: unknown) => void = () => {};
    read.mockReset();
    read.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    read.mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
    const a = app!.inject({ method: 'GET', url: '/api/v1/repos/wicked-crew/requirements' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    forgetRequirementsReads(); // past the read window: the next request reads again
    const b = app!.inject({ method: 'GET', url: '/api/v1/repos/wicked-crew/requirements' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // both reads land before either route answers: each still says its own
    resolveA({ graph: null, coverage: cov(3) });
    resolveB({ graph: null, coverage: cov(23) });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.json().coverage.realPct).toBe(3);
    expect(rb.json().coverage.realPct).toBe(23);
  });

  it('says nothing about coverage the engine could not count', async () => {
    await build(null);
    const res = await app!.inject({ method: 'GET', url: '/api/v1/repos/wicked-crew/requirements' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'No requirements graph yet for this repository',
      code: 'notGenerated',
      workflow: 'domain-extraction',
    });
  });
});
