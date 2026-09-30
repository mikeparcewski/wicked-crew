// Unit tests for the estate-MCP proposal-queue client (DES-MEM-FACETED-001 §5.0).
//
// These run against a FAKE estate-mcp: a tiny CommonJS node script (written to a temp dir) that
// speaks the same newline-delimited JSON-RPC 2.0 framing as `wicked-estate-mcp` — it logs every
// frame it receives to a file (so the test can assert the exact handshake) and answers `tools/call`
// per a mode arg. The client's spawn seam is injected to run that script, so no real binary is
// needed. Mirrors the spawned-subprocess pattern in mcp-server.test.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callEstateTool,
  EstateMcpError,
  estateMcpExe,
  memoryStoreIsolationNotice,
  resolveMemoryDb,
  sameDirectory,
  resolveMemoryDbPath,
} from '../src/core/estate-mcp-client.js';
import { defaultStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

// A fake estate-mcp server. argv: [logPath, mode]. Modes: 'ok' (mcp result), 'rpcerror' (JSON-RPC
// error), 'exit' (die on tools/call without answering). Logs every received frame as NDJSON.
const FAKE_SERVER = `
const fs = require('fs');
const readline = require('readline');
const [, , logPath, mode] = process.argv;
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (t === '') return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  fs.appendFileSync(logPath, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'wicked-estate', version: 'fake' } } });
    return;
  }
  if (msg.method === 'tools/call') {
    if (mode === 'exit') { process.exit(0); return; }
    if (mode === 'rpcerror') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom from estate' } });
      process.exit(0);
      return;
    }
    // mode 'ok': echo an MCP tool-result envelope carrying a JSON string, like the real server.
    const payload = { proposals: [
      { id: 'p1', kind_type: 'memory', payload: { content: 'x' }, facets: { cli: 'codex' },
        provenance: {}, state: 'pending', created_at: 1 },
    ], _echo: { name: msg.params && msg.params.name, arguments: msg.params && msg.params.arguments } };
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } });
    process.exit(0);
    return;
  }
  // notifications/initialized and anything else: no response.
});
`;

interface Fixture {
  scriptPath: string;
  logPath: string;
  dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'estate-mcp-fake-'));
  const scriptPath = join(dir, 'fake-estate-mcp.cjs');
  const logPath = join(dir, 'frames.ndjson');
  writeFileSync(scriptPath, FAKE_SERVER);
  writeFileSync(logPath, '');
  return { scriptPath, logPath, dir };
}

function spawnFake(fx: Fixture, mode: 'ok' | 'rpcerror' | 'exit'): () => ChildProcess {
  return () =>
    spawn(process.execPath, [fx.scriptPath, fx.logPath, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function readFrames(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('callEstateTool', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) removeScratch(d);
  });

  it('performs the initialize→initialized→tools/call handshake and returns the unwrapped tool result', async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const result = (await callEstateTool(
      'proposal.list',
      { kind_type: 'memory', state: 'pending' },
      { spawn: spawnFake(fx, 'ok'), timeoutMs: 5000 },
    )) as { proposals: unknown[]; _echo: { name: string; arguments: unknown } };

    // The MCP tool-result envelope was unwrapped (result.content[0].text → parsed JSON).
    expect(Array.isArray(result.proposals)).toBe(true);
    expect((result.proposals[0] as { id: string }).id).toBe('p1');
    // The tool name + arguments reached the server verbatim.
    expect(result._echo.name).toBe('proposal.list');
    expect(result._echo.arguments).toEqual({ kind_type: 'memory', state: 'pending' });

    // The handshake was exactly initialize → notifications/initialized → tools/call.
    const frames = readFrames(fx.logPath);
    expect(frames).toHaveLength(3);

    const init = frames[0]!;
    expect(init['method']).toBe('initialize');
    const initParams = init['params'] as { protocolVersion: string; clientInfo: { name: string; version: unknown } };
    expect(initParams.protocolVersion).toBe('2024-11-05');
    expect(initParams.clientInfo.name).toBe('wicked-crew');
    expect(typeof initParams.clientInfo.version).toBe('string');

    const initialized = frames[1]!;
    expect(initialized['method']).toBe('notifications/initialized');
    expect(initialized['id']).toBeUndefined(); // a notification carries no id

    const call = frames[2]!;
    expect(call['method']).toBe('tools/call');
    expect(call['params']).toEqual({ name: 'proposal.list', arguments: { kind_type: 'memory', state: 'pending' } });
  });

  it('surfaces a JSON-RPC error from the tool call as EstateMcpError (with the code)', async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    await expect(
      callEstateTool('proposal.approve', { id: 'p1' }, { spawn: spawnFake(fx, 'rpcerror'), timeoutMs: 5000 }),
    ).rejects.toMatchObject({ name: 'EstateMcpError', code: -32603, message: 'boom from estate' });
  });

  it('rejects (EstateMcpError) when the server exits before answering', async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const err = await callEstateTool(
      'proposal.reject',
      { id: 'p1' },
      { spawn: spawnFake(fx, 'exit'), timeoutMs: 5000 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EstateMcpError);
    expect((err as EstateMcpError).message).toMatch(/exited before answering proposal\.reject/);
  });
});

describe('resolveMemoryDbPath', () => {
  const scratch: string[] = [];
  afterEach(() => {
    setCrewStateHome(undefined);
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('honors WICKED_MEMORY_DB when set', () => {
    expect(resolveMemoryDbPath({ WICKED_MEMORY_DB: '/custom/mem.db' })).toBe('/custom/mem.db');
  });
  it('falls back to ${WICKED_HOME}/memory.db', () => {
    expect(resolveMemoryDbPath({ WICKED_HOME: '/opt/wk' })).toBe(join('/opt/wk', 'memory.db'));
  });
  it('defaults to ~/.wicked/memory.db when neither is set', () => {
    const p = resolveMemoryDbPath({});
    expect(p.endsWith(join('.wicked', 'memory.db'))).toBe(true);
  });

  // ── F5 (ship-proof C7) — THE MEMORY STORE FOLLOWS `--db` LIKE EVERY OTHER STORE ──────────────
  //
  // A brand-new state home on a free port (`--db <scratch>/core.db`) showed 596 of the operator's
  // real memories on Steering → Memories, and a Retire click there would have erased a row from
  // their store. Every other durable store resolves through `crewStateHome()`; memory resolved
  // from `homedir()` unconditionally — the crew#330/#351/#353 escape, a fourth time.
  //
  // The DEFAULT state home deliberately keeps `~/.wicked/memory.db`: that file is not crew's
  // private store, it is the operator's global one — the estate MCP's own default and what
  // garden's `mem` skills read. Moving the default daemon off it would split a single-state-home
  // user's memories from their own CLI. So isolation is keyed on "is this the default daemon".
  it('an ISOLATED state home gets its OWN memory store — two state homes never share one', () => {
    setCrewStateHome('/scratch/rig-a');
    const a = resolveMemoryDbPath({});
    setCrewStateHome('/scratch/rig-b');
    const b = resolveMemoryDbPath({});

    // Under `mcp/`, not the top level: the top level of the state home is core's embedded Read-fence
    // registry, and an unregistered top-level `memory.db` would refuse every governed run at intake
    // on the released engine — worse than the defect, and exactly on these state homes.
    expect(a).toBe(join('/scratch/rig-a', 'mcp', 'memory.db'));
    expect(b).toBe(join('/scratch/rig-b', 'mcp', 'memory.db'));
    expect(a).not.toBe(b);
    // The C7 signature: both resolved to the operator's host-global store.
    for (const p of [a, b]) expect(p.endsWith(join('.wicked', 'memory.db'))).toBe(false);
    // And the path is INSIDE the state home — a registered, worker-denied subtree of it.
    for (const [home, p] of [['/scratch/rig-a', a], ['/scratch/rig-b', b]] as const) {
      expect(p.startsWith(join(home, 'mcp'))).toBe(true);
    }
  });

  it('an isolated state home ignores WICKED_HOME — that names the GLOBAL store, not this daemon', () => {
    setCrewStateHome('/scratch/rig-a');
    expect(resolveMemoryDbPath({ WICKED_HOME: '/opt/wk' })).toBe(join('/scratch/rig-a', 'mcp', 'memory.db'));
  });

  it('WICKED_MEMORY_DB still outranks the state home — the explicit instruction is the specific one', () => {
    setCrewStateHome('/scratch/rig-a');
    expect(resolveMemoryDbPath({ WICKED_MEMORY_DB: '/custom/mem.db' })).toBe('/custom/mem.db');
  });

  // codex review of this PR, MEDIUM: an operator who has always run ONE daemon on a CUSTOM --db
  // lands on the isolated arm and sees an empty store. Nothing distinguishes them from a throwaway
  // test daemon, so there is no signal to adopt the global store on — and adopting it is the
  // defect. The choice is: isolate, and SAY SO, once.
  it('an isolated daemon with no store of its own NAMES the global store it is not reading', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-f5-'));
    scratch.push(root);
    const stateHome = join(root, 'state-home');
    const globalHome = join(root, 'global');
    mkdirSync(join(stateHome, 'mcp'), { recursive: true });
    mkdirSync(globalHome, { recursive: true });
    writeFileSync(join(globalHome, 'memory.db'), 'SQLite format 3\0');
    setCrewStateHome(stateHome);

    expect(resolveMemoryDb({ WICKED_HOME: globalHome })).toEqual({
      path: join(stateHome, 'mcp', 'memory.db'),
      source: 'state-home',
    });
    const notice = memoryStoreIsolationNotice({ WICKED_HOME: globalHome });
    expect(notice).not.toBeNull();
    expect(notice).toContain(join(stateHome, 'mcp', 'memory.db'));
    expect(notice).toContain(join(globalHome, 'memory.db'));
    expect(notice).toContain('no run of this daemon can see or retire those memories');
    expect(notice).toContain(`WICKED_MEMORY_DB=${join(globalHome, 'memory.db')}`);

    // Nothing to say once this daemon has a store of its own …
    writeFileSync(join(stateHome, 'mcp', 'memory.db'), 'SQLite format 3\0');
    expect(memoryStoreIsolationNotice({ WICKED_HOME: globalHome })).toBeNull();
    // … nor when the operator named a store explicitly …
    rmSync(join(stateHome, 'mcp', 'memory.db'));
    expect(memoryStoreIsolationNotice({ WICKED_HOME: globalHome, WICKED_MEMORY_DB: '/x/mem.db' })).toBeNull();
    // … nor when there is no global store to have been using.
    rmSync(join(globalHome, 'memory.db'));
    expect(memoryStoreIsolationNotice({ WICKED_HOME: globalHome })).toBeNull();
    // … nor on the default daemon, which reads the global store.
    setCrewStateHome(undefined);
    expect(memoryStoreIsolationNotice({ WICKED_HOME: globalHome })).toBeNull();
  });

  // "is this the default daemon" is decided by `sameDirectory`. A lexical compare called a
  // symlinked home, a differently-cased spelling on a case-insensitive filesystem and a Windows
  // junction ISOLATED, and handed the daemon an empty store (codex review, MEDIUM). Tested on
  // scratch directories rather than on the real `~/.wicked-crew`: a test must not write into HOME.
  it('sameDirectory follows a symlink and a spelling — the default-daemon test that decides it', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-f5-'));
    scratch.push(root);
    const real = join(root, 'real-state-home');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'alias');
    symlinkSync(real, link, 'dir');

    expect(sameDirectory(link, real)).toBe(true);
    expect(sameDirectory(join(root, 'alias', '.', ''), real)).toBe(true);
    expect(sameDirectory(join(real, '..', 'real-state-home'), real)).toBe(true);
    expect(sameDirectory(join(root, 'other'), real)).toBe(false);
    // Neither side exists: a lexical answer, and still the right one.
    expect(sameDirectory(join(root, 'ghost', '.'), join(root, 'ghost'))).toBe(true);
    expect(sameDirectory(join(root, 'ghost'), join(root, 'phantom'))).toBe(false);
  });

  it('the DEFAULT state home keeps the operator global store — a single-state-home user loses nothing', () => {
    setCrewStateHome(defaultStateHome(homedir()));
    expect(resolveMemoryDbPath({})).toBe(join(homedir(), '.wicked', 'memory.db'));
    // A relative/unnormalised spelling of the same directory is the same daemon.
    setCrewStateHome(join(homedir(), '.wicked-crew', '.', ''));
    expect(resolveMemoryDbPath({})).toBe(join(homedir(), '.wicked', 'memory.db'));
  });
});

describe('estateMcpExe', () => {
  it('defaults to wicked-estate-mcp', () => {
    expect(estateMcpExe({})).toBe('wicked-estate-mcp');
  });
  it('honors WICKED_ESTATE_MCP_EXE', () => {
    expect(estateMcpExe({ WICKED_ESTATE_MCP_EXE: '/bin/fake' })).toBe('/bin/fake');
  });
});
