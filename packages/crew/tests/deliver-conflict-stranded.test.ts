// crew#418 A — a deliver-phase LIFT collision strands, it does not fail the run.
//
// The engine reports a run `failed` whenever a Tool phase exits non-zero, and the deliver phase
// is a Tool phase. But when the ONLY thing that failed was the LIFT — the hardened deliver script
// refused on a rebase conflict the changelog union merge could not clear, or a non-fast-forward
// push, printing its DELIVER_LIFT_CONFLICT_MARKER — the run's WORK is complete and committed on
// its `wicked/<id>` branch. crew reinterprets that exact shape on the wire as `completed` +
// `delivery: 'stranded'` (recoverable via POST /runs/:id/deliver), consistently across GET
// /runs(/:id), the resume refusal, and the post-hoc deliver route. The engine's durable `failed`
// record is untouched — this is a wire derivation, like `delivery` itself.
//
// Two layers here:
//   WIRE (stub adapter, injected probes) — the status reinterpretation and its guards: the marker
//     strands; a markerless deliver failure (spawn/infra) and a genuine work-phase failure do NOT.
//   END-TO-END (real git, the post-hoc harness) — a run stranded by a REAL non-changelog rebase
//     conflict reads completed+stranded, its work is intact, and once the collision is cleared
//     POST /runs/:id/deliver lifts it into a PR for real.

import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex, gitWorktreeIsClean } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { runDeliverScript } from '../src/api/post-hoc-deliver.js';
import { DELIVER_LIFT_CONFLICT_MARKER } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const RUN_ID = 'ab114181-1111-4222-8333-444455556666';

/** How core spells a Tool-phase step failure on the unit: the WORKER_FAILURE_MARKER prefix plus a
 *  head+TAIL excerpt of the script output — the marker is the script's LAST line, so it lands in
 *  the tail. This mirrors `wicked-core/src/actor.rs` (`Worker FAILED on unit … (triage: …): …`). */
function deliverDenialReason(marker: string): string {
  return (
    `Worker FAILED on unit 5 (triage: the deliver step exited non-zero): ` +
    `Rebasing (1/1)\nCONFLICT (content): Merge conflict in src/thing.ts\n` +
    `Could not apply 0f3a…\n${marker} — rebase of wicked/${RUN_ID} onto origin/main hit ` +
    `conflicts outside the changelog; resolve on the branch and re-run; nothing was pushed`
  );
}

function unit(over: Partial<WorkUnit> & { id: string }): WorkUnit {
  return {
    session_id: RUN_ID,
    ord: 0,
    description: '',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: 'done',
    ...over,
  } as unknown as WorkUnit;
}

function view(over: {
  status?: string;
  repo_ref?: string | null;
  workdir?: string | null;
  units?: WorkUnit[];
}): SessionView {
  return {
    session: {
      id: RUN_ID,
      workflow_id: 'feature-deliver-' + RUN_ID,
      problem: 'fix the thing (#411)',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'failed',
      human_confirm: 'none',
      unit_ix: 5,
      attempt: 0,
      workdir: over.workdir ?? `/tmp/${RUN_ID}`,
      repo_ref: over.repo_ref === undefined ? 'repo-1' : over.repo_ref,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: over.units ?? [],
  } as unknown as SessionView;
}

/** A route set over a stub adapter, with the vacuity probes INJECTED so no real repo is touched:
 *  the worktree "exists" and "carries work" (not clean), the exact shape a stranded run leaves. */
function buildApp(views: SessionView[], runtimeOver: Partial<RuntimeDeps> = {}): FastifyInstance {
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    resumeRun: vi.fn(async () => 'executing'),
    listRepos: vi.fn(async () => []),
  } as unknown as CoreAdapter;
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
    adapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex: new DeliveryIndex(),
      worktreeExists: () => true,
      worktreeIsClean: async () => false,
      runBranchIsEmpty: async () => false,
      ...runtimeOver,
    },
  );
  return app;
}

const apps: FastifyInstance[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('crew#418 A — a deliver lift collision strands on the wire, it does not fail the run', () => {
  const strandedUnits = [
    unit({ id: `${RUN_ID}:build`, ord: 3, status: 'done' }),
    unit({
      id: `${RUN_ID}:deliver`,
      ord: 5,
      status: 'rejected',
      denial_reason: deliverDenialReason(DELIVER_LIFT_CONFLICT_MARKER),
      tool_cmd: ['bash', '-lc', 'gh pr create --head "$B" --fill'],
    }),
  ];

  it('GET /runs/:id reinterprets the failed run as completed + delivery: stranded', async () => {
    const app = buildApp([view({ status: 'failed', units: strandedUnits })]);
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown>; units: WorkUnit[] };
    };
    expect(body.run.session['status']).toBe('completed');
    expect(body.run.session['delivery']).toBe('stranded');
    // WHY it stranded stays on the wire — the deliver unit is still rejected with its marker.
    const deliver = body.run.units.find((u) => u.id.endsWith(':deliver'))!;
    expect(deliver.status).toBe('rejected');
    expect(deliver.denial_reason).toContain(DELIVER_LIFT_CONFLICT_MARKER);
  });

  it('GET /runs surfaces the same reinterpretation (the home needs-you count reads stranded)', async () => {
    const app = buildApp([view({ status: 'failed', units: strandedUnits })]);
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs` })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    const run = body.runs.find((r) => r.session['id'] === RUN_ID)!;
    expect(run.session['status']).toBe('completed');
    // crew#393's needs-you rollup counts `delivery: 'stranded'`; the newly-stranded run reaches it.
    expect(run.session['delivery']).toBe('stranded');
  });

  it('POST /runs/:id/resume refuses with the DELIVER recovery, not a re-entry', async () => {
    const app = buildApp([view({ status: 'failed', units: strandedUnits })]);
    apps.push(app);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/resume` });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; recovery: string };
    expect(body.recovery).toBe('deliver');
    expect(body.error).toContain(`POST /runs/${RUN_ID}/deliver`);
  });

  it('a deliver failure WITHOUT the marker (spawn/infra) stays failed — delivery none', async () => {
    // The deliver unit rejected, but its denial_reason carries NO marker — a spawn/infra fault or
    // a gh failure. That is a genuine terminal failure (the crew#400 posture), never a strand.
    const units = [
      unit({ id: `${RUN_ID}:build`, ord: 3, status: 'done' }),
      unit({
        id: `${RUN_ID}:deliver`,
        ord: 5,
        status: 'rejected',
        denial_reason:
          'Worker FAILED on unit 5 (triage: spawn failed): bash: gh: command not found',
        tool_cmd: ['bash', '-lc', 'gh pr create --head "$B" --fill'],
      }),
    ];
    const app = buildApp([view({ status: 'failed', units })]);
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(body.run.session['status']).toBe('failed');
    // A failed run derives delivery 'none' — its unit rejection already spells the failure.
    expect(body.run.session['delivery']).toBe('none');
  });

  it('a genuine WORK-phase failure (a non-deliver unit rejected) stays failed', async () => {
    // The build phase failed, so the deliver phase never ran (it depends on build). Even if some
    // stale marker were around, a rejected non-deliver unit means the run itself did not finish.
    const units = [
      unit({
        id: `${RUN_ID}:build`,
        ord: 3,
        status: 'rejected',
        denial_reason: 'Worker FAILED on unit 3 (triage: the tests did not pass): 4 failing',
      }),
      unit({ id: `${RUN_ID}:deliver`, ord: 5, status: 'pending' }),
    ];
    const app = buildApp([view({ status: 'failed', units })]);
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(body.run.session['status']).toBe('failed');
    expect(body.run.session['delivery']).toBe('none');
  });

  it('a repo-less run is never stranded (there is no worktree to lift)', async () => {
    const app = buildApp([view({ status: 'failed', repo_ref: null, units: strandedUnits })]);
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(body.run.session['status']).toBe('failed');
  });
});

// ── END-TO-END: strand by a REAL conflict, then lift it once the collision is cleared ──

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

interface Fixture {
  workdir: string;
  clone: string;
  origin: string;
  root: string;
  env: Record<string, string>;
}

/** A bare origin + a clone on main + a run worktree on wicked/<id>, plus a stub `gh` on a temp
 *  HOME — the same discipline as deliver-posthoc-route.test.ts. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'crew-strand-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'thing.ts'), 'export const v = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');
  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  api) echo "tester";;',
      '  auth) echo "gh: switched account";;',
      '  pr) echo "https://github.com/o/r/pull/71";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { workdir, clone, origin, root, env: { HOME: home, GH_ACCOUNT: '' } };
}

function originBranches(fx: Fixture): string[] {
  return git(fx.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('crew#418 A — strand then lift, end-to-end on real git', () => {
  it('a REAL non-changelog rebase conflict reads completed+stranded; clearing it lets POST /deliver lift', async () => {
    const fx = fixture();
    // The run's committed work touches thing.ts line 1…
    writeFileSync(join(fx.workdir, 'thing.ts'), 'export const v = 2; // run\n');
    git(fx.workdir, 'add', '-A');
    git(fx.workdir, 'commit', '-qm', 'run change');
    // …and main moves under it on the SAME line — a genuine (non-changelog) collision.
    writeFileSync(join(fx.clone, 'thing.ts'), 'export const v = 3; // main\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'main moved');
    git(fx.clone, 'push', '-q', 'origin', 'main');

    // Prove the deliver script REALLY refuses with the marker here (nothing pushed).
    const first = await runDeliverScript(fx.workdir, 'run change', fx.env);
    expect(first.status).not.toBe(0);
    expect(first.output).toContain(DELIVER_LIFT_CONFLICT_MARKER);
    expect(originBranches(fx)).toEqual(['main']);

    // The engine would record the run `failed` with that marker on the deliver unit. Build that
    // exact SessionView and serve it through the REAL vacuity probes over the REAL worktree.
    const units = [
      unit({ id: `${RUN_ID}:build`, ord: 3, status: 'done' }),
      unit({
        id: `${RUN_ID}:deliver`,
        ord: 5,
        status: 'rejected',
        denial_reason: `Worker FAILED on unit 5 (triage: deliver refused): ${first.output.slice(-400)}`,
        tool_cmd: ['bash', '-lc', 'gh pr create --head "$B" --fill'],
      }),
    ];
    const runView = view({ status: 'failed', workdir: fx.workdir, units });
    let calls = 0;
    const app = buildApp([runView], {
      worktreeExists: (p) => existsSync(p),
      worktreeIsClean: gitWorktreeIsClean(),
      deliverExec: (workdir, intent) => {
        calls += 1;
        return runDeliverScript(workdir, intent, fx.env);
      },
    });
    apps.push(app);
    await app.ready();

    // The wire: completed + stranded, over the real worktree (committed work → not vacuous).
    const before = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(before.run.session['status']).toBe('completed');
    expect(before.run.session['delivery']).toBe('stranded');

    // POST /deliver while the collision still stands refuses LOUDLY (409) — the work is real but
    // the lift still cannot happen; nothing is pushed. (The run is accepted as completed, i.e. the
    // route did not 409 on "run is failed".)
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toContain(DELIVER_LIFT_CONFLICT_MARKER);
    expect(originBranches(fx)).toEqual(['main']);

    // The operator clears the collision on the branch: rebase the run branch onto main and
    // resolve in favour of the run, leaving a single clean commit atop origin/main.
    git(fx.workdir, 'fetch', '-q', 'origin');
    git(fx.workdir, 'reset', '--hard', 'origin/main');
    writeFileSync(join(fx.workdir, 'thing.ts'), 'export const v = 2; // run (rebased)\n');
    git(fx.workdir, 'add', '-A');
    git(fx.workdir, 'commit', '-qm', 'run change (resolved)');

    const lifted = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(lifted.statusCode).toBe(200);
    expect((lifted.json() as { prUrl: string }).prUrl).toBe('https://github.com/o/r/pull/71');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(calls).toBe(2);

    // And the wire now reads delivered.
    const after = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(after.run.session['delivery']).toBe('delivered');
    expect(after.run.session['deliverUrl']).toBe('https://github.com/o/r/pull/71');
  }, 90_000);

  it('a REAL push 403 reaches the failed run wire as stranded and POST /deliver retries after repair (crew#432)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'auth-retry.ts'), 'export const retried = true;\n');
    git(fx.workdir, 'add', '--', 'auth-retry.ts');
    const hook = join(fx.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "remote: HTTP 403 authentication failed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    const first = await runDeliverScript(fx.workdir, 'auth retry', fx.env);
    expect(first.status).not.toBe(0);
    expect(first.output).toContain('HTTP 403 authentication failed');
    expect(first.output).toContain(DELIVER_LIFT_CONFLICT_MARKER);
    expect(originBranches(fx)).toEqual(['main']);

    const units = [
      unit({ id: `${RUN_ID}:build`, ord: 3, status: 'done' }),
      unit({
        id: `${RUN_ID}:deliver`,
        ord: 5,
        status: 'rejected',
        denial_reason: `Worker FAILED on unit 5: ${first.output.slice(-400)}`,
        tool_cmd: ['bash', '-lc', 'gh pr create --head "$B" --fill'],
      }),
    ];
    const app = buildApp([view({ status: 'failed', workdir: fx.workdir, units })], {
      worktreeExists: (p) => existsSync(p),
      worktreeIsClean: gitWorktreeIsClean(),
      deliverExec: (workdir, intent) => runDeliverScript(workdir, intent, fx.env),
    });
    apps.push(app);
    await app.ready();

    const stranded = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown>; units: WorkUnit[] };
    };
    expect(stranded.run.session['status']).toBe('completed');
    expect(stranded.run.session['delivery']).toBe('stranded');
    const deliver = stranded.run.units.find((u) => u.id.endsWith(':deliver'))!;
    expect(deliver.denial_reason).toContain('HTTP 403 authentication failed');

    rmSync(hook);
    const retried = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as { prUrl: string }).prUrl).toBe('https://github.com/o/r/pull/71');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 90_000);
});
