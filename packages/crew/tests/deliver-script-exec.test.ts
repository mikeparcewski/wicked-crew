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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELIVER_LIFT_CONFLICT_MARKER,
  DELIVER_OUTCOME_MARKER,
  DELIVER_PUSHED_NO_PR_MARKER,
  DELIVER_PUSH_REJECTED_MARKER,
  DELIVER_UNVERIFIED_MARKER,
  deliverPrScript,
  unverifiedTreesFrom,
  type DeliverScriptOptions,
} from '../src/core/deliver.js';
import { deliveryRecordFrom } from '../src/api/delivery-index.js';
import { DELIVER_CREDENTIALS_MISSING_MARKER } from '../src/core/deliver-credentials.js';
import { triageDeliverFailure, trustedDeliverOutcome, trustedOutcomeIn } from '../src/core/deliver-triage.js';

/** (crew#739) The sentinel nonce every composed script in this file carries. */
const TEST_NONCE = '0123456789abcdef0123456789abcdef';
import { deliverExclusionReason } from '../src/core/deliver-exclusions.js';
import { DELIVER_TITLE_MAX, commitSubject, composeDeliverText, deliverTitle, factsFromWorkflow, framedDeliverText } from '../src/core/deliver-text.js';

const RUN_ID = '1bc72c20-0457-425f-b4cb-215a40e68e1e';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

/** Every non-ignored untracked path in `cwd`, repo-relative, git's own spelling. */
function untrackedOf(cwd: string): string[] {
  return git(cwd, 'ls-files', '--others', '--exclude-standard').split('\n').filter((l) => l !== '');
}

/** {@link deliverExclusionReason} with the file's real size (F3's drift guard). */
function tsExclusion(cwd: string, rel: string): string | null {
  let size: number | null = null;
  try { size = statSync(join(cwd, rel)).size; } catch { /* raced away — unknown size */ }
  return deliverExclusionReason(rel, size, () => {
    try { return readFileSync(join(cwd, rel), 'utf8'); } catch { return null; }
  });
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
function fixture(opts: { worktree?: boolean; defaultBranch?: string; fromRef?: string } = {}): Fixture {
  const branch = opts.defaultBranch ?? 'main';
  const root = mkdtempSync(join(tmpdir(), 'crew-deliver-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  execFileSync('git', ['init', '--bare', '-b', branch, origin]);
  execFileSync('git', ['init', '-b', branch, seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', branch);

  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');
  // A clone sets origin/HEAD, which is what the script's default-branch derivation reads.
  expect(git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim()).toBe(
    `origin/${branch}`,
  );

  if (opts.worktree === false) return { workdir: clone, clone, origin, root };

  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, opts.fromRef ?? branch);
  return { workdir, clone, origin, root };
}

/** DES-L9 — the PR this run revises: a `wicked/prior-run` branch on origin, one commit on top of main,
 *  fetched into the clone so `origin/wicked/prior-run` resolves. Returns its head sha. */
const PR_BRANCH = 'wicked/prior-run';
/** (crew#940) The github.com origin the identity tests deliver to (the git shim maps it to the bare fixture). */
const GITHUB_URL = 'https://github.com/o/r.git';
/** A credential helper answering for gh's ACTIVE account — what osxkeychain or a stale helper holds. */
// Assembled at runtime: no credential-shaped literal in the source (secret scanners read it).
const ACTIVE_ACCOUNT_HELPER = ['!f() { test "$1" = get && printf \'user', "name=someone-else\\npass", "word=tok-someone-else\\n'; }; f"].join('');
const PR = { number: 273, headRef: PR_BRANCH, url: 'https://github.com/o/r/pull/273' };
function prBranchOnOrigin(root: string, origin: string): string {
  const other = join(root, 'other');
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 'prior@test');
  git(other, 'config', 'user.name', 'prior');
  git(other, 'checkout', '-q', '-b', PR_BRANCH);
  writeFileSync(join(other, 'pr.txt'), 'the prior run\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'fix: the prior run');
  git(other, 'push', '-q', 'origin', PR_BRANCH);
  return git(other, 'rev-parse', 'HEAD').trim();
}

/** Behaviour knobs the fake `gh` reads out of the environment. */
interface GhStub {
  /** stderr text + exit 1 from `gh pr create`. */
  failWith?: string;
  /** stdout text from a SUCCESSFUL `gh pr create` (default: a PR URL). */
  succeedWith?: string;
  /** `gh api user -q .login` output. */
  login?: string;
  /** Make `gh api user` FAIL (exit 1, nothing on stdout) — an unauthenticated gh. */
  apiFails?: boolean;
  /** What `gh pr view N --json state -q .state` answers (default `OPEN`). */
  prState?: string;
  /** stderr text + exit 1 from `gh pr comment`. */
  commentFailWith?: string;
  /** (crew#737) `gh auth token --user <tokenFor>` prints a token; any other account fails. */
  tokenFor?: string;
  /** (crew#737) The login `gh api user` answers while that token is exported as GH_TOKEN. */
  tokenLogin?: string;
  /** (crew#737) `gh auth token --help` lists `--user` (a gh ≥ 2.40); default: an older gh. */
  tokenUserFlag?: boolean;
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
  opts: {
    intent?: string;
    gh?: GhStub;
    env?: Record<string, string>;
    script?: DeliverScriptOptions;
    /** R1: what `git remote get-url --push origin` answers inside the script (a `git` shim; every
     *  other git call reaches the real git, so the push still lands on the bare fixture). */
    originPushUrl?: string;
    /** (crew#940) A github.com origin: origin's URL (and the script's) is GITHUB_URL, and a `git`
     *  shim hands any fetch/push/ls-remote naming that URL to the bare fixture — first asking git,
     *  with the SAME `-c` options the script passed, which password its credential helpers would
     *  present for github.com (recorded as `gitCreds`, "<subcommand> <password> allow=<GIT_ALLOW_PROTOCOL>"). */
    githubOrigin?: boolean;
  } = {},
): Promise<{ status: number; output: string; lastLine: string; outcome: string | null; pr: PrCreateCall | null; comment: string | null; ghCalls: string[]; gitCreds: string[]; prToken: string | null }> {
  const nonce = opts.script?.nonce ?? TEST_NONCE;
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
      // Every call is logged — the identity tests assert the script never runs `gh auth switch`.
      'printf "%s\\n" "$*" >> "$GH_STUB_RECORD.calls"',
      'case "$1" in',
      '  api) if [ -n "${GH_TOKEN:-}" ] && [ "$GH_TOKEN" = "tok-${GH_STUB_TOKEN_FOR:-}" ]; then echo "$GH_STUB_TOKEN_LOGIN"; exit 0; fi; if [ -n "${GH_STUB_API_FAIL:-}" ]; then echo "gh: not logged in" >&2; exit 1; fi; echo "${GH_STUB_LOGIN:-tester}";;',
      // (crew#737) `gh auth token [--help] --user <a>`: a token only for the stubbed account; the
      // help text lists --user only on a stubbed newer gh. Any other auth verb is still recorded.
      '  auth)',
      '    if [ "$2" = token ]; then',
      '      case " $* " in *" --help "*) if [ -n "${GH_STUB_TOKEN_USER_FLAG:-}" ]; then echo "  -u, --user string   The account to output the token for"; fi; exit 0;; esac',
      '      U=""; P=""; for a in "$@"; do [ "$P" = --user ] && U="$a"; P="$a"; done',
      '      if [ -n "$U" ] && [ "$U" = "${GH_STUB_TOKEN_FOR:-}" ]; then echo "tok-$U"; exit 0; fi',
      '      echo "no oauth token found for github.com account $U" >&2; exit 1',
      '    fi',
      '    echo "gh: switched account";;',
      '  pr)',
      '    case "$2" in',
      // DES-L9 revision mode: `gh pr view N --json state -q .state` and `gh pr comment N --body-file`.
      '      view) echo "${GH_STUB_PR_STATE:-OPEN}";;',
      '      comment) BF=""; while [ $# -gt 0 ]; do case "$1" in --body-file) BF="$2"; shift;; esac; shift; done; if [ -n "$BF" ]; then cp "$BF" "$GH_STUB_RECORD.comment"; fi; if [ -n "${GH_STUB_COMMENT_FAIL:-}" ]; then echo "$GH_STUB_COMMENT_FAIL" >&2; exit 1; fi; echo "https://github.com/o/r/pull/273#issuecomment-1";;',
      '      *)',
      // Record what the PR was opened WITH (crew#524): the title and the body file's content.
      '        T=""; BF=""; while [ $# -gt 0 ]; do case "$1" in --title) T="$2"; shift;; --body-file) BF="$2"; shift;; esac; shift; done',
      '        printf "%s\\n" "$T" > "$GH_STUB_RECORD.title"; if [ -n "$BF" ]; then cp "$BF" "$GH_STUB_RECORD.body"; fi; printf "%s\\n" "$*" > "$GH_STUB_RECORD.argv"; printf "%s\\n" "${GH_TOKEN:-}" > "$GH_STUB_RECORD.prtoken"',
      '        if [ -n "${GH_STUB_FAIL:-}" ]; then echo "$GH_STUB_FAIL" >&2; exit 1; fi',
      '        echo "${GH_STUB_OUT:-https://github.com/o/r/pull/7}";;',
      '    esac;;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const record = join(fx.root, `gh-record-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let script = opts.script;
  if (opts.githubOrigin === true) {
    git(fx.workdir, 'remote', 'set-url', 'origin', GITHUB_URL);
    script = { originUrl: GITHUB_URL, ...opts.script };
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/bash',
        `REAL='${realGit}'`,
        'args=("$@"); out=(); cfg=(); sub=""; i=0',
        'while [ $i -lt ${#args[@]} ]; do a="${args[$i]}"',
        '  if [ -z "$sub" ]; then',
        '    if [ "$a" = -c ]; then cfg+=(-c "${args[$((i+1))]}"); out+=(-c "${args[$((i+1))]}"); i=$((i+2)); continue; fi',
        '    case "$a" in -*) ;; *) sub="$a";; esac; out+=("$a")',
        '  else',
        `    if [ "$a" = '${GITHUB_URL}' ]; then case "$sub" in push|fetch|ls-remote)`,
        '      P=$(printf "protocol=https\nhost=github.com\npath=o/r.git\n\n" | GIT_TERMINAL_PROMPT=0 "$REAL" "${cfg[@]}" credential fill 2>/dev/null | sed -n "s/^password=//p" | head -1)',
        // The canonical https URL becomes the bare fixture (a local path), which the script's
        // https-only GIT_ALLOW_PROTOCOL would refuse; it is recorded, then lifted for this call.
        '      printf "%s %s %s\n" "$sub" "${P:-none}" "allow=${GIT_ALLOW_PROTOCOL:-}" >> "$GH_STUB_RECORD.gitcred"; a="$GIT_STUB_GITHUB_DIR"; unset GIT_ALLOW_PROTOCOL;; esac; fi',
        '    out+=("$a")',
        '  fi',
        '  i=$((i+1))',
        'done',
        'exec "$REAL" "${out[@]}"',
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
  } else if (opts.originPushUrl !== undefined) {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        // `remote get-url --push --all origin` — the env value may hold several newline-separated URLs.
        // Only the FULL invocation, so a script that dropped `--all` falls through to real git and the
        // multi-URL case fails (Copilot on crew#736).
        'if [ "$1" = remote ] && [ "$2" = get-url ] && [ "$3" = --push ] && [ "$4" = --all ] && [ "$5" = origin ] && [ $# -eq 5 ]; then printf "%s\\n" "$GIT_STUB_ORIGIN_PUSH_URL"; exit 0; fi',
        `exec '${realGit}' "$@"`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
  } else if (existsSync(join(bin, 'git'))) {
    rmSync(join(bin, 'git'));
  }

  const res = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'bash',
      ['-lc', deliverPrScript(opts.intent, { ...script, nonce })],
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
          GH_STUB_API_FAIL: opts.gh?.apiFails === true ? '1' : '',
          GH_STUB_PR_STATE: opts.gh?.prState ?? '',
          GH_STUB_COMMENT_FAIL: opts.gh?.commentFailWith ?? '',
          GH_STUB_TOKEN_FOR: opts.gh?.tokenFor ?? '',
          GH_STUB_TOKEN_LOGIN: opts.gh?.tokenLogin ?? '',
          GH_STUB_TOKEN_USER_FLAG: opts.gh?.tokenUserFlag === true ? '1' : '',
          GIT_STUB_ORIGIN_PUSH_URL: opts.originPushUrl ?? '',
          GIT_STUB_GITHUB_DIR: fx.origin,
          // DES-L9: the identity block reads GH_TOKEN's PRESENCE for its disclosure line — keep the
          // fixture deterministic whatever the developer's shell exported.
          GH_TOKEN: '',
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
  // (crew#739) Every exit ends with exactly one trusted sentinel, from the EXIT trap. It is peeled
  // off here so `lastLine` stays the script's own verdict text (the URL, a marker line); `outcome`
  // is the sentinel's verdict under the composed script's nonce.
  const sentinels = lines.filter((l) => l.startsWith(DELIVER_OUTCOME_MARKER));
  expect(sentinels, `exactly one trusted sentinel, last:\n${output}`).toHaveLength(1);
  expect(lines[lines.length - 1]!.startsWith(DELIVER_OUTCOME_MARKER), `the sentinel is the LAST line:\n${output}`).toBe(true);
  const outcome = trustedOutcomeIn(output, nonce);
  lines.pop();
  const pr: PrCreateCall | null = existsSync(`${record}.title`)
    ? {
        title: readFileSync(`${record}.title`, 'utf8').replace(/\n$/, ''),
        body: existsSync(`${record}.body`) ? readFileSync(`${record}.body`, 'utf8') : null,
        argv: readFileSync(`${record}.argv`, 'utf8').replace(/\n$/, ''),
      }
    : null;
  const comment = existsSync(`${record}.comment`) ? readFileSync(`${record}.comment`, 'utf8') : null;
  const ghCalls = existsSync(`${record}.calls`)
    ? readFileSync(`${record}.calls`, 'utf8').trimEnd().split('\n').filter(Boolean)
    : [];
  const gitCreds = existsSync(`${record}.gitcred`) ? readFileSync(`${record}.gitcred`, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
  const prToken = existsSync(`${record}.prtoken`) ? readFileSync(`${record}.prtoken`, 'utf8').trim() : null;
  return { status: res.status, output, lastLine: lines[lines.length - 1] ?? '', outcome, pr, comment, ghCalls, gitCreds, prToken };
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
    expect(r.outcome).toBe('pr');
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

  it('R1: opens the pull request ON the github.com repository the consent card named (`--repo owner/repo`)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    // The card's compose-time origin read named acme/widgets; gh must not pick another base
    // (a `gh repo set-default`, an `upstream` remote) behind the operator's consent. Userinfo is
    // assembled at runtime: no credential-shaped literal in the source.
    const consented = ['https://', 'x-access-token', ':', 'FAKE-TOKEN', '@github.com/acme/widgets.git'].join('');
    const r = await runDeliver(fx, {
      intent: 'bind the PR target',
      script: { runId: RUN_ID, originUrl: consented },
      originPushUrl: 'https://github.com/acme/widgets.git',
    });
    expect(r.status).toBe(0);
    // `ghCalls` keeps the full argv (the stub's `.argv` record is written after its arg loop shifts).
    const create = r.ghCalls.find((c) => c.startsWith('pr create')) ?? '';
    expect(create).toContain('pr create --repo acme/widgets --head');
    expect(r.output).not.toContain('FAKE-TOKEN');
  }, 60_000);

  it('R1: REFUSES when origin was re-pointed since the card was approved — nothing staged or pushed (Copilot)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    const r = await runDeliver(fx, {
      intent: 'origin drifted',
      script: { runId: RUN_ID, originUrl: 'git@github.com:acme/widgets.git' },
      originPushUrl: 'git@github.com:someone-else/widgets.git',
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: origin no longer points at acme/widgets (or also pushes elsewhere), the repository this delivery was approved for');
    expect(originBranches(fx)).not.toContain(`wicked/${RUN_ID}`);
    expect(r.ghCalls.some((c) => c.startsWith('pr create'))).toBe(false);
    expect(git(fx.workdir, 'status', '--porcelain')).toContain('README.md');
  }, 60_000);

  // The drift check PARSES the URL (codex review): a look-alike host, or a path that merely ends
  // in the repository, is refused; every honest spelling of the same repository passes.
  it.each([
    'https://evil.example/github.com/acme/widgets',
    'git@evilgithub.com:acme/widgets.git',
    'ssh://git@github.com.evil.example/acme/widgets',
    // A SECOND push URL would receive the branch unnamed (Copilot): every one must be the approved repo.
    'git@github.com:acme/widgets.git\ngit@github.com:someone-else/widgets.git',
  ])('R1 drift: a look-alike origin %s is refused, nothing pushed', async (lookAlike) => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    const r = await runDeliver(fx, {
      intent: 'look-alike origin',
      script: { runId: RUN_ID, originUrl: 'https://github.com/acme/widgets.git' },
      originPushUrl: lookAlike,
    });
    expect(r.output).toContain('deliver: origin no longer points at acme/widgets');
    expect(originBranches(fx)).not.toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  it.each([
    'git@github.com:acme/widgets.git',
    'ssh://git@GitHub.com:22/acme/widgets/',
    'https://github.com/acme/widgets',
    'https://github.com/ACME/Widgets.git',
    'ssh://git@ssh.github.com:443/acme/widgets.git',
    'git@github.com:/acme/widgets.git',
    'https://github.com/ACME/Widgets.GIT',
  ])('R1 drift: the honest spelling %s passes and the push lands', async (same) => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    const r = await runDeliver(fx, {
      intent: 'same origin',
      script: { runId: RUN_ID, originUrl: 'https://github.com/acme/widgets.git' },
      originPushUrl: same,
    });
    expect(r.output).not.toContain('origin no longer points at');
    expect(r.status).toBe(0);
  }, 60_000);

  it('R1: a non-github.com origin bakes no --repo — gh still resolves it (the push-only path keys on that)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'README.md'), 'base\nchanged\n');
    const r = await runDeliver(fx, { intent: 'no binding', script: { runId: RUN_ID, originUrl: fx.origin } });
    expect(r.status).toBe(0);
    const create = r.ghCalls.find((c) => c.startsWith('pr create')) ?? '';
    expect(create).toContain('pr create --head');
    expect(create).not.toContain('--repo');
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
    // F-BM-002 (crew#579): the engine's own scratch under the worktree — excluded at enumeration, counted once.
    mkdirSync(join(fx.workdir, 'tmp', 'wicked-checks'), { recursive: true });
    writeFileSync(join(fx.workdir, 'tmp', 'wicked-checks', 'a.log'), 'a\n');
    writeFileSync(join(fx.workdir, 'tmp', 'pytest-of-x'), 'b\n');
    // An oversized (>1 MiB) untracked blob with an unremarkable name — caught by the size cap.
    writeFileSync(join(fx.workdir, 'rec.bin'), Buffer.alloc(1_600_000, 7)); // oversize-1mib
    // N2: the empty recovery sentinel a PREVIOUS failed attempt left behind (the retry-gate shape).
    // The script removes it before staging, so it never ships — the TS predicate must agree.
    writeFileSync(join(fx.workdir, '.wicked-crew-delivery-stranded'), '');
    // crew#901: an env TEMPLATE with no value is the run's product (a README points at it); one that
    // holds a value is excluded by content, and a real `.env` stays denylisted by name.
    mkdirSync(join(fx.workdir, 'giphy'));
    writeFileSync(join(fx.workdir, 'giphy', '.env.example'), '# the one secret\nGIPHY_TOKEN=\nexport BASE_URL=<https://api.example>\n');
    writeFileSync(join(fx.workdir, 'leaky.env.sample'), 'GIPHY_TOKEN=abc123\n');
    writeFileSync(join(fx.workdir, '.env'), 'GIPHY_TOKEN=abc123\n');

    // F3 DRIFT GUARD, half 1 — what the TS classifier (the one the deliver-gate diff reads) keeps
    // over the tree the script is ABOUT to classify in shell.
    const untrackedBefore = untrackedOf(fx.workdir);
    const keptByTs = untrackedBefore.filter((p) => tsExclusion(fx.workdir, p) === null).sort();

    const r = await runDeliver(fx, { intent: 'ship the feature' });

    expect(r.status).toBe(0);
    // Only the run's product rode; every scratch/key/oversize path stayed out.
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`)
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual(['README.md', 'feature.ts', 'giphy/.env.example']);
    expect(r.output).toContain('deliver: EXCLUDED (env-template-with-values): leaky.env.sample');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): .env');
    // A GUARD, NOT A SILENT DROP — each exclusion is named with its reason in the phase output.
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): bus.db');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): deploy.key');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): .envrc');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): bus.db-wal');
    expect(r.output).toContain('deliver: EXCLUDED (denylisted-name): SECRETS.PEM');
    expect(r.output).toContain('deliver: EXCLUDED (socket-name): socket.path');
    // F-BM-002: a scratch DIRECTORY is excluded at enumeration and reported once, with a count.
    expect(r.output).toContain('deliver: EXCLUDED (scratch-dir): coverage/ (1 files)');
    expect(r.output).toContain('deliver: EXCLUDED (scratch-dir): tmp/ (2 files)');
    expect(r.output).not.toContain('wicked-checks/a.log'); // one line per directory, never per file
    expect(r.output).not.toContain('coverage/lcov.info');
    expect(r.output).toContain('deliver: EXCLUDED (oversize-1mib): rec.bin');
    // Skipped, never deleted — the excluded files remain untracked in the worktree for the operator.
    const status = git(fx.workdir, 'status', '--porcelain');
    for (const p of ['bus.db', 'socket.path', 'deploy.key', 'coverage/', 'tmp/', 'rec.bin']) {
      expect(status).toContain(p);
    }

    // F3 DRIFT GUARD (`core/deliver-exclusions.ts`) — the deliver gate's consent diffstat is
    // computed over the untracked set the TS classifier keeps, while THIS shell decided the push.
    // The two are necessarily separate implementations, so they are pinned against each other on
    // exactly this tree, both ways:
    //   • what TS kept beforehand == the untracked paths the script actually committed;
    //   • of what the script left behind, TS keeps nothing.
    expect(keptByTs).toEqual(['feature.ts', 'giphy/.env.example']);
    expect(untrackedOf(fx.workdir).filter((p) => tsExclusion(fx.workdir, p) === null)).toEqual([]);
  }, 60_000);

  // crew#861 (S17b F14): a creator's read-only re-verify left `.vitest/json/output.json` (a vitest
  // JSON reporter's output) untracked at the worktree root; `git add -A` would have shipped it. The
  // tool-artifact directories and `*.log` are excluded, the repository's ignore rules are honoured,
  // and EVERY skip is named — in the phase output and in the PR body / commit message itself.
  it('SKIPS gitignored paths and test-runner artifacts (.vitest/, playwright-report/, *.log) and names them in the PR (crew#861)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'feature.ts'), 'export const feature = 1;\n');
    writeFileSync(join(fx.workdir, '.gitignore'), 'dist/\n');
    mkdirSync(join(fx.workdir, 'dist'));
    writeFileSync(join(fx.workdir, 'dist', 'bundle.js'), 'built\n'); // gitignored
    mkdirSync(join(fx.workdir, '.vitest', 'json'), { recursive: true });
    // Small enough that the 1 MiB size net would NOT have caught it — only the class does.
    writeFileSync(join(fx.workdir, '.vitest', 'json', 'output.json'), JSON.stringify({ numTotalTests: 483 }));
    mkdirSync(join(fx.workdir, 'web', 'playwright-report'), { recursive: true });
    writeFileSync(join(fx.workdir, 'web', 'playwright-report', 'index.html'), '<html></html>\n'); // nested tool dir
    writeFileSync(join(fx.workdir, 'vitest-debug.log'), 'trace\n');
    // A crafted name cannot open a heading in the PR body: its newline is folded on the record line.
    writeFileSync(join(fx.workdir, 'evil\n## Injected.log'), 'x\n');
    // `-z`: git's own unquoted spelling, so the newline name is classified as the script sees it.
    const untrackedZ = (): string[] => git(fx.workdir, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter((l) => l !== '');
    const keptByTs = untrackedZ().filter((p) => tsExclusion(fx.workdir, p) === null).sort();

    const r = await runDeliver(fx, { intent: 'ship the feature' });

    expect(r.status).toBe(0);
    const files = git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'feature.ts']);
    // Named in the phase output, each with its reason.
    expect(r.output).toContain('deliver: EXCLUDED (tool-artifact-dir): .vitest/ (1 files)');
    expect(r.output).toContain('deliver: EXCLUDED (tool-artifact-dir): web/playwright-report/index.html');
    expect(r.output).toContain('deliver: EXCLUDED (tool-artifact-name): vitest-debug.log');
    expect(r.output).toMatch(/deliver: SKIPPED 1 gitignored \(never staged\): dist\//);
    // …and where the reviewer reads: the PR body and the commit message, above the footer.
    const body = r.pr?.body ?? '';
    expect(body).toContain('## Not shipped');
    expect(body).toContain('- `.vitest/ (1 files)` — tool-artifact-dir');
    expect(body).toContain('- `web/playwright-report/index.html` — tool-artifact-dir');
    expect(body).toContain('- `vitest-debug.log` — tool-artifact-name');
    expect(body).toContain('- 1 gitignored entry');
    expect(body).toContain('- `evil?## Injected.log` — tool-artifact-name');
    expect(body).not.toMatch(/^## Injected/m);
    expect(body.indexOf('## Not shipped')).toBeLessThan(body.lastIndexOf('\n---\n'));
    const message = git(fx.origin, 'log', '-1', '--format=%B', `wicked/${RUN_ID}`);
    expect(message).toContain('## Not shipped');
    expect(message.trim().split('\n').pop()).toMatch(/^Delivered-By: wicked-crew run\b/);
    // Skipped, never deleted.
    const status = git(fx.workdir, 'status', '--porcelain');
    for (const p of ['.vitest/', 'web/', 'vitest-debug.log', 'Injected.log']) expect(status).toContain(p);
    // The TS classifier (the deliver gate's diffstat) agrees with the shell, both ways.
    expect(keptByTs).toEqual(['.gitignore', 'feature.ts']);
    expect(untrackedZ().filter((p) => tsExclusion(fx.workdir, p) === null)).toEqual([]);
  }, 60_000);

  it('adds no Not-shipped section when nothing was skipped', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'feature.ts'), 'export const feature = 1;\n');
    const r = await runDeliver(fx, { intent: 'ship the feature' });
    expect(r.status).toBe(0);
    expect(r.pr?.body ?? '').not.toContain('## Not shipped');
  }, 60_000);

  // ── crew#940 (operator ruling 2026-10-10) — the push identity is chosen PER COMMAND ────────────
  // gh's machine-wide ACTIVE account is someone-else, and git's own credential helper answers for
  // that account too (osxkeychain, a stale helper). With release-bot configured, the phase reads
  // release-bot's own token and hands it to its gh calls and to its git fetch/push alone — so the
  // push, the fetch and the pull request all go out as release-bot. On main the configured account
  // was only checked against git's helper, so this delivery was refused (or pushed as the helper's
  // account): it fails there.
  it('crew#940: with gh active as ANOTHER user, delivery still fetches, pushes and opens the PR as the configured identity', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    git(fx.workdir, 'config', 'credential.helper', ACTIVE_ACCOUNT_HELPER);
    const r = await runDeliver(fx, {
      githubOrigin: true,
      gh: { login: 'someone-else', tokenFor: 'release-bot', tokenLogin: 'release-bot' },
      env: { GH_ACCOUNT: 'release-bot' },
      script: { runId: RUN_ID },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.outcome).toBe('pr');
    // git presented release-bot's token on every network call, never the active account's.
    expect(r.gitCreds.length).toBeGreaterThanOrEqual(2);
    expect(r.gitCreds.every((c) => c.endsWith(' tok-release-bot allow=https')), r.gitCreds.join('\n')).toBe(true);
    expect(r.gitCreds.some((c) => c.startsWith('push '))).toBe(true);
    // …and so did gh for the pull request.
    expect(r.prToken).toBe('tok-release-bot');
    expect(r.output).toContain("deliver: pushing as release-bot with its own gh token, pinned for this phase (gh's active account is not used)");
    // The token never reaches the log, and the account is never switched.
    expect(r.output).not.toContain('tok-release-bot');
    expect(r.ghCalls).toContain('auth token --hostname github.com --user release-bot');
    expect(r.ghCalls.some((c) => c.startsWith('auth switch'))).toBe(false);
    expect(r.output).not.toContain('identity mismatch');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  it('crew#940: a configured identity gh holds no token for is "GitHub credentials not configured" — refused before anything is staged, recoverably', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    const r = await runDeliver(fx, { githubOrigin: true, gh: { login: 'someone-else' }, script: { deliverIdentity: 'release-bot' } });
    expect(r.status).not.toBe(0);
    expect(r.outcome).toBe('rejected');
    expect(r.output).toContain('deliver: GitHub credentials not configured: gh holds no token for release-bot on this machine and no GH_TOKEN is exported.');
    expect(r.output).toContain(`${DELIVER_CREDENTIALS_MISSING_MARKER} github; ${DELIVER_PUSH_REJECTED_MARKER}`);
    expect(originBranches(fx)).toEqual(['main']);
    expect(git(fx.workdir, 'status', '--porcelain')).toContain('?? work.ts');
    expect(r.gitCreds).toEqual([]);
    expect(r.ghCalls.filter((c) => !c.startsWith('auth token'))).toEqual([]);
  }, 60_000);

  it('crew#940: an exported GH_TOKEN wins — and one that authenticates as another login than the identity is REFUSED', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    const ok = await runDeliver(fx, { githubOrigin: true, gh: { login: 'release-bot' }, env: { GH_ACCOUNT: 'release-bot', GH_TOKEN: 'ghp_stub' } });
    expect(ok.status, ok.output).toBe(0);
    expect(ok.output).toContain('deliver: pushing as release-bot (pinned by GH_TOKEN)');
    expect(ok.gitCreds.every((c) => c.endsWith(' ghp_stub allow=https'))).toBe(true);
    expect(ok.ghCalls.some((c) => c.startsWith('auth token'))).toBe(false);
    expect(ok.output).not.toContain('ghp_stub');

    const fx2 = fixture();
    writeFileSync(join(fx2.workdir, 'work.ts'), 'export const z = 3;\n');
    const bad = await runDeliver(fx2, { githubOrigin: true, gh: { login: 'someone-else' }, env: { GH_ACCOUNT: 'release-bot', GH_TOKEN: 'ghp_stub' } });
    expect(bad.status).not.toBe(0);
    expect(bad.output.trim().startsWith('deliver: identity mismatch')).toBe(true);
    expect(bad.output).toContain('deliver: identity mismatch — the push identity is release-bot but the exported GH_TOKEN authenticates as someone-else; nothing was staged, committed or pushed.');
    expect(originBranches(fx2)).toEqual(['main']);
    expect(git(fx2.workdir, 'status', '--porcelain')).toContain('?? work.ts');

    const fx3 = fixture();
    writeFileSync(join(fx3.workdir, 'work.ts'), 'export const z = 3;\n');
    const unread = await runDeliver(fx3, { githubOrigin: true, gh: { apiFails: true }, env: { GH_ACCOUNT: 'release-bot', GH_TOKEN: 'ghp_stub' } });
    expect(unread.status).not.toBe(0);
    expect(unread.output).toContain('but the exported GH_TOKEN authenticates as unreadable; nothing was staged');
  }, 90_000);

  it('with no identity configured it pushes as whatever gh holds — and SAYS so (not pinned)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    const r = await runDeliver(fx, { gh: { login: 'whoever' } });
    expect(r.status).toBe(0);
    expect(r.output).toContain('deliver: pushing as whoever (no push identity configured — not pinned)');
  }, 60_000);

  it('crew#940: a url.*.insteadOf rewriting the canonical URL (to ssh, or https carrying its own credential) is refused before staging', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    git(fx.workdir, 'config', 'url.git@github.com:.insteadOf', 'https://github.com/');
    const r = await runDeliver(fx, { githubOrigin: true, gh: { login: 'someone-else', tokenFor: 'release-bot', tokenLogin: 'release-bot' }, env: { GH_ACCOUNT: 'release-bot' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: git config rewrites https://github.com/ (a url.*.insteadOf), so the push would not go to https://github.com/o/r.git with the pinned token; nothing was staged');
    expect(r.gitCreds).toEqual([]);
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('crew#940: a github.com origin the composer could not read is refused, not pushed unpinned', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    git(fx.workdir, 'remote', 'set-url', 'origin', GITHUB_URL);
    const r = await runDeliver(fx, { gh: { login: 'someone-else', tokenFor: 'release-bot' }, env: { GH_ACCOUNT: 'release-bot' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: origin is a github.com remote, but this delivery was composed without reading it, so the push identity release-bot cannot be pinned; nothing was staged');
    expect(git(fx.workdir, 'status', '--porcelain')).toContain('?? work.ts');
  }, 60_000);

  it('off github.com the github.com identity does not apply: no token is read and the push goes to origin as before', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    const r = await runDeliver(fx, { gh: { login: 'someone-else' }, env: { GH_ACCOUNT: 'release-bot' } });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('deliver: the push identity release-bot applies to github.com origins only');
    expect(r.ghCalls.some((c) => c.startsWith('auth '))).toBe(false);
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  // (crew#549 / F-RC1-010) THE CREDENTIAL CROSS-CHECK. `gh api user` says who GH is; it says
  // nothing about the credential `git push` will use, and on the RC1 rig the two disagreed — the
  // run pushed under an account the operator had not chosen. An https remote whose credential
  // helper answers a DIFFERENT login must refuse, naming both, before anything is staged.
  it('REFUSES when gh’s login and git’s credential for the remote disagree — naming both, nothing pushed', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // An https remote (only https has a git credential) and a helper answering another account.
    git(fx.workdir, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    git(fx.workdir, 'config', 'credential.helper', "!printf 'username=other-bot\\npassword=x\\n'");

    const r = await runDeliver(fx, { gh: { login: 'release-bot' } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain(
      "deliver: identity mismatch — gh's active login is release-bot but git's credential for github.com is other-bot",
    );
    expect(r.output).toContain('The push would use other-bot, not release-bot.');
    // Before any fetch or staging: the work is still untracked, the remote untouched, tree kept.
    expect(git(fx.workdir, 'status', '--porcelain')).toContain('?? work.ts');
    expect(originBranches(fx)).toEqual(['main']);
    expect(existsSync(fx.workdir)).toBe(true);
  }, 60_000);

  it("REFUSES when origin's own URL authenticates as another account — the URL wins over the helper", async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // A username-qualified remote tells git which account to authenticate as, whatever a helper
    // would answer for the bare host — so a helper that AGREES with gh must not rescue it.
    git(fx.workdir, 'remote', 'set-url', 'origin', 'https://other-bot@github.com/o/r.git');
    git(fx.workdir, 'config', 'credential.helper', "!printf 'username=release-bot\\npassword=x\\n'");

    const r = await runDeliver(fx, { gh: { login: 'release-bot' } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain(
      "deliver: identity mismatch — gh's active login is release-bot but origin's URL authenticates as other-bot",
    );
    expect(r.output).toContain('The push would use other-bot, not release-bot.');
    expect(git(fx.workdir, 'status', '--porcelain')).toContain('?? work.ts');
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it("a URL username that AGREES with gh is disclosed and the check goes on", async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // An unroutable loopback port: the identity block runs in full and the fetch after it fails
    // AT ONCE (connection refused), so this test never waits on the network.
    git(fx.workdir, 'remote', 'set-url', 'origin', 'https://release-bot@127.0.0.1:1/o/r.git');
    git(fx.workdir, 'config', 'credential.helper', "!printf 'username=release-bot\\npassword=x\\n'");

    const r = await runDeliver(fx, { gh: { login: 'release-bot' } });

    expect(r.output).toContain('deliver: origin authenticates as release-bot (agrees with gh)');
    expect(r.output).not.toContain('identity mismatch');
    // (It then fails on the unreachable https remote's fetch; nothing was pushed.)
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('a credential that names a TOKEN, not an account, is disclosed as unresolved — never a refusal', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // Unroutable loopback again: past the identity block the fetch fails at once (see above).
    git(fx.workdir, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/o/r.git');
    git(fx.workdir, 'config', 'credential.helper', "!printf 'username=x-access-token\\npassword=ghp\\n'");

    const r = await runDeliver(fx, { gh: { login: 'release-bot' } });

    expect(r.output).toContain("deliver: git's credential for 127.0.0.1:1 is a token (x-access-token)");
    expect(r.output).toContain('gh reports release-bot');
    expect(r.output).not.toContain('identity mismatch');
    // (It then fails on the unreachable https remote's fetch — the identity block let it through,
    //  which is the assertion; nothing was pushed either way.)
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('agreeing logins are disclosed and the delivery proceeds', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    // A local remote has no git credential — the phase says so rather than going quiet.
    const r = await runDeliver(fx, { gh: { login: 'release-bot' } });
    expect(r.status).toBe(0);
    expect(r.output).toContain('no git credential applies');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
  }, 60_000);

  it('the CONFIGURED deliver identity (the setting) wins over a differing GH_ACCOUNT', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');
    const r = await runDeliver(fx, {
      githubOrigin: true,
      gh: { login: 'someone-else', tokenFor: 'release-bot', tokenLogin: 'release-bot' },
      env: { GH_ACCOUNT: 'stale-bot' },
      script: { deliverIdentity: 'release-bot' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('deliver: pushing as release-bot');
    expect(r.ghCalls).toContain('auth token --hostname github.com --user release-bot');
    expect(r.ghCalls.some((c) => c.includes('stale-bot'))).toBe(false);
  }, 60_000);

  // ── DES-L9 / crew#550 — REVISION mode ───────────────────────────────────────────────────────
  it('REVISION: pushes exactly the run’s commits onto the PR’s branch, opens no PR, comments the record, prints the PR URL last', async () => {
    const fx = fixture({ worktree: false });
    const prHead = prBranchOnOrigin(fx.root, fx.origin);
    // The engine's mint for a revision: fetch, then the run branch cut from origin/<PR head>.
    git(fx.clone, 'fetch', '-q', 'origin');
    const revised = { ...fx, workdir: join(fx.root, RUN_ID) };
    git(fx.clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, revised.workdir, `origin/${PR_BRANCH}`);
    expect(existsSync(join(revised.workdir, 'pr.txt'))).toBe(true);
    writeFileSync(join(revised.workdir, 'pr.txt'), 'the prior run\nrevised after review\n');

    const r = await runDeliver(revised, { intent: 'Revise PR #273 — the review said REQUEST CHANGES', script: { runId: RUN_ID, revisesPr: PR } });

    expect(r.status).toBe(0);
    expect(r.lastLine).toBe(PR.url);
    // The PR's branch gained EXACTLY the run's one commit on top of its old head; no run branch on origin.
    expect(git(fx.origin, 'rev-list', '--count', `${prHead}..${PR_BRANCH}`).trim()).toBe('1');
    expect(originBranches(fx).sort()).toEqual(['main', PR_BRANCH].sort());
    expect(git(fx.origin, 'log', '-1', '--format=%s', PR_BRANCH).trim()).toBe('Revise PR #273 — the review said REQUEST CHANGES');
    // No `gh pr create`; the run record rode `gh pr comment`.
    expect(r.pr).toBeNull();
    expect(r.ghCalls.some((c) => c.startsWith('pr create'))).toBe(false);
    expect(r.ghCalls).toContain('pr view 273 --json state -q .state');
    expect(r.comment).not.toBeNull();
    expect(r.comment).toContain('Revises pull request [#273](https://github.com/o/r/pull/273)');
    expect(r.output).toContain('deliver: pull request #273 is OPEN and its branch wicked/prior-run is at wicked/' + RUN_ID);
    expect(r.output).toContain('deliver: run record commented on pull request #273');
    // The commit message carries the git trailer naming the pipeline (review-benchmark-prs D4).
    expect(git(fx.origin, 'log', '-1', '--format=%b', PR_BRANCH)).toContain(`Delivered-By: wicked-crew run ${RUN_ID}`);
  }, 60_000);

  it('REVISION: a PR head that MOVED since the run based on it is refused before staging — no marker, nothing pushed', async () => {
    const fx = fixture({ worktree: false });
    const prHead = prBranchOnOrigin(fx.root, fx.origin);
    git(fx.clone, 'fetch', '-q', 'origin');
    const revised = { ...fx, workdir: join(fx.root, RUN_ID) };
    git(fx.clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, revised.workdir, `origin/${PR_BRANCH}`);
    writeFileSync(join(revised.workdir, 'pr.txt'), 'the prior run\nrevised\n');
    // …meanwhile someone pushes to the PR.
    const other = join(fx.root, 'other');
    writeFileSync(join(other, 'moved.txt'), 'moved\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'the PR moved');
    git(other, 'push', '-q', 'origin', PR_BRANCH);
    const movedHead = git(other, 'rev-parse', 'HEAD').trim();

    const r = await runDeliver(revised, { script: { runId: RUN_ID, revisesPr: PR } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain(
      `deliver: pull request #273's branch moved since this run based on it (origin/${PR_BRANCH} is no longer an ancestor of wicked/${RUN_ID}); nothing was staged, committed or pushed — launch a new revision on the current head, or rebase wicked/${RUN_ID} onto origin/${PR_BRANCH} by hand and approve to retry`,
    );
    expect(r.lastLine).toBe("deliver: pull request #273's branch moved — refused; nothing was pushed");
    expect(r.output).not.toContain('LIFT-CONFLICT');
    expect(git(fx.origin, 'rev-parse', PR_BRANCH).trim()).toBe(movedHead);
    expect(git(revised.workdir, 'status', '--porcelain')).toContain(' M pr.txt'); // refused before staging
    expect(prHead).not.toBe(movedHead);
  }, 60_000);

  it('REVISION: a PR head that VANISHED is refused; a run that added nothing on top of the PR is refused', async () => {
    const fx = fixture({ worktree: false });
    prBranchOnOrigin(fx.root, fx.origin);
    git(fx.clone, 'fetch', '-q', 'origin');
    const revised = { ...fx, workdir: join(fx.root, RUN_ID) };
    git(fx.clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, revised.workdir, `origin/${PR_BRANCH}`);

    // Nothing on top: a clean tree level with the PR head.
    const nothing = await runDeliver(revised, { script: { runId: RUN_ID, revisesPr: PR } });
    expect(nothing.status, nothing.output).not.toBe(0);
    expect(nothing.output).toContain('deliver: nothing to deliver — the run added no commit on top of PR #273');

    // Vanished: the PR branch is deleted on origin (merged and cleaned up).
    git(fx.origin, 'update-ref', '-d', `refs/heads/${PR_BRANCH}`);
    writeFileSync(join(revised.workdir, 'pr.txt'), 'the prior run\nrevised\n');
    const gone = await runDeliver(revised, { script: { runId: RUN_ID, revisesPr: PR } });
    expect(gone.status).not.toBe(0);
    expect(gone.output).toContain(`deliver: pull request #273's branch origin/${PR_BRANCH} no longer exists on the remote; nothing was staged, committed or pushed`);
    expect(gone.output).not.toContain('LIFT-CONFLICT');
    expect(originBranches(fx)).toEqual(['main']);
  }, 60_000);

  it('REVISION: a failed comment is disclosed, not fatal — the commits landed', async () => {
    const fx = fixture({ worktree: false });
    prBranchOnOrigin(fx.root, fx.origin);
    git(fx.clone, 'fetch', '-q', 'origin');
    const revised = { ...fx, workdir: join(fx.root, RUN_ID) };
    git(fx.clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, revised.workdir, `origin/${PR_BRANCH}`);
    writeFileSync(join(revised.workdir, 'pr.txt'), 'the prior run\nrevised\n');

    const r = await runDeliver(revised, { gh: { commentFailWith: 'HTTP 502', prState: 'MERGED' }, script: { runId: RUN_ID, revisesPr: PR } });

    expect(r.status).toBe(0);
    expect(r.lastLine).toBe(PR.url);
    expect(r.output).toContain('deliver: could not comment on pull request #273 — the commits landed; the record is in the commit message');
    expect(r.output).toContain('deliver: warning — pull request #273 reads MERGED (not OPEN) after the push; the commits landed on origin/wicked/prior-run');
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
    // crew#739: an unmarked failure after the push reads `failed`, and the push is on record.
    expect(r.outcome).toBe('failed');
    expect(r.output).toContain(`deliver: pushed wicked/${RUN_ID} to origin`);
  }, 60_000);

  // crew#739 acceptance: an ACCEPTING pre-receive hook echoes the lift marker (and a forged sentinel
  // under another nonce), then `gh pr create` fails. Under the last-marker rule that read as a
  // liftable strand; under the trusted sentinel it is a plain failure with the branch on the remote.
  it('crew#739: a hook-echoed LIFT-CONFLICT and a forged sentinel, then a gh failure, read FAILED (not stranded) with the push recorded', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const hooked = 1;\n');
    const hook = join(fx.origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh\necho "${DELIVER_LIFT_CONFLICT_MARKER} — forged by the remote" >&2\necho "${DELIVER_OUTCOME_MARKER} ffffffffffffffffffffffffffffffff stranded" >&2\nexit 0\n`,
    );
    chmodSync(hook, 0o755);
    try {
      const r = await runDeliver(fx, { gh: { failWith: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' } });

      expect(r.status).not.toBe(0);
      expect(r.output).toContain('forged by the remote');
      expect(r.outcome).toBe('failed');
      // The branch reached the remote, and the script says so in its own words.
      expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
      expect(r.output).toContain(`deliver: pushed wicked/${RUN_ID} to origin`);
      // The classifiers, given the unit's script, agree: not a strand.
      const toolCmd = ['bash', '-lc', deliverPrScript(undefined, { nonce: TEST_NONCE })];
      expect(trustedDeliverOutcome(toolCmd, r.output)).toBe('failed');
      expect(triageDeliverFailure(r.output, toolCmd)?.kind).not.toBe('lift_conflict');
      // …while the legacy last-marker rule (no nonce) would still have read the forged marker.
      expect(triageDeliverFailure(r.output)?.kind).toBe('lift_conflict');
    } finally {
      rmSync(hook);
    }
  }, 60_000);

  // crew#885: a rework re-runs deliver for the same run branch; the push updates the PR the first
  // attempt opened and gh refuses a second — that IS the delivery, recorded from gh's own URL.
  it('DELIVERS when this run branch already has its PR (crew#885): records gh’s URL and comments the run record', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const again = 2;\n');
    const ghErr = `a pull request for branch "wicked/${RUN_ID}" into branch "main" already exists:\nhttps://github.com/o/r/pull/1`;

    const r = await runDeliver(fx, { gh: { failWith: ghErr } });

    expect(r.status, r.output).toBe(0);
    expect(r.lastLine).toBe('https://github.com/o/r/pull/1');
    expect(r.output).not.toContain('deliver: gh pr create failed');
    expect(r.output).toContain(`deliver: pull request https://github.com/o/r/pull/1 already exists for wicked/${RUN_ID}`);
    // The new attempt's run record rides a comment on the existing PR.
    expect(r.comment).not.toBeNull();
    expect(r.ghCalls.some((c) => c.startsWith('pr comment https://github.com/o/r/pull/1'))).toBe(true);
    // The daemon records it as delivered: the transcript's verdict is that URL.
    expect(deliveryRecordFrom(r.output)).toEqual({ url: 'https://github.com/o/r/pull/1' });
  }, 120_000);

  it('still FAILS when the existing PR gh names is for ANOTHER branch (crew#885)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const other = 3;\n');
    const ghErr = 'a pull request for branch "someone-else" into branch "main" already exists:\nhttps://github.com/o/r/pull/9';

    const r = await runDeliver(fx, { gh: { failWith: ghErr } });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: gh pr create failed');
    expect(r.lastLine).not.toContain('http');
  }, 60_000);

  it('KEEPS the work on a REFUSED push — PUSH-REJECTED, never a LIFT-CONFLICT (N4) — then succeeds after the remote is repaired (crew#432)', async () => {
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
    // N4: a push the REMOTE refused is not a lift collision (the lift was clean). It must not carry
    // the LIFT-CONFLICT marker — the engine exempts that marker from its deterministic
    // deliver-refusal gate and hands it to an LLM triage, which re-ran the push with no gate.
    expect(failed.output).not.toContain(DELIVER_LIFT_CONFLICT_MARKER);
    // Its own marker is last, so it survives the engine's tail excerpt.
    expect(failed.lastLine).toContain(DELIVER_PUSH_REJECTED_MARKER);
    expect(failed.outcome).toBe('rejected');
    expect(failed.lastLine).toContain('approve to retry the deliver phase');
    expect(originBranches(fx)).toEqual(['main']);
    // The committed work remains on the local run branch, ready for post-hoc delivery.
    expect(git(fx.workdir, 'rev-list', '--count', `main..wicked/${RUN_ID}`).trim()).toBe('1');
    expect(existsSync(fx.workdir)).toBe(true);
    expect(existsSync(join(fx.workdir, '.wicked-crew-delivery-stranded'))).toBe(true);

    rmSync(hook);
    const retried = await runDeliver(fx);
    expect(retried.status).toBe(0);
    expect(retried.outcome).toBe('pr');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
    expect(existsSync(join(fx.workdir, '.wicked-crew-delivery-stranded'))).toBe(false);
  }, 60_000);

  it('studio#403: the refusal line carries the hook\'s own reason however long the push output is, and names the push identity LAST', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const reason = true;\n');
    git(fx.workdir, 'add', '--', 'work.ts');
    // A hook that talks a lot BEFORE its verdict: the old 96 … 128 window kept neither end's reason.
    const hook = join(fx.origin, 'hooks', 'pre-receive');
    const chatter = Array.from({ length: 12 }, (_, i) => `echo "checking policy step ${i} of 12 ........................................" >&2`).join('\n');
    writeFileSync(hook, `#!/bin/sh\n${chatter}\necho "GH013: Repository rule violations found for refs/heads/x: signed commits required" >&2\n${chatter}\nexit 1\n`);
    chmodSync(hook, 0o755);

    const failed = await runDeliver(fx);

    expect(failed.outcome).toBe('rejected');
    expect(failed.lastLine).toContain(DELIVER_PUSH_REJECTED_MARKER);
    expect(failed.lastLine).toContain('GH013: Repository rule violations found for refs/heads/x: signed commits required');
    expect(failed.lastLine).toContain('pre-receive hook declined');
    // What Approve does (and as whom) first; the remote's reason closes the line, just before the
    // marker, because the engine keeps only the output's TAIL as the gate's text.
    expect(failed.lastLine).toMatch(/approve to retry the deliver phase \(it re-pushes \S+ to origin as [^)]+\)\. The remote said: [^\n]*GH013[^\n]*; deliver: PUSH-REJECTED$/u);
    expect(failed.lastLine).not.toContain('failed to push some refs');
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
    // The marker is the script's last verdict line, followed only by the trusted sentinel
    // (crew#739), so both survive core's head+tail denial_reason excerpt.
    expect(r.lastLine).toContain('deliver: LIFT-CONFLICT');
    expect(r.outcome).toBe('stranded');
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

  it('bakes no account name in: the identity comes from GH_ACCOUNT at run time, and the account is never switched (DES-L9 D-18)', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const q = 5;\n');
    const r = await runDeliver(fx, { githubOrigin: true, gh: { login: 'other', tokenFor: 'someone', tokenLogin: 'someone' }, env: { GH_ACCOUNT: 'someone' } });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('deliver: pushing as someone with its own gh token');
    expect(r.ghCalls.some((c) => c.startsWith('auth switch'))).toBe(false);
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

  it('crew#550: a title past 72 characters keeps the whole PR title; the commit subject stops at 72 and the body opens with the full title', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'fix.ts'), 'export const fixed = true;\n');
    const long = "Run failure card: headline truncated at '(Failed):' and 'sign a seat in' — the remedy line never renders";
    expect(long.length).toBeGreaterThan(72);
    const runText = framedDeliverText({ title: long, body: '## Intent\n\nfix issue #214\n\nFixes #214\n' });
    const daemon = await fakeDaemon((id) => (id === RUN_ID ? { status: 200, body: runText } : null));
    daemons.push(daemon);

    const r = await runDeliver(fx, { intent: INTENT, script: { runId: RUN_ID, apiOrigin: daemon.origin } });

    expect(r.status).toBe(0);
    expect(r.pr!.title).toBe(long);
    const subject = git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim();
    expect([...subject].length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('…')).toBe(true);
    expect(long.startsWith(subject.slice(0, -1).trimEnd())).toBe(true);
    const body = git(fx.origin, 'log', '-1', '--format=%b', `wicked/${RUN_ID}`);
    expect(body.split('\n')[0]).toBe(long);
    expect(body).toContain('Fixes #214');
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
    // BC-72: the `bug` workflow's conventional prefix rides the fallback title too.
    expect(r.pr!.title).toBe(deliverTitle(INTENT, RUN_ID, 'bug'));
    expect(r.pr!.title.startsWith('fix: ')).toBe(true);
    // crew#860: the PR title is the intent's first sentence inside 100 columns (this one is cut at a
    // word boundary); the commit subject is cut at 72.
    expect(r.pr!.title.length).toBeLessThanOrEqual(DELIVER_TITLE_MAX);
    expect(r.pr!.body).toBe(`${expected.body}\n`);
    expect(r.pr!.body).toContain('Fixes #214');
    expect(r.pr!.body).toContain('Refs: #211'); // `wicked-studio#211` on a wicked-studio delivery (W3-K2)
    expect(r.pr!.body).toContain(`- Run: [\`${RUN_ID}\`](${daemon.origin}/runs/${RUN_ID})`);
    expect(r.pr!.body).toContain('workflow `bug` · repo `wicked-studio`');
    expect(r.pr!.body).toContain('Not available at composition time');
    // The commit subject is the composed 72-column cut (word boundary, never `…aga`), the body the full title.
    const subject = commitSubject(expected.title);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('…')).toBe(true);
    expect(git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim()).toBe(subject);
    expect(git(fx.origin, 'log', '-1', '--format=%b', `wicked/${RUN_ID}`).split('\n')[0]).toBe(expected.title);
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
    // The title is the first line as plain words, cut at a word boundary (≤ 256, one line, code
    // markers stripped) — nothing in it was expanded. WHERE the cut lands depends on the length of
    // the temp path (short `/tmp/…` on Linux, long `/var/folders/…` on macOS), so the composer is
    // the oracle, not a literal.
    expect(r.pr!.title).toBe(deliverTitle(hostile, RUN_ID));
    expect(r.pr!.title.startsWith("x'; touch")).toBe(true);
    expect(r.pr!.title.length).toBeLessThanOrEqual(256); // crew#550: GitHub's limit, not git's 72
    expect(r.pr!.title).not.toContain('\n');
    // The commit subject is still ≤ 72 and still nothing but text.
    const subject = git(fx.origin, 'log', '-1', '--format=%s', `wicked/${RUN_ID}`).trim();
    expect(subject).toBe(commitSubject(r.pr!.title));
    expect([...subject].length).toBeLessThanOrEqual(72);
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

  // Review F-527-003 — the default ref is derived as the engine derives it: a repo whose default
  // branch is `master` (origin/HEAD → origin/master) and a clone whose origin/HEAD DANGLES both
  // resolve to the branch the engine pinned, so neither reads as a moved base.
  it('a repo whose default branch is master delivers on a matching pin — no false BASE MOVED', async () => {
    const fx = fixture({ defaultBranch: 'master' });
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const onMaster = true;\n');
    const tip = git(fx.clone, 'rev-parse', 'origin/master').trim();

    const r = await runDeliver(fx, { intent: 'master default', env: { WICKED_DELIVER_VERIFIED_BASE: tip } });

    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toContain('BASE MOVED');
    expect(originBranches(fx).sort()).toEqual(['master', `wicked/${RUN_ID}`]);
  }, 60_000);

  it('a DANGLING origin/HEAD falls back to origin/main — the pin still matches, nothing is refused', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const dangling = true;\n');
    // The remote renamed/deleted its default branch since the clone: origin/HEAD points at a ref
    // that no longer exists.
    git(fx.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    const tip = git(fx.clone, 'rev-parse', 'origin/main').trim();

    const r = await runDeliver(fx, { intent: 'dangling origin/HEAD', env: { WICKED_DELIVER_VERIFIED_BASE: tip } });

    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toContain('BASE MOVED');
    expect(originBranches(fx)).toContain(`wicked/${RUN_ID}`);
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

// ── F2 (ship-proof C7) — A NON-GITHUB ORIGIN ─────────────────────────────────────────────────────
//
// On a local, SSH, GitLab, ADO or Gitea origin the phase PUSHED THE BRANCH and then died on
// `gh pr create`: "none of the git remotes configured for this repository point to a known GitHub
// host", `exit 1`, no fallback and no push-only mode. Approving the retry re-ran the identical
// refusal; rejecting cancelled the run. So the run could never reach a terminal state while the
// irreversible side effect had already happened.
//
// gh is the authority on whether a remote is a GitHub remote: it resolves the remotes itself and
// its refusal is that verdict. So the push-only success path opens on THAT message and on nothing
// else — every other gh failure (auth, validation, a missing gh) stays exactly as loud as before,
// which is what keeps GitHub Enterprise Server users (where gh succeeds) unaffected.
describe('deliver script — a non-GitHub origin delivers the branch and the run reaches a terminal state (F2)', () => {
  /** gh's own refusal for a remote it cannot resolve to a GitHub repository. */
  const NOT_GITHUB =
    'none of the git remotes configured for this repository point to a known GitHub host. Use `gh auth login` to authenticate with a host';

  it('pushes the branch, says no PR was opened and why, and EXITS 0', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');

    const r = await runDeliver(fx, { intent: 'ship it', gh: { failWith: NOT_GITHUB } });

    // The branch really is on the remote, with the run's commit — the delivery, re-derived.
    expect(git(fx.origin, 'rev-parse', `wicked/${RUN_ID}`).trim()).not.toBe('');
    expect(git(fx.origin, 'show', '--name-only', '--format=', `wicked/${RUN_ID}`)).toContain('work.ts');
    // The run reaches a terminal state instead of dying after the side effect.
    expect(r.status).toBe(0);
    // gh's own words are kept, and the phase says plainly what did and did not happen.
    expect(r.output).toContain(NOT_GITHUB);
    expect(r.output).toContain(`deliver: pushed ${`wicked/${RUN_ID}`} to origin`);
    expect(r.output).toContain('no pull request was opened');
    expect(r.output).toContain('that remote is not a GitHub host gh can resolve');
    // It never claims a PR: nothing downstream may read a pull-request URL out of this output.
    expect(r.output).not.toMatch(/https:\/\/\S+\/pull\/\d+/);
    // N1: the LAST line is the machine record the daemon turns into `delivery: 'pushed'` — the
    // branch and the push remote, exactly; without it the run read 'stranded'.
    expect(r.lastLine).toBe(`${DELIVER_PUSHED_NO_PR_MARKER} wicked/${RUN_ID} ${fx.origin}`);
    expect(r.outcome).toBe('pushed');
    expect(deliveryRecordFrom(r.output)).toEqual({
      pushed: { branch: `wicked/${RUN_ID}`, remote: fx.origin },
    });
  }, 60_000);

  it('EVERY other gh failure stays loud — a GHES / auth / missing-gh failure is not push-only', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const z = 3;\n');

    const r = await runDeliver(fx, {
      gh: { failWith: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' },
    });

    expect(r.status).not.toBe(0);
    expect(r.output).toContain('deliver: gh pr create failed');
    expect(r.output).not.toContain('no pull request was opened');
  }, 60_000);
});

// ── wicked-core#850 EX-04 — a POST-HOC lift labels its PR UNVERIFIED, with both trees ────────────
describe('deliver script — a post-hoc lift is labelled unverified (EX-04)', () => {
  it('post-hoc: the PR body ends with the label, and the marker line names the tree before and the tree delivered', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const lifted = true;\n');
    const r = await runDeliver(fx, { intent: 'post-hoc lift', env: { WICKED_DELIVER_POSTHOC: '1' } });
    expect(r.status, r.output).toBe(0);
    const trees = unverifiedTreesFrom(r.output);
    expect(trees?.treeBefore).toMatch(/^[0-9a-f]{40}$/);
    // The delivered tree IS what reached the remote.
    expect(trees?.treeAfter).toBe(git(fx.origin, 'rev-parse', `wicked/${RUN_ID}^{tree}`).trim());
    expect(r.pr?.body).toContain('**Unverified delivery.**');
    expect(r.pr?.body).toContain(trees!.treeBefore!);
    expect(r.pr?.body).toContain(trees!.treeAfter!);
    expect(r.lastLine).toMatch(/\/pull\/\d+$/); // the URL stays the verdict line
  }, 90_000);

  it('the engine-driven deliver unit (no post-hoc env) carries no label and prints no marker', async () => {
    const fx = fixture();
    writeFileSync(join(fx.workdir, 'work.ts'), 'export const verified = true;\n');
    const r = await runDeliver(fx, { intent: 'in-run deliver' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toContain(DELIVER_UNVERIFIED_MARKER);
    expect(unverifiedTreesFrom(r.output)).toBeNull();
    expect(r.pr?.body ?? '').not.toContain('Unverified delivery');
  }, 90_000);
});
