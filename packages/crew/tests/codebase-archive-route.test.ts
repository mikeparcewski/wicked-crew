// crew#720 — the run wire serves the final-codebase zip (`codebase_archive` + the download route)
// and the credentials-missing receipt (`deliver_credentials`) read from the deliver unit's refusal.

import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { CodebaseArchiveStore, deliverDispatchKey } from '../src/api/codebase-archive.js';
import { deliverPrScript } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';

const RUN = 'c0debase-7200-4000-8000-000000000001';
const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repoWithWork(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-720-route-'));
  roots.push(root);
  const g = (...a: string[]): string => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(root, 'README.md'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  return root;
}

function view(workdir: string, denial: string | null): SessionView {
  return {
    session: {
      id: RUN, workflow_id: 'feature-deliver', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['stub'],
      status: 'awaiting_human', human_confirm: 'none', unit_ix: 1, attempt: 0, workdir, repo_ref: 'repo-1',
      extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [
      { id: `${RUN}:deliver`, session_id: RUN, ord: 1, description: 'deliver', stage: 'act', status: denial === null ? 'done' : 'awaiting_human', denial_reason: denial, tool_cmd: ['bash', '-lc', 'x'] },
    ],
  } as unknown as SessionView;
}

async function app(views: SessionView[], store: CodebaseArchiveStore): Promise<FastifyInstance> {
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    listRepos: vi.fn(async () => []),
  } as unknown as CoreAdapter;
  const a = Fastify({ logger: false });
  registerRoutes(a, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' }, {
    deliveryIndex: new DeliveryIndex(),
    codebaseArchives: store,
  });
  apps.push(a);
  await a.ready();
  return a;
}

describe('crew#720 the run wire: codebase_archive, the zip route, deliver_credentials', () => {
  it('serves the archive record on GET /runs/:id and the zip bytes (with their sha256) on the artifact route', async () => {
    const wd = repoWithWork();
    const store = new CodebaseArchiveStore(join(wd, '..', `${RUN}-artifacts`));
    roots.push(join(wd, '..', `${RUN}-artifacts`));
    const rec = await store.archive(RUN, { workdir: wd }, 'deliver');
    expect(rec).not.toBeNull();
    const a = await app([view(wd, 'deliver: Azure DevOps credentials not configured: …\ndeliver: CREDENTIALS-MISSING azure_devops; deliver: PUSH-REJECTED')], store);

    const run = (await a.inject({ method: 'GET', url: `/api/v1/runs/${RUN}` })).json() as { run: { session: Record<string, unknown> } };
    expect(run.run.session['codebase_archive']).toEqual(rec);
    expect(run.run.session['deliver_credentials']).toMatchObject({ provider: 'azure_devops', status: 'missing' });

    const zip = await a.inject({ method: 'GET', url: rec!.url });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['x-content-sha256']).toBe(rec!.sha256);
    expect(createHash('sha256').update(zip.rawPayload).digest('hex')).toBe(rec!.sha256);
    const out = join(wd, '..', `${RUN}.zip`);
    writeFileSync(out, zip.rawPayload);
    roots.push(out);
    const entries = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    // The run's tree: the tracked file plus the new source file; never `.env`, never `.git`.
    expect(entries.filter((e) => !e.endsWith('/'))).toEqual(['README.md', 'src/a.ts']);
  });

  it('404s a run with no archive, and serves no deliver_credentials once the deliver unit is done', async () => {
    const wd = repoWithWork();
    const store = new CodebaseArchiveStore(join(wd, '..', `${RUN}-empty`));
    const a = await app([view(wd, null)], store);
    expect((await a.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/artifacts/codebase.zip` })).statusCode).toBe(404);
    const run = (await a.inject({ method: 'GET', url: `/api/v1/runs/${RUN}` })).json() as { run: { session: Record<string, unknown> } };
    expect(run.run.session['codebase_archive']).toBeUndefined();
    expect(run.run.session['deliver_credentials']).toBeUndefined();
  });
});

describe('crew#720 the deliver-archive trigger', () => {
  it('keys only a dispatched crew deliver script', () => {
    const script = deliverPrScript('x', { runId: RUN });
    expect(deliverDispatchKey({ type: 'toolExecutorDispatched', session: RUN, ord: 4, cmd: ['bash', '-lc', script] })).toBe(`${RUN}\0${4}`);
    expect(deliverDispatchKey({ type: 'toolExecutorDispatched', session: RUN, ord: 2, cmd: ['node', 'persist-graph.js'] })).toBeNull();
    expect(deliverDispatchKey({ type: 'unitOutputCaptured', session: RUN, ord: 4 })).toBeNull();
  });
});
