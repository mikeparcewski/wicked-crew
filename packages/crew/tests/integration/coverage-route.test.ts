// `GET /governance/coverage` — repo-scoped coverage (FINDING-009).
//
// The bare endpoint reads the daemon store and reports a vacuous `coverage: 1.0` that names no repo;
// the real gate is per-repo, computed over that repo's OWN code graph. This pins the route contract:
// `?repo=<ref>` must reach `getCoverageReportForRepo(ref)` (NOT the daemon-wide `getCoverageReport`),
// an unknown repo — which core rejects rather than reporting vacuously — surfaces as 404, and the
// bare call still serves the daemon-wide report for backward compatibility.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, expect, describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { CoverageReport } from '../../src/core/types.js';

const REPO_REPORT = { coverage: 0.42, resolved: 21, accounted: 50 } as unknown as CoverageReport;
const DAEMON_REPORT = { coverage: 1.0, resolved: 0, accounted: 0 } as unknown as CoverageReport;

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** Records the repoRef the route passed through, so the test proves the wiring, not just the value. */
let lastRepoRef: string | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'coverage-route-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.getCoverageReport = async () => DAEMON_REPORT;
  adapter.getCoverageReportForRepo = async (repoRef: string) => {
    lastRepoRef = repoRef;
    // Core rejects an unknown repo — never a silent vacuous report (FINDING-009).
    if (repoRef === 'no-such-repo') throw new Error(`unknown repo: ${repoRef}`);
    return REPO_REPORT;
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

describe('GET /governance/coverage', () => {
  it('with ?repo= reports coverage over THAT repo (not the vacuous daemon report)', async () => {
    lastRepoRef = null;
    const res = await get('/api/v1/governance/coverage?repo=autogpt');
    expect(res.status).toBe(200);
    // Proves the wiring: the route reached the repo-scoped method with the given ref…
    expect(lastRepoRef).toBe('autogpt');
    // …and returned that repo's report, not the daemon-wide `coverage: 1.0`.
    expect((res.body['report'] as CoverageReport).coverage).toBe(0.42);
  });

  it('maps an unknown repo to 404 rather than a misleading success', async () => {
    const res = await get('/api/v1/governance/coverage?repo=no-such-repo');
    expect(res.status).toBe(404);
    expect(res.body['error']).toMatch(/unknown repo/);
  });

  it('without ?repo= still serves the daemon-wide report (backward compatible)', async () => {
    lastRepoRef = null;
    const res = await get('/api/v1/governance/coverage');
    expect(res.status).toBe(200);
    expect(lastRepoRef).toBeNull(); // the repo-scoped path was NOT taken
    expect((res.body['report'] as CoverageReport).coverage).toBe(1.0);
  });
});
