/**
 * Fake `claude` CLI for the claude-acp-bridge tolerance test (crew#290).
 *
 * Speaks just enough of the Claude Agent SDK's stream-json wire protocol
 * (`--input-format stream-json --output-format stream-json`) for the
 * claude-agent-acp bridge to run governed-style turns against it. The SDK
 * launches this file via `node <path>` (non-native executables are wrapped),
 * so it needs no shebang/exec bit and works on Windows.
 *
 * Per user turn it emits, in order:
 *   1. system/init                          (turn 1 only)
 *   2. an assistant text message            ("starting work")
 *   3. system/vcs_state_changed kind:commit (the crew#290 killer frame —
 *      Claude Code emits it when the worker runs `git commit` mid-turn)
 *   4. a system frame with a totally unknown subtype
 *   5. a frame with a totally unknown top-level type
 *   6. another assistant text message       ("done" — proves the stream
 *      continued past the hostile frames)
 *   7. a result frame (success)
 *   8. system/session_state_changed state:idle
 *
 * Every control_request is answered with a generic success control_response;
 * `initialize` gets a canned payload (models/commands/agents/account).
 */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const SESSION_ID = randomUUID();
let turn = 0;

function controlSuccess(requestId, response) {
  send({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: response ?? {} },
  });
}

function assistantText(text) {
  send({
    type: 'assistant',
    message: {
      id: 'msg_' + randomUUID().slice(0, 8),
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });
}

function runTurn() {
  turn++;
  if (turn === 1) {
    send({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      cwd: process.cwd(),
      tools: [],
      model: 'fake-model',
      apiKeySource: 'none',
      mcp_servers: [],
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      agents: [],
      claude_code_version: '9.9.9',
      uuid: randomUUID(),
    });
  }

  assistantText(`turn ${turn}: starting work.`);

  // ── hostile frames, mid-turn ─────────────────────────────────────────────
  send({
    type: 'system',
    subtype: 'vcs_state_changed',
    kind: 'commit',
    branch: 'fix/incremental-commit',
    head: '0123456789abcdef',
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });
  send({
    type: 'system',
    subtype: 'totally_unknown_subtype_from_the_future',
    payload: { anything: true },
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });
  send({
    type: 'totally_unknown_frame_type',
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });

  assistantText(`turn ${turn}: done.`);

  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: `turn ${turn}: done.`,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    permission_denials: [],
    uuid: randomUUID(),
  });
  send({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_request') {
    if (msg.request?.subtype === 'initialize') {
      controlSuccess(msg.request_id, {
        commands: [],
        models: [{ value: 'fake-model', displayName: 'Fake Model', description: 'test stub' }],
        agents: [],
        account: {},
        output_style: 'default',
        capabilities: [],
      });
    } else {
      controlSuccess(msg.request_id, {});
    }
    return;
  }
  if (msg.type === 'user') runTurn();
});
rl.on('close', () => process.exit(0));
