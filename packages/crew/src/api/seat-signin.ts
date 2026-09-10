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
// Per-seat rules (each documented at its branch). EVERY known seat is probed under its OWN root
// in the worker home (wicked-core#410, F-010: the engine now runs codex/pi/copilot/opencode seats
// under `<worker home>/<seat>` through the CLI's own configuration-home variable, exactly as claude
// runs under `<worker home>/claude`) — so the roster says whether the SEAT is signed in, never
// whether the operator is. The layout mirrors `wicked_apps_core::spawn::seat_config_for`:
//   claude    — `<root>/claude/.claude.json` with an `oauthAccount` (per-config-dir keychain entry
//               means the file is the observable half; see below).
//   codex     — `<root>/codex/auth.json` (`CODEX_HOME=<root>/codex`).
//   copilot   — env token (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN) → true; else
//               `<root>/copilot/config.json` (`COPILOT_HOME`) recording a logged-in user → true;
//               installed but no user → null (keychain state unknowable cheaply — NOT false);
//               no trace → false.
//   opencode  — `<root>/opencode/data/opencode/auth.json` (`XDG_DATA_HOME=<root>/opencode/data`).
//   pi        — `<root>/pi/auth.json` (`PI_CODING_AGENT_DIR=<root>/pi`).
//   agy       — any `.json` under `~/.antigravitycli/` → true; else null (keyring unknowable; no
//               configuration-home variable is known for agy, so it runs where the operator does).
//   unknown   — null (a seat this module has no rule for is exactly "unknown").
// Under the operator's inherit hatch (`WICKED_WORKER_INHERIT_OPERATOR_CONFIG` set in the daemon's
// env) every seat runs on the operator's OWN configuration, so the probes read the CLIs' default
// homes instead (`~/.codex`, `~/.pi/agent`, `~/.copilot`, `~/.local/share/opencode`, `~/.claude`).

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
  // The one hatch every engine spawn honours (wicked_apps_core::spawn::INHERIT_OPERATOR_CONFIG_ENV):
  // set, the seats run on the operator's own CLI homes and so does this probe.
  const inherit = env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG'] !== undefined;
  // The worker home base the engine resolves (`WICKED_WORKER_HOME`, else `~/.wicked-worker`);
  // each seat's root is `<base>/<seat>`.
  const root = workerConfigRoot !== undefined && workerConfigRoot !== ''
    ? workerConfigRoot
    : join(home, '.wicked-worker');

  switch (seatKey) {
    case 'claude': {
      // The engine places the claude WORKER home at `<root>/claude` (acp_runner.rs
      // claude_worker_home; root = WICKED_WORKER_HOME or ~/.wicked-worker). Claude keeps the
      // OAuth token itself in a PER-CONFIG-DIR keychain entry, so the token is not observable —
      // but `/login` also writes an `oauthAccount` block into that dir's `.claude.json`, which
      // is: present-with-key means a login completed for the WORKER home (not the operator's
      // own ~/.claude). Heuristic by construction — a revoked token still reads true.
      const file = inherit ? join(home, '.claude', '.claude.json') : join(root, 'claude', '.claude.json');
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && 'oauthAccount' in parsed;
      } catch {
        return false; // missing / unreadable / malformed: no completed login is observable
      }
    }

    case 'codex':
      // `codex login` writes `$CODEX_HOME/auth.json` (tokens live IN the file — presence is the
      // state); the seat's CODEX_HOME is `<root>/codex` (wicked-core#410).
      return existsSync(
        inherit ? join(home, '.codex', 'auth.json') : join(root, 'codex', 'auth.json'),
      );

    case 'copilot': {
      // Env token wins: copilot honors these directly, and a set token IS a signed-in seat.
      for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        const v = env[key];
        if (typeof v === 'string' && v !== '') return true;
      }
      // `copilot login` stores the TOKEN in the OS keychain, but it also records the logged-in
      // USER in config.json (`lastLoggedInUser` / `loggedInUsers`) — verified in the field: a
      // successful sign-in left the chip on null-neutral and the Sign in button up, reading as
      // "didn't work". The file is JSONC (comment header), so this parses key-presence
      // leniently rather than JSON.parse-ing the whole document. The seat's config home is
      // `COPILOT_HOME=<root>/copilot` (wicked-core#410); the keychain entry itself is per-user.
      const cfg = inherit
        ? join(home, '.copilot', 'config.json')
        : join(root, 'copilot', 'config.json');
      if (existsSync(cfg)) {
        try {
          const raw = readFileSync(cfg, 'utf8');
          // A non-empty STRING user, or an array whose first entry is a non-empty string —
          // `[""]` must not read as signed in (Copilot, PR#282).
          // Both shapes seen in the field: a plain string user, OR an OBJECT user
          // ({host, login} — the live config on macOS). A non-empty "login" string inside
          // either container is the common observable.
          if (
            /"lastLoggedInUser"\s*:\s*"[^"]+"/.test(raw) ||
            /"loggedInUsers"\s*:\s*\[\s*"[^"]+"/.test(raw) ||
            // Object shapes, SCOPED to the user containers (an unrelated "login" string
            // elsewhere in the config must not read as signed in — Copilot, PR#283).
            /"lastLoggedInUser"\s*:\s*\{[^}]*"login"\s*:\s*"[^"]+"/.test(raw) ||
            /"loggedInUsers"\s*:\s*\[\s*\{[^}]*"login"\s*:\s*"[^"]+"/.test(raw)
          ) {
            return true;
          }
        } catch {
          /* unreadable config falls through to null */
        }
        // Installed but no recorded user and no env: the keychain half stays unknowable.
        return null;
      }
      return false; // no env, no config dir: nothing suggests this seat ever signed in
    }

    case 'opencode':
      // `opencode auth login` writes `$XDG_DATA_HOME/opencode/auth.json` — presence is the state;
      // the seat's XDG_DATA_HOME is `<root>/opencode/data` (wicked-core#410).
      return existsSync(
        inherit
          ? join(home, '.local', 'share', 'opencode', 'auth.json')
          : join(root, 'opencode', 'data', 'opencode', 'auth.json'),
      );

    case 'pi':
      // pi's auth flow writes `$PI_CODING_AGENT_DIR/auth.json` — presence is the state; the
      // seat's agent dir is `<root>/pi` (wicked-core#410).
      return existsSync(
        inherit ? join(home, '.pi', 'agent', 'auth.json') : join(root, 'pi', 'auth.json'),
      );

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
 * The `WICKED_WORKER_HOME` this process BOOTED with — captured at module load, before any
 * settings application can rewrite it. This is what an unset/empty `worker_config_root` restores:
 * an operator who exported the variable before starting the daemon keeps their choice (the engine
 * would have honoured it had crew never touched the env), and the test harness's hermetic arming
 * (tests/setup/hermetic-home.ts, crew#396) survives every `createServer` boot over an empty
 * settings store — the unconditional delete this replaces re-aimed every subsequent worker spawn
 * at the operator's REAL `~/.wicked-worker`.
 */
export const BOOT_WORKER_HOME: string | undefined = process.env['WICKED_WORKER_HOME'];

/**
 * Apply the persisted `worker_config_root` setting to THIS process's environment. The engine
 * reads `WICKED_WORKER_HOME` per worker spawn (acp_runner.rs — never cached at engine start),
 * so calling this at daemon boot and again on every settings change is sufficient: the next
 * spawn sees the new root with no daemon or engine restart. `settings.json` is the source of
 * truth when it names a root; unset/empty restores the env this process booted with
 * (`BOOT_WORKER_HOME`), falling back to deleting the variable (engine default
 * `~/.wicked-worker`) when the process booted without one.
 *
 * `fallback` exists so a unit test can exercise the booted-without-one branch in a process whose
 * baseline is armed; production callers never pass it. Pass `''` for "booted without one" — an
 * explicit `undefined` re-selects the default parameter (JS semantics), it does not override it.
 */
export function applyWorkerConfigRoot(
  root: string | undefined,
  fallback: string | undefined = BOOT_WORKER_HOME,
): void {
  if (typeof root === 'string' && root !== '') {
    process.env['WICKED_WORKER_HOME'] = root;
  } else if (typeof fallback === 'string' && fallback !== '') {
    process.env['WICKED_WORKER_HOME'] = fallback;
  } else {
    delete process.env['WICKED_WORKER_HOME'];
  }
}
