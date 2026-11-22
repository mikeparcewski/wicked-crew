// crew#1792: crew's own PR reads (review-change's provenance read, the revision's resolvePullRequest) run as the
// deliver identity, in the deliver script's credential order, whatever account gh has active on the host.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedGhExec, resolvePullRequest, type GhExec } from '../src/core/deliver.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A registered checkout whose origin is `url`, made with git itself (the shape `readDeliverOriginUrl` reads). */
function checkout(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-1792-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  if (url !== null) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
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

  it('leaves gh as it is with an exported GH_TOKEN, no identity, or an origin that is not a github.com repository', async () => {
    const github = checkout('https://github.com/acme/private-app.git');
    for (const [root, identity, env] of [
      [github, 'deliverbot', { GH_TOKEN: 'exported' }],
      [github, null, {}],
      [checkout('https://gitlab.com/acme/private-app.git'), 'deliverbot', {}],
      [checkout(null), 'deliverbot', {}],
    ] as const) {
      const { exec, calls } = fakeGh({ deliverbot: 'gho_deliverbot' });
      await pinnedGhExec(async () => identity, exec, env)(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
      expect(calls).toEqual([{ args: ['pr', 'view', '33'], env: undefined }]);
    }
  });

  it('refuses an identity that is not a GitHub login before asking gh for anything', async () => {
    const root = checkout('https://github.com/acme/private-app.git');
    const { exec, calls } = fakeGh({});
    const out = await pinnedGhExec(async () => '--user=x', exec, {})(['pr', 'view', '33'], { cwd: root, timeoutMs: 5000 });
    expect(out.code).toBe(1);
    expect(calls).toEqual([]);
  });
});
