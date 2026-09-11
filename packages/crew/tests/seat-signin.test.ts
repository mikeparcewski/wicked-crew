// Seat sign-in presence probes (seat sign-in) — the file/env heuristic, branch by branch.
//
// Every test runs against a FIXTURE home built with mkdtemp and an injected env (SigninProbeIo),
// so the suite never reads the developer's real dotfiles and never depends on which CLIs the
// machine running it has signed into. No probe may spawn a process — these are pure fs/env reads.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyWorkerConfigRoot, BOOT_WORKER_HOME, signedInHeuristic } from '../src/api/seat-signin.js';

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

/** The probe under the operator's inherit hatch: the seats run on the operator's own CLI homes. */
function probeInherit(seat: string): boolean | null {
  return signedInHeuristic(seat, undefined, {
    home,
    env: { WICKED_WORKER_INHERIT_OPERATOR_CONFIG: '1' },
  });
}

/** `<home>/.wicked-worker/<seat>` — the engine's default per-seat root (wicked-core#410). */
function seatRoot(seat: string, ...rest: string[]): string {
  return join(home, '.wicked-worker', seat, ...rest);
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
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

// wicked-core#410 (F-010): every known seat is probed under ITS OWN root in the worker home — the
// directory the engine now points the CLI at (`CODEX_HOME`, `PI_CODING_AGENT_DIR`, `COPILOT_HOME`,
// opencode's XDG bases) — never the operator's own CLI home. The finding: a fresh worker home
// reported claude `signed_in:false` but codex/pi/copilot/opencode `true`, off the OPERATOR's logins.
describe('codex — <worker home>/codex/auth.json presence (CODEX_HOME)', () => {
  it('false without the file, true with it — and the OPERATOR\'s ~/.codex/auth.json does not count', () => {
    writeFile(join(home, '.codex', 'auth.json'), '{}');
    expect(probe('codex')).toBe(false);
    writeFile(seatRoot('codex', 'auth.json'), '{}');
    expect(probe('codex')).toBe(true);
  });

  it('honours an explicit workerConfigRoot', () => {
    const custom = join(home, 'custom-root');
    writeFile(join(custom, 'codex', 'auth.json'), '{}');
    expect(probe('codex')).toBe(false);
    expect(probe('codex', custom)).toBe(true);
  });

  it('under the inherit hatch the seat runs on the operator\'s ~/.codex, so that is what is probed', () => {
    expect(probeInherit('codex')).toBe(false);
    writeFile(join(home, '.codex', 'auth.json'), '{}');
    expect(probeInherit('codex')).toBe(true);
  });
});

describe('copilot — env token, else keychain-unknowable', () => {
  it.each(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])('true when %s is set', (key) => {
    expect(signedInHeuristic('copilot', undefined, { home, env: { [key]: 'tok' } })).toBe(true);
  });

  it('an EMPTY env token does not count as set', () => {
    expect(signedInHeuristic('copilot', undefined, { home, env: { GH_TOKEN: '' } })).toBe(false);
  });

  // The seat's config home is `COPILOT_HOME=<worker home>/copilot` (wicked-core#410).
  const copilotConfig = (): string => seatRoot('copilot', 'config.json');

  it('null (NOT false) when installed but no recorded user — the keychain state is unknowable cheaply', () => {
    writeFile(copilotConfig(), '{}');
    expect(probe('copilot')).toBeNull();
  });

  it('TRUE when config.json records a logged-in user (JSONC with comment header, field shape)', () => {
    writeFile(
      copilotConfig(),
      '// User settings belong in settings.json\n{"lastLoggedInUser": "octocat", "loggedInUsers": ["octocat"], "trustedFolders": []}',
    );
    expect(probe('copilot')).toBe(true);
  });

  it('an EMPTY loggedInUsers array does not count as signed in', () => {
    writeFile(copilotConfig(), '{"loggedInUsers": [], "lastLoggedInUser": ""}');
    expect(probe('copilot')).toBeNull();
  });

  it('TRUE when the recorded user is an OBJECT ({host, login}) — the live macOS shape', () => {
    writeFile(
      copilotConfig(),
      '// comment\n{"loggedInUsers": [{"host": "github.com", "login": "octocat"}], "lastLoggedInUser": {"host": "github.com", "login": "octocat"}}',
    );
    expect(probe('copilot')).toBe(true);
  });

  it('an unrelated "login" string OUTSIDE the user containers does not count', () => {
    writeFile(
      copilotConfig(),
      '{"someFeature": {"login": "banner-text"}, "loggedInUsers": [], "lastLoggedInUser": null}',
    );
    expect(probe('copilot')).toBeNull();
  });

  it('an array of EMPTY STRINGS does not count as signed in either', () => {
    writeFile(copilotConfig(), '{"loggedInUsers": [""], "lastLoggedInUser": ""}');
    expect(probe('copilot')).toBeNull();
  });

  it('false when there is no env token and no config dir at all', () => {
    expect(probe('copilot')).toBe(false);
  });

  it('the OPERATOR\'s ~/.copilot/config.json does not count for the seat — unless the inherit hatch is set', () => {
    writeFile(join(home, '.copilot', 'config.json'), '{"lastLoggedInUser": "octocat"}');
    expect(probe('copilot')).toBe(false);
    expect(probeInherit('copilot')).toBe(true);
  });
});

describe('opencode / pi — credential-file presence under their seat roots', () => {
  it('opencode: <worker home>/opencode/data/opencode/auth.json (XDG_DATA_HOME=<root>/opencode/data)', () => {
    writeFile(join(home, '.local', 'share', 'opencode', 'auth.json'), '{}');
    expect(probe('opencode')).toBe(false);
    writeFile(seatRoot('opencode', 'data', 'opencode', 'auth.json'), '{}');
    expect(probe('opencode')).toBe(true);
    // Under the hatch the operator's own store is the seat's.
    expect(probeInherit('opencode')).toBe(true);
  });

  it('pi: <worker home>/pi/auth.json (PI_CODING_AGENT_DIR=<root>/pi)', () => {
    writeFile(join(home, '.pi', 'agent', 'auth.json'), '{}');
    expect(probe('pi')).toBe(false);
    writeFile(seatRoot('pi', 'auth.json'), '{}');
    expect(probe('pi')).toBe(true);
    expect(probeInherit('pi')).toBe(true);
  });

  it('an explicit workerConfigRoot relocates every seat root together', () => {
    const custom = join(home, 'elsewhere');
    writeFile(join(custom, 'pi', 'auth.json'), '{}');
    writeFile(join(custom, 'opencode', 'data', 'opencode', 'auth.json'), '{}');
    expect(probe('pi', custom)).toBe(true);
    expect(probe('opencode', custom)).toBe(true);
    expect(probe('pi')).toBe(false);
    expect(probe('opencode')).toBe(false);
  });
});

describe('agy — keyring-backed, json artifact upgrades to true', () => {
  it('null when ~/.gemini is missing (keyring unknowable)', () => {
    expect(probe('agy')).toBeNull();
  });

  it('null when the dir exists but holds no .json (still unknowable, never false)', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'notes.txt'), 'x');
    expect(probe('agy')).toBeNull();
  });

  it('true when any .json is present', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), '{}');
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

  it('unset restores the env this process booted with, never a stale override (crew#396)', () => {
    // Under the suite the boot value IS the hermetic arming (tests/setup/hermetic-home.ts), so
    // this is also the proof that a settings-driven unset cannot reopen the real ~/.wicked-worker.
    expect(BOOT_WORKER_HOME).toBeDefined();
    process.env['WICKED_WORKER_HOME'] = '/stale';
    applyWorkerConfigRoot(undefined);
    expect(process.env['WICKED_WORKER_HOME']).toBe(BOOT_WORKER_HOME);
  });

  it('treats "" as unset', () => {
    process.env['WICKED_WORKER_HOME'] = '/stale';
    applyWorkerConfigRoot('');
    expect(process.env['WICKED_WORKER_HOME']).toBe(BOOT_WORKER_HOME);
  });

  it('deletes the env when the process booted without one (engine default ~/.wicked-worker)', () => {
    process.env['WICKED_WORKER_HOME'] = '/stale';
    // '' is the no-boot-value fallback: an EXPLICIT `undefined` would re-select the default
    // parameter (BOOT_WORKER_HOME) — JS default-parameter semantics, not an override.
    applyWorkerConfigRoot(undefined, '');
    expect(process.env['WICKED_WORKER_HOME']).toBeUndefined();
  });
});
