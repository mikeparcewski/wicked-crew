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
import { deliverGateInstructions, deliverPrScript, isGitHubLogin } from '../src/core/deliver.js';
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
