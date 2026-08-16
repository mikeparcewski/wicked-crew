// Seat sign-in presence (seat sign-in): does each council seat LOOK signed in?
//
// The doctrine mirrors seat health (crew#274): auth state is RUNTIME state the platform observes
// and displays, never config an operator hand-edits. The studio surfaces every seat's auth
// uniformly — `signed_in` says what the daemon can OBSERVE, and the seat's `login_invocation`
// (engine roster passthrough, wicked-core PR#278) is what the studio runs in a PTY terminal
// (`POST /terminals`) to fix it.
//
// This module is a HEURISTIC, deliberately cheap:
//
// - File/env PRESENCE only — no process is ever spawned (the roster route calls this per seat
//   per request; a spawn here would be a fork bomb with a UI attached).
// - Three-valued: `true`/`false` when the observable half of the seat's auth state answers,
//   `null` when it is unknowable cheaply. Keychain-backed credentials are the canonical `null`:
//   a file can prove a login HAPPENED, but its absence proves nothing when the secret lives in
//   the OS keychain — and `false` would send an operator to re-login a working seat.
// - `true` is "a credential artifact exists", NOT "the credential still works". An expired
//   OAuth token reads `true` here; seat HEALTH (crew#274) is what catches it failing live.
//
// Per-seat rules (each documented at its branch):
//   claude    — the WORKER config home's `.claude.json` (per-config-dir keychain entry means the
//               file is the observable half; see below), under `WICKED_WORKER_HOME`/the default.
//   codex     — `~/.codex/auth.json` presence.
//   copilot   — env token (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN) → true; installed but no
//               env → null (keychain state unknowable cheaply — NOT false); no trace → false.
//   opencode  — `~/.local/share/opencode/auth.json` presence.
//   pi        — `~/.pi/agent/auth.json` presence.
//   agy       — any `.json` under `~/.antigravitycli/` → true; else null (keyring unknowable).
//   unknown   — null (a seat this module has no rule for is exactly "unknown").

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Injectable IO for tests: `home` replaces `os.homedir()` and `env` replaces `process.env`,
 * so fixture dirs built with `mkdtemp` exercise every branch without touching the developer's
 * real dotfiles. Production callers omit it.
 */
export interface SigninProbeIo {
  home?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Cheap signed-in presence for one seat. `workerConfigRoot` is the settings-applied
 * `WICKED_WORKER_HOME` value when set (the roster route passes the live env, which is exactly
 * what the engine will read at the next spawn); omitted = the engine default `~/.wicked-worker`.
 *
 * Never throws: an unreadable file or dir is treated as the corresponding "not observable"
 * answer for that seat's rule, never a 500 on the roster route.
 */
export function signedInHeuristic(
  seatKey: string,
  workerConfigRoot?: string,
  io: SigninProbeIo = {},
): boolean | null {
  const home = io.home ?? homedir();
  const env = io.env ?? process.env;

  switch (seatKey) {
    case 'claude': {
      // The engine places the claude WORKER home at `<root>/claude` (acp_runner.rs
      // claude_worker_home; root = WICKED_WORKER_HOME or ~/.wicked-worker). Claude keeps the
      // OAuth token itself in a PER-CONFIG-DIR keychain entry, so the token is not observable —
      // but `/login` also writes an `oauthAccount` block into that dir's `.claude.json`, which
      // is: present-with-key means a login completed for the WORKER home (not the operator's
      // own ~/.claude). Heuristic by construction — a revoked token still reads true.
      const root = workerConfigRoot !== undefined && workerConfigRoot !== ''
        ? workerConfigRoot
        : join(home, '.wicked-worker');
      const file = join(root, 'claude', '.claude.json');
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && 'oauthAccount' in parsed;
      } catch {
        return false; // missing / unreadable / malformed: no completed login is observable
      }
    }

    case 'codex':
      // `codex login` writes ~/.codex/auth.json (tokens live IN the file — presence is the state).
      return existsSync(join(home, '.codex', 'auth.json'));

    case 'copilot': {
      // Env token wins: copilot honors these directly, and a set token IS a signed-in seat.
      for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        const v = env[key];
        if (typeof v === 'string' && v !== '') return true;
      }
      // Installed (config exists) but no env: `copilot login` stores the credential in the OS
      // keychain, which this module will not open — unknowable cheaply is `null`, NOT `false`.
      if (existsSync(join(home, '.copilot', 'config.json'))) return null;
      return false; // no env, no config dir: nothing suggests this seat ever signed in
    }

    case 'opencode':
      // `opencode auth login` writes the credential file itself — presence is the state.
      return existsSync(join(home, '.local', 'share', 'opencode', 'auth.json'));

    case 'pi':
      // pi's auth flow writes ~/.pi/agent/auth.json — presence is the state.
      return existsSync(join(home, '.pi', 'agent', 'auth.json'));

    case 'agy': {
      // Antigravity keeps its credential in the OS keyring; a `.json` in ~/.antigravitycli/ is
      // the observable artifact a completed login leaves behind. Missing dir OR dir-with-no-json
      // both mean the keyring state is unknowable cheaply → null (only a json upgrades to true).
      let entries: string[];
      try {
        entries = readdirSync(join(home, '.antigravitycli'));
      } catch {
        return null;
      }
      return entries.some((f) => f.endsWith('.json')) ? true : null;
    }

    default:
      return null; // a seat with no rule here is exactly "unknown"
  }
}

/**
 * Apply the persisted `worker_config_root` setting to THIS process's environment. The engine
 * reads `WICKED_WORKER_HOME` per worker spawn (acp_runner.rs — never cached at engine start),
 * so calling this at daemon boot and again on every settings change is sufficient: the next
 * spawn sees the new root with no daemon or engine restart. `settings.json` is the source of
 * truth — unset/empty DELETES the env, restoring the engine default `~/.wicked-worker`.
 */
export function applyWorkerConfigRoot(root: string | undefined): void {
  if (typeof root === 'string' && root !== '') {
    process.env['WICKED_WORKER_HOME'] = root;
  } else {
    delete process.env['WICKED_WORKER_HOME'];
  }
}
