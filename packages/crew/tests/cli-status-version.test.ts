// crew#551 / crew#493 (F-RC1-044, F-003) — FIX-IT-ALL L10-1: the two daemon-client verbs and
// `--version`, observed through the REAL dist CLI as a child process (the shape the operator and
// the smoke harness see — S10 `status` after SIGTERM, S09 `--version`).
//
//   - `status` / `gate` against a port nothing listens on → exit 1, ONE remedy line on stderr,
//     empty stdout, no stack frame (was: the whole `TypeError: fetch failed` through main().catch).
//   - a non-2xx answer → exit 1 with the status and the body (was: `status` printed the error body
//     as JSON and exited 0 — a script could not tell "daemon down" from "no runs").
//   - a 2xx answer → unchanged output, exit 0.
//   - `version` | `--version` | `-V` → three `<name> <version>` lines for THIS install, exit 0, no
//     daemon consulted (the closed `--port` is ignored).
//
// Like the other dist-CLI suites (governance-replay-cli, mcp-server) this needs `dist/` built — CI
// runs `build:with-studio` before `test`.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { versionLines } from '../src/core/versions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'dist', 'cli', 'index.js');
const CREW_VERSION = (
  JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8')) as { version: string }
).version;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<Outcome> {
  const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const [code] = (await once(proc, 'close')) as [number | null];
  return { code, stdout, stderr };
}

/** A port on which nothing listens (bound once to find it, then released). */
async function closedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.close();
    await once(s, 'close');
  }
});

/** A stand-in daemon that answers every request with `status` and `body`. */
async function stubDaemon(status: number, body: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** A stand-in daemon answering per path (the `status` verb reads `/runs`, then `/health`). */
async function stubDaemonRoutes(routes: Record<string, string>): Promise<number> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = routes[path];
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(body ?? '{"error":"not found"}');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

const STACK_FRAME = /^\s+at /m;

describe('wicked-crew status / gate with no daemon answering (crew#551)', () => {
  it('status → exit 1, one remedy line, empty stdout, no stack', async () => {
    const port = await closedPort();
    const out = await cli(['status', '--port', String(port)]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/start it with `wicked-crew serve`/);
    expect(out.stderr).toContain(`127.0.0.1:${port}`);
    expect(out.stderr).not.toMatch(STACK_FRAME);
    expect(out.stderr).not.toContain('fetch failed');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('gate → the same remedy, exit 1, no stack', async () => {
    const port = await closedPort();
    const out = await cli(['gate', '--run', 'r1', '--port', String(port)]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/start it with `wicked-crew serve`/);
    expect(out.stderr).not.toMatch(STACK_FRAME);
  });
});

describe('wicked-crew status / gate against an answering daemon', () => {
  it('status: a non-2xx answer exits 1 naming the verb, the status and the body (was: JSON, exit 0)', async () => {
    const port = await stubDaemon(500, '{"error":"boom"}');
    const out = await cli(['status', '--port', String(port)]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('wicked-crew: status failed: 500');
    expect(out.stderr).toContain('boom');
    expect(out.stderr).not.toMatch(STACK_FRAME);
  });

  it('gate: a non-2xx answer exits 1 naming the verb, the status and the body', async () => {
    const port = await stubDaemon(404, '{"error":"no such run"}');
    const out = await cli(['gate', '--run', 'r1', '--port', String(port)]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('wicked-crew: gate failed: 404');
    expect(out.stderr).toContain('no such run');
  });

  it('status: a daemon whose base skill is REQUIRED and not handed says so on stderr — the remedy names the installer; stdout stays the runs JSON; exit 0 (F-W1-102)', async () => {
    const message =
      'the base skill "wicked-garden-governed-worker" (baseSkillRef — the role-keyed discipline every governed unit follows) is REQUIRED but no published snapshot is handed to the engine: the engine refuses every launch at intake until a generation holding it is published — install wicked-garden (npx wicked-installer install wicked-garden), POST /skills/refresh-baseline, then POST /skills/publish; set baseSkillRef "" (PUT /settings) to turn the base skill off explicitly';
    const port = await stubDaemonRoutes({
      '/api/v1/runs': '[]',
      '/api/v1/health': JSON.stringify({
        status: 'ok',
        baseSkill: { name: 'wicked-garden-governed-worker', policy: 'require', present: false, inCatalog: false, gen: null, engineInput: 'wicked-garden-governed-worker', finding: { kind: 'skills.base-skill', severity: 'error', message } },
        warnings: [{ kind: 'skills.base-skill', severity: 'error', message }],
      }),
    });
    const out = await cli(['status', '--port', String(port)]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([]);
    expect(out.stderr.trim()).toBe(`wicked-crew: ${message}`);
    expect(out.stderr).toContain('npx wicked-installer install wicked-garden');
    expect(out.stderr).not.toMatch(STACK_FRAME);
  });

  it('status: a daemon whose base skill is handed (finding null) — or one too old to report a posture — prints nothing on stderr', async () => {
    const handed = await stubDaemonRoutes({ '/api/v1/runs': '[]', '/api/v1/health': JSON.stringify({ status: 'ok', baseSkill: { name: 'wicked-garden-governed-worker', present: true, finding: null } }) });
    const out = await cli(['status', '--port', String(handed)]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([]);
    expect(out.stderr).toBe('');
    const old = await stubDaemonRoutes({ '/api/v1/runs': '[]', '/api/v1/health': JSON.stringify({ status: 'ok' }) });
    const out2 = await cli(['status', '--port', String(old)]);
    expect(out2.code).toBe(0);
    expect(out2.stderr).toBe('');
  });

  it('status: a 2xx answer is printed as before and exits 0', async () => {
    const port = await stubDaemon(200, '[{"id":"r1"}]');
    const out = await cli(['status', '--port', String(port)]);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual([{ id: 'r1' }]);
  });
});

describe('wicked-crew version (crew#493)', () => {
  const LINES = [
    new RegExp(`^wicked-crew ${CREW_VERSION.replace(/\./g, '\\.')}$`),
    /^wicked-core-ts (\d+\.\d+\.\d+\S*|unknown)$/,
    /^wicked-studio (\S+|none)$/,
  ];

  for (const spelling of ['version', '--version', '-V']) {
    it(`${spelling} → three lines for THIS install, exit 0, no daemon consulted`, async () => {
      // A closed --port proves the answer never touched a socket: it would be the remedy otherwise.
      const port = await closedPort();
      const out = await cli([spelling, '--port', String(port)]);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      const lines = out.stdout.trimEnd().split('\n');
      expect(lines).toHaveLength(3);
      lines.forEach((line, i) => expect(line).toMatch(LINES[i]!));
    });
  }

  it('the unknown-command usage names `version` and points at the daemon diagnostics', async () => {
    const out = await cli(['frobnicate']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('|version');
    expect(out.stderr).toContain('/api/v1/diagnostics');
  });

  it('versionLines spells an absent engine binding `unknown` and an unbundled studio `none`', () => {
    expect(versionLines({ crew: '1.2.3', coreTs: null, studioBundle: null })).toEqual([
      'wicked-crew 1.2.3',
      'wicked-core-ts unknown',
      'wicked-studio none',
    ]);
    expect(versionLines({ crew: '1.2.3', coreTs: '0.7.25', studioBundle: '0.5.9' })).toEqual([
      'wicked-crew 1.2.3',
      'wicked-core-ts 0.7.25',
      'wicked-studio 0.5.9',
    ]);
  });
});
