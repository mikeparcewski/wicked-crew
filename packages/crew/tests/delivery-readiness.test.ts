/**
 * crew#1527: whether a GitHub pull request can be opened, before the first job — one answer for the setup steps and the
 * system page's `delivery` row. The credential is checked by RUNNING the deliver script's own credential lines against
 * a stand-in gh; the git identity by asking real git.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { infraRow } from '../src/api/system-snapshot.js';
import {
  deliveryReadiness,
  deliveryRow,
  probeGithubCredential,
  readDeliveryReadiness,
  type DeliveryReadinessInput,
  type GithubCredentialProbe,
} from '../src/setup/delivery-readiness.js';
import { gitCommitIdents, type GitCommitIdents } from '../src/setup/known.js';

const ADA = { name: 'Ada', email: 'ada@example.invalid' };
const BOTH: GitCommitIdents = { author: ADA, committer: ADA };
const OK_GH: GithubCredentialProbe = { outcome: 'ok', pin: 'gh', login: 'ada' };
const base: DeliveryReadinessInput = { deliverDefault: 'pr', identityLogin: undefined, env: {}, credential: OK_GH, identity: BOTH };
const r = (over: Partial<DeliveryReadinessInput>) => deliveryReadiness({ ...base, ...over });

const root = mkdtempSync(join(tmpdir(), 'crew1527-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in gh with gh's precedence: GH_TOKEN, then GITHUB_TOKEN, then the stored login (FAKE_STORED). Tokens named
 *  `valid-<login>` / `keyring-<login>` authenticate as <login>; any other token is refused (HTTP 401). FAKE_KEYRING lists
 *  the logins `gh auth token --user` holds a token for; FAKE_OFFLINE makes GitHub unreachable. Builtins only. */
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh
tok="\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"
case "$1 $2" in
  "auth token") for a; do last=$a; done; case " \${FAKE_KEYRING:-} " in *" $last "*) echo "keyring-$last";; *) exit 1;; esac;;
  "auth status")
    if [ -n "$tok" ]; then case "$tok" in valid-*|keyring-*) exit 0;; *) echo "X Failed to log in to github.com using token" >&2; exit 1;; esac; fi
    [ -n "\${FAKE_STORED:-}" ] && exit 0; echo "You are not logged into any GitHub hosts" >&2; exit 1;;
  "api user")
    [ -n "\${GH_DEBUG:-}" ] && echo "* Request to https://api.github.com/user" >&2
    [ -n "\${FAKE_OFFLINE:-}" ] && { echo "error connecting to api.github.com" >&2; exit 1; }
    if [ -n "$tok" ]; then case "$tok" in valid-*) echo "\${tok#valid-}"; exit 0;; keyring-*) echo "\${tok#keyring-}"; exit 0;; *) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1;; esac; fi
    [ -n "\${FAKE_STORED:-}" ] && { echo "$FAKE_STORED"; exit 0; }; echo "gh: Requires authentication (HTTP 401)" >&2; exit 1;;
esac
`,
);
chmodSync(join(bin, 'gh'), 0o755);
const empty = join(root, 'empty');
mkdirSync(empty);

/** The probe in a plain (non-login) bash with only the stand-in gh on PATH. */
const probe = (env: Record<string, string>, identity = '') =>
  probeGithubCredential(identity, { env: { PATH: bin, HOME: root, ...env }, shell: ['/bin/bash', '-c'] });
/** The whole answer for one environment, credential probed for real. */
const answer = async (env: Record<string, string>, identity = '') =>
  deliveryReadiness({ ...base, identityLogin: identity || undefined, env, credential: await probe(env, identity) });

describe('deliveryReadiness (crew#1527): the deliver script\'s own credential lines, run', () => {
  it('W20 (merge check): an expired exported GITHUB_TOKEN beside a valid stored login is NOT ready, as delivery refuses it', async () => {
    const env = { GITHUB_TOKEN: 'expired-1', FAKE_STORED: 'ada' };
    expect(await probe(env)).toMatchObject({ outcome: 'missing' });
    const a = await answer(env);
    expect(a.ready).toBe(false);
    expect(a.github.status).toBe('missing');
    expect(a.fix).toContain('the exported GITHUB_TOKEN is what delivery uses');
    // The same stored login with no exported token is ready, naming gh's account.
    const ok = await answer({ FAKE_STORED: 'ada' });
    expect(ok).toMatchObject({ ready: true, pushAs: null, fix: null });
    expect(ok.reason).toContain("gh's signed-in account (ada)");
  });

  it('an exported GH_TOKEN is the credential: a valid one is ready (whatever gh\'s own login), an expired one is refused', async () => {
    const ok = await answer({ GH_TOKEN: 'valid-ada' });
    expect(ok).toMatchObject({ ready: true, github: { source: 'gh_token' } });
    expect(ok.reason).toContain('exported GH_TOKEN (ada)');
    expect(await probe({ GH_TOKEN: 'expired-2', FAKE_STORED: 'ada' })).toEqual({ outcome: 'refused', pin: 'exported' });
    const bad = await answer({ GH_TOKEN: 'expired-2', FAKE_STORED: 'ada' });
    expect(bad.ready).toBe(false);
    expect(bad.reason).toContain('GitHub refuses the exported GH_TOKEN');
  });

  it('pinned: the push identity\'s keyring token is the credential; none for it is not ready, naming the account', async () => {
    expect(await answer({ FAKE_KEYRING: 'grace', FAKE_STORED: 'ada' }, 'grace')).toMatchObject({ ready: true, pushAs: 'grace' });
    const none = await answer({ FAKE_STORED: 'ada' }, 'grace');
    expect(none).toMatchObject({ ready: false, pushAs: 'grace' });
    expect(none.fix).toContain('as grace');
    // GH_ACCOUNT pins too, as the script reads it.
    expect(await answer({ GH_ACCOUNT: 'grace', FAKE_STORED: 'ada' })).toMatchObject({ ready: false, pushAs: 'grace' });
  });

  it('pinned with an exported GH_TOKEN: another account\'s token is not ready (the script refuses it); the identity\'s own is ready', async () => {
    expect(await probe({ GH_TOKEN: 'valid-ada' }, 'grace')).toEqual({ outcome: 'mismatch', login: 'ada' });
    const mis = await answer({ GH_TOKEN: 'valid-ada' }, 'grace');
    expect(mis.ready).toBe(false);
    expect(mis.reason).toContain('authenticates as ada, not the push identity grace');
    expect(await answer({ GH_TOKEN: 'valid-grace' }, 'grace')).toMatchObject({ ready: true, pushAs: 'grace' });
  });

  it('codex r3 W12: gh diagnostics on stderr (GH_DEBUG) are not the login: the identity\'s own token stays ready', async () => {
    expect(await probe({ GH_TOKEN: 'valid-grace', GH_DEBUG: 'api' }, 'grace')).toEqual({ outcome: 'ok', pin: 'exported', login: 'grace' });
    expect(await probe({ GH_TOKEN: 'expired-3', GH_DEBUG: 'api' }, 'grace')).toEqual({ outcome: 'refused', pin: 'exported' });
  });

  it('an exported GITHUB_TOKEN gh uses (unpinned) is reported as the environment token, not gh\'s sign-in', async () => {
    const a = await answer({ GITHUB_TOKEN: 'valid-ada' });
    expect(a).toMatchObject({ ready: true, github: { source: 'gh_token' } });
    expect(a.github.message).toContain('GITHUB_TOKEN');
  });

  it('gh not installed is not ready, even with an exported GH_TOKEN (gh opens the pull request)', async () => {
    for (const env of [{}, { GH_TOKEN: 'valid-ada' }]) {
      const c = await probeGithubCredential('', { env: { PATH: empty, HOME: root, ...env }, shell: ['/bin/bash', '-c'] });
      expect(c).toEqual({ outcome: 'absent' });
      expect(deliveryReadiness({ ...base, credential: c }).reason).toContain('gh is not installed');
    }
  });

  it('could not check (GitHub unreachable, the shell not running) is unknown, never ready and never not-ready', async () => {
    expect(await probe({ FAKE_STORED: 'ada', FAKE_OFFLINE: '1' })).toBeNull();
    expect(await probeGithubCredential('', { env: { PATH: bin }, shell: [join(root, 'no-such-shell'), '-c'] })).toBeNull();
    expect(r({ credential: null }).ready).toBeNull();
    // A definite blocker still says not ready, and names what was not checked.
    const both = r({ credential: null, identity: { author: null, committer: null } });
    expect(both.ready).toBe(false);
    expect(both.reason).toContain('Not checked: the GitHub credential');
  });

  it('the fresh-home case: gh signed out, no identity -> not ready, naming gh auth login, git config and local delivery', async () => {
    const a = deliveryReadiness({ ...base, deliverDefault: undefined, credential: await probe({}), identity: { author: null, committer: null } });
    expect(a.ready).toBe(false);
    expect(a.reason).toMatch(/would stop at its deliver step: GitHub credentials not configured: gh is not signed in/);
    expect(a.reason).toContain('no git author or committer identity is configured');
    expect(a.fix).toContain('gh auth login');
    expect(a.fix).toContain('git config --global user.name');
    expect(a.fix).toContain('deliver locally');
  });

  it('a daemon defaulting to local delivery still answers for a pull request (studio always asks for one or not)', () => {
    expect(r({ deliverDefault: 'none' })).toMatchObject({ deliverDefault: 'none', ready: true });
    expect(r({ deliverDefault: 'none', credential: { outcome: 'absent' } })).toMatchObject({ deliverDefault: 'none', ready: false });
  });

  it('the system row is the same answer, and the whole row never carries the author\'s name or email', () => {
    const row = (i: Partial<DeliveryReadinessInput>) => {
      const a = r(i);
      return { a, row: deliveryRow(a, Date.now(), infraRow) };
    };
    const ok = row({});
    expect(ok.row).toMatchObject({ key: 'delivery', state: 'ok', reason: ok.a.reason, remedy: null, details: { ready: true } });
    const bad = row({ credential: { outcome: 'absent' } });
    expect(bad.row).toMatchObject({ state: 'degraded', reason: bad.a.reason, remedy: bad.a.fix });
    const localBad = row({ deliverDefault: 'none', credential: { outcome: 'absent' } });
    expect(localBad.row.state).toBe('off');
    expect(localBad.row.reason).toContain('defaults to local');
    expect(row({ credential: null }).row.state).toBe('unknown');
    for (const x of [ok, bad, localBad, row({ identity: { author: ADA, committer: null } })]) {
      const whole = JSON.stringify(x.row);
      expect(whole).not.toContain('ada@example.invalid');
      expect(whole).not.toContain('"Ada"');
    }
  });
});

describe('the git identity, asked of git as wicked-core asks it (core#1555)', () => {
  const gitEnv = (config: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)|^EMAIL$/u.test(k)) delete env[k];
    return env;
  };
  const cfg = (name: string, text: string) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };

  it('W12 (merge check): only author.* and committer.* configured (no user.*) resolves both roles: ready', async () => {
    const env = gitEnv(cfg('roles.gitconfig', '[author]\n\tname = Ada A\n\temail = a@example.invalid\n[committer]\n\tname = Ada C\n\temail = c@example.invalid\n'));
    const id = await gitCommitIdents({ cwd: empty, env });
    expect(id).toEqual({ author: { name: 'Ada A', email: 'a@example.invalid' }, committer: { name: 'Ada C', email: 'c@example.invalid' } });
    expect(r({ identity: id }).ready).toBe(true);
  });

  it('nothing configured: both roles are missing (git\'s own "identity unknown"), not ready', async () => {
    const id = await gitCommitIdents({ cwd: empty, env: gitEnv(cfg('none.gitconfig', '')) });
    expect(id).toEqual({ author: null, committer: null });
    const a = r({ identity: id });
    expect(a.ready).toBe(false);
    expect(a.fix).toContain('git config --global user.email');
  });

  it('a blank or control-character name is missing (the seat\'s rule); a no-break-space name counts as blank', () => {
    for (const author of [{ name: ' ', email: 'a@b' }, { name: ' ', email: 'a@b' }, { name: 'Ad\ra', email: 'a@b' }]) {
      expect(r({ identity: { author, committer: ADA } }).ready).toBe(false);
    }
  });

  it('W12 (merge check): a git that could not be asked, or a read that rejects, is unknown, never not-ready and never ready', async () => {
    expect(await gitCommitIdents({ cwd: empty, env: gitEnv(cfg('x.gitconfig', '')), git: join(root, 'no-such-git') })).toBeNull();
    expect(r({ identity: null }).ready).toBeNull();
    const rejected = await readDeliveryReadiness(async () => ({ deliverDefault: 'pr' as const }), {
      env: {}, credential: async () => OK_GH, identity: async () => { throw new Error('git broke'); },
    });
    expect(rejected.ready).toBeNull();
    expect(rejected.reason).toContain('the git author could not be read');
  });
});

describe('readDeliveryReadiness: the one bounded reader both routes use', () => {
  const settings = async () => ({ deliverDefault: 'pr' as const });
  it('reads the settings, the credential (for the configured push identity) and the identity through its seams', async () => {
    const asked: string[] = [];
    const a = await readDeliveryReadiness(async () => ({ deliverIdentityLogin: ' grace ' }), {
      env: {}, credential: async (id) => { asked.push(id); return { outcome: 'ok', pin: 'keyring', login: 'grace' }; }, identity: async () => BOTH,
    });
    expect(asked).toEqual(['grace']);
    expect(a).toMatchObject({ ready: true, pushAs: 'grace' });
  });

  it('SILENT-OK: a throwing probe, a failed settings read, or a read past the bound is unknown, never ready', async () => {
    const threw = await readDeliveryReadiness(settings, { env: {}, credential: async () => { throw new Error('boom'); }, identity: async () => BOTH });
    expect(threw.ready).toBeNull();
    const noSettings = await readDeliveryReadiness(async () => { throw new Error('unreadable'); }, { env: {}, credential: async () => OK_GH, identity: async () => BOTH });
    expect(noSettings).toMatchObject({ ready: null, deliverDefault: 'pr', pushAs: null });
    const slow = await readDeliveryReadiness(settings, { env: {}, credential: async () => OK_GH, identity: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(slow.ready).toBeNull();
    expect(slow.reason).toContain('did not answer');
    expect(deliveryRow(slow, Date.now(), infraRow).state).toBe('unknown');
  });

  it('a read past the bound still carries the settings it read (the default and the push identity), never invented ones', async () => {
    const slow = await readDeliveryReadiness(async () => ({ deliverDefault: 'none' as const, deliverIdentityLogin: 'ada' }), {
      env: {}, credential: () => new Promise(() => undefined), identity: async () => BOTH, timeoutMs: 20,
    });
    expect(slow).toMatchObject({ ready: null, deliverDefault: 'none', pushAs: 'ada' });
    expect(deliveryRow(slow, Date.now(), infraRow).state).toBe('unknown');
  });
});
