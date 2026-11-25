// crew#372: the compose facts publish trusts ride the REAL launch. A compose through the daemon's own route (createServer
// on the stub-runner CoreAdapter) records them on `run.launched`; a fresh run-timing index hydrated from that audit trail
// reads them back; and the daemon's publish route sees the run as a compose (not `not_a_compose`).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let projectId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'publish-launch-'));
  const root = join(dir, 'alpha');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'estate.db'), '');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  projectId = (await adapter.projectCreate('publish-launch')).id;
  const graph = {
    metadata: { schema_version: '1.0.0', migration_mode: 'x' },
    domains: { billing: { requirements: { r1: { title: 'Invoices are numbered', description: '', business_rules: [], validations: [], error_paths: [] } }, entities: {} } },
  };
  // The project's one repository and its requirements graph, as product-compose.test.ts serves them.
  adapter.projectMembers = (async () => [{ member_kind: 'crew.repo', member_ref: 'alpha' }]) as never;
  adapter.listRepos = (async () => [{ id: 'alpha', name: 'alpha', root_path: root, code_graph_db: join(root, 'estate.db') }]) as never;
  adapter.getRequirementsGraphForRepo = (async () => ({ graph, coverage: null })) as never;
  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('compose facts through the real launch', () => {
  it('run.launched carries them, a fresh index hydrates them, and publish reads the run as a compose', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/product/compose`, payload: { requirements: [{ repoId: 'alpha', key: 'billing::r1' }] } });
    expect(res.statusCode, res.body).toBe(202);
    const runId = (res.json() as { runId: string }).runId;
    // The daemon's trail is written behind the answer: wait for its launch entry.
    let trail = '';
    for (let i = 0; i < 100 && !trail.includes('"run.launched"'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      trail = existsSync(join(dir, 'audit.log')) ? readFileSync(join(dir, 'audit.log'), 'utf8') : '';
    }
    const launchLine = trail.split('\n').find((l) => l.includes('"run.launched"')) ?? '';
    expect(Object.keys((JSON.parse(launchLine) as { detail: Record<string, unknown> }).detail)).toContain('compose');
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    const fresh = new RunTimingIndex();
    await fresh.hydrate(audit);
    expect(fresh.composeOf(runId)).toMatchObject({ projectId, requirements: [{ repoId: 'alpha', key: 'billing::r1' }], level: 'stories', steps: [{ id: 'draft', catalog: 'produce' }, { id: 'review', catalog: 'critique' }] });
    // The daemon's own publish route reads the run as this project's compose: it is judged on its state and its plan,
    // never refused as not a compose.
    const r = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/product/publish`, payload: { runId, repo: 'owner/app' } });
    expect(r.statusCode, r.body).toBe(409);
    expect(['run_not_finished', 'plan_unreadable'], r.body).toContain((r.json() as { code: string }).code);
  });
});
