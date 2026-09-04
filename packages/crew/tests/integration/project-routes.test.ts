// `/api/v1/projects` — the DES-PROJECT-001 §5.2 surface over a REAL stub engine.
//
// What this pins, in ADR order:
//   §1  create/list/detail/patch + the active-name 409 + archive⇄restore lifecycle
//   §2.2 POST /runs {projectId}: auto-attach lands with the launch; unknown 404 / archived 409
//        with NO run persisted (fail-closed, never a silent unfiled run)
//   §5.3 the durable prompt inbox: a gated run's prompt is readable via /prompts, SURVIVES a
//        daemon restart (fresh adapter + server over the same core.db, empty caches), is served
//        by GET /runs/:id/gate from the durable table (no event replay), and empties the moment
//        POST /runs/:id/gate answers it
//   §5.2 /activity merges the member run's core events, newest-first, cursor-paginated
//   §7  the synthesized `default` project: lists, holds unfiled runs, rejects PATCH/attach
//
// The engine is the REAL addon (spawnStub: deterministic council + stub seats, no subprocess) —
// this suite needs wicked-core-ts >= 0.6.0 (use-local-core-ts during the bridge window).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { Project, ProjectMember, InteractionRequest, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;

const STUB_CLIS = JSON.stringify([
  { key: 'a', display_name: 'A', binary: 'a', headless_invocation: 'a {PROMPT}' },
]);

async function boot(dbPath: string): Promise<void> {
  adapter = new CoreAdapter({ dbPath, stub: true });
  app = await createServer(adapter, { projectEvents: { disabled: true } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function waitForStatus(runId: string, want: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  let last: string | undefined;
  while (Date.now() - start < timeoutMs) {
    const views = await adapter.sessionsDetail();
    const view = views.find((v: SessionView) => v.session.id === runId);
    if (view?.session.status === want) return;
    last = view?.session.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached ${want} (last: ${String(last)})`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'project-routes-'));
  await boot(join(dir, 'core.db'));
}, 60_000);

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

describe('project CRUD (§1)', () => {
  it('creates, lists (with the synthesized default), reads detail, renames', async () => {
    const created = await req('POST', '/projects', { name: 'keystone', description: 'the e2e' });
    expect(created.status).toBe(201);
    const project = created.json['project'] as Project;
    expect(project.id).toMatch(/^proj_/);
    expect(project.status).toBe('active');
    expect(project.scope).toBe(`project:${project.id}`);

    const list = await req('GET', '/projects');
    const projects = list.json['projects'] as Project[];
    expect(projects.some((p) => p.id === 'default' && p.name === 'Unfiled')).toBe(true);
    expect(projects.some((p) => p.id === project.id)).toBe(true);

    const dup = await req('POST', '/projects', { name: 'keystone' });
    expect(dup.status).toBe(409);

    const detail = await req('GET', `/projects/${project.id}`);
    expect(detail.status).toBe(200);
    expect((detail.json['project'] as Project).name).toBe('keystone');
    expect(detail.json['members']).toEqual([]);

    const renamed = await req('PATCH', `/projects/${project.id}`, { name: 'keystone-2' });
    expect(renamed.status).toBe(200);
    expect((renamed.json['project'] as Project).name).toBe('keystone-2');

    const missing = await req('GET', '/projects/proj_nope');
    expect(missing.status).toBe(404);
  });

  it('archive frees the name, blocks attach, restore re-opens (§1.3)', async () => {
    const a = (await req('POST', '/projects', { name: 'seasonal' })).json['project'] as Project;
    const archived = await req('PATCH', `/projects/${a.id}`, { status: 'archived' });
    expect(archived.status).toBe(200);
    expect((archived.json['project'] as Project).status).toBe('archived');

    // Name freed for a new active project (§1.1).
    const b = await req('POST', '/projects', { name: 'seasonal' });
    expect(b.status).toBe(201);

    // Archived blocks new attachments…
    const attach = await req('POST', `/projects/${a.id}/members`, {
      kind: 'crew.workflow',
      ref: 'feature',
    });
    expect(attach.status).toBe(409);

    // …and ?status= filters.
    const archivedList = await req('GET', '/projects?status=archived');
    expect((archivedList.json['projects'] as Project[]).map((p) => p.id)).toContain(a.id);

    const restored = await req('PATCH', `/projects/${a.id}`, { status: 'active' });
    expect((restored.json['project'] as Project).status).toBe('active');
  });

  it('the synthesized default rejects writes (§7)', async () => {
    expect((await req('PATCH', '/projects/default', { name: 'x' })).status).toBe(409);
    expect(
      (await req('POST', '/projects/default/members', { kind: 'crew.run', ref: 'r' })).status,
    ).toBe(409);
  });
});

describe('membership (§1.2)', () => {
  it('attach is idempotent, ref-checked for crew.*, detach 404s on a second call', async () => {
    const p = (await req('POST', '/projects', { name: 'members' })).json['project'] as Project;

    // crew.run refs are existence-checked at the API layer at attach time.
    const ghost = await req('POST', `/projects/${p.id}/members`, { kind: 'crew.run', ref: 'nope' });
    expect(ghost.status).toBe(404);

    // Open-grammar kinds the engine cannot resolve attach fine (interactive.doc).
    const first = await req('POST', `/projects/${p.id}/members`, {
      kind: 'interactive.doc',
      ref: 'brief',
      meta: { title: 'The Brief' },
      attachedBy: 'interactive',
    });
    expect(first.status).toBe(201);
    expect(first.json['created']).toBe(true);
    const member = first.json['member'] as ProjectMember;
    expect(member.member_kind).toBe('interactive.doc');
    expect(member.attached_by).toBe('interactive');

    const again = await req('POST', `/projects/${p.id}/members`, {
      kind: 'interactive.doc',
      ref: 'brief',
    });
    expect(again.status).toBe(200); // the idempotent hit, not a duplicate row
    expect(again.json['created']).toBe(false);

    const members = await req('GET', `/projects/${p.id}/members`);
    expect((members.json['members'] as ProjectMember[]).length).toBe(1);

    const detached = await req('DELETE', `/projects/${p.id}/members/${member.id}`);
    expect(detached.status).toBe(200);
    const detachedAgain = await req('DELETE', `/projects/${p.id}/members/${member.id}`);
    expect(detachedAgain.status).toBe(404);

    // Malformed kind is a 400 with the grammar named, not a silent engine trip.
    const bad = await req('POST', `/projects/${p.id}/members`, { kind: 'runs', ref: 'x' });
    expect(bad.status).toBe(400);
  });
});

describe('launch filing (§2.2) + the durable prompt inbox (§5.3)', () => {
  let project: Project;
  let runId: string;

  it('POST /runs {projectId} auto-attaches; unknown 404 / archived 409 persist NO run', async () => {
    project = (await req('POST', '/projects', { name: 'gated' })).json['project'] as Project;

    const unknown = await req('POST', '/runs', {
      problem: 'p',
      sessionId: 'never-a',
      clisJson: STUB_CLIS,
      projectId: 'proj_nope',
    });
    expect(unknown.status).toBe(404);
    expect(await adapter.sessions()).not.toContain('never-a');

    const graveyard = (await req('POST', '/projects', { name: 'graveyard' })).json['project'] as Project;
    await req('PATCH', `/projects/${graveyard.id}`, { status: 'archived' });
    const archived = await req('POST', '/runs', {
      problem: 'p',
      sessionId: 'never-b',
      clisJson: STUB_CLIS,
      projectId: graveyard.id,
    });
    expect(archived.status).toBe(409);
    expect(await adapter.sessions()).not.toContain('never-b');

    const launched = await req('POST', '/runs', {
      problem: 'Do step one. Do step two',
      sessionId: 'gated-run',
      clisJson: STUB_CLIS,
      humanConfirm: 'before:1',
      projectId: project.id,
    });
    expect(launched.status).toBe(201);
    runId = launched.json['runId'] as string;
    expect(runId).toBe('gated-run');

    const members = (await req('GET', `/projects/${project.id}/members`)).json[
      'members'
    ] as ProjectMember[];
    expect(members.map((m) => `${m.member_kind}:${m.member_ref}`)).toContain('crew.run:gated-run');
  }, 30_000);

  it('the open gate is addressable state on /prompts and /runs/:id/gate', async () => {
    await waitForStatus(runId, 'awaiting_human');

    const inbox = await req('GET', `/projects/${project.id}/prompts`);
    expect(inbox.status).toBe(200);
    const prompts = inbox.json['prompts'] as InteractionRequest[];
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.kind).toBe('gate');
    expect(prompts[0]!.session_id).toBe(runId);
    expect(prompts[0]!.status).toBe('open');
    expect(prompts[0]!.prompt.length).toBeGreaterThan(0);

    // The gate route serves the DURABLE row (adopted into the cache as a latency layer).
    const gate = await req('GET', `/runs/${runId}/gate`);
    expect(gate.status).toBe(200);
    expect(gate.json['prompt']).toBe(prompts[0]!.prompt);
    expect(gate.json['lifecycle']).toBe('open');
  }, 30_000);

  it('RESTART SURVIVAL: a fresh daemon over the same core.db still serves the prompt', async () => {
    // "Restart": close the server AND the adapter, then boot a brand-new pair on the same db —
    // every in-memory cache (GateCache, membership index) starts empty, exactly like a deploy.
    await app.close();
    adapter.close();
    await boot(join(dir, 'core.db'));

    const inbox = await req('GET', `/projects/${project.id}/prompts`);
    expect(inbox.status).toBe(200);
    const prompts = inbox.json['prompts'] as InteractionRequest[];
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.status).toBe('open');

    // The gate route answers from the durable table with a COLD cache — the FINDING-051 fix,
    // now structural rather than a replay heuristic.
    const gate = await req('GET', `/runs/${runId}/gate`);
    expect(gate.status).toBe(200);
    expect(gate.json['prompt']).toBe(prompts[0]!.prompt);
  }, 60_000);

  it('answering the gate empties the inbox and resumes the run (§8 step 8)', async () => {
    const answered = await req('POST', `/runs/${runId}/gate`, { approve: true });
    expect(answered.status).toBe(200);

    await waitForStatus(runId, 'completed');

    const inbox = await req('GET', `/projects/${project.id}/prompts`);
    expect((inbox.json['prompts'] as InteractionRequest[]).length).toBe(0);

    // The row resolved `answered` (not deleted): the decision payload is the durable record.
    const rows = await adapter.interactionRequests(runId);
    expect(rows).not.toBeNull();
    expect(rows![0]!.status).toBe('answered');
    expect(JSON.parse(rows![0]!.answer!)).toMatchObject({ approve: true });
  }, 30_000);

  it('/activity merges the member run’s events newest-first and paginates (§5.2)', async () => {
    const page = await req('GET', `/projects/${project.id}/activity?limit=3`);
    expect(page.status).toBe(200);
    const entries = page.json['entries'] as { ts: number; id: string; source: string; ref: string }[];
    expect(entries.length).toBe(3);
    expect(entries.every((e) => e.source === 'crew' && e.ref === runId)).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.ts).toBeGreaterThanOrEqual(entries[i]!.ts);
    }
    // Cursor pages strictly older entries, no overlap.
    const cursor = page.json['nextCursor'] as string | null;
    expect(cursor).not.toBeNull();
    const next = await req('GET', `/projects/${project.id}/activity?limit=50&cursor=${cursor}`);
    const nextEntries = next.json['entries'] as { id: string }[];
    expect(nextEntries.length).toBeGreaterThan(0);
    const seen = new Set(entries.map((e) => e.id));
    expect(nextEntries.some((e) => seen.has(e.id))).toBe(false);
  });

  it('an unfiled run shows in the default project; a filed one does not (§7)', async () => {
    const unfiled = await req('POST', '/runs', {
      problem: 'Do one thing',
      sessionId: 'unfiled-run',
      clisJson: STUB_CLIS,
    });
    expect(unfiled.status).toBe(201);
    await waitForStatus('unfiled-run', 'completed');

    const detail = await req('GET', '/projects/default');
    const members = detail.json['members'] as ProjectMember[];
    const refs = members.map((m) => m.member_ref);
    expect(refs).toContain('unfiled-run');
    expect(refs).not.toContain(runId);

    // The default project's activity/prompts read like any other project's.
    const activity = await req('GET', '/projects/default/activity?limit=5');
    expect(activity.status).toBe(200);
    expect((activity.json['entries'] as unknown[]).length).toBeGreaterThan(0);
    const prompts = await req('GET', '/projects/default/prompts');
    expect(prompts.status).toBe(200);
    expect((prompts.json['prompts'] as unknown[]).length).toBe(0);
  }, 30_000);
});
