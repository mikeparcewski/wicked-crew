/**
 * Fake `claude` CLI that ends every turn with a MALFORMED error result — subtype
 * `error_during_execution`, `is_error: true`, and NO `errors` array.
 *
 * This is the crew#290 candidate trigger that survives in upstream claude-agent-acp
 * 0.73.0: the KNOWN-subtype result handlers call `message.errors.join(", ")` (and a
 * sibling calls `.map`) unguarded, so a result frame missing those fields raises a
 * TypeError inside the bridge's message loop. The tolerance pin in
 * `claude-acp-bridge-tolerance.test.ts` asserts the bridge ANSWERS the turn (an error
 * response is fine — silence and process death are not) and STAYS ALIVE afterwards.
 *
 * Same stream-json dialect as `fake-claude-cli.mjs` (the SDK launches this file via
 * `node <path>`, so no shebang/exec bit needed).
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
  send({
    type: 'assistant',
    message: {
      id: 'msg_' + randomUUID().slice(0, 8),
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text: `turn ${turn}: about to fail malformed.` }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: randomUUID(),
  });
  // THE PROBE: an error result with no `errors` array (and no `result` text) — the
  // field shape the upstream handlers dereference without a guard.
  send({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
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
