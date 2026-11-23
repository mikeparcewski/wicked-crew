// crew#1839 — Add a repository → From a URL clones an Azure DevOps repository with the daemon's Azure DevOps
// credential, the way the deliver phase pushes: the header is minted by the deliver helper and reaches the ONE clone
// through GIT_CONFIG_* (never argv, never the clone's .git/config, never a message), the registered origin carries no
// userinfo, and a daemon without the credential is refused in words that name it.
//
// Azure DevOps is a loopback git smart-HTTP server (`git http-backend`) that refuses any request without the PAT's
// Basic header, as in deliver-provider-credentials.test.ts. The production URL is re-pointed at it through the clone's
// `target` seam (the rest of `adoRepoOf`'s answer, the canonical shape, is kept).

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerFailure } from '../src/api/repo-input.js';
import { adoRepoOf } from '../src/core/deliver-credentials.js';
import { defaultAdoHelperExec, type AdoHelperExec } from '../src/core/deliver.js';
import { ADO_CLONE_NO_CREDENTIAL, ADO_CLONE_REFUSED, adoCloneEnv, cloneRepository, type AdoCloneSeam } from '../src/core/repo-clone.js';

const PAT = 'pat-SECRET-0123456789abcdef'; // ggignore: a made-up test value, never a real token
const BASIC = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
const ENV = ['AZURE_DEVOPS_EXT_PAT', 'CREW_ADO_TENANT_ID', 'CREW_ADO_CLIENT_ID', 'CREW_ADO_CLIENT_SECRET'];

const roots: string[] = [];
const servers: Array<{ server: Server; closed: Promise<void>[] }> = [];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  for (const n of ENV) delete process.env[n];
  process.env['AZURE_DEVOPS_EXT_PAT'] = PAT;
});
afterEach(async () => {
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  for (const { server, closed } of servers.splice(0)) {
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all(closed);
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Fx {
  root: string;
  url: string;
  gitUrl: string;
  auths: string[];
  /** The paths the server was asked for. */
  paths: string[];
  /** A HOME with no git config, so no host credential helper answers for the loopback. */
  env: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

/** A bare repo served at `<loopback>/org/proj/_git/repo`, refusing any request without the PAT's header. */
async function fixture(): Promise<Fx> {
  const root = mkdtempSync(join(tmpdir(), 'crew-1839-'));
  roots.push(root);
  const bare = join(root, 'srv', 'org', 'proj', '_git', 'repo');
  const seed = join(root, 'seed');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), 'tiny-math\n');
  // The repository selects a filter for its README (a host whose config defines `leak` runs it at checkout).
  writeFileSync(join(seed, '.gitattributes'), 'README.md filter=leak\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', bare, 'main');
  const auths: string[] = [];
  const paths: string[] = [];
  const closed: Promise<void>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? '');
      auths.push(auth);
      paths.push(u.pathname);
      // A repository that moved: a redirect to where it is now (the clone must not follow it).
      if (u.pathname.startsWith('/moved/')) {
        res.writeHead(301, { location: `${u.pathname.slice('/moved'.length)}${u.search}` });
        res.end();
        return;
      }
      if (auth !== BASIC) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="ado"' });
        res.end('unauthorized');
        return;
      }
      const cgi = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: join(root, 'srv'),
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.replace(/^\?/, ''),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
          REMOTE_USER: 'crew',
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      closed.push(new Promise<void>((resolve) => cgi.once('close', () => resolve())));
      cgi.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') throw error;
      });
      const out: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => out.push(c));
      cgi.on('close', () => {
        const all = Buffer.concat(out);
        const sep = all.indexOf('\r\n\r\n');
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of all.subarray(0, sep).toString('utf8').split('\r\n')) {
          const at = line.indexOf(':');
          if (at < 0) continue;
          const k = line.slice(0, at).trim();
          const v = line.slice(at + 1).trim();
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
          else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(sep + 4));
      });
      cgi.stdin.end(Buffer.concat(chunks));
    });
  });
  servers.push({ server, closed });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // No Azure DevOps credential in it: a test hands its own.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: home };
  for (const n of ENV) delete env[n];
  return { root, url, gitUrl: `${url}/org/proj/_git/repo`, auths, paths, env };
}

/** The production reading of the URL, its git URL and login base re-pointed at the loopback. */
function seam(fx: Fx, minted: string[][] = []): AdoCloneSeam {
  const exec: AdoHelperExec = (args, opts) => {
    minted.push(args);
    return defaultAdoHelperExec(args, opts);
  };
  return {
    target: (u) => {
      const real = adoRepoOf(u);
      return real === null ? null : { ...real, gitUrl: fx.gitUrl, loginBase: fx.url };
    },
    exec,
    env: { ...fx.env, AZURE_DEVOPS_EXT_PAT: process.env['AZURE_DEVOPS_EXT_PAT'] ?? '' },
  };
}

/** A hook or filter's record of what it ran with: a line saying it ran, and only the variables that could carry a sign-in
 *  (never the whole environment: a failing assertion prints what it compared). */
const RECORD = (file: string): string => `{ echo ran; env | grep -iE '^(GIT_CONFIG|AZURE_DEVOPS|CREW_ADO)' || true; } >> '${file}'\n`;

function expectNoSecret(text: string): void {
  for (const s of [PAT, Buffer.from(`:${PAT}`).toString('base64')]) expect(text).not.toContain(s);
}

describe('crew#1839 From a URL on Azure DevOps', () => {
  it('each spelling Azure DevOps hands out clones with the daemon\'s PAT; origin has no userinfo; nothing is kept in .git/config', async () => {
    const fx = await fixture();
    const spellings = [
      'https://someone@dev.azure.com/org/proj/_git/repo',
      'https://org.visualstudio.com/DefaultCollection/proj/_git/repo',
      'git@ssh.dev.azure.com:v3/org/proj/repo',
      'org@vs-ssh.visualstudio.com:v3/org/proj/repo',
    ];
    for (const [i, spelling] of spellings.entries()) {
      const minted: string[][] = [];
      const dir = join(fx.root, `clone-${i}`);
      await cloneRepository(spelling, dir, { ado: seam(fx, minted) });
      expect(minted).toEqual([['header', fx.url]]);
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('tiny-math\n');
      // The clone is of the canonical URL: no userinfo, no ssh.
      expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe(fx.gitUrl);
      const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
      expect(config.toLowerCase()).not.toContain('extraheader');
      expect(config).not.toContain('Authorization');
      expectNoSecret(config);
    }
    // Every request the server answered carried the header (git asks unauthenticated first only when it has none).
    expect(fx.auths.length).toBeGreaterThan(0);
    expect(fx.auths.every((a) => a === BASIC)).toBe(true);
  }, 120_000);

  it('a daemon without an Azure DevOps credential is refused in words that name the credential to set', async () => {
    const fx = await fixture();
    delete process.env['AZURE_DEVOPS_EXT_PAT'];
    const minted: string[][] = [];
    const s = seam(fx, minted);
    const err = await cloneRepository(fx.gitUrl, join(fx.root, 'clone'), { ado: { ...s, env: { ...fx.env }, target: () => ({ ...adoRepoOf('https://dev.azure.com/org/proj/_git/repo')!, gitUrl: fx.gitUrl, loginBase: fx.url }) } }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(minted).toEqual([]);
    expect((err as Error).message.startsWith(ADO_CLONE_NO_CREDENTIAL)).toBe(true);
    expect((err as Error).message).toContain('AZURE_DEVOPS_EXT_PAT');
    const answer = registerFailure((err as Error).message, undefined, '/nonexistent-home', true);
    expect(answer.code).toBe('repo_clone_denied');
    expect(answer.error.startsWith('This daemon holds no Azure DevOps credential to clone it with: set AZURE_DEVOPS_EXT_PAT')).toBe(true);
    expect(answer.error).not.toContain("This computer's git sign-in");
  }, 60_000);

  it('a credential Azure DevOps refuses says so, and the token is in no message', async () => {
    const fx = await fixture();
    process.env['AZURE_DEVOPS_EXT_PAT'] = 'pat-wrong-0123456789'; // ggignore: a made-up test value
    const err = await cloneRepository('https://dev.azure.com/org/proj/_git/repo', join(fx.root, 'clone'), { ado: seam(fx) }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message.startsWith(`${ADO_CLONE_REFUSED} https://dev.azure.com/org/proj/_git/repo`)).toBe(true);
    expect(message).not.toContain('pat-wrong-0123456789');
    expect(message).not.toContain(Buffer.from(':pat-wrong-0123456789').toString('base64'));
    expect(registerFailure(message, undefined, '/nonexistent-home', true).code).toBe('repo_clone_denied');
  }, 60_000);

  it('a hook this computer\'s git config names runs, if at all, without the header or any credential in its environment', async () => {
    const fx = await fixture();
    // A host whose git config names a hooks folder: its hooks run on every clone, inside that git's environment.
    const hooks = join(fx.root, 'hooks');
    mkdirSync(hooks, { recursive: true });
    const leaked = join(fx.root, 'hook-saw-env.txt');
    for (const name of ['post-checkout', 'reference-transaction']) {
      writeFileSync(join(hooks, name), `#!/bin/sh\n${RECORD(leaked)}cat > /dev/null\n`);
      chmodSync(join(hooks, name), 0o755);
    }
    writeFileSync(join(fx.env['HOME']!, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('tiny-math\n');
    // The checkout's post-checkout hook ran (so the test can fail), and saw nothing it could sign in with.
    const seen = readFileSync(leaked, 'utf8');
    expect(seen).toContain('ran');
    expectNoSecret(seen);
    expect(seen.toLowerCase()).not.toContain('extraheader');
    expect(seen).not.toContain('Authorization');
    for (const n of ENV) expect(seen).not.toContain(`${n}=`);
  }, 60_000);

  it('a checkout filter the repository selects runs without the header or any credential in its environment', async () => {
    const fx = await fixture();
    const leaked = join(fx.root, 'filter-saw-env.txt');
    const filter = join(fx.root, 'leak.sh');
    writeFileSync(filter, `#!/bin/sh\n${RECORD(leaked)}cat\n`);
    chmodSync(filter, 0o755);
    writeFileSync(join(fx.env['HOME']!, '.gitconfig'), `[filter "leak"]\n\tsmudge = ${filter}\n`);
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('tiny-math\n');
    // The filter did run (so the test can fail), and saw nothing it could sign in with.
    const seen = readFileSync(leaked, 'utf8');
    expect(seen).toContain('ran');
    expectNoSecret(seen);
    expect(seen.toLowerCase()).not.toContain('extraheader');
    expect(seen).not.toContain('Authorization');
    for (const n of ENV) expect(seen).not.toContain(`${n}=`);
  }, 60_000);

  it('an empty repository clones, with nothing to check out', async () => {
    const fx = await fixture();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(fx.root, 'srv', 'org', 'proj', '_git', 'empty')]);
    const dir = join(fx.root, 'clone');
    const s = seam(fx);
    await cloneRepository('https://dev.azure.com/org/proj/_git/empty', dir, {
      ado: { ...s, target: (u) => ({ ...adoRepoOf(u)!, gitUrl: `${fx.url}/org/proj/_git/empty`, loginBase: fx.url }) },
    });
    expect(git(dir, 'remote', 'get-url', 'origin').trim()).toBe(`${fx.url}/org/proj/_git/empty`);
  }, 60_000);

  it('a redirect is refused even where this computer\'s git config follows redirects for that URL', async () => {
    const fx = await fixture();
    writeFileSync(join(fx.env['HOME']!, '.gitconfig'), `[http "${fx.url}/"]\n\tfollowRedirects = true\n`);
    const moved = `${fx.url}/moved/org/proj/_git/repo`;
    const s = seam(fx);
    const err = await cloneRepository('https://dev.azure.com/org/proj/_git/repo', join(fx.root, 'clone'), {
      ado: { ...s, target: (u) => ({ ...adoRepoOf(u)!, gitUrl: moved, loginBase: fx.url }) },
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expectNoSecret((err as Error).message);
    // Asked only at the old place: the redirect target never saw a request.
    expect(fx.paths.length).toBeGreaterThan(0);
    expect(fx.paths.every((p) => p.startsWith('/moved/'))).toBe(true);
  }, 60_000);

  it('the clone environment pins the header, redirects and hooks, and carries none of the raw credential variables', () => {
    const url = 'https://dev.azure.com/org/proj/_git/repo';
    const env = adoCloneEnv(
      { PATH: '/bin', AZURE_DEVOPS_EXT_PAT: PAT, CREW_ADO_TENANT_ID: 't', CREW_ADO_CLIENT_ID: 'c', CREW_ADO_CLIENT_SECRET: 'sp-secret', GIT_CONFIG_KEY_7: 'http.extraHeader', GIT_CONFIG_VALUE_7: 'x', GIT_CONFIG_PARAMETERS: "'http.extraheader'='y'" }, // ggignore: made-up test values
      url,
      BASIC,
    );
    for (const n of ENV) expect(env[n]).toBeUndefined();
    expect(env['GIT_CONFIG_KEY_7']).toBeUndefined();
    expect(env['GIT_CONFIG_PARAMETERS']).toBe('');
    const pairs = Array.from({ length: Number(env['GIT_CONFIG_COUNT']) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toEqual([
      ['http.extraHeader', ''],
      [`http.${url}.extraHeader`, ''],
      [`http.${url}.extraHeader`, `Authorization: ${BASIC}`],
      ['http.followRedirects', 'false'],
      [`http.${url}.followRedirects`, 'false'],
      ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ]);
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https');
    expect(env['PATH']).toBe('/bin');
  });

  it('a GitHub URL is cloned as before, with no Azure DevOps step', async () => {
    const minted: string[][] = [];
    const exec: AdoHelperExec = async (args) => (minted.push(args), { stdout: '', stderr: '', code: 1 });
    const root = mkdtempSync(join(tmpdir(), 'crew-1839-gh-'));
    roots.push(root);
    const bare = join(root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    // A local path stands in for the plain clone path; the point is that no header is minted for a non-ADO URL.
    await cloneRepository(bare, join(root, 'clone'), { ado: { exec } });
    expect(minted).toEqual([]);
  }, 60_000);
});
