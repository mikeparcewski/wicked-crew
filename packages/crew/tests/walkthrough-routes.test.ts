// Walkthroughs, crew half, slice WT-W1 (DES-walkthrough-proof §4.2, §4.10).
//
//   GET /api/v1/runs/:id/walkthrough?step=       the WalkthroughView: the pair's state (every state),
//                                                its chapters and checks, the video, the seats — read
//                                                from the run's units and the PROOF ROOT under the
//                                                run's evidence root, never from a caller-named path.
//   GET /api/v1/runs/:id/walkthrough/file?step=&path=
//                                                one file of that step's proof root, symlinks resolved
//                                                inside it.
//
// Fastify inject() with a mock adapter — no engine. The launch half (the minted evidence root and its
// author write root) is pinned in tests/walkthrough-launch.test.ts.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WalkthroughView } from 'wicked-crew-api-types';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

function buildApp(adapter: Record<string, unknown>): FastifyInstance {
  const app = Fastify({ logger: false });
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

type UnitStatus = 'pending' | 'distributed' | 'done' | 'rejected';

interface UnitSpec {
  step: string;
  catalog: string;
  role?: string;
  status: UnitStatus;
  cli?: string | null;
  denial?: string | null;
}

/** A repo-bound team run: build → walkthrough_plan → walkthrough_review (+ whatever the test adds). */
function run(id: string, evidenceRoot: string | null, units: UnitSpec[], status = 'running') {
  const cursor = units.findIndex((u) => u.status !== 'done');
  return {
    session: {
      id,
      status,
      unit_ix: cursor === -1 ? units.length : cursor,
      workflow_id: `${id}:plan-1`,
      problem: 'Fix the double charge',
      workdir: '/tmp/wt',
      extra_write_roots: evidenceRoot === null ? [] : [join(evidenceRoot, 'author')],
      ...(evidenceRoot === null ? {} : { evidence_root: evidenceRoot }),
      team_plan: { rev: 1, accepted_rev: 1 },
    },
    units: units.map((u, i) => ({
      id: `${id}:${u.step}`,
      session_id: id,
      ord: i + 1,
      catalog: u.catalog,
      role: u.role ?? (u.catalog === 'build' ? 'creator' : u.catalog === 'walkthrough_plan' ? 'evaluator' : 'neutral'),
      status: u.status,
      assigned_cli: u.cli === undefined ? (u.catalog === 'build' ? 'claude' : u.catalog === 'walkthrough_plan' ? 'codex' : null) : u.cli,
      denial_reason: u.denial ?? null,
    })),
  };
}

const PAIR = (plan: UnitStatus, review: UnitStatus, extra: Partial<Record<'planDenial', string>> = {}): UnitSpec[] => [
  { step: 'build', catalog: 'build', status: 'done' },
  { step: 'walkthrough_plan', catalog: 'walkthrough_plan', status: plan, denial: extra.planDenial ?? null },
  { step: 'walkthrough_review', catalog: 'walkthrough_review', status: review },
];

const RESULT_PASS = {
  overall: 'PASS',
  tree: 'a1b2c3d4',
  chapters: [
    {
      key: '01-pay-once',
      verdict: 'PASS',
      takes: 1,
      proves: ['build'],
      legs: [{ leg: 'provider', claim_level: 'machinery-verified', reason: 'the provider is a sink' }],
      checks: [
        { id: 'c1', kind: 'on_screen', sentence: 'The receipt reads Paid', passed: true, at_sec: 4.2, evidence: ['capture/c1.png'], vault_entry: 'v-1' },
        { id: 'c2', kind: 'saved_state', sentence: 'One order row, status paid', passed: true, at_sec: 5.1, evidence: ['capture/c2.parsed.json'] },
      ],
    },
  ],
};

describe('GET /runs/:id/walkthrough — the recording view (WT-W1)', () => {
  let roots: string;
  let app: FastifyInstance;
  let sessionsDetail: Mock;

  /** `<evidence root>/<step>/` with the given files (JSON values are serialized). */
  function proofRoot(evidence: string, step: string, files: Record<string, unknown>): string {
    const dir = join(evidence, step);
    mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
  }

  async function view(id: string, step?: string): Promise<{ status: number; body: WalkthroughView & { error?: string } }> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/walkthrough${step !== undefined ? `?step=${step}` : ''}` });
    return { status: res.statusCode, body: res.json() as WalkthroughView & { error?: string } };
  }

  beforeEach(async () => {
    roots = mkdtempSync(join(tmpdir(), 'walkthrough-roots-'));
    sessionsDetail = vi.fn().mockResolvedValue([]);
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
    removeScratch(roots);
  });

  it('404s an unknown run; a known run with no walkthrough step is 200 with stepId null and cause no_walkthrough', async () => {
    sessionsDetail.mockResolvedValue([run('r0', join(roots, 'r0'), [{ step: 'build', catalog: 'build', status: 'done' }])]);
    expect((await view('nope')).status).toBe(404);
    const { status, body } = await view('r0');
    expect(status).toBe(200);
    expect(body).toMatchObject({ runId: 'r0', stepId: null, planStepId: null, state: 'authoring', cause: 'no_walkthrough', chapters: [], steps: [], stale: false, sealed: false });
  });

  it('authoring while the author has not finished; seats name the evaluator apart from the builders', async () => {
    const ev = join(roots, 'r1');
    sessionsDetail.mockResolvedValue([run('r1', ev, PAIR('distributed', 'pending'))]);
    const { body } = await view('r1');
    expect(body).toMatchObject({ stepId: 'walkthrough_review', planStepId: 'walkthrough_plan', state: 'authoring', cause: null });
    expect(body.seat).toEqual({ evaluator: 'codex', builders: ['claude'] });
  });

  it('linting: the author was denied by its lint — the cause is the denial', async () => {
    const ev = join(roots, 'r2');
    sessionsDetail.mockResolvedValue([run('r2', ev, PAIR('rejected', 'pending', { planDenial: 'check c2 has no negative sample' }))]);
    const { body } = await view('r2');
    expect(body.state).toBe('linting');
    expect(body.cause).toBe('check c2 has no negative sample');
  });

  it('starting_app while the recorder is queued, or running with no progress file yet', async () => {
    const ev = join(roots, 'r3');
    sessionsDetail.mockResolvedValue([run('r3', ev, PAIR('done', 'pending'))]);
    expect((await view('r3')).body.state).toBe('starting_app');
    sessionsDetail.mockResolvedValue([run('r3', ev, PAIR('done', 'distributed'))]);
    expect((await view('r3')).body.state).toBe('starting_app');
  });

  it('recording and judging come from the recorder progress file; an unknown phase reads starting_app', async () => {
    const ev = join(roots, 'r4');
    sessionsDetail.mockResolvedValue([run('r4', ev, PAIR('done', 'distributed'))]);
    proofRoot(ev, 'walkthrough_review', { 'progress.json': { state: 'recording', chapter: '01-pay-once' }, 'chapters.json': [{ key: '01-pay-once', title: 'Pay once' }] });
    const rec = (await view('r4')).body;
    expect(rec.state).toBe('recording');
    expect(rec.chapters.map((c) => [c.key, c.title, c.index, c.total, c.verdict])).toEqual([['01-pay-once', 'Pay once', 1, 1, null]]);
    writeFileSync(join(ev, 'walkthrough_review', 'progress.json'), JSON.stringify({ state: 'judging' }));
    expect((await view('r4')).body.state).toBe('judging');
    writeFileSync(join(ev, 'walkthrough_review', 'progress.json'), JSON.stringify({ state: 'passed' }));
    expect((await view('r4')).body.state).toBe('starting_app');
  });

  it('passed: result.json overall PASS, with chapters, checks, legs, the tree and the stitched video', async () => {
    const ev = join(roots, 'r5');
    sessionsDetail.mockResolvedValue([run('r5', ev, PAIR('done', 'done'))]);
    proofRoot(ev, 'walkthrough_review', {
      'result.json': RESULT_PASS,
      'chapters.json': [{ key: '01-pay-once', title: 'Pay once', blurb: 'One charge per order' }],
      'demo-video/demo.mp4': 'mp4-bytes',
      'demo-video/poster.jpg': 'jpg',
      'demo-video/chapters.md': '| 0:00 | Pay once |\n',
      'demo-video/segments/01-pay-once/segment.mp4': 'seg',
    });
    const { body } = await view('r5');
    expect(body.state).toBe('passed');
    expect(body.cause).toBeNull();
    expect(body.tree).toBe('a1b2c3d4');
    expect(body.video).toEqual({ mp4: 'demo-video/demo.mp4', poster: 'demo-video/poster.jpg', markers: [{ at: '0:00', sec: 0, title: 'Pay once' }] });
    expect(body.chapters).toHaveLength(1);
    const ch = body.chapters[0]!;
    expect(ch).toMatchObject({ key: '01-pay-once', title: 'Pay once', blurb: 'One charge per order', recorded: true, verdict: 'PASS', takes: 1, failedAtSec: null, failedFrame: null, proves: ['build'] });
    expect(ch.legs).toEqual([{ leg: 'provider', claim_level: 'machinery-verified', reason: 'the provider is a sink' }]);
    expect(ch.checks[0]).toEqual({ id: 'c1', kind: 'on_screen', sentence: 'The receipt reads Paid', passed: true, atSec: 4.2, evidence: ['capture/c1.png'], vaultEntry: 'v-1', detail: null });
    expect(ch.checks[1]).toMatchObject({ id: 'c2', vaultEntry: null, evidence: ['capture/c2.parsed.json'] });
    // The seal is WT-W2's: nothing is sealed, and no step state is computed, in this slice.
    expect(body.sealed).toBe(false);
    expect(body.steps).toEqual([]);
  });

  it('failed: overall FAIL keeps the failing second and frame (contained to the proof root)', async () => {
    const ev = join(roots, 'r6');
    sessionsDetail.mockResolvedValue([run('r6', ev, PAIR('done', 'rejected'))]);
    proofRoot(ev, 'walkthrough_review', {
      'result.json': {
        overall: 'FAIL',
        chapters: [
          { key: '01-pay-once', verdict: 'FAIL', takes: 2, failed_at_sec: 7.5, failed_frame: 'segments/01-pay-once/failed-2/frame.png', checks: [{ id: 'c2', kind: 'saved_state', sentence: 'One order row', passed: false, at_sec: 7.5, detail: 'two rows' }] },
          { key: '02-escape', verdict: 'FAIL', failed_frame: '../../outside.png' },
        ],
      },
      'segments/01-pay-once/failed-2/frame.png': 'png',
    });
    const { body } = await view('r6');
    expect(body.state).toBe('failed');
    expect(body.chapters.map((c) => [c.key, c.verdict, c.takes, c.failedAtSec, c.failedFrame])).toEqual([
      ['01-pay-once', 'FAIL', 2, 7.5, 'segments/01-pay-once/failed-2/frame.png'],
      ['02-escape', 'FAIL', 1, null, null],
    ]);
    expect(body.chapters[0]!.checks[0]).toMatchObject({ passed: false, detail: 'two rows' });
  });

  it('inconclusive: the recorder (or the engine) wrote INCONCLUSIVE with its cause', async () => {
    const ev = join(roots, 'r7');
    sessionsDetail.mockResolvedValue([run('r7', ev, PAIR('done', 'rejected'))]);
    proofRoot(ev, 'walkthrough_review', { 'result.json': { overall: 'INCONCLUSIVE', cause: 'unjailed_host', reason: 'no OS jail on this host', chapters: [] } });
    const { body } = await view('r7');
    expect(body).toMatchObject({ state: 'inconclusive', cause: 'unjailed_host', chapters: [] });
  });

  it('a finished recorder with no readable result reads inconclusive / no_result; a run with no evidence root says so', async () => {
    const ev = join(roots, 'r8');
    sessionsDetail.mockResolvedValue([run('r8', ev, PAIR('done', 'rejected'))]);
    proofRoot(ev, 'walkthrough_review', { 'result.json': '{not json' });
    expect((await view('r8')).body).toMatchObject({ state: 'inconclusive', cause: 'no_result' });
    sessionsDetail.mockResolvedValue([run('r9', null, PAIR('done', 'rejected'))]);
    expect((await view('r9')).body).toMatchObject({ state: 'inconclusive', cause: 'no_evidence_root' });
  });

  it('defaults to the NEWEST pair; ?step= picks a pair by its review or plan step id; an unknown step is 404', async () => {
    const ev = join(roots, 'r10');
    const units: UnitSpec[] = [
      { step: 'build', catalog: 'build', status: 'done' },
      { step: 'wp1', catalog: 'walkthrough_plan', status: 'done' },
      { step: 'wr1', catalog: 'walkthrough_review', status: 'done' },
      { step: 'build-2', catalog: 'build', status: 'done', cli: 'pi' },
      { step: 'wp2', catalog: 'walkthrough_plan', status: 'distributed' },
      { step: 'wr2', catalog: 'walkthrough_review', status: 'pending' },
    ];
    sessionsDetail.mockResolvedValue([run('r10', ev, units)]);
    proofRoot(ev, 'wr1', { 'result.json': RESULT_PASS });
    const newest = (await view('r10')).body;
    expect([newest.stepId, newest.planStepId, newest.state]).toEqual(['wr2', 'wp2', 'authoring']);
    expect(newest.seat.builders).toEqual(['claude', 'pi']);
    const first = (await view('r10', 'wr1')).body;
    expect([first.stepId, first.planStepId, first.state]).toEqual(['wr1', 'wp1', 'passed']);
    // The first pair's builders are the creators BEFORE its review, not the later rework's.
    expect(first.seat.builders).toEqual(['claude']);
    expect((await view('r10', 'wp1')).body.stepId).toBe('wr1');
    const unknown = await view('r10', 'build');
    expect(unknown.status).toBe(404);
  });

  it('an author no recorder resolves to is its own (newest) pair, even with a recorder after it (codex)', async () => {
    const ev = join(roots, 'r12');
    const units: UnitSpec[] = [
      { step: 'build', catalog: 'build', status: 'done' },
      { step: 'p1', catalog: 'walkthrough_plan', status: 'done' },
      { step: 'p2', catalog: 'walkthrough_plan', status: 'distributed' },
      { step: 'r1', catalog: 'walkthrough_review', status: 'done' },
    ];
    const r = run('r12', ev, units);
    (r.units[3] as Record<string, unknown>).depends_on = ['p1'];
    sessionsDetail.mockResolvedValue([r]);
    const newest = (await view('r12')).body;
    expect([newest.stepId, newest.planStepId, newest.state]).toEqual([null, 'p2', 'authoring']);
    expect((await view('r12', 'r1')).body.planStepId).toBe('p1');
  });

  it('never reads a proof root through a link planted at the step path', async () => {
    const ev = join(roots, 'r11');
    const elsewhere = join(roots, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'result.json'), JSON.stringify(RESULT_PASS));
    mkdirSync(ev, { recursive: true });
    symlinkSync(elsewhere, join(ev, 'walkthrough_review'));
    sessionsDetail.mockResolvedValue([run('r11', ev, PAIR('done', 'done'))]);
    expect((await view('r11')).body).toMatchObject({ state: 'inconclusive', cause: 'no_result' });
  });

  describe('GET /runs/:id/walkthrough/file', () => {
    it('serves a proof-root file (with Range for the MP4) and refuses escapes, links out and other types', async () => {
      const ev = join(roots, 'f1');
      sessionsDetail.mockResolvedValue([run('f1', ev, PAIR('done', 'done'))]);
      const dir = proofRoot(ev, 'walkthrough_review', { 'result.json': RESULT_PASS, 'demo-video/demo.mp4': '0123456789', 'capture/c1.png': 'png' });
      writeFileSync(join(roots, 'secret.png'), 'secret');
      symlinkSync(join(roots, 'secret.png'), join(dir, 'capture', 'leak.png'));
      writeFileSync(join(dir, 'storyline.mjs'), 'export default {}');

      const png = await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?path=capture/c1.png' });
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.body).toBe('png');
      const ranged = await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?step=walkthrough_review&path=demo-video/demo.mp4', headers: { range: 'bytes=2-4' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.body).toBe('234');
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?path=../../secret.png' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?path=capture/leak.png' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/v1/runs/f1/walkthrough/file?path=${encodeURIComponent(join(roots, 'secret.png'))}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?path=storyline.mjs' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/nope/walkthrough/file?path=capture/c1.png' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f1/walkthrough/file?step=build&path=capture/c1.png' })).statusCode).toBe(404);
    });

    it('never serves the author dir: the storyline is the test plan, not evidence', async () => {
      const ev = join(roots, 'f2');
      sessionsDetail.mockResolvedValue([run('f2', ev, PAIR('done', 'done'))]);
      proofRoot(ev, 'walkthrough_review', { 'result.json': RESULT_PASS });
      mkdirSync(join(ev, 'author', 'walkthrough_plan'), { recursive: true });
      writeFileSync(join(ev, 'author', 'walkthrough_plan', 'notes.md'), 'x');
      expect((await app.inject({ method: 'GET', url: '/api/v1/runs/f2/walkthrough/file?path=../author/walkthrough_plan/notes.md' })).statusCode).toBe(404);
    });
  });
});
