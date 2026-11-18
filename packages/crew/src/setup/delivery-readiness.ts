/**
 * crew#1527: can a GitHub pull request be opened, BEFORE the first job? Delivery opens a pull request by default, but
 * nothing in the first-run path checked the GitHub sign-in it needs: the first job ran every phase and stopped at the
 * deliver step.
 *
 * ONE answer for both places that show it — studio's setup steps (`GET /setup/known` `delivery`) and the system page's
 * `delivery` infra row — read through ONE bounded reader ({@link readDeliveryReadiness}). Nothing of what delivery
 * requires is restated here; it is RUN:
 * - the GitHub credential: the deliver script's own credential lines ({@link GITHUB_CREDENTIAL_LINES}, the same text
 *   `deliverPrScript` runs), in the same shell (`bash -lc`) and the daemon's environment, so whatever token delivery
 *   would use (an exported `GH_TOKEN` or `GITHUB_TOKEN`, a push identity's keyring token, gh's own login) is the one
 *   checked; then that token asks GitHub who it is (`gh api user`, the script's own call), which also refuses an
 *   expired or revoked token and an exported token of another account than the push identity;
 * - the git author and committer: asked of git as wicked-core asks before a seat commits ({@link gitCommitIdents}).
 * A check that could not answer (a timeout, a spawn failure, GitHub not reachable, git failing) is `ready: null`, never
 * `true` and never `false`. No token leaves the probe's shell; the author's email is never in the words.
 *
 * Known gaps (stated in the wire docs): a repository's own push identity (`deliverIdentityByRepo`) and an Azure DevOps
 * origin are checked at launch for that repository; a repository-local git identity is not seen here.
 */

import type { SystemInfraRow } from 'wicked-crew-api-types';
import type { DeliverCredentials } from '../core/deliver-credentials.js';
import { execCapped } from '../core/exec.js';
import { GH_CALL_LINE, GITHUB_CREDENTIAL_LINES, pushIdentityOf, shellSingleQuote } from '../core/deliver.js';
import { gitCommitIdents, usableGitIdent, type GitCommitIdents } from './known.js';

/** api-types `DeliveryReadiness` (crew#1527). */
export interface DeliveryReadiness {
  /** The daemon's default for a launch that does not say (`pr` opens a pull request, `none` keeps the work on its
   *  branch). studio's composer always says, from its own "Open a PR when a build run finishes" preference. */
  deliverDefault: 'pr' | 'none';
  /** Can a GitHub PULL REQUEST be opened now? `true` = yes; `false` = a job that asks for one would stop at its deliver
   *  step; `null` = could not check (a timeout, GitHub or git not answering). Answered whatever `deliverDefault` says. */
  ready: boolean | null;
  /** The GitHub credential delivery would use, as its own credential lines resolved it. */
  github: DeliverCredentials;
  /** The configured push identity (`deliverIdentityLogin`, else `GH_ACCOUNT`); `null` = none: gh's own login opens it. */
  pushAs: string | null;
  /** The git author commits carry, as git resolves it; `null` when none is configured or it could not be read. */
  gitAuthor: { name: string | null; email: string | null } | null;
  /** One sentence: what a pull-request delivery will do now (never the author's email). */
  reason: string;
  /** What to do when not ready (commands, or delivering locally); `null` when ready. */
  fix: string | null;
}

/** What the deliver script's credential lines and `gh api user` found; `null` = could not check. */
export type GithubCredentialProbe =
  | { outcome: 'ok'; pin: 'exported' | 'keyring' | 'gh'; login: string | null }
  | { outcome: 'missing'; why: string }
  | { outcome: 'absent' }
  | { outcome: 'refused'; pin: 'exported' | 'keyring' | 'gh' }
  | { outcome: 'mismatch'; login: string }
  | null;

export interface DeliveryReadinessInput {
  /** `GET /settings` `deliverDefault` (absent = `pr`, the daemon default). */
  deliverDefault: 'pr' | 'none' | undefined;
  /** `GET /settings` `deliverIdentityLogin` (absent / blank = none). */
  identityLogin: string | undefined;
  env: NodeJS.ProcessEnv;
  credential: GithubCredentialProbe;
  identity: GitCommitIdents;
}

const LOCAL_CHOICE =
  'or deliver locally, with no pull request (studio Settings: turn off "Open a PR when a build run finishes"; the daemon setting deliverDefault: none)';
const AUTHOR_FIX = 'set the git author: git config --global user.name "Your Name" and git config --global user.email you@example.com';

function githubOf(c: GithubCredentialProbe, env: NodeJS.ProcessEnv): DeliverCredentials {
  if (c === null) return { provider: 'github', status: 'unknown', source: null, missing: [], message: 'GitHub credentials: could not be checked.' };
  if (c.outcome === 'ok') {
    // Unpinned, gh itself prefers an exported GITHUB_TOKEN over its stored sign-in.
    const envVar = c.pin === 'exported' ? 'GH_TOKEN' : c.pin === 'gh' && (env['GITHUB_TOKEN'] ?? '').trim() !== '' ? 'GITHUB_TOKEN' : null;
    return envVar !== null
      ? { provider: 'github', status: 'configured', source: 'gh_token', missing: [], message: `GitHub credentials: ${envVar} in the daemon environment.` }
      : { provider: 'github', status: 'configured', source: 'gh_login', missing: [], message: "GitHub credentials: gh's sign-in." };
  }
  return { provider: 'github', status: 'missing', source: null, missing: ['gh auth login', 'GH_TOKEN'], message: 'GitHub credentials: delivery would refuse them.' };
}

/** The readiness answer (pure). A definite blocker is `false`; otherwise anything not checked is `null`. */
export function deliveryReadiness(input: DeliveryReadinessInput): DeliveryReadiness {
  const deliverDefault = input.deliverDefault === 'none' ? 'none' : 'pr';
  const account = pushIdentityOf(input.identityLogin, input.env);
  const c = input.credential;
  const id = input.identity;
  const author = id?.author ?? null;
  const gitAuthor = author === null ? null : { name: author.name, email: author.email };
  const envToken = ['GH_TOKEN', 'GITHUB_TOKEN'].find((k) => (input.env[k] ?? '').trim() !== '');
  const tokenHint = envToken !== undefined ? ` (the exported ${envToken} is what delivery uses: export a valid one, or unset it so gh's stored sign-in is used)` : '';
  const blockers: string[] = [];
  const fixes: string[] = [];
  const unknowns: string[] = [];

  if (c === null) unknowns.push('the GitHub credential could not be checked (gh did not answer in time, or GitHub could not be reached)');
  else if (c.outcome === 'absent') {
    blockers.push('gh is not installed (delivery opens the pull request with it)');
    fixes.push('install the GitHub CLI (gh) and sign in: gh auth login');
  } else if (c.outcome === 'missing') {
    blockers.push(c.why.replace(/\.\s*$/u, ''));
    fixes.push(`${account !== null ? `sign in to GitHub as ${account}: gh auth login` : 'sign in to GitHub: gh auth login'} (or export GH_TOKEN for the daemon)${tokenHint}`);
  } else if (c.outcome === 'refused') {
    const whose = c.pin === 'exported' ? 'the exported GH_TOKEN' : c.pin === 'keyring' ? `${account ?? 'the push identity'}'s gh sign-in` : envToken !== undefined ? `the exported ${envToken}` : "gh's sign-in";
    blockers.push(`GitHub refuses ${whose} (expired or revoked)`);
    fixes.push(c.pin === 'exported' ? 'export a valid GH_TOKEN, or unset it' : `sign in again: gh auth login${account !== null ? ` as ${account}` : ''}${tokenHint}`);
  } else if (c.outcome === 'mismatch') {
    blockers.push(`the exported GH_TOKEN authenticates as ${c.login}, not the push identity ${account ?? ''}, and delivery refuses another account's token`);
    fixes.push(`export ${account ?? 'the push identity'}'s token as GH_TOKEN, or unset it so delivery reads ${account ?? 'that account'}'s own gh sign-in`);
  }

  if (id === null) unknowns.push('the git author could not be read');
  else {
    const roles = (['author', 'committer'] as const).filter((r) => !usableGitIdent(id[r]));
    if (roles.length > 0) {
      blockers.push(`no git ${roles.join(' or ')} identity is configured, so the commit would be refused`);
      fixes.push(AUTHOR_FIX);
    }
  }

  const base = { deliverDefault, github: githubOf(c, input.env), pushAs: account, gitAuthor } as const;
  if (blockers.length > 0) {
    const notChecked = unknowns.length > 0 ? ` Not checked: ${unknowns.join('; ')}.` : '';
    return { ...base, ready: false, reason: `A job that opens a pull request would stop at its deliver step: ${blockers.join('; ')}.${notChecked}`, fix: `To open pull requests, ${fixes.join(', and ')}; ${LOCAL_CHOICE}.` };
  }
  if (unknowns.length > 0 || c === null || c.outcome !== 'ok') {
    return { ...base, ready: null, reason: `Whether a pull request can be opened is not known yet: ${unknowns.join('; ')}.`, fix: 'Re-check in a moment.' };
  }
  const who = c.pin === 'exported' ? `with the exported GH_TOKEN${c.login !== null ? ` (${c.login})` : ''}` : c.pin === 'keyring' ? `as ${account}` : c.login !== null ? `with gh's signed-in account (${c.login})` : "with gh's sign-in";
  return { ...base, ready: true, reason: `Pull requests open ${who}; commits carry your git author.`, fix: null };
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

const PROBE = 'WICKED_DELIVERY_READINESS';

/** The probe: the deliver script's credential lines and its `gh api user`, ending in one marker line. No token is
 *  printed (gh's error words only reach the shell's case). */
export function credentialProbeScript(identity: string): string {
  const say = (words: string) => `printf '%s\\n' "${PROBE} ${words}"`;
  return [
    `_credmissing() { ${say('missing')}; printf '%s\\n' "$2"; exit 0; }`,
    "GHREPO='readiness/probe'",
    "GHT=''",
    "GHPIN=''",
    `CFG=${shellSingleQuote(identity)}`,
    'if [ -n "$CFG" ]; then GH_ACCOUNT="$CFG"; fi',
    // gh opens the pull request, whatever the credential.
    `command -v gh >/dev/null 2>&1 || { ${say('absent')}; exit 0; }`,
    GH_CALL_LINE,
    ...GITHUB_CREDENTIAL_LINES,
    '[ -n "$GHPIN" ] || GHPIN=gh',
    // The login is gh's stdout alone, as the script reads it (`2>/dev/null`): gh's diagnostics (GH_DEBUG) go to stderr.
    // Only a failed call is asked again for its words, to tell a refused credential from GitHub not answering.
    'OUT=$(_gh api user -q .login 2>/dev/null); RC=$?',
    `if [ "$RC" -ne 0 ]; then ERR=$(_gh api user -q .login 2>&1 >/dev/null); case "$ERR" in *"HTTP 401"*|*"Bad credentials"*) ${say('refused $GHPIN')};; *) ${say('unreachable')};; esac; exit 0; fi`,
    `if [ "$GHPIN" = exported ] && [ -n "\${GH_ACCOUNT:-}" ] && [ "$OUT" != "$GH_ACCOUNT" ]; then ${say('mismatch $OUT')}; exit 0; fi`,
    say('ok $GHPIN $OUT'),
  ].join('\n');
}

/** Parse the probe's output (the LAST marker line: a login shell's profile may print before it). */
export function parseCredentialProbe(stdout: string): GithubCredentialProbe {
  const lines = stdout.split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith(`${PROBE} `)) at = i;
  if (at < 0) return null;
  const [, kind, a, b] = lines[at]!.split(' ');
  const pin = (p: string | undefined) => (p === 'exported' || p === 'keyring' ? p : 'gh');
  switch (kind) {
    case 'ok': return { outcome: 'ok', pin: pin(a), login: b !== undefined && b !== '' ? b : null };
    case 'missing': return { outcome: 'missing', why: (lines[at + 1] ?? '').trim() || 'GitHub credentials not configured' };
    case 'absent': return { outcome: 'absent' };
    case 'refused': return { outcome: 'refused', pin: pin(a) };
    case 'mismatch': return { outcome: 'mismatch', login: a ?? '' };
    default: return null;
  }
}

/** How long one probe may take (inside {@link DELIVERY_READ_MS}). */
const PROBE_MS = 3_500;

/** Run the probe in the deliver step's shell (`bash -lc`, deliver.ts) and the daemon's environment. Any failure to
 *  run it is `null` (could not check). `shell` is a seam for the tests. */
export async function probeGithubCredential(identity: string, opts: { env?: NodeJS.ProcessEnv; shell?: readonly [string, ...string[]]; timeoutMs?: number } = {}): Promise<GithubCredentialProbe> {
  const [cmd, ...args] = opts.shell ?? ['bash', '-lc'];
  try {
    const { stdout } = await execCapped(cmd, [...args, credentialProbeScript(identity)], { timeout: opts.timeoutMs ?? PROBE_MS, windowsHide: true, env: opts.env ?? process.env });
    return parseCredentialProbe(stdout);
  } catch {
    return null;
  }
}

/** How long one answer may take (both routes): the system snapshot's probe bound. */
export const DELIVERY_READ_MS = 4_000;
/** How long one read serves (the system page polls; a sign-in or a git config is rare). */
const MEMO_MS = 30_000;
let identMemo: { at: number; value: Promise<GitCommitIdents> } | null = null;
let credMemo: { at: number; key: string; value: Promise<GithubCredentialProbe> } | null = null;

function memoIdents(): Promise<GitCommitIdents> {
  const now = Date.now();
  if (identMemo !== null && now - identMemo.at < MEMO_MS) return identMemo.value;
  const value = gitCommitIdents().catch(() => null);
  identMemo = { at: now, value };
  return value;
}

function memoCredential(identity: string): Promise<GithubCredentialProbe> {
  const now = Date.now();
  if (credMemo !== null && credMemo.key === identity && now - credMemo.at < MEMO_MS) return credMemo.value;
  const value = probeGithubCredential(identity).catch(() => null);
  credMemo = { at: now, key: identity, value };
  return value;
}

/** Tests only. */
export function resetDeliveryReadinessMemo(): void {
  identMemo = null;
  credMemo = null;
}

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

/** The ONE reader both routes use: this daemon's settings, the credential probe and git's identities (each memoised
 *  30 s), within {@link DELIVERY_READ_MS}; a read that does not settle in time, or fails, is not known (`ready: null`).
 *  The seams are injectable for the tests. */
export async function readDeliveryReadiness(
  getSettings: () => Promise<DeliverySettings>,
  deps: { env?: NodeJS.ProcessEnv; credential?: (identity: string) => Promise<GithubCredentialProbe>; identity?: () => Promise<GitCommitIdents>; timeoutMs?: number } = {},
): Promise<DeliveryReadiness> {
  const env = deps.env ?? process.env;
  // The settings read on its own, so an answer past the bound still carries what they say.
  let settingsRead: DeliverySettings | null = null;
  const settingsP = getSettings().then((s) => {
    settingsRead = s;
    return s;
  });
  const read = (async () => {
    const settings = await settingsP;
    const identityLogin = (settings.deliverIdentityLogin ?? '').trim();
    const [credential, identity] = await Promise.all([
      (deps.credential ?? memoCredential)(identityLogin).catch(() => null),
      (deps.identity ?? memoIdents)().catch(() => null),
    ]);
    return deliveryReadiness({ deliverDefault: settings.deliverDefault, identityLogin: settings.deliverIdentityLogin, env, credential, identity });
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
