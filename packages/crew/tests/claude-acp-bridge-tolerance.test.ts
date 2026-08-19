// Regression test for crew#290: the claude-agent-acp bridge must TOLERATE
// stream-json frames it does not recognize — never exit mid-turn.
//
// Claude Code emits `{"type":"system","subtype":"vcs_state_changed","kind":"commit"}`
// when the worker runs `git commit` mid-session. Governed runs INSTRUCT workers to
// commit incrementally (the evidence-floor contract, core#280/#281), so a bridge
// that treats the unknown subtype as fatal kills its own session on the first
// well-behaved commit: the engine sees Broken pipe and degrades the whole run to
// single-shot fallback (slower, no session continuity).
//
// This test runs the REAL packaged bridge binary against a fake `claude` CLI
// (tests/fixtures/fake-claude-cli.mjs) that injects, mid-turn:
//   - the vcs_state_changed system frame (kind: commit),
//   - a system frame with a totally unknown subtype, and
//   - a frame with a totally unknown top-level type,
// then finishes the turn normally. It asserts the bridge streams output emitted
// AFTER the hostile frames, completes the turn with stopReason end_turn, stays
// alive, and — the crew#288 turn-2 probe — completes a SECOND turn on the SAME
// session afterwards.
//
// Pinning this behavior matters even though the currently-pinned upstream
// version tolerates unknown frames (log-and-continue): the stream-json
// vocabulary grows with every Claude Code release, and a bridge bump that
// regresses to die-on-unknown would silently degrade every governed run.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Resolve the packaged bridge's bin entry (dist/index.js) from its package.json. */
function bridgeEntry(): string {
  const pkgPath = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> };
  return join(dirname(pkgPath), pkg.bin['claude-agent-acp']!);
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-cli.mjs');

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown> | undefined;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Minimal ACP client over the bridge's stdio. */
class BridgeClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderrLines: string[] = [];
  readonly updates: Array<Record<string, unknown>> = [];
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  constructor(cwd: string, configDir: string) {
    const env = { ...process.env };
    // The fake CLI must win regardless of what this machine has installed or
    // configured; a real model pin would make getAvailableModels reject it.
    delete env['ANTHROPIC_MODEL'];
    env['CLAUDE_CODE_EXECUTABLE'] = FIXTURE;
    env['CLAUDE_CONFIG_DIR'] = configDir;

    this.child = spawn(process.execPath, [bridgeEntry()], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal };
    });
    createInterface({ input: this.child.stderr }).on('line', (l) => this.stderrLines.push(l));
    createInterface({ input: this.child.stdout }).on('line', (l) => this.onLine(l));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // not a frame — ignore
    }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else slot.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method === 'session/update') {
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update) this.updates.push(update);
      return;
    }
    if (msg.method !== undefined && msg.id != null) {
      // Request from the bridge (e.g. a permission ask). The fake CLI never
      // triggers one; answer method-not-found so nothing blocks if it does.
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled by test client' } }) +
          '\n',
      );
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `${method} timed out after ${timeoutMs}ms; bridge exit=${JSON.stringify(this.exit)}; ` +
                `stderr tail: ${this.stderrLines.slice(-5).join(' | ')}`,
            ),
          );
        }
      }, timeoutMs).unref();
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }

  /** Text of every agent_message_chunk streamed so far. */
  chunkTexts(): string[] {
    return this.updates
      .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
      .map((u) => (u['content'] as { text?: string } | undefined)?.text ?? '');
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('claude-agent-acp bridge tolerance (crew#290)', () => {
  it('survives vcs_state_changed + unknown frames mid-turn, and a second turn still works', async () => {
    const cwd = makeTmpDir('acp-290-cwd-');
    const configDir = makeTmpDir('acp-290-config-');
    const client = new BridgeClient(cwd, configDir);
    cleanups.push(() => client.kill());

    const init = await client.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      15_000,
    );
    expect(init['protocolVersion']).toBe(1);

    const session = await client.request('session/new', { cwd, mcpServers: [] }, 20_000);
    const sessionId = session['sessionId'];
    expect(typeof sessionId).toBe('string');

    // ── Turn 1: the fake CLI injects the hostile frames mid-turn ────────────
    const turn1 = await client.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'first turn' }] },
      20_000,
    );
    expect(turn1['stopReason']).toBe('end_turn');
    // The bridge must not have died on the unknown frames…
    expect(client.exit).toBeNull();
    // …and must have kept streaming PAST them: "done." is only emitted after
    // vcs_state_changed + the unknown-subtype + unknown-type frames.
    expect(client.chunkTexts().some((t) => t.includes('turn 1: done.'))).toBe(true);

    // ── Turn 2 on the SAME session (crew#288 turn-2 wedge probe) ────────────
    const turn2 = await client.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'second turn' }] },
      20_000,
    );
    expect(turn2['stopReason']).toBe('end_turn');
    expect(client.exit).toBeNull();
    expect(client.chunkTexts().some((t) => t.includes('turn 2: done.'))).toBe(true);
  }, 60_000);
});
