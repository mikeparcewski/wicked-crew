/**
 * Result scrubbing for brokered MCP calls (DES-MCP-TOOLS-001 §4.3 D-2, §6 step 8).
 *
 * Every result an upstream returns passes through here before a worker, a log or a record sees
 * it, in this order:
 *
 *  1. **Exact secrets**: every value the broker injected on THIS call is replaced wherever it
 *     appears (`scrubSecrets`, the same pass the registry's probe uses).
 *  2. **Field names**: a value under a credential-named key (Authorization, Cookie, *token*,
 *     *secret*, *passw*, *credential*, *session*, api/private/access/secret key, ...) becomes
 *     `[REDACTED:field:<name>]`, recursively.
 *  3. **Value shapes**: credential-shaped substrings anywhere (Bearer/Basic auth, JWTs, AWS access
 *     key ids, GitHub/OpenAI/Slack tokens, `password=...` pairs, PEM private keys) become
 *     `[REDACTED:<pattern-id>]`.
 *
 * Layers 2 and 3 are ported from wicked-garden's QE evidence redactor
 * (`scripts/qe/runner/src/redact.mjs`). One difference: garden also denies a bare `key` field.
 * An MCP result routinely carries `key` as an identifier (a Jira issue key, a cache key), so here
 * only the qualified credential keys are denied (`api_key`, `private-key`, `accessKey`, ...).
 */

import { scrubSecrets } from './secrets.js';

const REDACTED = (reason: string): string => `[REDACTED:${reason}]`;

const FIELD_NAME_DENY: ReadonlyArray<RegExp> = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /passw/i,
  /passphrase/i,
  /credential/i,
  /session/i,
  /apikey/i,
  /(api|private|access|secret|signing|client)[-_.]?key/i,
];

export function isDeniedFieldName(name: string): boolean {
  return FIELD_NAME_DENY.some((re) => re.test(name));
}

interface ValuePattern {
  id: string;
  re: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

export const VALUE_PATTERNS: ReadonlyArray<ValuePattern> = [
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  { id: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/=]{8,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'kv-secret',
    re: /\b(token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?key|auth)=([^&\s"']{4,})/gi,
    replace: (_m: string, k: string) => `${k}=${REDACTED('kv')}`,
  },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function redactString(value: string): string {
  let out = value;
  for (const { id, re, replace } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = replace !== undefined ? out.replace(re, replace) : out.replace(re, REDACTED(id));
  }
  return out;
}

/** Layers 2 and 3 over any JSON value. Pure: returns a new value. */
export function redactDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isDeniedFieldName(k) ? REDACTED(`field:${k}`) : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** All three layers: the exact injected `secrets` first, then field names and value shapes. */
export function scrubResult<T>(value: T, secrets: ReadonlyArray<string>): T {
  return redactDeep(scrubSecrets(value, secrets));
}
