// crew#1476, crew#1477: paths and possible boundaries keep current-member provenance.
import Fastify from 'fastify';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CoreAdapter } from '../src/core/adapter.js';
import * as graph from '../src/projects/graph.js';
import { registerProjectRoutes } from '../src/projects/routes.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let app: FastifyInstance;
let q: Extract<graph.Queryable, { ok: true }>;
let exe: string;

function estate(reply: unknown, support = true): NodeJS.ProcessEnv {
  exe = join(dir, 'estate.cjs');
  writeFileSync(exe, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(argv) + '\\n');
process.stdout.write(argv.includes('--help') ? ${JSON.stringify(support ? '  wicked-estate link --project <id> [--status]' : 'old estate')} : JSON.stringify(${JSON.stringify(reply)}));
`);
  chmodSync(exe, 0o755);
  return { ...process.env, WICKED_ESTATE_EXE: exe };
}

const end = (label: string, name: string) => ({ symbol: `sym-${name}`, name, kind: 'Function', file: `${label}/src/${name}.ts`, line: 0, line_1based: 7 });
const crossing = (id: string, from: string, to: string) => ({ id, from: { repo: from }, to: { repo: to } });
const pathReply = () => ({ from: 'a', to: 'b', found: true, resolved: true, unresolved: null,
  hops: [{ source: end('api', 'a'), target: end('web', 'b'), kind: 'calls', confidence: 0.9 }],
  depth_bounded: false, node_bounded: false,
  crossings: [crossing('kept', 'api', 'web'), crossing('gone', 'gone', 'web')],
});
const statusReply = () => ({ project: 'p1', generation: 4, stale: true, stale_labels: ['web', 'gone'], last_error: 'previous failure', coverage: [
  { label: 'web', links_in: 2, incomplete: true, boundaries: { unresolved: ['z', 'a'] }, boundary_counts: { unresolved: 2 } },
  { label: 'api', links_out: 2, package_imports: 3, manifests: 1, boundaries: { undeclared: ['pkg'] } },
  { label: 'gone', boundaries: { unresolved: ['removed'] } },
] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'project-path-boundaries-'));
  q = { ok: true, dbPath: join(dir, 'graph.db'), labels: new Map([['api', 'repo-api'], ['web', 'repo-web']]),
    status: { projectId: 'p1', missingRepos: [] } } as unknown as typeof q;
  app = Fastify();
  const adapter = { projectGet: vi.fn(async () => ({ id: 'p1' })) } as unknown as CoreAdapter;
  registerProjectRoutes(app, adapter, { bus: null, index: new MembershipIndex(), log: () => undefined,
    settings: new ProjectSettingsStore(join(dir, 'settings.json')) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await app.close();
  removeScratch(dir);
});

describe.skipIf(process.platform === 'win32')('project path (crew#1476)', () => {
  it('attributes endpoints, uses 1-based lines, filters crossings and passes max depth', async () => {
    const env = estate(pathReply());
    const out = await graph.projectGraphPath(q, 'a', 'b', 6, env);
    expect(out).toMatchObject({ found: true, resolved: true, unresolved: null, linkage: 'linked', reposSearched: ['api', 'web'], hops: [{
      source: { repoId: 'repo-api', repo: 'api', symbol: 'sym-a', name: 'a', kind: 'Function', file: 'src/a.ts', line: 7 },
      target: { repoId: 'repo-web', repo: 'web', file: 'src/b.ts', line: 7 }, kind: 'calls', confidence: 0.9,
    }], crossings: [{ id: 'kept' }] });
    expect(JSON.parse(readFileSync(join(dir, 'calls'), 'utf8').trim())).toEqual(['path', 'a', 'b', '--db', q.dbPath, '--json', '--max-depth', '6']);
  });

  it('excludes the entire route when any endpoint belongs to a removed member', async () => {
    const raw = pathReply();
    raw.hops[0]!.target = end('gone', 'b');
    const out = await graph.projectGraphPath(q, 'a', 'b', undefined, estate(raw));
    expect(out).toMatchObject({ found: false, hops: [], excluded: 'the route found runs through a repository that is no longer in this project; refresh the project graph' });
  });

  it.each(['depth_bounded', 'node_bounded'] as const)('preserves a not-found %s disclosure', async (bound) => {
    const raw = { ...pathReply(), found: false, hops: [], crossings: [], [bound]: true };
    const out = await graph.projectGraphPath(q, 'a', 'b', undefined, estate(raw));
    expect(out).toMatchObject({ found: false, [bound]: true, hops: [], linkage: 'co-located' });
    expect(out.note).toContain('The search stopped at its depth or node bound');
  });

  it('relays an unresolved name', async () => {
    const out = await graph.projectGraphPath(q, 'a', 'b', undefined, estate({ ...pathReply(), found: false, resolved: false, unresolved: 'from', hops: [] }));
    expect(out).toMatchObject({ found: false, resolved: false, unresolved: 'from', hops: [] });
  });

  it('routes valid paths through the queryable gate', async () => {
    vi.spyOn(graph, 'queryable').mockResolvedValue(q);
    vi.stubEnv('WICKED_ESTATE_EXE', estate(pathReply())['WICKED_ESTATE_EXE']!);
    const res = await app.inject('/api/v1/projects/p1/graph/path?from=a&to=b&maxDepth=6');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: true, hops: [{ source: { repo: 'api' } }] });
  });

  it.each(['', '?from=a', '?to=b', '?from=%20&to=b', '?from=a&to=b&maxDepth=0', '?from=a&to=b&maxDepth=17', '?from=a&to=b&maxDepth=1.5', '?from=a&to=b&maxDepth=no'])('rejects missing names or invalid depth: %s', async (query) => {
    expect((await app.inject(`/api/v1/projects/p1/graph/path${query}`)).statusCode).toBe(400);
  });
});

describe.skipIf(process.platform === 'win32')('project boundaries (crew#1477)', () => {
  it('attributes full possible packages and coverage, excludes removed members, and sorts', async () => {
    const out = await graph.projectGraphBoundaries(q, estate(statusReply()));
    expect(out).toMatchObject({ linked: true, generation: 4, stale: true, stale_labels: ['web'], last_error: 'previous failure',
      members: [
        { repoId: 'repo-api', repo: 'api', links_out: 2, package_imports: 3, manifests: 1 },
        { repoId: 'repo-web', repo: 'web', links_in: 2, incomplete: true, boundary_counts: { unresolved: 2 } },
      ], possible: [
        { repoId: 'repo-api', repo: 'api', reason: 'undeclared', package: 'pkg' },
        { repoId: 'repo-web', repo: 'web', reason: 'unresolved', package: 'a' },
        { repoId: 'repo-web', repo: 'web', reason: 'unresolved', package: 'z' },
      ] });
    expect(out.note).toBe('possible = imports estate could not prove are links to another member, by reason; never edges');
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(calls[1]).toEqual(['link', '--project', 'p1', '--status', '--json', '--db', q.dbPath]);
  });

  it('caps possible rows at 500 and discloses the full total', async () => {
    const raw = statusReply();
    raw.coverage = [{ label: 'api', boundaries: { unresolved: Array.from({ length: 502 }, (_, i) => `p${String(i).padStart(3, '0')}`) } }];
    const out = await graph.projectGraphBoundaries(q, estate(raw));
    expect(out.possible).toHaveLength(500);
    expect(out).toMatchObject({ possible_total: 502, possible_truncated: true });
  });

  it('discloses a never-linked project', async () => {
    const out = await graph.projectGraphBoundaries(q, estate(null));
    expect(out).toMatchObject({ linked: false, members: [], possible: [], note: 'this project has not been linked yet; refresh its code graph' });
  });

  it('discloses an estate without link capability and never runs link', async () => {
    const out = await graph.projectGraphBoundaries(q, estate(null, false));
    expect(out).toMatchObject({ linked: false, members: [], possible: [], note: 'this wicked-estate cannot link repositories (X1, wicked-estate 0.34.0+); upgrade it to see boundaries' });
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim()).toBe('["--help"]');
  });

  it('serves boundaries over HTTP', async () => {
    vi.spyOn(graph, 'queryable').mockResolvedValue(q);
    vi.stubEnv('WICKED_ESTATE_EXE', estate(statusReply())['WICKED_ESTATE_EXE']!);
    const res = await app.inject('/api/v1/projects/p1/graph/boundaries');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linked: true, possible: [{ repo: 'api' }, { repo: 'web' }, { repo: 'web' }] });
  });

  it.each(['path?from=a&to=b', 'boundaries'])('shares query refusal and default project handling: %s', async (suffix) => {
    vi.spyOn(graph, 'queryable').mockResolvedValue({ ok: false, status: { state: 'engine-too-old', detail: 'upgrade the engine' } } as graph.Queryable);
    const res = await app.inject(`/api/v1/projects/p1/graph/${suffix}`);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: 'upgrade the engine' });
    expect((await app.inject(`/api/v1/projects/default/graph/${suffix}`)).statusCode).toBe(404);
  });
});
