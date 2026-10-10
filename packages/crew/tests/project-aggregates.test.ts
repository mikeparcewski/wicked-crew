// crew#371: a project's requirements / domain / coverage, folded over its repos' own reads. Every
// member is a row (ok / absent / error / dangling), never dropped; the requirements window is global.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { projectCoverage, registerProjectAggregateRoutes } from '../src/api/project-aggregates.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { ProjectsUnsupportedError } from '../src/core/adapter.js';

function writeGraph(root: string, domains: Record<string, { reqs: string[]; entities?: string[]; description?: string }>): void {
  mkdirSync(join(root, '.wicked-estate', 'requirements'), { recursive: true });
  const graph = {
    metadata: { schema_version: '1.0.0', migration_mode: 'x' },
    domains: Object.fromEntries(
      Object.entries(domains).map(([name, d]) => [
        name,
        {
          ...(d.description !== undefined ? { description: d.description } : {}),
          requirements: Object.fromEntries(d.reqs.map((r) => [r, { title: `${r} title`, description: '', business_rules: [{ id: 'b', statement: `${r} rule`, confidence: 1, provenance: { source: 's' } }], validations: [], error_paths: [] }])),
          entities: Object.fromEntries((d.entities ?? []).map((e) => [e, {}])),
        },
      ]),
    ),
  };
  writeFileSync(join(root, '.wicked-estate', 'requirements', 'requirements_graph.json'), JSON.stringify(graph));
}

const report = (behavior: number, resolved: number) => ({
  total: behavior + 1, behavior_bearing: behavior, resolved, risk_flagged: 0, unaccounted: behavior - resolved,
  coverage: behavior > 0 ? resolved / behavior : 1, resolved_rate: 0, mean_confidence: 0, resolve_threshold: 0, per_app: [], unaccounted_nodes: [],
});

describe('project aggregates (crew#371)', () => {
  let base: string;
  let app: FastifyInstance;
  const repos: Array<{ id: string; name: string; root_path: string }> = [];
  const adapter = {
    projectGet: vi.fn(async (id: string) => (id === 'p1' || id === 'empty' ? { id } : null)),
    projectMembers: vi.fn(async (id: string) =>
      id === 'p1'
        ? ['alpha', 'beta', 'gamma', 'gone'].map((ref) => ({ member_kind: 'crew.repo', member_ref: ref })).concat([{ member_kind: 'crew.run', member_ref: 'r1' }])
        : [],
    ),
    listRepos: vi.fn(async () => repos),
    getCoverageReportForRepo: vi.fn(async (ref: string) => {
      if (ref === 'alpha') return report(10, 5);
      if (ref === 'beta') return report(30, 30);
      if (ref === 'gamma') return null;
      throw new Error(`no registered repo '${ref}'`);
    }),
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'proj-agg-'));
    for (const id of ['alpha', 'beta', 'gamma']) {
      const root = join(base, id);
      mkdirSync(root, { recursive: true });
      repos.push({ id, name: `${id}-name`, root_path: root });
    }
    writeGraph(join(base, 'alpha'), { billing: { reqs: ['a1', 'a2', 'a3'], entities: ['Invoice'], description: 'Money' }, auth: { reqs: ['a4'] } });
    writeGraph(join(base, 'beta'), { billing: { reqs: ['b1', 'b2'], entities: ['Invoice', 'Ledger'] } });
    // gamma: no artifact -> absent. gone: a member with no registry record -> dangling.
    app = Fastify({ logger: false });
    registerProjectAggregateRoutes(app, adapter as unknown as CoreAdapter);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('requirements: every member is a row; the window is GLOBAL across repos in membership order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/p1/requirements?offset=2&limit=3' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows.map((r: { repo: { id: string }; state: string }) => [r.repo.id, r.state])).toEqual([
      ['alpha', 'ok'], ['beta', 'ok'], ['gamma', 'absent'], ['gone', 'dangling'],
    ]);
    expect(body.totals).toMatchObject({ repos: 4, ok: 2, absent: 1, errors: 0, dangling: 1, total: 6, corpus: 6 });
    // alpha holds 4 matching (window starts at its 3rd), beta fills the rest.
    expect(body.rows[0].total).toBe(4);
    expect(body.rows[0].items.map((i: { reqId: string }) => i.reqId)).toHaveLength(2);
    expect(body.rows[1].items.map((i: { reqId: string }) => i.reqId)).toEqual(['b1']);
    expect(body.rows[2].reason).toMatch(/not generated/);
    expect(body.rows[3]).toMatchObject({ repo: { id: 'gone', name: null }, items: [] });
  });

  it('requirements: the query filters every repo; a window past alpha starts in beta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/p1/requirements?q=b2&offset=0&limit=50' });
    const body = res.json();
    expect(body.totals.total).toBe(1);
    expect(body.rows[0].items).toEqual([]);
    expect(body.rows[1].items.map((i: { key: string }) => i.key)).toEqual(['billing::b2']);
  });

  it('requirements: an unknown query key is a 400; an unknown project a 404; the default project is empty', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/p1/requirements?bogus=1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/nope/requirements' })).statusCode).toBe(404);
    const def = await app.inject({ method: 'GET', url: '/api/v1/projects/default/requirements' });
    expect(def.statusCode).toBe(200);
    expect(def.json().rows).toEqual([]);
  });

  it('domain: per-repo summaries and the merged list (domain name -> the repos that model it)', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/v1/projects/p1/domain' })).json();
    expect(body.rows[0]).toMatchObject({ state: 'ok', domains: [{ name: 'billing', description: 'Money', requirements: 3, entities: 1 }, { name: 'auth', description: null, requirements: 1, entities: 0 }] });
    expect(body.rows[2].state).toBe('absent');
    expect(body.rows[3].state).toBe('dangling');
    expect(body.merged).toEqual([
      { name: 'auth', repoIds: ['alpha'], requirements: 1, entities: 0 },
      { name: 'billing', repoIds: ['alpha', 'beta'], requirements: 5, entities: 3 },
    ]);
    expect(body.totals).toMatchObject({ domains: 2, requirements: 6, entities: 3 });
  });

  it('coverage: per-repo reports, the WEIGHTED project coverage, an empty graph is absent', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/v1/projects/p1/coverage' })).json();
    expect(body.rows.map((r: { state: string }) => r.state)).toEqual(['ok', 'ok', 'absent', 'dangling']);
    expect(body.totals).toMatchObject({ behavior_bearing: 40, resolved: 35, coverage: 35 / 40 });
    const empty = (await app.inject({ method: 'GET', url: '/api/v1/projects/empty/coverage' })).json();
    expect(empty.totals.coverage).toBeNull();
  });

  it('coverage: a repo that does not answer in time is that row\'s error, the rest still answer', async () => {
    const slow = { ...adapter, getCoverageReportForRepo: vi.fn(async (ref: string) => (ref === 'alpha' ? new Promise(() => undefined) : report(4, 2))) };
    const res = await projectCoverage(slow as unknown as CoreAdapter, 'p1', 50);
    expect(res.rows[0]).toMatchObject({ state: 'error', reason: expect.stringMatching(/did not answer within/) });
    expect(res.rows[1]?.state).toBe('ok');
  });

  it('codex on #907: a hung coverage read is JOINED by the next request, never started twice; rows carry no node list', async () => {
    let calls = 0;
    const hung = { ...adapter, getCoverageReportForRepo: vi.fn(async (ref: string) => { if (ref === 'alpha') { calls++; return new Promise(() => undefined); } return report(4, 2); }) };
    await projectCoverage(hung as unknown as CoreAdapter, 'p1', 20);
    await projectCoverage(hung as unknown as CoreAdapter, 'p1', 20);
    expect(calls).toBe(1);
    const res = await projectCoverage(adapter as unknown as CoreAdapter, 'p1', 50);
    expect(res.rows[1]?.report).not.toHaveProperty('unaccounted_nodes');
    expect(res.rows[1]?.report).toMatchObject({ behavior_bearing: 30, unaccounted: 0 });
  });

  it('codex on #907: a members read on an engine without projects is a 501 too', async () => {
    const old = Fastify({ logger: false });
    registerProjectAggregateRoutes(old, { ...adapter, projectMembers: vi.fn(async () => { throw new ProjectsUnsupportedError('Listing project members'); }) } as unknown as CoreAdapter);
    await old.ready();
    expect((await old.inject({ method: 'GET', url: '/api/v1/projects/p1/requirements' })).statusCode).toBe(501);
    await old.close();
  });

  it('an engine without projects is a 501', async () => {
    const old = Fastify({ logger: false });
    registerProjectAggregateRoutes(old, { ...adapter, projectGet: vi.fn(async () => { throw new ProjectsUnsupportedError('Reading a project'); }) } as unknown as CoreAdapter);
    await old.ready();
    expect((await old.inject({ method: 'GET', url: '/api/v1/projects/p1/domain' })).statusCode).toBe(501);
    await old.close();
  });
});
