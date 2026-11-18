/**
 * crew#1527: can a GitHub pull request be opened, BEFORE the first job? Delivery opens a pull request by default, but
 * nothing in the first-run path checked the GitHub sign-in it needs: the first job ran every phase and stopped at the
 * deliver step.
 *
 * ONE answer for both places that show it — studio's setup steps (`GET /setup/known` `delivery`) and the system page's
 * `delivery` infra row — read through ONE bounded reader ({@link readDeliveryReadiness}), built from what the deliver
 * script itself requires on a github.com origin (core/deliver.ts `deliverPrScript`):
 * - gh installed (the script opens the pull request with it);
 * - the credential by the launch preflight's rule ({@link githubCredentials}: an exported `GH_TOKEN`, else, with a
 *   push identity configured, that account's gh login, else gh's own login), and, unpinned, `gh auth status`
 *   succeeding, as the script checks it;
 * - an exported `GH_TOKEN` WITH a push identity is matched to that identity by the script over the network
 *   (`gh api user`): not checked here, so `ready` is `null` (unknown) for it, never `true`;
 * - a global git author with a name and an email (a fresh home has none, and `git commit` refuses).
 * Presence only: no token is read. Never names the git author's email (the system row is an observer read).
 *
 * Known gaps (stated in the wire docs): a repository's own push identity (`deliverIdentityByRepo`) and an Azure DevOps
 * origin are checked at launch for that repository; a repository-local git identity is not seen here.
 */

import type { SystemInfraRow } from 'wicked-crew-api-types';
import { ghStatusRead, githubCredentials, type DeliverCredentials } from '../core/deliver-credentials.js';
import { pushIdentityOf } from '../core/deliver.js';
import { gitIdentity } from './known.js';

/** api-types `DeliveryReadiness` (crew#1527). */
export interface DeliveryReadiness {
  /** The daemon's default for a launch that does not say (`pr` opens a pull request, `none` keeps the work on its
   *  branch). studio's composer always says, from its own "Open a PR when a build run finishes" preference. */
  deliverDefault: 'pr' | 'none';
  /** Can a GitHub PULL REQUEST be opened now? `true` = yes; `false` = a job that asks for one would stop at its deliver
   *  step; `null` = not known (gh did not answer in time, or an exported token's account is checked only at delivery).
   *  Answered whatever `deliverDefault` says. */
  ready: boolean | null;
  /** The GitHub credential, by the launch preflight's rule. */
  github: DeliverCredentials;
  /** The configured push identity (`deliverIdentityLogin`, else `GH_ACCOUNT`); `null` = none: gh's own login opens it. */
  pushAs: string | null;
  /** The global git author commits carry; `null` when neither name nor email is set. */
  gitAuthor: { name: string | null; email: string | null } | null;
  /** One sentence: what a pull-request delivery will do now (never the author's email). */
  reason: string;
  /** What to do when not ready (commands, or delivering locally); `null` when ready. */
  fix: string | null;
}

export interface DeliveryReadinessInput {
  /** `GET /settings` `deliverDefault` (absent = `pr`, the daemon default). */
  deliverDefault: 'pr' | 'none' | undefined;
  /** `GET /settings` `deliverIdentityLogin` (absent / blank = none). */
  identityLogin: string | undefined;
  env: NodeJS.ProcessEnv;
  /** gh's answer: the logins, the active one and whether `gh auth status` succeeded; `'absent'` (gh not installed);
   *  `null` (no answer in time). */
  gh: { logins: readonly string[]; active: string | null; ok: boolean } | 'absent' | null;
  gitAuthor: { name: string | null; email: string | null } | null;
}

const LOCAL_CHOICE =
  'or deliver locally, with no pull request (studio Settings: turn off "Open a PR when a build run finishes"; the daemon setting deliverDefault: none)';
const AUTHOR_FIX = 'set the git author: git config --global user.name "Your Name" and git config --global user.email you@example.com';

function authorComplete(a: DeliveryReadiness['gitAuthor']): boolean {
  return a !== null && (a.name ?? '').trim() !== '' && (a.email ?? '').trim() !== '';
}

/** The readiness answer (pure). */
export function deliveryReadiness(input: DeliveryReadinessInput): DeliveryReadiness {
  const deliverDefault = input.deliverDefault === 'none' ? 'none' : 'pr';
  const gitAuthor = input.gitAuthor;
  const account = pushIdentityOf(input.identityLogin, input.env);
  const gh = input.gh;
  const logins = gh === null ? null : gh === 'absent' ? 'absent' : gh.logins;
  const github = githubCredentials(input.env, logins, account);
  const authorOk = authorComplete(gitAuthor);
  const andAuthor = authorOk ? '' : `, and ${AUTHOR_FIX}`;
  const base = { deliverDefault, github, pushAs: account, gitAuthor } as const;
  const no = (reason: string, fix: string): DeliveryReadiness => ({ ...base, ready: false, reason: `A job that opens a pull request would stop at its deliver step: ${reason}.`, fix });
  const unknown = (reason: string, fix: string): DeliveryReadiness => ({ ...base, ready: null, reason, fix });
  const tokenExported = (input.env['GH_TOKEN'] ?? '').trim() !== '';

  if (gh === null) return unknown('gh did not answer in time, so whether a pull request can be opened is not known yet.', 'Re-check in a moment.');
  if (gh === 'absent') return no('gh is not installed (delivery opens the pull request with it)', `To open pull requests, install the GitHub CLI (gh) and sign in: gh auth login${andAuthor}; ${LOCAL_CHOICE}.`);
  if (github.status === 'missing') {
    const signIn = account !== null ? `sign in to GitHub as ${account}: gh auth login` : 'sign in to GitHub: gh auth login';
    return no(account !== null ? `gh holds no sign-in for ${account}` : 'gh is not signed in to GitHub', `To open pull requests, ${signIn} (or export GH_TOKEN for the daemon)${andAuthor}; ${LOCAL_CHOICE}.`);
  }
  if (github.status === 'unknown') return unknown('whether a pull request can be opened is not known yet.', 'Re-check in a moment.');
  // Unpinned and no token: the script requires `gh auth status` to succeed, not only a listed login.
  if (!tokenExported && account === null && !gh.ok) {
    return no('gh auth status fails (a sign-in it holds needs attention)', `To open pull requests, run gh auth status and fix the sign-in it names (gh auth login)${andAuthor}; ${LOCAL_CHOICE}.`);
  }
  if (!authorOk) {
    return no('no global git author is set, so the commit would be refused', `To open pull requests, ${AUTHOR_FIX}; ${LOCAL_CHOICE}.`);
  }
  // An exported token with a push identity: the script matches the token's account to it over the network.
  if (tokenExported && account !== null) {
    return unknown(`Pull requests open with the exported GH_TOKEN; delivery checks that it is ${account}'s, and refuses another account's.`, `Make sure the exported GH_TOKEN is ${account}'s, or unset it so delivery reads ${account}'s own gh sign-in.`);
  }
  const who = tokenExported ? 'with the exported GH_TOKEN' : account !== null ? `as ${account}` : gh.active !== null ? `with gh's signed-in account (${gh.active})` : "with gh's sign-in";
  return { ...base, ready: true, reason: `Pull requests open ${who}; commits carry your global git author.`, fix: null };
}

/** The `delivery` infra row from the SAME answer: a pull request can be opened = ok; it cannot = degraded, or off when
 *  the daemon defaults to local delivery (nothing it starts by default needs one); not known = unknown. */
export function deliveryRow(r: DeliveryReadiness, startedAt: number, row: (key: 'delivery', state: SystemInfraRow['state'], reason: string, remedy: string | null, startedAt: number, details?: Record<string, unknown>) => SystemInfraRow): SystemInfraRow {
  const state: SystemInfraRow['state'] = r.ready === true ? 'ok' : r.ready === null ? 'unknown' : r.deliverDefault === 'none' ? 'off' : 'degraded';
  const reason = r.deliverDefault === 'none' ? `Delivery defaults to local (deliverDefault: none). ${r.reason}` : r.reason;
  return row('delivery', state, reason, r.fix, startedAt, {
    ready: r.ready,
    deliverDefault: r.deliverDefault,
    pushAs: r.pushAs,
    github: { status: r.github.status, source: r.github.source },
    gitAuthor: r.gitAuthor === null ? null : { named: (r.gitAuthor.name ?? '').trim() !== '', emailed: (r.gitAuthor.email ?? '').trim() !== '' },
  });
}

/** How long one answer may take (both routes): the system snapshot's probe bound. */
export const DELIVERY_READ_MS = 4_000;
/** How long one global git author read serves (the system page polls). */
const AUTHOR_MEMO_MS = 30_000;
let authorMemo: { at: number; value: Promise<DeliveryReadiness['gitAuthor']> } | null = null;

function memoAuthor(): Promise<DeliveryReadiness['gitAuthor']> {
  const now = Date.now();
  if (authorMemo !== null && now - authorMemo.at < AUTHOR_MEMO_MS) return authorMemo.value;
  const value = gitIdentity().catch(() => null);
  authorMemo = { at: now, value };
  return value;
}

/** Tests only. */
export function resetDeliveryReadinessMemo(): void { authorMemo = null; }

type DeliverySettings = { deliverDefault?: 'pr' | 'none' | undefined; deliverIdentityLogin?: string | undefined };

/** The answer when the reads did not settle within {@link DELIVERY_READ_MS} (or failed): not known, never ready. The
 *  settings, when they were read, still say what they say (the default and the push identity); only when the settings
 *  themselves could not be read are these the daemon's defaults (`pr`, no identity). */
function notKnownYet(why: string, settings: DeliverySettings | null, env: NodeJS.ProcessEnv): DeliveryReadiness {
  return {
    deliverDefault: settings?.deliverDefault === 'none' ? 'none' : 'pr',
    ready: null,
    github: { provider: 'github', status: 'unknown', source: null, missing: [], message: why },
    pushAs: settings === null ? null : pushIdentityOf(settings.deliverIdentityLogin, env),
    gitAuthor: null,
    reason: why,
    fix: 'Re-check in a moment.',
  };
}

/** The ONE reader both routes use: this daemon's settings, gh's (memoised, 4 s-bounded) status and the global git
 *  author (memoised 30 s), within {@link DELIVERY_READ_MS}; a read that does not settle in time, or fails, is not known
 *  (`ready: null`). The seams are injectable for the tests. */
export async function readDeliveryReadiness(
  getSettings: () => Promise<DeliverySettings>,
  deps: { env?: NodeJS.ProcessEnv; gh?: typeof ghStatusRead; gitAuthor?: () => Promise<DeliveryReadiness['gitAuthor']>; timeoutMs?: number } = {},
): Promise<DeliveryReadiness> {
  const env = deps.env ?? process.env;
  // The settings read on its own, so an answer past the bound still carries what they say.
  let settingsRead: DeliverySettings | null = null;
  const settingsP = getSettings().then((s) => {
    settingsRead = s;
    return s;
  });
  const read = (async () => {
    const [settings, gh, gitAuthor] = await Promise.all([
      settingsP,
      (deps.gh ?? ghStatusRead)().catch(() => null),
      (deps.gitAuthor ?? memoAuthor)().catch(() => null),
    ]);
    return deliveryReadiness({
      deliverDefault: settings.deliverDefault,
      identityLogin: settings.deliverIdentityLogin,
      env,
      gh,
      gitAuthor,
    });
  })();
  const ms = deps.timeoutMs ?? DELIVERY_READ_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<DeliveryReadiness>((resolve) => {
    timer = setTimeout(() => resolve(notKnownYet(`the delivery check did not answer within ${ms / 1000} s`, settingsRead, env)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      read.catch((e: unknown) => notKnownYet(`the delivery check could not read its settings: ${e instanceof Error ? e.message : String(e)}`, settingsRead, env)),
      late,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
