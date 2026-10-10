// crew#899: a chat's checkout is brought to its upstream when that is safe, and its staleness is
// told to the seats when it is not. Real git over a scratch origin + clone; no network.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freshenCheckout, freshnessClause, nonInteractiveGitEnv } from '../src/api/chat-freshness.js';
import { chatScopeStatement } from '../src/api/chat-scope.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

describe('freshenCheckout (crew#899)', () => {
  let base: string;
  let origin: string;
  let clone: string;
  let upstreamWork: string;

  const commitUpstream = (n: number): void => {
    for (let i = 0; i < n; i++) {
      writeFileSync(join(upstreamWork, `f${Date.now()}-${i}.txt`), String(i));
      git(upstreamWork, 'add', '-A');
      git(upstreamWork, 'commit', '-q', '-m', `up ${i}`);
    }
    git(upstreamWork, 'push', '-q', 'origin', 'main');
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'chat-fresh-'));
    origin = join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    upstreamWork = join(base, 'up');
    git(base, 'clone', '-q', origin, upstreamWork);
    git(upstreamWork, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(upstreamWork, 'README.md'), 'v0');
    git(upstreamWork, 'add', '-A');
    git(upstreamWork, 'commit', '-q', '-m', 'init');
    git(upstreamWork, 'push', '-q', '-u', 'origin', 'main');
    clone = join(base, 'checkout');
    git(base, 'clone', '-q', origin, clone);
  }, 120_000);

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('codex retro on #902: the git env never prompts — askpass answers nothing, GCM never interacts, ssh is batch mode on top of the operator\'s own command', () => {
    const env = nonInteractiveGitEnv({ PATH: '/bin', GIT_ASKPASS: '/usr/local/bin/gui-askpass', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/k' });
    expect(env).toMatchObject({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/k -o BatchMode=yes' });
    expect(nonInteractiveGitEnv({})['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');
  });

  it('a checkout already at its upstream is current', async () => {
    expect(await freshenCheckout(clone)).toEqual({ state: 'current', upstream: 'origin/main' });
  }, 120_000);

  it('a clean checkout behind its upstream is fast-forwarded, and the seats are told', async () => {
    commitUpstream(3);
    const f = await freshenCheckout(clone);
    expect(f).toEqual({ state: 'refreshed', upstream: 'origin/main', commits: 3 });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(upstreamWork, 'rev-parse', 'HEAD'));
    expect(freshnessClause(f)).toMatch(/fast-forwarded 3 commit\(s\) to `origin\/main`/);
  }, 120_000);

  it('the fast-forward runs no hooks of the checkout, and a remote named with a slash is fetched by its name (codex on #902)', async () => {
    git(clone, 'remote', 'rename', 'origin', 'team/origin');
    commitUpstream(1);
    const marker = join(base, 'hook-ran');
    const hook = join(clone, '.git', 'hooks', 'post-merge');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const f = await freshenCheckout(clone);
    expect(f).toEqual({ state: 'refreshed', upstream: 'team/origin/main', commits: 1 });
    expect(existsSync(marker)).toBe(false);
  }, 120_000);

  it('a DIRTY checkout is never moved: stale, with how far behind and why', async () => {
    commitUpstream(2);
    writeFileSync(join(clone, 'README.md'), 'local edit');
    const before = git(clone, 'rev-parse', 'HEAD');
    const f = await freshenCheckout(clone);
    expect(f).toMatchObject({ state: 'stale', upstream: 'origin/main', behind: 2, reason: 'the working tree has uncommitted changes' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(clone, 'status', '--porcelain')).toContain('README.md');
    expect(freshnessClause(f)).toMatch(/STALE: 2 commit\(s\) behind `origin\/main`, not refreshed/);
  }, 120_000);

  it('a branch with commits of its own is never moved', async () => {
    commitUpstream(1);
    writeFileSync(join(clone, 'mine.txt'), 'x');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'mine');
    const f = await freshenCheckout(clone);
    expect(f).toMatchObject({ state: 'stale', behind: 1, reason: 'the branch has 1 commit(s) of its own' });
  }, 120_000);

  it('a directory that is not a checkout top level says nothing', async () => {
    expect(await freshenCheckout(base)).toEqual({ state: 'unknown' });
    expect(freshnessClause({ state: 'unknown' })).toBe('');
  }, 120_000);

  it('the scope statement carries the clause on the repository line', () => {
    const text = chatScopeStatement('c899', {
      kind: 'repos',
      repos: [{ id: 'r1', name: 'alpha', rootPath: '/srv/alpha', freshness: { state: 'stale', upstream: 'origin/main', behind: 174, reason: 'the working tree has uncommitted changes' } }],
      cwd: join(tmpdir(), 'c899'),
      graph: { bound: false, reason: 'nothing to bind' },
      dangling: [],
    });
    expect(text).toContain('- **alpha** (`r1`): `/srv/alpha` (STALE: 174 commit(s) behind `origin/main`');
  });
});
