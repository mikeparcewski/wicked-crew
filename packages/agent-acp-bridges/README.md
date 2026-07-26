# agent-acp-bridges

ACP ([Agent Client Protocol](https://agentclientprotocol.com)) stdio bridges for headless
coding CLIs. Each bin turns a one-shot CLI into an ACP server that wicked-core (or any
ACP client) can drive as a governed, multi-turn worker session.

| bin | wraps | headless invocation |
|---|---|---|
| `codex-acp` | OpenAI Codex CLI | `codex exec --skip-git-repo-check <prompt>` |
| `pi-acp` | Pi CLI | `pi -p <prompt>` |
| `agy-acp` | Antigravity | `agy -p <prompt>` |
| `opencode-acp` | opencode | `opencode run <prompt>` |

GitHub Copilot CLI needs no bridge — it speaks native ACP (`copilot --acp`).
Claude Code uses the sibling package `claude-agent-acp` (token-level streaming and
governance `--settings` support).

## Install

Nothing to do when using **wicked-crew** — these ship as dependencies and the daemon
puts their shims on `PATH` at startup.

Standalone (e.g. driving wicked-core directly):

```sh
npm install -g agent-acp-bridges
```

The wrapped CLI itself must be installed and authenticated separately.

## Protocol

JSON-RPC 2.0 ndjson over stdin/stdout:

1. `initialize` → `{ protocolVersion, serverInfo }`
2. `session/new` → `{ sessionId }` (adopts `params.cwd`)
3. `session/prompt` → streamed `session/update` `agent_message_chunk` notifications,
   then `{ stopReason: "end_turn" | "error" }` — only a clean CLI exit reports
   `end_turn`.

`--settings <path>` is accepted and ignored (Claude-format gate hooks these CLIs
cannot execute). ANSI escape sequences are stripped from streamed output.
