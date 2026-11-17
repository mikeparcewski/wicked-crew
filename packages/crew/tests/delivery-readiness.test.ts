/**
 * crew#1527: whether delivery can push, before the first job — one answer for the setup steps and the
 * system page's `delivery` row, by the deliver preflight's own rule.
 */
import { describe, expect, it } from 'vitest';
import { githubCredentials } from '../src/core/deliver-credentials.js';
import { pushIdentityOf } from '../src/core/deliver.js';
import { infraRow } from '../src/api/system-snapshot.js';
import { deliveryReadiness, deliveryRow, readDeliveryReadiness, type DeliveryReadinessInput } from '../src/setup/delivery-readiness.js';

const AUTHOR = { name: 'Ada', email: 'ada@example.invalid' };
const base: DeliveryReadinessInput = { deliverDefault: 'pr', identityLogin: undefined, env: {}, gh: { logins: ['ada'], active: 'ada' }, gitAuthor: AUTHOR };

describe('deliveryReadiness (crew#1527)', () => {
  it('local delivery needs no sign-in', () => {
    const r = deliveryReadiness({ ...base, deliverDefault: 'none', gh: null, gitAuthor: null });
    expect(r).toMatchObject({ deliverDefault: 'none', ready: true, github: null, fix: null });
    expect(r.reason).toMatch(/local/);
  });

  it('a pull-request delivery with gh signed in and a git author is ready, naming the account', () => {
    const r = deliveryReadiness(base);
    expect(r).toMatchObject({ deliverDefault: 'pr', ready: true, pushAs: 'ada', fix: null });
    expect(r.reason).toContain('as ada');
    expect(r.reason).toContain('Ada <ada@example.invalid>');
  });

  it('the fresh-home case (#1527): gh not signed in -> not ready, with the sign-in and the local choice', () => {
    for (const gh of [{ logins: [], active: null }, 'absent'] as const) {
      const r = deliveryReadiness({ ...base, gh, deliverDefault: undefined, gitAuthor: null });
      expect(r.ready).toBe(false);
      expect(r.github?.status).toBe('missing');
      expect(r.fix).toContain('gh auth login');
      expect(r.fix).toContain('local delivery');
      expect(r.fix).toContain('git config --global user.name');
      expect(r.reason).toMatch(/stop at its deliver step/);
    }
  });

  it('a configured identity gh holds no sign-in for is not ready, and names that account', () => {
    const r = deliveryReadiness({ ...base, identityLogin: 'grace' });
    expect(r.ready).toBe(false);
    expect(r.pushAs).toBe('grace');
    expect(r.fix).toContain('as grace');
    const viaEnv = deliveryReadiness({ ...base, env: { GH_ACCOUNT: 'grace' } });
    expect(viaEnv.ready).toBe(false);
    expect(viaEnv.pushAs).toBe('grace');
  });

  it('GH_TOKEN counts as the credential, as at deliver', () => {
    const r = deliveryReadiness({ ...base, gh: { logins: [], active: null }, env: { GH_TOKEN: 'x' } });
    expect(r.ready).toBe(true);
    expect(r.github?.source).toBe('gh_token');
  });

  it('no git author (name or email missing) is not ready, with the git config fix', () => {
    for (const gitAuthor of [null, { name: 'Ada', email: null }, { name: ' ', email: 'a@b' }]) {
      const r = deliveryReadiness({ ...base, gitAuthor });
      expect(r.ready).toBe(false);
      expect(r.fix).toContain('git config --global user.email');
    }
  });

  it('SILENT-OK: gh not answering is unknown, never ready and never "signed out"', () => {
    const r = deliveryReadiness({ ...base, gh: null });
    expect(r.ready).toBeNull();
    expect(r.github?.status).toBe('unknown');
  });

  /** SAYS-VS-DOES: ready exactly when the deliver preflight (same rule, same identity) says configured and a full git
   *  author is set, over every combination. */
  it('matrix: ready === preflight configured && author set, for every combination', () => {
    const ghs: DeliveryReadinessInput['gh'][] = [null, 'absent', { logins: [], active: null }, { logins: ['ada'], active: 'ada' }, { logins: ['ada', 'grace'], active: 'grace' }];
    for (const deliverDefault of ['pr', 'none', undefined] as const)
      for (const identityLogin of [undefined, '', 'grace'])
        for (const env of [{}, { GH_TOKEN: 't' }, { GH_ACCOUNT: 'ada' }] as NodeJS.ProcessEnv[])
          for (const gh of ghs)
            for (const gitAuthor of [null, AUTHOR]) {
              const r = deliveryReadiness({ deliverDefault, identityLogin, env, gh, gitAuthor });
              if (deliverDefault === 'none') {
                expect(r.ready).toBe(true);
                continue;
              }
              const logins = gh === null ? null : gh === 'absent' ? 'absent' : gh.logins;
              const pre = githubCredentials(env, logins, pushIdentityOf(identityLogin, env));
              const want = pre.status === 'unknown' ? null : pre.status === 'configured' && gitAuthor !== null;
              expect(r.ready, JSON.stringify({ deliverDefault, identityLogin, env, gh, gitAuthor })).toBe(want);
              expect(r.github).toEqual(pre);
            }
  });

  it('the system row is the same answer: ok / off / degraded / unknown', () => {
    const row = (i: DeliveryReadinessInput) => {
      const r = deliveryReadiness(i);
      return { r, row: deliveryRow(r, Date.now(), infraRow) };
    };
    const ok = row(base);
    expect(ok.row).toMatchObject({ key: 'delivery', state: 'ok', reason: ok.r.reason, remedy: null });
    expect(row({ ...base, deliverDefault: 'none' }).row.state).toBe('off');
    const bad = row({ ...base, gh: { logins: [], active: null } });
    expect(bad.row).toMatchObject({ state: 'degraded', reason: bad.r.reason, remedy: bad.r.fix });
    expect(row({ ...base, gh: null }).row.state).toBe('unknown');
    // No token, no email in the row's details.
    expect(JSON.stringify(ok.row.details)).not.toContain('ada@example.invalid');
  });

  it('readDeliveryReadiness reads the settings, gh and the author through its seams; local skips gh', async () => {
    let asked = 0;
    const gh = async () => { asked += 1; return { logins: [] as string[], active: null }; };
    const r = await readDeliveryReadiness({ deliverDefault: 'pr' }, { env: {}, gh, gitAuthor: async () => AUTHOR });
    expect(r.ready).toBe(false);
    expect(asked).toBe(1);
    const local = await readDeliveryReadiness({ deliverDefault: 'none' }, { env: {}, gh, gitAuthor: async () => null });
    expect(local.ready).toBe(true);
    expect(asked).toBe(1);
    const failing = await readDeliveryReadiness({}, { env: {}, gh: async () => { throw new Error('boom'); }, gitAuthor: async () => AUTHOR });
    expect(failing.ready).toBeNull();
  });
});
