/**
 * The person's container engine (CS9): search runs SearXNG in it, so research reaches the web only where one runs.
 * Docker, Podman and nerdctl (Rancher Desktop's containerd mode) are found on PATH and in their usual install
 * directories, and asked `info` with a deadline. None found is said plainly, with {@link NO_ENGINE_REASON}.
 *
 * crew runs every engine command with ITS OWN empty client config (docker and nerdctl: `DOCKER_CONFIG`; podman: an
 * empty `--authfile` on pull), so the pull of a public image is anonymous: no credential helper, keychain entry or
 * registry login of the person's is read or sent. Docker's current context endpoint is carried over as
 * `DOCKER_HOST`, so the engine the person uses is the one crew talks to.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { childEnvWithBootEstateDb } from '../../../core/governance-store.js';

export const NO_ENGINE_REASON = 'Research needs a container engine for web search: install Docker, Rancher Desktop or Podman';

export type EngineName = 'docker' | 'podman' | 'nerdctl';

const LABEL: Record<EngineName, string> = { docker: 'Docker', podman: 'Podman', nerdctl: 'Rancher Desktop (nerdctl)' };

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: readonly string[], opts: { env?: Record<string, string>; timeoutMs: number }) => Promise<ExecResult>;

/** The real exec: no shell, a deadline, output capped. */
export const execCommand: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    // (crew#495) The child never sees the daemon's exported governance store: its boot value, as every child crew spawns.
    execFile(cmd, [...args], { env: childEnvWithBootEstateDb(opts.env ?? process.env), timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Where an executable is: PATH first, then `extraDirs`; `null` = not found. */
export async function findExecutable(name: string, extraDirs: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const dirs = [...(env['PATH'] ?? '').split(delimiter).filter((d) => d !== ''), ...extraDirs];
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      try {
        await access(p, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return p;
      } catch {
        // next
      }
    }
  }
  return null;
}

/** The usual install directories of the three engines' CLIs. */
export function engineDirs(home: string = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [join(home, '.rd', 'bin'), 'C:\\Program Files\\Docker\\Docker\\resources\\bin', 'C:\\Program Files\\RedHat\\Podman'];
  return [join(home, '.rd', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/opt/podman/bin', '/usr/bin'];
}

export interface ContainerEngine {
  name: EngineName;
  label: string;
  cli: string;
  /** The env every command of this engine runs with (crew's own client config). */
  env: Record<string, string>;
  /** Arguments `pull` adds (podman: the empty auth file). */
  pullArgs: string[];
}

export type EngineDetection = { ok: true; engine: ContainerEngine } | { ok: false; reason: string; found: EngineName[] };

export interface EngineDeps {
  exec?: Exec;
  find?: (name: string) => Promise<string | null>;
  /** crew's own empty client-config directory (`<state home>/mcp/adapters/web/engine`). */
  configDir: string;
  env?: NodeJS.ProcessEnv;
}

const INFO_TIMEOUT_MS = 8_000;

function baseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  // The client configuration (and the registry logins in it) is crew's own; the endpoint is resolved below.
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(DOCKER_|REGISTRY_AUTH_FILE$)/.test(k)) out[k] = v;
  return out;
}

/** Find a running engine: docker, then podman, then nerdctl. */
export async function detectEngine(deps: EngineDeps): Promise<EngineDetection> {
  const exec = deps.exec ?? execCommand;
  const env = deps.env ?? process.env;
  const find = deps.find ?? ((n: string) => findExecutable(n, engineDirs(), env));
  await mkdir(deps.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(deps.configDir, 'config.json'), '{}\n', { mode: 0o600 });
  await writeFile(join(deps.configDir, 'auth.json'), '{}\n', { mode: 0o600 });
  const found: EngineName[] = [];
  for (const name of ['docker', 'podman', 'nerdctl'] as const) {
    const cli = await find(name);
    if (cli === null) continue;
    found.push(name);
    const e: Record<string, string> = { ...baseEnv(env) };
    if (name === 'docker') {
      // The endpoint the person selected, by Docker's own precedence: DOCKER_CONTEXT, then DOCKER_HOST, then the current
      // context (contexts are read with the person's own DOCKER_CONFIG, where they live). Then every command runs with
      // that endpoint and crew's empty client config.
      const explicitContext = (env['DOCKER_CONTEXT'] ?? '') !== '';
      let host = explicitContext ? '' : (env['DOCKER_HOST'] ?? '');
      if (host === '') {
        const ctx = await exec(cli, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env: Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined)), timeoutMs: INFO_TIMEOUT_MS });
        host = ctx.code === 0 ? ctx.stdout.trim() : '';
      }
      if (host !== '') e['DOCKER_HOST'] = host;
      for (const k of ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) if (env[k] !== undefined) e[k] = env[k] as string;
    }
    if (name === 'docker' || name === 'nerdctl') e['DOCKER_CONFIG'] = deps.configDir;
    const info = await exec(cli, ['info', '--format', '{{json .}}'], { env: e, timeoutMs: INFO_TIMEOUT_MS });
    if (info.code === 0) return { ok: true, engine: { name, label: LABEL[name], cli, env: e, pullArgs: name === 'podman' ? ['--authfile', join(deps.configDir, 'auth.json')] : [] } };
  }
  if (found.length === 0) return { ok: false, reason: NO_ENGINE_REASON, found };
  return { ok: false, reason: `Research needs a container engine for web search: ${found.map((n) => LABEL[n]).join(' or ')} is installed but not answering; start it`, found };
}
