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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { runDeliverScript } from '../src/api/post-hoc-deliver.js';
import { deliverTextAllowed } from '../src/core/deliver-grants.js';
import { RetryIndex } from '../src/api/retry-index.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

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
      '  api) case "$2" in repos/*/rules/branches/*) printf "%s" "${GH_STUB_RULES:-[]}";; repos/*/branches/*) echo "{}";; *) echo "tester";; esac;;',
      '  auth) echo "gh: switched account";;',
      '  run) printf "%s\\n" "${GH_STUB_LOG:-}";;',
      '  pr)',
      '    case "$2" in checks) printf "%s" "${GH_STUB_CHECKS:-[]}"; exit 0;; view) echo main; exit 0;; esac',
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
  /** Records every `audit.record(...)` call (CS11: lets a test read the `run.delivered` detail). */
  recordSpy: ReturnType<typeof vi.spyOn>;
}

/** A route set whose deliverExec is the REAL script spawn, aimed at the fixture's HOME. `repoRoot`
 *  (CS11) wires `listRepos` so the route's `repoRootOf` resolves — the post-hoc delivered-commit
 *  read needs the registered repo root to find the run branch's `refs/heads/wicked/<id>`. */
function buildApp(views: SessionView[], env: Record<string, string>, repoRoot?: string): App {
  let calls = 0;
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    ...(repoRoot !== undefined
      ? { listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo-1', root_path: repoRoot, registered_at: 1 }]) }
      : {}),
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  // CS11: a noop trail (writes nothing) spied so a test can read the `run.delivered` detail the
  // route recorded — the spy captures the call args even though the underlying record is a no-op.
  const audit = AuditLog.noop();
  const recordSpy = vi.spyOn(audit, 'record');
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
    withRunViews(mockAdapter),
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'off' },
    {
      deliveryIndex: new DeliveryIndex(),
      deliverExec: (workdir, intent) => {
        calls += 1;
        return runDeliverScript(workdir, intent, undefined, env);
      },
    },
  );
  return { app, execCalls: () => calls, recordSpy };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) removeScratch(r);
});

describe('POST /runs/:id/deliver — post-hoc delivery, driven for real (crew#393)', () => {
  it('SUCCESS: lifts the stranded work, answers {prUrl}, and the wire flips to delivered', async () => {
    const fx = fixture();
    // What a completed run left behind: files written, nothing committed, no PR.
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const { app, recordSpy } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], fx.env, fx.clone);
    apps.push(app);
    await app.ready();

    // Before: the wire says stranded — reviewable work, no PR.
    const before = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(before.run.session['delivery']).toBe('stranded');

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(200);
    // wicked-core#850 EX-04: a post-hoc lift answers how it was assured — never verified, both trees named.
    expect(res.json()).toEqual({
      prUrl: 'https://github.com/o/r/pull/42',
      assurance: expect.objectContaining({ verified: false, via: 'post_hoc', treeBefore: expect.stringMatching(/^[0-9a-f]{40}$/), treeAfter: expect.stringMatching(/^[0-9a-f]{40}$/) }),
    });

    // The commit exists on the LOCAL origin's run branch — the lift is real, not asserted.
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');

    // And the run wire now says so.
    const after = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(after.run.session['delivery']).toBe('delivered');
    expect(after.run.session['deliverUrl']).toBe('https://github.com/o/r/pull/42');

    // CS11 (cs11-b review P2/tests): the PRODUCTION route — not a test copy — recorded the run
    // branch's delivered HEAD onto the `run.delivered` detail, read through its own wiring.
    const headSha = git(fx.origin, 'rev-parse', `wicked/${RUN_ID}`).trim();
    expect(recordSpy).toHaveBeenCalledWith(
      'run.delivered',
      expect.anything(),
      expect.objectContaining({ runId: RUN_ID, detail: expect.objectContaining({ commit: headSha }) }),
    );
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

  it('crew#1623: a red required check on a post-hoc lift is a 409 naming the check and its link, with NO log text, secret or home path', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    // Synthetic values, assembled at run time.
    const secret = ['wJalr', 'XUtn1-post-hoc'].join('');
    const home = ['', 'Users', 'alice', 'work'].join('/');
    const job = 'https://github.com/o/r/actions/runs/1/job/22';
    const env = {
      ...fx.env,
      GH_STUB_RULES: JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'semver' }] } }]),
      GH_STUB_CHECKS: JSON.stringify([{ name: 'semver', bucket: 'fail', link: job, workflow: 'CI' }]),
      GH_STUB_LOG: `aws_secret_access_key = ${secret}\ncwd ${home}`,
    };
    const { app } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(res.statusCode).toBe(409);
    const body = (res.json() as { error: string }).error;
    expect(body).toContain('PR CHECKS FAILING');
    expect(body).toContain('CI / semver');
    expect(body).toContain(job);
    expect(body).not.toContain(secret);
    expect(body).not.toContain('alice');
    expect(body).not.toContain('aws_secret_access_key');
  }, 60_000);

  it('N1: a NON-GITHUB origin — the branch is pushed, the run reads pushed (never stranded), and a second call pushes nothing', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const env = {
      ...fx.env,
      GH_STUB_FAIL:
        'none of the git remotes configured for this repository point to a known GitHub host. Use `gh auth login` to authenticate with a host',
    };
    const { app, execCalls } = buildApp([view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })], env);
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    // No PR URL exists to answer with, so it is not a 200 {prUrl} — but the push DID happen.
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('delivered as a pushed branch');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);

    const after = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(after.run.session['delivery']).toBe('pushed');
    expect(after.run.session['deliverBranch']).toBe(`wicked/${RUN_ID}`);
    expect(after.run.session['deliverRemote']).toBe(fx.origin);
    expect('deliverUrl' in after.run.session).toBe(false);

    // Nothing is left to lift: the route says so and never runs the script again.
    const again = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(again.statusCode).toBe(409);
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
    removeScratch(fx.workdir);
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
      withRunViews(mockAdapter),
      new GateCache(),
      new ElicitationCache(),
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

// R1 (Copilot on crew#736): the post-hoc delivery binds `gh pr create --repo` to origin's GitHub
// repository like the gated one — the route reads the worktree's push URL and hands it on.
describe('POST /runs/:id/deliver — the post-hoc delivery carries the origin it pushes to (R1)', () => {
  it('passes the worktree\'s push URL as originUrl, so the script can bind --repo and check drift', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    execFileSync('git', ['config', 'remote.origin.pushurl', 'https://github.com/acme/widgets.git'], { cwd: fx.workdir });
    const seen: Array<string | null | undefined> = [];
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => [view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })]),
      sessions: vi.fn(async () => [RUN_ID]),
    } as unknown as CoreAdapter;
    const app = Fastify({ logger: false });
    registerRoutes(
      app,
      withRunViews(mockAdapter),
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      {
        deliveryIndex: new DeliveryIndex(),
        deliverExec: async (_workdir, _intent, opts) => {
          seen.push(opts?.originUrl);
          return { status: 1, output: 'deliver: stub stops here' };
        },
      },
    );
    apps.push(app);
    await app.ready();
    await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });
    expect(seen).toEqual(['https://github.com/acme/widgets.git']);
  });
});

// ── DES-L9 / crew#550 — a stranded REVISION re-pushes onto its PR's branch, never a new PR ────────
//
// The run revised PR #273 (its worktree was cut from `origin/wicked/prior-run`), committed its work,
// and the push failed (the strand). Post-hoc, the daemon re-checks the PR is still OPEN through the
// same resolver the launch used and hands the script the revision target: the PR branch gains
// exactly the run's commit, no `wicked/<run>` branch appears on origin, and the answer is the PR's
// URL. A PR that closed meanwhile is a named 409 — nothing pushed.
describe('POST /runs/:id/deliver — a stranded REVISION re-pushes onto the PR branch (DES-L9)', () => {
  const PR_BRANCH = 'wicked/prior-run';
  const PR_URL = 'https://github.com/o/r/pull/273';

  /** The revision fixture: a PR branch on origin, the run worktree cut FROM it with one committed
   *  change of its own (the strand shape), and a stub gh that answers `pr view` / `pr comment`. */
  function revisionFixture(): Fixture & { prHead: string } {
    const fx = fixture();
    const other = join(fx.root, 'other');
    execFileSync('git', ['clone', '-q', fx.origin, other]);
    git(other, 'config', 'user.email', 'prior@test');
    git(other, 'config', 'user.name', 'prior');
    git(other, 'checkout', '-q', '-b', PR_BRANCH);
    writeFileSync(join(other, 'pr.txt'), 'the prior run\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'fix: the prior run');
    git(other, 'push', '-q', 'origin', PR_BRANCH);
    const prHead = git(other, 'rev-parse', 'HEAD').trim();
    // Re-cut the run worktree from the PR head (what the engine's `base_ref` mint does), with the
    // run's own committed change on top and nothing pushed.
    git(fx.clone, 'worktree', 'remove', '--force', fx.workdir);
    git(fx.clone, 'branch', '-D', `wicked/${RUN_ID}`);
    git(fx.clone, 'fetch', '-q', 'origin');
    git(fx.clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, fx.workdir, `origin/${PR_BRANCH}`);
    writeFileSync(join(fx.workdir, 'pr.txt'), 'the prior run\nrevised after review\n');
    git(fx.workdir, 'add', '-A');
    git(fx.workdir, 'commit', '-qm', 'fix: revised after review');
    writeFileSync(
      join(fx.root, 'bin', 'gh'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  api) case "$2" in repos/*/rules/branches/*) echo "[]";; repos/*/branches/*) echo "{}";; *) echo "tester";; esac;;',
        '  pr) case "$2" in checks) echo "[]";; view) case " $* " in *" baseRefName "*) echo main;; *) echo "OPEN";; esac;; comment) echo "commented";; *) echo "gh: unexpected $*" >&2; exit 2;; esac;;',
        '  *) echo "gh: unexpected $*" >&2; exit 2;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(fx.root, 'bin', 'gh'), 0o755);
    return { ...fx, prHead };
  }

  function buildRevisionApp(fx: Fixture, resolve: NonNullable<RuntimeDeps['resolvePullRequest']>, exec?: RuntimeDeps['deliverExec']): FastifyInstance {
    const retryIndex = new RetryIndex();
    retryIndex.setRevisesPr(RUN_ID, { number: 273, headRef: PR_BRANCH, url: PR_URL });
    const views = [view(RUN_ID, { repo_ref: 'repo-1', workdir: fx.workdir })];
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => views),
      sessions: vi.fn(async () => [RUN_ID]),
      listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo-1', root_path: fx.clone, registered_at: 1 }]),
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
      withRunViews(mockAdapter),
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      {
        deliveryIndex: new DeliveryIndex(),
        retryIndex,
        resolvePullRequest: resolve,
        // The revision target rides `opts` — this harness passes it through (the crew#393 one drops it).
        deliverExec: exec ?? ((workdir, intent, opts) => runDeliverScript(workdir, intent, opts, fx.env)),
      },
    );
    return app;
  }

  // crew#1885: no unit carries a post-hoc delivery's script, so its nonce is registered for the run while the daemon runs
  // it: that is the script's credential for its run's PR text (`POST /deliver/text`), under required auth too.
  it('crew#1885: the post-hoc script reads its run record with a nonce registered only while it runs', async () => {
    const fx = revisionFixture();
    const seen: Array<{ run: string; allowed: boolean }> = [];
    const daemon = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { run: string; nonce: string };
        const run = decodeURIComponent(body.run);
        // What crew's route asks: no unit of this run declares the nonce, so only the post-hoc grant can allow it.
        const allowed = deliverTextAllowed(run, [], body.nonce);
        seen.push({ run, allowed });
        res.writeHead(allowed ? 200 : 403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(allowed ? 'fix: the title only the run record has\n\n## Intent\n\nfrom the record\n' : 'refused');
      });
    });
    await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
    const addr = daemon.address() as AddressInfo;
    const origin = `http://127.0.0.1:${addr.port}`;
    const nonce = 'abcdef0123456789abcdef0123456789';
    try {
      const app = buildRevisionApp(fx, async () => ({ ok: true, pr: { number: 273, headRef: PR_BRANCH, url: PR_URL, state: 'OPEN' } }), (workdir, intent, opts) =>
        runDeliverScript(workdir, intent, { ...opts, apiOrigin: origin, nonce }, fx.env));
      apps.push(app);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });

      expect(res.statusCode, res.body).toBe(200);
      // The script asked once, for this run, and was allowed while it ran (the revision's work was committed by the
      // run, so its commit keeps the run's own subject; the text rides the PR comment).
      expect(seen).toEqual([{ run: RUN_ID, allowed: true }]);
      // Released once the script exited: the same nonce no longer reads the text.
      expect(deliverTextAllowed(RUN_ID, [], nonce)).toBe(false);
    } finally {
      await new Promise<void>((r) => daemon.close(() => r()));
    }
  }, 60_000);

  it('re-checks the PR is OPEN, pushes exactly the run’s commit onto its branch, answers the PR URL — no new PR', async () => {
    const fx = revisionFixture();
    const app = buildRevisionApp(fx, async () => ({ ok: true, pr: { number: 273, headRef: PR_BRANCH, url: PR_URL, state: 'OPEN' } }));
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ prUrl: PR_URL, assurance: expect.objectContaining({ verified: false, via: 'post_hoc' }) }); // EX-04
    expect(git(fx.origin, 'rev-list', '--count', `${fx.prHead}..${PR_BRANCH}`).trim()).toBe('1');
    expect(git(fx.origin, 'log', '-1', '--format=%s', PR_BRANCH).trim()).toBe('fix: revised after review');
    expect(originBranches(fx).sort()).toEqual(['main', PR_BRANCH].sort());
    // …and the wire now reads delivered at the PR's URL.
    const one = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(one.run.session['delivery']).toBe('delivered');
    expect(one.run.session['deliverUrl']).toBe(PR_URL);
  }, 60_000);

  it('409 by name when the PR closed meanwhile — nothing pushed, the strand stays', async () => {
    const fx = revisionFixture();
    const app = buildRevisionApp(fx, async () => ({ ok: false, error: 'revisesPr #273 is MERGED — only an open pull request can be revised' }));
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN_ID}/deliver` });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'revisesPr #273 is MERGED — only an open pull request can be revised' });
    expect(git(fx.origin, 'rev-parse', PR_BRANCH).trim()).toBe(fx.prHead);
    expect(originBranches(fx).sort()).toEqual(['main', PR_BRANCH].sort());
  }, 60_000);
});
