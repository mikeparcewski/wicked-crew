// Unit tests for the estate-MCP proposal-queue client (DES-MEM-FACETED-001 §5.0).
//
// These run against a FAKE estate-mcp: a tiny CommonJS node script (written to a temp dir) that
// speaks the same newline-delimited JSON-RPC 2.0 framing as `wicked-estate-mcp` — it logs every
// frame it receives to a file (so the test can assert the exact handshake) and answers `tools/call`
// per a mode arg. The client's spawn seam is injected to run that script, so no real binary is
// needed. Mirrors the spawned-subprocess pattern in mcp-server.test.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callEstateProposalTool,
  EstateMcpError,
  estateMcpExe,
  resolveMemoryDbPath,
} from '../src/core/estate-mcp-client.js';
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

describe('callEstateProposalTool', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) removeScratch(d);
  });

  it('performs the initialize→initialized→tools/call handshake and returns the unwrapped tool result', async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const result = (await callEstateProposalTool(
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
      callEstateProposalTool('proposal.approve', { id: 'p1' }, { spawn: spawnFake(fx, 'rpcerror'), timeoutMs: 5000 }),
    ).rejects.toMatchObject({ name: 'EstateMcpError', code: -32603, message: 'boom from estate' });
  });

  it('rejects (EstateMcpError) when the server exits before answering', async () => {
    const fx = makeFixture();
    dirs.push(fx.dir);

    const err = await callEstateProposalTool(
      'proposal.reject',
      { id: 'p1' },
      { spawn: spawnFake(fx, 'exit'), timeoutMs: 5000 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EstateMcpError);
    expect((err as EstateMcpError).message).toMatch(/exited before answering proposal\.reject/);
  });
});

describe('resolveMemoryDbPath', () => {
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
});

describe('estateMcpExe', () => {
  it('defaults to wicked-estate-mcp', () => {
    expect(estateMcpExe({})).toBe('wicked-estate-mcp');
  });
  it('honors WICKED_ESTATE_MCP_EXE', () => {
    expect(estateMcpExe({ WICKED_ESTATE_MCP_EXE: '/bin/fake' })).toBe('/bin/fake');
  });
});
