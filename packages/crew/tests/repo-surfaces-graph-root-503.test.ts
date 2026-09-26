// wicked-core#406 follow-up: every repo surface that opens a repo's code graph answers **503** —
// (since crew#548 the requirements surfaces read the repo-root artifact only and are not among them) —
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
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, {});
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
  ]) {
    it(`GET ${url} → 503 with the engine's own diagnosis`, async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/no repo-graph root resolves for this daemon/);
      expect(body.error).not.toMatch(/wicked-core#170/);
    });
  }

  it('the requirements surfaces no longer open the code graph (crew#548): with no repo-graph root they answer from the artifact — 404 when none is generated, PATCH included — never 503', async () => {
    // Until 0.7.35 `api/requirements.ts` read the LIVE store first (a second SQLite library on the
    // code-graph file — the F-E2E-021 class), so a missing graph root surfaced here as the 503 above.
    // The artifact lives under the REPO root (`.wicked-estate/requirements/`), a different path
    // family, so the graph root is irrelevant to it now.
    for (const url of ['/api/v1/repos/r/requirements', '/api/v1/repos/r/requirements/some-key']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as { error: string }).error).not.toMatch(/no repo-graph root resolves/);
    }
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/repos/r/requirements/some-key',
      // A body ReqPatchSchema accepts, so the parse passes and the artifact lookup is what answers.
      payload: { risk: true },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('a repo whose graph is merely not indexed yet keeps its pre-existing answers — and /graph now SAYS it is not indexed (F-2R2-005)', async () => {
    const graph = (await app.inject({ method: 'GET', url: '/api/v1/repos/ok/graph' })).json() as {
      graph: null;
      reason?: string;
      finding?: unknown;
    };
    expect(graph.graph).toBeNull();
    // `graph: null` alone cannot distinguish "not indexed" from "empty": the reason names the repo,
    // the registered graph path, and the onboarding route that builds it.
    expect(graph.reason).toMatch(/no code graph has been built for 'ok' yet/);
    expect(graph.reason).toContain('/state/repo-graphs/ok-0123456789ab/estate.db');
    expect(graph.reason).toContain('POST /api/v1/repos/ok/onboard');
    expect(graph.finding).toBeUndefined();
    const br = await app.inject({ method: 'GET', url: '/api/v1/repos/ok/graph/blast-radius?name=x' });
    expect(br.statusCode).toBe(404);
    expect((br.json() as { error: string }).error).toMatch(/not built/);
    const req = await app.inject({ method: 'GET', url: '/api/v1/repos/ok/requirements' });
    expect(req.statusCode).toBe(404);
  });

  it('/graph for a repo whose in-tree graph is IGNORED carries the repos wire\'s own finding as the reason (F-2R2-005)', async () => {
    const finding = {
      code: 'in_tree_code_graph_ignored',
      message:
        'in-tree graph /repos/legacy/.codegraph is ignored and no live graph exists under the state home yet — re-run onboarding (POST /repos/legacy/onboard)',
      path: '/repos/legacy/.codegraph',
    };
    await app.close();
    await build([{ ...unindexedRepo('legacy'), findings: [finding] }]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/legacy/graph' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ graph: null, reason: finding.message, finding });
  });

  it('an unknown repo is still a 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/repos/nope/graph' })).statusCode).toBe(404);
  });
});
