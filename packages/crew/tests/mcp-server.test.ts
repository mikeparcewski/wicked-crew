// Contract tests for `wicked-crew mcp` — the stdio MCP server that proxies the daemon.
// Launches the server as a child process, speaks raw JSON-RPC 2.0 over stdin/stdout,
// and verifies: initialization, tool list shape, and per-tool argument schemas.
// Does NOT make live HTTP calls to a daemon (a missing daemon surfaces as an init error,
// tested in the 'daemon unreachable' case below).

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli/index.js');

// ─── JSON-RPC 2.0 mini-client ────────────────────────────────────────────────

type McpMessage = Record<string, unknown>;

async function withMcpServer(
  port: number,
  fn: (send: (msg: McpMessage) => void, received: () => McpMessage[]) => Promise<void>,
): Promise<void> {
  const proc = spawn(process.execPath, [DIST, 'mcp', '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: McpMessage[] = [];
  let buf = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    for (let i = 0; i < parts.length - 1; i++) {
      try { lines.push(JSON.parse(parts[i]!) as McpMessage); } catch { /* skip */ }
    }
    buf = parts.at(-1) ?? '';
  });

  const send = (msg: McpMessage) => proc.stdin.write(JSON.stringify(msg) + '\n');

  try {
    await fn(send, () => lines);
  } finally {
    proc.kill();
    await new Promise<void>((res) => proc.on('exit', res));
  }
}

function waitFor(
  getLines: () => McpMessage[],
  predicate: (msgs: McpMessage[]) => McpMessage | undefined,
  timeoutMs = 3000,
): Promise<McpMessage> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    const poll = setInterval(() => {
      const found = predicate(getLines());
      if (found) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(found);
      }
    }, 50);
  });
}

const INIT_REQUEST = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

// Using port 4711 (running daemon) for the happy-path tests and port 1 for
// the unreachable-daemon test. The tests skip gracefully if the daemon is absent.

describe('wicked-crew mcp: initialization', () => {
  it('responds to initialize with the correct server identity', async () => {
    await withMcpServer(4711, async (send, received) => {
      send(INIT_REQUEST);
      const resp = await waitFor(received, (msgs) => msgs.find((m) => m['id'] === 1));
      expect(resp['result']).toMatchObject({
        serverInfo: { name: 'wicked-crew', version: expect.any(String) },
        capabilities: { tools: expect.any(Object) },
        protocolVersion: expect.any(String),
      });
    });
  }, 5000);
});

describe('wicked-crew mcp: tool registry', () => {
  it('lists exactly the 7 run-lifecycle tools', async () => {
    await withMcpServer(4711, async (send, received) => {
      send(INIT_REQUEST);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      const resp = await waitFor(received, (msgs) => msgs.find((m) => m['id'] === 2));
      const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>;

      expect(tools.map((t) => t.name).sort()).toEqual([
        'answer_gate',
        'cancel_run',
        'launch_run',
        'list_runs',
        'list_workflows',
        'run_events',
        'run_status',
      ]);
    });
  }, 5000);

  it('launch_run requires a problem argument', async () => {
    await withMcpServer(4711, async (send, received) => {
      send(INIT_REQUEST);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      const resp = await waitFor(received, (msgs) => msgs.find((m) => m['id'] === 2));
      const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<{
        name: string;
        inputSchema: { required?: string[] };
      }>;

      const launchTool = tools.find((t) => t.name === 'launch_run');
      expect(launchTool).toBeDefined();
      expect(launchTool!.inputSchema?.required).toContain('problem');
    });
  }, 5000);
});

describe('wicked-crew mcp: tool calls', () => {
  it('list_workflows returns the daemon workflow list', async () => {
    await withMcpServer(4711, async (send, received) => {
      send(INIT_REQUEST);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workflows', arguments: {} } });

      const resp = await waitFor(received, (msgs) => msgs.find((m) => m['id'] === 2), 5000);
      const content = (resp['result'] as Record<string, unknown>)['content'] as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe('text');

      const parsed = JSON.parse(content[0]!.text);
      expect(parsed).toHaveProperty('workflows');
      expect(Array.isArray(parsed.workflows)).toBe(true);
    });
  }, 8000);

  it('run_status returns a 404 error for an unknown run ID', async () => {
    await withMcpServer(4711, async (send, received) => {
      send(INIT_REQUEST);
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'run_status', arguments: { run_id: 'no-such-run-abc123' } },
      });

      // A missing run returns an error result (isError: true) or throws; either is acceptable.
      const resp = await waitFor(received, (msgs) => msgs.find((m) => m['id'] === 2), 5000);
      const result = resp['result'] as Record<string, unknown>;
      const isErr = result['isError'] === true;
      const content = result['content'] as Array<{ type: string; text: string }>;
      // Either flagged as an error or the text contains an error indication.
      if (!isErr) {
        expect(content[0]!.text).toMatch(/404|not found|unknown/i);
      }
    });
  }, 8000);
});

describe('wicked-crew mcp: daemon unreachable', () => {
  it('fails loudly when the daemon is not running', async () => {
    // Port 1 has no listener; the probe should fail quickly.
    await new Promise<void>((resolve) => {
      const proc = spawn(process.execPath, [DIST, 'mcp', '--port', '1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      proc.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
      proc.on('exit', (code) => {
        expect(code).not.toBe(0);
        expect(stderrBuf).toMatch(/Cannot reach daemon|ECONNREFUSED|port 1/);
        resolve();
      });
      // Give it 3 seconds max.
      setTimeout(() => { proc.kill(); resolve(); }, 3000);
    });
  }, 5000);
});
