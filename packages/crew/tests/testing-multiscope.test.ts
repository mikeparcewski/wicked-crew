// The pinned multiscope wire (testing UX): POST /testing/recon (the recon trigger) and
// POST /campaigns accept optional `projectId` / `repoRefs`, resolve them fail-closed (errors
// NAME the bad ref / project), and — because one engine run carries ONE repo — fan a multi-repo
// launch into one run per repo under one shared campaign label, answering with `runIds` in the
// caller's resolved order. Neither field ⇒ today's behavior, byte-for-byte (regression pins).
//
// Route behavior over a stubbed adapter (the campaign-routes.test.ts pattern): the engine seams
// (`launchRun`, `launchCampaign`, `listRepos`, `projectGet`, `projectMembers`) are stubbed
// instance-level so this file pins the HTTP contract, not the scheduler.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type {
  AuditEntry,
  CampaignDef,
  LaunchRunInput,
  Project,
  ProjectMember,
  RepoEntry,
  WorkflowDef,
} from '../src/core/types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────────

const REPOS: RepoEntry[] = [
  { id: 'repo-alpha', name: 'alpha', root_path: '/x/alpha', default_branch: 'main', registered_at: 1 },
  { id: 'repo-beta', name: 'beta', root_path: '/x/beta', default_branch: 'main', registered_at: 2 },
  { id: 'repo-gamma', name: 'gamma', root_path: '/x/gamma', default_branch: 'main', registered_at: 3 },
];

function project(id: string, status: 'active' | 'archived' = 'active'): Project {
  return {
    id,
    name: id,
    description: null,
    status,
    scope: `project:${id}`,
    created_at: 1,
    updated_at: 1,
  };
}

function repoMember(projectId: string, ref: string): ProjectMember {
  return {
    id: `${projectId}:crew.repo:${ref}`,
    project_id: projectId,
    member_kind: 'crew.repo',
    member_ref: ref,
    meta: null,
    attached_at: 1,
    attached_by: 'api',
  };
}

/** proj-two → alpha + beta; proj-empty → no repo members; proj-stale → a dangling ref. */
const PROJECTS: Record<string, { project: Project; members: ProjectMember[] }> = {
  'proj-two': {
    project: project('proj-two'),
    members: [repoMember('proj-two', 'repo-alpha'), repoMember('proj-two', 'repo-beta')],
  },
  'proj-empty': { project: project('proj-empty'), members: [] },
  'proj-archived': { project: project('proj-archived', 'archived'), members: [] },
  'proj-stale': {
    project: project('proj-stale'),
    members: [repoMember('proj-stale', 'repo-gone')],
  },
};

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let auditPath: string;

/** Every governed-run launch the stub captured, in order. */
let runLaunches: LaunchRunInput[] = [];
/** The last campaign launch the stub captured. */
let campaignLaunch: { def: CampaignDef; workflows: WorkflowDef[] } | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'testing-multiscope-'));
  auditPath = join(dir, 'audit.log');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  adapter.listRepos = async () => REPOS;
  adapter.projectGet = async (id: string) => PROJECTS[id]?.project ?? null;
  adapter.projectMembers = async (id: string) => PROJECTS[id]?.members ?? [];
  adapter.launchRun = async (input: LaunchRunInput) => {
    if (input.problem.includes('BOOM-ON-SECOND') && runLaunches.length === 1) {
      throw new Error('engine exploded mid-fan');
    }
    runLaunches.push(input);
    return input.sessionId;
  };
  adapter.launchCampaign = async (def: CampaignDef, workflows: WorkflowDef[] = []) => {
    campaignLaunch = { def, workflows };
    return def.id;
  };

  app = await createServer(adapter, { auditPath });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  runLaunches = [];
  campaignLaunch = null;
});

async function post(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** run.launched audit entries whose detail carries `campaign` — polled until `expected` have
 *  flushed (appends are fire-and-forget, serialized on the log's own chain). */
async function reconAuditEntries(campaign: string, expected: number): Promise<AuditEntry[]> {
  let entries: AuditEntry[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      entries = readFileSync(auditPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as AuditEntry)
        .filter(
          (e) =>
            e.action === 'run.launched' &&
            (e.detail as Record<string, unknown> | undefined)?.['campaign'] === campaign,
        );
      if (entries.length >= expected) return entries;
    } catch {
      /* not flushed yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return entries;
}

// ── POST /testing/recon — the recon trigger ────────────────────────────────────

describe('POST /testing/recon', () => {
  it('neither field ⇒ ONE unscoped run (today’s behavior), runIds still the source of truth', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'survey the estate' });
    expect(res.status).toBe(201);
    expect(runLaunches).toHaveLength(1);
    expect(runLaunches[0]!.repoRef).toBeUndefined();
    expect(runLaunches[0]!.projectId).toBeUndefined();
    const runIds = res.body['runIds'] as string[];
    expect(runIds).toHaveLength(1);
    expect(res.body['runId']).toBe(runIds[0]);
    expect(res.body['campaign']).toMatch(/^recon-/);
  });

  it('repoRefs fan out: one run per repo, caller order kept, one shared campaign label', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'survey both',
      repoRefs: ['repo-beta', 'repo-alpha'],
    });
    expect(res.status).toBe(201);
    // N launches, in the caller's order.
    expect(runLaunches.map((l) => l.repoRef)).toEqual(['repo-beta', 'repo-alpha']);
    // runIds order matches input; runId is the first.
    const runIds = res.body['runIds'] as string[];
    expect(runIds).toEqual(runLaunches.map((l) => l.sessionId));
    expect(res.body['runId']).toBe(runIds[0]);
    // The SAME campaign label on every fanned run's trail entry.
    const campaign = res.body['campaign'] as string;
    const entries = await reconAuditEntries(campaign, 2);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => (e.detail as Record<string, unknown>)['repoRef'])).toEqual([
      'repo-beta',
      'repo-alpha',
    ]);
  });

  it('a unique repo NAME resolves to its id', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'survey by name',
      repoRefs: ['beta'],
    });
    expect(res.status).toBe(201);
    expect(runLaunches.map((l) => l.repoRef)).toEqual(['repo-beta']);
  });

  it('projectId alone resolves the project’s member repos AND files each run into it', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'survey the project',
      projectId: 'proj-two',
    });
    expect(res.status).toBe(201);
    expect(runLaunches.map((l) => l.repoRef)).toEqual(['repo-alpha', 'repo-beta']);
    expect(runLaunches.every((l) => l.projectId === 'proj-two')).toBe(true);
    expect((res.body['runIds'] as string[])).toHaveLength(2);
  });

  it('BOTH ⇒ the union, deduped, explicit repoRefs order first — THREE engine launches, ONE label', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'union scope',
      repoRefs: ['repo-gamma', 'repo-beta'],
      projectId: 'proj-two',
    });
    expect(res.status).toBe(201);
    // gamma + beta (explicit, in order), then alpha from the project; beta NOT repeated.
    expect(runLaunches.map((l) => l.repoRef)).toEqual(['repo-gamma', 'repo-beta', 'repo-alpha']);
    expect(res.body['runIds']).toEqual(runLaunches.map((l) => l.sessionId));
    // All THREE fanned runs share the ONE campaign label on their trail entries.
    const campaign = res.body['campaign'] as string;
    const entries = await reconAuditEntries(campaign, 3);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => (e.detail as Record<string, unknown>)['repoRef'])).toEqual([
      'repo-gamma',
      'repo-beta',
      'repo-alpha',
    ]);
  });

  it('404s an unknown project, naming it', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'x', projectId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body['error']).toMatch(/unknown project: ghost/);
    expect(runLaunches).toHaveLength(0);
  });

  it('400s a project with zero repo members, naming the project and the fix', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'x', projectId: 'proj-empty' });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/proj-empty/);
    expect(res.body['error']).toMatch(/has no repo members/);
    expect(res.body['error']).toMatch(/attach one|pass repoRefs/);
    expect(runLaunches).toHaveLength(0);
  });

  it('409s an archived project, naming the restore path', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'x', projectId: 'proj-archived' });
    expect(res.status).toBe(409);
    expect(res.body['error']).toMatch(/proj-archived.*archived/);
  });

  it('400s a bad ref BY NAME before anything launches (fail-closed, whole request)', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'x',
      repoRefs: ['repo-alpha', 'no-such-repo'],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/'no-such-repo' does not name a registered repo/);
    expect(runLaunches).toHaveLength(0);
  });

  it('400s a stale project repo member BY NAME (a launch on it would fail mid-run)', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'x', projectId: 'proj-stale' });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/'repo-gone'/);
    expect(runLaunches).toHaveLength(0);
  });

  it('400s unknown body fields BY NAME (strict schema — `repoRef` singular is the trap)', async () => {
    const res = await post('/api/v1/testing/recon', { problem: 'x', repoRef: 'repo-alpha' });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/unknown field `repoRef`/);
    expect(runLaunches).toHaveLength(0);
  });

  it('a mid-fan engine failure answers 500 and NAMES what already launched', async () => {
    const res = await post('/api/v1/testing/recon', {
      problem: 'BOOM-ON-SECOND',
      repoRefs: ['repo-alpha', 'repo-beta'],
    });
    expect(res.status).toBe(500);
    expect(res.body['error']).toMatch(/failed on repo 'repo-beta' after 1 run\(s\) launched/);
    expect(res.body['runIds']).toEqual([runLaunches[0]!.sessionId]);
  });
});

// ── POST /campaigns — multiscope fan-out ───────────────────────────────────────

describe('POST /campaigns multiscope', () => {
  const SCENARIOS = [
    { id: 'a', tool: { cmd: ['node', '/specs/a.mjs'] } },
    { id: 'b', deps: ['a'], tool: { cmd: ['node', '/specs/b.mjs'] } },
  ];

  it('REGRESSION: a legacy body (no scope fields) answers the legacy shape — no runIds key', async () => {
    const res = await post('/api/v1/campaigns', { id: 'camp-legacy', scenarios: SCENARIOS });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ campaignId: 'camp-legacy' });
    const def = campaignLaunch!.def;
    expect(def.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(def.nodes.every((n) => n.run_spec.repo_ref === undefined)).toBe(true);
  });

  it('repoRefs fan: one node per repo per unpinned scenario, SAME campaign, lane-local deps', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-fan',
      scenarios: SCENARIOS,
      repoRefs: ['repo-alpha', 'repo-beta'],
    });
    expect(res.status).toBe(201);
    expect(res.body['campaignId']).toBe('camp-fan');
    const def = campaignLaunch!.def;
    expect(def.nodes.map((n) => n.node_id)).toEqual(['a--r1', 'a--r2', 'b--r1', 'b--r2']);
    // Each lane runs its own repo…
    const repoOf = Object.fromEntries(def.nodes.map((n) => [n.node_id, n.run_spec.repo_ref]));
    expect(repoOf).toEqual({
      'a--r1': 'repo-alpha',
      'a--r2': 'repo-beta',
      'b--r1': 'repo-alpha',
      'b--r2': 'repo-beta',
    });
    // …deps stay inside the lane…
    expect(def.edges).toEqual([
      { from: 'a--r1', to: 'b--r1', condition: 'on_success' },
      { from: 'a--r2', to: 'b--r2', condition: 'on_success' },
    ]);
    // …titles name the repo…
    expect(def.nodes.map((n) => n.run_spec.problem)).toEqual([
      'a [alpha]',
      'a [beta]',
      'b [alpha]',
      'b [beta]',
    ]);
    // …and runIds are the attempt-0 node run ids, repo-major in the caller's order.
    expect(res.body['runIds']).toEqual([
      'camp-fan:a--r1:a0',
      'camp-fan:b--r1:a0',
      'camp-fan:a--r2:a0',
      'camp-fan:b--r2:a0',
    ]);
  });

  it('ONE resolved repo keeps node ids unchanged (single-codebase = today’s per-scenario spelling)', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-one',
      scenarios: SCENARIOS,
      repoRefs: ['repo-gamma'],
    });
    expect(res.status).toBe(201);
    const def = campaignLaunch!.def;
    expect(def.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(def.nodes.every((n) => n.run_spec.repo_ref === 'repo-gamma')).toBe(true);
    expect(res.body['runIds']).toEqual(['camp-one:a:a0', 'camp-one:b:a0']);
  });

  it('ONE repo + a pinned scenario keeps the documented runIds order: fanned first, then pinned', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-one-pin',
      scenarios: [
        { id: 'report', repoRef: 'repo-gamma', tool: { cmd: ['node', '/specs/r.mjs'] } },
        { id: 'scan', tool: { cmd: ['node', '/specs/scan.mjs'] } },
      ],
      repoRefs: ['repo-alpha'],
    });
    expect(res.status).toBe(201);
    const def = campaignLaunch!.def;
    // Node ids unchanged, the unpinned scenario assigned the launch repo, the pin kept.
    const repoOf = Object.fromEntries(def.nodes.map((n) => [n.node_id, n.run_spec.repo_ref]));
    expect(repoOf).toEqual({ report: 'repo-gamma', scan: 'repo-alpha' });
    // Same order rule as the multi-repo fan (no repo-count special case for consumers).
    expect(res.body['runIds']).toEqual(['camp-one-pin:scan:a0', 'camp-one-pin:report:a0']);
  });

  it('a scenario’s own repoRef PINS it: never fanned, and fanned deps wait for every lane', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-pin',
      scenarios: [
        { id: 'scan', tool: { cmd: ['node', '/specs/scan.mjs'] } },
        { id: 'report', deps: ['scan'], repoRef: 'repo-gamma', tool: { cmd: ['node', '/specs/r.mjs'] } },
      ],
      repoRefs: ['repo-alpha', 'repo-beta'],
    });
    expect(res.status).toBe(201);
    const def = campaignLaunch!.def;
    expect(def.nodes.map((n) => n.node_id)).toEqual(['scan--r1', 'scan--r2', 'report']);
    expect(def.nodes.find((n) => n.node_id === 'report')!.run_spec.repo_ref).toBe('repo-gamma');
    expect(def.edges).toEqual([
      { from: 'scan--r1', to: 'report', condition: 'on_success' },
      { from: 'scan--r2', to: 'report', condition: 'on_success' },
    ]);
    // Fanned lanes first (repo-major), then the pinned node.
    expect(res.body['runIds']).toEqual([
      'camp-pin:scan--r1:a0',
      'camp-pin:scan--r2:a0',
      'camp-pin:report:a0',
    ]);
  });

  it('projectId resolves member repos for the fan (and unions with repoRefs, deduped)', async () => {
    const res = await post('/api/v1/campaigns', {
      id: 'camp-proj',
      scenarios: [{ id: 'a', tool: { cmd: ['node', '/specs/a.mjs'] } }],
      projectId: 'proj-two',
      repoRefs: ['repo-gamma', 'repo-beta'],
    });
    expect(res.status).toBe(201);
    const def = campaignLaunch!.def;
    // THREE repos ⇒ THREE nodes inside ONE campaign def (the campaign IS the shared label):
    // gamma + beta (explicit, in order), then alpha from the project — beta not repeated.
    expect(def.id).toBe('camp-proj');
    expect(def.nodes.map((n) => n.run_spec.repo_ref)).toEqual([
      'repo-gamma',
      'repo-beta',
      'repo-alpha',
    ]);
    expect(res.body['runIds']).toEqual([
      'camp-proj:a--r1:a0',
      'camp-proj:a--r2:a0',
      'camp-proj:a--r3:a0',
    ]);
  });

  it('404s an unknown project / 400s an empty one, nothing launched', async () => {
    const ghost = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
      projectId: 'ghost',
    });
    expect(ghost.status).toBe(404);
    expect(ghost.body['error']).toMatch(/unknown project: ghost/);

    const empty = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
      projectId: 'proj-empty',
    });
    expect(empty.status).toBe(400);
    expect(empty.body['error']).toMatch(/proj-empty.*has no repo members/);
    expect(campaignLaunch).toBeNull();
  });

  it('400s a bad ref BY NAME, nothing launched', async () => {
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
      repoRefs: ['nope'],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/'nope' does not name a registered repo/);
    expect(campaignLaunch).toBeNull();
  });

  it('zod stays strict: an unknown scope spelling 400s BY NAME', async () => {
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: 'a', tool: { cmd: ['true'] } }],
      repos: ['repo-alpha'],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/unknown field `repos`/);
  });

  it('400s a fanned id that would blow the scenario-id cap, naming the fix', async () => {
    const longId = 'x'.repeat(48); // legal alone, too long once a lane suffix lands
    const res = await post('/api/v1/campaigns', {
      scenarios: [{ id: longId, tool: { cmd: ['true'] } }],
      repoRefs: ['repo-alpha', 'repo-beta'],
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatch(/too long to fan across 2 repos/);
  });
});
