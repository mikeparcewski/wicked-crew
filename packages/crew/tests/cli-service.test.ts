// crew#551 (F-RC1-044) — the daemon as a login service, and a `status` that says what to do.
//
//   - `serve --install-service` renders a LaunchAgent (macOS) / systemd user unit (Linux) that runs
//     `wicked-crew serve` with the forwarded options, RunAtLoad+KeepAlive / Restart=on-failure, the
//     daemon log under the state home, and an env captured from an allowlist — CLAUDE_CONFIG_DIR
//     included (core#403: the worker fence for a non-default config dir is derived from the
//     daemon's own env), tokens never written.
//   - it refuses while a hand-started daemon holds the port, naming the pid.
//   - `status` with no daemon: exit 1, one line, naming `--install-service`; with the service
//     installed but the daemon down, the one line names the service log instead.
//
// The CLI half spawns the REAL dist CLI (CI runs `build:with-studio` before `test`) with a fake HOME.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureServiceEnv,
  forwardedServeArgs,
  installService,
  installedService,
  logPathFromUnit,
  renderPlist,
  renderSystemdUnit,
  serviceUnitPath,
  stableNodePath,
  uninstallService,
  type CommandRunner,
  type ServiceDeps,
  type ServiceSpec,
} from '../src/cli/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'dist', 'cli', 'index.js');

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'crew-svc-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC: ServiceSpec = {
  program: ['/usr/local/bin/node', '/opt/crew/dist/cli/index.js', 'serve', '--port', '7702'],
  env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/srv/op/alt & co/.claude', WICKED_X: '100%' },
  logPath: '/srv/op/100% crew/daemon-stdout.log',
  workingDir: '/srv/op',
};

describe('captureServiceEnv', () => {
  it('keeps the allowlist + WICKED_*, carries CLAUDE_CONFIG_DIR (core#403), and never writes a secret', () => {
    const { env, omitted } = captureServiceEnv({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CONFIG_DIR: '/h/alt/.claude',
      CLAUDE_CODE_SESSION_ID: 'x',
      GH_ACCOUNT: 'someone',
      GH_TOKEN: 'secret',
      WICKED_WORKER_HOME: '/h/.wicked-worker',
      WICKED_CREW_TOKEN: 'bearer',
      WICKED_BEARER: 'b',
      WICKED_ESTATE_DB: 'postgres://u:pw@db/gov',
      WICKED_SESSION_COOKIE: 'c',
      CREW_PORT: '7702',
      RANDOM: 'no',
    });
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: '/h/alt/.claude',
      CREW_PORT: '7702',
      GH_ACCOUNT: 'someone',
      HOME: '/h',
      PATH: '/bin',
      WICKED_WORKER_HOME: '/h/.wicked-worker',
    });
    expect(omitted).toEqual(['GH_TOKEN', 'WICKED_BEARER', 'WICKED_CREW_TOKEN', 'WICKED_ESTATE_DB', 'WICKED_SESSION_COOKIE']);
  });

  it('forwards the serve options minus the service flags', () => {
    expect(forwardedServeArgs(['--port', '7702', '--install-service', '--db', '/d/core.db'])).toEqual(['--port', '7702', '--db', '/d/core.db']);
  });
});

describe('stableNodePath', () => {
  it('names the PATH symlink that resolves to the running binary, not the versioned target', () => {
    const d = tmpHome();
    const cellar = join(d, 'Cellar', 'node', '26.0.0', 'bin');
    const bin = join(d, 'bin');
    mkdirSync(cellar, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(cellar, 'node'), '');
    symlinkSync(join(cellar, 'node'), join(bin, 'node'));
    expect(stableNodePath(join(cellar, 'node'), `/nowhere:${bin}`)).toBe(join(bin, 'node'));
    expect(stableNodePath(join(cellar, 'node'), '/nowhere')).toBe(join(cellar, 'node'));
  });
});

describe('unit rendering', () => {
  it('plist: label, argv, escaped env, RunAtLoad + KeepAlive, log path — and the log reads back', () => {
    const text = renderPlist(SPEC);
    expect(text).toContain('<string>com.wickedagile.wicked-crew</string>');
    expect(text).toContain('<string>/opt/crew/dist/cli/index.js</string>\n    <string>serve</string>');
    expect(text).toContain('<key>CLAUDE_CONFIG_DIR</key>\n    <string>/srv/op/alt &amp; co/.claude</string>');
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    // Background would have launchd throttle the daemon's disk I/O (a live boot took minutes).
    expect(text).not.toContain('ProcessType');
    expect(logPathFromUnit(text)).toBe(SPEC.logPath);
  });

  it('systemd: quoted ExecStart, escaped Environment, Restart=on-failure, default.target — and the log reads back', () => {
    const text = renderSystemdUnit(SPEC);
    expect(text).toContain('ExecStart="/usr/local/bin/node" "/opt/crew/dist/cli/index.js" "serve" "--port" "7702"');
    expect(text).toContain('Environment="CLAUDE_CONFIG_DIR=/srv/op/alt & co/.claude"');
    expect(text).toContain('Environment="WICKED_X=100%%"');
    expect(text).toContain('StandardError=append:/srv/op/100%% crew/daemon-stdout.log');
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('WantedBy=default.target');
    expect(logPathFromUnit(text)).toBe(SPEC.logPath);
  });
});

function fakeDeps(platform: 'darwin' | 'linux', home: string, holder: { pid: number | null } | null = null, servicePid: number | null = null) {
  const calls: string[] = [];
  const lines: string[] = [];
  const run: CommandRunner = (cmd, args) => {
    // `launchctl print` is a read (is the service's process the one on the port?) — not recorded.
    if (cmd === 'launchctl' && args[0] === 'print') {
      return servicePid === null ? { status: 113, stdout: '', stderr: 'Could not find service' } : { status: 0, stdout: `\tstate = running\n\tpid = ${servicePid}\n`, stderr: '' };
    }
    calls.push([cmd, ...args].join(' '));
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps: ServiceDeps = { platform, home, uid: 501, run, portHolder: async () => holder, log: (l) => lines.push(l) };
  return { deps, calls, lines };
}

const INPUT = (home: string) => ({
  cliPath: '/opt/crew/dist/cli/index.js',
  nodePath: '/usr/local/bin/node',
  serveArgs: ['--install-service', '--port', '7702'],
  env: { PATH: '/bin', CLAUDE_CONFIG_DIR: join(home, 'alt', '.claude'), GH_TOKEN: 'secret' },
  stateHome: join(home, '.wicked-crew'),
  port: 7702,
});

describe('installService / uninstallService', () => {
  it('macOS: writes a 0600 LaunchAgent and bootstraps it; the token is named, not written', async () => {
    const home = tmpHome();
    const { deps, calls, lines } = fakeDeps('darwin', home);
    expect(await installService(INPUT(home), deps)).toBe(0);
    const unit = serviceUnitPath('darwin', home)!;
    const text = readFileSync(unit, 'utf8');
    expect(statSync(unit).mode & 0o777).toBe(0o600);
    expect(text).toContain(join(home, 'alt', '.claude'));
    expect(text).not.toContain('secret');
    expect(text).toContain('<string>--port</string>\n    <string>7702</string>');
    expect(text).not.toContain('--install-service');
    expect(calls).toEqual([`launchctl bootstrap gui/501 ${unit}`]);
    expect(lines.join('\n')).toContain('GH_TOKEN');
    expect(installedService('darwin', home)).toEqual({ unitPath: unit, logPath: join(home, '.wicked-crew', 'daemon-stdout.log') });
  });

  it('macOS: re-install boots the loaded agent out first (so kickstart/reload picks up the new unit)', async () => {
    const home = tmpHome();
    const unit = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'old');
    // The daemon answering on the port IS the installed service (same pid) — not a refusal.
    const { deps, calls } = fakeDeps('darwin', home, { pid: 42 }, 42);
    expect(await installService(INPUT(home), deps)).toBe(0);
    expect(calls).toEqual([`launchctl bootout gui/501/com.wickedagile.wicked-crew`, `launchctl bootstrap gui/501 ${unit}`]);
  });

  it('refuses while a hand-started daemon holds the port, naming its pid; writes nothing', async () => {
    const home = tmpHome();
    const { deps, calls, lines } = fakeDeps('darwin', home, { pid: 4242 });
    expect(await installService(INPUT(home), deps)).toBe(1);
    expect(lines.join('\n')).toContain('pid 4242');
    expect(calls).toEqual([]);
    expect(existsSync(serviceUnitPath('darwin', home)!)).toBe(false);
  });

  it('refuses a re-install while a DIFFERENT process holds the port (the service is not the holder)', async () => {
    const home = tmpHome();
    const unit = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'old');
    const { deps, calls, lines } = fakeDeps('darwin', home, { pid: 4242 }, 42);
    expect(await installService(INPUT(home), deps)).toBe(1);
    expect(lines.join('\n')).toContain('pid 4242');
    expect(calls).toEqual([]);
    expect(readFileSync(unit, 'utf8')).toBe('old');
  });

  it('refuses to install a service that runs from the npx cache', async () => {
    const home = tmpHome();
    const { deps, lines } = fakeDeps('darwin', home);
    expect(await installService({ ...INPUT(home), cliPath: '/h/.npm/_npx/abc/node_modules/wicked-crew/dist/cli/index.js' }, deps)).toBe(1);
    expect(lines.join('\n')).toContain('npm install -g wicked-crew');
  });

  it('Linux: writes the user unit, reloads, enables and (re)starts it; prints the linger hint', async () => {
    const home = tmpHome();
    const { deps, calls, lines } = fakeDeps('linux', home);
    expect(await installService(INPUT(home), deps)).toBe(0);
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'wicked-crew.service'))).toBe(true);
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable wicked-crew.service',
      'systemctl --user restart wicked-crew.service',
    ]);
    expect(lines.join('\n')).toContain('loginctl enable-linger');
  });

  it('a failed service-manager call exits 1 with its stderr', async () => {
    const home = tmpHome();
    const { deps, lines } = fakeDeps('darwin', home);
    deps.run = () => ({ status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' });
    expect(await installService(INPUT(home), deps)).toBe(1);
    expect(lines.join('\n')).toContain('Bootstrap failed');
  });

  it('uninstall: boots out and removes the unit; no unit is a no-op', async () => {
    const home = tmpHome();
    const { deps, calls } = fakeDeps('darwin', home);
    await installService(INPUT(home), deps);
    calls.length = 0;
    expect(uninstallService(deps)).toBe(0);
    expect(calls).toEqual(['launchctl bootout gui/501/com.wickedagile.wicked-crew']);
    expect(existsSync(serviceUnitPath('darwin', home)!)).toBe(false);
    expect(uninstallService(deps)).toBe(0);
  });
});

// ── the real CLI ──────────────────────────────────────────────────────────────────────────────

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const [code] = (await once(proc, 'close')) as [number | null];
  return { code, stdout, stderr };
}

async function closedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

describe('wicked-crew CLI (crew#551)', () => {
  it('serve --help documents --install-service and --uninstall-service', async () => {
    const out = await cli(['serve', '--help'], process.env);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('--install-service');
    expect(out.stdout).toContain('--uninstall-service');
  });

  it('status, no daemon, no service: exit 1, one line naming serve AND --install-service', async () => {
    const home = tmpHome();
    const port = await closedPort();
    const out = await cli(['status', '--port', String(port)], { ...process.env, HOME: home });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toContain('`wicked-crew serve --install-service`');
    expect(out.stderr).not.toMatch(/^\s+at /m);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'status, service installed but the daemon down: exit 1, one line naming the service log',
    async () => {
      const home = tmpHome();
      const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
      const unit = serviceUnitPath(platform, home)!;
      mkdirSync(dirname(unit), { recursive: true });
      const log = join(home, '.wicked-crew', 'daemon-stdout.log');
      writeFileSync(unit, (platform === 'darwin' ? renderPlist : renderSystemdUnit)({ ...SPEC, logPath: log }));
      const port = await closedPort();
      const out = await cli(['status', '--port', String(port)], { ...process.env, HOME: home });
      expect(out.code).toBe(1);
      expect(out.stderr.trim().split('\n')).toHaveLength(1);
      expect(out.stderr).toContain('the login service is installed but the daemon is not up');
      expect(out.stderr).toContain(log);
    },
  );
});
