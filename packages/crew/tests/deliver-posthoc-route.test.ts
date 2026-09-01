// crew#393 — POST /runs/:id/deliver DRIVEN FOR REAL: the post-hoc lift of a stranded run's
// worktree into a PR, against temp git repos (a bare LOCAL origin standing in for GitHub) and a
// fake `gh` — the same fixture discipline as deliver-script-exec.test.ts, because the route runs
// the SAME hardened script (`core/deliver.ts`) through the daemon's own spawn seam.
//
// What must hold, and what these tests pin:
//   SUCCESS   — a completed repo-scoped run with uncommitted work answers 200 {prUrl}; the
//               commit lands on the LOCAL origin's run branch, and the run's wire flips to
//               delivery:'delivered' + deliverUrl on the very next GET.
//   IDEMPOTENT— a second POST answers the SAME prUrl WITHOUT running the script again (the
//               exec-call count stays at 1): a double-click can never double-open a PR.
//   CONFLICT  — a rebase conflict is a loud 409 carrying the script's own words, with NOTHING
//               pushed to the origin; the run stays recoverable (delivery:'stranded').
//   GUARDS    — 404 unknown run; 409 not-completed / repo-less / worktree-gone / nothing to
//               deliver. Never a silent success.
//
// NEVER creates a real GitHub PR: `gh` is a stub script on a PATH the fixture controls (the
// spawn's HOME points at a temp dir whose .bash_profile prepends the stub bin — sourced after
// /etc/profile's path_helper, so the prepend survives the login shell), and every push targets
// a file-backed bare repo.

import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { runDeliverScript } from '../src/api/post-hoc-deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const RUN_ID = '83052f0b-96a8-4a99-ad2a-c84b75111ff0';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. The explicit
 * env spread keeps the setup's hermetic arming (harness-hygiene scan; identical to inheriting). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

interface Fixture {
  /** The stranded run worktree (basename === RUN_ID, branch wicked/<RUN_ID>). */
  workdir: string;
  clone: string;
  /** The bare repo standing in for GitHub. */
  origin: string;
  root: string;
  /** The env the deliver spawn gets: temp HOME (stub `gh` on PATH), no operator GH_ACCOUNT. */
  env: Record<string, string>;
}

const roots: string[] = [];

/** A bare origin + a clone on `main` + a run worktree on `wicked/<RUN_ID>` — the exact shape a
 *  completed repo-scoped run leaves behind — plus the stub `gh` HOME. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'crew-posthoc-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), 'base\n');
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

  // The stub gh + the temp HOME whose .bash_profile makes it win inside `bash -lc`.
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
      '  pr)',
      '    if [ -n "${GH_STUB_FAIL:-}" ]; then echo "$GH_STUB_FAIL" >&2; exit 1; fi',
      '    echo "${GH_STUB_OUT:-https://github.com/o/r/pull/42}";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);

  return { workdir, clone, origin, root, env: { HOME: home, GH_ACCOUNT: '' } };
}

/** The branches the bare origin actually holds. */
function originBranches(fx: Fixture): string[] {
  return git(fx.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function view(
  id: string,
  over: { status?: string; repo_ref?: string | null; workdir?: string | null } = {},
): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'fix the attention-reason regression (#352)',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: over.workdir ?? null,
      repo_ref: over.repo_ref ?? null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

interface App {
  app: FastifyInstance;
  execCalls: () => number;
}

/** A route set whose deliverExec is the REAL script spawn, aimed at the fixture's HOME. */
function buildApp(views: SessionView[], env: Record<string, string>): App {
  let calls = 0;
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
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
    mockAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex: new DeliveryIndex(),
      deliverExec: (workdir, intent) => {
        calls += 1;
        return runDeliverScript(workdir, intent, env);
      },
    },
  );
  return { app, execCalls: () => calls };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('POST /runs/:id/deliver — post-hoc delivery, driven for real (crew#393)', () => {
  it('SUCCESS: lifts the stranded work, answers {prUrl}, and the wire flips to delivered', async () => {
    const fx = fixture();
    // What a completed run left behind: files written, nothing committed, no PR.
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const { app } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], fx.env);
    apps.push(app);
    await app.ready();

    // Before: the wire says stranded — reviewable work, no PR.
    const before = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(before.run.session['delivery']).toBe('stranded');

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prUrl: 'https://github.com/o/r/pull/42' });

    // The commit exists on the LOCAL origin's run branch — the lift is real, not asserted.
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');

    // And the run wire now says so.
    const after = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(after.run.session['delivery']).toBe('delivered');
    expect(after.run.session['deliverUrl']).toBe('https://github.com/o/r/pull/42');
  }, 60_000);

  it('IDEMPOTENT: a second call answers the SAME prUrl without running the script again', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const { app, execCalls } = buildApp(
      [view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })],
      fx.env,
    );
    apps.push(app);
    await app.ready();

    const first = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(first.statusCode).toBe(200);
    const url = (first.json() as { prUrl: string }).prUrl;
    expect(execCalls()).toBe(1);

    const second = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { prUrl: string }).prUrl).toBe(url);
    // The script did NOT run again — no second push, no chance of a second PR.
    expect(execCalls()).toBe(1);
  }, 60_000);

  it('CONFLICT: a rebase conflict is a loud 409 with nothing pushed; the run stays stranded', async () => {
    const fx = fixture();
    // main moves under the stranded run…
    writeFileSync(join(fx.clone, 'README.md'), 'base\nfrom main\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'main moved');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // …and the run's stranded work touches the same line.
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nfrom the run\n');
    const { app } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], fx.env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    const err = (res.json() as { error: string }).error;
    // The script's own words reach the caller — never a silent or generic failure.
    expect(err).toContain('deliver failed');
    expect(err).toContain('conflicts');
    expect(err).toContain('nothing was pushed');
    expect(originBranches(fx)).toEqual(['main']);

    // Still recoverable: the wire keeps saying stranded.
    const after = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(after.run.session['delivery']).toBe('stranded');
  }, 60_000);

  it('NOTHING TO DELIVER: a clean worktree level with main is a loud 409, nothing pushed', async () => {
    const fx = fixture(); // clean worktree, branch level with main
    const { app } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], fx.env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('nothing to deliver');
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('404 for a run that exists nowhere', async () => {
    const fx = fixture();
    const { app } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], fx.env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/no-such-run/deliver' });
    expect(res.statusCode).toBe(404);
  });

  it('409 for a run that is not completed — live work is never lifted out from under itself', async () => {
    const fx = fixture();
    const { app, execCalls } = buildApp(
      [view(RUN_ID, { status: 'executing', repo_ref: 'repo-1', workdir: fx.workdir })],
      fx.env,
    );
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('executing');
    expect(execCalls()).toBe(0);
  });

  it('409 for a repo-less run — there is no worktree to lift', async () => {
    const fx = fixture();
    const { app, execCalls } = buildApp([view(RUN_ID)], fx.env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('not repo-scoped');
    expect(execCalls()).toBe(0);
  });

  it('409 when the worktree is gone — named, not a script crash', async () => {
    const fx = fixture();
    rmSync(fx.workdir, { recursive: true, force: true });
    expect(existsSync(fx.workdir)).toBe(false);
    const { app, execCalls } = buildApp(
      [view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })],
      fx.env,
    );
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('worktree is gone');
    expect(execCalls()).toBe(0);
  });

  it('500 when the script never reached its own verdict (spawn failure / timeout kill) — an infra fault, not a 409 refusal', async () => {
    const fx = fixture();
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => [view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })]),
      sessions: vi.fn(async () => [RUN_ID]),
    } as unknown as CoreAdapter;
    const app = Fastify({ logger: false });
    registerRoutes(
      app,
      mockAdapter,
      new GateCache(),
      new ElicitationCache(),
      new QeGateCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      {
        deliveryIndex: new DeliveryIndex(),
        // What runDeliverScript resolves for a timeout kill or ENOENT: non-zero, marked.
        deliverExec: async () => ({ status: 1, output: 'spawn bash ENOENT', spawnFailure: true }),
      },
    );
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(500);
    const err = (res.json() as { error: string }).error;
    expect(err).toContain('could not run to completion');
    expect(err).toContain('ENOENT');
  });
});
