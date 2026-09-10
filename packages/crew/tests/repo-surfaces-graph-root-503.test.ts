// wicked-core#406 follow-up: every repo surface that opens a repo's code graph answers **503** —
// the shared `codeGraphErrorStatus` — when a CURRENT engine resolved no repo-graph root
// (`code_graph_root_unresolvable`), instead of letting `codeGraphDb()`'s throw fall through to
// Fastify's generic 500. The remedy is the daemon's environment, and the response says so.
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';

const MESSAGE =
  'no repo-graph root resolves for this daemon (no WICKED_ESTATE_REPO_GRAPH_ROOT override, no state home, no HOME / USERPROFILE): the repo has no code graph until one does';

/** A CURRENT engine's record for a repo whose daemon resolved no repo-graph root. */
function unresolvableRepo(id: string): RepoEntry {
  return {
    id,
    name: id,
    root_path: `/repos/${id}`,
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: '',
    findings: [{ code: 'code_graph_root_unresolvable', message: MESSAGE, path: null }],
  };
}

/** A healthy record whose graph simply has not been indexed yet (the pre-existing shapes stay). */
function unindexedRepo(id: string): RepoEntry {
  return {
    id,
    name: id,
    root_path: `/repos/${id}`,
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: `/state/repo-graphs/${id}-0123456789ab/estate.db`,
  };
}

describe('repo surfaces — a current engine with no repo-graph root answers 503, never 500', () => {
  let app: FastifyInstance;

  async function build(repos: RepoEntry[]): Promise<void> {
    const adapter = { listRepos: vi.fn().mockResolvedValue(repos) } as unknown as CoreAdapter;
    app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {});
    await app.ready();
  }

  beforeEach(async () => {
    await build([unresolvableRepo('r'), unindexedRepo('ok')]);
  });

  afterEach(async () => {
    await app.close();
  });

  for (const url of [
    '/api/v1/repos/r/graph',
    '/api/v1/repos/r/graph/blast-radius?name=thing',
    '/api/v1/repos/r/domain-graph',
    '/api/v1/repos/r/requirements',
    '/api/v1/repos/r/requirements/some-key',
  ]) {
    it(`GET ${url} → 503 with the engine's own diagnosis`, async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/no repo-graph root resolves for this daemon/);
      expect(body.error).not.toMatch(/wicked-core#170/);
    });
  }

  it('PATCH /repos/:id/requirements/:key → 503 too', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/repos/r/requirements/some-key',
      // A body ReqPatchSchema accepts, so the parse passes and the graph open is what answers.
      payload: { risk: true },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toMatch(/no repo-graph root resolves/);
  });

  it('a repo whose graph is merely not indexed yet keeps its pre-existing answers', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos/ok/graph' })).json()).toEqual({ graph: null });
    const br = await app.inject({ method: 'GET', url: '/api/v1/repos/ok/graph/blast-radius?name=x' });
    expect(br.statusCode).toBe(404);
    expect((br.json() as { error: string }).error).toMatch(/not built/);
    const req = await app.inject({ method: 'GET', url: '/api/v1/repos/ok/requirements' });
    expect(req.statusCode).toBe(404);
  });

  it('an unknown repo is still a 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos/nope/graph' })).statusCode).toBe(404);
  });
});
