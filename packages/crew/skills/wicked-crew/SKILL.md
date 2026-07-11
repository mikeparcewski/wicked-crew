---
name: wicked-crew
description: |
  Drive the wicked-crew governed execution daemon — the harness for your coding-agent harnesses — from its command line. Launch, observe, gate, and resume durable multi-agent runs where "done" is re-derived from evidence and the agent that evaluates work is structurally never the one that created it.
  Use when: the user wants to put a feature, bug fix, or migration through governed execution — "run this through crew", "kick this off as a crew run", "have crew do this", "governed run"; check the state or progress of a run — "what's crew doing", "is the run done", "show crew status", "poll the run"; approve, reject, or amend a crew gate — "approve the gate", "reject that step", "the gate is waiting on me", "steer the run"; or resume an interrupted or paused session — "pick the run back up", "resume that crew session".
---

# wicked-crew

`wicked-crew` is a governed execution platform: intent in, verified work out. It runs the
coding-agent CLIs you already use as governed workers through durable, multi-agent
workflows, with human gates and evidence-derived "done".

This skill wraps the `wicked-crew` **binary** — that binary is the entire tool. There are
no bundled scripts, so every command below runs identically on macOS, Linux, and Windows.
Prefer these CLI verbs; drop to raw REST (§6) only for inspection the verbs don't cover.

## The one hard rule — evaluator ≠ creator (do not break this)

If you launched, drove, or steered a run, you are its **creator**. A creator must **never
approve that run's own gates.** When a run pauses at a gate, your job is to surface the gate
evidence to the **human** and let the human (or a different, uninvolved agent) decide. Calling
`wicked-crew gate` to approve work you initiated is a violation of crew's core invariant —
treat it as forbidden. Rejecting/steering your own run is fine; approving it is not.

## 1. Preflight — is crew installed and is the daemon up?

Run a single status probe; its outcome tells you everything:

```
wicked-crew status
```

- **"command not found" / "not recognized"** → the binary isn't on `PATH`. Tell the user to
  install it by running the **wicked installer**, then stop. Do not try to fabricate a path.
- **Runs but fails with a connection error** (`ECONNREFUSED` / connection refused) → the binary
  is installed but no daemon is listening. Start one (§2).
- **Prints JSON** (a list of runs) → a daemon is already live on the port; reuse it.

**Endpoint & port.** The daemon binds **loopback only** — `127.0.0.1`, default port **7701**.
Override with `--port <n>` on any verb, or the `CREW_PORT` environment variable. It never
listens on a non-loopback address, and there is no auth — do not attempt to expose it.

## 2. Launch a governed run

`wicked-crew start` hosts its **own** daemon in-process **and** launches the run in one shot,
so you normally do not need a separate `serve`. Because it hosts the daemon, it is a
long-lived process — **run it as a background / detached process** and keep it alive until the
run reaches a terminal state, or `status`/`gate` will have nothing to talk to.

```
wicked-crew start --problem "<the intent, in plain language>" [--session <id>] [--human-confirm none|all|before:<ord>]
```

- `--problem` (required in practice) — the goal/bug/migration to execute.
- `--session <id>` — reuse a stable id so you can `resume` later; omit to get a random one.
- `--human-confirm` — gate policy: `all` (human confirms every gate — safest, keeps the hard
  rule easy to honor), `before:<ord>` (confirm before a specific unit ordinal), or `none` (no
  human gates — fully autonomous; only use when the human has explicitly authorized unattended
  execution).

**Read the readiness line.** On startup the process prints one machine-readable line to
**stdout**:

```
WICKED_CREW_READY {"mode":"start","port":7701,"db":"…","run":"<run-id>","startupMs":…}
```

Capture stdout, find the `WICKED_CREW_READY ` prefix, and `JSON.parse` the remainder. Keep the
`run` (run id) and `port` — every later verb needs them.

**Standalone-daemon alternative.** If you instead want a persistent daemon with no run bound
to it (e.g. to service the desktop UI or drive multiple runs over REST), background
`wicked-crew serve` and launch runs via `POST /api/v1/runs` (§6). Do **not** also run
`wicked-crew start` against a port a `serve` daemon already holds — `start` binds its own
listener and will fail with `EADDRINUSE`.

## 3. Observe — poll until a gate or a terminal state

```
wicked-crew status --run <run-id> [--port <n>]
```

Returns the run as JSON. Poll on a modest interval. Watch the run's status; the ones that
require you to act:

- `awaiting_human` → a gate is pending. Go to §4 (surface it to the human — do not self-approve).
- a terminal state (completed / failed / cancelled) → stop polling and report the outcome.

Omit `--run` to list **all** runs (useful to rediscover a run id).

## 4. Gate — approve / reject / amend (human decision, not yours)

When status shows `awaiting_human`, first **pull the evidence and show it to the human**: the
gate detail (`GET /api/v1/runs/:id/gate`, §6) plus the relevant unit output
(`…/units/:ord/output`). Present what the run did and what it's asking to do next.

Only once the **human** (or an uninvolved agent) has decided do you relay their decision:

```
wicked-crew gate --run <run-id> [--reject] [--amend "<steering text>"] [--port <n>]
```

- default (no `--reject`) = **approve**. Per the hard rule, only pass this on behalf of a human
  who authorized it — never for work you drove.
- `--reject` = reject the gate (cancels the run).
- `--amend "<text>"` = steer: approve-with-correction (or attach guidance to a rejection).

If you drove the run, your only self-initiated options here are to **reject or amend** — never
to approve.

## 5. Resume an interrupted session

```
wicked-crew resume --session <session-id> [--port <n>]
```

Like `start`, this re-hosts the daemon in-process, so **background it** and keep it alive. It
prints a `WICKED_CREW_READY` line (`mode":"resume"`) carrying the `run` and current `status`.

## 6. Escalation — richer inspection over REST

The verbs cover the common path; for deeper inspection talk to the daemon's REST API directly.
Base URL `http://127.0.0.1:<port>/api/v1`, **loopback only, no auth** (never send these
off-host):

- `GET /runs` — all runs; `GET /runs/:id` — one run's full detail.
- `GET /runs/:id/units/:ord/output` — a single work unit's captured transcript / terminal
  output (`:ord` is the unit ordinal).
- `GET /runs/:id/gate` — the pending gate's detail (evidence to show the human before §4).
- `POST /runs/:id/gate` `{ "approve": bool, "amend"?: string }` — what `wicked-crew gate` wraps.
- `POST /runs` — launch a run against a standalone `serve` daemon (see §2 alternative).
- Live streams: WebSocket at `/ws` (event bus) and the per-terminal sockets for real-time
  unit output.

## Out of scope for this skill

- **No MCP server.** crew is driven through its CLI and REST here; this skill does not stand up
  or register an MCP surface.
- **No hooks.** This skill installs no lifecycle hooks and expects none.
