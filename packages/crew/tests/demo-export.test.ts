// EP-C3 (DES-ARTIFACT-EDITOR-PLUGINS-001 §7.3): GIF and poster export for a demo run.
//
//   POST /api/v1/runs/:id/demo/export {format:'gif'}            → demo-video/demo.gif (interactive's
//                                                                  two-pass palette filter)
//   POST /api/v1/runs/:id/demo/export {format:'poster', atSec?} → demo-video/poster.jpg (default: the
//                                                                  first chapter marker + 1 s)
//
// ffmpeg runs with an ASYNC spawn and a timeout, never spawnSync: interactive's encoder blocks for up
// to 180 s, which in the daemon would stall every route (review N6). These tests drive a fake ffmpeg
// (a node script named by WICKED_FFMPEG) so the seam is exercised for real on any host, plus one
// real-ffmpeg round trip when the host has ffmpeg.

import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { DEMO_EXPORT_TIMEOUT_MS } from '../src/api/recording.js';
import type { DemoExportSchema } from '../src/api/recording.js';
import type { z } from 'zod';
import type { DemoExportBody, DemoExportResponse } from 'wicked-crew-api-types';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

// Compile-time pin (typecheck): every body the contract lets a client send, the route's schema accepts.
type ContractBodyAccepted = DemoExportBody extends z.input<typeof DemoExportSchema> ? true : never;
const contractBodyAccepted: ContractBodyAccepted = true;

function buildApp(adapter: Record<string, unknown>): FastifyInstance {
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
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    { callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown> },
  );
  return app;
}

/** A finished demo run (plan → record → review, all done), or one still recording. */
function demoRun(id: string, preset = 'demo', recording = false) {
  const steps = ['pa-scope', 'plan', 'record', 'review'];
  return {
    session: {
      id,
      status: recording ? 'executing' : 'completed',
      unit_ix: recording ? 2 : steps.length,
      workflow_id: `${id}:plan-2`,
      problem: 'Make a demo',
      extra_write_roots: [],
      team_plan: { rev: 2, accepted_rev: 2, preset },
    },
    units: steps.map((s, i) => ({
      id: `${id}:${s}`,
      session_id: id,
      ord: i + 1,
      status: recording && i >= 2 ? 'pending' : 'done',
      assigned_cli: null,
    })),
  };
}

/**
 * A fake ffmpeg: records its argv to `<dir>/argv-<n>.json`, then — per FAKE_FFMPEG_MODE — writes
 * bytes to its LAST argument (the output), exits 1 with a message, writes nothing, or sleeps.
 */
function fakeFfmpeg(dir: string): string {
  const path = join(dir, 'fake-ffmpeg.mjs');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      "import { writeFileSync, readdirSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      'const dir = process.env.FAKE_FFMPEG_LOG;',
      "const n = readdirSync(dir).filter((f) => f.startsWith('argv-')).length;",
      "writeFileSync(join(dir, `argv-${n}.json`), JSON.stringify(args));",
      "const mode = process.env.FAKE_FFMPEG_MODE ?? 'ok';",
      "const sleep = Number(process.env.FAKE_FFMPEG_SLEEP_MS ?? '0');",
      'setTimeout(() => {',
      "  if (mode === 'fail') { process.stderr.write('Invalid data found when processing input'); process.exit(1); }",
      "  if (mode === 'empty') process.exit(0);",
      "  const out = args[args.length - 1];",
      "  writeFileSync(out, out.endsWith('.gif') ? 'GIF89a-fake' : '\\xff\\xd8fake-jpeg');",
      '  process.exit(0);',
      '}, sleep);',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

// Each case spawns a real child process (node or ffmpeg): give a loaded host room.
describe('POST /runs/:id/demo/export (EP-C3)', { timeout: 30_000 }, () => {
  let demos: string;
  let logDir: string;
  let app: FastifyInstance;
  let sessionsDetail: Mock;
  const saved = {
    dir: process.env.WICKED_DEMO_DIR,
    ffmpeg: process.env.WICKED_FFMPEG,
    log: process.env.FAKE_FFMPEG_LOG,
    mode: process.env.FAKE_FFMPEG_MODE,
    sleep: process.env.FAKE_FFMPEG_SLEEP_MS,
  };
  const savedTimeouts = { ...DEMO_EXPORT_TIMEOUT_MS };

  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /** A stitched demo: a 10-byte "MP4", chapter markers at 0:05 and 1:05, a contact sheet. */
  function stitchedRoot(id: string, markers = '| 0:05 | Introduction |\n| 1:05 | Home |\n'): string {
    const root = join(demos, id);
    mkdirSync(join(root, 'demo-video'), { recursive: true });
    mkdirSync(join(root, 'review'), { recursive: true });
    writeFileSync(join(root, 'demo-video', 'demo.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(root, 'demo-video', 'chapters.md'), `| Time | Chapter |\n|---|---|\n${markers}`);
    writeFileSync(join(root, 'review', 'joins.png'), 'png');
    return root;
  }

  const argvOf = (n: number): string[] => JSON.parse(readFileSync(join(logDir, `argv-${n}.json`), 'utf8')) as string[];
  const spawns = (): number => readdirSync(logDir).filter((f) => f.startsWith('argv-')).length;
  const exportReq = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${id}/demo/export`, payload });

  beforeEach(async () => {
    demos = mkdtempSync(join(tmpdir(), 'demo-export-roots-'));
    logDir = mkdtempSync(join(tmpdir(), 'demo-export-ffmpeg-'));
    process.env.WICKED_DEMO_DIR = demos;
    process.env.WICKED_FFMPEG = fakeFfmpeg(logDir);
    process.env.FAKE_FFMPEG_LOG = logDir;
    delete process.env.FAKE_FFMPEG_MODE;
    delete process.env.FAKE_FFMPEG_SLEEP_MS;
    sessionsDetail = vi.fn().mockResolvedValue([demoRun('d1'), demoRun('nd', 'bug'), demoRun('rec', 'demo', true)]);
    app = buildApp({
      sessionsDetail,
      workOutput: vi.fn().mockResolvedValue(null),
      listRepos: vi.fn().mockResolvedValue([]),
      projectMembers: vi.fn().mockResolvedValue([]),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    restore('WICKED_DEMO_DIR', saved.dir);
    restore('WICKED_FFMPEG', saved.ffmpeg);
    restore('FAKE_FFMPEG_LOG', saved.log);
    restore('FAKE_FFMPEG_MODE', saved.mode);
    restore('FAKE_FFMPEG_SLEEP_MS', saved.sleep);
    Object.assign(DEMO_EXPORT_TIMEOUT_MS, savedTimeouts);
    removeScratch(demos);
    removeScratch(logDir);
  });

  it('GIF: encodes demo.mp4 with the two-pass palette filter into demo-video/demo.gif, and the file route serves it', async () => {
    const root = stitchedRoot('d1');
    const res = await exportReq('d1', { format: 'gif' });
    expect(res.statusCode, res.body).toBe(200);
    const answer: DemoExportResponse = { format: 'gif', path: 'demo-video/demo.gif', bytes: Buffer.byteLength('GIF89a-fake') };
    expect(res.json()).toEqual(answer);
    expect(contractBodyAccepted).toBe(true);
    const argv = argvOf(0);
    // ffmpeg never touches the worker-writable root: it reads a staged copy and writes beside it.
    const staged = argv[argv.indexOf('-i') + 1]!;
    expect(staged.startsWith(root)).toBe(false);
    expect(argv[argv.length - 1]!.startsWith(root)).toBe(false);
    expect(argv[argv.length - 1]!.startsWith(dirname(staged))).toBe(true);
    expect(existsSync(dirname(staged)), 'the staging directory is removed').toBe(false);
    expect(argv[argv.indexOf('-vf') + 1]).toContain('palettegen');
    expect(argv[argv.indexOf('-vf') + 1]).toContain('paletteuse');
    expect(argv[argv.indexOf('-loop') + 1]).toBe('0');
    // The input is demuxed as MP4 from the local file only: never as a playlist naming other media.
    expect(argv.slice(argv.indexOf('-i') - 4, argv.indexOf('-i'))).toEqual(['-f', 'mov', '-protocol_whitelist', 'file']);
    expect(readFileSync(join(root, 'demo-video', 'demo.gif'), 'utf8')).toBe('GIF89a-fake');
    // Only the finished file is left: the encode wrote to a temporary name and renamed it.
    expect(readdirSync(join(root, 'demo-video')).sort()).toEqual(['chapters.md', 'demo.gif', 'demo.mp4']);

    const served = await app.inject({ method: 'GET', url: '/api/v1/runs/d1/demo/file?path=demo-video/demo.gif' });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/gif');
    // The MP4 is untouched and still served with Range.
    const mp4 = await app.inject({ method: 'GET', url: '/api/v1/runs/d1/demo/file?path=demo-video/demo.mp4', headers: { range: 'bytes=0-3' } });
    expect(mp4.statusCode).toBe(206);
    expect(mp4.body).toBe('0123');
  });

  it('poster: defaults to the first chapter marker + 1 s, takes atSec, writes demo-video/poster.jpg', async () => {
    const root = stitchedRoot('d1');
    const first = await exportReq('d1', { format: 'poster' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ format: 'poster', path: 'demo-video/poster.jpg' });
    const a0 = argvOf(0);
    expect(a0[a0.indexOf('-ss') + 1]).toBe('6');
    expect(a0[a0.indexOf('-frames:v') + 1]).toBe('1');
    expect(existsSync(join(root, 'demo-video', 'poster.jpg'))).toBe(true);

    const at = await exportReq('d1', { format: 'poster', atSec: 12.5 });
    expect(at.statusCode, at.body).toBe(200);
    const a1 = argvOf(1);
    expect(a1[a1.indexOf('-ss') + 1]).toBe('12.5');
  });

  it('poster with no chapter markers starts at 1 s', async () => {
    stitchedRoot('d1', '');
    const res = await exportReq('d1', { format: 'poster' });
    expect(res.statusCode, res.body).toBe(200);
    const a0 = argvOf(0);
    expect(a0[a0.indexOf('-ss') + 1]).toBe('1');
  });

  it('the daemon keeps answering while an encode runs (async spawn, never spawnSync)', async () => {
    stitchedRoot('d1');
    process.env.FAKE_FFMPEG_SLEEP_MS = '1500';
    let exportDone = false;
    const pending = exportReq('d1', { format: 'gif' }).then((r) => {
      exportDone = true;
      return r;
    });
    // Wait until the encoder has actually started, then ask the daemon something else.
    for (let i = 0; i < 100 && spawns() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(spawns(), 'the encoder started').toBe(1);
    const other = await app.inject({ method: 'GET', url: '/api/v1/runs/d1/demo/file?path=review/joins.png' });
    expect(other.statusCode).toBe(200);
    expect(exportDone, 'the other request answered while the encode was still running').toBe(false);
    expect((await pending).statusCode).toBe(200);
  });

  it('two exports of the same format at once run ONE encode', async () => {
    stitchedRoot('d1');
    process.env.FAKE_FFMPEG_SLEEP_MS = '300';
    const [a, b] = await Promise.all([exportReq('d1', { format: 'gif' }), exportReq('d1', { format: 'gif' })]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(spawns()).toBe(1);
  });

  it('a demo-video/ swapped for a symlink during the encode is never written through', async () => {
    const root = stitchedRoot('d1');
    const outside = mkdtempSync(join(tmpdir(), 'demo-export-outside-'));
    process.env.FAKE_FFMPEG_SLEEP_MS = '800';
    const pending = exportReq('d1', { format: 'gif' });
    for (let i = 0; i < 100 && spawns() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    renameSync(join(root, 'demo-video'), join(root, 'moved'));
    symlinkSync(outside, join(root, 'demo-video'));
    const res = await pending;
    expect(res.statusCode, res.body).toBe(409);
    // ffmpeg wrote only into its staging directory, never through the swapped path.
    expect(argvOf(0)[argvOf(0).length - 1]!.startsWith(root)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    removeScratch(outside);
  });

  it('a gate answered during the encode that resumes the recorder discards the export (409)', async () => {
    const root = stitchedRoot('d1');
    process.env.FAKE_FFMPEG_SLEEP_MS = '800';
    const pending = exportReq('d1', { format: 'gif' });
    for (let i = 0; i < 100 && spawns() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    // request_changes at the review gate rewinds to record: the run is recording again.
    sessionsDetail.mockResolvedValue([demoRun('d1', 'demo', true)]);
    const res = await pending;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('resumed');
    expect(existsSync(join(root, 'demo-video', 'demo.gif'))).toBe(false);
    expect(readdirSync(join(root, 'demo-video')).sort()).toEqual(['chapters.md', 'demo.mp4']);
  });

  it('an in-root symlinked MP4 still exports into demo-video/, the path the answer names', async () => {
    const root = stitchedRoot('d1');
    mkdirSync(join(root, 'recordings'), { recursive: true });
    renameSync(join(root, 'demo-video', 'demo.mp4'), join(root, 'recordings', 'source.mp4'));
    symlinkSync(join('..', 'recordings', 'source.mp4'), join(root, 'demo-video', 'demo.mp4'));
    const res = await exportReq('d1', { format: 'gif' });
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(join(root, 'demo-video', 'demo.gif'))).toBe(true);
    expect(readdirSync(join(root, 'recordings'))).toEqual(['source.mp4']);
  });

  it('a different poster frame while one encodes is refused (409); the same frame joins', async () => {
    stitchedRoot('d1');
    process.env.FAKE_FFMPEG_SLEEP_MS = '600';
    const first = exportReq('d1', { format: 'poster', atSec: 2 });
    for (let i = 0; i < 100 && spawns() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const [other, same] = await Promise.all([
      exportReq('d1', { format: 'poster', atSec: 9 }),
      exportReq('d1', { format: 'poster', atSec: 2 }),
    ]);
    expect(other.statusCode, other.body).toBe(409);
    expect(other.body).toContain('already running');
    expect((await first).statusCode).toBe(200);
    expect(same.statusCode).toBe(200);
    expect(spawns()).toBe(1);
  });

  it('a missing ffmpeg answers 503 with the install hint', async () => {
    stitchedRoot('d1');
    process.env.WICKED_FFMPEG = join(logDir, 'no-such-ffmpeg');
    const res = await exportReq('d1', { format: 'gif' });
    expect(res.statusCode, res.body).toBe(503);
    const body = res.json() as { error: string; hint: string };
    expect(body.error).toMatch(/ffmpeg not found/);
    expect(body.hint).toMatch(/install ffmpeg/i);
    expect(body.hint).toContain('WICKED_FFMPEG');
  });

  it('an encode that fails answers 502 with ffmpeg\'s words and leaves no partial file', async () => {
    const root = stitchedRoot('d1');
    process.env.FAKE_FFMPEG_MODE = 'fail';
    const res = await exportReq('d1', { format: 'gif' });
    expect(res.statusCode, res.body).toBe(502);
    expect((res.json() as { error: string }).error).toContain('Invalid data found');
    expect(readdirSync(join(root, 'demo-video')).sort()).toEqual(['chapters.md', 'demo.mp4']);
  });

  it('a poster past the end of the video (no frame written) answers 422', async () => {
    stitchedRoot('d1');
    process.env.FAKE_FFMPEG_MODE = 'empty';
    const res = await exportReq('d1', { format: 'poster', atSec: 9999 });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('an encode past its timeout is killed and answers 504, leaving no partial file', async () => {
    const root = stitchedRoot('d1');
    process.env.FAKE_FFMPEG_SLEEP_MS = '5000';
    DEMO_EXPORT_TIMEOUT_MS.gif = 300;
    const started = Date.now();
    const res = await exportReq('d1', { format: 'gif' });
    expect(res.statusCode, res.body).toBe(504);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(readdirSync(join(root, 'demo-video')).sort()).toEqual(['chapters.md', 'demo.mp4']);
  });

  it('refuses: no stitched MP4 yet (409), a run still recording (409), not a demo run (404), a bad body (400)', async () => {
    mkdirSync(join(demos, 'd1'), { recursive: true });
    expect((await exportReq('d1', { format: 'gif' })).statusCode).toBe(409);
    expect((await exportReq('nd', { format: 'gif' })).statusCode).toBe(404);
    expect((await exportReq('nope', { format: 'gif' })).statusCode).toBe(404);
    // While the recorder runs, its worker can write the root: no export until the review gate.
    stitchedRoot('rec');
    const recording = await exportReq('rec', { format: 'gif' });
    expect(recording.statusCode, recording.body).toBe(409);
    expect(recording.body).toContain('review gate');
    stitchedRoot('d1');
    for (const body of [{ format: 'webm' }, { format: 'poster', atSec: -1 }, { format: 'gif', atSec: 3 }, { format: 'gif', path: '/etc' }, {}]) {
      expect((await exportReq('d1', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(spawns()).toBe(0);
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  // Defense in depth: ffmpeg 8 already refuses an HLS playlist with a non-standard extension on its
  // own; the forced `-f mov -protocol_whitelist file` (pinned in the GIF case's argv) keeps an older
  // host ffmpeg from following one too.
  it.skipIf(!hasFfmpeg)('with the host ffmpeg: a demo.mp4 that is really a playlist naming media outside the root is refused', async () => {
    const root = stitchedRoot('d1');
    delete process.env.WICKED_FFMPEG;
    const outside = mkdtempSync(join(tmpdir(), 'demo-export-secret-'));
    const secret = join(outside, 'secret.mp4');
    expect(
      spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5:duration=2', '-c:v', 'mpeg4', secret], { stdio: 'ignore' }).status,
    ).toBe(0);
    writeFileSync(join(root, 'demo-video', 'demo.mp4'), `ffconcat version 1.0\nfile '${secret}'\n`);
    const res = await exportReq('d1', { format: 'poster', atSec: 0 });
    expect(res.statusCode, res.body).toBe(502);
    expect(existsSync(join(root, 'demo-video', 'poster.jpg'))).toBe(false);
    writeFileSync(join(root, 'demo-video', 'demo.mp4'), `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile://${secret}\n#EXT-X-ENDLIST\n`);
    const hls = await exportReq('d1', { format: 'gif' });
    expect(hls.statusCode, hls.body).toBe(502);
    expect(existsSync(join(root, 'demo-video', 'demo.gif'))).toBe(false);
    removeScratch(outside);
  });

  it.skipIf(!hasFfmpeg)('with the host ffmpeg: a real GIF and a real JPEG poster from a real MP4', async () => {
    const root = stitchedRoot('d1', '| 0:00 | Introduction |\n');
    delete process.env.WICKED_FFMPEG;
    const mp4 = join(root, 'demo-video', 'demo.mp4');
    const made = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5:duration=2', '-c:v', 'mpeg4', mp4], { stdio: 'ignore' });
    expect(made.status, 'the fixture MP4 encodes').toBe(0);
    const gif = await exportReq('d1', { format: 'gif' });
    expect(gif.statusCode, gif.body).toBe(200);
    expect(readFileSync(join(root, 'demo-video', 'demo.gif')).subarray(0, 6).toString('latin1')).toBe('GIF89a');
    const poster = await exportReq('d1', { format: 'poster' });
    expect(poster.statusCode, poster.body).toBe(200);
    const jpg = readFileSync(join(root, 'demo-video', 'poster.jpg'));
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
  });
});
