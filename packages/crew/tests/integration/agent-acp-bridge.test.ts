// Integration test: the shared agent-acp bridge (packages/agent-acp-bridges) speaks
// well-formed ACP over stdio. A stub "CLI" (plain `node -e`) stands in for
// codex/pi/agy/opencode, so the test is deterministic and offline:
//   1. initialize      → protocolVersion + serverInfo
//   2. session/new     → sessionId (and cwd adoption)
//   3. session/prompt  → agent_message_chunk notification(s) + stopReason end_turn
//   4. a failing CLI   → stopReason error (non-zero exit must not report end_turn)
//   5. notifications (no id) never receive a response

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = join(here, '..', '..', '..', 'agent-acp-bridges');

interface RpcMsg {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
}

/** Drive one scripted exchange against a bridge whose CLI is `node -e <cliScript>`. */
async function runExchange(cliScript: string): Promise<RpcMsg[]> {
  // A one-shot bridge instance: invocation ignores the prompt and runs the stub CLI.
  const bridgeBoot = `
    import('${join(bridgeDir, 'bridge.mjs').replace(/\\/g, '\\\\')}').then(({ runBridge }) => {
      runBridge({
        name: 'stub-acp',
        version: '0.0.0',
        invocation: () => ({ bin: process.execPath, args: ['-e', ${JSON.stringify(cliScript)}] }),
      });
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bridgeBoot], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const seen: RpcMsg[] = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      seen.push(JSON.parse(line) as RpcMsg);
    } catch {
      /* non-JSON noise — the client contract says skip it */
    }
  });

  const send = (obj: unknown): void => {
    child.stdin.write(JSON.stringify(obj) + '\n');
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
  // A notification (no id) — must never be answered.
  send({ jsonrpc: '2.0', method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'ignored' }] } });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { prompt: [{ type: 'text', text: 'hello bridge' }] },
  });
  child.stdin.end();

  await once(child, 'close');
  return seen;
}

describe('agent-acp bridge', () => {
  it('completes the handshake and streams a successful turn', async () => {
    const seen = await runExchange(`process.stdout.write('chunk one\\n'); process.stdout.write('chunk two\\n');`);

    const init = seen.find((m) => m.id === 1);
    expect(init?.result?.['protocolVersion']).toBe(1);
    expect((init?.result?.['serverInfo'] as { name: string }).name).toBe('stub-acp');

    const sess = seen.find((m) => m.id === 2);
    expect(typeof sess?.result?.['sessionId']).toBe('string');

    const chunks = seen
      .filter((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((m) => m.params?.update?.content?.text ?? '');
    expect(chunks.join('')).toContain('chunk one');
    expect(chunks.join('')).toContain('chunk two');

    const turn = seen.find((m) => m.id === 3);
    expect(turn?.result?.['stopReason']).toBe('end_turn');
  }, 30_000);

  it('reports error for a non-zero CLI exit even when output was streamed', async () => {
    const seen = await runExchange(`process.stdout.write('partial output'); process.exit(3);`);
    const turn = seen.find((m) => m.id === 3);
    expect(turn?.result?.['stopReason']).toBe('error');
  }, 30_000);

  it('never responds to notifications and answers unknown methods with -32601', async () => {
    const bridgeBoot = `
      import('${join(bridgeDir, 'bridge.mjs').replace(/\\/g, '\\\\')}').then(({ runBridge }) => {
        runBridge({ name: 'stub-acp', version: '0.0.0', invocation: () => ({ bin: 'true', args: [] }) });
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', bridgeBoot], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const seen: RpcMsg[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        seen.push(JSON.parse(line) as RpcMsg);
      } catch {
        /* skip */
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'no/such/method', params: {} }) + '\n');
    child.stdin.end();
    await once(child, 'close');

    expect(seen.filter((m) => m.id === undefined || m.id === null)).toHaveLength(0);
    const unknown = seen.find((m) => m.id === 9);
    expect(unknown?.error?.code).toBe(-32601);
  }, 30_000);
});
