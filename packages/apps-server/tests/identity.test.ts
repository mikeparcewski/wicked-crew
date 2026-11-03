// The two token profiles and the audience rules (DES-APPS-001 §8.2, S15), judged on verified claims. The
// signature, issuer, audience and expiry checks are crew's verifier (exercised for real in site-pg.test.ts);
// here the verifier is replaced so each claim rule is tested on its own.

import { describe, expect, it } from 'vitest';

import { bearerOf, SignIn, TEAMS_CLIENT_IDS } from '../src/identity.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '99999999-8888-7777-6666-555555555555';

const entra = (rule: 'roles' | 'groups' = 'roles', teams = false): SignIn =>
  new SignIn({
    identity: { profile: 'entra', issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, clientId: CLIENT, tenantId: TENANT },
    teams,
    audience: rule === 'roles' ? { kind: 'entra-roles', roles: ['Apps.Viewer'] } : { kind: 'entra-groups', groups: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] },
    verify: async (token) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
  });
const oidc = (audience: ConstructorParameters<typeof SignIn>[0]['audience']): SignIn =>
  new SignIn({ identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'desk' }, audience, verify: async (token) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown> });
/** An unsigned stand-in token: the stub verifier above only decodes it. */
const tok = (claims: Record<string, unknown>, header: Record<string, unknown> = {}): string => `${Buffer.from(JSON.stringify({ alg: 'RS256', ...header })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const userToken = { ver: '2.0', aud: CLIENT, azp: CLIENT, tid: TENANT, scp: 'access_as_user', oid: 'oid-a', upn: 'a@contoso.example', roles: ['Apps.Viewer'] };

describe('the Entra profile', () => {
  it("accepts a person's v2 access token for the app's own scope in the role, with viewer.email = upn", async () => {
    const j = await entra().judge(`Bearer ${tok(userToken)}`);
    expect(j.ok).toBe(true);
    if (j.ok) {
      // Namespaced by tenant: the same object id from another tenant is another principal.
      expect(j.actor.id).toBe(`entra:${TENANT}:oid-a`);
      expect(j.viewer.email).toBe('a@contoso.example');
      expect(j.claims).toMatchObject({ ver: '2.0', aud: CLIENT, scp: 'access_as_user', tid: TENANT, oid: 'oid-a', upn: 'a@contoso.example', roles: ['Apps.Viewer'] });
    }
  });

  it('refuses an app-only token, an ID token, a v1 token, another client, another tenant and a token with no user', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ ...userToken, scp: undefined, idtyp: 'app', roles: ['Apps.Viewer'] }, 401, 'wrong_token'],
      [{ ...userToken, scp: undefined }, 401, 'wrong_token'], // an ID token: no scp
      [{ ...userToken, scp: 'User.Read' }, 401, 'wrong_token'],
      [{ ...userToken, ver: '1.0' }, 401, 'wrong_token'],
      [{ ...userToken, aud: `api://site/${CLIENT}` }, 401, 'wrong_token'],
      [{ ...userToken, tid: '00000000-0000-0000-0000-000000000000' }, 403, 'other_tenant'],
      [{ ...userToken, upn: undefined }, 401, 'wrong_token'],
      [{ ...userToken, oid: undefined }, 401, 'wrong_token'],
    ];
    for (const [claims, status, code] of cases) {
      const j = await entra().judge(`Bearer ${tok(claims)}`);
      expect(j.ok, JSON.stringify(claims)).toBe(false);
      if (!j.ok) expect([j.status, j.code], JSON.stringify(claims)).toEqual([status, code]);
    }
  });

  it('judges roles by VALUE: another role is refused (tester B), with the claims logged and no source called', async () => {
    const j = await entra().judge(`Bearer ${tok({ ...userToken, roles: ['Apps.Other'] })}`);
    expect(j).toMatchObject({ ok: false, status: 403, code: 'not_in_audience' });
    if (!j.ok) expect(j.claims?.roles).toEqual(['Apps.Other']);
  });

  it('refuses a token whose groups overflowed (the overage marker) under a group rule', async () => {
    const overage = { ...userToken, roles: undefined, _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/…' } } };
    expect(await entra('groups').judge(`Bearer ${tok(overage)}`)).toMatchObject({ ok: false, code: 'groups_overage' });
    expect(await entra('groups').judge(`Bearer ${tok({ ...userToken, roles: undefined, hasgroups: true })}`)).toMatchObject({ ok: false, code: 'groups_overage' });
    expect((await entra('groups').judge(`Bearer ${tok({ ...userToken, groups: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] })}`)).ok).toBe(true);
  });
});

describe('the Entra client binding (azp) and the whole claim', () => {
  it("binds the token to the client that asked for it: the site's own, and the Teams clients only when the Teams tab is published", async () => {
    for (const azp of [undefined, 'cccccccc-0000-0000-0000-000000000000', TEAMS_CLIENT_IDS[0]]) {
      expect((await entra().judge(`Bearer ${tok({ ...userToken, azp })}`)).ok, String(azp)).toBe(false);
    }
    for (const azp of TEAMS_CLIENT_IDS) expect((await entra('roles', true).judge(`Bearer ${tok({ ...userToken, azp })}`)).ok, azp).toBe(true);
    expect((await entra('roles', true).judge(`Bearer ${tok({ ...userToken, azp: 'cccccccc-0000-0000-0000-000000000000' })}`)).ok).toBe(false);
  });

  it('judges the whole group and role lists: a match past the 50th entry counts; the decision log keeps 50', async () => {
    const roles = [...Array.from({ length: 60 }, (_, i) => `Role.${i}`), 'Apps.Viewer'];
    const j = await entra().judge(`Bearer ${tok({ ...userToken, roles })}`);
    expect(j.ok).toBe(true);
    if (j.ok) expect(j.claims.roles).toHaveLength(50);
    const groups = [...Array.from({ length: 70 }, (_, i) => `g${i}`), 'support-ops'];
    const o = await oidc({ kind: 'oidc-groups', groups: ['support-ops'] }).judge(`Bearer ${tok({ sub: 'u', aud: 'desk', groups })}`);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.viewer.groups).toHaveLength(71);
  });
});

describe('the generic OIDC profile', () => {
  const base = { sub: 'u1', aud: 'desk', email: 'priya@example.com', email_verified: true };

  it('an email-domain audience needs email_verified === true (a Boolean), whatever the string says', async () => {
    const rule = oidc({ kind: 'oidc-email-domain', domains: ['example.com'] });
    expect((await rule.judge(`Bearer ${tok(base)}`)).ok).toBe(true);
    for (const ev of ['true', 'yes', 1, false, null]) expect((await rule.judge(`Bearer ${tok({ ...base, email_verified: ev })}`)).ok, String(ev)).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, email_verified: undefined })}`)).ok).toBe(false);
    // A look-alike domain is not the domain.
    expect((await rule.judge(`Bearer ${tok({ ...base, email: 'priya@notexample.com' })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, email: 'priya@example.com.evil.test' })}`)).ok).toBe(false);
  });

  it('a group audience reads the configured claim; groups must be a list of strings', async () => {
    const rule = oidc({ kind: 'oidc-groups', groups: ['support-ops'], claim: 'roles' });
    expect((await rule.judge(`Bearer ${tok({ ...base, roles: ['support-ops'] })}`)).ok).toBe(true);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['support-ops'] })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, roles: 'support-ops' })}`)).ok).toBe(false);
  });

  it('takes the ID token: an access token (at+jwt, a scope, scp) or one another client asked for is refused; the id is namespaced by issuer', async () => {
    const rule = oidc({ kind: 'oidc-groups', groups: ['g'] });
    const ok = await rule.judge(`Bearer ${tok({ ...base, groups: ['g'] })}`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.actor.id).toMatch(/^oidc:[0-9a-f]{16}:u1$/);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'] }, { typ: 'at+jwt' })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], scope: 'openid read:items' })}`)).ok).toBe(false);
    for (const scope of [['openid'], { a: 1 }, null, 0]) expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], scope })}`)).ok, JSON.stringify(scope)).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], scp: 'access_as_user' })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], azp: 'another-client' })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], azp: 'desk' })}`)).ok).toBe(true);
  });

  it('a token for several audiences counts only when azp names this client', async () => {
    const rule = oidc({ kind: 'oidc-groups', groups: ['g'] });
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], aud: ['desk', 'other'] })}`)).ok).toBe(false);
    expect((await rule.judge(`Bearer ${tok({ ...base, groups: ['g'], aud: ['desk', 'other'], azp: 'desk' })}`)).ok).toBe(true);
  });

  it('a verifier failure is a 401 and nothing of the token is kept', async () => {
    const rule = new SignIn({ identity: { profile: 'oidc', issuer: 'https://dex.apps.test', clientId: 'desk' }, audience: { kind: 'oidc-groups', groups: ['g'] }, verify: async () => Promise.reject(new Error('signature')) });
    expect(await rule.judge(`Bearer ${tok(base)}`)).toEqual({ ok: false, status: 401, code: 'invalid_token', reason: 'the sign-in is not valid here: sign in again', claims: null });
  });

  it('refuses a profile and audience rule that do not belong together, and an http issuer', () => {
    expect(() => oidc({ kind: 'entra-roles', roles: ['x'] })).toThrow(/not one of the oidc profile/);
    expect(() => new SignIn({ identity: { profile: 'oidc', issuer: 'http://dex', clientId: 'c' }, audience: { kind: 'oidc-groups', groups: ['g'] } })).toThrow(/https/);
  });
});

describe('the bearer header', () => {
  it('is exactly "Bearer <token>" and at most 16 KB', () => {
    expect(bearerOf('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    for (const h of [undefined, '', 'bearer abc', 'Basic abc', 'Bearer ', 'Bearer a b', ['Bearer a'], `Bearer ${'a'.repeat(16 * 1024 + 1)}`]) expect(bearerOf(h as string | undefined)).toBeNull();
  });
});
