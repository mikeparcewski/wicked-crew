/**
 * The project-graph routes' DEGRADATION contract, and the attribution that makes a federated answer
 * an answer.
 *
 * # Why degradation is the thing under test
 *
 * Every failure mode of this surface has the same natural shape — an empty result set — and every
 * one of them has a different cause and a different fix: no repo members, a graph never built, a
 * member the registry has forgotten, an addon too old to vouch for repo records. Served as `[]` they
 * are indistinguishable from "nothing in this project depends on that symbol", which is the exact
 * wrong answer to act on. Estate's R3 rule and FINDING-069 are both this failure; these tests pin
 * that each one names itself.
 *
 * Fastify `inject()` with a mock adapter, like run-dto-lineage-project.test.ts. Nothing here spawns
 * `wicked-estate`: every case below is decided BEFORE a query would run, which is the point — a
 * project that cannot answer must not reach the binary at all.
 */
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { registerProjectRoutes } from '../src/projects/routes.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { attributeHits, CO_LOCATION_NOTE } from '../src/projects/graph.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Project, ProjectMember, RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const PROJECT_ID = 'proj_test_graph';

function project(id = PROJECT_ID): Project {
  return {
    id,
    name: 'graph test',
    description: '',
    status: 'active',
    scope: '',
    created_at: 0,
    updated_at: 0,
  } as Project;
}

function repoMember(ref: string): ProjectMember {
  return {
    id: `${PROJECT_ID}:crew.repo:${ref}`,
    project_id: PROJECT_ID,
    member_kind: 'crew.repo',
    member_ref: ref,
    meta: null,
    attached_at: 0,
    attached_by: 'api',
  };
}

/** A repo record as a CURRENT engine publishes it (with `code_graph_db`). */
function repo(id: string): RepoEntry {
  return {
    id,
    name: id,
    root_path: join('/repos', id),
    default_branch: 'main',
    registered_at: 0,
    code_graph_db: join('/repos', id, '.codegraph', 'estate.db'),
  };
}

/** A repo record as a STALE addon publishes it: the field is ABSENT, not `undefined`. */
function staleRepo(id: string): RepoEntry {
  const rest: Record<string, unknown> = { ...repo(id) };
  // DELETE, not `code_graph_db: undefined` — repo-paths.test.ts pays for this distinction too: a
  // key present-and-undefined is not what a stale addon's JSON produces, and the two behave
  // differently through default parameters.
  delete rest['code_graph_db'];
  return rest as unknown as RepoEntry;
}

interface Fixture {
  app: FastifyInstance;
  graphRoot: string;
}

function build(opts: {
  members?: ProjectMember[];
  repos?: RepoEntry[];
  projectExists?: boolean;
  graphRoot: string;
}): FastifyInstance {
  const adapter = {
    projectGet: vi.fn(async (id: string) => (opts.projectExists === false ? null : project(id))),
    projectMembers: vi.fn(async () => opts.members ?? []),
    listRepos: vi.fn(async () => opts.repos ?? []),
    projectList: vi.fn(async () => []),
    sessions: vi.fn(async () => []),
    chatList: vi.fn(async () => []),
  } as unknown as CoreAdapter;

  const app = Fastify({ logger: false });
  registerProjectRoutes(app, adapter, {
    bus: null,
    index: new MembershipIndex(),
    log: () => undefined,
    settings: new ProjectSettingsStore(join(opts.graphRoot, 'settings.json')),
  });
  return app;
}

let fixture: Fixture;

beforeEach(() => {
  const graphRoot = mkdtempSync(join(tmpdir(), 'crew-project-graph-'));
  process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = graphRoot;
  fixture = { app: undefined as unknown as FastifyInstance, graphRoot };
});

afterEach(async () => {
  await fixture.app?.close();
  delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
  removeScratch(fixture.graphRoot);
});

describe('GET /projects/:id/graph — the graph reports its own standing', () => {
  it('a project with NO repo members says so, and names the fix', async () => {
    fixture.app = build({ members: [], graphRoot: fixture.graphRoot });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/graph` });
    expect(res.statusCode).toBe(200);
    const { status } = res.json() as { status: Record<string, unknown> };
    expect(status['state']).toBe('no-repo-members');
    expect(status['detail']).toMatch(/no crew\.repo members/);
    expect(status['detail']).toMatch(/POST \/api\/v1\/projects/);
    expect(status['dbPath']).toBeNull();
    // The limit travels with every payload, including the ones that carry no results.
    expect(status['linkage']).toBe('co-located');
    expect(status['note']).toBe(CO_LOCATION_NOTE);
  });

  it('repo members but no database says NOT-INDEXED, which is a different thing', async () => {
    fixture.app = build({
      members: [repoMember('wicked-ledger'), repoMember('wicked-vault')],
      repos: [repo('wicked-ledger'), repo('wicked-vault')],
      graphRoot: fixture.graphRoot,
    });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/graph` });
    expect(res.statusCode).toBe(200);
    const { status } = res.json() as { status: Record<string, unknown> };
    expect(status['state']).toBe('not-indexed');
    expect(status['detail']).toMatch(/2 repo member\(s\) but no code graph yet/);
    expect(status['detail']).toMatch(/graph\/refresh/);
    expect(status['missingRepos']).toEqual(['wicked-ledger', 'wicked-vault']);
    // Every member is listed with the label its rows WILL carry, so an operator can predict the
    // provenance strings before the first refresh.
    expect((status['repos'] as Array<Record<string, unknown>>).map((r) => r['label'])).toEqual([
      'wicked-ledger',
      'wicked-vault',
    ]);
  });

  it('a member the registry has forgotten is listed as such, not dropped', async () => {
    fixture.app = build({
      members: [repoMember('wicked-ledger'), repoMember('deleted-repo')],
      repos: [repo('wicked-ledger')],
      graphRoot: fixture.graphRoot,
    });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/graph` });
    const { status } = res.json() as { status: Record<string, unknown> };
    const rows = status['repos'] as Array<Record<string, unknown>>;
    const dangling = rows.find((r) => r['repoId'] === 'deleted-repo');
    expect(dangling).toBeDefined();
    expect(dangling?.['indexed']).toBe(false);
    expect(dangling?.['reason']).toMatch(/registry no longer knows this ref/);
    expect(status['missingRepos']).toContain('deleted-repo');
  });

  it('a project whose members are ALL dangling does not offer a refresh that cannot help', async () => {
    // Found by the proof harness: this used to report "has 0 repo member(s) … build it with POST
    // …/graph/refresh", which is both wrong (there IS a member) and useless (a refresh resolves
    // zero repos and builds nothing, so the operator learns nothing from running it).
    fixture.app = build({
      members: [repoMember('deleted-repo')],
      repos: [],
      graphRoot: fixture.graphRoot,
    });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/graph` });
    const { status } = res.json() as { status: Record<string, unknown> };
    expect(status['state']).toBe('not-indexed');
    expect(status['detail']).toMatch(/only repo member\(s\) — deleted-repo — are not in the repo registry/);
    expect(status['detail']).toMatch(/a refresh cannot help/);
    expect(status['detail']).not.toMatch(/has 0 repo member/);
  });

  it('an addon too old to publish code_graph_db answers engine-too-old, not an empty graph', async () => {
    fixture.app = build({
      members: [repoMember('wicked-ledger')],
      repos: [staleRepo('wicked-ledger')],
      graphRoot: fixture.graphRoot,
    });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/graph` });
    expect(res.statusCode).toBe(200);
    const { status } = res.json() as { status: Record<string, unknown> };
    expect(status['state']).toBe('engine-too-old');
    // repoPaths.ts's message, carried through verbatim — it already names the remedy.
    expect(status['detail']).toMatch(/carries no code_graph_db/);
    expect(status['detail']).toMatch(/wicked-core#170/);
  });

  it('the synthesized default project can never have a graph, and says why', async () => {
    fixture.app = build({ graphRoot: fixture.graphRoot });
    const res = await fixture.app.inject({ method: 'GET', url: '/api/v1/projects/default/graph' });
    expect(res.statusCode).toBe(200);
    const { status } = res.json() as { status: Record<string, unknown> };
    expect(status['state']).toBe('no-repo-members');
    expect(status['detail']).toMatch(/unfiled runs and chats only/);
  });

  it('an unknown project is a 404, not an empty graph', async () => {
    fixture.app = build({ projectExists: false, graphRoot: fixture.graphRoot });
    const res = await fixture.app.inject({ method: 'GET', url: `/api/v1/projects/nope/graph` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/not found/);
  });
});

describe('the query routes refuse rather than answer emptily', () => {
  const urls = (id = PROJECT_ID) => [
    `/api/v1/projects/${id}/graph/blast-radius?name=record`,
    `/api/v1/projects/${id}/graph/search?name=record`,
  ];

  it('requires a name, exactly as /repos/:id/graph/blast-radius does', async () => {
    fixture.app = build({ graphRoot: fixture.graphRoot });
    for (const url of [
      `/api/v1/projects/${PROJECT_ID}/graph/blast-radius`,
      `/api/v1/projects/${PROJECT_ID}/graph/search?name=%20`,
    ]) {
      const res = await fixture.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('name query parameter required');
    }
  });

  it('404s with the CAUSE when the project has no repo members', async () => {
    fixture.app = build({ members: [], graphRoot: fixture.graphRoot });
    for (const url of urls()) {
      const res = await fixture.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: string; status: Record<string, unknown> };
      expect(body.status['state']).toBe('no-repo-members');
      expect(body.error).toMatch(/no crew\.repo members/);
      // The thing that must NOT be here: a well-formed empty answer.
      expect(body).not.toHaveProperty('dependents');
      expect(body).not.toHaveProperty('matches');
    }
  });

  it('404s with the REFRESH remedy when the graph was never built', async () => {
    fixture.app = build({
      members: [repoMember('wicked-ledger')],
      repos: [repo('wicked-ledger')],
      graphRoot: fixture.graphRoot,
    });
    for (const url of urls()) {
      const res = await fixture.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: string; status: Record<string, unknown> };
      expect(body.status['state']).toBe('not-indexed');
      expect(body.error).toMatch(/graph\/refresh/);
    }
  });

  it('501s — a capability gap, not a bad request — when the addon predates code_graph_db', async () => {
    fixture.app = build({
      members: [repoMember('wicked-ledger')],
      repos: [staleRepo('wicked-ledger')],
      graphRoot: fixture.graphRoot,
    });
    for (const url of urls()) {
      const res = await fixture.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(501);
      expect((res.json() as { error: string }).error).toMatch(/carries no code_graph_db/);
    }
  });

  it('refuses a refresh of the synthesized default project', async () => {
    fixture.app = build({ graphRoot: fixture.graphRoot });
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/projects/default/graph/refresh',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('attribution — a hit that does not say WHERE is not an answer', () => {
  const labels = new Map([
    ['wicked-ledger', 'wicked-ledger'],
    ['wicked-vault', 'wicked-vault'],
  ]);

  it('splits the estate path into the repo and the repo-relative file', () => {
    const { hits, byRepo } = attributeHits(
      [
        { id: 'sym-a', name: 'expectType', kind: 'function', file: 'wicked-ledger/test/types/consumer.mts', line: 96 },
        { id: 'sym-b', name: 'expectType', kind: 'function', file: 'wicked-vault/test/types/consumer.mts', line: 97 },
        { id: 'sym-c', name: 'record', kind: 'function', file: 'wicked-vault/src/vault/vault.mjs', line: 196 },
      ],
      labels,
    );
    expect(hits.map((h) => [h.repo, h.file])).toEqual([
      ['wicked-ledger', 'test/types/consumer.mts'],
      ['wicked-vault', 'test/types/consumer.mts'],
      ['wicked-vault', 'src/vault/vault.mjs'],
    ]);
    // `file` is repo-relative — the same spelling /repos/:id/graph returns — with the repo named
    // beside it, rather than a prefixed path a caller would have to parse to open the file.
    expect(hits.every((h) => !h.file.startsWith(h.repo))).toBe(true);
    expect(byRepo).toEqual([
      { repoId: 'wicked-vault', repo: 'wicked-vault', count: 2 },
      { repoId: 'wicked-ledger', repo: 'wicked-ledger', count: 1 },
    ]);
  });

  it('excludes rows of a repo that is no longer a member', () => {
    // estate has no per-label delete, so a detached repo's rows stay in the database. Returning
    // them under a project-scoped query would answer about a repo the project does not contain.
    // They are dropped HERE and named in `status.staleRepos` — excluded, not silently absent.
    const { hits } = attributeHits(
      [
        { id: 'a', name: 'x', kind: 'function', file: 'wicked-ledger/src/a.ts', line: 1 },
        { id: 'b', name: 'x', kind: 'function', file: 'detached-repo/src/b.ts', line: 2 },
      ],
      labels,
    );
    expect(hits.map((h) => h.repo)).toEqual(['wicked-ledger']);
  });

  it('drops a path with no label prefix rather than inventing a repo for it', () => {
    const { hits } = attributeHits([{ id: 'a', name: 'x', kind: 'f', file: 'src/a.ts', line: 1 }], labels);
    expect(hits).toEqual([]);
  });

  it('reads estate resolve\'s `symbol_id` as well as blast-radius\'s `id`', () => {
    const { hits } = attributeHits(
      [{ symbol_id: 'ts . . . wicked-vault/src/vault/vault/record().', name: 'record', kind: 'Function', file: 'wicked-vault/src/vault/vault.mjs', line: 196 }],
      labels,
    );
    expect(hits[0]?.id).toMatch(/record\(\)/);
    expect(hits[0]?.repo).toBe('wicked-vault');
  });
});
