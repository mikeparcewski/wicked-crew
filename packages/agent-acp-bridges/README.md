# agent-acp-bridges

ACP ([Agent Client Protocol](https://agentclientprotocol.com)) stdio bridge for headless
coding CLIs that have **no native or ecosystem ACP adapter**. Each bin turns a one-shot
CLI into an ACP server that wicked-core (or any ACP client) can drive as a worker session.

| bin | wraps | headless invocation |
|---|---|---|
| `agy-acp` | Antigravity | `agy -p <prompt>` |

Every other roster CLI uses a native or upstream adapter instead of this package:

| CLI | adapter |
|---|---|
| claude | [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) (official, Claude Agent SDK) |
| codex | [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) (official, Rust) |
| pi | [`pi-acp`](https://www.npmjs.com/package/pi-acp) (community) |
| copilot | native — `copilot --acp` |
| opencode | native — `opencode acp` |

When an ecosystem adapter appears for a CLI bridged here, prefer it and shrink this
package further — the goal is for this package to disappear.

## Terms-of-service caution

`agy-acp` drives Antigravity programmatically. Community reports suggest this may
conflict with Antigravity's terms of service — review Google's current terms before
using this bridge, and drop the seat from your roster if in doubt.

## Install

Nothing to do when using **wicked-crew** — this ships as a dependency and the daemon
puts its shim on `PATH` at startup. The wrapped CLI itself must be installed and
authenticated separately.

## Protocol

JSON-RPC 2.0 ndjson over stdin/stdout:

1. `initialize` → `{ protocolVersion, serverInfo }`
2. `session/new` → `{ sessionId }` (adopts `params.cwd`)
3. `session/prompt` → streamed `session/update` `agent_message_chunk` notifications,
   then `{ stopReason: "end_turn" | "error" }` — only a clean CLI exit reports
   `end_turn`.

`--settings <path>` is accepted and ignored (Claude-format gate hooks these CLIs
cannot execute). ANSI escape sequences are stripped from streamed output.
