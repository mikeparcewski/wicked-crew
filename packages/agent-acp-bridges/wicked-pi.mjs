#!/usr/bin/env node
/**
 * `wicked-pi` — the pi launcher that turns `WICKED_PI_SKILL_DIRS` into pi's skill flags (F-079,
 * wicked-crew#531; the env contract wicked-core#441 sets).
 *
 * Why a launcher and not a bridge: the pi seat's ACP carrier is the community `pi-acp` adapter,
 * which spawns `pi --mode rpc --no-themes` itself and forwards no argv of its own — but it does
 * let its host name the command it spawns as pi (`PI_ACP_PI_COMMAND`, passed the adapter's own
 * environment). wicked-crew's daemon points that variable here at boot (`bridge-path.ts`), so the
 * chain on a governed run is
 *
 *   wicked-core ──env WICKED_PI_SKILL_DIRS──▶ pi-acp ──PI_ACP_PI_COMMAND──▶ wicked-pi ──▶ pi
 *
 * and pi starts as `pi --no-skills --skill <dir>… --mode rpc --no-themes`: the snapshot's
 * deliverable portable skills, discovery of `~/.pi/agent/skills` OFF, exactly the argv the wrapped
 * carrier composes (`skills_snapshot.rs argv_flags`). With the variable unset this is a
 * transparent pass-through: `pi <args>` with the args untouched.
 *
 * Node cannot exec(2), so pi runs as a child with inherited stdio (pi-acp's RPC pipes pass
 * straight through, unbuffered); termination signals are forwarded and pi's exit status is
 * mirrored, so pi-acp's process management sees pi, not this shim.
 */

import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { piSkillFlags } from './bridge.mjs';

/** The pi executable this launcher runs — `WICKED_PI_BINARY` for a pinned path, else `pi` on PATH. */
export function piBinary(env = process.env) {
  const pinned = env['WICKED_PI_BINARY'];
  return typeof pinned === 'string' && pinned.trim() !== '' ? pinned.trim() : 'pi';
}

/**
 * The env contract for input governance on the pi seat (wicked-core#563). wicked-core sets it on
 * the ACP adapter's environment for a seat it governs; pi-acp passes its environment to this
 * launcher. Unset, empty or `0` means no gate. Any other value turns the gate on.
 */
export const PI_GOVERNANCE_ENV = 'WICKED_PI_GOVERNANCE';
/** An explicit path to the gate extension file, instead of the bundled `pi-governance` package. */
export const PI_GOVERNANCE_EXTENSION_ENV = 'WICKED_PI_GOVERNANCE_EXTENSION';

/** The bundled gate's file path, or `null` when the `pi-governance` package cannot be resolved. */
export function bundledGovernanceExtension() {
  try {
    return fileURLToPath(import.meta.resolve('pi-governance/extension'));
  } catch {
    return null;
  }
}

/**
 * pi's flags for the gate: `--no-extensions -e <gate>` when governance is on, so the gate is the
 * only extension loaded. Another extension's `tool_call` handler could change a call's
 * arguments after the gate approved it. Returns `[]` when governance is off.
 *
 * Throws when governance is on and no gate file can be found. The launcher then refuses to
 * start pi rather than start it ungoverned.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string | null} [resolveBundled]
 * @returns {string[]}
 */
export function piGovernanceFlags(env = process.env, resolveBundled = bundledGovernanceExtension) {
  const on = env[PI_GOVERNANCE_ENV];
  if (on === undefined || on.trim() === '' || on.trim() === '0') return [];
  const explicit = env[PI_GOVERNANCE_EXTENSION_ENV];
  const gate = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : resolveBundled();
  if (!gate) {
    throw new Error(
      `${PI_GOVERNANCE_ENV} is set but the pi-governance extension was not found (install the pi-governance package, or set ${PI_GOVERNANCE_EXTENSION_ENV})`,
    );
  }
  // Checked here because pi's own handling of an `-e` path it cannot load is not this launcher's
  // contract: a gate that is named but absent must stop the launch too.
  if (!existsSync(gate)) {
    throw new Error(`${PI_GOVERNANCE_ENV} is set but the pi-governance extension file does not exist: ${gate}`);
  }
  return ['--no-extensions', '-e', gate];
}

/**
 * The argv pi is started with: the governance flags, then the skill flags derived from the
 * environment, then every argument this launcher was given (pi-acp's `--mode rpc --no-themes`,
 * or an operator's own).
 *
 * @param {string[]} passthrough
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string | null} [resolveBundled]
 * @returns {string[]}
 */
export function composePiArgv(passthrough, env = process.env, resolveBundled = bundledGovernanceExtension) {
  return [...piGovernanceFlags(env, resolveBundled), ...piSkillFlags(env), ...passthrough];
}

/**
 * Windows runs npm-installed CLIs through `.cmd` shims, which `spawn` can only start via a shell;
 * a shell re-parses the command line, so every argument is double-quoted (with embedded quotes
 * escaped) before it is joined. POSIX spawns directly — no quoting, no shell.
 */
function spawnPi(bin, argv, env) {
  if (process.platform !== 'win32') return spawn(bin, argv, { stdio: 'inherit', env });
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  return spawn([bin, ...argv].map(quote).join(' '), { stdio: 'inherit', env, shell: true });
}

/** Run pi with the composed argv; resolve with the code this process should exit with. */
export function runPiLauncher(passthrough = process.argv.slice(2), env = process.env, resolveBundled = bundledGovernanceExtension) {
  return new Promise((resolve) => {
    const bin = piBinary(env);
    let argv;
    try {
      argv = composePiArgv(passthrough, env, resolveBundled);
    } catch (err) {
      console.error(`[wicked-pi] refusing to start pi: ${err?.message ?? String(err)}`);
      resolve(126);
      return;
    }
    let child;
    try {
      child = spawnPi(bin, argv, env);
    } catch (err) {
      console.error(`[wicked-pi] could not start ${bin}: ${err?.message ?? String(err)}`);
      resolve(127);
      return;
    }
    const forward = (signal) => () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP'].map((sig) => {
      const h = forward(sig);
      process.on(sig, h);
      return [sig, h];
    });
    const done = (code) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      resolve(code);
    };
    child.on('error', (err) => {
      console.error(`[wicked-pi] could not start ${bin}: ${err?.code === 'ENOENT' ? 'executable not found on PATH (install @earendil-works/pi-coding-agent, or set WICKED_PI_BINARY)' : err.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => {
      // A signal-killed pi is reported the way a shell would: 128 + the signal number.
      if (code !== null) done(code);
      else done(128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1));
    });
  });
}

/**
 * `true` when this file is the script node was started with (the bin path, through the npm shim —
 * which reaches it via the workspace symlink, so both sides are realpath'd); `false` when it is
 * imported (the tests import the pure functions above and must not start pi).
 */
function invokedDirectly() {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await runPiLauncher();
}
