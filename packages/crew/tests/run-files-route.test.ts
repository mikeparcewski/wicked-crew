// DES-FEEDBACK-002 CREW-1 — GET /runs/:id/files + GET /runs/:id/diff: the in-studio viewer's wire.
//
// Fastify inject() with a mock adapter over REAL filesystem fixtures (temp dirs, a real git repo
// as the run workdir) — containment, caps, binary sniff, and diff assembly are filesystem/git
// facts, so the tests exercise the real machinery rather than stubs. The heart is the containment
// suite: both routes must reuse POST /open's exact posture (fail-closed, symlink-safe
// `isInsideRoot` over `allowedRootsFor`'s root set) — traversal, absolute-outside, and symlink
// escapes all 403 and never touch the file.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { allowedRootsFor } from '../src/api/open-path.js';
import {
  BINARY_SNIFF_BYTES,
  DIFF_OUTPUT_CAP_BYTES,
  FILE_CONTENT_CAP_BYTES,
} from '../src/api/run-files.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { FastifyInstance } from 'fastify';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

function view(id: string, workdir: string | null, extraRoots: string[]) {
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
      extra_write_roots: extraRoots,
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

describe('GET /runs/:id/files + /runs/:id/diff (DES-FEEDBACK-002 CREW-1)', () => {
  let base: string;
  let workdir: string;
  let extraRoot: string;
  let repoRoot: string;
  let outside: string;
  let reaped: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'crew1-files-'));
    workdir = join(base, 'work');
    extraRoot = join(base, 'extra');
    repoRoot = join(base, 'repo');
    outside = join(base, 'outside');
    reaped = join(base, 'reaped'); // never created — a workdir the reaper already removed
    for (const d of [workdir, extraRoot, repoRoot, outside]) mkdirSync(d);

    // The workdir is a REAL git repo: one committed file later modified (unstaged), one committed
    // file with a staged edit, one untracked file — the §3.7 staged+unstaged+untracked worktree.
    git(workdir, 'init', '-q');
    writeFileSync(join(workdir, 'tracked.txt'), 'line-one\nline-two\n');
    writeFileSync(join(workdir, 'staged.txt'), 'staged-original\n');
    mkdirSync(join(workdir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(workdir, 'src', 'nested', 'deep.ts'), 'export const deep = 1;\n');
    git(workdir, 'add', '.');
    git(workdir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(workdir, 'tracked.txt'), 'line-one\nline-two-CHANGED\n'); // unstaged
    writeFileSync(join(workdir, 'staged.txt'), 'staged-CHANGED\n');
    git(workdir, 'add', 'staged.txt'); // staged
    writeFileSync(join(workdir, 'created.txt'), 'brand new\n'); // untracked

    // Viewer-truthfulness fixtures (§12.2): >512 KB, binary, and containment-attack surfaces.
    writeFileSync(join(workdir, 'big.txt'), 'x'.repeat(FILE_CONTENT_CAP_BYTES + 1024));
    writeFileSync(
      join(workdir, 'blob.bin'),
      Buffer.concat([Buffer.from('elf'), Buffer.from([0, 1, 2]), Buffer.alloc(64, 7)]),
    );
    writeFileSync(join(workdir, 'nul-late.txt'), 'a'.repeat(BINARY_SNIFF_BYTES) + '\0tail'); // NUL after the sniff window
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(join(outside, 'secret.txt'), join(workdir, 'sneaky-link'), 'file');
    writeFileSync(join(extraRoot, 'deliverable.md'), '# extra-root file');
    writeFileSync(join(repoRoot, 'README.md'), 'repo readme');

    const mockAdapter = {
      sessionsDetail: vi
        .fn()
        .mockResolvedValue([
          view('run-1', workdir, [extraRoot]),
          view('run-bare', null, []),
          view('run-reaped', reaped, []),
          view('run-nogit', extraRoot, []),
        ]),
      listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'repo', root_path: repoRoot }]),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const getFile = (runId: string, path?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/files`,
      ...(path === undefined ? {} : { query: { path } }),
    });
  const getDiff = (runId: string, path?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/diff`,
      ...(path === undefined ? {} : { query: { path } }),
    });

  // ── files: happy paths ────────────────────────────────────────────────────

  it('serves a nested file inside the run workdir with the full contract shape', async () => {
    const res = await getFile('run-1', join(workdir, 'src', 'nested', 'deep.ts'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      path: join(workdir, 'src', 'nested', 'deep.ts'),
      content: 'export const deep = 1;\n',
      size: Buffer.byteLength('export const deep = 1;\n'),
      truncated: false,
      binary: false,
    });
  });

  it('serves a file inside an extra write root', async () => {
    const res = await getFile('run-1', join(extraRoot, 'deliverable.md'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe('# extra-root file');
  });

  it('serves a file inside a registered repo root', async () => {
    const res = await getFile('run-1', join(repoRoot, 'README.md'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe('repo readme');
  });

  // ── files: caps + binary sniff (§3.3 truthfulness) ───────────────────────

  it('caps a >512 KB file at the first 512 KB with truncated:true and the FULL size', async () => {
    const res = await getFile('run-1', join(workdir, 'big.txt'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: string; size: number; truncated: boolean; binary: boolean };
    expect(body.truncated).toBe(true);
    expect(body.content.length).toBe(FILE_CONTENT_CAP_BYTES);
    expect(body.size).toBe(FILE_CONTENT_CAP_BYTES + 1024);
    expect(body.binary).toBe(false);
  });

  it('answers binary:true with content:"" for a NUL-in-first-8KB file', async () => {
    const res = await getFile('run-1', join(workdir, 'blob.bin'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { content: string; binary: boolean; truncated: boolean; size: number };
    expect(body).toMatchObject({ content: '', binary: true, truncated: false });
    expect(body.size).toBe(70);
  });

  it('a NUL past the 8 KB sniff window still serves as text (the sniff is a window, not a scan)', async () => {
    const res = await getFile('run-1', join(workdir, 'nul-late.txt'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { binary: boolean }).binary).toBe(false);
  });

  // ── files: the validation ladder ─────────────────────────────────────────

  it('400s a missing path query parameter', async () => {
    const res = await getFile('run-1');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('path');
  });

  it('400s a relative path', async () => {
    const res = await getFile('run-1', 'src/nested/deep.ts');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('absolute');
  });

  it('404s an unknown run before judging the path', async () => {
    const res = await getFile('nope', join(outside, 'secret.txt'));
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain('unknown run');
  });

  it('404s a contained-but-missing file', async () => {
    const res = await getFile('run-1', join(workdir, 'no-such-file.txt'));
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain('no such file');
  });

  it('400s a directory path — this route serves file bytes, never listings', async () => {
    const res = await getFile('run-1', join(workdir, 'src'));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('not a regular file');
  });

  // ── files: containment (the heart — POST /open's exact posture) ──────────

  it('403s an absolute path outside every allowed root', async () => {
    const res = await getFile('run-1', join(outside, 'secret.txt'));
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain('outside every allowed root');
  });

  it('403s /etc/passwd', async () => {
    expect((await getFile('run-1', '/etc/passwd')).statusCode).toBe(403);
  });

  it('403s a ../../ traversal that escapes the workdir after normalization', async () => {
    const res = await getFile('run-1', join(workdir, '..', '..', '..', 'etc', 'passwd'));
    expect(res.statusCode).toBe(403);
  });

  it('403s a traversal INTO the outside dir that stays lexically under the workdir prefix', async () => {
    const res = await getFile('run-1', `${workdir}/../outside/secret.txt`);
    expect(res.statusCode).toBe(403);
  });

  it('403s a symlink inside the workdir that points outside (realpath containment)', async () => {
    const res = await getFile('run-1', join(workdir, 'sneaky-link'));
    expect(res.statusCode).toBe(403);
    expect((res.json() as { content?: string }).content).toBeUndefined(); // never read
  });

  it('403s a sibling whose name merely extends the workdir prefix (workXX vs work)', async () => {
    const sibling = `${workdir}xx`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'f.txt'), 'prefix cousin');
    expect((await getFile('run-1', join(sibling, 'f.txt'))).statusCode).toBe(403);
  });

  it('a workdir-less run still serves repo-root files, and nothing else', async () => {
    expect((await getFile('run-bare', join(repoRoot, 'README.md'))).statusCode).toBe(200);
    expect((await getFile('run-bare', join(extraRoot, 'deliverable.md'))).statusCode).toBe(403);
  });

  it('a reaped workdir keeps its containment: inside → 404 (gone), outside → 403', async () => {
    expect((await getFile('run-reaped', join(reaped, 'x.txt'))).statusCode).toBe(404);
    expect((await getFile('run-reaped', join(outside, 'secret.txt'))).statusCode).toBe(403);
  });

  // ── diff: happy paths ─────────────────────────────────────────────────────

  it('whole-worktree diff carries staged + unstaged + untracked-as-additions', async () => {
    const res = await getDiff('run-1');
    expect(res.statusCode).toBe(200);
    const { diff, truncated } = res.json() as { diff: string; truncated: boolean };
    expect(truncated).toBe(false);
    expect(diff).toContain('a/tracked.txt'); // unstaged edit
    expect(diff).toContain('+line-two-CHANGED');
    expect(diff).toContain('a/staged.txt'); // staged edit
    expect(diff).toContain('+staged-CHANGED');
    expect(diff).toContain('b/created.txt'); // untracked → all-addition --no-index hunk
    expect(diff).toContain('+brand new');
    expect(diff).toContain('new file mode');
  });

  it('?path narrows the diff to one file', async () => {
    const res = await getDiff('run-1', join(workdir, 'tracked.txt'));
    expect(res.statusCode).toBe(200);
    const { diff } = res.json() as { diff: string };
    expect(diff).toContain('+line-two-CHANGED');
    expect(diff).not.toContain('staged-CHANGED');
    expect(diff).not.toContain('created.txt');
  });

  it('?path on an UNTRACKED file yields its all-addition hunk', async () => {
    const res = await getDiff('run-1', join(workdir, 'created.txt'));
    expect(res.statusCode).toBe(200);
    const { diff } = res.json() as { diff: string };
    expect(diff).toContain('+brand new');
    expect(diff).not.toContain('tracked.txt');
  });

  it('a clean tree answers {diff:"", truncated:false} — a real answer, not an error', async () => {
    const clean = join(base, 'clean');
    mkdirSync(clean);
    git(clean, 'init', '-q');
    writeFileSync(join(clean, 'f.txt'), 'committed\n');
    git(clean, 'add', '.');
    git(clean, 'commit', '-q', '-m', 'base');
    // A dedicated app whose roster holds only the clean-tree run — the shared fixture's worktree
    // is deliberately dirty in three ways and must stay that way for the other tests.
    const scoped = Fastify({ logger: false });
    registerRoutes(
      scoped,
      {
        sessionsDetail: vi.fn().mockResolvedValue([view('run-clean', clean, [])]),
        listRepos: vi.fn().mockResolvedValue([]),
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
    );
    await scoped.ready();
    try {
      const ok = await scoped.inject({ method: 'GET', url: '/api/v1/runs/run-clean/diff' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ diff: '', truncated: false });
    } finally {
      await scoped.close();
    }
  });

  it('a non-git workdir answers an empty diff rather than an error (the git-history tolerance)', async () => {
    const res = await getDiff('run-nogit');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ diff: '', truncated: false });
  });

  // ── diff: caps ────────────────────────────────────────────────────────────

  it('cuts a >1 MB diff at the cap with truncated:true', async () => {
    const huge = join(workdir, 'huge-untracked.txt');
    writeFileSync(huge, `${'y'.repeat(120)}\n`.repeat(Math.ceil((DIFF_OUTPUT_CAP_BYTES * 2) / 121)));
    try {
      const res = await getDiff('run-1', huge);
      expect(res.statusCode).toBe(200);
      const { diff, truncated } = res.json() as { diff: string; truncated: boolean };
      expect(truncated).toBe(true);
      expect(diff.length).toBe(DIFF_OUTPUT_CAP_BYTES);
    } finally {
      rmSync(huge, { force: true });
    }
  });

  // ── diff: the validation ladder ───────────────────────────────────────────

  it('404s an unknown run', async () => {
    expect((await getDiff('nope')).statusCode).toBe(404);
  });

  it('409s a run with no workdir — nothing to diff against', async () => {
    const res = await getDiff('run-bare');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('no workdir');
  });

  it('409s a reaped workdir (directory no longer exists)', async () => {
    const res = await getDiff('run-reaped');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('no longer exists');
  });

  it('400s a relative ?path and 403s an outside one — the files route ladder, shared', async () => {
    expect((await getDiff('run-1', 'tracked.txt')).statusCode).toBe(400);
    expect((await getDiff('run-1', join(outside, 'secret.txt'))).statusCode).toBe(403);
    expect((await getDiff('run-1', join(workdir, '..', 'outside', 'secret.txt'))).statusCode).toBe(403);
  });
});

describe('allowedRootsFor (the ONE root set /open and both viewer routes share)', () => {
  const repos = [{ root_path: '/repos/a' }, { root_path: '/repos/b' }];

  it('run session: workdir + extra_write_roots + every repo root', () => {
    expect(
      allowedRootsFor({ workdir: '/w', extra_write_roots: ['/e1', '/e2'] }, repos),
    ).toEqual(['/w', '/e1', '/e2', '/repos/a', '/repos/b']);
  });

  it('no session: repo roots only', () => {
    expect(allowedRootsFor(undefined, repos)).toEqual(['/repos/a', '/repos/b']);
  });

  it('skips null/empty workdir and blank extra roots — absence never becomes a root', () => {
    expect(allowedRootsFor({ workdir: null, extra_write_roots: ['', '/e'] }, [])).toEqual(['/e']);
    expect(allowedRootsFor({ workdir: '', extra_write_roots: null }, [])).toEqual([]);
  });
});
