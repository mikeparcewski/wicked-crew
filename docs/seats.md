# Seats: sign-in, the roster, and governed work

A **seat** is one coding-agent CLI (claude, codex, pi, copilot, opencode, agy) that the daemon runs
as a worker. This page covers two questions the daemon answers before it routes any work to a seat:
whether the seat can authenticate, and whether it enforces governance on its tool calls.

## Where a seat's login lives

The engine runs every seat under its own configuration home inside the worker home
(`WICKED_WORKER_HOME`, default `~/.wicked-worker`, or `worker_config_root` in the system settings):

| Seat | Configuration home | Credential |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR=<worker home>/claude` | OS keychain entry keyed by the config dir (see below); `.claude.json` records the account |
| codex | `CODEX_HOME=<worker home>/codex` | `auth.json` |
| pi | `PI_CODING_AGENT_DIR=<worker home>/pi` | `auth.json` |
| copilot | `COPILOT_HOME=<worker home>/copilot` | a token in the environment, or the OS keychain |
| opencode | `XDG_DATA_HOME=<worker home>/opencode/data` | `opencode/auth.json` |

Each seat's roster record carries `login_invocation`, the exact command that signs that seat in
under its own home. The System page runs it in a terminal.

### Claude: the keychain entry is keyed by the config dir

Claude Code stores its OAuth token in the OS keychain (macOS: a generic password) under the service
name `Claude Code-credentials-<first 8 hex chars of sha256(CLAUDE_CONFIG_DIR)>`. `.claude.json` in
the config dir still records the account (`oauthAccount`), but it holds no token.

So when the worker home is **moved or renamed** (a new `worker_config_root`, a restored machine, a
copied config dir), `.claude.json` comes along but the token does not: the new path hashes to a
different service name. Every headless `claude` under the new dir then prints
`Not logged in · Please run /login`, while the file still looks signed in.

The remedy is to sign in once under the new dir, with the seat's `login_invocation`:

```sh
CLAUDE_CONFIG_DIR="<worker home>/claude" claude    # then /login
```

(Re-keying the old keychain item to the new service name in Keychain Access also works. Do not
script it through `security … -w`: that prints the token and puts it on a command line.)

No daemon restart is needed. The seat's next check picks up the new entry.

## How the roster decides `auth`

`GET /api/v1/roster` reports each seat's `auth` (`signed_in`, `signed_out`, `not_required`,
`unknown`) and says where the reading came from in `auth_source`. In order of precedence:

1. **The seat's own refusal** (`auth_source: "seat-stderr"`). A ballot, a unit or an ACP handshake
   in which the seat said it has no working credential ("Not logged in", "No API key found",
   "OAuth session expired …", a 401) sets `signed_out` for 30 minutes, or
   until the seat's next successful output. The engine's frame is read in full: `kind`, `reason`
   (`not_logged_in`), `stderr`, `stdout` and `detail`. This flips the roster within the same run.
2. **The seat's auth-status check** (`auth_source: "probe"`, with `probed_at`). For claude
   (`claude auth status`) and codex (`codex login status`), the daemon runs the CLI's own check
   under the seat's configuration home. The check runs in the background, never on the request
   path. A signed-in answer is re-checked after 5 minutes and any other answer after 30 seconds, so
   a seat signed in from the System page turns green within a poll or two. Changing the worker home
   discards every answer. Until the first check answers, a probed seat reads `unknown`, not
   `signed_in`, because a credential file is not a working login.

   A status command reads the stored login and never asks the provider. An OAuth login whose
   token expired and cannot be refreshed still reads signed in there (crew#645). So when the
   status command says signed in, the daemon also sends one short live request under the same
   configuration home: `claude -p` on haiku with no tools, no MCP servers and no session file, or
   `codex exec --ephemeral --sandbox read-only`, asking for the single word "OK". If the seat
   refuses it for want of a credential, it reads `signed_out` and its words become the
   `auth_evidence`. If the request times out or fails for another reason, the status answer stands.
3. **The credential file** (no `auth_source`). For seats with no status command (pi, copilot,
   opencode, agy), the daemon checks that a credential-shaped file exists. A file can prove that a
   login happened, not that it still works; the seat's own refusal (1) is what catches that.

`login_check` says how far the reading was verified. `live` means the seat answered (or refused) an
authenticated request. `status` means only the status command answered. `unverified` means nothing
asked the seat: it has no status command, or its check has not answered or could not tell. Unless
the check is `live`, `login_note` explains why, starting "login unverified".

A launch (`POST /runs` with no `clisJson`, the adapter's own launches and `wicked-crew start`) first
waits, for up to 20 seconds, for any seat whose check is missing or stale. So an expired login reads
`signed_out` before the launch routes work. A probed seat whose check still has not answered is
`council_eligible: false` ("login not verified yet"). Its `auth` stays `unknown`, so a chat still
offers it.

A seat whose `auth` is `signed_out` is `council_eligible: false`. At launch, the daemon hands the
engine such a seat as benched (`health.usable: false`), so no unit is routed to it. If the bench
leaves an evaluator unit with no seat distinct from its creator, the engine refuses the plan and
the run parks at a gate. It does not plan a self-graded run.

## Governed work goes to seats that enforce governance

A seat **enforces input governance** when every tool call it makes is put to the engine's policy
gate before it runs:

- an ACP seat whose adapter is admitted (`acp_input_governance = true` in its `[cli.acp]` record;
  claude's adapter is);
- a wrapped seat only when it runs claude (the PreToolUse gate-hook is claude-only).

Any other seat (today pi, codex, copilot, opencode and agy) runs a governed unit with its tool calls
unchecked, and the engine emits `governanceUnenforced` for it.

When the engine distributes a run, a **build** unit (the stage that writes) goes to a seat that
enforces governance whenever one is eligible, even if an ungoverned seat comes first in the roster.
Review and test units are unaffected: the evaluator-distinct rule moves them off the builder's seat,
and they run with a read-only write posture. If no eligible seat that enforces governance admits a
build unit, it is still routed, and its `unitDistributed.degradedReason` names the unit and the
ungoverned seat, so the operator sees it at the intake gate.
