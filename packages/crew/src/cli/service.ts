// `wicked-crew serve --install-service` / `--uninstall-service` — crew#551 (F-RC1-044).
//
// A hand-started daemon dies with the machine, and after a reboot the product is simply down. This
// registers the daemon as a per-user login service so it comes back on its own:
//   - macOS: a LaunchAgent (`~/Library/LaunchAgents/com.wickedagile.wicked-crew.plist`), RunAtLoad +
//     KeepAlive, loaded with `launchctl bootstrap gui/<uid>`.
//   - Linux: a systemd user unit (`~/.config/systemd/user/wicked-crew.service`), Restart=on-failure,
//     enabled with `systemctl --user enable --now`.
//   - anything else: the recipe is printed, nothing is automated.
//
// The service environment is captured ONCE at install time from an allowlist — a service manager
// starts the daemon with a near-empty environment, and the daemon's worker fence for a non-default
// Claude config dir is derived from ITS OWN `CLAUDE_CONFIG_DIR` (core#403), so that variable must
// travel with the service. Secrets (names carrying TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL) are NEVER
// written into the unit file: they are named in the install output, not persisted.
//
// Pure renderers + one installer with an injectable command runner, so the unit text and the
// command sequence are unit-tested without touching the host's service manager.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { childEnvWithBootEstateDb } from '../core/governance-store.js';

export const SERVICE_LABEL = 'com.wickedagile.wicked-crew';
export const SYSTEMD_UNIT_NAME = 'wicked-crew.service';
export const INSTALL_SERVICE_FLAG = '--install-service';
export const UNINSTALL_SERVICE_FLAG = '--uninstall-service';

export type ServicePlatform = 'darwin' | 'linux' | 'other';

export function servicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  return platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : 'other';
}

/** Where the unit file lives for this platform, or `null` where nothing is automated. */
export function serviceUnitPath(platform: ServicePlatform, home: string = homedir()): string | null {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (platform === 'linux') return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
  return null;
}

/** Exact names carried into the service environment (besides the `WICKED_*` prefix). */
const ENV_ALLOW = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  // core#403: the daemon derives the worker fence for the operator's Claude config dir from its own
  // CLAUDE_CONFIG_DIR — without it a service-managed daemon stops fencing a non-default dir.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CREW_PORT',
  // The deliver push identity pin (crew#549 / F-RC1-010) — an account NAME, not a credential.
  'GH_ACCOUNT',
]);
const SECRET_NAME = /TOKEN|SECRET|PASS|KEY|CREDENTIAL|BEARER|COOKIE|SESSION/i;
/** A value carrying a credential in URL userinfo (`postgres://user:pass@host/db`). */
const SECRET_VALUE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i;

export interface CapturedEnv {
  env: Record<string, string>;
  /** Names that would have been carried but look like secrets — reported, never written. */
  omitted: string[];
}

/** The service environment: the allowlist + every `WICKED_*` variable, minus anything secret-shaped. */
export function captureServiceEnv(source: NodeJS.ProcessEnv = process.env): CapturedEnv {
  const env: Record<string, string> = {};
  const omitted: string[] = [];
  for (const name of Object.keys(source).sort()) {
    const value = source[name];
    if (value === undefined) continue;
    const wanted = ENV_ALLOW.has(name) || name.startsWith('WICKED_');
    if (SECRET_NAME.test(name) || (wanted && SECRET_VALUE.test(value))) {
      if (wanted || name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') omitted.push(name);
      continue;
    }
    if (wanted) env[name] = value;
  }
  return { env, omitted };
}

export interface ServiceSpec {
  /** Absolute argv: the node binary, the CLI entry, `serve`, and the forwarded serve options. */
  program: string[];
  env: Record<string, string>;
  /** stdout + stderr of the daemon. */
  logPath: string;
  workingDir: string;
}

/** The serve options the service re-runs with: argv minus the two service flags. */
export function forwardedServeArgs(argv: string[]): string[] {
  return argv.filter((a) => a !== INSTALL_SERVICE_FLAG && a !== UNINSTALL_SERVICE_FLAG);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function renderPlist(spec: ServiceSpec): string {
  const args = spec.program.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    env,
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(spec.workingDir)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    // No `ProcessType: Background`: launchd throttles a Background job's disk I/O, and on a busy
    // host the daemon then took minutes to open its own module files. The default (Standard) is right.
    '  <key>StandardOutPath</key>',
    `  <string>${xml(spec.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(spec.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** A systemd-quoted word: double quotes, `\` and `"` escaped, `%` doubled (specifier escape). */
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  return [
    '[Unit]',
    'Description=wicked-crew daemon (governed agent runs + the studio console)',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${spec.program.map(sdQuote).join(' ')}`,
    `WorkingDirectory=${sdQuote(spec.workingDir)}`,
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    // `append:` takes the rest of the line as the path (no quoting); `%` is a specifier, so doubled.
    `StandardOutput=append:${spec.logPath.replace(/%/g, '%%')}`,
    `StandardError=append:${spec.logPath.replace(/%/g, '%%')}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The daemon log an installed unit writes to — read back from the unit text (`status` names it). */
export function logPathFromUnit(text: string): string | null {
  const plist = /<key>StandardErrorPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  if (plist?.[1] !== undefined) {
    return plist[1].replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  }
  const unit = /^StandardError=append:(.+)$/m.exec(text);
  return unit?.[1]?.replace(/%%/g, '%') ?? null;
}

/** An installed service on this host: its unit path and the log it writes, or `null`. */
export function installedService(
  platform: ServicePlatform = servicePlatform(),
  home: string = homedir(),
): { unitPath: string; logPath: string | null } | null {
  const unitPath = serviceUnitPath(platform, home);
  if (unitPath === null || !existsSync(unitPath)) return null;
  let text = '';
  try {
    text = readFileSync(unitPath, 'utf8');
  } catch {
    /* unreadable unit: still installed */
  }
  return { unitPath, logPath: logPathFromUnit(text) };
}

/** Printed where nothing is automated (Windows): a Task Scheduler recipe for the same command. */
export function windowsRecipe(spec: ServiceSpec): string {
  const cmd = spec.program.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return [
    'wicked-crew: a login service is not automated on this platform. Register it with Task Scheduler:',
    `  schtasks /Create /SC ONLOGON /TN wicked-crew /TR "${cmd.replace(/"/g, '\\"')}" /RL LIMITED`,
    'and set the same environment variables for your user first (setx NAME value).',
  ].join('\n');
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

export const runCommand: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: childEnvWithBootEstateDb(process.env) });
  return { status: r.error ? 127 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
};

export interface ServiceDeps {
  platform: ServicePlatform;
  home: string;
  uid: number;
  run: CommandRunner;
  /** A process already listening on the daemon port (`null` = nothing answering). */
  portHolder: () => Promise<{ pid: number | null } | null>;
  log: (line: string) => void;
}

export interface InstallInput {
  /** The CLI entry the service runs (`process.argv[1]`). */
  cliPath: string;
  nodePath: string;
  serveArgs: string[];
  env: NodeJS.ProcessEnv;
  /** The daemon's state home (the `--db` parent or `~/.wicked-crew`) — the log lands there. */
  stateHome: string;
  port: number;
}

/**
 * The node binary the unit names. `process.execPath` is the resolved binary (Homebrew:
 * `/opt/homebrew/Cellar/node/<version>/bin/node`), which a node upgrade deletes. When a `node` on
 * the captured PATH resolves to that same binary, name the PATH entry instead (the stable symlink).
 */
export function stableNodePath(execPath: string, path: string | undefined): string {
  let target = execPath;
  try {
    target = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'node');
    try {
      if (realpathSync(candidate) === target) return candidate;
    } catch {
      /* not here */
    }
  }
  return execPath;
}

/** `0` on success, `1` on a refusal or a failed service-manager call (the reason is logged). */
export async function installService(input: InstallInput, deps: ServiceDeps): Promise<number> {
  const unitPath = serviceUnitPath(deps.platform, deps.home);
  let cli = input.cliPath;
  try {
    cli = realpathSync(input.cliPath);
  } catch {
    /* keep as given */
  }
  if (/[\\/]_npx[\\/]/.test(cli)) {
    deps.log(
      'wicked-crew: refusing to install a login service that runs from the npx cache (it is not durable). ' +
        'Install crew first — `npm install -g wicked-crew` — then run `wicked-crew serve --install-service`.',
    );
    return 1;
  }
  const { env, omitted } = captureServiceEnv(input.env);
  const nodePath = stableNodePath(input.nodePath, env['PATH']);
  const logPath = join(input.stateHome, 'daemon-stdout.log');
  const spec: ServiceSpec = {
    program: [nodePath, cli, 'serve', ...forwardedServeArgs(input.serveArgs)],
    env,
    logPath,
    workingDir: deps.home,
  };
  if (unitPath === null) {
    deps.log(windowsRecipe(spec));
    return 0;
  }
  const alreadyInstalled = existsSync(unitPath);
  // Never touch a hand-started daemon on the same port: refuse and name its pid.
  const holder = await deps.portHolder();
  // Only the installed service's own process may hold the port (a re-install reloads it). Anything
  // else (a hand-started daemon, another program) is refused, named by pid, and left alone.
  if (holder !== null) {
    const servicePid = alreadyInstalled ? runningServicePid(deps) : null;
    const isService = servicePid !== null && (holder.pid === null || holder.pid === servicePid);
    if (!isService) {
      const who = holder.pid !== null ? `pid ${holder.pid}` : 'a process lsof could not name';
      deps.log(
        `wicked-crew: 127.0.0.1:${input.port} is already held by ${who}, which is not the login service. ` +
          'Stop it first (a hand-started daemon: its terminal, or `kill <pid>`), then run `wicked-crew serve --install-service` again.',
      );
      return 1;
    }
  }
  mkdirSync(dirname(unitPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const text = deps.platform === 'darwin' ? renderPlist(spec) : renderSystemdUnit(spec);
  writeFileSync(unitPath, text, { mode: 0o600 });

  const steps: Array<[string, string[], boolean]> =
    deps.platform === 'darwin'
      ? [
          // An installed agent is reloaded (bootout tolerates "not loaded").
          ...(alreadyInstalled ? [['launchctl', ['bootout', `gui/${deps.uid}/${SERVICE_LABEL}`], false] as [string, string[], boolean]] : []),
          ['launchctl', ['bootstrap', `gui/${deps.uid}`, unitPath], true],
        ]
      : [
          ['systemctl', ['--user', 'daemon-reload'], true],
          ['systemctl', ['--user', 'enable', SYSTEMD_UNIT_NAME], true],
          ['systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME], true],
        ];
  for (const [cmd, args, required] of steps) {
    const r = deps.run(cmd, args);
    if (required && r.status !== 0) {
      deps.log(`wicked-crew: \`${cmd} ${args.join(' ')}\` failed (exit ${r.status ?? 'signal'}): ${(r.stderr || r.stdout).trim()}`);
      deps.log(`The unit file is at ${unitPath}; remove it with \`wicked-crew serve --uninstall-service\`.`);
      return 1;
    }
  }
  deps.log(`wicked-crew: login service installed — ${unitPath}`);
  deps.log(`  runs: ${spec.program.join(' ')}`);
  deps.log(`  log:  ${logPath}`);
  deps.log(`  env:  ${Object.keys(env).join(', ') || '(none)'}`);
  if (omitted.length > 0) {
    deps.log(
      `  not written to the unit (secret-shaped): ${omitted.join(', ')} — the service runs without them` +
        (omitted.includes('GH_TOKEN')
          ? `; the deliver phase pushes with gh's keyring login${env['GH_ACCOUNT'] !== undefined ? ', checked against GH_ACCOUNT' : ''}`
          : ''),
    );
  }
  if (deps.platform === 'linux') {
    deps.log('  to start it at boot without a login session: `loginctl enable-linger $USER`');
  }
  deps.log('The daemon is starting; `wicked-crew status` answers once it is up.');
  return 0;
}

/** The pid of the loaded service's running process, or `null` (not loaded, not running, unknown). */
export function runningServicePid(deps: Pick<ServiceDeps, 'platform' | 'uid' | 'run'>): number | null {
  if (deps.platform === 'darwin') {
    const r = deps.run('launchctl', ['print', `gui/${deps.uid}/${SERVICE_LABEL}`]);
    const m = r.status === 0 ? /^\s*pid = (\d+)$/m.exec(r.stdout) : null;
    return m?.[1] !== undefined ? Number(m[1]) : null;
  }
  if (deps.platform === 'linux') {
    const r = deps.run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT_NAME]);
    const pid = Number(r.stdout.trim());
    return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

export function uninstallService(deps: Pick<ServiceDeps, 'platform' | 'home' | 'uid' | 'run' | 'log'>): number {
  const unitPath = serviceUnitPath(deps.platform, deps.home);
  if (unitPath === null) {
    deps.log('wicked-crew: no login service is automated on this platform (remove the Task Scheduler task by hand).');
    return 0;
  }
  if (!existsSync(unitPath)) {
    deps.log(`wicked-crew: no login service installed (${unitPath} does not exist).`);
    return 0;
  }
  if (deps.platform === 'darwin') {
    deps.run('launchctl', ['bootout', `gui/${deps.uid}/${SERVICE_LABEL}`]);
    unlinkSync(unitPath);
  } else {
    deps.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
    unlinkSync(unitPath);
    deps.run('systemctl', ['--user', 'daemon-reload']);
  }
  deps.log(`wicked-crew: login service removed (${unitPath}); the daemon it ran is stopped.`);
  return 0;
}

/** The pid listening on a TCP port (lsof; best-effort, `null` when unknown). */
export function listeningPid(port: number, run: CommandRunner = runCommand): number | null {
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number((r.stdout.trim().split('\n')[0] ?? '').trim());
  return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}
