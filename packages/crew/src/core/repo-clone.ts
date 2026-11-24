/**
 * crew#1839: the `git clone` behind Add a repository → From a URL.
 *
 * A plain clone uses this computer's own git sign-in (its credential helper). An Azure DevOps URL is cloned with the
 * daemon's Azure DevOps credential when it holds one (`AZURE_DEVOPS_EXT_PAT`, or the `CREW_ADO_*` service principal),
 * the way the deliver phase pushes: the deliver helper mints the header (`node ado.mjs header`), and it reaches this
 * ONE `git clone --no-checkout` through `GIT_CONFIG_*` in the child's environment, scoped to the repository's
 * canonical URL (`http.<url>.extraHeader`) after an empty entry resets any ambient extra header. Redirects are refused,
 * hooks are off, git's own credential helpers are off for it, the raw credential variables are not in its environment,
 * and only the URL's own protocol is allowed. The working tree is checked out after, by a git without the header, so no
 * filter or hook the repository selects runs beside it. (crew#1842) That checkout leaves Git LFS files as pointers
 * (`GIT_LFS_SKIP_SMUDGE=1`: an uncached object would need the credential the checkout does not carry); `git lfs fetch`,
 * a host tool that runs no filter or extension, downloads them with the same scoped header from the repository's own
 * LFS endpoint, and `git lfs checkout`, again without the header, writes the files. The
 * header is never in argv, never written to the clone's `.git/config` (environment config is not persisted) and never
 * in an error: a message that could carry it is redacted. The clone is of the canonical URL, so the registered
 * `origin` carries no userinfo. Every git here runs on `gitChildEnv` (crew#1843): fsmonitor off, no raw credential.
 */

import { adoCredentials, adoRepoOf, ADO_PAT_ENV, ADO_SP_ENV, type AdoRepo } from './deliver-credentials.js';
import { defaultAdoHelperExec, type AdoHelperExec } from './deliver.js';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ADO_RAW_ENV, execCapped, gitChildEnv, withoutAdoCredential } from './exec.js';

/** How a clone reaches Azure DevOps. Injectable so a test points it at a loopback server; production reads the URL. */
export interface AdoCloneSeam {
  /** The Azure DevOps repository a URL names (production: {@link adoRepoOf}). */
  target?: (gitUrl: string) => AdoRepo | null;
  exec?: AdoHelperExec;
  env?: NodeJS.ProcessEnv;
  /** How long the credentialed clone may run (production: 5 minutes). */
  timeoutMs?: number;
}

/** The sentence a clone refused for want of the daemon's Azure DevOps credential carries (repo-input.ts reads it). */
export const ADO_CLONE_NO_CREDENTIAL =
  `This daemon holds no Azure DevOps credential to clone it with: set ${ADO_PAT_ENV}, or ${ADO_SP_ENV.join(', ')} (a service principal), in the daemon's environment and restart it.`;

/** The start of the sentence a clone refused WITH the daemon's Azure DevOps credential carries. */
export const ADO_CLONE_REFUSED = "The daemon's Azure DevOps credential could not clone";

/** (crew#1535) git's refusals when it has no credential for a repository, or the repository is not there to it. */
export const CLONE_DENIED = /repository (?:'[^']*' )?not found|could not read (?:username|password)|terminal prompts disabled|authentication failed|permission denied \(publickey\)|returned error: 40[13]/i;

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out.replace(/(authorization\s*:\s*)(basic|bearer)\s+\S+/gi, '$1$2 [REDACTED]');
}

/** Where git looks for hooks when it must run none (an empty place: git finds no hook in it). */
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * The environment of the ONE credential-bearing `git clone`: the header scoped to the repository's canonical URL (after
 * an empty entry resets any ambient extra header, globally and for that URL), redirects refused globally AND for that
 * URL (an ambient `http.<url>.followRedirects` outranks the global key), hooks off (a hook a host's `core.hooksPath` or
 * template names would run inside this environment), git's credential prompts off, only the URL's own protocol allowed,
 * and the daemon's raw credential variables removed (the header is minted already). Exported for its test.
 */
export function adoCloneEnv(base: NodeJS.ProcessEnv, gitUrl: string, header: string): NodeJS.ProcessEnv {
  const env = withoutAdoCredential(base);
  const config: Array<[string, string]> = [
    ['http.extraHeader', ''],
    [`http.${gitUrl}.extraHeader`, ''],
    [`http.${gitUrl}.extraHeader`, `Authorization: ${header}`],
    ['http.followRedirects', 'false'],
    [`http.${gitUrl}.followRedirects`, 'false'],
    ['core.hooksPath', NO_HOOKS],
    [`http.${gitUrl}.sslVerify`, 'true'],
    // (coord F2) A transfer that stalls ends itself, even when no parent is left to kill it.
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '60'],
  ];
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(k)) delete env[k];
  // (coord F1 on crew#1841) git's own tracing could write the header to a file or stderr (GIT_TRACE_CURL with
  // GIT_TRACE_REDACT=0, GIT_CURL_VERBOSE), and GIT_SSL_NO_VERIFY would hand it to whoever answers for the host: none of
  // them reaches this git, and redaction is forced on.
  for (const k of Object.keys(env)) if (/^GIT_TRACE/.test(k) || k === 'GIT_CURL_VERBOSE' || k === 'GIT_SSL_NO_VERIFY') delete env[k];
  env['GIT_TRACE_REDACT'] = '1';
  // An inherited GIT_CONFIG_PARAMETERS is read after GIT_CONFIG_COUNT and could restore another header.
  env['GIT_CONFIG_PARAMETERS'] = '';
  env['GIT_CONFIG_COUNT'] = String(config.length);
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env['GIT_ALLOW_PROTOCOL'] = new URL(gitUrl).protocol.replace(':', '');
  env['GIT_ASKPASS'] = '';
  return env;
}

/** What a contained git keeps of its stderr (the tail: git's reason is last). */
const STDERR_KEEP = 64 * 1024;

/**
 * (coord F2 on crew#1841) Run the ONE credential-bearing git in its own process group, and on its deadline kill the
 * GROUP: git's remote helpers (`git remote-http`, `git-remote-http`) carry the header in their environment, and a kill
 * of the `git` pid alone leaves them running, re-parented, until the connection dies. Rejects with git's stderr in the
 * message (the caller redacts it). Windows has no process groups: there the tree is ended with `taskkill /T`.
 */
function runContained(what: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = spawn('git', args, { env: gitChildEnv(env), stdio: ['ignore', 'ignore', 'pipe'], detached: posix, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-STDERR_KEEP);
    });
    let timedOut = false;
    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL');
        else spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        // The group is gone already.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Whatever the outcome, nothing of this group outlives it (Windows: the tree ends with git; a timeout ended it).
      if (posix) killTree();
      if (timedOut) reject(new Error(`git ${what} timed out after ${Math.round(timeoutMs / 1000)} s and was stopped. ${stderr.trim()}`.trim()));
      else if (code === 0) resolve();
      else reject(new Error(`Command failed: git ${args.join(' ')} (${code !== null ? `exit ${code}` : `signal ${signal ?? 'unknown'}`})\n${stderr.trim()}`));
    });
  });
}

/**
 * Clone `gitUrl` into `cloneDir`. Throws git's own failure (an Azure DevOps one with the header redacted). An Azure
 * DevOps URL on a daemon without its credential is cloned as before (the host's git sign-in may still reach it); when
 * that is refused, the message names the missing credential ({@link ADO_CLONE_NO_CREDENTIAL}).
 */
export async function cloneRepository(gitUrl: string, cloneDir: string, opts: { allowProtocols?: string; ado?: AdoCloneSeam } = {}): Promise<void> {
  const env = opts.ado?.env ?? process.env;
  const base: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', ...(opts.allowProtocols !== undefined ? { GIT_ALLOW_PROTOCOL: opts.allowProtocols } : {}) };
  // (coord F4) No git this module runs needs the raw Azure DevOps credential: a plain clone's filters and hooks never see
  // it (`gitChildEnv` drops it from every git too; here it is gone before any header is minted).
  for (const n of ADO_RAW_ENV) delete base[n];
  const ado = (opts.ado?.target ?? adoRepoOf)(gitUrl);
  if (ado === null || adoCredentials(env).status !== 'configured') {
    try {
      // crew-0182: a repository that needs a sign-in fails in seconds with git's own reason, instead of waiting on a
      // credential prompt no one can answer until the 5-minute timeout.
      await execCapped('git', ['clone', '--', gitUrl, cloneDir], { timeout: CLONE_TIMEOUT_MS, env: base });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ado === null || !CLONE_DENIED.test(message)) throw err;
      throw new Error(`${ADO_CLONE_NO_CREDENTIAL} Git said: ${message}`);
    }
    return;
  }
  const mint = await (opts.ado?.exec ?? defaultAdoHelperExec)(['header', ado.loginBase], { timeoutMs: 30_000 });
  const header = mint.stdout.trim();
  const secrets = [header, header.replace(/^(?:Basic|Bearer) /, ''), ...[ADO_PAT_ENV, 'CREW_ADO_CLIENT_SECRET'].map((n) => (env[n] ?? '').trim())].filter((s) => s !== '');
  if (mint.code !== 0 || !/^(?:Basic|Bearer) \S+$/.test(header)) {
    const why = redact((mint.stderr || '').trim().split('\n').slice(-1)[0] ?? '', secrets).replace(/^deliver: /, '');
    throw new Error(`${ADO_CLONE_REFUSED} ${ado.webUrl}: ${why !== '' ? why : 'it could not mint a sign-in header'}`);
  }
  try {
    // The header rides ONLY the fetch: `--no-checkout`, so no smudge/process filter, hook or other repository-selected
    // command runs while it is in the environment (a filter the host's config names would inherit it).
    await runContained('clone', ['-c', 'credential.helper=', 'clone', '--no-checkout', '--', ado.gitUrl, cloneDir], adoCloneEnv(base, ado.gitUrl, header), opts.ado?.timeoutMs ?? CLONE_TIMEOUT_MS);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secrets);
    if (!CLONE_DENIED.test(message)) throw new Error(message);
    throw new Error(`${ADO_CLONE_REFUSED} ${ado.webUrl} (it has no access to it, or the URL is wrong). Git said: ${message}`);
  }
  // The working tree, in a second git with no header and no raw credential (an empty repository has nothing to check out).
  // Git LFS files stay pointers here (crew#1842): an object this host has not cached needs the credential.
  const plain = base;
  const born = await execCapped('git', ['-C', cloneDir, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 30_000, env: plain }).then(() => true, () => false);
  if (!born) return;
  try {
    await execCapped('git', ['-C', cloneDir, 'checkout', '--quiet', '--force', 'HEAD'], { timeout: CLONE_TIMEOUT_MS, env: { ...plain, GIT_LFS_SKIP_SMUDGE: '1' } });
    if (!(await usesGitLfs(cloneDir, plain))) return;
    // The repository keeps the LFS filter in its own config, as `git lfs install` writes it, so a host that installed
    // git-lfs without running that still gets real files now and pointers when a file is staged later.
    for (const [k, v] of LFS_FILTER_CONFIG) await execCapped('git', ['-C', cloneDir, 'config', '--local', k, v], { timeout: 30_000, env: plain });
    const lfsUrl = `${ado.gitUrl}.git/info/lfs`;
    const lfsStore = join(cloneDir, '.git', 'lfs');
    try {
      // ONLY the download carries the header: `git lfs fetch` (the host's tool) stores the checked-out commit's objects
      // in the clone's own LFS store and runs no filter, extension or hook. Its endpoint is pinned to the repository's
      // own (`<url>.git/info/lfs`, which the header's URL scope covers), so a `.lfsconfig` cannot aim it elsewhere, and
      // git-lfs drops the header on a redirect to another origin. Pinned too, against this host's git config: the
      // store (its error log, which records the environment, stays in the clone), TLS verification (git-lfs reads the
      // global and host keys, not the URL one the clone pins), no standalone transfer program, no credential helper.
      await runContained('lfs fetch', [
        '-C', cloneDir, '-c', 'credential.helper=', '-c', `lfs.url=${lfsUrl}`, '-c', `lfs.storage=${lfsStore}`,
        '-c', 'http.sslVerify=true', '-c', `http.${new URL(lfsUrl).origin}/.sslVerify=true`,
        '-c', 'lfs.standalonetransferagent=', '-c', `lfs.${lfsUrl}.standalonetransferagent=`,
        'lfs', 'fetch',
      ], adoCloneEnv(base, ado.gitUrl, header), opts.ado?.timeoutMs ?? CLONE_TIMEOUT_MS);
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err), secrets);
      throw new Error(`${ADO_CLONE_LFS_FAILED} ${ado.webUrl} with the daemon's Azure DevOps credential. Check that the credential can read the repository, then add it again. Git said: ${message}`);
    } finally {
      // git-lfs writes its environment (the header's GIT_CONFIG_* entries among it) into an error log here.
      await rm(join(lfsStore, 'logs'), { recursive: true, force: true });
    }
    // The files themselves, from the local store, in a git with no header: whatever filter or extension the checkout
    // runs sees no credential. git-lfs reports a file it could not write without failing, so every LFS file the fetch
    // was to download is checked after: one still a pointer fails the clone. (crew#1863) Files the repository's
    // `lfs.fetchinclude` / `lfs.fetchexclude` leave out stay pointers on purpose, so the check takes the same filters.
    await execCapped('git', ['-C', cloneDir, 'lfs', 'checkout'], { timeout: CLONE_TIMEOUT_MS, env: plain });
    const scope = await lfsFetchScope(cloneDir, plain);
    // git-lfs marks each line `<oid> <*|-> <path>`: `-` is a pointer. A path may itself hold " - ".
    const pointers = (await execCapped('git', ['-C', cloneDir, 'lfs', 'ls-files', ...scope], { timeout: 30_000, env: plain })).stdout
      .split('\n')
      .filter((line) => /^\S+ - /.test(line))
      .map((line) => line.replace(/^\S+ - /, ''));
    if (pointers.length > 0) {
      throw new Error(`${ADO_CLONE_LFS_FAILED} ${ado.webUrl}: ${pointers.length} of them could not be written (${pointers.slice(0, 3).join(', ')}${pointers.length > 3 ? ', …' : ''}). Check the disk has room, then add it again.`);
    }
  } catch (err) {
    // Leave the folder as git found it (empty), so adding the repository again can clone into it.
    await emptyDir(cloneDir);
    throw err;
  }
}

/**
 * (crew#1863) The `git lfs ls-files` filters (`--include=` / `--exclude=`) for what `git lfs fetch` left out on purpose:
 * `lfs.fetchinclude` / `lfs.fetchexclude` as git-lfs reads them (git-lfs `git/config.go`, `config --includes`). git's
 * own config wins, even when it sets a key empty, then the repository's `.lfsconfig`. They are read as the fetch read
 * them: its environment drops every inherited GIT_CONFIG_* entry (`adoCloneEnv`).
 */
export async function lfsFetchScope(cloneDir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const asFetched: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0' };
  for (const k of Object.keys(asFetched)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(k)) delete asFetched[k];
  const read = (key: string, file: string[]): Promise<string | null> =>
    execCapped('git', ['-C', cloneDir, 'config', '--includes', ...file, '--get', key], { timeout: 30_000, env: asFetched }).then((r) => r.stdout.trim(), () => null);
  const scope: string[] = [];
  for (const [key, flag] of [['lfs.fetchinclude', '--include'], ['lfs.fetchexclude', '--exclude']] as const) {
    const value = (await read(key, [])) ?? (await read(key, ['--file', join(cloneDir, '.lfsconfig')])) ?? '';
    if (value !== '') scope.push(`${flag}=${value}`);
  }
  return scope;
}

/** The `filter.lfs` keys `git lfs install` writes (git-lfs `lfs/attribute.go`). */
const LFS_FILTER_CONFIG: ReadonlyArray<[string, string]> = [
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.required', 'true'],
];

async function emptyDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.map((e) => rm(join(dir, e), { recursive: true, force: true }).catch(() => undefined)));
}

/** The start of the sentence a clone whose Git LFS files could not be downloaded carries (crew#1842). */
export const ADO_CLONE_LFS_FAILED = 'Could not download the Git LFS files of';

/**
 * Whether the checked-out commit stores files in Git LFS, and this host has Git LFS to fetch them with. Without it the
 * files stay pointers, as any clone on this host leaves them. A failure to read either is the clone's failure, never a
 * silent "no".
 */
async function usesGitLfs(cloneDir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const tracked = await execCapped('git', ['-C', cloneDir, 'ls-files', '-z', '--', ':(attr:filter=lfs)'], { timeout: 30_000, env });
  if (tracked.stdout === '') return false;
  try {
    // (crew#1864) In git's own words: the answer below is matched in English, and git translates it (help.c `_()`).
    await execCapped('git', ['lfs', 'version'], { timeout: 30_000, env: { ...env, LC_ALL: 'C', LANGUAGE: '' } });
    return true;
  } catch (err) {
    // git's own answer for a subcommand it does not have.
    if (/is not a git command/i.test(String((err as { stderr?: unknown }).stderr ?? (err as Error).message))) return false;
    throw err;
  }
}
