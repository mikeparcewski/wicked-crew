// Home command-center run metrics (api-types 0.24.0) — `AgentSession.created_at`, the daemon-side
// launch-time join.
//
// Fastify inject() with a mock adapter (no NAPI). Pins:
//   - a run launched via POST /runs → `created_at` is PRESENT on BOTH GET /runs and GET /runs/:id,
//     a unix-SECONDS number matching the launch instant;
//   - a run the daemon has no `run.launched` entry for → `created_at` is ABSENT (never null, never
//     fabricated), so a bucketed KPI can exclude an undated run;
//   - the `run.launched` audit entry carries the launch `ts`, and a fresh RunTimingIndex hydrates
//     `created_at` back from that trail in unix seconds (the restart path);
//   - RunTimingIndex converts the trail's millis `ts` to whole unix seconds.

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

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
  runTimingIndex: RunTimingIndex,
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
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'off' },
    { runTimingIndex },
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

describe('run metrics — created_at on the run DTO', () => {
  let mockAdapter: MockAdapter;
  let runTimingIndex: RunTimingIndex;
  let app: FastifyInstance;
  // A REAL temp-file trail, not `AuditLog.noop()`: `created_at` is stamped ONLY from the durable
  // `run.launched` entry (routes.ts never fabricates one), so exercising the present-path means
  // recording a real launch — the same seam `createServer` builds in production. A noop trail would
  // make the "launched → created_at present" pin pass only via a path production never takes.
  let dir: string;
  let audit: AuditLog;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-run-metrics-dto-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a']),
      launchRun: vi.fn().mockResolvedValue('run-b'),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
    };
    runTimingIndex = new RunTimingIndex();
    app = buildApp(mockAdapter, runTimingIndex, audit);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    removeScratch(dir);
  });

  it('a run launched via POST /runs → created_at is a unix-SECONDS number on both endpoints', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'p', clisJson: '[]' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { runId: string }).runId).toBe('run-b');
    const after = Math.floor(Date.now() / 1000);

    const detail = await detailSession(app, 'run-b');
    expect(typeof detail['created_at']).toBe('number');
    const createdAt = detail['created_at'] as number;
    // Unix SECONDS, not millis — bounded by the launch window (a millis value would be ~1000× larger).
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
    expect(Number.isInteger(createdAt)).toBe(true);

    expect((await listSession(app, 'run-b'))['created_at']).toBe(createdAt);
  });

  it('a run with no launch record → created_at is ABSENT, not null', async () => {
    // run-a is served by the adapter but was never launched through this daemon.
    const detail = await detailSession(app, 'run-a');
    expect('created_at' in detail).toBe(false);
    const listed = await listSession(app, 'run-a');
    expect('created_at' in listed).toBe(false);
  });
});

describe('run metrics — the audit trail carries the launch time and hydrates it back', () => {
  let dir: string;
  let app: FastifyInstance;
  let audit: AuditLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-run-metrics-'));
  });

  afterEach(async () => {
    await app?.close();
    removeScratch(dir);
  });

  it('run.launched ts hydrates created_at (restart path), in unix seconds', async () => {
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
    app = buildApp(mockAdapter, new RunTimingIndex(), audit);
    await app.ready();

    const before = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'time it', clisJson: '[]' },
    });
    expect(res.statusCode).toBe(201);
    await audit.flush();

    // The system of record: the run.launched entry stamps the launch millis.
    const entries = await audit.read({ action: 'run.launched' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe('run-b');
    expect(typeof entries[0]!.ts).toBe('number');

    // The restart path: a NEW index over the same trail (what createServer does at boot) answers
    // the launch time in unix SECONDS, with no in-memory carryover.
    const rehydrated = new RunTimingIndex();
    await rehydrated.hydrate(new AuditLog(auditPath, () => undefined));
    const createdAt = rehydrated.createdAtFor('run-b');
    expect(createdAt).toBe(Math.floor(entries[0]!.ts / 1000));
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(rehydrated.createdAtFor('run-a')).toBeUndefined();
  });
});

describe('RunTimingIndex — millis → whole unix seconds', () => {
  it('hydrateFromLaunchEntries floors the trail millis to seconds; ignores malformed entries', () => {
    const idx = new RunTimingIndex();
    idx.hydrateFromLaunchEntries([
      { ts: 1_755_800_123_456, action: 'run.launched', actor: { id: 'x', kind: 'human', trust: 'admin' }, runId: 'r1' },
      { ts: 0, action: 'run.launched', actor: { id: 'x', kind: 'human', trust: 'admin' }, runId: 'r2' },
      { ts: 1_700_000_000_000, action: 'run.launched', actor: { id: 'x', kind: 'human', trust: 'admin' } },
    ]);
    expect(idx.createdAtFor('r1')).toBe(1_755_800_123); // floor(…456 / 1000)
    expect(idx.createdAtFor('r2')).toBeUndefined(); // ts <= 0 is not a real launch instant
    expect(idx.createdAtFor('missing')).toBeUndefined();
  });

  it('set() stores whole seconds from a millis instant', () => {
    const idx = new RunTimingIndex();
    idx.set('r1', 1_755_800_999_999);
    expect(idx.createdAtFor('r1')).toBe(1_755_800_999);
  });
});

// The shared launch seam (Copilot #466): EVERY route that launches a run records `run.launched` AND
// stamps the index through this one helper, so a recon fan / steering-author run gets `created_at`
// live too — never absent-until-restart. Pinned directly (cheaper than standing up those routes).
describe('recordRunLaunched — record + stamp, from the SAME durable ts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-record-launch-'));
  });
  afterEach(() => removeScratch(dir));

  const actor = { id: 'mikeparcewski', kind: 'human', trust: 'admin' } as const;

  it('a REAL trail: records the entry AND stamps the index to the SAME whole second', async () => {
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    const idx = new RunTimingIndex();
    const ts = recordRunLaunched(audit, idx, actor, 'run-z', { recon: true });
    expect(ts).toBeGreaterThan(0);
    expect(idx.createdAtFor('run-z')).toBe(Math.floor(ts / 1000));
    await audit.flush();
    const entries = await audit.read({ action: 'run.launched' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe('run-z');
    expect(entries[0]!.ts).toBe(ts); // the index and the trail share the ONE ts — no drift
  });

  it('a NOOP trail (audit disabled): records nothing and stamps nothing — created_at stays ABSENT', () => {
    const idx = new RunTimingIndex();
    const ts = recordRunLaunched(AuditLog.noop(), idx, actor, 'run-z', { recon: true });
    expect(ts).toBe(0);
    expect(idx.createdAtFor('run-z')).toBeUndefined();
  });

  it('an ABSENT index is tolerated (a route-unit test that omits it): no throw, entry still recorded', async () => {
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    expect(() => recordRunLaunched(audit, undefined, actor, 'run-z', {})).not.toThrow();
    await audit.flush();
    expect(await audit.read({ action: 'run.launched' })).toHaveLength(1);
  });
});
