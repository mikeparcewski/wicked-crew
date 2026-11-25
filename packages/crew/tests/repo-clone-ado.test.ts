// crew#1839 — Add a repository → From a URL clones an Azure DevOps repository with the daemon's Azure DevOps
// credential, the way the deliver phase pushes: the header is minted by the deliver helper and reaches the ONE clone
// through GIT_CONFIG_* (never argv, never the clone's .git/config, never a message), the registered origin carries no
// userinfo, and a daemon without the credential is refused in words that name it.
//
// Azure DevOps is a loopback git smart-HTTP server (`git http-backend`) that refuses any request without the PAT's
// Basic header, as in deliver-provider-credentials.test.ts. The production URL is re-pointed at it through the clone's
// `target` seam (the rest of `adoRepoOf`'s answer, the canonical shape, is kept).

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerFailure } from '../src/api/repo-input.js';
import { adoRepoOf } from '../src/core/deliver-credentials.js';
import { defaultAdoHelperExec, type AdoHelperExec } from '../src/core/deliver.js';
import { ADO_CLONE_LFS_FAILED, ADO_CLONE_NO_CREDENTIAL, ADO_CLONE_REFUSED, adoCloneEnv, cloneRepository, lfsFetchScope, type AdoCloneSeam } from '../src/core/repo-clone.js';

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
  /** (crew#1842) The Authorization header of each LFS batch request, and of each object download. */
  lfsBatchAuths: string[];
  lfsDownloadAuths: string[];
}

/** (crew#1842) The one Git LFS object the LFS fixture stores, as git-lfs's pointer spec (v1) names it. */
const LFS_CONTENT = 'a large binary file, stored in Git LFS\n';
const LFS_OID = createHash('sha256').update(LFS_CONTENT).digest('hex');
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID}\nsize ${Buffer.byteLength(LFS_CONTENT)}\n`;
/** The object store's own per-download token, handed out in the batch answer (as Azure DevOps hands one out). */
/** (crew#1863) An LFS object the fixture's server does not hold, so only a fetch that leaves it out can succeed. */
const LFS_EXCLUDED_CONTENT = 'a large file this clone leaves out on purpose\n';
const LFS_EXCLUDED_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(LFS_EXCLUDED_CONTENT).digest('hex')}\nsize ${Buffer.byteLength(LFS_EXCLUDED_CONTENT)}\n`;
const LFS_OBJECT_TOKEN = 'object-token-0123'; // ggignore: a made-up test value
/** What `git lfs install` writes to a host's global git config (git-lfs `lfs/attribute.go`, the `filter.lfs` keys). */
const LFS_INSTALL_CONFIG = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n';
const HAS_GIT_LFS = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

/** A bare repo served at `<loopback>/org/proj/_git/repo`, refusing any request without the PAT's header. With `lfs`, its
 *  commit stores `big.bin` in Git LFS: the batch endpoint (`<repo>.git/info/lfs/objects/batch`, behind the header too)
 *  sends downloads to an object path of its own that takes only the batch answer's token. */
async function fixture(opts: { lfs?: boolean; lfsRefuse?: boolean; lfsconfig?: string; lfsName?: string; lfsExcluded?: string; lfsUnserved?: string; lfsFetchInclude?: string } = {}): Promise<Fx> {
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
  writeFileSync(join(seed, '.gitattributes'), `README.md filter=leak\n${opts.lfs === true ? '*.bin filter=lfs diff=lfs merge=lfs -text\n' : ''}`);
  if (opts.lfs === true) writeFileSync(join(seed, opts.lfsName ?? 'big.bin'), LFS_POINTER);
  // (crew#1863) A second LFS file, whose object the server does not have, that the repository's `.lfsconfig` leaves out.
  if (opts.lfsExcluded !== undefined) writeFileSync(join(seed, opts.lfsExcluded), LFS_EXCLUDED_POINTER);
  // The same unserved object, at a path only a fetch filter (`lfsFetchInclude`) can leave out.
  if (opts.lfsUnserved !== undefined) {
    mkdirSync(join(seed, opts.lfsUnserved, '..'), { recursive: true });
    writeFileSync(join(seed, opts.lfsUnserved), LFS_EXCLUDED_POINTER);
  }
  // A repository may carry its own LFS endpoint (`.lfsconfig`); the credentialed download must not follow it.
  const lfsconfig = [
    ...(opts.lfsconfig !== undefined ? [`\turl = ${opts.lfsconfig}`] : []),
    ...(opts.lfsExcluded !== undefined ? [`\tfetchexclude = ${opts.lfsExcluded}`] : []),
    ...(opts.lfsFetchInclude !== undefined ? [`\tfetchinclude = ${opts.lfsFetchInclude}`] : []),
  ];
  if (lfsconfig.length > 0) writeFileSync(join(seed, '.lfsconfig'), `[lfs]\n${lfsconfig.join('\n')}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  // No hook: a host that ran `git lfs install` has a pre-push hook that would try to upload the LFS object to the bare repo.
  git(seed, '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, 'push', '-q', bare, 'main');
  const auths: string[] = [];
  const paths: string[] = [];
  const lfsBatchAuths: string[] = [];
  const lfsDownloadAuths: string[] = [];
  let base = '';
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
      if (u.pathname === `/lfs-objects/${LFS_OID}`) {
        lfsDownloadAuths.push(auth);
        if (opts.lfs !== true || opts.lfsRefuse === true || req.headers['x-object-token'] !== LFS_OBJECT_TOKEN) {
          res.writeHead(403);
          res.end('no token');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(LFS_CONTENT);
        return;
      }
      if (u.pathname.endsWith('/info/lfs/objects/batch')) lfsBatchAuths.push(auth);
      if (auth !== BASIC) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="ado"' });
        res.end('unauthorized');
        return;
      }
      if (opts.lfs === true && u.pathname === '/org/proj/_git/repo.git/info/lfs/objects/batch') {
        const asked = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { objects: Array<{ oid: string; size: number }> };
        res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
        res.end(JSON.stringify({
          transfer: 'basic',
          objects: asked.objects.map((o) => ({
            oid: o.oid, size: o.size, authenticated: true,
            actions: { download: { href: `${base}/lfs-objects/${o.oid}`, header: { 'X-Object-Token': LFS_OBJECT_TOKEN }, expires_in: 3600 } },
          })),
        }));
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
  base = url;
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // No Azure DevOps credential in it: a test hands its own.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: home };
  for (const n of ENV) delete env[n];
  return { root, url, gitUrl: `${url}/org/proj/_git/repo`, auths, paths, env, lfsBatchAuths, lfsDownloadAuths };
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

  // (crew#1842) Runs wherever git-lfs is installed, and always in CI (whose runners carry it): there a missing git-lfs
  // fails the test instead of skipping it.
  it.skipIf(!HAS_GIT_LFS && process.env['CI'] === undefined)('a Git LFS file this host has not cached is downloaded with the header, which reaches only the repository\'s own LFS endpoint (crew#1842)', async () => {
    // The repository names another LFS endpoint: an unreachable one, so following it would fail the clone.
    const fx = await fixture({ lfs: true, lfsconfig: 'http://127.0.0.1:9/elsewhere/info/lfs' });
    // The host ran `git lfs install`: a checkout smudges LFS files, and the filter is required. Its config also names a
    // standalone transfer program, which would be handed the header's environment if the download used it.
    const spy = join(fx.root, 'transfer-spy.sh');
    const spied = join(fx.root, 'transfer-spy-ran.txt');
    writeFileSync(spy, `#!/bin/sh\n${RECORD(spied)}exit 1\n`);
    chmodSync(spy, 0o755);
    writeFileSync(join(fx.env['HOME']!, '.gitconfig'), `${LFS_INSTALL_CONFIG}[lfs]\n\tstandalonetransferagent = spy\n[lfs "customtransfer.spy"]\n\tpath = ${spy}\n`);
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe(LFS_CONTENT);
    expect(existsSync(spied)).toBe(false);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('tiny-math\n');
    // The batch request carried the header; the object store, at a path outside the header's scope, never saw it.
    expect(fx.lfsBatchAuths.length).toBeGreaterThan(0);
    expect(fx.lfsBatchAuths.every((a) => a === BASIC)).toBe(true);
    expect(fx.lfsDownloadAuths).toEqual(['']);
    // The working tree is clean (the LFS file is the object, not a pointer git sees as modified) and nothing was kept:
    // not in .git/config, and no git-lfs log (which records its environment) is left.
    expect(execFileSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], { cwd: dir, env: { ...process.env, ...fx.env }, encoding: 'utf8' }).trim()).toBe('');
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
    expect(config.toLowerCase()).not.toContain('extraheader');
    expectNoSecret(config);
    expect(existsSync(join(dir, '.git', 'lfs', 'logs'))).toBe(false);
  }, 120_000);

  it.skipIf(!HAS_GIT_LFS && process.env['CI'] === undefined)('a host with git-lfs but no `git lfs install` still gets the real file, a clean tree, and a pointer when the file is staged again (review r1, r2)', async () => {
    const fx = await fixture({ lfs: true });
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe(LFS_CONTENT);
    const run = (...args: string[]): string => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: dir, env: { ...process.env, ...fx.env }, encoding: 'utf8' });
    expect(run('status', '--porcelain').trim()).toBe('');
    // The filter lives in the repository's own config, so a later edit is stored in LFS, not as the binary.
    writeFileSync(join(dir, 'big.bin'), 'an edited large file\n');
    run('add', 'big.bin');
    expect(run('cat-file', '-p', ':big.bin').startsWith('version https://git-lfs.github.com/spec/v1')).toBe(true);
  }, 120_000);

  it.skipIf(!HAS_GIT_LFS && process.env['CI'] === undefined)('an LFS download that fails says what to check, carries no token, and leaves the folder empty for another try (review r1)', async () => {
    const fx = await fixture({ lfs: true, lfsRefuse: true });
    const dir = join(fx.root, 'clone');
    mkdirSync(dir);
    const err = await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith(`${ADO_CLONE_LFS_FAILED} https://dev.azure.com/org/proj/_git/repo with the daemon's Azure DevOps credential. Check that`)).toBe(true);
    expectNoSecret((err as Error).message);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  }, 120_000);

  // (crew#1863) git-lfs marks each `ls-files` line with `*` (written) or `-` (a pointer); a name holding " - " is a name.
  it.skipIf(!HAS_GIT_LFS && process.env['CI'] === undefined)('an LFS file whose name contains " - " is written, and the clone succeeds (crew#1863)', async () => {
    const fx = await fixture({ lfs: true, lfsName: 'Song - Remix.bin' });
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'Song - Remix.bin'), 'utf8')).toBe(LFS_CONTENT);
  }, 120_000);

  it.skipIf(!HAS_GIT_LFS && process.env['CI'] === undefined)('an LFS file the repository\'s lfs.fetchexclude leaves out stays a pointer, and the clone succeeds (crew#1863)', async () => {
    const fx = await fixture({ lfs: true, lfsExcluded: 'skipped.bin' });
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: seam(fx) });
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe(LFS_CONTENT);
    expect(readFileSync(join(dir, 'skipped.bin'), 'utf8')).toBe(LFS_EXCLUDED_POINTER);
  }, 120_000);

  // (crew#1863 review r1b) git-lfs matches the filters under `core.ignorecase`. The fetch's environment drops the one the
  // daemon inherited, so the check must too; Linux only, where a clone's own `core.ignorecase` is false.
  it.skipIf(process.platform !== 'linux' || (!HAS_GIT_LFS && process.env['CI'] === undefined))('the pointer check matches the fetch filters under the fetch\'s own config, not an inherited core.ignorecase (crew#1863)', async () => {
    const fx = await fixture({ lfs: true, lfsUnserved: 'assets/skipped.bin', lfsFetchInclude: 'big.bin,ASSETS/**' });
    const s = seam(fx);
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: { ...s, env: { ...s.env, GIT_CONFIG_PARAMETERS: "'core.ignorecase=true'" } } });
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe(LFS_CONTENT);
    expect(readFileSync(join(dir, 'assets', 'skipped.bin'), 'utf8')).toBe(LFS_EXCLUDED_POINTER);
  }, 120_000);

  // (crew#1863 review r1) The filters are read as git-lfs reads them, in the environment the fetch ran in.
  it('the pointer check reads the fetch filters as git-lfs does: .lfsconfig includes, an empty git setting, no inherited GIT_CONFIG_* (crew#1863)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-1863-scope-'));
    roots.push(root);
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    execFileSync('git', ['init', '-q', repo]);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
    // `.lfsconfig` names its exclusion through an include, which git-lfs follows (`config --includes`).
    writeFileSync(join(repo, '.lfsconfig'), '[include]\n\tpath = lfs-extra.config\n[lfs]\n\tfetchinclude = assets/**\n');
    writeFileSync(join(repo, 'lfs-extra.config'), '[lfs]\n\tfetchexclude = skipped.bin\n');
    expect(await lfsFetchScope(repo, env)).toEqual(['--include=assets/**', '--exclude=skipped.bin']);
    // git's own config wins over `.lfsconfig`, even set empty (git-lfs reads the last value); a valueless entry is no
    // value at all, so `.lfsconfig`'s stands (git-lfs skips it, review r1b).
    writeFileSync(join(home, '.gitconfig'), '[lfs]\n\tfetchinclude =\n\tfetchexclude\n');
    expect(await lfsFetchScope(repo, env)).toEqual(['--exclude=skipped.bin']);
    // An entry the daemon inherited never reached the fetch (`adoCloneEnv` drops them), so it does not count here.
    const inherited = { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'lfs.fetchexclude', GIT_CONFIG_VALUE_0: 'other.bin', GIT_CONFIG_PARAMETERS: "'lfs.fetchinclude=else/**'" };
    expect(await lfsFetchScope(repo, inherited)).toEqual(['--exclude=skipped.bin']);
    writeFileSync(join(home, '.gitconfig'), '[lfs]\n\tfetchexclude =\n');
    expect(await lfsFetchScope(repo, env)).toEqual(['--include=assets/**']);
  });

  // (crew#1864) git translates "is not a git command" (help.c `_()`). This git answers in German, as gettext would for its
  // locale, and has no git-lfs: the clone keeps the pointers, as on any host without git-lfs.
  it.skipIf(process.platform === 'win32')('a host without git-lfs whose git speaks German still clones a repository with LFS files, leaving pointers (crew#1864)', async () => {
    const fx = await fixture({ lfs: true });
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = join(fx.root, 'git-de');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'if [ "$1" = lfs ]; then',
      '  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in',
      '    C|C.*|POSIX|"") echo "git: \'lfs\' is not a git command. See \'git --help\'." >&2;;',
      '    *) echo "git: \'lfs\' ist kein Git-Befehl. Siehe \'git --help\'." >&2;;',
      '  esac',
      '  exit 1',
      'fi',
      `exec '${realGit}' "$@"`,
    ].join('\n'));
    chmodSync(join(bin, 'git'), 0o755);
    const s = seam(fx);
    const env: NodeJS.ProcessEnv = { ...s.env, PATH: `${bin}:${s.env!['PATH'] ?? ''}`, LANG: 'de_DE.UTF-8', LANGUAGE: 'de' };
    delete env['LC_ALL'];
    delete env['LC_MESSAGES'];
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, { ado: { ...s, env } });
    expect(readFileSync(join(dir, 'big.bin'), 'utf8')).toBe(LFS_POINTER);
    expect(fx.lfsBatchAuths).toEqual([]);
  }, 120_000);

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
      {
        PATH: '/bin', AZURE_DEVOPS_EXT_PAT: PAT, CREW_ADO_TENANT_ID: 't', CREW_ADO_CLIENT_ID: 'c', CREW_ADO_CLIENT_SECRET: 'sp-secret', // ggignore: made-up test values
        GIT_CONFIG_KEY_17: 'http.extraHeader', GIT_CONFIG_VALUE_17: 'x', GIT_CONFIG_PARAMETERS: "'http.extraheader'='y'",
        // (coord F1) A daemon started while someone debugged git over HTTP.
        GIT_TRACE_CURL: '/tmp/curl.log', GIT_TRACE_REDACT: '0', GIT_CURL_VERBOSE: '1', GIT_SSL_NO_VERIFY: '1', GIT_TRACE: '1', GIT_TRACE2_EVENT: '/tmp/t2', GIT_TRACE_PACKET: '1',
      },
      url,
      BASIC,
    );
    for (const n of ENV) expect(env[n]).toBeUndefined();
    expect(env['GIT_CONFIG_KEY_17']).toBeUndefined();
    expect(env['GIT_CONFIG_VALUE_17']).toBeUndefined();
    expect(env['GIT_CONFIG_PARAMETERS']).toBe('');
    for (const n of ['GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_SSL_NO_VERIFY', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_TRACE_PACKET']) expect(env[n], n).toBeUndefined();
    expect(env['GIT_TRACE_REDACT']).toBe('1');
    const pairs = Array.from({ length: Number(env['GIT_CONFIG_COUNT']) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toEqual([
      ['http.extraHeader', ''],
      [`http.${url}.extraHeader`, ''],
      [`http.${url}.extraHeader`, `Authorization: ${BASIC}`],
      ['http.followRedirects', 'false'],
      [`http.${url}.followRedirects`, 'false'],
      ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
      [`http.${url}.sslVerify`, 'true'],
      ['http.lowSpeedLimit', '1000'],
      ['http.lowSpeedTime', '60'],
    ]);
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https');
    expect(env['PATH']).toBe('/bin');
  });

  it('a daemon tracing git over HTTP writes no header anywhere: the clone gets no trace or TLS-off setting (coord F1)', async () => {
    const fx = await fixture();
    const trace = join(fx.root, 'curl.log');
    const s = seam(fx);
    const dir = join(fx.root, 'clone');
    await cloneRepository('https://dev.azure.com/org/proj/_git/repo', dir, {
      // (GIT_CURL_VERBOSE would send the same trace to stderr instead of the file; the env test covers it.)
      ado: { ...s, env: { ...s.env, GIT_TRACE_CURL: trace, GIT_TRACE_REDACT: '0', GIT_SSL_NO_VERIFY: '1' } },
    });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('tiny-math\n');
    // No trace at all: the clone's git was never asked for one.
    expect(existsSync(trace)).toBe(false);
    expect(fx.auths.every((a) => a === BASIC)).toBe(true);
  }, 60_000);

  it('a plain clone on a daemon holding the PAT runs no filter with it (coord F4)', async () => {
    const fx = await fixture();
    const leaked = join(fx.root, 'filter-saw-env.txt');
    const filter = join(fx.root, 'leak.sh');
    writeFileSync(filter, `#!/bin/sh\n${RECORD(leaked)}cat\n`);
    chmodSync(filter, 0o755);
    writeFileSync(join(fx.env['HOME']!, '.gitconfig'), `[filter "leak"]\n\tsmudge = ${filter}\n`);
    const dir = join(fx.root, 'plain');
    // A local path: not Azure DevOps, so the plain clone path.
    await cloneRepository(join(fx.root, 'srv', 'org', 'proj', '_git', 'repo'), dir, { ado: { env: { ...fx.env, AZURE_DEVOPS_EXT_PAT: PAT, CREW_ADO_CLIENT_SECRET: 'sp-secret' } } }); // ggignore: made-up test values
    const seen = readFileSync(leaked, 'utf8');
    expect(seen).toContain('ran');
    expectNoSecret(seen);
    for (const n of ENV) expect(seen).not.toContain(`${n}=`);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('a clone that stalls past its deadline is stopped with every git it started: nothing carrying the header outlives it (coord F2)', async () => {
    const fx = await fixture();
    // Accepts, reads, never answers.
    const held: Socket[] = [];
    const stall = createTcpServer((sock) => {
      held.push(sock);
      sock.on('data', () => undefined);
    });
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(stall.address() as { port: number }).port}`;
    try {
      const s = seam(fx);
      const err = await cloneRepository('https://dev.azure.com/org/proj/_git/repo', join(fx.root, 'clone'), {
        ado: { ...s, timeoutMs: 1500, target: (u) => ({ ...adoRepoOf(u)!, gitUrl: `${at}/org/proj/_git/repo`, loginBase: fx.url }) },
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('timed out');
      expectNoSecret((err as Error).message);
      // git's remote helpers carry the URL in their argv: none of them is left.
      // (pgrep matches the full command line and prints only pids; exit 1 = none.)
      const survivors = (): string[] => {
        try {
          return execFileSync('pgrep', ['-f', at], { encoding: 'utf8' }).split('\n').filter((l) => l.trim() !== '');
        } catch (e) {
          if ((e as { status?: number }).status === 1) return [];
          throw new Error(`pgrep failed: ${String((e as { status?: number }).status)}`);
        }
      };
      for (let i = 0; i < 20 && survivors().length > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
      expect(survivors()).toEqual([]);
    } finally {
      for (const sock of held) sock.destroy();
      await new Promise<void>((r) => stall.close(() => r()));
    }
  }, 60_000);

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
