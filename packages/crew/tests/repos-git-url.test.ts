// studio#1012: GET /repos carries each registration's `git_url`, read from its checkout's `origin` (the engine records
// none for its own clones), credentials and query removed; a checkout with no origin has no field. Real `git`, no daemon.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { removeScratch } from './setup/scratch.js';

// Spelled in pieces so no secret scanner reads a fake credential as a real one (as deliver-target-names-repo.test.ts).
const USERPASS_URL = ['https://', 'x-access-token', ':', 'ghp_SECRETPASS111', '@github.com/acme/userpass.git'].join('');
const TOKEN_URL = ['https://', 'ghp_SECRETTOKEN222', '@github.com/acme/token.git'].join('');
// Spellings `withoutCredentials` can't read: a remote-helper address and a query on an scp address (never shown at all).
const HELPER_URL = ['https::https://', 'x-access-token', ':', 'ghp_SECRETHELPER555', '@github.com/acme/helper.git'].join('');
const SCP_QUERY_URL = 'git@github.com:acme/scpq.git?access_token=SECRETSCPQ666';

let scratch: string;
const apps: FastifyInstance[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-repos-git-url-'));
  // No host `insteadOf` rewrite or system config may change what `git remote get-url` prints.
  const gitconfig = join(scratch, 'gitconfig');
  writeFileSync(gitconfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});
afterAll(() => {
  vi.unstubAllEnvs();
  removeScratch(scratch);
});

/** A git checkout under the scratch dir, with `origin` set to `origin` (none when `null`). */
function checkout(name: string, origin: string | null): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', dir]);
  if (origin !== null) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

const entry = (id: string, root: string, extra: Partial<RepoEntry> = {}): RepoEntry =>
  ({ id, name: id, root_path: root, default_branch: 'main', registered_at: 1, ...extra });

function routes(repos: RepoEntry[]) {
  const adapter = { listRepos: vi.fn(async () => repos) };
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined });
  apps.push(app);
  return app;
}

async function listed(app: FastifyInstance): Promise<{ raw: string; repos: Array<Record<string, unknown>> }> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/repos' });
  expect(res.statusCode).toBe(200);
  return { raw: res.body, repos: (res.json() as { repos: Array<Record<string, unknown>> }).repos };
}

describe('GET /api/v1/repos — git_url from the checkout origin', () => {
  it('https, scp-ssh and ssh:// origins pass through; credentials, query and fragment are removed; no origin = no field', async () => {
    const repos = [
      entry('https', checkout('https', 'https://github.com/acme/https-repo.git')),
      entry('scp', checkout('scp', 'git@github.com:acme/scp-repo.git')),
      entry('ssh', checkout('ssh', 'ssh://git@github.com/acme/ssh-repo.git')),
      entry('gitssh', checkout('gitssh', 'git+ssh://alice@git.example.com/team/gitssh.git')),
      entry('userpass', checkout('userpass', USERPASS_URL)),
      entry('token', checkout('token', TOKEN_URL)),
      entry('query', checkout('query', 'https://github.com/acme/query.git?access_token=SECRETQUERY333#SECRETFRAG777')),
      entry('helper', checkout('helper', HELPER_URL)),
      entry('scpq', checkout('scpq', SCP_QUERY_URL)),
      entry('none', checkout('none', null)),
      entry('gone', join(scratch, 'not-there')),
    ];
    const { raw, repos: out } = await listed(routes(repos));
    const byId = Object.fromEntries(out.map((r) => [String(r['id']), r]));
    expect(byId['https']!['git_url']).toBe('https://github.com/acme/https-repo.git');
    expect(byId['scp']!['git_url']).toBe('git@github.com:acme/scp-repo.git');
    expect(byId['ssh']!['git_url']).toBe('ssh://git@github.com/acme/ssh-repo.git');
    // git's ssh alias keeps its login: on such a server the user names the account.
    expect(byId['gitssh']!['git_url']).toBe('git+ssh://alice@git.example.com/team/gitssh.git');
    expect(byId['userpass']!['git_url']).toBe('https://github.com/acme/userpass.git');
    expect(byId['token']!['git_url']).toBe('https://github.com/acme/token.git');
    expect(byId['query']!['git_url']).toBe('https://github.com/acme/query.git');
    // Fail closed: an address the stripper can't vouch for is not sent.
    expect(byId['helper']).not.toHaveProperty('git_url');
    expect(byId['scpq']).not.toHaveProperty('git_url');
    expect(byId['none']).not.toHaveProperty('git_url');
    expect(byId['gone']).not.toHaveProperty('git_url');
    // Every other field is the engine's own, unchanged.
    expect(byId['none']).toEqual(repos[9]);
    expect(out).toHaveLength(repos.length);
    expect(raw).not.toMatch(/SECRET|ghp_|x-access-token|access_token/);
  });

  it('a git_url the engine recorded takes precedence over the origin, its credentials removed; a blank one falls back', async () => {
    const recorded = entry('recorded', checkout('recorded', 'https://github.com/acme/from-origin.git'), { git_url: ['https://', 'ghp_SECRETREC444', '@github.com/acme/recorded.git'].join('') });
    const blank = entry('blank', checkout('blank', 'https://github.com/acme/blank.git'), { git_url: '   ' });
    const unsafe = entry('unsafe', checkout('unsafe', 'https://github.com/acme/unsafe.git'), { git_url: HELPER_URL });
    const { raw, repos: out } = await listed(routes([recorded, blank, unsafe]));
    expect(out[0]!['git_url']).toBe('https://github.com/acme/recorded.git');
    expect(out[1]!['git_url']).toBe('https://github.com/acme/blank.git');
    expect(out[2]).not.toHaveProperty('git_url');
    expect(raw).not.toMatch(/SECRET|ghp_|x-access-token/);
  });

  it('holds each origin a minute, then reads it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = checkout('moved', 'https://github.com/acme/before.git');
    const app = routes([entry('moved', root)]);
    expect((await listed(app)).repos[0]!['git_url']).toBe('https://github.com/acme/before.git');
    execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://github.com/acme/after.git']);
    expect((await listed(app)).repos[0]!['git_url']).toBe('https://github.com/acme/before.git');
    vi.setSystemTime(Date.now() + 61_000);
    expect((await listed(app)).repos[0]!['git_url']).toBe('https://github.com/acme/after.git');
  });

  it('drops a checkout that is no longer registered from the cache', async () => {
    const root = checkout('churn', 'https://github.com/acme/first.git');
    const registry = [entry('churn', root)];
    const app = routes(registry);
    expect((await listed(app)).repos[0]!['git_url']).toBe('https://github.com/acme/first.git');
    execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://github.com/acme/second.git']);
    registry.pop();
    expect((await listed(app)).repos).toEqual([]);
    // Registered again within the minute: read afresh, not the held value.
    registry.push(entry('churn', root));
    expect((await listed(app)).repos[0]!['git_url']).toBe('https://github.com/acme/second.git');
  });
});
