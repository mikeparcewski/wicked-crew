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
 * filter or hook the repository selects runs beside it. The header is never in argv, never written to the clone's
 * `.git/config` (environment config is not persisted) and never in an error: a message that could carry it is
 * redacted. The clone is of the canonical URL, so the registered `origin` carries no userinfo.
 */

import { adoCredentials, adoRepoOf, ADO_PAT_ENV, ADO_SP_ENV, type AdoRepo } from './deliver-credentials.js';
import { defaultAdoHelperExec, type AdoHelperExec } from './deliver.js';
import { spawn } from 'node:child_process';

import { execCapped } from './exec.js';
import { childEnvWithBootEstateDb } from './governance-store.js';

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

/** The raw Azure DevOps credential variables: the header is minted from them, so the clone's git never needs them. */
const ADO_RAW_ENV = [ADO_PAT_ENV, ...ADO_SP_ENV] as const;

/**
 * The environment of the ONE credential-bearing `git clone`: the header scoped to the repository's canonical URL (after
 * an empty entry resets any ambient extra header, globally and for that URL), redirects refused globally AND for that
 * URL (an ambient `http.<url>.followRedirects` outranks the global key), hooks off (a hook a host's `core.hooksPath` or
 * template names would run inside this environment), git's credential prompts off, only the URL's own protocol allowed,
 * and the daemon's raw credential variables removed (the header is minted already). Exported for its test.
 */
export function adoCloneEnv(base: NodeJS.ProcessEnv, gitUrl: string, header: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const n of ADO_RAW_ENV) delete env[n];
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
function runContained(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = spawn('git', args, { env: childEnvWithBootEstateDb(env), stdio: ['ignore', 'ignore', 'pipe'], detached: posix, windowsHide: true });
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
      if (timedOut) reject(new Error(`git clone timed out after ${Math.round(timeoutMs / 1000)} s and was stopped. ${stderr.trim()}`.trim()));
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
  // (coord F4) No git this module runs needs the raw Azure DevOps credential: a plain clone's filters and hooks never see it.
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
    await runContained(['-c', 'credential.helper=', 'clone', '--no-checkout', '--', ado.gitUrl, cloneDir], adoCloneEnv(base, ado.gitUrl, header), opts.ado?.timeoutMs ?? CLONE_TIMEOUT_MS);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secrets);
    if (!CLONE_DENIED.test(message)) throw new Error(message);
    throw new Error(`${ADO_CLONE_REFUSED} ${ado.webUrl} (it has no access to it, or the URL is wrong). Git said: ${message}`);
  }
  // The working tree, in a second git with no header and no raw credential (an empty repository has nothing to check out).
  const plain = base;
  const born = await execCapped('git', ['-C', cloneDir, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 30_000, env: plain }).then(() => true, () => false);
  if (born) await execCapped('git', ['-C', cloneDir, 'checkout', '--quiet', '--force', 'HEAD'], { timeout: CLONE_TIMEOUT_MS, env: plain });
}
