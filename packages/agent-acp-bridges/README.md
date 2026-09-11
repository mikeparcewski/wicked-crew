# agent-acp-bridges

ACP ([Agent Client Protocol](https://agentclientprotocol.com)) stdio bridge for headless
coding CLIs that have **no native or ecosystem ACP adapter**. Each bin turns a one-shot
CLI into an ACP server that wicked-core (or any ACP client) can drive as a worker session.

| bin | wraps | headless invocation |
|---|---|---|
| `agy-acp` | Antigravity | `agy -p <prompt>` |
| `wicked-pi` | pi (a launcher, not a bridge — see [Skills for a pi seat](#skills-for-a-pi-seat-wicked_pi_skill_dirs)) | `pi [--no-skills --skill <dir>…] <args>` |

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

## Skills for a pi seat (`WICKED_PI_SKILL_DIRS`)

The contract between wicked-core and this package for handing a **pi** seat the published skills
snapshot over the ACP carrier (F-079; wicked-core#441 sets the variable, wicked-crew#531 honours it):

| | |
|---|---|
| variable | `WICKED_PI_SKILL_DIRS` |
| value | the deliverable **portable** skill directories of the pinned snapshot generation (`<snapshot>/skills/<dir>`), joined with the OS path delimiter (`:` on POSIX, `;` on Windows), in the order the wrapped carrier puts them on pi's argv |
| effect when set with dirs | a **delivery**: pi is started with `--no-skills` (discovery of `~/.pi/agent/skills` OFF) followed by one `--skill <dir>` per entry — order kept, blank entries and duplicates dropped — **before** every other argument |
| effect when set but **empty** (`WICKED_PI_SKILL_DIRS=`) | a delivery of **zero** portable skills: pi is started with `--no-skills` **alone** — discovery stays off, the seat sees no skills (1.1.1; 1.1.0 read this as "no delivery") |
| effect when unset | **no delivery**: nothing is added; the launch is byte-identical to before |

Two places implement it:

- **`runBridge` (`bridge.mjs`)** — any bridge built on it that spawns the `pi` binary gets the
  flags prepended to its invocation's args (`skillFlagsFor(bin, env)` / `piSkillFlags(env)`,
  both exported). Other binaries are never touched.
- **`wicked-pi` (the launcher)** — the pi seat's actual ACP carrier is the community
  [`pi-acp`](https://www.npmjs.com/package/pi-acp) adapter, which spawns `pi --mode rpc --no-themes`
  itself and forwards no argv of its own, but lets its host name the command it runs as pi through
  `PI_ACP_PI_COMMAND` (inheriting the adapter's environment). The wicked-crew daemon points that
  variable at this launcher at boot (`ensurePiLauncherCommand`, respecting an operator's own value),
  so the chain on a governed run is

  ```
  wicked-core ──env WICKED_PI_SKILL_DIRS──▶ pi-acp ──PI_ACP_PI_COMMAND──▶ wicked-pi ──▶ pi --no-skills --skill … --mode rpc --no-themes
  ```

  `wicked-pi` runs `pi` from `PATH` (or the path in `WICKED_PI_BINARY`), passes stdio straight
  through, forwards `SIGTERM`/`SIGINT`/`SIGHUP`, and mirrors pi's exit status. A missing pi is a
  named failure (exit 127).

## Protocol

JSON-RPC 2.0 ndjson over stdin/stdout:

1. `initialize` → `{ protocolVersion, serverInfo }`
2. `session/new` → `{ sessionId }` (adopts `params.cwd`)
3. `session/prompt` → streamed `session/update` `agent_message_chunk` notifications,
   then `{ stopReason: "end_turn" | "error" }` — only a clean CLI exit reports
   `end_turn`.

`--settings <path>` is accepted and ignored (Claude-format gate hooks these CLIs
cannot execute). ANSI escape sequences are stripped from streamed output.

## Tolerance policy

Unknown input never kills the bridge (crew#290 — a mid-turn exit degrades the
whole governed run to single-shot fallback). The wire vocabulary grows over
time, so the dispatch is tolerant-by-default:

- unparseable lines, non-JSON-RPC frames (e.g. a stray stream-json
  `system`/`vcs_state_changed` frame), and unknown notification methods are
  logged to stderr and dropped;
- unknown request methods get a JSON-RPC `-32601` error response;
- a handler error is answered with `-32603` and the session keeps serving —
  the next `session/prompt` on the same session still works.
