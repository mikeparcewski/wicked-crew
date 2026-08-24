// crew#317 — the deliver script DRIVEN FOR REAL, against temp git repos and a fake `gh`.
//
// The sibling suite (deliver-phase.test.ts) pins the script's SHAPE. That is not enough for this
// defect: run `d1bc72c2` pushed a branch identical to origin/main and reported success, and every
// string assertion in the world would have passed on the script that did it. What has to be true
// is behavioural — a commit exists, a ref is or is not on the remote, a non-zero status reaches
// the caller — so these tests build a bare origin, clone it, cut a run worktree, and run the real
// `bash -lc <script>` inside it exactly as core's `run_tool_cmd` does.
//
// `gh` is a script on a PATH we control. The script is invoked as a LOGIN shell (`bash -lc`, the
// production invocation), so `/etc/profile` runs and macOS's path_helper reshuffles PATH — a
// pre-set PATH is therefore not enough to win. HOME is pointed at a temp dir whose `.bash_profile`
// prepends the fake bin, which is sourced AFTER path_helper and does win.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverPrScript } from '../src/core/deliver.js';

const RUN_ID = '1bc72c20-0457-425f-b4cb-215a40e68e1e';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

interface Fixture {
  /** The run worktree the script runs in (basename === RUN_ID). */
  workdir: string;
  /** The clone the worktree hangs off. */
  clone: string;
  /** The bare repo standing in for GitHub. */
  origin: string;
  root: string;
}

const roots: string[] = [];

/**
 * A bare origin + a clone on `main` + a run worktree on `wicked/<RUN_ID>` — the exact shape
 * `repo::create_worktree` leaves behind: a branch cut from the base tip with a CLEAN tree.
 */
function fixture(opts: { worktree?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'crew-deliver-'));
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
  // A clone sets origin/HEAD, which is what the script's default-branch derivation reads.
  expect(git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim()).toBe(
    'origin/main',
  );

  if (opts.worktree === false) return { workdir: clone, clone, origin, root };

  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
  return { workdir, clone, origin, root };
}

/** Behaviour knobs the fake `gh` reads out of the environment. */
interface GhStub {
  /** stderr text + exit 1 from `gh pr create`. */
  failWith?: string;
  /** stdout text from a SUCCESSFUL `gh pr create` (default: a PR URL). */
  succeedWith?: string;
  /** `gh api user -q .login` output. */
  login?: string;
}

/**
 * Run the deliver script in `workdir` exactly as core does (`bash -lc <script>`), with a fake
 * `gh` on PATH and a temp HOME. Returns the merged output and exit status.
 */
function runDeliver(
  fx: Fixture,
  opts: { intent?: string; gh?: GhStub; env?: Record<string, string> } = {},
): { status: number; output: string; lastLine: string } {
  const home = join(fx.root, 'home');
  const bin = join(fx.root, 'bin');
  if (!existsSync(bin)) mkdirSync(bin, { recursive: true });
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  // Sourced after /etc/profile's path_helper, so this prepend is the one that survives.
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  // A real `gh` would talk to GitHub; this one reports what the test needs and nothing else.
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  api) echo "${GH_STUB_LOGIN:-tester}";;',
      '  auth) echo "gh: switched account";;',
      '  pr)',
      '    if [ -n "${GH_STUB_FAIL:-}" ]; then echo "$GH_STUB_FAIL" >&2; exit 1; fi',
      '    echo "${GH_STUB_OUT:-https://github.com/o/r/pull/7}";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);

  const res = spawnSync('bash', ['-lc', deliverPrScript(opts.intent)], {
    cwd: fx.workdir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      // The operator's own account guard must not leak into the fixture.
      GH_ACCOUNT: '',
      GH_STUB_FAIL: opts.gh?.failWith ?? '',
      GH_STUB_OUT: opts.gh?.succeedWith ?? '',
      GH_STUB_LOGIN: opts.gh?.login ?? 'tester',
      ...opts.env,
    },
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const lines = output.trimEnd().split('\n');
  return { status: res.status ?? -1, output, lastLine: lines[lines.length - 1] ?? '' };
}

/** The branches the bare origin actually holds. */
function originBranches(fx: Fixture): string[] {
  return git(fx.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('deliver script, driven for real (crew#317)', () => {
  it('COMMITS the run’s uncommitted work, pushes it, and prints the PR URL last', () => {
    const fx = fixture();
    // What an agent leaves behind: files written, nothing committed (core#291's premise).
    writeFileSync(join(fx.workdir, 'attentionReason.ts'), 'export const x = 1;\n');
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');

    const r = runDeliver(fx, { intent: 'add the attention-reason helper' });

    expect(r.status).toBe(0);
    expect(r.lastLine).toBe('https://github.com/o/r/pull/7');
    // The commit exists, on the run branch, on the REMOTE — the thing d1bc72c2 never produced.
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    const subject = git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim();
    expect(subject).toBe(`wicked-crew run ${RUN_ID}: add the attention-reason helper`);
    // Both files rode along, and the worktree is clean afterwards.
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`).trim();
    expect(files.split('\n').sort()).toEqual(['README.md', 'attentionReason.ts']);
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toBe('');
  }, 60_000);

  it('takes the run’s OWN commits when the tree is already clean — no empty commit', () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'done.ts'), 'export const y = 2;\n');
    git(fx.workdir, 'add', '-A');
    git(fx.workdir, 'commit', '-qm', 'feat: the run committed incrementally');

    const r = runDeliver(fx, { intent: 'incremental' });

    expect(r.status).toBe(0);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    expect(git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim()).toBe(
      'feat: the run committed incrementally',
    );
  }, 60_000);

  it('FAILS LOUDLY and pushes NOTHING when the run produced no change', () => {
    const fx = fixture(); // clean worktree, branch level with main — exactly d1bc72c2

    const r = runDeliver(fx, { intent: 'nothing at all' });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain(
      'deliver: nothing to deliver — the run produced no committed change',
    );
    expect(r.output).toContain('nothing was pushed');
    // The empty ref d1bc72c2 left on GitHub must never exist.
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('FAILS the phase with gh’s own message when gh pr create fails', () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // The real message from run d1bc72c2's persisted unit.
    const ghErr =
      'could not compute title or body defaults: could not find any commits between origin/main and wicked/x';

    const r = runDeliver(fx, { gh: { failWith: ghErr } });

    expect(r.status).not.toBe(0);
    // gh's actual words survive — the old `| tail -1` both truncated them and lost the status.
    expect(r.output).toContain(ghErr);
    expect(r.output).toContain('deliver: gh pr create failed');
    expect(r.lastLine).not.toContain('http');
  }, 60_000);

  it('FAILS when gh exits 0 but produces no PR URL — done is re-derived, not asserted', () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');

    const r = runDeliver(fx, { gh: { succeedWith: 'Warning: something odd happened' } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('exited 0 but produced no PR URL');
  }, 60_000);

  it('REFUSES the default branch — a clone on main pushes nothing', () => {
    const fx = fixture({ worktree: false });
    writeFileSync(join(fx.workdir, 'oops.ts'), 'export const w = 4;\n');

    const r = runDeliver(fx);

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('refusing to push branch');
    expect(originBranches(fx)).toEqual(['main']);
    // And it refused BEFORE staging anything.
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toContain('oops.ts');
  }, 60_000);

  it('ABORTS a conflicting rebase, fails visibly, and pushes nothing', () => {
    const fx = fixture();
    // main moves under the run…
    writeFileSync(join(fx.clone, 'README.md'), 'base\nfrom main\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'main moved');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // …and the run touches the same line.
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nfrom the run\n');

    const r = runDeliver(fx);

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('failed (conflicts)');
    expect(r.output).toContain('nothing was pushed');
    expect(originBranches(fx)).toEqual(['main']);
    // The abort left the worktree on the branch tip, not mid-rebase.
    expect(existsSync(join(fx.clone, '.git', 'worktrees', RUN_ID, 'rebase-merge'))).toBe(false);
  }, 60_000);

  it('honours the GH_ACCOUNT guard without baking a name in', () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const q = 5;\n');

    // Same account ⇒ no switch.
    const same = runDeliver(fx, { gh: { login: 'someone' }, env: { GH_ACCOUNT: 'someone' } });
    expect(same.status).toBe(0);
    expect(same.output).not.toContain('switched account');

    // Different account ⇒ the switch runs.
    const fx2 = fixture();
    writeFileSync(join(fx2.workdir, 'work.ts'), 'export const q = 6;\n');
    const other = runDeliver(fx2, { gh: { login: 'someone' }, env: { GH_ACCOUNT: 'other' } });
    expect(other.status).toBe(0);
    expect(other.output).toContain('switched account');
  }, 90_000);
});
