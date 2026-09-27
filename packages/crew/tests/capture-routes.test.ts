// Studio OS behaviour 8, "Capture anything" (crew half).
//
//   POST /api/v1/projects/:id/capture — notes, text files and photos land in a per-run inbox and a
//     small repo-less team run is launched THROUGH `POST /runs` (one launch path: membership, the
//     state-home and roster checks, the audit trail), filed to the project. The run's output is
//     PROPOSALS in the existing estate queue; this route writes nothing else.
//   POST /api/v1/proposals/:id/approve {content?, reach?} — accept WITH an edit: the edited copy is
//     submitted to the same queue, the original rejected, the copy approved. Crossing projects
//     (`reach: "pattern"`) is only ever this human act, only on a memory-class capture.
//
// Fastify inject() with a mock adapter and a stubbed estate client — no engine, no estate process.

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

// A 1x1 PNG — the "whiteboard photo".
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type EstateStub = ReturnType<typeof vi.fn>;

function buildApp(adapter: Record<string, unknown>, estate: EstateStub, index = new MembershipIndex()): FastifyInstance {
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
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index, log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    { callEstateTool: estate as (t: string, a: Record<string, unknown>) => Promise<unknown> },
  );
  return app;
}

describe('POST /projects/:id/capture — capture into the proposal queue', () => {
  let inbox: string;
  let app: FastifyInstance;
  let launchRun: ReturnType<typeof vi.fn>;
  const prevInbox = process.env.WICKED_CAPTURE_INBOX_DIR;

  beforeEach(async () => {
    inbox = mkdtempSync(join(tmpdir(), 'capture-inbox-'));
    process.env.WICKED_CAPTURE_INBOX_DIR = inbox;
    launchRun = vi.fn(async (input: LaunchRunInput) => input.sessionId);
    app = buildApp(
      {
        launchRun,
        sessionsDetail: vi.fn().mockResolvedValue([]),
        listRepos: vi.fn().mockResolvedValue([]),
        projectMembers: vi.fn().mockResolvedValue([]),
      },
      vi.fn(),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (prevInbox === undefined) delete process.env.WICKED_CAPTURE_INBOX_DIR;
    else process.env.WICKED_CAPTURE_INBOX_DIR = prevInbox;
    removeScratch(inbox);
  });

  it('lands notes, a text file and a photo in the run inbox and launches a repo-less understand run filed to the project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/capture',
      payload: {
        notes: 'Standup: we chose Postgres over Mongo.',
        files: [
          { name: 'meeting.md', text: '# Notes\nShip the upload endpoint next.' },
          { name: '../../whiteboard.png', mediaType: 'image/png', dataBase64: PNG_B64 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json() as { runId: string };
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    // One launch, through POST /runs: the run IS the capture id, filed to the project, one
    // read-only catalog step, nothing delivered.
    expect(launchRun).toHaveBeenCalledTimes(1);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.sessionId).toBe(runId);
    expect(input.projectId).toBe('proj-1');
    expect(input.plan).toEqual({ steps: [{ catalog: 'understand', id: 'capture' }] });
    expect(input.workflow).toBeUndefined();
    expect(input.repoRef).toBeUndefined();
    const dir = join(inbox, runId);
    expect(input.problem).toContain(join(dir, 'CAPTURE.md'));

    // The materials, byte-exact; caller names are display text, never paths.
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['0-notes.md', '1-meeting.md', '2-whiteboard.png', 'CAPTURE.md']);
    expect(readFileSync(join(dir, '0-notes.md'), 'utf8')).toBe('Standup: we chose Postgres over Mongo.');
    expect(readFileSync(join(dir, '2-whiteboard.png')).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);

    // The brief names every material, the three capture classes, and the project scope.
    const brief = readFileSync(join(dir, 'CAPTURE.md'), 'utf8');
    for (const f of ['0-notes.md', '1-meeting.md', '2-whiteboard.png']) expect(brief).toContain(join(dir, f));
    for (const cls of ['"capture":"intent"', '"capture":"decision"', '"capture":"memory"']) expect(brief).toContain(cls);
    expect(brief).toContain('{"project":"proj-1"}');
    expect(brief).toContain('"reach":"pattern"');
  });

  it('400s a capture with nothing in it, and launches nothing', async () => {
    for (const payload of [{}, { notes: '   ' }, { files: [] }]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/projects/proj-1/capture', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(launchRun).not.toHaveBeenCalled();
    expect(readdirSync(inbox)).toEqual([]);
  });

  it('400s an image type a vision seat cannot read, and a photo that is not base64', async () => {
    const bad = [
      { name: 'x.svg', mediaType: 'image/svg+xml', dataBase64: PNG_B64 },
      { name: 'x.png', mediaType: 'image/png', dataBase64: 'not base64!!' },
    ];
    for (const f of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/projects/proj-1/capture', payload: { files: [f] } });
      expect(res.statusCode, f.name).toBe(400);
    }
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('400s notes over the byte cap, naming the cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/capture',
      payload: { notes: 'x'.repeat(256 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/bytes/);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it("passes the launch's own refusal through (unknown project → 404) and leaves no inbox behind", async () => {
    launchRun.mockRejectedValueOnce(new Error("project 'nope' is not registered"));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/nope/capture',
      payload: { notes: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it('accepts a photo bigger than the default 1 MiB JSON body limit', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/capture',
      payload: { files: [{ name: 'board.jpg', mediaType: 'image/jpeg', dataBase64: big }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json() as { runId: string };
    expect(existsSync(join(inbox, runId, '0-board.jpg'))).toBe(true);
  });
});

describe('POST /proposals/:id/approve {content?, reach?} — accept with an edit', () => {
  let app: FastifyInstance;
  let estate: EstateStub;
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    kind_type: 'memory',
    payload: { content: 'Uploads go through the S3 presign flow at Acme', tier: 'semantic', capture: 'memory', reach: 'pattern' },
    facets: { project: 'proj-1', repo: 'upload-api', cli: 'claude' },
    provenance: { run_id: 'r-cap' },
    state: 'pending',
    created_at: 1,
    ...over,
  });

  function stubEstate(row: Record<string, unknown>): void {
    estate.mockImplementation(async (tool: string) => {
      if (tool === 'proposal.list') return { proposals: [row] };
      if (tool === 'proposal.submit') return { id: 'p2' };
      if (tool === 'proposal.reject') return { ok: true };
      if (tool === 'proposal.approve') return { outcome: 'promoted', active_id: 'proposal:p2' };
      throw new Error(`unexpected ${tool}`);
    });
  }

  beforeEach(async () => {
    estate = vi.fn();
    app = buildApp({ sessionsDetail: vi.fn().mockResolvedValue([]), listRepos: vi.fn().mockResolvedValue([]) }, estate);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('submits the edited copy, rejects the original, approves the copy; a pattern leaves the project', async () => {
    stubEstate(pending());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/proposals/p1/approve',
      payload: { content: 'Uploads go through a presign flow', reach: 'pattern' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ outcome: 'promoted', active_id: 'proposal:p2', edited: { from: 'p1', to: 'p2' } });
    const calls = estate.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['proposal.list', 'proposal.submit', 'proposal.reject', 'proposal.approve']);
    expect(estate).toHaveBeenCalledWith('proposal.list', { state: 'pending' });
    expect(estate).toHaveBeenCalledWith('proposal.submit', {
      kind_type: 'memory',
      payload: { content: 'Uploads go through a presign flow', tier: 'semantic', capture: 'memory', reach: 'pattern', edited_from: 'p1' },
      // Crossing projects strips the client scope (project + repo); other axes stay.
      facets: { cli: 'claude' },
    });
    expect(estate).toHaveBeenCalledWith('proposal.reject', { id: 'p1' });
    expect(estate).toHaveBeenCalledWith('proposal.approve', { id: 'p2' });
  });

  it('an edit that keeps the project reach keeps every facet', async () => {
    stubEstate(pending());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/proposals/p1/approve',
      payload: { content: 'Acme uploads use presign', reach: 'project' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const submit = estate.mock.calls.find((c) => c[0] === 'proposal.submit')![1] as Record<string, unknown>;
    expect(submit['facets']).toEqual({ project: 'proj-1', repo: 'upload-api', cli: 'claude' });
    expect((submit['payload'] as Record<string, unknown>)['reach']).toBe('project');
  });

  it('an accept that keeps an already project-scoped row as filed is a plain approve — no copy', async () => {
    stubEstate(pending({ payload: { content: 'We chose Postgres', tier: 'semantic', capture: 'decision' } }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { reach: 'project' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ outcome: 'promoted', active_id: 'proposal:p2' });
    expect(estate.mock.calls).toEqual([
      ['proposal.list', { state: 'pending' }],
      ['proposal.approve', { id: 'p1' }],
    ]);
  });

  it("keeping a row in its project when the worker filed no project facet scopes the copy to the capture run's project", async () => {
    const index = new MembershipIndex();
    index.set('r-cap', 'proj-7');
    await app.close();
    app = buildApp({ sessionsDetail: vi.fn().mockResolvedValue([]), listRepos: vi.fn().mockResolvedValue([]) }, estate, index);
    await app.ready();
    stubEstate(pending({ facets: {} }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { reach: 'project' } });
    expect(res.statusCode, res.body).toBe(200);
    const submit = estate.mock.calls.find((c) => c[0] === 'proposal.submit')![1] as Record<string, unknown>;
    expect(submit['facets']).toEqual({ project: 'proj-7' });
  });

  it('refuses to keep a row in a project nobody can name, writing nothing', async () => {
    stubEstate(pending({ facets: {}, provenance: {} }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { reach: 'project' } });
    expect(res.statusCode).toBe(400);
    expect(estate.mock.calls.map((c) => c[0])).toEqual(['proposal.list']);
  });

  it('refuses to let a decision or an intent cross projects, writing nothing', async () => {
    for (const capture of ['decision', 'intent']) {
      estate.mockReset();
      stubEstate(pending({ payload: { content: 'We chose Postgres', tier: 'semantic', capture } }));
      const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { reach: 'pattern' } });
      expect(res.statusCode, capture).toBe(400);
      expect(estate.mock.calls.map((c) => c[0])).toEqual(['proposal.list']);
    }
  });

  it('refuses an edit of a non-memory proposal and of an id that is not pending', async () => {
    stubEstate(pending({ kind_type: 'policy:security', payload: { rule: 'r', severity: 'warn' } }));
    const policy = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { content: 'x' } });
    expect(policy.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/proposals/zzz/approve', payload: { content: 'x' } });
    expect(missing.statusCode).toBe(404);
    expect(estate.mock.calls.every((c) => c[0] === 'proposal.list')).toBe(true);
  });

  it('a plain approve (no body, or {}) is unchanged: one proposal.approve, no copy', async () => {
    estate.mockResolvedValue({ outcome: 'promoted', active_id: 'm-1' });
    for (const payload of [undefined, {}]) {
      estate.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/proposals/p1/approve',
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'promoted', active_id: 'm-1' });
      expect(estate.mock.calls).toEqual([['proposal.approve', { id: 'p1' }]]);
    }
  });

  it('400s an unknown field or a blank content (strict body)', async () => {
    for (const payload of [{ bogus: 1 }, { content: '  ' }, { reach: 'everywhere' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(estate).not.toHaveBeenCalled();
  });
});
