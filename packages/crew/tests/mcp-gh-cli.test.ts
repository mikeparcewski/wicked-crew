/**
 * The `gh-cli:<login>` credential of a GitHub project-management source: the GitHub CLI's sign-in, pinned to one
 * account, read at the moment of each call and never kept. A fake gh runner stands in for the real CLI.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ghAccountState } from '../src/core/deliver-credentials.js';
import { parseGhActiveLogin } from '../src/core/deliver.js';
import type { McpUpstreamConfig, ProbeResult } from '../src/mcp/probe.js';
import { McpRegistry, McpRegistryError } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { type GhRan, type GhRunner, parseSecretRef, resolveSecret, secretIsSet, type SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  sets = 0;
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.sets += 1;
    this.values.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

const block = (login: string, active: boolean | null): string =>
  `  ✓ Logged in to github.com account ${login} (keyring)\n${active === null ? '' : `  - Active account: ${active}\n`}  - Git operations protocol: https\n`;
const status = (...blocks: string[]): string => `github.com\n${blocks.join('')}`;

/** A fake gh: `statusText` answers the status call, `token` the token call; every call is recorded. */
function fakeGh(init: { statusText: string | 'enoent'; token?: string; tokenCode?: number }): GhRunner & { calls: string[][]; state: { statusText: string | 'enoent'; token: string; tokenCode: number } } {
  const state = { statusText: init.statusText, token: init.token ?? 'ghp_synthetic_one', tokenCode: init.tokenCode ?? 0 };
  const calls: string[][] = [];
  const run = (async (args: string[]): Promise<GhRan> => {
    calls.push(args);
    if (args[1] === 'status') {
      return state.statusText === 'enoent' ? { code: null, stdout: '', stderr: '', enoent: true } : { code: 0, stdout: '', stderr: state.statusText };
    }
    return { code: state.tokenCode, stdout: `${state.token}\n`, stderr: '' };
  }) as GhRunner & { calls: string[][]; state: typeof state };
  run.calls = calls;
  run.state = state;
  return run;
}
const tokenCalls = (gh: { calls: string[][] }): string[][] => gh.calls.filter((c) => c[1] === 'token');

describe('parseGhActiveLogin', () => {
  it('reads the Active account marker per block', () => {
    expect(parseGhActiveLogin(status(block('alice', false), block('bob', true)))).toBe('bob');
  });
  it('takes a single login with no marker (older gh) as active', () => {
    expect(parseGhActiveLogin('Logged in to github.com as alice (keyring)')).toBe('alice');
  });
  it('is null when several logins and no single active one can be proven', () => {
    expect(parseGhActiveLogin(status(block('alice', null), block('bob', null)))).toBeNull();
    expect(parseGhActiveLogin(status(block('alice', true), block('bob', true)))).toBeNull();
    expect(parseGhActiveLogin('not signed in')).toBeNull();
  });
});

describe('gh-cli references', () => {
  it('parses a GitHub login and rejects anything else before a subprocess could run', () => {
    expect(parseSecretRef('gh-cli:alice')).toEqual({ kind: 'gh-cli', account: 'alice' });
    for (const bad of ['gh-cli:', 'gh-cli:-bad', 'gh-cli:a b', 'gh-cli:a;rm', 'gh-cli:$(id)', `gh-cli:${'a'.repeat(40)}`]) expect(parseSecretRef(bad)).toBeNull();
    expect(parseSecretRef('env:GH_X')).toEqual({ kind: 'env', name: 'GH_X' });
  });

  it('reads the pinned active account\'s token each time, with the pinned command, and never caches it', async () => {
    const gh = fakeGh({ statusText: status(block('alice', true)) });
    const store = new MemorySecretStore();
    expect(await resolveSecret('gh-cli:alice', store, {}, gh)).toBe('ghp_synthetic_one');
    gh.state.token = 'ghp_synthetic_two';
    expect(await resolveSecret('gh-cli:alice', store, {}, gh)).toBe('ghp_synthetic_two');
    expect(tokenCalls(gh)).toEqual([
      ['auth', 'token', '--hostname', 'github.com', '--user', 'alice'],
      ['auth', 'token', '--hostname', 'github.com', '--user', 'alice'],
    ]);
    expect(store.sets).toBe(0);
  });

  it('refuses another active account by name, without reading any token', async () => {
    const gh = fakeGh({ statusText: status(block('alice', false), block('bob', true)) });
    await expect(resolveSecret('gh-cli:alice', new MemorySecretStore(), {}, gh)).rejects.toMatchObject({ code: 'gh_account_mismatch' });
    expect(tokenCalls(gh)).toEqual([]);
  });

  it('refuses several accounts with no provable active one', async () => {
    const gh = fakeGh({ statusText: status(block('alice', null), block('bob', null)) });
    await expect(resolveSecret('gh-cli:alice', new MemorySecretStore(), {}, gh)).rejects.toMatchObject({ code: 'gh_account_mismatch' });
    expect(tokenCalls(gh)).toEqual([]);
  });

  it('names signed-out, not-installed and no-token, and never falls back to GH_TOKEN', async () => {
    const env = { GH_TOKEN: 'ghp_env_token', GITHUB_TOKEN: 'ghp_env_token2' };
    const store = new MemorySecretStore();
    await expect(resolveSecret('gh-cli:alice', store, env, fakeGh({ statusText: status(block('bob', true)) }))).rejects.toMatchObject({ code: 'gh_signed_out' });
    await expect(resolveSecret('gh-cli:alice', store, env, fakeGh({ statusText: 'enoent' }))).rejects.toMatchObject({ code: 'gh_not_installed' });
    await expect(resolveSecret('gh-cli:alice', store, env, fakeGh({ statusText: status(block('alice', true)), tokenCode: 1 }))).rejects.toMatchObject({ code: 'gh_token_unavailable' });
  });

  it('secretIsSet answers from the status alone', async () => {
    const gh = fakeGh({ statusText: status(block('alice', true)) });
    expect(await secretIsSet('gh-cli:alice', new MemorySecretStore(), {}, gh)).toBe(true);
    gh.state.statusText = status(block('alice', false), block('bob', true));
    expect(await secretIsSet('gh-cli:alice', new MemorySecretStore(), {}, gh)).toBe(false);
    expect(tokenCalls(gh)).toEqual([]);
  });
});

describe('a GitHub source saved with gh-cli', () => {
  let base: string;
  let secrets: MemorySecretStore;
  let gh: ReturnType<typeof fakeGh>;
  let seen: Array<string | null>;
  let registry: McpRegistry;
  let ghState: { available: boolean; accounts: string[]; active: string | null };
  const config = (over: Partial<McpUpstreamConfig> = {}): McpUpstreamConfig => ({
    name: 'github',
    kind: 'mcp-http',
    command: null,
    args: [],
    url: 'https://mcp.example.test/mcp',
    auth: { ref: 'gh-cli:alice', header: 'Authorization', prefix: 'Bearer ' },
    pm: { system: 'github' },
    ...over,
  });
  const probe = async (_c: McpUpstreamConfig, secret: string | null): Promise<ProbeResult> => {
    seen.push(secret);
    return { ok: true, serverInfo: null, tools: [] };
  };
  const make = (): McpRegistry => new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets, probe, discover: () => [], gh, ghState: async () => ghState });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crew-mcp-gh-'));
    mkdirSync(join(base, 'state'), { recursive: true });
    secrets = new MemorySecretStore();
    gh = fakeGh({ statusText: status(block('alice', true)) });
    seen = [];
    ghState = { available: true, accounts: ['alice'], active: 'alice' };
    registry = make();
  });
  afterEach(() => removeScratch(base));

  const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

  it('previews, saves and reads with the current token, storing none anywhere', async () => {
    const p = await registry.preview(config());
    expect(seen).toEqual(['ghp_synthetic_one']);
    await registry.save(p.previewHash);
    gh.state.token = 'ghp_synthetic_two';
    const reread = make();
    expect(await reread.callSecret(config())).toEqual({ secret: 'ghp_synthetic_two', missing: false });
    expect(secrets.sets).toBe(0);
    expect(secrets.values.size).toBe(0);
    for (const f of filesUnder(base)) {
      if (statSync(f).isFile()) {
        const text = readFileSync(f, 'utf8');
        expect(text).not.toContain('ghp_synthetic');
      }
    }
    const stored = JSON.stringify(await reread.list());
    expect(stored).toContain('gh-cli:alice');
    expect(stored).not.toContain('ghp_synthetic');
  });

  it('refuses a different active account on preview and on a read, and sends nothing', async () => {
    const p = await registry.preview(config());
    await registry.save(p.previewHash);
    seen.length = 0;
    gh.state.statusText = status(block('alice', false), block('bob', true));
    await expect(registry.preview(config())).rejects.toMatchObject({ status: 409, code: 'gh_account_mismatch' });
    await expect(registry.callSecret(config())).rejects.toMatchObject({ status: 409, code: 'gh_account_mismatch' });
    expect(seen).toEqual([]);
    expect(tokenCalls(gh).length).toBe(1); // the first preview's, none after the switch
  });

  it('reports gh missing, signed out and signed in on the listing, and never reads a token for it', async () => {
    for (const state of [
      { available: false, accounts: [], active: null },
      { available: true, accounts: [], active: null },
      { available: true, accounts: ['alice', 'bob'], active: 'bob' },
    ]) {
      ghState = state;
      expect((await registry.list()).ghCli).toEqual(state);
    }
    expect(gh.calls).toEqual([]);
  });

  it('is for a GitHub PM source only, and a staged secret is not paired with it', async () => {
    await expect(registry.preview(config({ pm: { system: 'jira' } }))).rejects.toBeInstanceOf(McpRegistryError);
    const noPm = config();
    delete noPm.pm;
    await expect(registry.preview(noPm)).rejects.toMatchObject({ code: 'gh_cli_not_allowed' });
    await expect(registry.preview(config(), 'a-typed-token-value')).rejects.toMatchObject({ code: 'secret_not_staged_here' });
    expect(secrets.sets).toBe(0);
  });

  it('leaves a typed-token source unchanged and never runs gh for it', async () => {
    const typed = config({ auth: { ref: 'keychain:wicked-mcp/github', header: 'Authorization', prefix: 'Bearer ' } });
    const p = await registry.preview(typed, 'typed-token-value');
    await registry.save(p.previewHash);
    expect(secrets.values.get('github')).toBe('typed-token-value');
    expect(await registry.callSecret(typed)).toEqual({ secret: 'typed-token-value', missing: false });
    expect(gh.calls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the listing and the resolver see the same identities', () => {
  it('an exported GH_TOKEN / GITHUB_TOKEN does not make the listing offer an account the resolver would refuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-fake-gh-'));
    // A gh that reports an env-token identity when it is handed a token variable, the keyring account otherwise.
    writeFileSync(
      join(dir, 'gh'),
      '#!/bin/sh\nif [ -n "$GH_TOKEN$GITHUB_TOKEN" ]; then\n  echo "  ✓ Logged in to github.com account envuser (GH_TOKEN)"\nelse\n  echo "  ✓ Logged in to github.com account alice (keyring)"\n  echo "  - Active account: true"\nfi\n',
    );
    chmodSync(join(dir, 'gh'), 0o755);
    vi.stubEnv('PATH', `${dir}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('GH_TOKEN', 'ghp_synthetic_env');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_synthetic_env2');
    try {
      expect(await ghAccountState()).toEqual({ available: true, accounts: ['alice'], active: 'alice' });
    } finally {
      vi.unstubAllEnvs();
      removeScratch(dir);
    }
  });
});
