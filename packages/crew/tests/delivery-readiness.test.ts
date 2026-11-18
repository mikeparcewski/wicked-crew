/**
 * crew#1527: whether a GitHub pull request can be opened, before the first job — one answer for the setup steps and the
 * system page's `delivery` row, following what the deliver script itself requires.
 */
import { describe, expect, it } from 'vitest';
import { infraRow } from '../src/api/system-snapshot.js';
import { deliveryReadiness, deliveryRow, readDeliveryReadiness, type DeliveryReadinessInput } from '../src/setup/delivery-readiness.js';

const AUTHOR = { name: 'Ada', email: 'ada@example.invalid' };
const SIGNED_IN = { logins: ['ada'], active: 'ada', ok: true };
const SIGNED_OUT = { logins: [] as string[], active: null, ok: false };
const base: DeliveryReadinessInput = { deliverDefault: 'pr', identityLogin: undefined, env: {}, gh: SIGNED_IN, gitAuthor: AUTHOR };
const r = (over: Partial<DeliveryReadinessInput>) => deliveryReadiness({ ...base, ...over });

describe('deliveryReadiness (crew#1527)', () => {
  it('gh signed in and a global author: ready, with gh\'s account named and no email anywhere in the words', () => {
    const a = r({});
    expect(a).toMatchObject({ deliverDefault: 'pr', ready: true, pushAs: null, fix: null });
    expect(a.reason).toContain("gh's signed-in account (ada)");
    expect(a.reason).not.toContain('ada@example.invalid');
  });

  it('the fresh-home case (#1527): gh signed out, no author -> not ready, naming gh auth login, git config and local delivery', () => {
    const a = r({ gh: SIGNED_OUT, deliverDefault: undefined, gitAuthor: null });
    expect(a.ready).toBe(false);
    expect(a.github.status).toBe('missing');
    expect(a.reason).toMatch(/would stop at its deliver step: gh is not signed in/);
    expect(a.fix).toContain('gh auth login');
    expect(a.fix).toContain('git config --global user.name');
    expect(a.fix).toContain('deliver locally');
    expect(a.fix).toContain('Open a PR when a build run finishes');
  });

  it('a daemon defaulting to local delivery still answers for a pull request (studio always asks for one or not)', () => {
    expect(r({ deliverDefault: 'none' })).toMatchObject({ deliverDefault: 'none', ready: true });
    expect(r({ deliverDefault: 'none', gh: SIGNED_OUT })).toMatchObject({ deliverDefault: 'none', ready: false });
  });

  /** Independent of the preflight helper: the deliver script's own requirements (core/deliver.ts deliverPrScript). */
  describe('what the deliver script requires', () => {
    it('gh not installed is not ready, even with an exported GH_TOKEN (gh opens the pull request)', () => {
      for (const env of [{}, { GH_TOKEN: 't' }]) {
        const a = r({ gh: 'absent', env });
        expect(a.ready).toBe(false);
        expect(a.reason).toContain('gh is not installed');
      }
    });

    it('gh not answering is unknown, never ready and never signed out, even with an exported GH_TOKEN', () => {
      for (const env of [{}, { GH_TOKEN: 't' }]) expect(r({ gh: null, env }).ready).toBeNull();
    });

    it('unpinned: a listed login is not enough when gh auth status fails (the script requires it to succeed)', () => {
      const a = r({ gh: { logins: ['ada'], active: 'ada', ok: false } });
      expect(a.ready).toBe(false);
      expect(a.reason).toContain('gh auth status fails');
    });

    it('pinned: that account\'s gh login is the credential (gh auth status of another sign-in does not matter)', () => {
      expect(r({ identityLogin: 'grace', gh: { logins: ['ada', 'grace'], active: 'ada', ok: false } })).toMatchObject({ ready: true, pushAs: 'grace' });
      const a = r({ identityLogin: 'grace' });
      expect(a).toMatchObject({ ready: false, pushAs: 'grace' });
      expect(a.fix).toContain('as grace');
      expect(r({ env: { GH_ACCOUNT: 'grace' } })).toMatchObject({ ready: false, pushAs: 'grace' });
    });

    it('an exported GH_TOKEN with a push identity is unknown: the script refuses another account\'s token, checked only at delivery', () => {
      const a = r({ identityLogin: 'grace', env: { GH_TOKEN: 't' }, gh: SIGNED_OUT });
      expect(a.ready).toBeNull();
      expect(a.reason).toContain("grace's");
      expect(a.fix).toContain('unset it');
    });

    it('an exported GH_TOKEN without a push identity is ready (gh installed), whatever gh\'s own login', () => {
      const a = r({ env: { GH_TOKEN: 't' }, gh: SIGNED_OUT });
      expect(a).toMatchObject({ ready: true, pushAs: null });
      expect(a.github.source).toBe('gh_token');
      expect(a.reason).toContain('exported GH_TOKEN');
    });

    it('no global author (name or email missing or blank) is not ready: git commit refuses', () => {
      for (const gitAuthor of [null, { name: 'Ada', email: null }, { name: ' ', email: 'a@b' }]) {
        const a = r({ gitAuthor });
        expect(a.ready).toBe(false);
        expect(a.fix).toContain('git config --global user.email');
      }
    });
  });

  it('the system row is the same answer, and the whole row never carries the author\'s name or email', () => {
    const row = (i: Partial<DeliveryReadinessInput>) => {
      const a = r(i);
      return { a, row: deliveryRow(a, Date.now(), infraRow) };
    };
    const ok = row({});
    expect(ok.row).toMatchObject({ key: 'delivery', state: 'ok', reason: ok.a.reason, remedy: null, details: { ready: true } });
    const bad = row({ gh: SIGNED_OUT });
    expect(bad.row).toMatchObject({ state: 'degraded', reason: bad.a.reason, remedy: bad.a.fix });
    const localBad = row({ deliverDefault: 'none', gh: SIGNED_OUT });
    expect(localBad.row.state).toBe('off');
    expect(localBad.row.reason).toContain('defaults to local');
    expect(row({ gh: null }).row.state).toBe('unknown');
    for (const x of [ok, bad, localBad, row({ gitAuthor: { name: 'Ada', email: null } })]) {
      const whole = JSON.stringify(x.row);
      expect(whole).not.toContain('ada@example.invalid');
      expect(whole).not.toContain('"Ada"');
    }
  });

  describe('readDeliveryReadiness: the one bounded reader both routes use', () => {
    const settings = async () => ({ deliverDefault: 'pr' as const });
    it('reads the settings, gh and the author through its seams', async () => {
      const a = await readDeliveryReadiness(settings, { env: {}, gh: async () => SIGNED_OUT, gitAuthor: async () => AUTHOR });
      expect(a.ready).toBe(false);
      const pinned = await readDeliveryReadiness(async () => ({ deliverIdentityLogin: 'ada' }), { env: {}, gh: async () => SIGNED_IN, gitAuthor: async () => AUTHOR });
      expect(pinned).toMatchObject({ ready: true, pushAs: 'ada' });
    });

    it('SILENT-OK: a throwing gh, a failed settings read, or a read past the bound is unknown, never ready', async () => {
      const threw = await readDeliveryReadiness(settings, { env: { GH_TOKEN: 't' }, gh: async () => { throw new Error('boom'); }, gitAuthor: async () => AUTHOR });
      expect(threw.ready).toBeNull();
      const noSettings = await readDeliveryReadiness(async () => { throw new Error('unreadable'); }, { env: {}, gh: async () => SIGNED_IN, gitAuthor: async () => AUTHOR });
      expect(noSettings.ready).toBeNull();
      const slow = await readDeliveryReadiness(settings, { env: {}, gh: async () => SIGNED_IN, gitAuthor: () => new Promise(() => undefined), timeoutMs: 20 });
      expect(slow.ready).toBeNull();
      expect(slow.reason).toContain('did not answer');
      expect(deliveryRow(slow, Date.now(), infraRow).state).toBe('unknown');
    });

    it('a read past the bound still carries the settings it read (the default and the push identity), never invented ones', async () => {
      const slow = await readDeliveryReadiness(async () => ({ deliverDefault: 'none' as const, deliverIdentityLogin: 'ada' }), {
        env: {}, gh: () => new Promise(() => undefined), gitAuthor: async () => AUTHOR, timeoutMs: 20,
      });
      expect(slow).toMatchObject({ ready: null, deliverDefault: 'none', pushAs: 'ada' });
      expect(deliveryRow(slow, Date.now(), infraRow).state).toBe('unknown');
      const noSettings = await readDeliveryReadiness(async () => { throw new Error('unreadable'); }, { env: {}, gh: async () => SIGNED_IN, gitAuthor: async () => AUTHOR });
      expect(noSettings).toMatchObject({ ready: null, deliverDefault: 'pr', pushAs: null });
    });
  });
});
