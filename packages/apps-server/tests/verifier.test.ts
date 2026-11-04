// crew's verifier as the app server uses it (packages/crew/src/api/auth.ts `verifyOidcClaims`), against a real HTTPS
// issuer reached by name through the dialer: the claims come back whole, and a token with a made-up `kid` does not
// make the verifier fetch the issuer's keys on every request (an internet-facing site, DES-APPS-001 §8.2).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { verifyOidcClaims } from '../../crew/src/api/auth.js';
import { startIdp, type TestIdp } from './support/idp.js';

describe('verifyOidcClaims', () => {
  let idp: TestIdp;
  beforeAll(async () => {
    idp = await startIdp();
  });
  afterAll(async () => {
    await idp?.close();
  });

  it('answers every claim of a valid token, and refuses a bad signature, issuer, audience or expiry', async () => {
    const config = { issuer: idp.issuer, audience: 'site', allowRanges: ['127.0.0.1/32'] };
    const claims = await verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site', email: 'a@example.com', email_verified: true, groups: ['g'], tid: 't', roles: ['r'] }), config, { dial: idp.dial });
    expect(claims).toMatchObject({ sub: 'u1', email: 'a@example.com', email_verified: true, groups: ['g'], tid: 't', roles: ['r'] });
    expect(Object.isFrozen(claims)).toBe(true);
    await expect(verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site' }, { key: 'stranger' }), config, { dial: idp.dial })).rejects.toThrow(/signature/);
    await expect(verifyOidcClaims(idp.token({ sub: 'u1', aud: 'other' }), config, { dial: idp.dial })).rejects.toThrow(/audience/);
    await expect(verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site', iss: 'https://elsewhere.example' }), config, { dial: idp.dial })).rejects.toThrow(/issuer/);
    await expect(verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site', exp: 1 }), config, { dial: idp.dial })).rejects.toThrow(/expired/);
    await expect(verifyOidcClaims('x.y.z', { ...config, issuer: 'http://plain.example' })).rejects.toThrow(/https/);
  });

  it('a token with an unknown kid re-fetches the keys at most once per 30 s', async () => {
    const config = { issuer: idp.issuer, audience: 'site', allowRanges: ['127.0.0.1/32'] };
    await verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site' }), config, { dial: idp.dial }); // the keys are cached
    const before = idp.hits.filter((h) => h === '/keys').length;
    for (let i = 0; i < 5; i++) await expect(verifyOidcClaims(idp.token({ sub: 'u1', aud: 'site' }, { kid: `made-up-${i}` }), config, { dial: idp.dial })).rejects.toThrow(/no JWKS key/);
    expect(idp.hits.filter((h) => h === '/keys').length - before).toBeLessThanOrEqual(1);
  });

  it('concurrent unknown kids on an issuer never fetched share ONE key fetch', async () => {
    const fresh = await startIdp();
    try {
      const config = { issuer: fresh.issuer, audience: 'site', allowRanges: ['127.0.0.1/32'] };
      const all = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => verifyOidcClaims(fresh.token({ sub: 'u1', aud: 'site' }, { kid: `made-up-${i}` }), config, { dial: fresh.dial })));
      expect(all.every((r) => r.status === 'rejected')).toBe(true);
      expect(fresh.hits.filter((h) => h === '/keys')).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });

  it('keys already known keep verifying while a refresh runs or fails (stale while revalidating): nobody is signed out', async () => {
    const warm = await startIdp();
    try {
      const config = { issuer: warm.issuer, audience: 'site', allowRanges: ['127.0.0.1/32'] };
      const t = (): string => warm.token({ sub: 'u1', aud: 'site', exp: Math.floor(Date.now() / 1000) + 7200 });
      await verifyOidcClaims(t(), config, { dial: warm.dial }); // the keys are cached
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past the 5-minute TTL
      warm.failKeys = true;
      const all = await Promise.all(Array.from({ length: 4 }, () => verifyOidcClaims(t(), config, { dial: warm.dial })));
      expect(all.every((c) => c['sub'] === 'u1')).toBe(true);
      await new Promise((r) => setTimeout(r, 300)); // the background refresh fails
      expect((await verifyOidcClaims(t(), config, { dial: warm.dial }))['sub']).toBe('u1');
      // A kid nobody published still gets nothing.
      await expect(verifyOidcClaims(warm.token({ sub: 'u1', aud: 'site' }, { kid: 'never' }), config, { dial: warm.dial })).rejects.toThrow(/no JWKS key/);
    } finally {
      vi.useRealTimers();
      await warm.close();
    }
  });

  it('an issuer whose keys fail is asked again at most once per 30 s, not on every request', async () => {
    const down = await startIdp();
    try {
      down.failKeys = true;
      const config = { issuer: down.issuer, audience: 'site', allowRanges: ['127.0.0.1/32'] };
      for (let i = 0; i < 5; i++) await expect(verifyOidcClaims(down.token({ sub: 'u1', aud: 'site' }), config, { dial: down.dial })).rejects.toThrow();
      expect(down.hits.filter((h) => h === '/keys')).toHaveLength(1);
    } finally {
      await down.close();
    }
  });
});
