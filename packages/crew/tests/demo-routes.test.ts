// The Demo experience, crew half (wicked-studio#373, migration M9b).
//
//   POST /api/v1/projects/:id/demo — mints the run's demo root, writes the brief, and launches the
//     built-in `demo` preset THROUGH `POST /runs` with the root as its only extra write root.
//   GET  /api/v1/runs/:id/demo — the stage, script, chapters (+ record progress), contact sheets, the
//     reviewer's verdicts and the chaptered MP4, read from that root and the run's units.
//   GET  /api/v1/runs/:id/demo/file — one deliverable (Range for the MP4), contained to the root.
//   PUT  /api/v1/runs/:id/demo/script — the presenter's edit, only while the plan gate is open.
//
// Fastify inject() with a mock adapter — no engine.

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { parseRange, parseReview } from '../src/api/recording.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { assertWickedRootsOutsideStateHome, StateHomePlacementError } from '../src/projects/state-home-preflight.js';

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

type Step = 'pa-scope' | 'plan' | 'record' | 'review';

/** A demo run as the engine serves it: the PA's scope step, then plan → record → review. */
function demoRun(id: string, cursor: Step, status: string, opts: { preset?: string } = {}) {
  const steps: Step[] = ['pa-scope', 'plan', 'record', 'review'];
  const ix = steps.indexOf(cursor);
  return {
    session: {
      id,
      status,
      unit_ix: ix,
      workflow_id: `${id}:plan-2`,
      problem: 'Make a demo',
      extra_write_roots: [],
      team_plan: { rev: 2, accepted_rev: 2, preset: opts.preset ?? 'demo' },
    },
    units: steps.map((s, i) => ({
      id: `${id}:${s}`,
      session_id: id,
      ord: i + 1,
      status: i < ix ? 'done' : i === ix && status === 'awaiting_human' ? 'done' : 'pending',
      assigned_cli: s === 'record' ? 'claude' : s === 'review' ? 'codex' : null,
    })),
  };
}

describe('the Demo experience routes', () => {
  let demos: string;
  let app: FastifyInstance;
  let launchRun: Mock;
  let sessionsDetail: Mock;
  let workOutput: Mock;
  const prev = process.env.WICKED_DEMO_DIR;

  beforeEach(async () => {
    demos = mkdtempSync(join(tmpdir(), 'demo-roots-'));
    process.env.WICKED_DEMO_DIR = demos;
    launchRun = vi.fn(async (input: LaunchRunInput) => input.sessionId);
    sessionsDetail = vi.fn().mockResolvedValue([]);
    workOutput = vi.fn().mockResolvedValue(null);
    app = buildApp({
      launchRun,
      sessionsDetail,
      workOutput,
      listRepos: vi.fn().mockResolvedValue([]),
      projectMembers: vi.fn().mockResolvedValue([]),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (prev === undefined) delete process.env.WICKED_DEMO_DIR;
    else process.env.WICKED_DEMO_DIR = prev;
    removeScratch(demos);
  });

  it('launches the demo preset through POST /runs with the minted demo root as its only write root', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/demo',
      payload: { url: 'http://127.0.0.1:5173/', audience: 'New team leads', show: 'Launch a run and approve its plan' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json() as { runId: string };
    expect(launchRun).toHaveBeenCalledTimes(1);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    const root = join(demos, runId);
    expect(input.sessionId).toBe(runId);
    expect(input.workflow).toBe('demo');
    expect(input.projectId).toBe('proj-1');
    expect(input.repoRef).toBeUndefined();
    expect(input.extraWriteRoots).toEqual([root]);
    expect(input.problem).toContain(join(root, 'BRIEF.md'));
    expect(input.problem).toContain('wicked-garden-demo');
    // Worker prompts are single-line and capped: the brief carries the words, the problem only points.
    expect(input.problem).not.toContain('\n');
    expect(Buffer.byteLength(input.problem)).toBeLessThan(600);
    const brief = readFileSync(join(root, 'BRIEF.md'), 'utf8');
    expect(brief).toContain('http://127.0.0.1:5173/');
    expect(brief).toContain('New team leads');
    expect(brief).toContain('Launch a run and approve its plan');
    expect(brief).toMatch(/Read-only against the app/);
    expect(brief).toMatch(/synthetic/i);
  });

  it('a demo from Unfiled (the `default` mount) launches unfiled, never into the synthesized project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/default/demo',
      payload: { url: 'http://127.0.0.1:5173/', audience: 'a', show: 'b' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.projectId).toBeUndefined();
    expect(input.workflow).toBe('demo');
  });

  it('POST /runs refuses the demo preset launched directly: it would have no demo root or brief', async () => {
    for (const payload of [
      { problem: 'Make a demo', workflow: 'demo', deliver: 'none' },
      { problem: 'Make a demo', workflow: 'demo', deliver: 'none', sessionId: 'not-minted-by-the-demo-route' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('POST /projects/:id/demo');
    }
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('a demo run whose launch is not scored yet is read off its run identity', async () => {
    const run = demoRun('u1', 'pa-scope', 'executing');
    delete (run.session as { team_plan?: unknown }).team_plan;
    (run.session as { run_identity?: unknown }).run_identity = { kind: 'preset', name: 'demo', user_plan: false, system: true };
    sessionsDetail.mockResolvedValue([run]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/u1/demo' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { stage: string }).stage).toBe('preparing');
  });

  it('refuses a non-http app and removes the root of a launch POST /runs refused', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/proj-1/demo',
      payload: { url: 'file:///etc/passwd', audience: 'a', show: 'b' },
    });
    expect(bad.statusCode).toBe(400);
    expect(launchRun).not.toHaveBeenCalled();

    launchRun.mockRejectedValueOnce(Object.assign(new Error('unknown project'), { code: 'unknown_project' }));
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/nope/demo',
      payload: { url: 'http://127.0.0.1:5173/', audience: 'a', show: 'b' },
    });
    expect(refused.statusCode).not.toBe(201);
    const input = launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(existsSync(join(demos, input.sessionId))).toBe(false);
  });

  /** A root at the review gate: planned, recorded (one chapter not yet), stitched, sheets written. */
  function reviewedRoot(id: string): string {
    const root = join(demos, id);
    mkdirSync(join(root, 'demo-video', 'segments', '01-home'), { recursive: true });
    mkdirSync(join(root, 'review'), { recursive: true });
    writeFileSync(join(root, 'BRIEF.md'), '# Demo brief\n\n- **App:** http://127.0.0.1:5173/\n\n## Who it is for\n\nNew team leads\n\n## What to show\n\nx\n');
    writeFileSync(join(root, 'script.md'), '# Script\n\nAll data is synthetic.\n');
    writeFileSync(
      join(root, 'chapters.json'),
      JSON.stringify([
        { key: '01-home', title: 'Home', blurb: 'What needs you', tags: ['Home'], resets: [] },
        { key: '02-launch', title: 'Launch', blurb: 'Describe the goal', tags: ['Launch'], resets: ['r1'] },
        { key: 'Bad Key', title: 'dropped' },
      ]),
    );
    writeFileSync(join(root, 'demo-video', 'segments', '01-home', 'segment.mp4'), 'seg');
    writeFileSync(join(root, 'demo-video', 'demo.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(root, 'demo-video', 'chapters.md'), '| Time | Chapter |\n|---|---|\n| 0:00 | Introduction |\n| 1:05 | Home |\n');
    writeFileSync(join(root, 'demo-video', 'recording.json'), JSON.stringify({ readOnly: true }));
    for (const n of ['chapters', 'joins', 'end']) writeFileSync(join(root, 'review', `${n}.png`), 'png');
    return root;
  }

  it('serves the review gate: chapters with record progress, sheets, the verdicts, the MP4 and the seats', async () => {
    reviewedRoot('r1');
    sessionsDetail.mockResolvedValue([demoRun('r1', 'review', 'awaiting_human')]);
    workOutput.mockResolvedValue(
      'Findings:\n1:05 · 01-home · caption early · re-encode\n```json\n{"verdict":"changes","findings":[' +
        '{"at":"1:05","chapter":"01-home","issue":"caption early","verdict":"re-encode"},' +
        '{"at":"2:00","chapter":"02-launch","issue":"bad","verdict":"not-a-verdict"}]}\n```\n',
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/demo' });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json();
    expect(v.stage).toBe('review_gate');
    expect(v.url).toBe('http://127.0.0.1:5173/');
    expect(v.audience).toBe('New team leads');
    expect(v.chapters.map((c: { key: string; recorded: boolean }) => [c.key, c.recorded])).toEqual([
      ['01-home', true],
      ['02-launch', false],
    ]);
    expect(v.markers).toEqual([
      { at: '0:00', sec: 0, title: 'Introduction' },
      { at: '1:05', sec: 65, title: 'Home' },
    ]);
    expect(v.sheets.map((s: { name: string }) => s.name)).toEqual(['chapters', 'joins', 'end']);
    expect(v.video).toEqual({ path: 'demo-video/demo.mp4', bytes: 10 });
    expect(v.recording).toEqual({ readOnly: true });
    expect(v.review.verdict).toBe('changes');
    expect(v.review.findings).toEqual([{ at: '1:05', chapter: '01-home', issue: 'caption early', verdict: 're-encode' }]);
    expect(v.seats).toEqual({ recorder: 'claude', reviewer: 'codex' });
    expect(v.syntheticLabelled).toBe(true);
    expect(workOutput).toHaveBeenCalledWith('r1:review');
  });

  it('the view follows no symlink a worker made out of the root', async () => {
    const root = reviewedRoot('r9');
    const outside = mkdtempSync(join(tmpdir(), 'demo-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'SECRET-FROM-OUTSIDE');
      writeFileSync(join(outside, 'big.mp4'), Buffer.alloc(64));
      for (const f of ['script.md', 'demo-video/demo.mp4', 'review/end.png']) removeScratch(join(root, f));
      symlinkSync(join(outside, 'secret.md'), join(root, 'script.md'));
      symlinkSync(join(outside, 'big.mp4'), join(root, 'demo-video', 'demo.mp4'));
      symlinkSync(join(outside, 'secret.md'), join(root, 'review', 'end.png'));
      sessionsDetail.mockResolvedValue([demoRun('r9', 'review', 'awaiting_human')]);
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r9/demo' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('SECRET-FROM-OUTSIDE');
      const v = res.json() as { script: string | null; video: unknown; sheets: Array<{ name: string }> };
      expect(v.script).toBeNull();
      expect(v.video).toBeNull();
      expect(v.sheets.map((x) => x.name)).toEqual(['chapters', 'joins']);
    } finally {
      removeScratch(outside);
    }
  });

  it('names each stage from the cursor and the run status', async () => {
    const stageOf = async (cursor: Step, status: string): Promise<string> => {
      sessionsDetail.mockResolvedValue([demoRun('s1', cursor, status)]);
      return ((await app.inject({ method: 'GET', url: '/api/v1/runs/s1/demo' })).json() as { stage: string }).stage;
    };
    expect(await stageOf('pa-scope', 'executing')).toBe('preparing');
    expect(await stageOf('plan', 'executing')).toBe('planning');
    expect(await stageOf('plan', 'awaiting_human')).toBe('plan_gate');
    expect(await stageOf('record', 'executing')).toBe('recording');
    expect(await stageOf('review', 'executing')).toBe('reviewing');
    expect(await stageOf('review', 'awaiting_human')).toBe('review_gate');
    expect(await stageOf('review', 'completed')).toBe('done');
    expect(await stageOf('record', 'failed')).toBe('failed');
  });

  it('reads the gates the way the engine opens them: the plan gate with the cursor on record, the review gate after review', async () => {
    // The live engine (wicked-core `awaitingHuman{ord: 3, reviewingOrd: 2}`): plan done, cursor on record.
    const planGate = demoRun('g1', 'record', 'awaiting_human');
    planGate.units[2]!.status = 'pending';
    const reviewGate = demoRun('g2', 'review', 'awaiting_human');
    const rerecording = demoRun('g3', 'record', 'executing');
    rerecording.units[3]!.status = 'done';
    sessionsDetail.mockResolvedValue([planGate, reviewGate, rerecording]);
    const stage = async (id: string): Promise<string> =>
      ((await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/demo` })).json() as { stage: string }).stage;
    expect(await stage('g1')).toBe('plan_gate');
    expect(await stage('g2')).toBe('review_gate');
    expect(await stage('g3')).toBe('recording');
  });

  it('a record the engine rejected is no plan gate, and its script cannot be edited', async () => {
    reviewedRoot('x1');
    const run = demoRun('x1', 'record', 'awaiting_human');
    run.units[2]!.status = 'rejected';
    sessionsDetail.mockResolvedValue([run]);
    expect(((await app.inject({ method: 'GET', url: '/api/v1/runs/x1/demo' })).json() as { stage: string }).stage).toBe('recording');
    const put = await app.inject({ method: 'PUT', url: '/api/v1/runs/x1/demo/script', payload: { content: '# edited' } });
    expect(put.statusCode).toBe(409);
  });

  it('a review the engine judged NOT PASS is the review gate, rejected, with its verdict read', async () => {
    reviewedRoot('f1');
    const failed = demoRun('f1', 'review', 'awaiting_human');
    failed.units[3]!.status = 'rejected';
    sessionsDetail.mockResolvedValue([failed]);
    workOutput.mockResolvedValue('Captions early.\n```json\n{"verdict": "changes", "findings": [{"at": "0:41", "chapter": "02-launch", "issue": "caption early", "verdict": "re-record"}]}\n```');
    const v = (await app.inject({ method: 'GET', url: '/api/v1/runs/f1/demo' })).json() as {
      stage: string; review: { verdict: string; rejected: boolean; findings: unknown[] };
    };
    expect(v.stage).toBe('review_gate');
    expect(v.review.rejected).toBe(true);
    expect(v.review.verdict).toBe('changes');
    expect(v.review.findings).toHaveLength(1);
  });

  it('a held team plan is the team gate, and a run with only its scope step is preparing', async () => {
    const held = demoRun('t1', 'plan', 'awaiting_human');
    held.session.team_plan = { rev: 2, accepted_rev: 1, preset: 'demo' };
    held.units[1]!.status = 'pending';
    const scoping = demoRun('t2', 'pa-scope', 'executing');
    scoping.units = scoping.units.slice(0, 1);
    sessionsDetail.mockResolvedValue([held, scoping]);
    const stage = async (id: string): Promise<string> =>
      ((await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/demo` })).json() as { stage: string }).stage;
    expect(await stage('t1')).toBe('team_gate');
    expect(await stage('t2')).toBe('preparing');
  });

  it('answers 404 for a run that is not a demo run', async () => {
    sessionsDetail.mockResolvedValue([demoRun('f1', 'plan', 'executing', { preset: 'feature' })]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/demo' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs/none/demo' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/demo/file?path=review/end.png' })).statusCode).toBe(404);
  });

  it('serves a deliverable from the root only, with Range for the MP4', async () => {
    const root = reviewedRoot('r2');
    writeFileSync(join(demos, 'secret.png'), 'outside');
    symlinkSync(join(demos, 'secret.png'), join(root, 'review', 'leak.png'));
    sessionsDetail.mockResolvedValue([demoRun('r2', 'review', 'awaiting_human')]);

    const png = await app.inject({ method: 'GET', url: '/api/v1/runs/r2/demo/file?path=review/joins.png' });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.body).toBe('png');

    const part = await app.inject({
      method: 'GET',
      url: '/api/v1/runs/r2/demo/file?path=demo-video/demo.mp4',
      headers: { range: 'bytes=2-5' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body).toBe('2345');

    const escape = await app.inject({ method: 'GET', url: '/api/v1/runs/r2/demo/file?path=../secret.png' });
    expect(escape.statusCode).toBe(404);
    const viaLink = await app.inject({ method: 'GET', url: '/api/v1/runs/r2/demo/file?path=review/leak.png' });
    expect(viaLink.statusCode).toBe(404);
    const absolute = await app.inject({ method: 'GET', url: `/api/v1/runs/r2/demo/file?path=${encodeURIComponent(join(demos, 'secret.png'))}` });
    expect(absolute.statusCode).toBe(404);
    const type = await app.inject({ method: 'GET', url: '/api/v1/runs/r2/demo/file?path=storyline.mjs' });
    expect(type.statusCode).toBe(400);
    const range = await app.inject({
      method: 'GET',
      url: '/api/v1/runs/r2/demo/file?path=demo-video/demo.mp4',
      headers: { range: 'bytes=20-30' },
    });
    expect(range.statusCode).toBe(416);
  });

  it('the file route reads the run list once per demo run, not once per Range request', async () => {
    reviewedRoot('c1');
    sessionsDetail.mockResolvedValue([demoRun('c1', 'review', 'awaiting_human')]);
    for (const range of ['bytes=0-3', 'bytes=4-7', 'bytes=8-9']) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/c1/demo/file?path=demo-video/demo.mp4', headers: { range } });
      expect(res.statusCode).toBe(206);
    }
    expect(sessionsDetail).toHaveBeenCalledTimes(1);
  });

  it('takes the presenter script edit only while the plan gate is open', async () => {
    const root = reviewedRoot('r3');
    sessionsDetail.mockResolvedValue([demoRun('r3', 'record', 'executing')]);
    const late = await app.inject({ method: 'PUT', url: '/api/v1/runs/r3/demo/script', payload: { content: '# New' } });
    expect(late.statusCode).toBe(409);
    expect(readFileSync(join(root, 'script.md'), 'utf8')).toContain('synthetic');

    sessionsDetail.mockResolvedValue([demoRun('r3', 'plan', 'awaiting_human')]);
    const ok = await app.inject({ method: 'PUT', url: '/api/v1/runs/r3/demo/script', payload: { content: '# New script' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(readFileSync(join(root, 'script.md'), 'utf8')).toBe('# New script');

    const big = await app.inject({
      method: 'PUT',
      url: '/api/v1/runs/r3/demo/script',
      payload: { content: 'x'.repeat(256 * 1024 + 1) },
    });
    expect(big.statusCode).toBe(413);
  });

  it('refuses a demo root inside the state home at boot', () => {
    const home = mkdtempSync(join(tmpdir(), 'state-home-'));
    try {
      expect(() => assertWickedRootsOutsideStateHome({ WICKED_DEMO_DIR: join(home, 'demos') }, home)).toThrow(
        StateHomePlacementError,
      );
      expect(() => assertWickedRootsOutsideStateHome({ WICKED_DEMO_DIR: join(tmpdir(), 'elsewhere') }, home)).not.toThrow();
    } finally {
      removeScratch(home);
    }
  });
});

describe('demo parsers', () => {
  it('reads the LAST fenced json block of the review and drops malformed findings', () => {
    expect(parseReview(null)).toEqual({ verdict: null, findings: [] });
    expect(parseReview('no block')).toEqual({ verdict: null, findings: [] });
    const two = '```json\n{"verdict":"changes","findings":[]}\n```\nthen\n```json\n{"verdict":"accept","findings":[]}\n```';
    expect(parseReview(two).verdict).toBe('accept');
    expect(parseReview('```json\n{not json\n```').verdict).toBeNull();
  });

  it('parses a single byte range and refuses the ones it cannot serve', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=4-100', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=10-12', 10)).toBe('bad');
    expect(parseRange('bytes=1-2,4-5', 10)).toBe('bad');
    expect(parseRange('items=0-1', 10)).toBe('bad');
  });
});
