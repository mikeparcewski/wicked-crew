/**
 * Sign-in for the standalone site (DES-APPS-001 §8.2): one issuer per site, fixed at publish, two token
 * profiles, verified with crew's verifier code (signature from the issuer's keys through the dialer; `iss`,
 * `aud`, `exp`, `nbf`), then judged here against the profile and the app's audience rule.
 *
 * - **oidc**: the ID token, `aud` = the client id (when `aud` lists more than one audience, `azp` must be the
 *   client id). Audience by group claim values, or by email domain with a Boolean `email_verified: true`.
 *   `viewer.email` only when `email_verified === true`, whatever the audience rule.
 * - **entra**: a v2 ACCESS token for the app's own scope: `ver` 2.0, `aud` = the client id, `tid` = the
 *   tenant, `scp` holds `access_as_user`, and `oid` and `upn` are present. An app-only token (no `scp`) and an
 *   ID token are refused. Audience by app-role values (`roles`) or group object ids (a token with a groups
 *   overage marker instead of groups is refused). `viewer.email` = the `upn`.
 *
 * Every judgement returns the claims the decision log keeps (never the token).
 */

import { createHash } from 'node:crypto';

import type { Actor, AppAudienceRule, AppPublishIdentity, DialOptions, OidcConfig, Viewer } from './crew.js';
import { verifyOidcClaims } from './crew.js';

/** The Teams clients that ask Entra for the site's token through Teams SSO (DES §8.3 step 3). */
export const TEAMS_CLIENT_IDS = ['1fec8e78-bce4-4aaf-ab1b-5451cc387264', '5e3ce6c0-2b1f-4285-8d4b-75ee78787346'] as const;

/** What the decision log records of a token: the claims that decided, never the token or its signature. */
export interface LoggedClaims {
  iss: string | null;
  ver: string | null;
  aud: string | string[] | null;
  sub: string | null;
  scp: string | null;
  tid: string | null;
  oid: string | null;
  upn: string | null;
  email: string | null;
  email_verified: unknown;
  azp: string | null;
  roles: string[] | null;
  groups: string[] | null;
}

export type Judgement =
  | { ok: true; actor: Actor; viewer: Viewer; claims: LoggedClaims }
  | { ok: false; status: 401 | 403; code: string; reason: string; claims: LoggedClaims | null };

/**
 * A bearer token is at most this long. Node's HTTP server refuses a header block over 16 KB anyway, so a longer
 * token could never arrive: this only says so before any work.
 */
const MAX_TOKEN = 16 * 1024;
/** How many list entries the DECISION LOG keeps. Audience rules always judge the whole claim. */
const LOG_LIST_MAX = 50;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null);
/** Every string of a list claim (`null` = not a list). The whole list: a group past any cut is still a group. */
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
const logList = (v: unknown): string[] | null => strList(v)?.slice(0, LOG_LIST_MAX) ?? null;
/** The JWT header's `typ`, read without trusting it for anything but refusing an access token. */
function headerTyp(token: string): string | null {
  try {
    const h = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { typ?: unknown };
    return typeof h.typ === 'string' ? h.typ.toLowerCase() : null;
  } catch {
    return null;
  }
}

function logged(c: Readonly<Record<string, unknown>>, groupsClaim: string): LoggedClaims {
  const aud = c['aud'];
  return {
    iss: str(c['iss']),
    ver: str(c['ver']),
    aud: typeof aud === 'string' ? aud : Array.isArray(aud) ? aud.filter((x): x is string => typeof x === 'string').slice(0, 10) : null,
    sub: str(c['sub']),
    scp: str(c['scp']),
    tid: str(c['tid']),
    oid: str(c['oid']),
    upn: str(c['upn']),
    email: str(c['email']),
    email_verified: c['email_verified'] === undefined ? null : c['email_verified'],
    azp: str(c['azp']),
    roles: logList(c['roles']),
    groups: logList(c[groupsClaim]),
  };
}

/** `Authorization: Bearer <token>`, exactly; anything else is no token. */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
  if (m === null || m[1]!.length > MAX_TOKEN) return null;
  return m[1]!;
}

export interface SiteSignIn {
  identity: AppPublishIdentity;
  audience: Exclude<AppAudienceRule, { kind: 'public' }>;
  /** The Teams tab is published: Entra tokens the Teams clients asked for (their `azp`) are the site's too. */
  teams?: boolean;
  dial?: DialOptions;
  /** Tests only: the verifier (default: crew's `verifyOidcClaims`). */
  verify?: (token: string, config: OidcConfig, deps: { dial?: DialOptions }) => Promise<Readonly<Record<string, unknown>>>;
}

export class SignIn {
  private readonly config: OidcConfig;
  private readonly verify: NonNullable<SiteSignIn['verify']>;
  /**
   * The namespace of this site's principals: a record or audit line names `<profile>:<issuer or tenant>:<subject>`,
   * so the same `sub` from another issuer (a republish onto the same volume) is never the same person.
   */
  private readonly principal: string;

  constructor(private readonly opts: SiteSignIn) {
    const { identity, audience } = opts;
    if (!identity.issuer.startsWith('https://')) throw new Error(`the issuer must be an https:// URL (got ${JSON.stringify(identity.issuer)})`);
    if (identity.clientId.length === 0) throw new Error('the client id is required');
    const profileOf = (k: AppAudienceRule['kind']): 'oidc' | 'entra' => (k.startsWith('entra-') ? 'entra' : 'oidc');
    if (profileOf(audience.kind) !== identity.profile) throw new Error(`audience rule ${audience.kind} is not one of the ${identity.profile} profile's`);
    if (identity.profile === 'entra' && (identity.tenantId === undefined || !/^[0-9a-f-]{36}$/i.test(identity.tenantId))) throw new Error('the entra profile names its tenant id');
    this.config = { issuer: identity.issuer, audience: identity.clientId, ...(identity.allowRanges !== undefined ? { allowRanges: identity.allowRanges } : {}) };
    this.verify = opts.verify ?? verifyOidcClaims;
    const ns = identity.profile === 'entra' ? identity.tenantId!.toLowerCase() : createHash('sha256').update(`${identity.issuer}\u0000${identity.clientId}`).digest('hex').slice(0, 16);
    this.principal = `${identity.profile}:${ns}:`;
  }

  async judge(authorization: string | string[] | undefined): Promise<Judgement> {
    const token = bearerOf(authorization);
    if (token === null) return { ok: false, status: 401, code: 'sign_in', reason: 'sign in to open this app', claims: null };
    let claims: Readonly<Record<string, unknown>>;
    try {
      claims = await this.verify(token, this.config, this.opts.dial !== undefined ? { dial: this.opts.dial } : {});
    } catch {
      return { ok: false, status: 401, code: 'invalid_token', reason: 'the sign-in is not valid here: sign in again', claims: null };
    }
    const groupsClaim = this.opts.audience.kind === 'oidc-groups' ? (this.opts.audience.claim ?? 'groups') : 'groups';
    const log = logged(claims, groupsClaim);
    return this.opts.identity.profile === 'entra' ? this.entra(claims, log) : this.oidc(claims, log, groupsClaim, headerTyp(token));
  }

  private refuse(status: 401 | 403, code: string, reason: string, claims: LoggedClaims): Judgement {
    return { ok: false, status, code, reason, claims };
  }

  private oidc(c: Readonly<Record<string, unknown>>, log: LoggedClaims, groupsClaim: string, typ: string | null): Judgement {
    const clientId = this.opts.identity.clientId;
    // A token issued to several audiences is ours only when it was issued TO us (OIDC Core 3.1.3.7), and an `azp`
    // naming another client means another app asked for it.
    if (Array.isArray(c['aud']) && c['aud'].length > 1 && c['azp'] !== clientId) return this.refuse(401, 'wrong_token', 'this sign-in was issued to another app', log);
    if (c['azp'] !== undefined && c['azp'] !== clientId) return this.refuse(401, 'wrong_token', 'this sign-in was issued to another app', log);
    // The ID token, not an access token the same issuer minted for this audience (RFC 9068 `at+jwt`, or a token
    // carrying a delegated scope).
    if (typ === 'at+jwt' || typ === 'application/at+jwt' || c['scp'] !== undefined || c['scope'] !== undefined) return this.refuse(401, 'wrong_token', 'this site takes the ID token of your sign-in', log);
    const sub = str(c['sub']);
    if (sub === null) return this.refuse(401, 'wrong_token', 'the sign-in names no subject', log);
    const verified = c['email_verified'] === true;
    const email = verified ? str(c['email']) : null;
    const groups = strList(c[groupsClaim]) ?? [];
    const rule = this.opts.audience;
    let inAudience = false;
    if (rule.kind === 'oidc-groups') inAudience = groups.some((g) => rule.groups.includes(g));
    else if (rule.kind === 'oidc-email-domain') {
      const domain = email === null ? null : email.slice(email.lastIndexOf('@') + 1).toLowerCase();
      inAudience = domain !== null && email!.includes('@') && rule.domains.some((d) => d.toLowerCase() === domain);
    }
    if (!inAudience) return this.refuse(403, 'not_in_audience', "you don't have access to this app", log);
    const id = `${this.principal}${sub}`;
    const actor = Object.freeze({ id, kind: 'human', trust: 'operator' }) as Actor;
    const name = str(c['name']) ?? str(c['preferred_username']);
    return { ok: true, actor, viewer: { id, email, name, groups }, claims: log };
  }

  private entra(c: Readonly<Record<string, unknown>>, log: LoggedClaims): Judgement {
    const { tenantId } = this.opts.identity;
    if (c['ver'] !== '2.0') return this.refuse(401, 'wrong_token', 'this site takes v2 access tokens', log);
    if (typeof c['aud'] !== 'string' || c['aud'] !== this.opts.identity.clientId) return this.refuse(401, 'wrong_token', 'this sign-in was issued to another app', log);
    if (typeof c['tid'] !== 'string' || c['tid'].toLowerCase() !== tenantId!.toLowerCase()) return this.refuse(403, 'other_tenant', "you don't have access to this app", log);
    // App-only tokens carry no `scp`; an ID token carries no `scp` either (DES §8.2).
    const scp = typeof c['scp'] === 'string' ? c['scp'].split(' ') : [];
    if (c['idtyp'] === 'app' || !scp.includes('access_as_user')) return this.refuse(401, 'wrong_token', "this site takes a person's access token for its own scope", log);
    // The client that asked for the token: the site itself, or (a published Teams tab) one of the Teams clients.
    const azp = c['azp'];
    const clients: string[] = [this.opts.identity.clientId, ...(this.opts.teams === true ? TEAMS_CLIENT_IDS : [])];
    if (typeof azp !== 'string' || !clients.some((x) => x.toLowerCase() === azp.toLowerCase())) return this.refuse(401, 'wrong_token', 'this sign-in was asked for by another app', log);
    const oid = str(c['oid']);
    const upn = str(c['upn']);
    if (oid === null || upn === null) return this.refuse(401, 'wrong_token', 'the sign-in names no user', log);
    const rule = this.opts.audience;
    let inAudience = false;
    if (rule.kind === 'entra-roles') inAudience = (strList(c['roles']) ?? []).some((r) => rule.roles.includes(r));
    else if (rule.kind === 'entra-groups') {
      const overage = c['hasgroups'] === true || (typeof c['_claim_names'] === 'object' && c['_claim_names'] !== null && Object.hasOwn(c['_claim_names'], 'groups'));
      if (overage) return this.refuse(403, 'groups_overage', 'your groups are too many to read from the sign-in: ask for an app role instead', log);
      inAudience = (strList(c['groups']) ?? []).some((g) => rule.groups.includes(g));
    }
    if (!inAudience) return this.refuse(403, 'not_in_audience', "you don't have access to this app", log);
    const id = `${this.principal}${oid}`;
    const actor = Object.freeze({ id, kind: 'human', trust: 'operator' }) as Actor;
    return { ok: true, actor, viewer: { id, email: upn, name: str(c['name']), groups: strList(c['groups']) ?? [] }, claims: log };
  }
}
