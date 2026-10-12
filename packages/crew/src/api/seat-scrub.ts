/**
 * Account identifiers never reach the wire (DES-seats-page A8 and A2).
 *
 * A seat's own words ride `GET /roster` as `auth_evidence` and inside `login_note`, and those are
 * the CLI's status output. Signed in, `claude auth status --json` prints the account (`email`,
 * `orgId`, `orgName`) beside the fields the roster needs (`loggedIn`, `authMethod`). `codex login
 * status` prints a masked key prefix ("Logged in using an API key - sk-proj-***"). This module is
 * the one place that turns that output into something the roster may carry:
 *
 *  - {@link scrubStatusOutput} reads a JSON status object for its ALLOWLISTED fields only, so an
 *    account field that a newer CLI adds is dropped too, and a field this module does not know is
 *    never carried;
 *  - {@link scrubEvidence} is the second guard for free text: email-like, UUID-like and key-shaped
 *    strings are masked, wherever they appear;
 *  - {@link accountFromStatus} reads the account KIND (and a provider-public plan name) from the
 *    raw output BEFORE the scrub. It never returns an identifier.
 *
 * The roster's evidence fields carry ONLY crew's own vocabulary (codex r2 on #996: no mask can know
 * every shape an identifier takes in a CLI's prose): {@link statusSummary} for a status command,
 * {@link liveSummary} for the live check, `refusalSummary` (seat-health.ts) for a seat's refusal.
 * {@link scrubEvidence} stays as the second guard over all of them.
 *
 * Pure: no IO, no clock.
 */

import { refusalSummary } from './seat-health.js';

/** The fields of a JSON auth-status object the roster may carry. Everything else is dropped. */
const STATUS_ALLOWLIST: readonly string[] = ['loggedIn', 'authMethod', 'apiProvider'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A provider key prefix with whatever follows it (masked or not): `sk-…`, `sk-ant-…`, `ghp_…`,
 *  `gho_…`, `github_pat_…`, `xox?-…`, `AKIA…`. */
const KEY_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_*.-]*|gh[pousr]_[A-Za-z0-9_*]*|github_pat_[A-Za-z0-9_*]*|xox[abprs]-[A-Za-z0-9*-]*|AKIA[A-Z0-9*]*)/g;
/** A long unbroken token (24+ chars of a key alphabet, holding a digit or a capital): an access
 *  token, a bearer, a hash. Version strings never reach this length without a separator, and a
 *  snake_case word (`read_only_requires_wrapped`) holds neither. */
const LONG_TOKEN_RE = /\b(?=[A-Za-z0-9_\-]*[0-9A-Z])[A-Za-z0-9_\-]{24,}\b/g;
/** `Bearer <token>` / `Basic <token>`: whatever follows the scheme. */
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+[^\s,;)}\]]+/gi;
/** `key: value` / `key=value` pairs whose key names an account identifier or a secret. The value is
 *  masked to the end of its clause — a quoted string, or everything up to `,` `;` `)` `}` `]` or the
 *  line's end — so a multi-word name ("organization: Acme Research Ltd") goes whole. */
const ACCOUNT_PAIR_RE =
  /("?(?:e-?mail|email_?address|account(?:_?id|_?uuid|_?name)?|org(?:ani[sz]ation)?(?:_?id|_?uuid|_?name)?|team(?:_?id|_?name)?|workspace(?:_?id|_?name)?|tenant(?:_?id)?|user(?:_?id|_?name)?|login|username|(?:access_?|refresh_?|id_?|session_?|auth_?)?token|api_?key|secret|password|passwd|credentials?|authorization|cookie)"?\s*[:=]\s*)("[^"]*"|[^,;)}\]\n]+)/gi;

/** Mask every account identifier in free text (the second guard; see the module doc). */
export function scrubEvidence(text: string): string {
  return text
    .replace(ACCOUNT_PAIR_RE, (_m, key: string, value: string) => `${key}${value.startsWith('"') ? '"<redacted>"' : '<redacted>'}`)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} <redacted>`)
    .replace(EMAIL_RE, '<email>')
    .replace(UUID_RE, '<id>')
    .replace(KEY_PREFIX_RE, '<key>')
    .replace(LONG_TOKEN_RE, '<redacted>');
}

/**
 * A CLI's status output reduced to what the roster may carry. JSON objects (claude) keep only the
 * {@link STATUS_ALLOWLIST} fields, re-serialized compactly; anything else goes through
 * {@link scrubEvidence}.
 */
export function scrubStatusOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const kept: Record<string, unknown> = {};
        for (const k of STATUS_ALLOWLIST) {
          const v = (parsed as Record<string, unknown>)[k];
          if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 40)) kept[k] = v;
        }
        return scrubEvidence(JSON.stringify(kept));
      }
    } catch {
      /* not one JSON object: the text guard below */
    }
  }
  return scrubEvidence(text);
}

/** `RosterSeat.account.kind` (api-types 0.115.0). */
export type SeatAccountKind = 'subscription' | 'api_key' | 'free' | 'unknown';

export interface SeatAccount {
  kind: SeatAccountKind;
  /** A provider-public plan name ("Max", "Pro"), only from the fixed table below. */
  plan?: string;
}

/** Provider-public plan names, by the status output's own token. Anything else is not carried. */
const CLAUDE_PLANS: Readonly<Record<string, string>> = Object.freeze({
  max: 'Max',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
});

/**
 * The account kind a seat's auth-status output states, or `undefined` when it states none (the
 * caller then says `unknown`). Read from the RAW output; returns no identifier.
 *
 *  - claude (`auth status --json`): `authMethod: "claude.ai"` is a subscription (plan from
 *    `subscriptionType`), `"api_key"` an API key;
 *  - codex (`login status`): "Logged in using ChatGPT" is a subscription; an API key, an access
 *    token or a Bedrock key is `api_key`.
 */
export function accountFromStatus(seatKey: string, stdout: string, stderr = ''): SeatAccount | undefined {
  if (seatKey === 'claude') {
    try {
      const parsed = JSON.parse(stdout.trim()) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
      if (parsed.loggedIn !== true) return undefined;
      if (parsed.authMethod === 'claude.ai') {
        const plan = typeof parsed.subscriptionType === 'string' ? CLAUDE_PLANS[parsed.subscriptionType.toLowerCase()] : undefined;
        return { kind: 'subscription', ...(plan !== undefined ? { plan } : {}) };
      }
      if (parsed.authMethod === 'api_key') return { kind: 'api_key' };
      return { kind: 'unknown' };
    } catch {
      return undefined;
    }
  }
  if (seatKey === 'codex') {
    const said = `${stdout}\n${stderr}`;
    if (/logged in using chatgpt/i.test(said)) return { kind: 'subscription' };
    if (/logged in using (?:an api key|amazon bedrock|(?:a )?(?:personal )?access token)/i.test(said)) return { kind: 'api_key' };
    if (/logged in using/i.test(said)) return { kind: 'unknown' };
  }
  return undefined;
}

/** A probe process's outcome, as `seat-probe.ts` reports it (structural). */
export interface ProbeOutputLike {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Why a probe process did not answer, in crew's words. */
function processFailure(error: string): string {
  if (/ENOENT/.test(error)) return 'the CLI is not installed (ENOENT)';
  if (/ETIMEDOUT|timed? ?out|SIGTERM|killed/i.test(error)) return 'timed out';
  return 'the CLI did not run';
}

/** codex `login status` phrases (codex 0.16x), the only words carried from its output. */
const CODEX_STATUS_PHRASES: readonly RegExp[] = [
  /Not logged in/i,
  /Logged in using ChatGPT/i,
  /Logged in using an API key/i,
  /Logged in using Amazon Bedrock (?:API key|AWS access keys)/i,
  /Logged in using (?:personal )?access token/i,
  /Logged in using workload identity/i,
];

/**
 * A status command's answer, in crew's words only: claude's JSON reduced to its allowlisted
 * fields (stdout alone — a stderr warning never turns the allowlist off; malformed JSON is
 * withheld, never echoed), codex's known phrase, plus any refusal phrase stderr carried.
 */
export function statusSummary(seatKey: string, out: ProbeOutputLike): string {
  if (out.error !== undefined || out.code === null) return processFailure(out.error ?? '');
  let main: string;
  if (seatKey === 'claude') {
    const stdout = out.stdout.trim();
    main =
      stdout.startsWith('{') && isJsonObject(stdout)
        ? scrubStatusOutput(stdout)
        : (refusalSummary(out.stdout) ?? `exit ${out.code}: the status output is not JSON (withheld)`);
  } else {
    const said = `${out.stdout}\n${out.stderr}`;
    const phrase = CODEX_STATUS_PHRASES.map((re) => re.exec(said)?.[0]).find((p) => p !== undefined);
    main = phrase ?? `exit ${out.code}: the status output is withheld`;
  }
  const refused = refusalSummary(out.stderr);
  return scrubEvidence(refused !== null && !main.toLowerCase().includes(refused.toLowerCase()) ? `${main}; ${refused}` : main);
}

/** What stops a live request, beyond a refusal for want of a credential (crew's words). */
const LIVE_BLOCKERS: ReadonlyArray<[RegExp, string]> = [
  [/usage limit/i, 'usage limit'],
  [/rate[ -]?limit/i, 'rate limit'],
  [/quota/i, 'quota'],
  [/overloaded/i, 'overloaded'],
  [/stream disconnected|ECONNRESET|ECONNREFUSED|ENOTFOUND|network/i, 'network'],
];

/** The live check's answer, in crew's words only: the refusal phrase, a known blocker, or the exit. */
export function liveSummary(out: ProbeOutputLike): string {
  if (out.error !== undefined || out.code === null) return processFailure(out.error ?? '');
  const said = `${out.stdout}\n${out.stderr}`;
  const refused = refusalSummary(said);
  if (refused !== null) return scrubEvidence(refused);
  const blocker = LIVE_BLOCKERS.find(([re]) => re.test(said))?.[1];
  return blocker !== undefined ? `exit ${out.code}: ${blocker}` : `exit ${out.code}`;
}

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}
