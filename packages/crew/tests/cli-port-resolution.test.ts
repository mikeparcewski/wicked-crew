// F-W1-101 (wave-1 gate P1 — FIX-IT-ALL L10, 0.7.36): `wicked-crew serve` honoured `CREW_PORT` but
// `status` / `gate` read only `--port` and fell back to 7701 — on a host whose daemon listens on
// `CREW_PORT=<other>`, `status` queried the DEFAULT port, found a stranger's daemon and exited 0
// reporting ANOTHER daemon's runs; `wicked-crew status --help` answered "Unknown command".
//
// ONE resolver (cli/port.ts) decides the port for the boot and for every daemon-client verb; this
// file pins (a) its table, (b) that cli/index.ts has NO other `CREW_PORT` read and uses the resolver
// at every port site, (c) the real dist CLI against two stub daemons — a STRANGER on port A and the
// right one on port B — never touching the real default port 7701, and (d) `--help` on a subcommand.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { DAEMON_PORT_ENV, DEFAULT_DAEMON_PORT, daemonPortSource, resolveDaemonPort } from '../src/cli/port.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'dist', 'cli', 'index.js');

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const [code] = (await once(proc, 'close')) as [number | null];
  return { code, stdout, stderr };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.close(); await once(s, 'close'); }
});

/** A stand-in daemon that answers `GET /api/v1/runs` with a body naming itself and counts its hits. */
async function stubDaemon(name: string): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: `run-of-${name}` }]));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

describe('resolveDaemonPort — the one place the daemon port is decided', () => {
  it('--port wins over CREW_PORT, CREW_PORT wins over the default, the default is 7701', () => {
    expect(resolveDaemonPort(['--port', '4242'], { [DAEMON_PORT_ENV]: '5151' })).toBe(4242);
    expect(resolveDaemonPort([], { [DAEMON_PORT_ENV]: '5151' })).toBe(5151);
    expect(resolveDaemonPort(['--run', 'r1'], {})).toBe(DEFAULT_DAEMON_PORT);
    expect(DEFAULT_DAEMON_PORT).toBe(7701);
    // serve's own semantics, unchanged: an EMPTY CREW_PORT is Number('') === 0 (an ephemeral listen port).
    expect(resolveDaemonPort([], { [DAEMON_PORT_ENV]: '' })).toBe(0);
    // The source names where the value came from — what error text prints instead of re-reading the env.
    expect(daemonPortSource(['--port', 'x'], { [DAEMON_PORT_ENV]: '5151' })).toEqual({ raw: 'x', from: '--port' });
    expect(daemonPortSource([], { [DAEMON_PORT_ENV]: '5151' })).toEqual({ raw: '5151', from: DAEMON_PORT_ENV });
    expect(daemonPortSource([], {})).toEqual({ raw: undefined, from: 'default' });
  });

  it('no src/cli module but port.ts reads CREW_PORT — directly or through DAEMON_PORT_ENV — and index.ts resolves every port through the resolver', () => {
    // review-L10-604 MED: a display-only `process.env[DAEMON_PORT_ENV]` slipped past a guard that
    // only knew the quoted spelling — so the guard matches the indirect spelling too, and every
    // module under src/cli/ except the resolver itself.
    const cliDir = join(HERE, '..', 'src', 'cli');
    const READ = /process\.env\s*\[\s*(['"]CREW_PORT['"]|DAEMON_PORT_ENV)\s*\]|process\.env\.CREW_PORT/g;
    const offenders: string[] = [];
    for (const f of readdirSync(cliDir)) {
      if (!f.endsWith('.ts') || f === 'port.ts') continue;
      const text = readFileSync(join(cliDir, f), 'utf8');
      for (const m of text.match(READ) ?? []) offenders.push(`${f}: ${m}`);
    }
    expect(offenders).toEqual([]);
    const src = readFileSync(join(cliDir, 'index.ts'), 'utf8');
    expect((src.match(/resolveDaemonPort\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // No verb keeps its own `?? 7701` / `: 7701` fallback: the default lives in one constant.
    expect(src.match(/[:?]\s*7701\b/g) ?? []).toEqual([]);
  });
});

describe('wicked-crew status against a daemon on CREW_PORT while a STRANGER sits on another port (F-W1-101)', () => {
  it('status with CREW_PORT set queries THAT daemon — the stranger on the other port is never contacted', async () => {
    const stranger = await stubDaemon('stranger');
    const mine = await stubDaemon('mine');
    const out = await cli(['status'], { [DAEMON_PORT_ENV]: String(mine.port) });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual([{ id: 'run-of-mine' }]);
    // Since F-W1-102 (fixall L4-⑧b) `status` makes TWO calls to the daemon it resolved: the runs
    // listing it prints, then `GET /health` — a daemon whose REQUIRED base skill is not handed
    // refuses every launch, and `status` says so on stderr. This test's subject is unchanged: both
    // calls go to THIS daemon and the stranger on the other port is never contacted.
    expect(mine.hits()).toBe(2);
    expect(stranger.hits()).toBe(0);
  });

  it('--port beats CREW_PORT, exactly as it does for serve', async () => {
    const stranger = await stubDaemon('stranger');
    const mine = await stubDaemon('mine');
    const out = await cli(['status', '--port', String(mine.port)], { [DAEMON_PORT_ENV]: String(stranger.port) });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([{ id: 'run-of-mine' }]);
    expect(stranger.hits()).toBe(0);
  });

  it('the no-daemon remedy names the port CREW_PORT resolved to', async () => {
    const probe = await stubDaemon('closed');
    const port = probe.port;
    servers.pop()!.close(); // free it: nothing listens there now
    const out = await cli(['status'], { [DAEMON_PORT_ENV]: String(port) });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`127.0.0.1:${port}`);
    expect(out.stderr).toMatch(/start it with `wicked-crew serve`/);
  });
});

describe('--help on a subcommand prints usage and exits 0 (F-W1-101)', () => {
  for (const verb of ['status', 'gate']) {
    it(`wicked-crew ${verb} --help`, async () => {
      const out = await cli([verb, '--help'], {});
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      expect(out.stdout).toMatch(new RegExp(`^Usage: wicked-crew ${verb} `));
      expect(out.stdout).toContain('CREW_PORT');
      expect(out.stdout).not.toContain('Unknown command');
    });
  }
  it('gate without --run prints the same usage on stderr and exits 1', async () => {
    const out = await cli(['gate'], {});
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^Usage: wicked-crew gate /);
  });
});
