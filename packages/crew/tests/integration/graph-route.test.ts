// `GET /governance/graph` — repo-scoped code-graph summary (#122).
//
// The daemon store holds run/governance nodes, not a repo's code graph, so there is no meaningful
// daemon-wide graph view: this endpoint is repo-scoped ONLY. Pins the contract — `?repo=<ref>`
// reaches `getGraphKindsForRepo(ref)` and returns its kinds; a missing repo is 400; an unknown repo
// (which core rejects, never a silent empty summary) is 404; a repeated `?repo=` array is tolerated.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, expect, describe, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { GraphKind } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const KINDS: GraphKind[] = [
  { kind: 'function', count: 2 },
  { kind: 'struct', count: 1 },
];

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;

/** Records the repoRef the route passed through, so the test proves wiring, not just a value. */
let lastRepoRef: string | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'graph-route-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.getGraphKindsForRepo = async (repoRef: string) => {
    lastRepoRef = repoRef;
    if (repoRef === 'no-such-repo') throw new Error(`no registered repo '${repoRef}'`);
    // A non-not-found failure (binding/parse drift) is OURS → the route must 500, not 404.
    if (repoRef === 'boom') throw new Error('getGraphKindsForRepo: engine returned invalid JSON');
    return KINDS;
  };

  app = await createServer(adapter);
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

async function get(path: string) {
  // crew#1556: route injection also works where the test host cannot open sockets.
  const res = await app.inject({ method: 'GET', url: path });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('GET /governance/graph', () => {
  it('with ?repo= returns that repo’s node-count-by-kind summary', async () => {
    lastRepoRef = null;
    const res = await get('/api/v1/governance/graph?repo=autogpt');
    expect(res.status).toBe(200);
    expect(lastRepoRef).toBe('autogpt');
    expect(res.body['kinds']).toEqual(KINDS);
  });

  it('tolerates a repeated ?repo= array (takes the first)', async () => {
    lastRepoRef = null;
    const res = await get('/api/v1/governance/graph?repo=autogpt&repo=other');
    expect(res.status).toBe(200);
    expect(lastRepoRef).toBe('autogpt');
  });

  it('requires a repo — a bare call is 400, not a vacuous summary', async () => {
    const res = await get('/api/v1/governance/graph');
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/requires a \?repo=/);
  });

  it('maps an unknown repo to 404', async () => {
    const res = await get('/api/v1/governance/graph?repo=no-such-repo');
    expect(res.status).toBe(404);
    expect(res.body['error']).toMatch(/no registered repo/);
  });

  it('trims a padded repo before the registry lookup', async () => {
    lastRepoRef = null;
    const res = await get('/api/v1/governance/graph?repo=%20autogpt%20');
    expect(res.status).toBe(200);
    expect(lastRepoRef).toBe('autogpt'); // trimmed, not " autogpt "
  });

  it('maps an internal (non-not-found) failure to 500, not 404', async () => {
    const res = await get('/api/v1/governance/graph?repo=boom');
    expect(res.status).toBe(500);
  });
});

// crew#1555, crew#1556: the repo route carries estate's additive fields and every page's drift.
describe.skipIf(process.platform === 'win32')('repo blast-radius wire', () => {
  it('passes depth, stale, resolved and merged freshness through two pages', async () => {
    const priorPath = process.env['PATH'];
    const priorList = adapter.listRepos;
    const db = join(dir, 'blast.db');
    const exe = join(dir, 'wicked-estate');
    const freshness = { commits_behind: 0, indexing: [], roots: [], stale_files: [], stale_files_total: 0, unindexed_files: 0, checked_files: 1, not_file_backed: 0 };
    const pages = [
      { target: 'f', resolved: true, dependents: [{ id: 'a', name: 'a', kind: 'Function', file: 'a.ts', line: 1, depth: 2, stale: 'modified' }], next_cursor: 'c1', freshness: { ...freshness, stale_files: [{ file: 'a.ts', status: 'modified' }], stale_files_total: 1, checked_files: 2 } },
      { target: 'f', resolved: true, dependents: [], next_cursor: null, freshness },
    ];
    writeFileSync(db, '');
    writeFileSync(exe, `#!/usr/bin/env node
const pages = ${JSON.stringify(pages)};
process.stdout.write(JSON.stringify(pages[process.argv.includes('--cursor') ? 1 : 0]));
`);
    chmodSync(exe, 0o755);
    process.env['PATH'] = `${dir}:${priorPath ?? ''}`;
    adapter.listRepos = async () => [{ id: 'blast', name: 'blast', root_path: dir, default_branch: 'main', registered_at: 0, code_graph_db: db }];
    try {
      const res = await get('/api/v1/repos/blast/graph/blast-radius?name=f');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ resolved: true, dependents: [{ depth: 2, stale: 'modified' }], freshness: {
        stale_files: [{ file: 'a.ts', status: 'modified' }], stale_files_total: 1, checked_files: 3,
      } });
    } finally {
      adapter.listRepos = priorList;
      if (priorPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = priorPath;
    }
  });
});
