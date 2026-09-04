import { symlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// crew#273 — POST /open: open a file/folder with the OS default app, daemon-side.
//
// Fastify inject() with a mock adapter and a STUBBED opener (no process is ever spawned here).
// Covers the validation ladder — 400 bad body / relative path, 404 unknown run, 403 outside
// every allowed root (incl. traversal) — plus the 200 spawn-success and 502 spawn-failure ends.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { isInsideRoot } from '../src/api/open-path.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const WORKDIR = '/tmp/wicked-open-test/work';
const EXTRA_ROOT = '/tmp/wicked-open-test/extra';
const REPO_ROOT = '/tmp/wicked-open-test/repo';

function view(id: string, workdir: string | null) {
  return {
    session: {
      id,
      workflow_id: null,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir,
      repo_ref: null,
      extra_write_roots: [EXTRA_ROOT],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  listRepos: ReturnType<typeof vi.fn>;
};

describe('POST /open (crew#273)', () => {
  let mockAdapter: MockAdapter;
  let opener: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-1', WORKDIR), view('run-bare', null)]),
      listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'repo', root_path: REPO_ROOT }]),
    };
    opener = vi.fn().mockResolvedValue(undefined);
    app = Fastify({ logger: false });
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
      undefined,
      undefined,
      undefined,
      { openWithOs: opener },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/open', payload: body as Record<string, unknown> });

  it('opens a path inside the run workdir (200, opener gets the resolved path)', async () => {
    const res = await post({ path: `${WORKDIR}/report.html`, runId: 'run-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'opened' });
    expect(opener).toHaveBeenCalledWith(`${WORKDIR}/report.html`);
  });

  it("opens a path inside the run's extra write roots", async () => {
    const res = await post({ path: `${EXTRA_ROOT}/draft.md`, runId: 'run-1' });
    expect(res.statusCode).toBe(200);
  });

  it('opens a path inside a registered repo root with NO runId', async () => {
    const res = await post({ path: `${REPO_ROOT}/README.md` });
    expect(res.statusCode).toBe(200);
    expect(opener).toHaveBeenCalledWith(`${REPO_ROOT}/README.md`);
  });

  it('403s a path outside every allowed root, and never spawns', async () => {
    const res = await post({ path: '/etc/passwd', runId: 'run-1' });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain('outside every allowed root');
    expect(opener).not.toHaveBeenCalled();
  });

  it('403s a traversal that escapes an allowed root after normalization', async () => {
    const res = await post({ path: `${WORKDIR}/../../../etc/passwd`, runId: 'run-1' });
    expect(res.statusCode).toBe(403);
    expect(opener).not.toHaveBeenCalled();
  });

  it('a workdir-less run still opens repo-root paths, but not arbitrary ones', async () => {
    expect((await post({ path: `${REPO_ROOT}/x.txt`, runId: 'run-bare' })).statusCode).toBe(200);
    expect((await post({ path: '/somewhere/else', runId: 'run-bare' })).statusCode).toBe(403);
  });

  it('404s an unknown runId before any root check', async () => {
    const res = await post({ path: `${REPO_ROOT}/README.md`, runId: 'nope' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain('unknown run');
    expect(opener).not.toHaveBeenCalled();
  });

  it('400s a relative path', async () => {
    const res = await post({ path: 'work/report.html', runId: 'run-1' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('absolute');
    expect(opener).not.toHaveBeenCalled();
  });

  it('400s an unknown field, naming it (strict body)', async () => {
    const res = await post({ path: `${WORKDIR}/f`, run: 'run-1' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('`run`');
    expect(opener).not.toHaveBeenCalled();
  });

  it('400s a missing/empty path', async () => {
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ path: '' })).statusCode).toBe(400);
  });

  it('502s when the opener itself cannot spawn', async () => {
    opener.mockRejectedValueOnce(new Error('spawn xdg-open ENOENT'));
    const res = await post({ path: `${REPO_ROOT}/README.md` });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('spawn xdg-open ENOENT');
  });

  it('500s (not 200/403) when the run lookup itself fails', async () => {
    mockAdapter.sessionsDetail.mockRejectedValueOnce(new Error('engine down'));
    const res = await post({ path: `${WORKDIR}/f`, runId: 'run-1' });
    expect(res.statusCode).toBe(500);
    expect(opener).not.toHaveBeenCalled();
  });
});

describe('isInsideRoot (the containment rule)', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b', '/a/b/c/d.txt')).toBe(true);
    expect(isInsideRoot('/a/b/', '/a/b/c')).toBe(true);
  });

  it('rejects siblings, parents, and prefix-name cousins', () => {
    expect(isInsideRoot('/a/b', '/a')).toBe(false);
    expect(isInsideRoot('/a/b', '/a/bc')).toBe(false); // prefix of the NAME, not a child
    expect(isInsideRoot('/a/b', '/a/c')).toBe(false);
  });

  it('normalizes traversal before judging', () => {
    expect(isInsideRoot('/a/b', '/a/b/../evil')).toBe(false);
    expect(isInsideRoot('/a/b', '/a/b/c/../d')).toBe(true);
  });

  it('does not wrongly exclude a child whose name merely starts with dots', () => {
    expect(isInsideRoot('/a/b', '/a/b/..hidden')).toBe(true);
  });

  it('judges REAL paths — a symlink out of the root does not smuggle its target in', () => {
    // Real filesystem fixture: root/link → outside/secret.txt. Lexically root/link is inside;
    // its REAL path is not (Copilot, PR#279).
    const base = mkdtempSync(join(tmpdir(), 'open-symlink-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'x');
    const link = join(root, 'link');
    symlinkSync(secret, link, 'file');
    try {
      expect(isInsideRoot(root, link)).toBe(false);
      expect(isInsideRoot(root, join(root, 'real-child.txt'))).toBe(true); // missing → lexical
    } finally {
      removeScratch(base);
    }
  });
});
