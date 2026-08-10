// `GET /governance/graph` — repo-scoped code-graph summary (#122).
//
// The daemon store holds run/governance nodes, not a repo's code graph, so there is no meaningful
// daemon-wide graph view: this endpoint is repo-scoped ONLY. Pins the contract — `?repo=<ref>`
// reaches `getGraphKindsForRepo(ref)` and returns its kinds; a missing repo is 400; an unknown repo
// (which core rejects, never a silent empty summary) is 404; a repeated `?repo=` array is tolerated.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, expect, describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { GraphKind } from '../../src/core/types.js';

const KINDS: GraphKind[] = [
  { kind: 'function', count: 2 },
  { kind: 'struct', count: 1 },
];

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

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
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
