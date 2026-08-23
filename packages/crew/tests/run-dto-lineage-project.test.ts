// CREW-UX-2 + CREW-UX-3 (DES-UX-001 §8.2/§8.3, api-types 0.8.0) — the run DTO's
// daemon-side joins.
//
// Fastify inject() with a mock adapter (no NAPI). Pins:
//   CREW-UX-2 — `AgentSession.project_id` populated from the membership record at DTO
//     assembly on BOTH `GET /runs` and `GET /runs/:id`: attach at launch, attach later
//     (POST /projects/:id/members), detach → null, unfiled → null (`null` = genuinely
//     unfiled, so the field is always PRESENT on a served run).
//   CREW-UX-3 — `LaunchRunBody.retryOf` must name an EXISTING run (400 otherwise, nothing
//     launched); echoed as `AgentSession.retry_of` (absent — not null — when no lineage);
//     the `run.launched` audit entry's detail carries it, and a fresh RetryIndex hydrates
//     the lineage back from that trail (the restart path).

import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { RetryIndex } from '../src/api/retry-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
  launchRun: ReturnType<typeof vi.fn>;
  projectMembers: ReturnType<typeof vi.fn>;
  projectMemberAttach: ReturnType<typeof vi.fn>;
  projectMemberDetach: ReturnType<typeof vi.fn>;
};

function view(id: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

function buildApp(
  mockAdapter: MockAdapter,
  index: MembershipIndex,
  retryIndex: RetryIndex,
  audit: AuditLog = AuditLog.noop(),
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index, log: () => undefined },
    { audit, authMode: 'off' },
    { retryIndex },
  );
  return app;
}

async function detailSession(app: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { run: { session: Record<string, unknown> } }).run.session;
}

async function listSession(app: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
  expect(res.statusCode).toBe(200);
  const runs = (res.json() as { runs: { session: Record<string, unknown> }[] }).runs;
  const hit = runs.find((r) => r.session['id'] === id);
  expect(hit).toBeDefined();
  return hit!.session;
}

describe('CREW-UX-2 — project_id on the run DTO (DES-UX-001 §8.2)', () => {
  let mockAdapter: MockAdapter;
  let index: MembershipIndex;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a')]),
      sessions: vi.fn().mockResolvedValue(['run-a']),
      launchRun: vi.fn().mockResolvedValue('run-b'),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn().mockResolvedValue({
        member: {
          id: 'm1',
          project_id: 'proj-1',
          member_kind: 'crew.run',
          member_ref: 'run-a',
          attached_at: 1755800000000,
        },
        created: true,
      }),
      projectMemberDetach: vi.fn().mockResolvedValue(true),
    };
    index = new MembershipIndex();
    app = buildApp(mockAdapter, index, new RetryIndex());
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('unfiled run → project_id is PRESENT and null on both list and detail', async () => {
    const detail = await detailSession(app, 'run-a');
    expect('project_id' in detail).toBe(true);
    expect(detail['project_id']).toBeNull();
    const listed = await listSession(app, 'run-a');
    expect('project_id' in listed).toBe(true);
    expect(listed['project_id']).toBeNull();
  });

  it('attach at launch (POST /runs with projectId) → DTO echoes it on both endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'p', clisJson: '[]', projectId: 'proj-1' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { runId: string }).runId).toBe('run-b');
    mockAdapter.sessionsDetail.mockResolvedValue([view('run-a'), view('run-b')]);
    expect((await detailSession(app, 'run-b'))['project_id']).toBe('proj-1');
    expect((await listSession(app, 'run-b'))['project_id']).toBe('proj-1');
    // The neighbor stays genuinely unfiled — the join is per-run, not per-response.
    expect((await listSession(app, 'run-a'))['project_id']).toBeNull();
  });

  it('attach later (POST /projects/:id/members) → DTO echoes it; detach → back to null', async () => {
    const attach = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/members',
      payload: { kind: 'crew.run', ref: 'run-a' },
    });
    expect(attach.statusCode).toBe(201);
    expect((await detailSession(app, 'run-a'))['project_id']).toBe('proj-1');
    expect((await listSession(app, 'run-a'))['project_id']).toBe('proj-1');

    mockAdapter.projectMembers.mockResolvedValue([
      {
        id: 'm1',
        project_id: 'proj-1',
        member_kind: 'crew.run',
        member_ref: 'run-a',
        attached_at: 1755800000000,
      },
    ]);
    const detach = await app.inject({ method: 'DELETE', url: '/api/v1/projects/proj-1/members/m1' });
    expect(detach.statusCode).toBe(200);
    const detail = await detailSession(app, 'run-a');
    expect('project_id' in detail).toBe(true);
    expect(detail['project_id']).toBeNull();
    expect((await listSession(app, 'run-a'))['project_id']).toBeNull();
  });
});

describe('CREW-UX-3 — retryOf lineage (DES-UX-001 §8.3)', () => {
  let mockAdapter: MockAdapter;
  let retryIndex: RetryIndex;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a']),
      launchRun: vi.fn().mockResolvedValue('run-b'),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
    };
    retryIndex = new RetryIndex();
    app = buildApp(mockAdapter, new MembershipIndex(), retryIndex);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('valid lineage round-trips: launch with retryOf → retry_of on both endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'retry it', clisJson: '[]', retryOf: 'run-a' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { runId: string }).runId).toBe('run-b');
    // The engine's LaunchOptions carries no lineage field — retryOf must NOT leak into
    // the adapter input (it is daemon-side provenance, task #88 style).
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('retryOf' in input).toBe(false);

    expect((await detailSession(app, 'run-b'))['retry_of']).toBe('run-a');
    expect((await listSession(app, 'run-b'))['retry_of']).toBe('run-a');
  });

  it('an unknown retryOf → 400 with a named error, and NOTHING is launched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'retry a ghost', clisJson: '[]', retryOf: 'no-such-run' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain('retryOf');
    expect(error).toContain('no-such-run');
    expect(mockAdapter.launchRun).not.toHaveBeenCalled();
  });

  it('absent retryOf → retry_of is ABSENT on the DTO, not null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'plain launch', clisJson: '[]' },
    });
    expect(res.statusCode).toBe(201);
    const detail = await detailSession(app, 'run-b');
    expect('retry_of' in detail).toBe(false);
    const listed = await listSession(app, 'run-b');
    expect('retry_of' in listed).toBe(false);
  });
});

describe('CREW-UX-3 — the audit trail carries lineage and hydrates it back', () => {
  let dir: string;
  let app: FastifyInstance;
  let audit: AuditLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-lineage-'));
  });

  afterEach(async () => {
    // Guarded: a test that throws before `app` is assigned must surface ITS error,
    // not a secondary teardown TypeError masking it (Copilot, #306).
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('run.launched detail carries retryOf; a fresh RetryIndex hydrates it (restart path)', async () => {
    const auditPath = join(dir, 'audit.log');
    audit = new AuditLog(auditPath, () => undefined);
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a']),
      launchRun: vi.fn().mockResolvedValue('run-b'),
      projectMembers: vi.fn(),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
    };
    app = buildApp(mockAdapter, new MembershipIndex(), new RetryIndex(), audit);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'retry it', clisJson: '[]', retryOf: 'run-a' },
    });
    expect(res.statusCode).toBe(201);
    await audit.flush();

    // The system of record: the run.launched entry's detail names the lineage.
    const entries = await audit.read({ action: 'run.launched' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe('run-b');
    expect(entries[0]!.detail?.['retryOf']).toBe('run-a');

    // The restart path: a NEW index over the same trail (what createServer does at boot)
    // answers the lineage without any in-memory carryover.
    const rehydrated = new RetryIndex();
    await rehydrated.hydrate(new AuditLog(auditPath, () => undefined));
    expect(rehydrated.retryOfFor('run-b')).toBe('run-a');
    expect(rehydrated.retryOfFor('run-a')).toBeUndefined();
  });
});
