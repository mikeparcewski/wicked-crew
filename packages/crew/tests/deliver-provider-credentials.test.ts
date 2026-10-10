// crew#720 — the Azure DevOps delivery provider, the credential preflight both providers share, and
// the final-codebase zip every delivery leaves behind — DRIVEN FOR REAL.
//
// The deliver script runs as core runs it (`bash -lc <script>`) in a run worktree. Azure DevOps is a
// local git smart-HTTP server (`git http-backend`) and a mocked REST + Entra API in THIS process,
// both of which refuse any request without the expected Authorization header; GitHub is a stub `gh`
// on a PATH we control (HOME's .bash_profile prepends it after macOS's path_helper). After each
// outcome the daemon's archiver zips the run's tree, and the zip's entries are compared with the tree
// delivery would ship: never `.git`, a gitignored file or an untracked `.env`.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DELIVER_PUSH_REJECTED_MARKER, deliverGateInstructions, deliverPrScript, type DeliverScriptOptions } from '../src/core/deliver.js';
import { ADO_HELPER_JS } from '../src/core/ado-deliver-helper.js';
import {
  adoCredentials,
  adoRepoOf,
  credentialsMissingIn,
  deliverCredentialsFor,
  deliverCredentialsProbe,
  githubCredentials,
  missingCredentials,
  type AdoRepo,
} from '../src/core/deliver-credentials.js';
import { deliveryRecordFrom, prUrlFrom } from '../src/api/delivery-index.js';
import { trustedOutcomeIn } from '../src/core/deliver-triage.js';
import { CodebaseArchiveStore, archiverGitEnv } from '../src/api/codebase-archive.js';

const RUN_ID = '720ad0de-0000-4000-8000-00000000c0de';
const NONCE = 'fedcba9876543210fedcba9876543210';
const PAT = 'pat-SECRET-0123456789abcdef';
// A dummy, unsigned token built at runtime (a JWT-shaped literal would trip secret scanners).
const b64u = (o: object | string): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const JWT = [b64u({ alg: 'none' }), b64u({ sub: 'crew-test' }), b64u('dummy')].join('.');
const SP_SECRET = 'sp-SECRET-client-value-42';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

interface Fx {
  root: string;
  bare: string;
  clone: string;
  workdir: string;
  home: string;
  bin: string;
}

/**
 * A bare repo (at `<root>/srv/org/proj/_git/repo` so a smart-HTTP server can serve it at the ADO
 * path) seeded with README + a `.gitignore` that ignores `build/`; a clone on main; a run worktree
 * on `wicked/<RUN_ID>` carrying the run's UNCOMMITTED work: a new source file (the product), an
 * untracked `.env` (a secret) and a gitignored `build/out.js`.
 */
function fixture(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'crew-720-'));
  roots.push(root);
  const bare = join(root, 'srv', 'org', 'proj', '_git', 'repo');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(bare, 'config', 'http.receivepack', 'true');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  writeFileSync(join(seed, '.gitignore'), 'build/\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', bare, 'main');
  execFileSync('git', ['clone', '-q', bare, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');
  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
  mkdirSync(join(workdir, 'src'), { recursive: true });
  writeFileSync(join(workdir, 'src', 'feature.ts'), 'export const feature = 720;\n');
  writeFileSync(join(workdir, '.env'), 'API_KEY=do-not-ship\n');
  mkdirSync(join(workdir, 'build'), { recursive: true });
  writeFileSync(join(workdir, 'build', 'out.js'), 'compiled\n');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  return { root, bare, clone, workdir, home, bin };
}

/** The files the run's tree must hold — the product, never the secret or the ignored build. */
const SHIPPED = ['.gitignore', 'README.md', 'src/feature.ts'];

/** A stub gh: `auth status` fails when GH_STUB_SIGNED_OUT is set; `api user` answers GH_STUB_LOGIN
 *  (or GH_STUB_TOKEN_LOGIN while the pinned token is exported); `auth token --user` serves a token
 *  for GH_STUB_TOKEN_FOR only; `pr create` prints a PR URL. Every call is recorded. */
function stubGh(fx: Fx): void {
  writeFileSync(
    join(fx.bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_STUB_RECORD"',
      'case "$1 $2" in',
      '  "auth status") if [ -n "${GH_STUB_SIGNED_OUT:-}" ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi; echo "  Logged in to github.com account ${GH_STUB_LOGIN:-tester}";;',
      '  "auth token") U=""; P=""; for a in "$@"; do [ "$P" = --user ] && U="$a"; P="$a"; done; if [ -n "$U" ] && [ "$U" = "${GH_STUB_TOKEN_FOR:-}" ]; then echo "tok-$U"; exit 0; fi; exit 1;;',
      '  "api user") if [ -n "${GH_TOKEN:-}" ] && [ "$GH_TOKEN" = "tok-${GH_STUB_TOKEN_FOR:-}" ]; then echo "$GH_STUB_TOKEN_LOGIN"; exit 0; fi; echo "${GH_STUB_LOGIN:-tester}";;',
      '  "pr create") echo "https://github.com/o/r/pull/9";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(fx.bin, 'gh'), 0o755);
}

interface Run {
  status: number;
  output: string;
  outcome: string | null;
  ghCalls: string[];
}

async function runDeliver(fx: Fx, script: DeliverScriptOptions, env: Record<string, string>): Promise<Run> {
  const record = join(fx.root, `gh-calls-${Math.random().toString(16).slice(2)}`);
  const res = await new Promise<{ status: number; out: string }>((resolve) => {
    execFile(
      'bash',
      ['-lc', deliverPrScript('feat: crew#720 delivery', { runId: RUN_ID, nonce: NONCE, ...script })],
      {
        cwd: fx.workdir,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: fx.home,
          GH_STUB_RECORD: record,
          GH_ACCOUNT: '',
          GH_TOKEN: '',
          WICKED_DELIVER_VERIFIED_BASE: '',
          AZURE_DEVOPS_EXT_PAT: '',
          CREW_ADO_TENANT_ID: '',
          CREW_ADO_CLIENT_ID: '',
          CREW_ADO_CLIENT_SECRET: '',
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({ status: err === null ? 0 : typeof code === 'number' ? code : -1, out: `${stdout}${stderr}` });
      },
    );
  });
  const ghCalls = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { status: res.status, output: res.out, outcome: trustedOutcomeIn(res.out, NONCE), ghCalls };
}

/** Archive the run's tree the way the daemon does, and read the zip's entries back. */
async function zipOf(fx: Fx, trigger: 'deliver' | 'run_end' = 'deliver', workdir: string | null = fx.workdir) {
  const store = new CodebaseArchiveStore(join(fx.root, 'artifacts'));
  const rec = await store.archive(RUN_ID, { workdir, repoRoot: fx.clone }, trigger);
  expect(rec, 'an archive was taken').not.toBeNull();
  const path = store.zipFile(RUN_ID)!;
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l !== '' && !l.endsWith('/'))
    .sort();
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  expect(rec!.sha256).toBe(sha);
  return { rec: rec!, entries, path, store };
}

function expectShippedZip(entries: string[], zipPath: string): void {
  expect(entries).toEqual(SHIPPED);
  expect(entries.some((e) => e.startsWith('.git/') || e === '.env' || e.startsWith('build/'))).toBe(false);
  expect(execFileSync('unzip', ['-p', zipPath, 'src/feature.ts'], { encoding: 'utf8' })).toBe('export const feature = 720;\n');
}

// ── the mocked Azure DevOps: smart-HTTP git + REST + Entra on one loopback server ─────────────────

interface Ado {
  url: string;
  target: AdoRepo;
  prBodies: Array<{ auth: string; body: Record<string, unknown> }>;
  tokenForms: URLSearchParams[];
  authSeen: string[];
}

async function mockAdo(fx: Fx, o: { auth: string; existingPr?: number; refusePush?: boolean; mint?: string }): Promise<Ado> {
  const state: Omit<Ado, 'url' | 'target'> = { prBodies: [], tokenForms: [], authSeen: [] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = String(req.headers['authorization'] ?? '');
      if (u.pathname === '/tenant-1/oauth2/v2.0/token' && req.method === 'POST') {
        const form = new URLSearchParams(body.toString('utf8'));
        state.tokenForms.push(form);
        const ok = form.get('client_secret') === SP_SECRET && form.get('scope') === '499b84ac-1321-427f-aa17-267ca6975798/.default';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { access_token: o.mint ?? JWT, expires_in: 3600 } : { error: 'invalid_client' }));
        return;
      }
      state.authSeen.push(auth);
      if (auth !== o.auth) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="ado"' });
        res.end('unauthorized');
        return;
      }
      if (u.pathname === '/org/proj/_apis/git/repositories/repo/pullrequests') {
        if (req.method === 'POST') {
          state.prBodies.push({ auth, body: JSON.parse(body.toString('utf8')) as Record<string, unknown> });
          if (o.existingPr !== undefined) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'TF401179: An active pull request for the source and target branch already exists.' }));
            return;
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ pullRequestId: 77 }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            value:
              o.existingPr === undefined
                ? []
                : [{ pullRequestId: o.existingPr, status: 'active', sourceRefName: u.searchParams.get('searchCriteria.sourceRefName'), targetRefName: 'refs/heads/main' }],
          }),
        );
        return;
      }
      if (u.pathname.startsWith('/org/proj/_git/repo/')) {
        if (o.refusePush === true && (u.searchParams.get('service') === 'git-receive-pack' || u.pathname.endsWith('/git-receive-pack'))) {
          res.writeHead(403);
          res.end('TF401027: You need the Git GenericContribute permission to perform this action.');
          return;
        }
        // CGI: git http-backend serves the bare repo under GIT_PROJECT_ROOT.
        const cgi = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: join(fx.root, 'srv'),
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
        const out: Buffer[] = [];
        cgi.stdout.on('data', (c: Buffer) => out.push(c));
        cgi.on('close', () => {
          const all = Buffer.concat(out);
          const sep = all.indexOf('\r\n\r\n');
          const head = all.subarray(0, sep).toString('utf8');
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of head.split('\r\n')) {
            const at = line.indexOf(':');
            if (at < 0) continue;
            const k = line.slice(0, at).trim();
            const val = line.slice(at + 1).trim();
            if (k.toLowerCase() === 'status') status = Number.parseInt(val, 10);
            else headers[k] = val;
          }
          res.writeHead(status, headers);
          res.end(all.subarray(sep + 4));
        });
        cgi.stdin.end(body);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const gitUrl = `${url}/org/proj/_git/repo`;
  // The worktree's origin IS the served repository (the drift check compares them).
  git(fx.clone, 'remote', 'set-url', 'origin', gitUrl);
  return {
    url,
    // Pushes + REST go to the loopback server; the PR's web URL is the production shape.
    target: { org: 'org', project: 'proj', repo: 'repo', gitUrl, apiBase: `${url}/org/proj/_apis/git/repositories/repo`, webUrl: 'https://dev.azure.com/org/proj/_git/repo', loginBase: url },
    ...state,
  } as Ado;
}

function bareBranches(fx: Fx): string[] {
  return git(fx.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
}

function expectNoSecret(text: string): void {
  for (const s of [PAT, Buffer.from(`:${PAT}`).toString('base64'), JWT, SP_SECRET]) expect(text).not.toContain(s);
}

// ── pure: parsing, preflight, card, parsers ──────────────────────────────────────────────────────

describe('crew#720 provider + credentials (pure)', () => {
  it('names the Azure DevOps repository of every spelling Azure DevOps hands out, and nothing looser', () => {
    for (const url of [
      'https://dev.azure.com/org/proj/_git/repo',
      'https://org@dev.azure.com/org/proj/_git/repo',
      'https://org.visualstudio.com/proj/_git/repo',
      'https://org.visualstudio.com/DefaultCollection/proj/_git/repo.git',
      'git@ssh.dev.azure.com:v3/org/proj/repo',
      'org@vs-ssh.visualstudio.com:v3/org/proj/repo',
    ]) {
      const r = adoRepoOf(url);
      expect(r, url).not.toBeNull();
      expect(r!.gitUrl).toBe('https://dev.azure.com/org/proj/_git/repo');
      expect(r!.apiBase).toBe('https://dev.azure.com/org/proj/_apis/git/repositories/repo');
    }
    for (const url of ['https://dev.azure.com/org/proj', 'https://evil.example/dev.azure.com/org/proj/_git/repo', 'http://dev.azure.com/org/proj/_git/repo', 'https://github.com/o/r', '/local/path', '']) {
      expect(adoRepoOf(url), url).toBeNull();
    }
  });

  it('the helper canonicalises origin URLs the same way (drift check parity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-720-helper-'));
    roots.push(dir);
    const helper = join(dir, 'ado.mjs');
    writeFileSync(helper, ADO_HELPER_JS);
    const same = (...urls: string[]): boolean => {
      try {
        execFileSync(process.execPath, [helper, 'same', 'https://dev.azure.com/org/proj/_git/repo', urls.join('\n')]);
        return true;
      } catch {
        return false;
      }
    };
    expect(same('https://org@dev.azure.com/org/proj/_git/repo', 'git@ssh.dev.azure.com:v3/org/proj/repo')).toBe(true);
    expect(same('https://org.visualstudio.com/DefaultCollection/proj/_git/repo')).toBe(true);
    expect(same('https://dev.azure.com/org/proj/_git/repo', 'https://dev.azure.com/org/proj/_git/other')).toBe(false);
    expect(same('https://evil.example/org/proj/_git/repo')).toBe(false);
    expect(same()).toBe(false);
  });

  it('one shape for both providers: configured / missing, presence only', () => {
    expect(adoCredentials({ CREW_ADO_TENANT_ID: 't', CREW_ADO_CLIENT_ID: 'c', CREW_ADO_CLIENT_SECRET: 's' })).toMatchObject({ provider: 'azure_devops', status: 'configured', source: 'service_principal' });
    expect(adoCredentials({ AZURE_DEVOPS_EXT_PAT: 'p' })).toMatchObject({ status: 'configured', source: 'pat' });
    const ado = adoCredentials({ CREW_ADO_TENANT_ID: 't' });
    expect(ado).toMatchObject({ status: 'missing', source: null, missing: ['CREW_ADO_CLIENT_ID', 'CREW_ADO_CLIENT_SECRET', 'AZURE_DEVOPS_EXT_PAT'] });
    expect(ado.message).toMatch(/^Azure DevOps credentials not configured/);
    expect(githubCredentials({ GH_TOKEN: 'x' }, [])).toMatchObject({ provider: 'github', status: 'configured', source: 'gh_token' });
    expect(githubCredentials({}, ['alice'])).toMatchObject({ status: 'configured', source: 'gh_login' });
    expect(githubCredentials({}, null)).toMatchObject({ status: 'unknown' });
    const gh = githubCredentials({}, 'absent');
    expect(gh).toMatchObject({ status: 'missing', missing: ['gh auth login', 'GH_TOKEN'] });
    expect(gh.message).toMatch(/^GitHub credentials not configured: gh is not installed/);
    expect(githubCredentials({}, []).message).toMatch(/gh is not signed in to github.com/);
    expect(deliverCredentialsFor('/local/path', {}, [])).toBeNull();
    expect(missingCredentials('github').status).toBe('missing');
  });

  it('the probe runs gh only for a github.com origin with no GH_TOKEN', async () => {
    let probed = 0;
    const probe = async (): Promise<string[] | 'absent'> => {
      probed += 1;
      return 'absent';
    };
    expect((await deliverCredentialsProbe('https://github.com/o/r', {}, probe))?.status).toBe('missing');
    expect((await deliverCredentialsProbe('https://github.com/o/r', { GH_TOKEN: 't' }, probe))?.status).toBe('configured');
    expect((await deliverCredentialsProbe('https://dev.azure.com/o/p/_git/r', {}, probe))?.provider).toBe('azure_devops');
    expect(await deliverCredentialsProbe('/srv/repo.git', {}, probe)).toBeNull();
    expect(probed).toBe(1);
  });

  it('the gate card says "<provider> credentials not configured" BEFORE approval', () => {
    const gh = deliverGateInstructions({ originUrl: 'https://github.com/o/r', runId: RUN_ID, credentials: githubCredentials({}, []) });
    expect(gh).toContain('GitHub credentials not configured');
    expect(gh).toContain('gh auth login');
    const ado = deliverGateInstructions({ originUrl: 'https://dev.azure.com/org/proj/_git/repo', runId: RUN_ID, credentials: adoCredentials({}) });
    expect(ado).toContain('on Azure DevOps and opens a pull request there');
    expect(ado).toContain('Azure DevOps credentials not configured: set CREW_ADO_TENANT_ID, CREW_ADO_CLIENT_ID, CREW_ADO_CLIENT_SECRET (a service principal) or AZURE_DEVOPS_EXT_PAT');
    expect(ado).not.toMatch(/\bgh\b/);
    expect(deliverGateInstructions({ originUrl: 'https://dev.azure.com/org/proj/_git/repo', credentials: adoCredentials({ AZURE_DEVOPS_EXT_PAT: 'p' }) })).toContain('personal access token');
  });

  it('parsers: an ADO PR URL is a delivery; Azure Repos\' push hint is not; the refusal line names the provider', () => {
    expect(prUrlFrom('remote: https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=x\n')).toBeNull();
    expect(deliveryRecordFrom('pushed\nhttps://dev.azure.com/o/p/_git/r/pullrequest/12\n')).toEqual({ url: 'https://dev.azure.com/o/p/_git/r/pullrequest/12' });
    expect(credentialsMissingIn('x\ndeliver: CREDENTIALS-MISSING azure_devops; deliver: PUSH-REJECTED\n')).toBe('azure_devops');
    expect(credentialsMissingIn('deliver: pushed')).toBeNull();
  });

  it('a revision of an Azure DevOps pull request is refused at compose time', () => {
    expect(() =>
      deliverPrScript('x', { originUrl: 'https://dev.azure.com/org/proj/_git/repo', revisesPr: { number: 3, headRef: 'wicked/a', url: 'https://github.com/o/r/pull/3' } }),
    ).toThrow(/Azure DevOps pull request is not supported/);
  });
});

// ── driven for real: every outcome, both providers, and the zip in each ─────────────────────────

describe('crew#720 deliver, driven for real — Azure DevOps', () => {
  it('MISSING CREDENTIALS: refused before anything is staged, parks recoverably, the zip holds the work', async () => {
    const fx = fixture();
    const ado = await mockAdo(fx, { auth: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}` });
    const r = await runDeliver(fx, { adoTarget: ado.target }, {});
    expect(r.status).toBe(1);
    expect(r.outcome).toBe('rejected');
    expect(r.output).toContain('Azure DevOps credentials not configured');
    expect(r.output).toContain(`deliver: CREDENTIALS-MISSING azure_devops; ${DELIVER_PUSH_REJECTED_MARKER}`);
    expect(credentialsMissingIn(r.output)).toBe('azure_devops');
    expect(r.ghCalls).toEqual([]);
    expect(ado.authSeen).toEqual([]); // nothing reached the remote
    expect(bareBranches(fx)).toEqual(['main']);
    expect(git(fx.workdir, 'rev-list', '--count', 'main..HEAD').trim()).toBe('0'); // nothing committed
    const { entries, path } = await zipOf(fx);
    expectShippedZip(entries, path);
  }, 60_000);

  it('PAT: pushes over smart HTTP with the scoped header, opens the PR through REST, and leaks nothing', async () => {
    const fx = fixture();
    const auth = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
    const ado = await mockAdo(fx, { auth });
    const r = await runDeliver(fx, { adoTarget: ado.target }, { AZURE_DEVOPS_EXT_PAT: PAT });
    expect(r.status, r.output).toBe(0);
    expect(r.outcome).toBe('pr');
    expect(deliveryRecordFrom(r.output)).toEqual({ url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/77' });
    expect(bareBranches(fx).sort()).toEqual(['main', `wicked/${RUN_ID}`]);
    expect(ado.prBodies).toHaveLength(1);
    expect(ado.prBodies[0]!.body).toMatchObject({ sourceRefName: `refs/heads/wicked/${RUN_ID}`, targetRefName: 'refs/heads/main', title: 'feat: crew#720 delivery' });
    expect(ado.authSeen.every((a) => a === auth)).toBe(true);
    expect(r.ghCalls).toEqual([]);
    expectNoSecret(r.output);
    // The pushed tree is the shipped tree, and the zip equals it.
    const pushed = git(fx.bare, 'ls-tree', '-r', '--name-only', `wicked/${RUN_ID}`).split('\n').filter(Boolean).sort();
    expect(pushed).toEqual(SHIPPED);
    const { entries, path, rec } = await zipOf(fx);
    expectShippedZip(entries, path);
    expect(rec.tree).toBe(git(fx.bare, 'rev-parse', `wicked/${RUN_ID}^{tree}`).trim());
    // Nothing of the credential was written into the clone's config.
    expect(readFileSync(join(fx.clone, '.git', 'config'), 'utf8')).not.toContain('extraHeader');
  }, 60_000);

  it('SERVICE PRINCIPAL: mints an Entra token (secret only in the form body) and uses it as Bearer for git and REST', async () => {
    const fx = fixture();
    const ado = await mockAdo(fx, { auth: `Bearer ${JWT}` });
    const r = await runDeliver(fx, { adoTarget: ado.target }, { CREW_ADO_TENANT_ID: 'tenant-1', CREW_ADO_CLIENT_ID: 'client-1', CREW_ADO_CLIENT_SECRET: SP_SECRET });
    expect(r.status, r.output).toBe(0);
    expect(r.outcome).toBe('pr');
    expect(ado.tokenForms).toHaveLength(1);
    expect(ado.tokenForms[0]!.get('grant_type')).toBe('client_credentials');
    expect(ado.tokenForms[0]!.get('client_id')).toBe('client-1');
    expect(ado.prBodies[0]!.auth).toBe(`Bearer ${JWT}`);
    expectNoSecret(r.output);
  }, 60_000);

  it('a PR already open for this branch pair is ADOPTED (a retry after the push landed)', async () => {
    const fx = fixture();
    const ado = await mockAdo(fx, { auth: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`, existingPr: 41 });
    const r = await runDeliver(fx, { adoTarget: ado.target }, { AZURE_DEVOPS_EXT_PAT: PAT });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('already exists');
    expect(prUrlFrom(r.output)).toBe('https://dev.azure.com/org/proj/_git/repo/pullrequest/41');
  }, 60_000);

  it('REFUSED PUSH (403): committed, nothing on the remote, parks recoverably; the zip holds the committed tree', async () => {
    const fx = fixture();
    const ado = await mockAdo(fx, { auth: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`, refusePush: true });
    const r = await runDeliver(fx, { adoTarget: ado.target }, { AZURE_DEVOPS_EXT_PAT: PAT });
    expect(r.status).toBe(1);
    expect(r.outcome).toBe('rejected');
    expect(r.output).toContain(DELIVER_PUSH_REJECTED_MARKER);
    expect(bareBranches(fx)).toEqual(['main']);
    expect(ado.prBodies).toEqual([]);
    expectNoSecret(r.output);
    const { entries, path, rec } = await zipOf(fx);
    expectShippedZip(entries, path);
    expect(rec.tree).toBe(git(fx.workdir, 'rev-parse', 'HEAD^{tree}').trim());
  }, 60_000);

  it('origin re-pointed since approval is refused before anything is staged', async () => {
    const fx = fixture();
    const ado = await mockAdo(fx, { auth: `Basic ${Buffer.from(`:${PAT}`).toString('base64')}` });
    git(fx.clone, 'remote', 'set-url', 'origin', `${ado.url}/org/proj/_git/other`);
    const r = await runDeliver(fx, { adoTarget: ado.target }, { AZURE_DEVOPS_EXT_PAT: PAT });
    expect(r.status).toBe(1);
    expect(r.output).toContain('origin no longer points at');
    expect(ado.authSeen).toEqual([]);
  }, 60_000);
});

describe('crew#720 deliver, driven for real — GitHub parity', () => {
  it('MISSING CREDENTIALS (gh signed out, no GH_TOKEN): the same refusal shape, parks recoverably, zip present', async () => {
    const fx = fixture();
    stubGh(fx);
    const r = await runDeliver(fx, { originUrl: 'https://github.com/o/r' }, { GH_STUB_SIGNED_OUT: '1' });
    expect(r.status).toBe(1);
    expect(r.outcome).toBe('rejected');
    expect(r.output).toContain('GitHub credentials not configured: gh is not signed in to github.com and no GH_TOKEN is exported');
    expect(r.output).toContain(`deliver: CREDENTIALS-MISSING github; ${DELIVER_PUSH_REJECTED_MARKER}`);
    expect(r.ghCalls).toEqual(['auth status --hostname github.com']);
    expect(git(fx.workdir, 'rev-list', '--count', 'main..HEAD').trim()).toBe('0');
    const { entries, path } = await zipOf(fx);
    expectShippedZip(entries, path);
  }, 60_000);

  it('WRONG ACCOUNT (identity alice, the exported GH_TOKEN authenticates as bob): refused, nothing pushed, zip present', async () => {
    const fx = fixture();
    stubGh(fx);
    // (crew#940) A keyring pin reads alice's OWN token, so the only credential that can belong to
    // another login is an exported GH_TOKEN — that is the wrong account the phase still refuses.
    const r = await runDeliver(fx, { originUrl: 'https://github.com/o/r' }, { GH_ACCOUNT: 'alice', GH_TOKEN: 'ghp_bobs', GH_STUB_LOGIN: 'bob' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('identity mismatch');
    expect(bareBranches(fx)).toEqual(['main']);
    const { entries, path } = await zipOf(fx);
    expectShippedZip(entries, path);
  }, 60_000);

  it('REFUSED PUSH (pre-receive hook): parks recoverably; the zip holds the committed tree', async () => {
    const fx = fixture();
    stubGh(fx);
    writeFileSync(join(fx.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected: pushes need review" >&2\nexit 1\n');
    chmodSync(join(fx.bare, 'hooks', 'pre-receive'), 0o755);
    const r = await runDeliver(fx, {}, {});
    expect(r.status).toBe(1);
    expect(r.outcome).toBe('rejected');
    expect(r.output).toContain(DELIVER_PUSH_REJECTED_MARKER);
    const { entries, path, rec } = await zipOf(fx);
    expectShippedZip(entries, path);
    expect(rec.tree).toBe(git(fx.workdir, 'rev-parse', 'HEAD^{tree}').trim());
  }, 60_000);

  it('DELIVERED (local origin, push-only) and then RUN END after the worktree is reaped: the branch fallback, no rewrite', async () => {
    const fx = fixture();
    stubGh(fx);
    const r = await runDeliver(fx, {}, {});
    expect(r.status, r.output).toBe(0);
    const first = await zipOf(fx, 'deliver');
    expectShippedZip(first.entries, first.path);
    // Same tree again ⇒ the same record, nothing rewritten.
    expect(await first.store.archive(RUN_ID, { workdir: fx.workdir, repoRoot: fx.clone }, 'run_end')).toBe(first.rec);
    // The engine reaps the worktree; the run branch still holds the tree.
    git(fx.clone, 'worktree', 'remove', '--force', fx.workdir);
    const fresh = new CodebaseArchiveStore(join(fx.root, 'artifacts2'));
    const rec = await fresh.archive(RUN_ID, { workdir: fx.workdir, repoRoot: fx.clone }, 'run_end');
    expect(rec).toMatchObject({ source: 'branch', trigger: 'run_end', tree: first.rec.tree });
    // And the record survives a restart (read back from disk).
    expect(new CodebaseArchiveStore(join(fx.root, 'artifacts2')).get(RUN_ID)).toEqual(rec);
  }, 60_000);

  it('LIFT CONFLICT (rebase hit a conflict outside the changelog): stranded; the zip holds the run branch\'s work', async () => {
    const fx = fixture();
    stubGh(fx);
    // origin moved on README since the run branched, and the run changed README too.
    const other = join(fx.root, 'other');
    execFileSync('git', ['clone', '-q', fx.bare, other]);
    git(other, 'config', 'user.email', 'o@test');
    git(other, 'config', 'user.name', 'o');
    writeFileSync(join(other, 'README.md'), 'theirs\n');
    git(other, 'commit', '-qam', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(fx.workdir, 'README.md'), 'ours\n');
    const r = await runDeliver(fx, {}, {});
    expect(r.status).toBe(1);
    expect(r.outcome).toBe('stranded');
    const { entries, path, rec } = await zipOf(fx, 'run_end');
    expectShippedZip(entries, path);
    expect(execFileSync('unzip', ['-p', path, 'README.md'], { encoding: 'utf8' })).toBe('ours\n');
    expect(rec.tree).toBe(git(fx.workdir, 'rev-parse', `wicked/${RUN_ID}^{tree}`).trim());
  }, 60_000);

  it('A RUN THAT FAILED AFTER BUILDING (deliver never ran): the run-end zip holds the worktree\'s work', async () => {
    const fx = fixture();
    const { entries, path, rec } = await zipOf(fx, 'run_end');
    expectShippedZip(entries, path);
    expect(rec).toMatchObject({ trigger: 'run_end', source: 'worktree' });
  }, 60_000);

});

describe('crew#720 codex r1 regressions', () => {
  it('an insteadOf rewrite to ext:: never hands the Azure DevOps header to another program', async () => {
    const fx = fixture();
    const auth = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
    const ado = await mockAdo(fx, { auth });
    const leak = join(fx.root, 'leak.txt');
    // origin carries a username, so it canonicalises to the consented repository (the drift check
    // passes) while the insteadOf below matches only the bare canonical URL the fetch uses (codex r2).
    git(fx.clone, 'remote', 'set-url', 'origin', ado.target.gitUrl.replace('http://', 'http://crew@'));
    const capture = join(fx.root, 'capture.sh');
    writeFileSync(capture, `#!/bin/sh\nenv > '${leak}'\nexit 1\n`);
    chmodSync(capture, 0o755);
    git(fx.clone, 'config', `url.ext::${capture}.insteadOf`, ado.target.gitUrl);
    git(fx.clone, 'config', 'protocol.ext.allow', 'always');
    const r = await runDeliver(fx, { adoTarget: ado.target }, { AZURE_DEVOPS_EXT_PAT: PAT });
    expect(r.status).toBe(1);
    expect(r.output).not.toContain('origin no longer points at');
    expect(existsSync(leak)).toBe(false);
    expectNoSecret(r.output);
  }, 60_000);

  it('the archive follows the worktree INDEX (a `git rm --cached` secret is untracked; a force-added file rides)', async () => {
    const fx = fixture();
    // `.env` committed on the run branch, then untracked by the run with a secret written into it.
    writeFileSync(join(fx.workdir, '.env'), 'OLD=1\n');
    git(fx.workdir, 'add', '-f', '.env');
    git(fx.workdir, '-c', 'user.email=r@t', '-c', 'user.name=r', 'commit', '-qm', 'env');
    git(fx.workdir, 'rm', '-q', '--cached', '.env');
    writeFileSync(join(fx.workdir, '.env'), 'API_KEY=secret\n');
    git(fx.workdir, 'add', '-f', 'build/out.js');
    const before = readFileSync(join(fx.clone, '.git', 'worktrees', RUN_ID, 'index'));
    const { entries } = await zipOf(fx, 'run_end');
    expect(entries).toEqual(['.gitignore', 'README.md', 'build/out.js', 'src/feature.ts']);
    // The worktree's own index is untouched.
    expect(readFileSync(join(fx.clone, '.git', 'worktrees', RUN_ID, 'index')).equals(before)).toBe(true);
  }, 60_000);

  it("the archiver's git never sees the daemon's forge credentials (a repository clean filter included)", async () => {
    expect(archiverGitEnv({ PATH: '/bin', GH_TOKEN: 'g', AZURE_DEVOPS_EXT_PAT: 'p', CREW_ADO_CLIENT_SECRET: 's', GIT_CONFIG_COUNT: '1' })).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
    const fx = fixture();
    const leak = join(fx.root, 'filter-env.txt');
    writeFileSync(join(fx.workdir, '.gitattributes'), '*.ts filter=leak\n');
    git(fx.clone, 'config', 'filter.leak.clean', `sh -c 'env > ${leak}; cat'`);
    const prev = process.env['AZURE_DEVOPS_EXT_PAT'];
    process.env['AZURE_DEVOPS_EXT_PAT'] = PAT;
    try {
      await zipOf(fx, 'run_end');
    } finally {
      if (prev === undefined) delete process.env['AZURE_DEVOPS_EXT_PAT'];
      else process.env['AZURE_DEVOPS_EXT_PAT'] = prev;
    }
    expect(existsSync(leak)).toBe(true);
    expect(readFileSync(leak, 'utf8')).not.toContain(PAT);
  }, 60_000);
});
