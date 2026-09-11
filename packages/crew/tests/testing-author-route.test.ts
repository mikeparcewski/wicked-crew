// Wave 6 — `POST /testing/author` launches the `qe-author-tests` WORKFLOW (never a free-text plan)
// over the operator's intent: one governed run per resolved repo, paused at its intake gate unless
// EXPLICITLY ungated, delivered by the ENGINE's deliver phase (`deliver: 'pr'` default), filed under
// the repo's `qe-tests-<repo>` label group, with the PLAN the intake gate shows on the 201
// (F-7R2-003/004/008/012/014 + F-075). The engine is the stub build with its launch stubbed so the
// launch INPUT is the thing under test; GET /campaigns then shows the group from launch.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { QE_AUTHOR_TESTS_WORKFLOW } from '../src/qe/author-workflow.js';
import type { AuditEntry, LaunchRunInput, Project, ProjectMember, RepoEntry, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const REPOS: RepoEntry[] = [
  { id: 'repo-alpha', name: 'alpha', root_path: '/x/alpha', default_branch: 'main', registered_at: 1 },
  { id: 'repo-beta', name: 'beta', root_path: '/x/beta', default_branch: 'main', registered_at: 2 },
];

const project = (id: string): Project => ({ id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 1, updated_at: 1 });
const repoMember = (projectId: string, ref: string): ProjectMember => ({
  id: `${projectId}:crew.repo:${ref}`, project_id: projectId, member_kind: 'crew.repo', member_ref: ref, meta: null, attached_at: 1, attached_by: 'api',
});

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let auditPath: string;
let launches: LaunchRunInput[] = [];

/** A completed-looking view for every stubbed launch, so GET /campaigns can join the group members. */
function viewOf(input: LaunchRunInput): SessionView {
  return {
    session: {
      id: input.sessionId, workflow_id: input.workflow ?? 'wf-x', problem: input.problem, entity_mode: 'shared', collection_scope: null,
      clis: ['stub'], status: 'awaiting_human', human_confirm: { before: 1 }, unit_ix: 1, attempt: 0, workdir: null,
      repo_ref: input.repoRef ?? null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'testing-author-'));
  auditPath = join(dir, 'audit.log');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.listRepos = async () => REPOS;
  adapter.projectGet = async (id: string) => (id === 'proj-two' ? project('proj-two') : null);
  adapter.projectMembers = async (id: string) => (id === 'proj-two' ? [repoMember('proj-two', 'repo-alpha'), repoMember('proj-two', 'repo-beta')] : []);
  adapter.launchRun = async (input: LaunchRunInput) => {
    launches.push(input);
    return input.sessionId;
  };
  adapter.sessionsDetail = async () => launches.map(viewOf);
  adapter.projectMemberAttach = async (projectId, kind, ref) => ({ member: { ...repoMember(projectId, ref), member_kind: kind } } as never);
  app = await createServer(adapter, { auditPath });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

beforeEach(() => {
  launches = [];
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function get(path: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${baseUrl}${path}`)).json()) as Record<string, unknown>;
}
/** The trail's entries once `pred` holds — appends are fire-and-forget on the log's own chain, so
 *  the file is polled (the testing-multiscope idiom), never read once. */
async function trail(pred: (entries: AuditEntry[]) => boolean, ms = 5_000): Promise<AuditEntry[]> {
  const deadline = Date.now() + ms;
  let entries: AuditEntry[] = [];
  while (Date.now() < deadline) {
    try {
      entries = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
      if (pred(entries)) return entries;
    } catch {
      /* not flushed yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return entries;
}

describe('POST /testing/author', () => {
  it('launches the qe-author-tests WORKFLOW over one repo: intake gate, engine delivery, label group, and the plan on the 201', async () => {
    const { status, body } = await post('/api/v1/testing/author', { problem: 'functional tests for the run lifecycle UI', repoRefs: ['repo-alpha'] });
    expect(status).toBe(201);
    expect(body['workflow']).toBe(QE_AUTHOR_TESTS_WORKFLOW);
    expect(body['runIds']).toEqual([body['runId']]);
    expect(body['gate']).toBe('before:1');
    expect(body['deliver']).toBe('pr');
    expect(body['campaignRegistered']).toBe(false);
    expect(body['runs']).toEqual([{ runId: body['runId'], repoRef: 'repo-alpha', label: 'qe-tests-alpha' }]);
    const plan = body['plan'] as { workflow: string; phases: Array<{ id: string; executor: string; role: string; engine?: boolean }>; seats: string[] };
    expect(plan.workflow).toBe(QE_AUTHOR_TESTS_WORKFLOW);
    expect(plan.phases.map((p) => p.id)).toEqual(['recon', 'author', 'verify', 'review', 'deliver']);
    expect(plan.phases.find((p) => p.id === 'deliver')).toMatchObject({ executor: 'tool', engine: true });
    expect(Array.isArray(plan.seats)).toBe(true);

    // The launch INPUT is the point: a WORKFLOW launch, gated, repo-bound, delivered by the engine.
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      problem: 'functional tests for the run lifecycle UI',
      workflow: QE_AUTHOR_TESTS_WORKFLOW,
      humanConfirm: 'before:1',
      repoRef: 'repo-alpha',
      deliver: 'pr',
    });
    // The roster handed to the engine is the standing roster (crew's readings are translated at the adapter).
    expect(Array.isArray(JSON.parse(launches[0]!.clisJson))).toBe(true);

    // The durable record: `run.launched` carries the workflow, the delivery decision and the group label…
    const isOurs = (e: AuditEntry) => e.action === 'run.launched' && e.runId === body['runId'];
    const launched = (await trail((entries) => entries.some(isOurs))).filter(isOurs);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.detail).toMatchObject({ workflow: QE_AUTHOR_TESTS_WORKFLOW, deliver: 'pr', groupLabel: 'qe-tests-alpha', author: true, gate: 'before:1', repoRef: 'repo-alpha' });
    // …and GET /campaigns shows the group from launch (F-7R2-014), plus the (still empty) test sets.
    const campaigns = await get('/api/v1/campaigns');
    const groups = campaigns['groups'] as Array<{ label: string; runs: Array<{ runId: string }> }>;
    expect(groups.find((g) => g.label === 'qe-tests-alpha')?.runs.map((r) => r.runId)).toEqual([body['runId']]);
    expect(campaigns['test_sets']).toEqual([]);
  });

  it('ungated:true launches unattended; deliver:none leaves delivery off and the plan without the deliver phase', async () => {
    const { status, body } = await post('/api/v1/testing/author', { problem: 'x', repoRefs: ['repo-alpha'], ungated: true, deliver: 'none' });
    expect(status).toBe(201);
    expect(body['gate']).toBe('none');
    expect(body['deliver']).toBe('none');
    expect(launches[0]).toMatchObject({ humanConfirm: 'none' });
    expect('deliver' in launches[0]!).toBe(false);
    expect((body['plan'] as { phases: Array<{ id: string }> }).phases.map((p) => p.id)).toEqual(['recon', 'author', 'verify', 'review']);
  });

  it('a project scope fans one run per repo member, each under its own repo label', async () => {
    const { status, body } = await post('/api/v1/testing/author', { problem: 'x', projectId: 'proj-two' });
    expect(status).toBe(201);
    expect(body['scope']).toBe('project');
    expect((body['runIds'] as string[]).length).toBe(2);
    expect((body['runs'] as Array<{ label: string }>).map((r) => r.label)).toEqual(['qe-tests-alpha', 'qe-tests-beta']);
    expect(launches.map((l) => l.repoRef)).toEqual(['repo-alpha', 'repo-beta']);
    expect(launches.every((l) => l.workflow === QE_AUTHOR_TESTS_WORKFLOW && l.projectId === 'proj-two')).toBe(true);
  });

  it('a NARROWED project scope — projectId + repoRefs — authors into the named repos only, filed into the project (studio #263 F-4; unlike recon’s union)', async () => {
    const { status, body } = await post('/api/v1/testing/author', { problem: 'x', projectId: 'proj-two', repoRefs: ['repo-alpha'] });
    expect(status).toBe(201);
    expect(body['scope']).toBe('repoRefs');
    expect((body['runIds'] as string[]).length).toBe(1);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ repoRef: 'repo-alpha', projectId: 'proj-two', workflow: QE_AUTHOR_TESTS_WORKFLOW });
    // The filing project is still validated by name: unknown → 404; the synthesized default → 400.
    expect((await post('/api/v1/testing/author', { problem: 'x', projectId: 'proj-none', repoRefs: ['repo-alpha'] })).status).toBe(404);
    const dflt = await post('/api/v1/testing/author', { problem: 'x', projectId: 'default', repoRefs: ['repo-alpha'] });
    expect(dflt.status).toBe(400);
    expect(String(dflt.body['error'])).toContain('default');
    expect(launches).toHaveLength(1); // neither refusal launched anything
  });

  it('refuses an unscoped author (nothing to author into), an unknown project, and an unknown field — by name', async () => {
    const unscoped = await post('/api/v1/testing/author', { problem: 'x' });
    expect(unscoped.status).toBe(400);
    expect(String(unscoped.body['error'])).toContain('repository');
    expect(launches).toEqual([]);
    expect((await post('/api/v1/testing/author', { problem: 'x', projectId: 'proj-none' })).status).toBe(404);
    const typo = await post('/api/v1/testing/author', { problem: 'x', repoRefs: ['repo-alpha'], ungate: true });
    expect(typo.status).toBe(400);
    expect(String(typo.body['error'])).toContain('`ungate`');
    expect(launches).toEqual([]);
  });

  it('GET /workflows lists the workflow the launch used (F-075: the catalog carries a test/QE workflow)', async () => {
    const wf = (await get('/api/v1/workflows'))['workflows'] as Array<{ id: string; is_system?: boolean }>;
    const qe = wf.find((w) => w.id === QE_AUTHOR_TESTS_WORKFLOW);
    expect(qe).toBeDefined();
    expect(qe?.is_system).toBeUndefined();
  });
});
