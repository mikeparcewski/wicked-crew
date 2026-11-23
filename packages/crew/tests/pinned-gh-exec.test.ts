// crew#1792: crew's own PR reads (review-change's provenance read, the revision's resolvePullRequest) run as the
// deliver identity, in the deliver script's credential order, whatever account gh has active on the host.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedGhExec, pinnedGitExec, resolvePullRequest, type GhExec, type GitExec } from '../src/core/deliver.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A registered checkout whose origin is `url`, made with git itself (the shape `readDeliverOriginUrl` reads). */
function checkout(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-1792-'));
  dirs.push(dir);
  // The hermetic arming rides into git as every test child's does (harness-hygiene).
  execFileSync('git', ['init', '-q', dir], { env: { ...process.env } });
  if (url !== null) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir, env: { ...process.env } });
  return dir;
}

const PR_URL = 'https://github.com/acme/private-app/pull/33';
/** `gh pr view 33 --json headRefName,state,isCrossRepository,url` as gh prints it. */
const PR_JSON = JSON.stringify({ headRefName: 'feature/min', isCrossRepository: false, state: 'OPEN', url: PR_URL });

type Call = { args: string[]; env: Readonly<Record<string, string>> | undefined };
/** A gh whose active account cannot see the private repository: `pr view` answers only with the deliver identity's
 *  token, as GitHub answers "Could not resolve to a Repository" otherwise. */
function fakeGh(tokens: Record<string, string>): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GhExec = async (args, opts) => {
    calls.push({ args, env: opts.env });
    if (args[0] === 'auth' && args[1] === 'token') {
      const user = args[args.indexOf('--user') + 1]!;
      return user in tokens ? { stdout: `${tokens[user]}\n`, stderr: '', code: 0 } : { stdout: '', stderr: `no oauth token found for github.com account ${user}`, code: 1 };
    }
    if (opts.env?.['GH_TOKEN'] === tokens['deliverbot']) return { stdout: PR_JSON, stderr: '', code: 0 };
    return { stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/private-app'. (repository)", code: 1 };
  };
  return { exec, calls };
}

describe('pinnedGhExec (crew#1792)', () => {
  it('reads a private PR with the deliver identity\'s own token, pinned to the origin, not the active account', async () => {
    const root = checkout('git@github.com:acme/private-app.git');
    const { exec, calls } = fakeGh({ deliverbot: 'gho_deliverbot' });
    const pinned = pinnedGhExec(async () => 'deliverbot', exec, {});
    const r = await resolvePullRequest(root, 33, pinned);
    expect(r).toEqual({ ok: true, pr: { number: 33, headRef: 'feature/min', url: PR_URL, state: 'OPEN' } });
    expect(calls).toEqual([
      { args: ['auth', 'token', '--hostname', 'github.com', '--user', 'deliverbot'], env: undefined },
      { args: ['pr', 'view', '33', '--json', 'headRefName,state,isCrossRepository,url'], env: { GH_TOKEN: 'gho_deliverbot', GH_HOST: 'github.com', GH_REPO: 'github.com/acme/private-app' } },
    ]);
  });

  it('fails the read by name when gh holds no token for the identity, never falling back to the active account', async () => {
    const root = checkout('https://github.com/acme/private-app.git');
    const { exec, calls } = fakeGh({});
    const out = await pinnedGhExec(async () => 'deliverbot', exec, {})(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('gh holds no token for deliverbot');
    expect(calls.map((c) => c.args[0])).toEqual(['auth']);
    const r = await resolvePullRequest(root, 33, pinnedGhExec(async () => 'deliverbot', exec, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('gh holds no token for deliverbot');
  });

  it('leaves gh as it is with no identity, or an origin that is absent or not a github.com repository', async () => {
    const github = checkout('https://github.com/acme/private-app.git');
    for (const [root, identity] of [
      [github, null],
      [checkout('https://gitlab.com/acme/private-app.git'), 'deliverbot'],
      [checkout(null), 'deliverbot'],
    ] as const) {
      const { exec, calls } = fakeGh({ deliverbot: 'gho_deliverbot' });
      await pinnedGhExec(async () => identity, exec, {})(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
      expect(calls).toEqual([{ args: ['pr', 'view', '33'], env: undefined }]);
    }
  });

  it('lets an exported GH_TOKEN win, still pinned to the origin so an inherited GH_REPO cannot retarget the read', async () => {
    const root = checkout('https://github.com/acme/private-app.git');
    const { exec, calls } = fakeGh({ deliverbot: 'gho_deliverbot' });
    const identity = async (): Promise<string | null> => { throw new Error('an exported GH_TOKEN wins: the identity is not read'); };
    await pinnedGhExec(identity, exec, { GH_TOKEN: 'exported', GH_REPO: 'github.com/other/repo' })(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
    expect(calls).toEqual([{ args: ['pr', 'view', '33'], env: { GH_HOST: 'github.com', GH_REPO: 'github.com/acme/private-app' } }]);
  });

  it('fails by name, reading nothing, when the origin cannot be read and a pin applies', async () => {
    const notACheckout = mkdtempSync(join(tmpdir(), 'crew-1792-bare-'));
    dirs.push(notACheckout);
    const { exec, calls } = fakeGh({ deliverbot: 'gho_deliverbot' });
    const out = await pinnedGhExec(async () => 'deliverbot', exec, {})(['pr', 'view', '33'], { cwd: notACheckout, timeoutMs: 5000 });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("could not read the repository's origin");
    expect(calls).toEqual([]);
    // An exported token is pinned to the origin too: unreadable, gh is never asked (an inherited GH_REPO could answer).
    const exported = await pinnedGhExec(async () => null, exec, { GH_TOKEN: 'exported', GH_REPO: 'github.com/other/repo' })(['pr', 'view', '33'], { cwd: notACheckout, timeoutMs: 5000 });
    expect(exported.code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses an identity that is not a GitHub login before asking gh for anything', async () => {
    const root = checkout('https://github.com/acme/private-app.git');
    const { exec, calls } = fakeGh({});
    const out = await pinnedGhExec(async () => '--user=x', exec, {})(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
    expect(out.code).toBe(1);
    expect(calls).toEqual([]);
  });
});

type GitCall = { args: string[]; cwd: string; env: Readonly<Record<string, string>> | undefined };
/** A git seam that records every call; `config --get-regexp` answers as git does with no rewrite configured (exit 1). */
function fakeGit(rewrites = ''): { git: GitExec; calls: GitCall[] } {
  const calls: GitCall[] = [];
  return { calls, git: async (args, cwd, env) => {
    if (args[0] === 'config') return rewrites === '' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: rewrites, stderr: '' };
    calls.push({ args, cwd, env });
    return { code: 0, stdout: '', stderr: '' };
  } };
}

describe('pinnedGitExec (crew#1804)', () => {
  it('fetches a branch from the canonical URL with the deliver identity\'s token in the environment, never argv', async () => {
    const root = checkout('git@github.com:acme/private-app.git');
    const { exec } = fakeGh({ deliverbot: 'gho_deliverbot' });
    const { git, calls } = fakeGit();
    await pinnedGitExec(async () => 'deliverbot', git, exec, {})(['fetch', 'origin', 'feature/min'], root);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args.slice(-5)).toEqual(['fetch', '-q', '--no-recurse-submodules', 'https://github.com/acme/private-app.git', '+refs/heads/feature/min:refs/remotes/origin/feature/min']);
    expect(call!.args.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
    expect(call!.args).toEqual(expect.arrayContaining(['maintenance.auto=false', 'gc.auto=0', '--no-recurse-submodules']));
    expect(call!.args.join(' ')).not.toContain('gho_deliverbot');
    expect(call!.env).toMatchObject({
      GH_TOKEN: 'gho_deliverbot', GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
    });
    // A commit target fetches every branch, as `git fetch origin` does.
    await pinnedGitExec(async () => 'deliverbot', git, exec, {})(['fetch', 'origin'], root);
    expect(calls[1]!.args.slice(-2)).toEqual(['https://github.com/acme/private-app.git', '+refs/heads/*:refs/remotes/origin/*']);
  });

  it('hands real git the token through its one-command helper only, never asking the helper the host configured', () => {
    const root = checkout('https://github.com/acme/private-app.git');
    // A complete credential, so git would stop at it were it asked; it leaves a mark when it is.
    const asked = join(root, 'host-helper-asked');
    execFileSync('git', ['config', 'credential.helper', `!touch '${asked}'; echo username=host-login; echo password=host-login-token; :`], { cwd: root });
    const { git, calls } = fakeGit();
    return pinnedGitExec(async () => null, git, fakeGh({}).exec, { GH_TOKEN: 'exported' })(['fetch', 'origin', 'main'], root).then(() => {
      const [call] = calls;
      // The same -c options and environment, asked for the credential a fetch of github.com would use.
      const opts = call!.args.slice(0, call!.args.indexOf('fetch'));
      const out = execFileSync('git', [...opts, 'credential', 'fill'], {
        cwd: root, encoding: 'utf8', input: 'protocol=https\nhost=github.com\npath=acme/private-app.git\n\n', env: { ...process.env, ...call!.env },
      });
      expect(out).toContain('username=x-access-token');
      expect(out).toContain('password=exported');
      expect(out).not.toContain('host-login');
      expect(existsSync(asked)).toBe(false);
    });
  });

  it('refuses a url.*.insteadOf that rewrites the canonical URL, fetching nothing (xreview r1)', async () => {
    const root = checkout('git@github.com:acme/private-app.git');
    // The shape `git config --get-regexp` prints: `<key> <value>`.
    const { git, calls } = fakeGit('url.https://other-login:tok@github.com/.insteadof https://github.com/\n');
    const out = await pinnedGitExec(async () => 'deliverbot', git, fakeGh({ deliverbot: 'gho_deliverbot' }).exec, {})(['fetch', 'origin'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('url.*.insteadOf');
    expect(calls).toEqual([]);
    // A rewrite of another host does not apply.
    const other = fakeGit('url.https://mirror.example/.insteadof https://gitlab.com/\n');
    expect((await pinnedGitExec(async () => 'deliverbot', other.git, fakeGh({ deliverbot: 'gho_deliverbot' }).exec, {})(['fetch', 'origin'], root)).code).toBe(0);
    expect(other.calls).toHaveLength(1);
  });

  it('runs no repository hook with the token in its environment (real git, xreview r1)', async () => {
    // A repository whose core.hooksPath holds a reference-transaction hook that would record its environment.
    const root = checkout('https://github.com/acme/private-app.git');
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    const ran = join(root, 'hook-ran');
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\nenv > '${ran}'\n`);
    chmodSync(join(hooks, 'reference-transaction'), 0o755);
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: root });
    const { git, calls } = fakeGit();
    await pinnedGitExec(async () => null, git, fakeGh({}).exec, { GH_TOKEN: 'exported' })(['fetch', 'origin', 'main'], root);
    const opts = calls[0]!.args.slice(0, calls[0]!.args.indexOf('fetch'));
    // The same -c options on a ref update that fires reference-transaction: the hook never runs.
    execFileSync('git', [...opts, 'update-ref', 'refs/remotes/origin/main', execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: root, input: 'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\n\nx\n', encoding: 'utf8',
    }).trim()], { cwd: root, env: { ...process.env, ...calls[0]!.env } });
    expect(existsSync(ran)).toBe(false);
    // Without them the hook does run (the fixture is live).
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: root });
    expect(existsSync(ran)).toBe(true);
  });

  it('runs every other git command, and a fetch with nothing to pin, as it is', async () => {
    const github = checkout('https://github.com/acme/private-app.git');
    for (const [root, identity, args] of [
      [github, 'deliverbot', ['rev-parse', '--verify', '-q', 'origin/main^{commit}']],
      [github, null, ['fetch', 'origin', 'main']],
      [checkout('https://gitlab.com/acme/private-app.git'), 'deliverbot', ['fetch', 'origin']],
      [github, 'deliverbot', ['fetch', 'origin', '-bad']],
    ] as const) {
      const { git, calls } = fakeGit();
      await pinnedGitExec(async () => identity, git, fakeGh({ deliverbot: 'gho_deliverbot' }).exec, {})([...args], root);
      expect(calls).toEqual([{ args: [...args], cwd: root, env: undefined }]);
    }
  });

  it('fails the fetch by name, running nothing, when the identity has no token', async () => {
    const root = checkout('https://github.com/acme/private-app.git');
    const { git, calls } = fakeGit();
    const out = await pinnedGitExec(async () => 'deliverbot', git, fakeGh({}).exec, {})(['fetch', 'origin'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('gh holds no token for deliverbot');
    expect(calls).toEqual([]);
  });
});
