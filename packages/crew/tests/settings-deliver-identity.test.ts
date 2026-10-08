// crew#549 — the DELIVER IDENTITY setting, and the identity the deliver script checks.
//
// The deliver phase pushed under whatever credential the daemon's environment resolved at push
// time. `GH_ACCOUNT` was the only pin, it only ever checked `gh api user`, and nothing checked the
// credential `git push` would actually use — on the RC1 rig those two disagreed and a run
// delivered under an account the operator had not chosen (F-RC1-010).
//
// The setting is a LOGIN, never a token: `GET /settings` returns it and no secret, an invalid
// value is a 400 at the PUT boundary, and the same validator guards the script's shell splice.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { deliverGateInstructions, deliverIdentityFor, deliverPrScript, isGitHubLogin, parseGhAuthStatusLogins } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SystemSettings } from '../src/core/types.js';

function memoryAdapter(initial?: Partial<SystemSettings>): CoreAdapter {
  let store: SystemSettings = { graphNodeLimit: 150, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
  } as unknown as CoreAdapter;
}

describe('PUT/GET /settings deliverIdentityLogin', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const build = (initial?: Partial<SystemSettings>) => {
    app = Fastify({ logger: false });
    registerRoutes(app, memoryAdapter(initial), new GateCache(), new ElicitationCache());
    return app;
  };

  it('accepts a login, trims it, and serves it back', async () => {
    const a = build();
    const put = await a.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { deliverIdentityLogin: '  release-bot  ' },
    });
    expect(put.statusCode).toBe(200);
    const get = await a.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(get.json().settings.deliverIdentityLogin).toBe('release-bot');
  });

  it('"" clears it (back to the GH_ACCOUNT environment variable)', async () => {
    const a = build({ deliverIdentityLogin: 'release-bot' });
    const put = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { deliverIdentityLogin: '' } });
    expect(put.statusCode).toBe(200);
    const get = await a.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(get.json().settings.deliverIdentityLogin).toBe('');
  });

  it('refuses anything that is not a GitHub login — a typo would refuse every delivery', async () => {
    const a = build();
    for (const bad of [
      'release bot', // a space
      '-release-bot', // leading hyphen
      'release--bot', // double hyphen
      'release-bot/', // a slash — the shell literal must never see one
      "release'; rm -rf /; '", // an injection attempt
      'a'.repeat(40), // past GitHub's 39
      42,
      null,
    ]) {
      const res = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { deliverIdentityLogin: bad } });
      expect(res.statusCode, `${JSON.stringify(bad)} must be refused`).toBe(400);
      expect(res.json().error).toContain('must be a GitHub login');
      // It says what it is, so nobody pastes a token into it.
      expect(res.json().error).toContain('never a token');
    }
  });
});

describe('crew#737 — PUT/GET /settings deliverIdentityByRepo (a push identity per repository)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const build = (initial?: Partial<SystemSettings>) => {
    app = Fastify({ logger: false });
    registerRoutes(app, memoryAdapter(initial), new GateCache(), new ElicitationCache());
    return app;
  };

  it('accepts repo id → login (trimmed; "" drops that repo), serves it back, and refuses a non-login naming the repo', async () => {
    const a = build();
    const put = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { deliverIdentityByRepo: { 'repo-a': ' release-bot ', 'repo-b': '' } } });
    expect(put.statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/v1/settings' })).json().settings.deliverIdentityByRepo).toEqual({ 'repo-a': 'release-bot' });
    const bad = await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { deliverIdentityByRepo: { 'repo-a': 'ghp_not a login!' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/deliverIdentityByRepo\.repo-a must be a GitHub login/);
    expect((await a.inject({ method: 'PUT', url: '/api/v1/settings', payload: { deliverIdentityByRepo: ['release-bot'] } })).statusCode).toBe(400);
  });
});

describe('crew#737 — the gate card for a pinned repository', () => {
  it('names the repository pin, says the push uses that account\'s own token, and says BEFORE approval when it is not signed in', () => {
    const repo = deliverGateInstructions({ deliverIdentity: 'release-bot', deliverIdentitySource: 'repo', deliverIdentitySignedIn: true });
    expect(repo).toContain("Push identity: release-bot (this repository's push identity) — the phase pushes with that account's own gh token");
    const out = deliverGateInstructions({ deliverIdentity: 'release-bot', deliverIdentitySource: 'repo', deliverIdentitySignedIn: false });
    expect(out).toContain("Pushes as release-bot (this repository's push identity) — NOT signed in to gh on this machine");
    expect(out).toContain('the phase will refuse and push nothing');
    // Unknown (no probe) is never "not signed in".
    expect(deliverGateInstructions({ deliverIdentity: 'release-bot', deliverIdentitySignedIn: null })).not.toContain('NOT signed in');
  });

  it('the repository pin wins over the daemon-wide identity; an unpinned repo falls back', () => {
    const settings = { deliverIdentityLogin: 'daemon-bot', deliverIdentityByRepo: { 'repo-a': 'release-bot' } };
    expect(deliverIdentityFor(settings, 'repo-a')).toEqual({ login: 'release-bot', source: 'repo' });
    expect(deliverIdentityFor(settings, 'repo-b')).toEqual({ login: 'daemon-bot', source: 'setting' });
    expect(deliverIdentityFor(settings, undefined)).toEqual({ login: 'daemon-bot', source: 'setting' });
    expect(deliverIdentityFor({}, 'repo-a')).toEqual({ login: '', source: 'setting' });
  });

  it('parses gh auth status (new and old wording) into the logins it holds', () => {
    const text = [
      'github.com',
      '  ✓ Logged in to github.com account release-bot (keyring)',
      '  - Active account: true',
      '  ✓ Logged in to github.com account other-bot (keyring)',
      '  ✓ Logged in to github.com as old-style (oauth_token)',
    ].join('\n');
    expect(parseGhAuthStatusLogins(text)).toEqual(['release-bot', 'other-bot', 'old-style']);
    expect(parseGhAuthStatusLogins('You are not logged into any GitHub hosts.')).toEqual([]);
  });
});

describe('the deliver identity in the script and on the gate card', () => {
  it('bakes the configured login and refuses at compose time on anything else', () => {
    const script = deliverPrScript('fix it', { deliverIdentity: 'release-bot' });
    expect(script).toContain("CFG='release-bot'");
    // The env var still works when nothing is configured, and the setting wins when it is.
    expect(script).toContain('if [ -n "$CFG" ]; then GH_ACCOUNT="$CFG"; fi');
    expect(deliverPrScript('fix it')).toContain("CFG=''");
    for (const bad of ["release'; echo pwned; '", 'release bot', '-x']) {
      expect(() => deliverPrScript('fix it', { deliverIdentity: bad })).toThrow(/not a GitHub login/);
    }
  });

  it('asks git which credential the push would use, and refuses when it disagrees with gh', () => {
    const script = deliverPrScript('fix it');
    expect(script).toContain('git credential fill');
    expect(script).toContain('GIT_TERMINAL_PROMPT=0');
    // Before anything is fetched or staged: the identity block precedes the first fetch.
    expect(script.indexOf('git credential fill')).toBeLessThan(script.indexOf('git fetch origin'));
    expect(script).toContain("git's credential for $RH is $GC");
  });

  it('the gate card names the login, WHERE it is configured, and the cross-check', () => {
    const fromSetting = deliverGateInstructions({ deliverIdentity: 'release-bot', ghAccount: 'stale-bot' });
    expect(fromSetting).toContain('Push identity: release-bot (the deliver identity setting)');
    const fromEnv = deliverGateInstructions({ ghAccount: 'env-bot' });
    expect(fromEnv).toContain('Push identity: env-bot (GH_ACCOUNT)');
    const none = deliverGateInstructions({});
    expect(none).toContain('none configured');
    expect(none).toContain('set the deliver identity in system settings');
    for (const text of [fromSetting, fromEnv, none]) {
      expect(text).toContain("refuses if gh's login and git's credential for the remote disagree");
    }
  });

  it('isGitHubLogin is the one validator both boundaries use', () => {
    for (const ok of ['a', 'release-bot', 'a1-b2-c3', 'A'.repeat(39)]) expect(isGitHubLogin(ok)).toBe(true);
    for (const bad of ['', '-a', 'a-', 'a--b', 'a b', 'a/b', 'a'.repeat(40), "a'b"]) {
      expect(isGitHubLogin(bad), bad).toBe(false);
    }
  });
});
