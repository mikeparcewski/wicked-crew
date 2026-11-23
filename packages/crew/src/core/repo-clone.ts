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
import { execCapped } from './exec.js';

/** How a clone reaches Azure DevOps. Injectable so a test points it at a loopback server; production reads the URL. */
export interface AdoCloneSeam {
  /** The Azure DevOps repository a URL names (production: {@link adoRepoOf}). */
  target?: (gitUrl: string) => AdoRepo | null;
  exec?: AdoHelperExec;
  env?: NodeJS.ProcessEnv;
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
  ];
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(k)) delete env[k];
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

/**
 * Clone `gitUrl` into `cloneDir`. Throws git's own failure (an Azure DevOps one with the header redacted). An Azure
 * DevOps URL on a daemon without its credential is cloned as before (the host's git sign-in may still reach it); when
 * that is refused, the message names the missing credential ({@link ADO_CLONE_NO_CREDENTIAL}).
 */
export async function cloneRepository(gitUrl: string, cloneDir: string, opts: { allowProtocols?: string; ado?: AdoCloneSeam } = {}): Promise<void> {
  const env = opts.ado?.env ?? process.env;
  const base: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', ...(opts.allowProtocols !== undefined ? { GIT_ALLOW_PROTOCOL: opts.allowProtocols } : {}) };
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
    await execCapped('git', ['-c', 'credential.helper=', 'clone', '--no-checkout', '--', ado.gitUrl, cloneDir], {
      timeout: CLONE_TIMEOUT_MS,
      env: adoCloneEnv(base, ado.gitUrl, header),
    });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secrets);
    if (!CLONE_DENIED.test(message)) throw new Error(message);
    throw new Error(`${ADO_CLONE_REFUSED} ${ado.webUrl} (it has no access to it, or the URL is wrong). Git said: ${message}`);
  }
  // The working tree, in a second git with no header and no raw credential (an empty repository has nothing to check out).
  const plain: NodeJS.ProcessEnv = { ...base };
  for (const n of ADO_RAW_ENV) delete plain[n];
  const born = await execCapped('git', ['-C', cloneDir, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 30_000, env: plain }).then(() => true, () => false);
  if (born) await execCapped('git', ['-C', cloneDir, 'checkout', '--quiet', '--force', 'HEAD'], { timeout: CLONE_TIMEOUT_MS, env: plain });
}
