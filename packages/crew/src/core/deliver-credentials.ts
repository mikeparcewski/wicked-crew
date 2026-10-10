/**
 * crew#720: the deliver phase's provider credentials — ONE preflight shape for GitHub and Azure
 * DevOps — and the Azure DevOps repository a remote URL names.
 *
 * Only PRESENCE is read here, never a value: the credential stays in the daemon's environment
 * (or gh's keyring) and is consumed by the deliver script alone, inside the deliver phase (the
 * engine strips every forge credential from worker seats, wicked-core#671).
 *
 * The same check runs twice: at launch (so the deliver gate card says "<provider> credentials not
 * configured" BEFORE approval, and `GET /repos/:id/deliver-target` reports it) and in the deliver
 * script itself before anything is staged, whose refusal parks the run at the engine's
 * deliver-refusal gate with the work kept ({@link DELIVER_CREDENTIALS_MISSING_MARKER}).
 */

// A function-only import (no module-evaluation use), so the cycle with deliver.ts is inert.
import { execFile } from 'node:child_process';
import { originRemoteHost, parseGhAuthStatusLogins } from './deliver.js';
import { childEnvWithBootEstateDb } from './governance-store.js';

/** The forge a delivery goes to. `null` from {@link deliverProviderOf} = neither (a local path,
 *  GitLab, Gitea, …): the push-only path, which needs no provider credential of crew's. */
export type DeliverProvider = 'github' | 'azure_devops';

/** api-types `DeliverCredentials` (crew#720) — the one preflight shape every provider shares. */
export interface DeliverCredentials {
  provider: DeliverProvider;
  /** `unknown` = the probe could not answer (gh timed out); never read as `missing`. */
  status: 'configured' | 'missing' | 'unknown';
  /** Where the credential comes from when configured; `null` otherwise. */
  source: 'gh_token' | 'gh_login' | 'service_principal' | 'pat' | null;
  /** What to set when `missing`, in the order the phase tries them (env var names, commands). */
  missing: string[];
  /** One sentence for the gate card and the run record. */
  message: string;
}

/** The env var names the Azure DevOps delivery reads (service principal first, then the PAT). */
export const ADO_SP_ENV = ['CREW_ADO_TENANT_ID', 'CREW_ADO_CLIENT_ID', 'CREW_ADO_CLIENT_SECRET'] as const;
export const ADO_PAT_ENV = 'AZURE_DEVOPS_EXT_PAT';

/**
 * The line the deliver script prints when the provider credential is absent:
 * `deliver: CREDENTIALS-MISSING <provider>` — before anything is staged, followed by the
 * push-refused marker so the engine parks the run at its deliver-refusal gate.
 */
export const DELIVER_CREDENTIALS_MISSING_MARKER = 'deliver: CREDENTIALS-MISSING';

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}

/** The Azure DevOps credential the daemon environment holds (presence only). */
export function adoCredentials(env: NodeJS.ProcessEnv = process.env): DeliverCredentials {
  if (ADO_SP_ENV.every((n) => present(env, n))) {
    return { provider: 'azure_devops', status: 'configured', source: 'service_principal', missing: [], message: 'Azure DevOps credentials: the service principal (CREW_ADO_TENANT_ID / CREW_ADO_CLIENT_ID / CREW_ADO_CLIENT_SECRET).' };
  }
  if (present(env, ADO_PAT_ENV)) {
    return { provider: 'azure_devops', status: 'configured', source: 'pat', missing: [], message: `Azure DevOps credentials: a personal access token (${ADO_PAT_ENV}).` };
  }
  const spMissing = ADO_SP_ENV.filter((n) => !present(env, n));
  return {
    provider: 'azure_devops',
    status: 'missing',
    source: null,
    missing: [...spMissing, ADO_PAT_ENV],
    message:
      `Azure DevOps credentials not configured: set ${ADO_SP_ENV.join(', ')} (a service principal) or ${ADO_PAT_ENV} ` +
      "in the daemon's environment and restart it. The deliver phase refuses before anything is staged and the run waits at the deliver gate with its work kept.",
  };
}

/**
 * The GitHub credential: an exported `GH_TOKEN`, else a gh login for github.com. `logins` is
 * `gh auth status`'s answer — `[]` = gh answered with no login, `'absent'` = gh is not installed,
 * `null` = the probe could not answer (unknown, never missing).
 */
export function githubCredentials(env: NodeJS.ProcessEnv, logins: readonly string[] | 'absent' | null): DeliverCredentials {
  if (present(env, 'GH_TOKEN')) {
    return { provider: 'github', status: 'configured', source: 'gh_token', missing: [], message: 'GitHub credentials: GH_TOKEN in the daemon environment.' };
  }
  if (logins === null) {
    return { provider: 'github', status: 'unknown', source: null, missing: [], message: 'GitHub credentials: gh did not answer in time; the deliver phase checks again before it stages anything.' };
  }
  if (logins !== 'absent' && logins.length > 0) {
    return { provider: 'github', status: 'configured', source: 'gh_login', missing: [], message: `GitHub credentials: gh is signed in to github.com (${logins.join(', ')}).` };
  }
  return {
    provider: 'github',
    status: 'missing',
    source: null,
    missing: ['gh auth login', 'GH_TOKEN'],
    message:
      `GitHub credentials not configured: ${logins === 'absent' ? 'gh is not installed and ' : 'gh is not signed in to github.com and '}no GH_TOKEN is exported. ` +
      "Run `gh auth login` on this machine or export GH_TOKEN in the daemon's environment. The deliver phase refuses before anything is staged and the run waits at the deliver gate with its work kept.",
  };
}

/** The Azure DevOps repository a remote URL names. */
export interface AdoRepo {
  org: string;
  project: string;
  repo: string;
  /** The canonical https git URL every authenticated fetch/push goes to. */
  gitUrl: string;
  /** `…/_apis/git/repositories/<repo>` — the REST base for pull requests. */
  apiBase: string;
  /** The repository's web URL; a PR is `<webUrl>/pullrequest/<id>`. */
  webUrl: string;
  /** The Entra token authority (service-principal mint). */
  loginBase: string;
}

const ADO_PART = /^[A-Za-z0-9._~%() -]+$/;

/** Is `host` an Azure DevOps host (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`)? */
export function isAdoHost(host: string | null): boolean {
  if (host === null) return false;
  const h = host.toLowerCase();
  return h === 'dev.azure.com' || h === 'ssh.dev.azure.com' || h === 'visualstudio.com' || h.endsWith('.visualstudio.com');
}

/**
 * The Azure DevOps repository of a remote URL, or `null`. Accepts the four spellings Azure DevOps
 * hands out — `https://[user@]dev.azure.com/<org>/<project>/_git/<repo>`,
 * `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`,
 * `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` and
 * `<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>` — and nothing looser. Userinfo is
 * never kept. Every part is percent-decoded once and re-encoded, so the canonical URL is stable.
 */
export function adoRepoOf(url: string | null | undefined): AdoRepo | null {
  const raw = (url ?? '').trim();
  if (raw === '' || !isAdoHost(originRemoteHost(raw))) return null;
  let org: string;
  let project: string;
  let repo: string;
  const dec = (s: string): string | null => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  const ssh = /^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:v3\/)([^/]+)\/([^/]+)\/([^/]+?)\/?$/i.exec(raw);
  if (ssh !== null) {
    [org, project, repo] = [ssh[1]!, ssh[2]!, ssh[3]!];
  } else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter((x) => x !== '');
    const gitAt = segs.indexOf('_git');
    if (gitAt < 0 || gitAt !== segs.length - 2) return null;
    if (host === 'dev.azure.com') {
      if (gitAt !== 2) return null;
      [org, project, repo] = [segs[0]!, segs[1]!, segs[3]!];
    } else if (host.endsWith('.visualstudio.com')) {
      org = host.slice(0, -'.visualstudio.com'.length);
      const rest = segs.slice(0, gitAt).filter((s, i) => !(i === 0 && s.toLowerCase() === 'defaultcollection'));
      if (rest.length !== 1) return null;
      [project, repo] = [rest[0]!, segs[gitAt + 1]!];
    } else {
      return null;
    }
  }
  const parts = [org, project, repo.replace(/\.git$/i, '')].map(dec);
  if (parts.some((p) => p === null || p === '' || !ADO_PART.test(p))) return null;
  const [o, p, r] = parts as [string, string, string];
  const e = encodeURIComponent;
  const webUrl = `https://dev.azure.com/${e(o)}/${e(p)}/_git/${e(r)}`;
  return {
    org: o,
    project: p,
    repo: r,
    gitUrl: webUrl,
    apiBase: `https://dev.azure.com/${e(o)}/${e(p)}/_apis/git/repositories/${e(r)}`,
    webUrl,
    loginBase: 'https://login.microsoftonline.com',
  };
}

/** The provider a delivery to `originUrl` uses, or `null` (push-only / local / unknown). */
export function deliverProviderOf(originUrl: string | null | undefined): DeliverProvider | null {
  const host = originRemoteHost((originUrl ?? '').trim());
  if (host === null) return null;
  if (host === 'github.com' || host === 'ssh.github.com') return 'github';
  if (adoRepoOf(originUrl) !== null) return 'azure_devops';
  return null;
}

/** The credential preflight a deliver card shows for an origin; `null` when no provider applies. */
export function deliverCredentialsFor(
  originUrl: string | null | undefined,
  env: NodeJS.ProcessEnv,
  ghLogins: readonly string[] | 'absent' | null,
): DeliverCredentials | null {
  const provider = deliverProviderOf(originUrl);
  if (provider === 'azure_devops') return adoCredentials(env);
  if (provider === 'github') return githubCredentials(env, ghLogins);
  return null;
}

/** `deliver: CREDENTIALS-MISSING <provider>` in a deliver transcript → that provider, else `null`.
 *  The LAST such line decides; the script prints it before anything reaches the remote. */
export function credentialsMissingIn(text: string): DeliverProvider | null {
  let found: DeliverProvider | null = null;
  for (const line of text.split('\n')) {
    const m = /^deliver: CREDENTIALS-MISSING (github|azure_devops)\b/.exec(line.trim());
    if (m !== null) found = m[1] as DeliverProvider;
  }
  return found;
}

/**
 * {@link deliverCredentialsFor} with the gh probe run only when it can matter: a github.com origin
 * with no exported GH_TOKEN (a bounded `gh auth status`, crew#737's probe). gh not installed reads
 * `'absent'`; a probe that timed out reads unknown. Never throws.
 */
export async function deliverCredentialsProbe(
  originUrl: string | null | undefined,
  env: NodeJS.ProcessEnv,
  probe: () => Promise<string[] | 'absent' | null> = ghLoginsOrAbsent,
): Promise<DeliverCredentials | null> {
  const provider = deliverProviderOf(originUrl);
  if (provider === null) return null;
  if (provider === 'azure_devops' || present(env, 'GH_TOKEN')) return deliverCredentialsFor(originUrl, env, null);
  const logins = await probe().catch(() => null);
  return deliverCredentialsFor(originUrl, env, logins);
}

/** `gh auth status --hostname github.com` → the logins, `'absent'` when gh is not installed (spawn
 *  ENOENT), `null` when it could not answer. Bounded to 4 s; one answer serves 30 s. */
let ghMemo: { at: number; value: Promise<string[] | 'absent' | null> } | null = null;
/** How long one gh answer serves the launch composer and the gate card (a sign-in is rare). */
const GH_MEMO_MS = 30_000;

export function ghLoginsOrAbsent(): Promise<string[] | 'absent' | null> {
  const now = Date.now();
  if (ghMemo !== null && now - ghMemo.at < GH_MEMO_MS) return ghMemo.value;
  const value = ghLoginsUncached();
  ghMemo = { at: now, value };
  return value;
}

function ghLoginsUncached(): Promise<string[] | 'absent' | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 4_000, encoding: 'utf8', env: childEnvWithBootEstateDb(process.env) }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') return resolve('absent');
      // A non-numeric code (a timeout kill, another spawn failure) is no answer at all.
      if (err !== null && typeof code !== 'number') return resolve(null);
      resolve(parseGhAuthStatusLogins(`${String(stdout ?? '')}\n${String(stderr ?? '')}`));
    });
  });
}

/** The canonical `missing` reading for a provider — what the run record says after the deliver
 *  phase refused for want of the credential (the phase read the environment it ran in). */
export function missingCredentials(provider: DeliverProvider): DeliverCredentials {
  return provider === 'azure_devops' ? adoCredentials({}) : githubCredentials({}, []);
}
