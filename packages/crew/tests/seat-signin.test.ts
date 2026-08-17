// Seat sign-in presence probes (seat sign-in) — the file/env heuristic, branch by branch.
//
// Every test runs against a FIXTURE home built with mkdtemp and an injected env (SigninProbeIo),
// so the suite never reads the developer's real dotfiles and never depends on which CLIs the
// machine running it has signed into. No probe may spawn a process — these are pure fs/env reads.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyWorkerConfigRoot, signedInHeuristic } from '../src/api/seat-signin.js';

let home: string;
/** Empty env: no ambient GH_TOKEN/GITHUB_TOKEN from the machine running the suite leaks in. */
const NO_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'seat-signin-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function probe(seat: string, workerConfigRoot?: string): boolean | null {
  return signedInHeuristic(seat, workerConfigRoot, { home, env: NO_ENV });
}

describe('claude — worker-home .claude.json with oauthAccount', () => {
  const write = (dir: string, content: string): void => {
    mkdirSync(join(dir, 'claude'), { recursive: true });
    writeFileSync(join(dir, 'claude', '.claude.json'), content);
  };

  it('false when the worker home has no .claude.json at all', () => {
    expect(probe('claude')).toBe(false);
  });

  it('false when .claude.json exists but carries no oauthAccount (config written, never logged in)', () => {
    write(join(home, '.wicked-worker'), JSON.stringify({ theme: 'dark' }));
    expect(probe('claude')).toBe(false);
  });

  it('false when .claude.json is malformed JSON (never a throw)', () => {
    write(join(home, '.wicked-worker'), '{not json');
    expect(probe('claude')).toBe(false);
  });

  it('true when the DEFAULT worker home (<home>/.wicked-worker) carries an oauthAccount', () => {
    write(join(home, '.wicked-worker'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
    expect(probe('claude')).toBe(true);
  });

  it('honours an explicit workerConfigRoot over the default', () => {
    const custom = join(home, 'custom-root');
    write(custom, JSON.stringify({ oauthAccount: {} }));
    // Default home has nothing — only the custom root answers true.
    expect(probe('claude')).toBe(false);
    expect(probe('claude', custom)).toBe(true);
  });

  it('treats an EMPTY workerConfigRoot as "use the default"', () => {
    write(join(home, '.wicked-worker'), JSON.stringify({ oauthAccount: {} }));
    expect(probe('claude', '')).toBe(true);
  });
});

describe('codex — ~/.codex/auth.json presence', () => {
  it('false without the file, true with it', () => {
    expect(probe('codex')).toBe(false);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    expect(probe('codex')).toBe(true);
  });
});

describe('copilot — env token, else keychain-unknowable', () => {
  it.each(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])('true when %s is set', (key) => {
    expect(signedInHeuristic('copilot', undefined, { home, env: { [key]: 'tok' } })).toBe(true);
  });

  it('an EMPTY env token does not count as set', () => {
    expect(signedInHeuristic('copilot', undefined, { home, env: { GH_TOKEN: '' } })).toBe(false);
  });

  it('null (NOT false) when installed but no recorded user — the keychain state is unknowable cheaply', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'config.json'), '{}');
    expect(probe('copilot')).toBeNull();
  });

  it('TRUE when config.json records a logged-in user (JSONC with comment header, field shape)', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(
      join(home, '.copilot', 'config.json'),
      '// User settings belong in settings.json\n{"lastLoggedInUser": "octocat", "loggedInUsers": ["octocat"], "trustedFolders": []}',
    );
    expect(probe('copilot')).toBe(true);
  });

  it('an EMPTY loggedInUsers array does not count as signed in', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(
      join(home, '.copilot', 'config.json'),
      '{"loggedInUsers": [], "lastLoggedInUser": ""}',
    );
    expect(probe('copilot')).toBeNull();
  });

  it('TRUE when the recorded user is an OBJECT ({host, login}) — the live macOS shape', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(
      join(home, '.copilot', 'config.json'),
      '// comment\n{"loggedInUsers": [{"host": "github.com", "login": "octocat"}], "lastLoggedInUser": {"host": "github.com", "login": "octocat"}}',
    );
    expect(probe('copilot')).toBe(true);
  });

  it('an unrelated "login" string OUTSIDE the user containers does not count', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(
      join(home, '.copilot', 'config.json'),
      '{"someFeature": {"login": "banner-text"}, "loggedInUsers": [], "lastLoggedInUser": null}',
    );
    expect(probe('copilot')).toBeNull();
  });

  it('an array of EMPTY STRINGS does not count as signed in either', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(
      join(home, '.copilot', 'config.json'),
      '{"loggedInUsers": [""], "lastLoggedInUser": ""}',
    );
    expect(probe('copilot')).toBeNull();
  });

  it('false when there is no env token and no config dir at all', () => {
    expect(probe('copilot')).toBe(false);
  });
});

describe('opencode / pi — credential-file presence', () => {
  it('opencode: ~/.local/share/opencode/auth.json', () => {
    expect(probe('opencode')).toBe(false);
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), '{}');
    expect(probe('opencode')).toBe(true);
  });

  it('pi: ~/.pi/agent/auth.json', () => {
    expect(probe('pi')).toBe(false);
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'auth.json'), '{}');
    expect(probe('pi')).toBe(true);
  });
});

describe('agy — keyring-backed, json artifact upgrades to true', () => {
  it('null when ~/.antigravitycli is missing (keyring unknowable)', () => {
    expect(probe('agy')).toBeNull();
  });

  it('null when the dir exists but holds no .json (still unknowable, never false)', () => {
    mkdirSync(join(home, '.antigravitycli'), { recursive: true });
    writeFileSync(join(home, '.antigravitycli', 'notes.txt'), 'x');
    expect(probe('agy')).toBeNull();
  });

  it('true when any .json is present', () => {
    mkdirSync(join(home, '.antigravitycli'), { recursive: true });
    writeFileSync(join(home, '.antigravitycli', 'settings.json'), '{}');
    expect(probe('agy')).toBe(true);
  });
});

describe('unknown seats', () => {
  it('a seat this module has no rule for is exactly "unknown"', () => {
    expect(probe('mystery-cli')).toBeNull();
  });
});

describe('applyWorkerConfigRoot — the WICKED_WORKER_HOME env seam', () => {
  const saved = process.env['WICKED_WORKER_HOME'];

  afterEach(() => {
    if (saved === undefined) delete process.env['WICKED_WORKER_HOME'];
    else process.env['WICKED_WORKER_HOME'] = saved;
  });

  it('sets the env for a non-empty root', () => {
    applyWorkerConfigRoot('/srv/worker-homes');
    expect(process.env['WICKED_WORKER_HOME']).toBe('/srv/worker-homes');
  });

  it('deletes the env when unset (engine default ~/.wicked-worker)', () => {
    process.env['WICKED_WORKER_HOME'] = '/stale';
    applyWorkerConfigRoot(undefined);
    expect(process.env['WICKED_WORKER_HOME']).toBeUndefined();
  });

  it('treats "" as unset', () => {
    process.env['WICKED_WORKER_HOME'] = '/stale';
    applyWorkerConfigRoot('');
    expect(process.env['WICKED_WORKER_HOME']).toBeUndefined();
  });
});
