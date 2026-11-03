// A real OIDC issuer for the site's tests: HTTPS under a throwaway CA (openssl at test time, no key material in
// the repo), discovery and JWKS documents, and an RSA key that signs whatever claims a test asks for. The site
// reaches it by NAME through crew's dialer (a resolver that maps idp.apps.test to loopback, the CA as its root).

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const IDP_HOST = 'idp.apps.test';

export interface TestIdp {
  issuer: string;
  ca: string;
  endpoints: { authorization: string; token: string };
  /** Discovery and key fetches so far (paths). */
  hits: string[];
  dial: { resolver: (host: string) => Promise<string[]>; tls: { ca: string } };
  /** Who the next browser sign-in at `/auth` signs in as (its claims); `null` = the issuer refuses. */
  signInAs: Record<string, unknown> | null;
  /** The key endpoint answers 500 while set (a failing issuer). */
  failKeys: boolean;
  /** Code exchanges at `/token` so far, and the ones refused. */
  exchanges: { ok: number; refused: number };
  /** A JWT signed by the issuer's key; `iss`, `exp` and `iat` default sensibly, anything can be overridden. */
  token(claims: Record<string, unknown>, opts?: { kid?: string; key?: 'issuer' | 'stranger' }): string;
  close(): Promise<void>;
}

export async function startIdp(): Promise<TestIdp> {
  const dir = mkdtempSync(join(tmpdir(), 'apps-k6-idp-'));
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=apps k6 test CA']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${IDP_HOST}`]);
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:${IDP_HOST}\n`);
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf']);
  const ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(signing.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'RS256', use: 'sig' };
  const hits: string[] = [];
  let issuer = '';
  // Codes issued at /auth, redeemed once at /token with the PKCE verifier (S256), the same redirect URI and client.
  const codes = new Map<string, { claims: Record<string, unknown>; challenge: string; redirectUri: string; clientId: string; nonce: string | null }>();
  // eslint-disable-next-line prefer-const -- assigned below, read by the handler
  let self: TestIdp;
  const server: Server = createServer({ key: readFileSync(join(dir, 'leaf.key')), cert: readFileSync(join(dir, 'leaf.pem')) }, (req, res) => {
    hits.push((req.url ?? '').split('?')[0]!);
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/auth' && req.method === 'GET') {
      const q = url.searchParams;
      if (self.signInAs === null || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || (q.get('code_challenge') ?? '') === '') {
        res.statusCode = 403;
        res.end('refused');
        return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { claims: { ...self.signInAs }, challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri') ?? '', clientId: q.get('client_id') ?? '', nonce: q.get('nonce') });
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
      res.setHeader('access-control-allow-headers', 'content-type, accept, dpop');
      res.setHeader('access-control-allow-methods', 'POST');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const f = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        const ok = c !== undefined && f.get('grant_type') === 'authorization_code' && f.get('redirect_uri') === c.redirectUri && f.get('client_id') === c.clientId && createHash('sha256').update(verifier).digest('base64url') === c.challenge;
        res.setHeader('content-type', 'application/json');
        if (!ok) {
          self.exchanges.refused++;
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        self.exchanges.ok++;
        const t = self.token({ aud: c.clientId, ...(c.nonce !== null ? { nonce: c.nonce } : {}), ...c.claims });
        res.end(JSON.stringify({ access_token: t, id_token: t, token_type: 'Bearer', expires_in: 3600 }));
      });
      return;
    }
    res.setHeader('content-type', 'application/json');
    if ((req.url ?? '').endsWith('/.well-known/openid-configuration')) {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys`, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` }));
    } else if (req.url === '/keys') {
      if (self.failKeys) res.statusCode = 500;
      res.end(self.failKeys ? '{}' : JSON.stringify({ keys: [jwk] }));
    }
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  issuer = `https://${IDP_HOST}:${port}`;
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  self = {
    signInAs: null,
    failKeys: false,
    exchanges: { ok: 0, refused: 0 },
    issuer,
    ca,
    endpoints: { authorization: `${issuer}/auth`, token: `${issuer}/token` },
    hits,
    dial: { resolver: async (h) => (h === IDP_HOST ? ['127.0.0.1'] : []), tls: { ca } },
    token(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const head = b64({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' });
      const body = b64({ iss: issuer, iat: now, exp: now + 3600, ...claims });
      const key = opts.key === 'stranger' ? stranger.privateKey : signing.privateKey;
      return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
        rmSync(dir, { recursive: true, force: true });
      }),
  };
  return self;
}
