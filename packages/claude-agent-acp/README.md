# claude-agent-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com)) stdio bridge for
**Claude Code**. Turns `claude -p` into an ACP server that wicked-core (or any ACP
client) drives as a governed, multi-turn worker session.

Compared to the generic bridges in the sibling `agent-acp-bridges` package, this one is
Claude-aware:

- **Token-level streaming** — probes for `--include-partial-messages` support once per
  process and forwards `stream_event` text deltas as `agent_message_chunk`
  notifications, so text reaches the client as it is generated.
- **Governance** — `--settings <path>` is forwarded to `claude -p`, so a PreToolUse
  gate-hook fires on every tool call when the client arms input governance.
- **Usage reporting** — token counts from the result frame ride a `usage_update`
  notification.

## Install

Nothing to do when using **wicked-crew** — this ships as a dependency and the daemon
puts its shim on `PATH` at startup.

Standalone:

```sh
npm install -g claude-agent-acp
```

Claude Code itself must be installed and authenticated separately.

## Protocol

JSON-RPC 2.0 ndjson over stdin/stdout: `initialize` → `session/new` →
`session/prompt` (repeated), with `session/update` notifications streaming text and
usage before each turn's `{ stopReason }` response.
