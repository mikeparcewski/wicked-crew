# wicked-crew

**The harness for your agent harnesses** — run the coding-agent CLIs you already use as governed
workers through durable, multi-agent workflows. Intent in, verified work out: the evaluator is
structurally not the creator, gates are deny-dominates, and "done" is re-derived from evidence
instead of asserted.

Local-first: loopback only, no accounts, no billing, no model reselling. Crew drives the agents
*you* already pay for, on *your* auth and *your* plan.

## Install

Requires Node.js ≥ 22 and at least one coding-agent CLI on your machine (e.g. Claude Code, Codex).

```bash
npm install -g wicked-crew
wicked-crew serve
```

Or without installing:

```bash
npx wicked-crew serve
```

Or use the family installer — [`npx wicked-installer`](https://www.npmjs.com/package/wicked-installer)
installs/updates the whole wicked-\* family, crew included.

`serve` starts the daemon on `http://127.0.0.1:7701` (override with `--port` or `CREW_PORT`) and
serves the bundled **wicked-studio** browser console same-origin — open the URL and you have the
control room: launch and steer runs, answer human gates, browse projects and evidence, watch live
engine events. Durable state (runs, evidence, event log) lives in `~/.wicked-crew/` (`--db`
overrides).

## Quickstart

```bash
# 1. Start the daemon (leave it running)
wicked-crew serve

# 2. Launch a governed run — from the console at http://127.0.0.1:7701,
#    or headless over the API:
curl -X POST http://127.0.0.1:7701/api/v1/runs \
     -H 'content-type: application/json' \
     -d '{"problem": "Add input validation to the signup form", "workflow": "feature"}'

# 3. Watch it move through the workflow's phases; approve or reject at the gates.
```

One run token moves through the workflow's phases with a gate between every one — e.g. for
`feature`: clarify → design → build → adversarial-review → test → review. Each phase is executed
by a versioned skill on an assigned CLI worker; the gates decide, and every decision is audited.

## The governed-run model

- **You own the workflow; the agent owns the work.** The orchestrator sequences phases and holds
  the gates; the agent does the coding inside a phase.
- **Workflows are data.** `feature` / `bug` / `migration` ship built-in; new ones are drop-in JSON
  files, not code.
- **Gates are real, not self-graded.** Phase transitions resolve **deny-dominates** on a
  deterministic structural floor, with an independent evaluator seat that reads cold evidence
  only — a model may fail a gate, never solely approve one.
- **Evidence, not assertion.** "Done" is re-derived from evidence at the gate, never claimed by
  the agent that did the work.

The engine underneath is [wicked-core](https://github.com/mikeparcewski/wicked-core) (Rust,
single-writer), embedded via the `wicked-core-ts` napi bridge — the daemon is a thin REST+WS
layer over it.

## The acceptance gate

`GET /api/v1/runs/:id/acceptance` answers "does the QE evidence ledger accept this run's work?" —
crew's machine gate, absorbed from the retired wicked-testing product. <!-- historical --> It reads the repo's
evidence ledger (a wicked-ledger store at `<repo>/.wicked-qe/`, written by wicked-garden's QE
skills; legacy `.wicked-testing/` ledgers are still read) and resolves the workflow's acceptance
requirement **deny-dominates**: only a `PASS` verdict satisfies it. `FAIL`, `CONDITIONAL`,
`PARTIAL`, `INCONCLUSIVE`, a missing ledger, or a missing verdict each deny with their own named
reason — no evidence is never a pass. The route always returns 200 for a known run ("no verdict"
is a real answer about the gate, not an error); `?qeRun=<id>` pins the read to one QE run.

## CLI

```
wicked-crew serve|start|resume|gate|status|mcp
```

| command | what it does |
|---|---|
| `serve` | run the daemon: REST `/api/v1` + WS `/ws` + the bundled studio console |
| `start` | boot and launch a run headless (`--problem`, `--workflow`, `--repo`) |
| `resume` | resume a persisted run (`--session <id>`) |
| `gate` | answer a pending human gate from the terminal |
| `status` | inspect run state |
| `mcp` | stdio MCP server — crew-as-a-tool for coding agents |

## Links

- Repo: <https://github.com/mikeparcewski/wicked-crew>
- Site & docs: <https://wc.wickedagile.com>
- Wire contract (every `/api/v1` + `/ws` shape, types-only): [`wicked-crew-api-types`](https://www.npmjs.com/package/wicked-crew-api-types)
- Engine: [wicked-core](https://github.com/mikeparcewski/wicked-core) · Console: [wicked-studio](https://github.com/mikeparcewski/wicked-studio)

MIT
