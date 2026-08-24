// CREW-UX-7 (DES-UX-002 §7.2, api-types 0.9.0) — durable pre-gate operator guidance.
// (The doc spells the slice CREW-UX-4; that id was already spent on the unrelated merged
// crew#308, so the implementation ships as CREW-UX-7 — see src/api/guidance-index.ts.)
//
// Fastify inject() with a mock adapter (no NAPI). Pins:
//   PUT /runs/:id/guidance — upsert (200, echoes {runId, guidance}), overwrite, clear via
//     `text: ''`, 404 for an unknown run, and a NAMED 400 past the 8192-byte cap.
//   DTO echo — `AgentSession.guidance` present after a set on BOTH `GET /runs` and
//     `GET /runs/:id`; ABSENT (not null/'') when never set or after a clear, so a pre-0.9.0
//     client's field set is unchanged unless the operator actually wrote a note.
//   Durability — the `guidance.set` audit entry (action + actor + runId + detail.text) is the
//     system of record; a fresh GuidanceIndex hydrates the CURRENT note back from the trail
//     (the restart path), newest write wins, and a cleared note stays cleared.

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
import { GuidanceIndex } from '../src/api/guidance-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
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
      status: 'running',
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
  guidanceIndex: GuidanceIndex,
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
    { guidanceIndex },
  );
  return app;
}

async function putGuidance(app: FastifyInstance, id: string, text: string) {
  return app.inject({ method: 'PUT', url: `/api/v1/runs/${id}/guidance`, payload: { text } });
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

describe('CREW-UX-7 — PUT /runs/:id/guidance + DTO echo (DES-UX-002 §7.2)', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a', 'run-b']),
    };
    app = buildApp(mockAdapter, new GuidanceIndex());
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('upsert round-trips: PUT → 200 echo, guidance on BOTH list and detail', async () => {
    const res = await putGuidance(app, 'run-a', 'prefer the streaming approach');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: 'run-a', guidance: 'prefer the streaming approach' });

    expect((await detailSession(app, 'run-a'))['guidance']).toBe('prefer the streaming approach');
    expect((await listSession(app, 'run-a'))['guidance']).toBe('prefer the streaming approach');
    // The neighbor is untouched — the note is per-run.
    expect('guidance' in (await listSession(app, 'run-b'))).toBe(false);
  });

  it('re-PUT overwrites — ONE note per run, not an append log', async () => {
    expect((await putGuidance(app, 'run-a', 'first')).statusCode).toBe(200);
    expect((await putGuidance(app, 'run-a', 'second')).statusCode).toBe(200);
    expect((await detailSession(app, 'run-a'))['guidance']).toBe('second');
  });

  it("empty string CLEARS: the DTO field returns to ABSENT, not '' or null", async () => {
    expect((await putGuidance(app, 'run-a', 'note')).statusCode).toBe(200);
    const res = await putGuidance(app, 'run-a', '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: 'run-a', guidance: '' });
    expect('guidance' in (await detailSession(app, 'run-a'))).toBe(false);
    expect('guidance' in (await listSession(app, 'run-a'))).toBe(false);
  });

  it('never set → ABSENT on both endpoints (old-client field-set safety)', async () => {
    expect('guidance' in (await detailSession(app, 'run-a'))).toBe(false);
    expect('guidance' in (await listSession(app, 'run-a'))).toBe(false);
  });

  it('unknown run → 404, nothing indexed', async () => {
    const res = await putGuidance(app, 'no-such-run', 'note');
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Run not found');
  });

  it('a malformed body → 400 (missing text / wrong type / extra keys)', async () => {
    for (const payload of [{}, { text: 42 }, { text: 'ok', extra: true }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/runs/run-a/guidance', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('the 8192-byte cap: at-cap accepted, one byte past → a NAMED 400, nothing stored', async () => {
    expect((await putGuidance(app, 'run-a', 'x'.repeat(8192))).statusCode).toBe(200);
    const res = await putGuidance(app, 'run-a', 'y'.repeat(8193));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('8192-byte cap');
    // The over-cap write did not clobber the at-cap note.
    expect((await detailSession(app, 'run-a'))['guidance']).toBe('x'.repeat(8192));
    // The cap counts BYTES, not chars: 3000 three-byte chars = 9000 bytes.
    expect((await putGuidance(app, 'run-a', '€'.repeat(3000))).statusCode).toBe(400);
  });
});

describe('CREW-UX-7 — the audit trail carries guidance and hydrates it back', () => {
  let dir: string;
  let app: FastifyInstance;
  let audit: AuditLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-guidance-'));
  });

  afterEach(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function freshApp(auditPath: string): FastifyInstance {
    audit = new AuditLog(auditPath, () => undefined);
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-a'), view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-a', 'run-b']),
    };
    return buildApp(mockAdapter, new GuidanceIndex(), audit);
  }

  it('guidance.set entry shape: action + actor + runId + detail.text', async () => {
    const auditPath = join(dir, 'audit.log');
    app = freshApp(auditPath);
    await app.ready();

    expect((await putGuidance(app, 'run-a', 'watch the retry budget')).statusCode).toBe(200);
    await audit.flush();

    const entries = await audit.read({ action: 'guidance.set' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe('run-a');
    expect(entries[0]!.actor).toEqual({ id: 'local', kind: 'human', trust: 'admin' });
    expect(entries[0]!.detail?.['text']).toBe('watch the retry budget');
  });

  it('restart path: a fresh GuidanceIndex hydrates the CURRENT note; newest wins; cleared stays cleared', async () => {
    const auditPath = join(dir, 'audit.log');
    app = freshApp(auditPath);
    await app.ready();

    // run-a: written twice — the newest must win after rehydrate.
    expect((await putGuidance(app, 'run-a', 'old note')).statusCode).toBe(200);
    expect((await putGuidance(app, 'run-a', 'new note')).statusCode).toBe(200);
    // run-b: written then CLEARED — the older non-empty entry must not resurrect it.
    expect((await putGuidance(app, 'run-b', 'temp note')).statusCode).toBe(200);
    expect((await putGuidance(app, 'run-b', '')).statusCode).toBe(200);
    await audit.flush();

    // What createServer does at boot: a NEW index over the same trail, no in-memory carryover.
    const rehydrated = new GuidanceIndex();
    await rehydrated.hydrate(new AuditLog(auditPath, () => undefined));
    expect(rehydrated.guidanceFor('run-a')).toBe('new note');
    expect(rehydrated.guidanceFor('run-b')).toBeUndefined();
    expect(rehydrated.guidanceFor('run-never')).toBeUndefined();
  });

  it('a missing trail hydrates to no-guidance (pre-CREW-UX-7 behavior), not an error', async () => {
    const idx = new GuidanceIndex();
    await idx.hydrate(new AuditLog(join(dir, 'never-written.log'), () => undefined));
    expect(idx.guidanceFor('run-a')).toBeUndefined();
  });
});

// Copilot (#312): a corrupt NEWEST guidance.set entry must not let an older
// superseded note resurrect on hydrate — the newest entry decides, even malformed.
describe('GuidanceIndex hydrate — corrupt newest entry', () => {
  it('marks the run seen before the text check, so the older note stays dead', async () => {
    const idx = new GuidanceIndex();
    const entries = [
      { runId: 'r1', action: 'guidance.set', detail: { text: 42 as unknown as string } },
      { runId: 'r1', action: 'guidance.set', detail: { text: 'stale older note' } },
    ];
    await idx.hydrate({ read: async () => entries } as never);
    expect(idx.guidanceFor('r1')).toBeUndefined();
  });
});
