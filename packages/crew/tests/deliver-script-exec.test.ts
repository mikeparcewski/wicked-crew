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

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverPrScript, type DeliverScriptOptions } from '../src/core/deliver.js';
import { composeDeliverText, deliverTitle, factsFromWorkflow, framedDeliverText } from '../src/core/deliver-text.js';

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
 *
 * ASYNC on purpose (crew#524): the stand-in daemon some tests run lives in THIS process, so a
 * synchronous spawn would block the event loop the daemon needs to answer the script's request
 * — the script would wait out curl's timeout and fall back, never having been answered.
 */
async function runDeliver(
  fx: Fixture,
  opts: { intent?: string; gh?: GhStub; env?: Record<string, string>; script?: DeliverScriptOptions } = {},
): Promise<{ status: number; output: string; lastLine: string; pr: PrCreateCall | null }> {
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
      // Record what the PR was opened WITH (crew#524): the title and the body file's content.
      '    T=""; BF=""; while [ $# -gt 0 ]; do case "$1" in --title) T="$2"; shift;; --body-file) BF="$2"; shift;; esac; shift; done',
      '    printf "%s\\n" "$T" > "$GH_STUB_RECORD.title"; if [ -n "$BF" ]; then cp "$BF" "$GH_STUB_RECORD.body"; fi; printf "%s\\n" "$*" > "$GH_STUB_RECORD.argv"',
      '    if [ -n "${GH_STUB_FAIL:-}" ]; then echo "$GH_STUB_FAIL" >&2; exit 1; fi',
      '    echo "${GH_STUB_OUT:-https://github.com/o/r/pull/7}";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);

  const record = join(fx.root, `gh-record-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const res = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'bash',
      ['-lc', deliverPrScript(opts.intent, opts.script)],
      {
        cwd: fx.workdir,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: home,
          GH_STUB_RECORD: record,
          // The operator's own account guard must not leak into the fixture.
          GH_ACCOUNT: '',
          // Nor a verified-base pin (wicked-core#431) — set per test where the pin is under test.
          WICKED_DELIVER_VERIFIED_BASE: '',
          GH_STUB_FAIL: opts.gh?.failWith ?? '',
          GH_STUB_OUT: opts.gh?.succeedWith ?? '',
          GH_STUB_LOGIN: opts.gh?.login ?? 'tester',
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({ status: err === null ? 0 : typeof code === 'number' ? code : -1, stdout, stderr });
      },
    );
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const lines = output.trimEnd().split('\n');
  const pr: PrCreateCall | null = existsSync(`${record}.title`)
    ? {
        title: readFileSync(`${record}.title`, 'utf8').replace(/\n$/, ''),
        body: existsSync(`${record}.body`) ? readFileSync(`${record}.body`, 'utf8') : null,
        argv: readFileSync(`${record}.argv`, 'utf8').replace(/\n$/, ''),
      }
    : null;
  return { status: res.status, output, lastLine: lines[lines.length - 1] ?? '', pr };
}

/** What the fake `gh pr create` was called with. */
interface PrCreateCall {
  title: string;
  /** The `--body-file` content, or null when no body file was passed. */
  body: string | null;
  argv: string;
}

/** A stand-in daemon answering `GET /api/v1/runs/:id/deliver-text` (crew#524). */
async function fakeDaemon(handler: (runId: string) => { status: number; body: string } | null): Promise<{
  origin: string;
  close: () => Promise<void>;
  requests: string[];
}> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const m = /^\/api\/v1\/runs\/([^/]+)\/deliver-text$/.exec(req.url ?? '');
    const answer = m ? handler(decodeURIComponent(m[1]!)) : null;
    if (answer === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"Run not found"}');
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(answer.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
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
  it('COMMITS the run’s uncommitted work — an UNTRACKED new file rides, pushes it, prints the PR URL last', async () => {
    const fx = fixture();
    // An operator/repo `commit.cleanup=strip` would treat the `## …` heading lines of the message
    // as comments — the script commits with `--cleanup=whitespace` so they survive (W3-K1).
    git(fx.clone, 'config', 'commit.cleanup', 'strip');
    // What an agent leaves behind: files written, nothing committed AND nothing staged
    // (core#291's premise). A brand-new source file the agent never `git add`ed MUST still ride —
    // that is the run's product, and crew, not the agent, owns staging it.
    writeFileSync(join(fx.workdir, 'attentionReason.ts'), 'export const x = 1;\n');
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');

    const r = await runDeliver(fx, { intent: 'add the attention-reason helper', script: { runId: RUN_ID } });

    expect(r.status).toBe(0);
    expect(r.lastLine).toBe('https://github.com/o/r/pull/7');
    // The commit exists, on the run branch, on the REMOTE — the thing d1bc72c2 never produced.
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    // The commit subject IS the PR title, composed from the intent (crew#524) — no run-id prefix
    // eating the 72 columns, no `--fill` truncation; the body names the run.
    const subject = git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim();
    expect(subject).toBe('add the attention-reason helper');
    const commitBody = git(fx.origin, 'log', '-1', '--format=%b', `wicked/${RUN_ID}`);
    expect(commitBody).toContain('## Intent');
    expect(commitBody).toContain(`Delivered by [wicked-crew](https://wc.wickedagile.com) run \`${RUN_ID}\`.`);
    // And the PR was opened with that title and a body file, never `--fill`.
    expect(r.pr).not.toBeNull();
    expect(r.pr!.title).toBe('add the attention-reason helper');
    expect(r.pr!.argv).not.toContain('--fill');
    expect(r.pr!.body).toContain('add the attention-reason helper');
    expect(r.pr!.body).toContain(`- Run: \`${RUN_ID}\``);
    // Both files rode along (the untracked new file included), and the worktree is clean after.
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`).trim();
    expect(files.split('\n').sort()).toEqual(['README.md', 'attentionReason.ts']);
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toBe('');
  }, 60_000);

  it('EXCLUDES untracked scratch/key-material and reports each exclusion, while product rides (crew#434)', async () => {
    const fx = fixture();
    // The run's product: a tracked edit and an untracked new source file (neither is scratch).
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    writeFileSync(join(fx.workdir, 'feature.ts'), 'export const feature = 1;\n');
    // The failed-ignore residue the incident (interactive#199/#200) actually leaked. None of it is
    // gitignored here, so only the classifier stands between it and the governed PR:
    writeFileSync(join(fx.workdir, 'bus.db'), 'SQLite format 3\0scratch\n'); // denylisted-name
    writeFileSync(join(fx.workdir, 'socket.path'), '/Users/alice/run/tool.sock\n'); // socket-name
    writeFileSync(join(fx.workdir, 'deploy.key'), 'PRIVATE KEY MATERIAL\n'); // denylisted-name
    writeFileSync(join(fx.workdir, '.envrc'), 'export SECRET=1\n'); // denylisted-name (direnv)
    writeFileSync(join(fx.workdir, 'bus.db-wal'), 'wal frames\n'); // denylisted-name (sidecar)
    writeFileSync(join(fx.workdir, 'SECRETS.PEM'), 'KEY MATERIAL\n'); // denylisted-name (case-insensitive; distinct basename — APFS folds case)
    mkdirSync(join(fx.workdir, 'coverage'));
    writeFileSync(join(fx.workdir, 'coverage', 'lcov.info'), 'TN:\n'); // scratch-dir
    // An oversized (>1 MiB) untracked blob with an unremarkable name — caught by the size cap.
    writeFileSync(join(fx.workdir, 'rec.bin'), Buffer.alloc(1_600_000, 7)); // oversize-1mib

    const r = await runDeliver(fx, { intent: 'ship the feature' });

    expect(r.status).toBe(0);
    // Only the run's product rode; every scratch/key/oversize path stayed out.
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`)
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual(['README.md', 'feature.ts']);
    // A GUARD, NOT A SILENT DROP — each exclusion is named with its reason in the phase output.
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): bus.db');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): deploy.key');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): .envrc');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): bus.db-wal');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): SECRETS.PEM');
    expect(r.output).toContain('deliver: EXCLUDED (socket-name): socket.path');
    expect(r.output).toContain('deliver: EXCLUDED (scratch-dir): coverage/lcov.info');
    expect(r.output).toContain('deliver: EXCLUDED (oversize-1mib): rec.bin');
    // Skipped, never deleted — the excluded files remain untracked in the worktree for the operator.
    const status = git(fx.workdir, 'status', '--porcelain');
    for (const p of ['bus.db', 'socket.path', 'deploy.key', 'coverage/', 'rec.bin']) {
      expect(status).toContain(p);
    }
  }, 60_000);

  it('takes the run’s OWN commits when the tree is already clean — no empty commit', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'done.ts'), 'export const y = 2;\n');
    git(fx.workdir, 'add', '-A');
    git(fx.workdir, 'commit', '-qm', 'feat: the run committed incrementally');

    const r = await runDeliver(fx, { intent: 'incremental' });

    expect(r.status).toBe(0);
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    expect(git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim()).toBe(
      'feat: the run committed incrementally',
    );
  }, 60_000);

  it('FAILS LOUDLY and pushes NOTHING when the run produced no change', async () => {
    const fx = fixture(); // clean worktree, branch level with main — exactly d1bc72c2

    const r = await runDeliver(fx, { intent: 'nothing at all' });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain(
      'deliver: nothing to deliver — the run produced no committed change',
    );
    expect(r.output).toContain('nothing was pushed');
    // The empty ref d1bc72c2 left on GitHub must never exist.
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('FAILS the phase with gh’s own message when gh pr create fails', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // The real message from run d1bc72c2's persisted unit.
    const ghErr =
      'could not compute title or body defaults: could not find any commits between origin/main and wicked/x';

    const r = await runDeliver(fx, { gh: { failWith: ghErr } });

    expect(r.status).not.toBe(0);
    // gh's actual words survive — the old `| tail -1` both truncated them and lost the status.
    expect(r.output).toContain(ghErr);
    expect(r.output).toContain('deliver: gh pr create failed');
    expect(r.lastLine).not.toContain('http');
  }, 60_000);

  it('STRANDS a failed push with git’s error intact, then succeeds after the remote is repaired (crew#432)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const preserved = true;\n');
    git(fx.workdir, 'add', '--', 'work.ts');
    // A server-side rejection exercises the push path after fetch/rebase/commit without relying
    // on the test host’s network. Its output stands in for GitHub's auth-403/transport text.
    const hook = join(fx.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "remote: HTTP 403 authentication failed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    const failed = await runDeliver(fx);

    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('HTTP 403 authentication failed');
    expect(failed.output).toContain('deliver: LIFT-CONFLICT');
    // The marker is last so core retains it in the run-unit denial tail and exposes the strand.
    expect(failed.lastLine).toContain('deliver: LIFT-CONFLICT');
    expect(originBranches(fx)).toEqual(['main']);
    // The committed work remains on the local run branch, ready for post-hoc delivery.
    expect(git(fx.workdir, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    expect(existsSync(fx.workdir)).toBe(true);
    expect(existsSync(join(fx.workdir, '.wicked-crew-delivery-stranded'))).toBe(true);

    rmSync(hook);
    const retried = await runDeliver(fx);
    expect(retried.status).toBe(0);
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(existsSync(join(fx.workdir, '.wicked-crew-delivery-stranded'))).toBe(false);
  }, 60_000);

  it('FAILS when gh exits 0 but produces no PR URL — done is re-derived, not asserted', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');

    const r = await runDeliver(fx, { gh: { succeedWith: 'Warning: something odd happened' } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('exited 0 but produced no PR URL');
  }, 60_000);

  it('REFUSES the default branch — a clone on main pushes nothing', async () => {
    const fx = fixture({ worktree: false });
    writeFileSync(join(fx.workdir, 'oops.ts'), 'export const w = 4;\n');

    const r = await runDeliver(fx);

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('refusing to push branch');
    expect(originBranches(fx)).toEqual(['main']);
    // And it refused BEFORE staging anything.
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toContain('oops.ts');
  }, 60_000);

  it('ABORTS a NON-changelog rebase conflict as a LIFT-CONFLICT, pushes nothing, keeps the work (crew#418 A)', async () => {
    const fx = fixture();
    // main moves under the run…
    writeFileSync(join(fx.clone, 'README.md'), 'base\nfrom main\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'main moved');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // …and the run touches the same line.
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nfrom the run\n');

    const r = await runDeliver(fx);

    expect(r.status).not.toBe(0);
    // The refusal is the crew#418 LIFT-CONFLICT marker — the exact substring crew keys the
    // "stranded, recoverable" reinterpretation on — and it guarantees nothing was pushed.
    expect(r.output).toContain('deliver: LIFT-CONFLICT');
    expect(r.output).toContain('nothing was pushed');
    // The marker is the LAST line of the transcript, so it survives core's head+tail denial_reason
    // excerpt (the tail is where a step's operative line lives).
    expect(r.output.trimEnd().split('\n').pop()).toContain('deliver: LIFT-CONFLICT');
    expect(originBranches(fx)).toEqual(['main']);
    // The abort left the worktree on the branch tip, not mid-rebase…
    expect(existsSync(join(fx.clone, '.git', 'worktrees', RUN_ID, 'rebase-merge'))).toBe(false);
    // …and the run's WORK is intact and committed on its branch, ready for a post-hoc lift.
    expect(git(fx.workdir, 'show', `wicked/${RUN_ID}:README.md`)).toContain('from the run');
  }, 60_000);

  it('UNION-MERGES a CHANGELOG-only rebase conflict and delivers — the collision no longer strands (crew#418 B)', async () => {
    const fx = fixture();
    // A shared ancestor that already carries CHANGELOG [Unreleased] — the real shape (the file
    // exists; both runs modify it) rather than an add/add.
    const base = '## [Unreleased]\n\n### Changed\n- base line\n';
    writeFileSync(join(fx.clone, 'CHANGELOG.md'), base);
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'add changelog');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // Rebase the run branch onto that shared ancestor so its base has the same CHANGELOG=base.
    git(fx.workdir, 'fetch', '-q', 'origin');
    git(fx.workdir, 'reset', '--hard', 'origin/main');
    // main then lands run ONE's bullet (its PR merged first)…
    writeFileSync(join(fx.clone, 'CHANGELOG.md'), base + '- run ONE change (#416)\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'run one');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // …and the run adds its OWN bullet to the SAME section — a rebase conflict by construction.
    writeFileSync(join(fx.workdir, 'CHANGELOG.md'), base + '- run TWO change (#411)\n');

    const r = await runDeliver(fx);

    // It DELIVERS — the union merge kept both additive lines, the rebase continued, the PR opened.
    expect(r.status).toBe(0);
    expect(r.output).not.toContain('LIFT-CONFLICT');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    const delivered = git(fx.origin, 'show', `wicked/${RUN_ID}:CHANGELOG.md`);
    expect(delivered).toContain('run ONE change (#416)');
    expect(delivered).toContain('run TWO change (#411)');
  }, 60_000);

  it('STRANDS a CHANGELOG conflict that reaches a RELEASED section — the union is [Unreleased]-only (crew#418 review)', async () => {
    const fx = fixture();
    // A changelog with an Unreleased section AND a released one. Both runs diverge in the
    // RELEASED [0.5.0] section (not additive-in-Unreleased) — a genuine conflict the union must
    // NOT silently combine.
    const base =
      '## [Unreleased]\n\n### Changed\n- base line\n\n## [0.5.0]\n\n### Fixed\n- shared released line\n';
    writeFileSync(join(fx.clone, 'CHANGELOG.md'), base);
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'add changelog');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    git(fx.workdir, 'fetch', '-q', 'origin');
    git(fx.workdir, 'reset', '--hard', 'origin/main');
    // main edits the RELEASED line…
    writeFileSync(
      join(fx.clone, 'CHANGELOG.md'),
      base.replace('- shared released line', '- shared released line, edited by run ONE'),
    );
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'run one edits released');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // …and the run edits the SAME released line differently — a real conflict outside [Unreleased].
    writeFileSync(
      join(fx.workdir, 'CHANGELOG.md'),
      base.replace('- shared released line', '- shared released line, edited by run TWO'),
    );

    const r = await runDeliver(fx);

    // It STRANDS loudly — the union is refused because the divergence is outside [Unreleased];
    // nothing was pushed, no branch created.
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('LIFT-CONFLICT');
    expect(originBranches(fx)).not.toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  it('honours the GH_ACCOUNT guard without baking a name in', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const q = 5;\n');

    // Same account ⇒ no switch.
    const same = await runDeliver(fx, { gh: { login: 'someone' }, env: { GH_ACCOUNT: 'someone' } });
    expect(same.status).toBe(0);
    expect(same.output).not.toContain('switched account');

    // Different account ⇒ the switch runs.
    const fx2 = fixture();
    writeFileSync(join(fx2.workdir, 'work.ts'), 'export const q = 6;\n');
    const other = await runDeliver(fx2, { gh: { login: 'someone' }, env: { GH_ACCOUNT: 'other' } });
    expect(other.status).toBe(0);
    expect(other.output).toContain('switched account');
  }, 90_000);
});

// crew#524 / F-3R2-014 — the PR title + body and the commit message come from the RUN, driven for
// real: a stand-in daemon answers `GET /api/v1/runs/:id/deliver-text`, the script uses that text;
// when no daemon answers, the launch-time text embedded in the script is used and the output says so.
describe('deliver script — composed PR text (crew#524)', () => {
  const INTENT =
    'Found by the seed-surfaces suite (wicked-studio#211, scenario CLN-2) against a disposable wicked-crew 0.7.25 daemon.\n\n' +
    '**Observed:** the archive controls never render.\n\nfix issue #214';
  const daemons: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close();
  });

  it('opens the PR with the RUN-DERIVED text the daemon answers, and commits the same text', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const runText = framedDeliverText({
      title: 'Archive/Restore reachable from the project shell',
      body: '## Intent\n\nfix issue #214\n\nFixes #214\n\n## Repo checks\n\n| check | command | exit | duration |\n|---|---|---|---|\n| test | `npm run test` | 0 | 79.2s |\n',
    });
    const daemon = await fakeDaemon((id) => (id === RUN_ID ? { status: 200, body: runText } : null));
    daemons.push(daemon);

    const r = await runDeliver(fx, { intent: INTENT, script: { runId: RUN_ID, apiOrigin: daemon.origin } });

    expect(r.status).toBe(0);
    expect(r.lastLine).toBe('https://github.com/o/r/pull/7');
    // The script asked THIS daemon for THIS run's text, exactly once, by the run id from the branch.
    expect(daemon.requests).toEqual([`GET /api/v1/runs/${RUN_ID}/deliver-text`]);
    expect(r.output).toContain(`deliver: PR text composed from the run record (${daemon.origin})`);
    // …and opened the PR with it: title from line 1, body from line 3 on — the checks table included.
    expect(r.pr!.title).toBe('Archive/Restore reachable from the project shell');
    expect(r.pr!.body).toContain('Fixes #214');
    expect(r.pr!.body).toContain('| test | `npm run test` | 0 | 79.2s |');
    expect(r.pr!.body!.startsWith('## Intent')).toBe(true);
    expect(r.pr!.argv).not.toContain('--fill');
    // The commit message is the same text: subject = title, body = the PR body.
    expect(git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim()).toBe(
      'Archive/Restore reachable from the project shell',
    );
    expect(git(fx.origin, 'log', '-1', '--format=%b', `wicked/${RUN_ID}`)).toContain('Fixes #214');
  }, 60_000);

  it('falls back to the launch-time text — and SAYS so — when the daemon does not know the run', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const daemon = await fakeDaemon(() => null); // 404 for every run
    daemons.push(daemon);
    const facts = factsFromWorkflow({
      runId: RUN_ID,
      intent: INTENT,
      workflowId: 'bug',
      repoRef: 'wicked-studio',
      phases: [],
      runUrl: `${daemon.origin}/runs/${RUN_ID}`,
    });

    const r = await runDeliver(fx, { intent: INTENT, script: { runId: RUN_ID, apiOrigin: daemon.origin, facts } });

    expect(r.status).toBe(0);
    expect(daemon.requests).toHaveLength(1);
    expect(r.output).toContain(`deliver: the daemon at ${daemon.origin} did not answer with the run record — using the launch-time PR text`);
    const expected = composeDeliverText(facts);
    expect(r.pr!.title).toBe(expected.title);
    expect(r.pr!.title).toBe(deliverTitle(INTENT, RUN_ID));
    expect(r.pr!.title.length).toBeLessThanOrEqual(72);
    expect(r.pr!.title.endsWith('…')).toBe(true); // word-boundary cut, never `…aga`
    expect(r.pr!.body).toBe(`${expected.body}\n`);
    expect(r.pr!.body).toContain('Fixes #214');
    expect(r.pr!.body).toContain('Refs: #211'); // `wicked-studio#211` on a wicked-studio delivery (W3-K2)
    expect(r.pr!.body).toContain(`- Run: [\`${RUN_ID}\`](${daemon.origin}/runs/${RUN_ID})`);
    expect(r.pr!.body).toContain('workflow `bug` · repo `wicked-studio`');
    expect(r.pr!.body).toContain('Not available at composition time');
    expect(git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim()).toBe(expected.title);
  }, 60_000);

  it('REJECTS a 200 that is not framed as title / blank / body and falls back, saying so (Copilot on #525)', async () => {
    for (const bogus of ['{"error":"stale endpoint"}\n', 'title only\n', 'title\nno blank line\nbody\n', 'title\n\n\n   \n']) {
      const fx = fixture();
      writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
      const daemon = await fakeDaemon(() => ({ status: 200, body: bogus }));
      daemons.push(daemon);

      const r = await runDeliver(fx, { intent: 'ship it', script: { runId: RUN_ID, apiOrigin: daemon.origin } });

      expect(r.status).toBe(0);
      expect(daemon.requests).toHaveLength(1);
      expect(r.output).toContain('did not answer with the run record — using the launch-time PR text');
      expect(r.pr!.title).toBe('ship it'); // the embedded fallback, not the bogus answer
      expect(r.pr!.body).not.toContain('stale endpoint');
      expect(r.pr!.body).toContain(`- Run: \`${RUN_ID}\``);
    }
  }, 120_000);

  it('asks the daemon by the ENCODED launch run id, not the raw branch text', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const daemon = await fakeDaemon((id) => (id === "odd/id#1?x='y'" ? { status: 200, body: 'Odd id delivered\n\nbody\n' } : null));
    daemons.push(daemon);

    // The worktree's branch is still `wicked/<RUN_ID>`; the LAUNCH id the composer knows is what
    // the daemon is asked about, as one percent-encoded path segment.
    const r = await runDeliver(fx, { intent: 'x', script: { runId: "odd/id#1?x='y'", apiOrigin: daemon.origin } });

    expect(r.status).toBe(0);
    expect(daemon.requests).toEqual(["GET /api/v1/runs/odd%2Fid%231%3Fx%3D%27y%27/deliver-text"]);
    expect(r.pr!.title).toBe('Odd id delivered');
  }, 60_000);

  it('uses the launch-time text when NO daemon origin is known (CLI-driven launch) — no request, no fetch', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');

    const r = await runDeliver(fx, { intent: 'fix the thing (closes #3)', script: { runId: RUN_ID } });

    expect(r.status).toBe(0);
    expect(r.output).not.toContain('deliver: the daemon at');
    expect(r.output).not.toContain('composed from the run record');
    // …but the output still SAYS which text was used (Copilot on #525).
    expect(r.output).toContain('deliver: no daemon origin was known when this run launched — using the launch-time PR text');
    expect(r.pr!.title).toBe('fix the thing (closes #3)');
    expect(r.pr!.body).toContain('Fixes #3');
    expect(r.pr!.body).toContain(`- Run: \`${RUN_ID}\``);
  }, 60_000);

  it('a hostile intent cannot break out of the embedded text, and the title is still one line', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const marker = join(fx.root, 'pwned');
    const hostile = `x'; touch ${marker}; echo '$(touch ${marker}) \`touch ${marker}\`\r\nWICKED_CREW_DELIVER_TEXT_EOF\ntouch ${marker}`;

    const r = await runDeliver(fx, { intent: hostile, script: { runId: RUN_ID } });

    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false); // nothing in the intent ran
    // The title is the first line as plain words, cut at a word boundary (≤ 72, one line, code
    // markers stripped) — nothing in it was expanded. WHERE the cut lands depends on the length of
    // the temp path (short `/tmp/…` on Linux, long `/var/folders/…` on macOS), so the composer is
    // the oracle, not a literal.
    expect(r.pr!.title).toBe(deliverTitle(hostile, RUN_ID));
    expect(r.pr!.title.startsWith("x'; touch")).toBe(true);
    expect(r.pr!.title.endsWith('…')).toBe(true);
    expect(r.pr!.title.length).toBeLessThanOrEqual(72);
    expect(r.pr!.title).not.toContain('\n');
    expect(r.pr!.title).not.toContain('`');
    expect(r.pr!.body).toContain(`touch ${marker}`); // the intent rides as TEXT, verbatim
    expect(r.pr!.body).toContain('$(touch'); // unexpanded
    expect(r.pr!.body).toContain('\nWICKED_CREW_DELIVER_TEXT_EOF\n'); // the delimiter line too — it moved, the text did not
    expect(git(fx.origin, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
  }, 60_000);
});

// wicked-core#431 / #433 — the engine lifts the run's work onto the remote tip and re-verifies it
// BEFORE this script runs, then hands the tip it verified against as WICKED_DELIVER_VERIFIED_BASE.
// The engine's fetch and the script's fetch are two moments; these drive the window for real.
describe('deliver script honours the engine’s verified-base pin (wicked-core#431)', () => {
  it('DELIVERS when WICKED_DELIVER_VERIFIED_BASE names the current remote tip', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const pinned = true;\n');
    const tip = git(fx.clone, 'rev-parse', 'origin/main').trim();

    const r = await runDeliver(fx, { intent: 'pinned base', env: { WICKED_DELIVER_VERIFIED_BASE: tip } });

    expect(r.status).toBe(0);
    expect(r.output).not.toContain('BASE MOVED');
    expect(r.lastLine).toBe('https://github.com/o/r/pull/7');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  it('REFUSES a base that moved since the engine verified — nothing staged, committed or pushed; not a strand', async () => {
    const fx = fixture();
    // What the engine pinned: the remote tip at lift + re-verify time.
    const verified = git(fx.clone, 'rev-parse', 'origin/main').trim();
    // The remote advances in the window between the engine's re-verify and this script's fetch.
    writeFileSync(join(fx.clone, 'README.md'), 'base\nlanded meanwhile\n');
    git(fx.clone, 'add', '-A');
    git(fx.clone, 'commit', '-qm', 'main moved after the re-verify');
    git(fx.clone, 'push', '-q', 'origin', 'main');
    // The run's verified work sits UNCOMMITTED in the worktree — exactly as the engine leaves it for
    // its own retry (its lift re-applies uncommitted work; a branch with its own commits is skipped).
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const verifiedOnTheOldBase = true;\n');

    const r = await runDeliver(fx, { env: { WICKED_DELIVER_VERIFIED_BASE: verified } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: BASE MOVED since verification');
    expect(r.output).toContain(verified);
    expect(r.output).toContain('Nothing was staged, committed or pushed');
    // NOT a recoverable strand — a post-hoc lift would push a tree nobody verified on the new base.
    expect(r.output).not.toContain('LIFT-CONFLICT');
    expect(originBranches(fx)).toEqual(['main']);
    // The worktree is exactly as the engine left it: the work untracked and unstaged, no commit on
    // the run branch, no stranded sentinel — so an approved retry re-lifts and re-verifies cleanly.
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toBe('?? work.ts');
    expect(git(fx.workdir, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('0');
    expect(existsSync(join(fx.workdir, '.wicked-crew-delivery-stranded'))).toBe(false);
  }, 60_000);

  it('REFUSES fail-closed when the pin is set but the default tip does not resolve to it (a garbage pin)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const x = 1;\n');

    const r = await runDeliver(fx, { env: { WICKED_DELIVER_VERIFIED_BASE: 'not-a-commit-0000' } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: BASE MOVED since verification');
    expect(r.output).toContain('not-a-commit-0000');
    expect(originBranches(fx)).toEqual(['main']);
    expect(git(fx.workdir, 'status', '--porcelain').trim()).toBe('?? work.ts');
  }, 60_000);
});

// Wave-3 isolation review (crew#524 follow-up): the embedded fallback used to derive `Fixes #N`
// from the intent AFTER bounding it to EMBEDDED_INTENT_CAP, so a closing reference written past
// the cap never reached the PR body of a run whose daemon did not answer. Driven for real: no
// daemon origin ⇒ the embedded text, and it still carries the reference.
describe('deliver script — a `fixes #N` past the embedded-intent cap still reaches the PR body', () => {
  it('keeps `Fixes #214` from the FULL intent while the embedded text is cut and says so', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const longIntent = `Archive controls never render\n\n${'observation '.repeat(700)}\n\nThis fixes #214 and relates to wicked-studio#211.`;
    expect(longIntent.indexOf('fixes #214')).toBeGreaterThan(8_000);

    const r = await runDeliver(fx, { intent: longIntent, script: { runId: RUN_ID } });

    expect(r.status).toBe(0);
    expect(r.output).toContain('using the launch-time PR text');
    expect(r.pr!.title).toBe('Archive controls never render');
    expect(r.pr!.body).toContain('\nFixes #214\n');
    expect(r.pr!.body).toContain('the intent is longer than the deliver script embeds');
    expect(r.pr!.body).not.toContain('This fixes #214 and relates to'); // the TEXT was cut, the reference was not
    // The commit message carries the same closing line.
    expect(git(fx.origin, 'log', '-1', '--format=%b', `wicked/${RUN_ID}`)).toContain('Fixes #214');
  }, 60_000);
});

// wicked-core#433 review addendum — the crew#426 preflight (`npm install` + `manifest:endpoints` +
// `generate:api-tests`) runs AFTER the engine verified the tree. Driven for real on a crew-SHAPED
// fixture (the preflight is gated on root package.json + lockfile + packages/crew +
// packages/crew-api-types) whose codegen script either leaves the manifest alone or rewrites it.
describe('deliver script — the preflight must not weaken the verified tree (wicked-core#433 addendum)', () => {
  /** Turn the fixture's seed into a crew-shaped workspace whose `manifest:endpoints` script runs
   *  `regen` inside packages/crew; the seed's lockfile is what `npm install` itself produces, so an
   *  in-sync preflight rewrites nothing. */
  function crewShaped(fx: Fixture, regen: string): void {
    const seed = join(fx.root, 'seed');
    mkdirSync(join(seed, 'packages', 'crew'), { recursive: true });
    mkdirSync(join(seed, 'packages', 'crew-api-types'), { recursive: true });
    writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name: 'fx-root', private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
    writeFileSync(
      join(seed, 'packages', 'crew', 'package.json'),
      `${JSON.stringify({ name: 'fx-crew', version: '0.0.0', private: true, scripts: { 'manifest:endpoints': regen, 'generate:api-tests': 'node -e 0' } }, null, 2)}\n`,
    );
    writeFileSync(join(seed, 'packages', 'crew', 'endpoint-manifest.json'), '{"version":1,"apiTypesVersion":"0.0.0"}\n');
    writeFileSync(join(seed, 'packages', 'crew-api-types', 'package.json'), `${JSON.stringify({ name: 'fx-api-types', version: '0.0.0', private: true }, null, 2)}\n`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: seed, stdio: 'ignore' });
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'crew-shaped workspace');
    git(seed, 'push', '-q', 'origin', 'main');
    // The run worktree hangs off the clone: bring both to the new tip.
    git(fx.clone, 'pull', '-q', '--ff-only', 'origin', 'main');
    git(fx.workdir, 'fetch', '-q', 'origin');
    git(fx.workdir, 'reset', '-q', '--hard', 'origin/main');
  }
  const REWRITE = `node -e "require('fs').writeFileSync('endpoint-manifest.json', JSON.stringify({version:1,apiTypesVersion:'9.9.9'})+'\\n')"`;

  it('an in-sync preflight changes nothing and the delivery proceeds', async () => {
    const fx = fixture();
    crewShaped(fx, 'node -e 0');
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const verified = true;\n');

    const r = await runDeliver(fx, { intent: 'in-sync preflight' });

    expect(r.status).toBe(0);
    expect(r.output).not.toContain('PREFLIGHT CHANGED');
    expect(r.output).not.toContain('preflight regenerated');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 90_000);

  it('an ENGINE-driven delivery REFUSES when the preflight rewrote a tracked file — named, nothing staged or pushed', async () => {
    const fx = fixture();
    crewShaped(fx, REWRITE);
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const verified = true;\n');

    const r = await runDeliver(fx, { intent: 'regenerated after verify' });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: PREFLIGHT CHANGED the verified tree');
    expect(r.output).toContain('packages/crew/endpoint-manifest.json');
    expect(r.output).toContain('Nothing was staged, committed or pushed');
    expect(r.output).not.toContain('LIFT-CONFLICT');
    expect(originBranches(fx)).toEqual(['main']);
    // The regeneration is left in the worktree for the operator to see (unstaged), the work untouched.
    const status = git(fx.workdir, 'status', '--porcelain');
    expect(status).toContain(' M packages/crew/endpoint-manifest.json');
    expect(status).toContain('?? work.ts');
    expect(git(fx.workdir, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('0');
  }, 90_000);

  it('a POST-HOC lift keeps the regeneration, delivers it, and SAYS which files it rewrote', async () => {
    const fx = fixture();
    crewShaped(fx, REWRITE);
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const verified = true;\n');

    const r = await runDeliver(fx, { intent: 'post-hoc regeneration', env: { WICKED_DELIVER_POSTHOC: '1' } });

    expect(r.status).toBe(0);
    expect(r.output).toContain('deliver: preflight regenerated tracked files on a post-hoc lift');
    expect(r.output).toContain('packages/crew/endpoint-manifest.json');
    expect(r.output).not.toContain('PREFLIGHT CHANGED');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`).trim().split('\n').sort();
    expect(files).toEqual(['packages/crew/endpoint-manifest.json', 'work.ts']);
  }, 90_000);
});
