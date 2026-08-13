/**
 * The daemon's identity/actor seam (task #88, locked decision #6).
 *
 * LOCAL IS SACRED: the default deployment stays exactly what it was — a
 * 127.0.0.1-bound daemon with loopback CORS and NO auth, where every request
 * implicitly acts as the full-trust local operator. Nothing in this module
 * runs a verifier, reads a token file, or changes a response in that mode; it
 * only pins ONE actor shape onto the request so downstream code (audit trail,
 * bus events, gate decisions) never branches on "was there auth".
 *
 * TEAM/HOSTED REQUIRES AUTH: `WICKED_RUNTIME=team` or `WICKED_CREW_AUTH=required`
 * arms a bearer-token check on `/api/v1/*` and the `/ws` upgrade paths.
 * Verification is pluggable behind {@link TokenVerifier}; v1 ships the static
 * workload-token verifier (hashed-at-rest file, {@link loadTokenFile}) and the
 * OIDC verifier SEAM ({@link OidcConfig} + {@link createOidcVerifier}), whose
 * implementation is a named follow-up — configuring OIDC today fails the boot
 * LOUDLY rather than pretending an IdP was consulted.
 *
 * Deny semantics: missing/unknown token in required mode → 401 (with
 * `WWW-Authenticate: Bearer`); an authenticated actor below a route's rung on
 * the trust ladder → 403. The ladder is {@link requiredTrust} — minimal and
 * documented (docs/auth.md), not a per-route registry.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, ActorKind, TrustLevel } from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The authenticated actor — or {@link LOCAL_ACTOR} when auth is off. Set by
     * the identity hook for every request under `/api/v1` and `/ws`; routes
     * outside that scope (SPA assets) never read it.
     */
    actor: Actor;
  }
}

export type AuthMode = 'required' | 'off';

/**
 * The implicit full-trust local operator. `admin` is the ladder's top rung —
 * the local single-operator deployment has exactly one human and no boundary
 * to enforce between that human and the daemon, so "full trust" and "admin"
 * are the same fact spelled once.
 */
export const LOCAL_ACTOR: Actor = Object.freeze({
  id: 'local',
  kind: 'human',
  trust: 'admin',
}) as Actor;

const TRUST_RANK: Record<TrustLevel, number> = { observer: 0, operator: 1, admin: 2 };
const KINDS: ReadonlySet<string> = new Set<ActorKind>(['human', 'agent', 'system']);
const TRUSTS: ReadonlySet<string> = new Set<TrustLevel>(['observer', 'operator', 'admin']);

/** True when `actor` sits at or above `min` on the ladder. */
export function trustAtLeast(actor: Actor, min: TrustLevel): boolean {
  return TRUST_RANK[actor.trust] >= TRUST_RANK[min];
}

/**
 * Resolve the daemon's auth mode. DENY-DOMINANT: `WICKED_RUNTIME=team` forces
 * `required` and nothing can talk it back down — a team runtime with auth
 * switched off is exactly the silently-ungoverned state this seam exists to
 * prevent. Outside team runtime, `WICKED_CREW_AUTH` (`required`|`off`) is
 * explicit; unset means the local default, off.
 */
export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  if (env['WICKED_RUNTIME']?.trim().toLowerCase() === 'team') return 'required';
  const explicit = env['WICKED_CREW_AUTH']?.trim().toLowerCase();
  if (explicit === undefined || explicit === '' || explicit === 'off') return 'off';
  if (explicit === 'required') return 'required';
  // An unknown value fails LOUD rather than defaulting to off: a typo'd
  // `WICKED_CREW_AUTH=reqired` silently running unauthenticated is the worst
  // possible reading of an operator's stated intent to authenticate.
  throw new Error(`WICKED_CREW_AUTH must be 'required' or 'off' (got '${explicit}')`);
}

// ── Token verification (pluggable) ────────────────────────────────────────────

/**
 * The verifier seam. A verifier resolves a presented bearer token to an
 * {@link Actor}, or `null` when the token is not one of its. Verifiers are
 * tried in order; the first non-null answer wins. v1 ships the static
 * workload-token verifier; the OIDC verifier is the named follow-up
 * (docs/auth.md § "The OIDC seam").
 */
export interface TokenVerifier {
  /** Names the verifier in logs and errors (`static-tokens`, `oidc`). */
  readonly name: string;
  verify(token: string): Promise<Actor | null>;
}

/** Where the workload-token file lives unless overridden. */
export function defaultTokensPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_TOKENS'] ?? join(homedir(), '.config', 'wicked-crew', 'tokens.json');
}

/** One entry of `tokens.json` — the HASH of a token, never the token itself. */
export interface TokenFileEntry {
  /** Lowercase hex SHA-256 of the bearer token (64 chars). */
  sha256: string;
  actor: Actor;
  /** Operator note ("ci runner", "maria's laptop"); never used for decisions. */
  label?: string;
}

/** `sha256` hex of a presented token — the only form the daemon stores or compares. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Parse a tokens.json payload into a hash→actor map. FAILS CLOSED on any
 * malformed entry: a typo'd trust level that silently skipped its entry would
 * lock an operator out (or, worse, a hand-edit that half-parsed would demote
 * someone) with nothing saying so. The error names the entry index and field.
 */
export function parseTokenFile(json: string, source: string): Map<string, Actor> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const file = raw as { version?: unknown; tokens?: unknown };
  if (typeof file !== 'object' || file === null || !Array.isArray(file.tokens)) {
    throw new Error(`${source}: expected { "version": 1, "tokens": [...] }`);
  }
  if (file.version !== undefined && file.version !== 1) {
    throw new Error(`${source}: unsupported version ${JSON.stringify(file.version)} (this build reads version 1)`);
  }
  const map = new Map<string, Actor>();
  file.tokens.forEach((entry: unknown, i: number) => {
    const e = entry as Partial<TokenFileEntry>;
    const at = `${source}: tokens[${i}]`;
    if (typeof e?.sha256 !== 'string' || !SHA256_HEX.test(e.sha256)) {
      throw new Error(`${at}: 'sha256' must be 64 lowercase hex chars (sha256 of the token)`);
    }
    const a = e.actor as Partial<Actor> | undefined;
    if (typeof a?.id !== 'string' || a.id.length === 0 || a.id.length > 128) {
      throw new Error(`${at}: 'actor.id' must be a non-empty string (≤128 chars)`);
    }
    if (typeof a.kind !== 'string' || !KINDS.has(a.kind)) {
      throw new Error(`${at}: 'actor.kind' must be 'human' | 'agent' | 'system'`);
    }
    if (typeof a.trust !== 'string' || !TRUSTS.has(a.trust)) {
      throw new Error(`${at}: 'actor.trust' must be 'observer' | 'operator' | 'admin'`);
    }
    if (map.has(e.sha256)) {
      throw new Error(`${at}: duplicate token hash (also used by an earlier entry)`);
    }
    map.set(e.sha256, Object.freeze({ id: a.id, kind: a.kind, trust: a.trust }) as Actor);
  });
  return map;
}

/**
 * Load `tokens.json` from disk into a static verifier. A MISSING file is a
 * loud warning, not a boot failure: the daemon still starts and every request
 * 401s, which is the honest fail-closed posture (an unreachable daemon tells
 * the operator less than one that answers "no tokens are registered").
 * A PRESENT-but-malformed file fails the boot — see {@link parseTokenFile}.
 */
export function loadTokenFile(path: string, warn: (msg: string) => void): Map<string, Actor> {
  let json: string;
  try {
    json = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warn(
        `[auth] required mode with NO token file at ${path} — every /api/v1 and /ws request will 401 ` +
          `until tokens are registered (docs/auth.md § "Workload tokens")`,
      );
      return new Map();
    }
    throw new Error(`[auth] cannot read token file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Hashes, not tokens, live in this file — but its actor/trust mappings are
  // still authorization state, so a group/world-writable file is worth a shout.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o077;
      if (mode !== 0) {
        warn(`[auth] ${path} is group/world-accessible (mode ${(statSync(path).mode & 0o777).toString(8)}) — chmod 600 recommended`);
      }
    } catch {
      /* stat raced a delete; the read above already succeeded */
    }
  }
  return parseTokenFile(json, path);
}

/** The static workload-token verifier: sha256 the presented token, look it up. */
export function createStaticVerifier(entries: Map<string, Actor>): TokenVerifier {
  return {
    name: 'static-tokens',
    verify: (token) => Promise.resolve(entries.get(tokenHash(token)) ?? null),
  };
}

// ── The OIDC verifier (crew#249) ─────────────────────────────────────────────

/**
 * The OIDC verifier's config shape. Lives in `~/.config/wicked-crew/auth.json`
 * as `{ "oidc": … }`.
 */
export interface OidcConfig {
  /** The issuer URL — discovery happens at `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  /** The audience (`aud`) access tokens must carry to be accepted by this daemon. */
  audience: string;
  /** Explicit JWKS URI; omit to use the discovery document's `jwks_uri`. */
  jwksUri?: string;
  /**
   * Claim mapping. `id` defaults to `sub`; `trust` names a claim whose value is
   * a {@link TrustLevel} (defaults to the `defaultTrust` below when absent).
   * OIDC-verified principals are always `kind: 'human'` — workloads use tokens.
   */
  claims?: { id?: string; trust?: string };
  /** Trust assigned when the trust claim is absent (default `observer` — least privilege). */
  defaultTrust?: TrustLevel;
}

/** Where the auth config (OIDC seam) lives unless overridden. */
export function defaultAuthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_AUTH_CONFIG'] ?? join(homedir(), '.config', 'wicked-crew', 'auth.json');
}

// ── OIDC internals ────────────────────────────────────────────────────────────

/** JSON Web Key (RFC 7517). Only the fields needed for verification. */
interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

interface JwksResponse { keys: Jwk[] }
interface DiscoveryDoc { jwks_uri: string }

/** Per-issuer JWKS cache: keys indexed by kid (or by alg when kid is absent). */
const JWKS_CACHE = new Map<string, { keys: Map<string, Jwk>; fetchedAt: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000; // 5-min TTL before background refresh

function base64urlDecode(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

async function fetchJwks(jwksUri: string): Promise<Map<string, Jwk>> {
  const doc = await fetchJson<JwksResponse>(jwksUri);
  const map = new Map<string, Jwk>();
  for (const key of doc.keys ?? []) {
    if (key.use !== undefined && key.use !== 'sig') continue;
    // Index by kid; fall back to alg when kid is absent.
    const index = key.kid ?? key.alg ?? key.kty;
    map.set(index, key);
  }
  return map;
}

async function resolveJwksUri(config: OidcConfig): Promise<string> {
  if (config.jwksUri) return config.jwksUri;
  const discovery = await fetchJson<DiscoveryDoc>(
    `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  return discovery.jwks_uri;
}

async function getJwk(
  config: OidcConfig,
  kid: string,
  allowRefresh: boolean,
): Promise<Jwk | null> {
  const cached = JWKS_CACHE.get(config.issuer);
  const stale = !cached || Date.now() - cached.fetchedAt > JWKS_TTL_MS;
  if (cached && !stale) {
    const hit = cached.keys.get(kid);
    if (hit) return hit;
    if (!allowRefresh) return null;
  }
  // Fetch (or re-fetch on stale/miss).
  const uri = await resolveJwksUri(config);
  const keys = await fetchJwks(uri);
  JWKS_CACHE.set(config.issuer, { keys, fetchedAt: Date.now() });
  return keys.get(kid) ?? null;
}

// Supported algorithm → hash algorithm pairs.
const ALG_HASH: Record<string, string> = {
  RS256: 'SHA256', RS384: 'SHA384', RS512: 'SHA512',
  ES256: 'SHA256', ES384: 'SHA384', ES512: 'SHA512',
  PS256: 'SHA256', PS384: 'SHA384', PS512: 'SHA512',
};

function verifySignature(headerPayload: string, sig: Buffer, jwk: Jwk, alg: string): boolean {
  const hashAlg = ALG_HASH[alg];
  if (!hashAlg) return false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const opts = alg.startsWith('PS')
      ? ({ padding: constants.RSA_PKCS1_PSS_PADDING } as object)
      : alg.startsWith('ES')
        ? ({ dsaEncoding: 'ieee-p1363' } as object)
        : ({} as object);
    return cryptoVerify(hashAlg, Buffer.from(headerPayload), { key, ...opts }, sig);
  } catch {
    return false;
  }
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
}

/**
 * Verify a raw JWT string against the issuer's JWKS. Returns the decoded
 * payload on success or throws a descriptive error on failure.
 */
async function verifyJwt(token: string, config: OidcConfig): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT: expected 3 dot-separated parts');

  let header: { kid?: string; alg?: string };
  let payload: JwtPayload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]!).toString('utf8')) as typeof header;
    payload = JSON.parse(base64urlDecode(parts[1]!).toString('utf8')) as JwtPayload;
  } catch {
    throw new Error('malformed JWT: header or payload is not valid base64url JSON');
  }

  const alg = header.alg ?? '';
  if (!ALG_HASH[alg]) throw new Error(`unsupported JWT algorithm: ${alg}`);

  const kid = header.kid ?? alg;
  const sig = base64urlDecode(parts[2]!);
  const headerPayload = `${parts[0]}.${parts[1]}`;

  // Try cached key first; re-fetch once on unknown kid.
  const jwk = await getJwk(config, kid, true);
  if (!jwk) throw new Error(`no JWKS key found for kid=${JSON.stringify(kid)}`);

  if (!verifySignature(headerPayload, sig, jwk, alg)) {
    throw new Error('JWT signature verification failed');
  }

  // Claim validation.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iss !== 'string' || payload.iss !== config.issuer) {
    throw new Error(`JWT issuer mismatch: expected ${config.issuer}, got ${JSON.stringify(payload.iss)}`);
  }
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(config.audience)) {
    throw new Error(`JWT audience mismatch: expected ${config.audience}, got ${JSON.stringify(payload.aud)}`);
  }
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('JWT has expired (exp)');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new Error('JWT is not yet valid (nbf)');
  }

  return payload;
}

function mapOidcActor(payload: JwtPayload, config: OidcConfig): Actor {
  const idClaim = config.claims?.id ?? 'sub';
  const rawId = payload[idClaim];
  const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : payload.sub ?? '';
  if (!id) throw new Error(`JWT has no value for id claim '${idClaim}' or 'sub'`);

  const trustClaim = config.claims?.trust;
  const rawTrust = trustClaim ? payload[trustClaim] : undefined;
  const defaultTrust = config.defaultTrust ?? 'observer';
  const trust: TrustLevel = TRUSTS.has(String(rawTrust)) ? (rawTrust as TrustLevel) : defaultTrust;

  return Object.freeze({ id, kind: 'human', trust }) as Actor;
}

/**
 * Create an OIDC verifier that validates JWTs against the issuer's JWKS.
 * Supports RS256/384/512, ES256/384/512, PS256/384/512. JWKS keys are cached
 * per issuer with a 5-minute TTL and auto-refreshed on unknown kid.
 */
export function createOidcVerifier(config: OidcConfig): TokenVerifier {
  // Validate config at creation time — a misconfigured issuer URL is caught
  // immediately at boot rather than silently during the first verification.
  if (!config.issuer || !config.issuer.startsWith('http')) {
    throw new Error(`[auth] OIDC config: 'issuer' must be an https:// URL (got ${JSON.stringify(config.issuer)})`);
  }
  if (!config.audience) {
    throw new Error(`[auth] OIDC config: 'audience' is required`);
  }
  return {
    name: 'oidc',
    async verify(token: string): Promise<Actor | null> {
      // A JWT has exactly 3 base64url segments separated by dots. Static
      // workload tokens are opaque strings and won't have this shape — the
      // verifier chain tries static-tokens first, so if we get called the
      // token isn't a known workload token. But don't assume it's a JWT either.
      if (!token.includes('.')) return null; // clearly not a JWT; pass through
      try {
        const payload = await verifyJwt(token, config);
        return mapOidcActor(payload, config);
      } catch {
        // Any verification failure → null so the chain can try the next
        // verifier (or 401 if none match). The deny-401 path logs the failure.
        return null;
      }
    },
  };
}

// ── Resolution + hook installation ───────────────────────────────────────────

/** `createServer`'s auth options — everything defaults to env/file resolution. */
export interface AuthOptions {
  /** Override mode resolution (tests / embedders). Default: {@link resolveAuthMode}. */
  mode?: AuthMode;
  /** Token file path. Default: `WICKED_CREW_TOKENS` or `~/.config/wicked-crew/tokens.json`. */
  tokensPath?: string;
  /** auth.json path (the OIDC seam's config). Default: `~/.config/wicked-crew/auth.json`. */
  configPath?: string;
  /**
   * Replace the default verifier chain entirely (tests / embedders with their
   * own identity source). When set, the token file and auth.json are not read.
   */
  verifiers?: TokenVerifier[];
  /**
   * Origins allowed CORS when auth is required, beyond loopback. Default:
   * `WICKED_CREW_ALLOWED_ORIGINS` (comma-separated) or — when unset — ANY
   * origin: bearer auth carries no ambient credential, so cross-origin JS
   * without a token holds nothing (docs/auth.md § "CORS pairing").
   */
  allowedOrigins?: string[];
}

/** The resolved auth state `createServer` builds once and hooks consult per request. */
export interface ResolvedAuth {
  mode: AuthMode;
  verifiers: TokenVerifier[];
  /** `null` = any origin (required mode's default); else an allowlist. Loopback always passes. */
  allowedOrigins: string[] | null;
}

/** Resolve mode + verifier chain. Reads files ONLY in required mode. */
export function resolveAuth(options: AuthOptions | undefined, warn: (msg: string) => void): ResolvedAuth {
  const mode = options?.mode ?? resolveAuthMode();
  const originsEnv = process.env['WICKED_CREW_ALLOWED_ORIGINS'];
  const allowedOrigins =
    options?.allowedOrigins ??
    (originsEnv !== undefined && originsEnv.trim() !== ''
      ? originsEnv.split(',').map((o) => o.trim()).filter(Boolean)
      : null);
  if (mode === 'off') {
    // Local default: no verifier exists, no file is read, no request is denied.
    return { mode, verifiers: [], allowedOrigins };
  }
  if (options?.verifiers !== undefined) {
    return { mode, verifiers: options.verifiers, allowedOrigins };
  }
  const verifiers: TokenVerifier[] = [
    createStaticVerifier(loadTokenFile(options?.tokensPath ?? defaultTokensPath(), warn)),
  ];
  // The OIDC seam: configuring it today is a LOUD boot failure, never a silent skip.
  const configPath = options?.configPath ?? defaultAuthConfigPath();
  let configJson: string | null = null;
  try {
    configJson = readFileSync(configPath, 'utf8');
  } catch (err) {
    // ONLY a missing file is the ordinary case. An unreadable-but-present
    // auth.json (EACCES, EISDIR, …) silently skipping a configured OIDC block
    // would be exactly the quiet misconfiguration this seam refuses to be
    // (Copilot, #250) — so anything else fails the boot, named.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `[auth] cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    configJson = null; // no auth.json — the ordinary case
  }
  if (configJson !== null) {
    let parsed: { oidc?: OidcConfig };
    try {
      parsed = JSON.parse(configJson) as { oidc?: OidcConfig };
    } catch (err) {
      throw new Error(`[auth] ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.oidc !== undefined) {
      verifiers.push(createOidcVerifier(parsed.oidc)); // throws — the declared seam
    }
  }
  return { mode, verifiers, allowedOrigins };
}

// ── The trust ladder over routes ─────────────────────────────────────────────

/** `PATCH /projects/:id` (exactly one segment after /projects) — see {@link requiredTrust}. */
const PROJECT_DETAIL_PATH = new RegExp(`^${API_PREFIX}/projects/[^/]+$`);

/**
 * Minimum trust for a request. Minimal by design (the task's rule: no
 * deny-by-default registry over unknown routes):
 *
 * - `/ws/terminals` and any sub-path → `operator` (write-capable WS channel;
 *   inbound frames are raw PTY stdin regardless of the GET upgrade method)
 * - reads (GET/HEAD) and the main `/ws` stream → `observer`
 * - governance writes, settings writes, project archive/restore → `admin`
 * - every other mutation (launch, gate, cancel, chats, terminals, repos,
 *   workflows, project CRUD/membership) → `operator`
 *
 * `body` is consulted for exactly one rule: `PATCH /projects/:id` is an
 * `operator` rename/describe unless the patch carries `status` (archive or
 * restore), which changes what the whole team can attach work to — `admin`.
 */
export function requiredTrust(method: string, path: string, body: unknown): TrustLevel {
  // /ws/terminals and any sub-path (e.g. /ws/terminals/:id) are write-capable WS
  // channels — inbound frames are raw PTY stdin. The HTTP upgrade uses GET but the
  // socket carries operator-level writes. Guard both with and without trailing slash.
  if (path === '/ws/terminals' || path.startsWith('/ws/terminals/')) return 'operator';
  if (method === 'GET' || method === 'HEAD') return 'observer';
  if (path.startsWith(`${API_PREFIX}/governance/`)) return 'admin';
  if (path === `${API_PREFIX}/settings`) return 'admin';
  if (
    method === 'PATCH' &&
    PROJECT_DETAIL_PATH.test(path) &&
    typeof body === 'object' &&
    body !== null &&
    'status' in body
  ) {
    return 'admin';
  }
  return 'operator';
}

/** Path without the query string. */
function pathOf(req: FastifyRequest): string {
  const url = req.raw.url ?? req.url;
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

/** True for the paths the auth boundary covers: the API and the WS upgrades. */
export function isProtectedPath(path: string): boolean {
  return (
    path === API_PREFIX ||
    path.startsWith(`${API_PREFIX}/`) ||
    path === '/ws' ||
    path.startsWith('/ws/')
  );
}

/**
 * Extract the presented bearer token. `Authorization: Bearer <t>` everywhere;
 * the `/ws` upgrade paths ALSO accept `?access_token=` (RFC 6750 §2.3),
 * because the browser `WebSocket` constructor cannot set headers. Header wins
 * when both are present.
 */
export function extractToken(req: FastifyRequest, path: string): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (m) return m[1] ?? null;
    return null; // a malformed Authorization header is not a token
  }
  if (path === '/ws' || path.startsWith('/ws/')) {
    const raw = (req.query as { access_token?: string | string[] } | undefined)?.access_token;
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first === 'string' && first !== '') return first;
  }
  return null;
}

async function deny401(reply: FastifyReply, error: string): Promise<void> {
  await reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer realm="wicked-crew"')
    .send({ error });
}

/**
 * Install the identity (401) and trust (403) hooks.
 *
 * Identity runs at `onRequest` — before body parsing, and (per
 * `@fastify/websocket`) before the upgrade completes, so a bad token is an
 * HTTP 401 on the wire for REST and WS alike. Trust runs at `preHandler`,
 * where the parsed body exists (the one body-dependent rule is the project
 * archive). Both scope to {@link isProtectedPath}; the SPA shell and its
 * assets stay public so a hosted skin can load and ASK for a token.
 */
export function registerAuthHooks(app: FastifyInstance, auth: ResolvedAuth): void {
  app.decorateRequest('actor', null as unknown as Actor);

  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req);
    if (!isProtectedPath(path)) return;
    if (auth.mode === 'off') {
      req.actor = LOCAL_ACTOR;
      return;
    }
    const token = extractToken(req, path);
    if (token === null) {
      return deny401(reply, 'Authentication required: send Authorization: Bearer <token>');
    }
    for (const verifier of auth.verifiers) {
      const actor = await verifier.verify(token);
      if (actor !== null) {
        req.actor = actor;
        return;
      }
    }
    return deny401(reply, 'Invalid or unknown token');
  });

  app.addHook('preHandler', async (req, reply) => {
    const path = pathOf(req);
    if (!isProtectedPath(path)) return;
    // `actor` is always set here: the onRequest hook either assigned it or
    // already answered 401 (which skips the rest of the lifecycle).
    const need = requiredTrust(req.method, path, req.body);
    if (!trustAtLeast(req.actor, need)) {
      // RETURN the reply — the idiomatic guarantee that the lifecycle stops
      // here and the route handler is never reached (Copilot, #250).
      return reply.code(403).send({
        error: `Insufficient trust: this action requires '${need}' (you are '${req.actor.trust}')`,
      });
    }
  });
}
