/**
 * crew#1527: can delivery push, BEFORE the first job? A new user's daemon delivers to a pull request
 * by default (`deliverDefault: "pr"`), but nothing in the first-run path checked the GitHub sign-in
 * that delivery needs: the first job ran every phase and stopped at the deliver step.
 *
 * ONE answer for both places that show it — studio's setup steps (`GET /setup/known` `delivery`) and
 * the system page's `delivery` infra row — built from the deliver preflight's OWN rule
 * ({@link githubCredentials}, crew#720/#940: an exported `GH_TOKEN`, else a gh login for github.com,
 * and with a configured push identity only THAT account's login), plus the git author the deliver
 * step's commit and the seats' commits carry (wicked-core#1485). Presence only: no token is read.
 *
 * Known gap (stated): a repository's own push identity (`deliverIdentityByRepo`) is checked at launch
 * for that repository by the existing preflight; this answer checks the daemon-wide identity.
 */

import type { SystemInfraRow } from 'wicked-crew-api-types';
import { ghStatusRead, githubCredentials, type DeliverCredentials } from '../core/deliver-credentials.js';
import { pushIdentityOf } from '../core/deliver.js';
import { gitIdentity } from './known.js';

/** api-types `DeliveryReadiness` (crew#1527). */
export interface DeliveryReadiness {
  /** The daemon's delivery default: `pr` opens a pull request, `none` keeps the work on its branch. */
  deliverDefault: 'pr' | 'none';
  /** `true` = a job can deliver as configured; `false` = it would stop at the deliver step; `null` = unknown
   *  (gh did not answer in time). */
  ready: boolean | null;
  /** The GitHub credential, by the deliver preflight's rule; `null` when delivery is local (`none`). */
  github: DeliverCredentials | null;
  /** The GitHub account delivery pushes as: the configured identity, else gh's active login; `null` = none known. */
  pushAs: string | null;
  /** The git author commits carry (the global identity); `null` when neither name nor email is set. */
  gitAuthor: { name: string | null; email: string | null } | null;
  /** One sentence: what delivery will do now. */
  reason: string;
  /** What to do when not ready (commands and the Settings choice); `null` when ready. */
  fix: string | null;
}

export interface DeliveryReadinessInput {
  /** `GET /settings` `deliverDefault` (absent = `pr`, the daemon default). */
  deliverDefault: 'pr' | 'none' | undefined;
  /** `GET /settings` `deliverIdentityLogin` (absent / blank = none). */
  identityLogin: string | undefined;
  env: NodeJS.ProcessEnv;
  /** gh's answer: the logins, `'absent'` (gh not installed), `null` (no answer in time). */
  gh: { logins: readonly string[]; active: string | null } | 'absent' | null;
  gitAuthor: { name: string | null; email: string | null } | null;
}

const LOCAL_CHOICE = 'or choose local delivery (Settings → Delivery: keep the work on its branch)';

/** The readiness answer (pure). */
export function deliveryReadiness(input: DeliveryReadinessInput): DeliveryReadiness {
  const gitAuthor = input.gitAuthor;
  if (input.deliverDefault === 'none') {
    return {
      deliverDefault: 'none',
      ready: true,
      github: null,
      pushAs: null,
      gitAuthor,
      reason: 'Delivery is local: a job keeps its work on its own branch, so no GitHub sign-in is needed.',
      fix: null,
    };
  }
  const account = pushIdentityOf(input.identityLogin, input.env);
  const logins = input.gh === null ? null : input.gh === 'absent' ? 'absent' : input.gh.logins;
  const github = githubCredentials(input.env, logins, account);
  const active = input.gh !== null && input.gh !== 'absent' ? input.gh.active : null;
  const pushAs = account ?? (github.source === 'gh_login' ? active : null);
  const authorOk = gitAuthor !== null && (gitAuthor.name ?? '').trim() !== '' && (gitAuthor.email ?? '').trim() !== '';
  const authorFix = 'set the git author: git config --global user.name "Your Name" and git config --global user.email you@example.com';
  if (github.status === 'unknown') {
    return { deliverDefault: 'pr', ready: null, github, pushAs, gitAuthor, reason: 'Delivery opens a pull request; gh did not answer in time, so the GitHub sign-in is not known yet.', fix: 'Re-check in a moment.' };
  }
  if (github.status === 'missing') {
    const signIn = account !== null ? `sign in to GitHub as ${account}: gh auth login` : 'sign in to GitHub: gh auth login';
    return {
      deliverDefault: 'pr',
      ready: false,
      github,
      pushAs,
      gitAuthor,
      reason: `Delivery opens a pull request, but ${account !== null ? `gh holds no sign-in for ${account}` : 'gh is not signed in to GitHub'}${logins === 'absent' ? ' (gh is not installed)' : ''}: a job would stop at its deliver step.`,
      fix: `To open pull requests, ${signIn} (or export GH_TOKEN for the daemon)${authorOk ? '' : `, and ${authorFix}`}; ${LOCAL_CHOICE}.`,
    };
  }
  if (!authorOk) {
    return {
      deliverDefault: 'pr',
      ready: false,
      github,
      pushAs,
      gitAuthor,
      reason: `Delivery opens a pull request${pushAs !== null ? ` as ${pushAs}` : ''}, but no git author is set: the deliver step's commit would carry no name.`,
      fix: `To open pull requests, ${authorFix}; ${LOCAL_CHOICE}.`,
    };
  }
  return {
    deliverDefault: 'pr',
    ready: true,
    github,
    pushAs,
    gitAuthor,
    reason: `Delivery opens a pull request${pushAs !== null ? ` as ${pushAs}` : ''}; commits by ${gitAuthor!.name} <${gitAuthor!.email}>.`,
    fix: null,
  };
}

/** The `delivery` infra row from the SAME answer: ready = ok, local = off, not ready = degraded, unknown = unknown. */
export function deliveryRow(r: DeliveryReadiness, startedAt: number, row: (key: 'delivery', state: SystemInfraRow['state'], reason: string, remedy: string | null, startedAt: number, details?: Record<string, unknown>) => SystemInfraRow): SystemInfraRow {
  const state: SystemInfraRow['state'] = r.deliverDefault === 'none' ? 'off' : r.ready === true ? 'ok' : r.ready === null ? 'unknown' : 'degraded';
  return row('delivery', state, r.reason, r.fix, startedAt, {
    deliverDefault: r.deliverDefault,
    pushAs: r.pushAs,
    github: r.github === null ? null : { status: r.github.status, source: r.github.source },
    gitAuthor: r.gitAuthor === null ? null : { named: (r.gitAuthor.name ?? '') !== '', emailed: (r.gitAuthor.email ?? '') !== '' },
  });
}

/** The readiness answer for this daemon now: its settings, gh's (memoised, 4 s-bounded) status and the global git
 *  author. The seams are injectable for the tests. */
export async function readDeliveryReadiness(
  settings: { deliverDefault?: 'pr' | 'none' | undefined; deliverIdentityLogin?: string | undefined },
  deps: { env?: NodeJS.ProcessEnv; gh?: typeof ghStatusRead; gitAuthor?: () => Promise<DeliveryReadiness['gitAuthor']> } = {},
): Promise<DeliveryReadiness> {
  const local = settings.deliverDefault === 'none';
  const [gh, gitAuthor] = await Promise.all([
    local ? Promise.resolve(null) : (deps.gh ?? ghStatusRead)().catch(() => null),
    (deps.gitAuthor ?? (() => gitIdentity()))().catch(() => null),
  ]);
  return deliveryReadiness({
    deliverDefault: settings.deliverDefault,
    identityLogin: settings.deliverIdentityLogin,
    env: deps.env ?? process.env,
    gh,
    gitAuthor,
  });
}
