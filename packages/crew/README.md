# wicked-crew

**The harness for your agent harnesses** — run the coding-agent CLIs you already use as governed
workers through durable, multi-agent workflows. Intent in, gated work out: gates are
deny-dominates, "done" is re-derived from evidence instead of asserted, and review goes to a seat
other than the creator's whenever the roster has an eligible one — team runs require it, and an ordinary run
that cannot meet it says so on the run ("evaluator ≠ creator not held").

Local-first: loopback only, no accounts, no billing, no model reselling. Crew drives the agents
*you* already pay for, on *your* auth and *your* plan.

## Install

Before you start, you need:

- **Node.js ≥ 22.**
- **A container runtime** (Rancher Desktop, Docker, Podman, Colima or OrbStack), running. Governed
  agents work in a hardened seat container, and you sign each one in from studio's Agents tab in a
  login container. `WICKED_SEAT_FLOOR=host` keeps the labelled interim host floor instead.
- **At least one coding-agent CLI** you can sign in (Claude Code, Codex, GitHub Copilot, OpenCode or Pi).
- **wicked-garden ≥ 12.40.0**, the skills every governed worker follows. crew does not vendor it, and
  without it every launch is refused: `npx wicked-installer install wicked-garden`, then restart
  `wicked-crew serve`.
- Optional: **wicked-estate** (`wicked-estate-mcp` on PATH) for code graphs and memory. It installs
  with cargo today, so it needs a Rust toolchain.

```bash
npm install -g wicked-crew
wicked-crew serve
```

Studio's Nerve Center names whichever of these is missing on a fresh install.

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
overrides). Governance evidence — conformance claims, phase transitions, rule lifecycle — lands in
`<core db>.governance/governance.db` (`--governance-db` / `WICKED_CREW_GOVERNANCE_DB` override; an
inherited `WICKED_ESTATE_DB` is honoured — the emit seam is SQLite-only, so a URL-form value such as
`postgres://…` in your shell refuses boot until `--governance-db` names a SQLite file); events the
engine cannot store dead-letter to
`<core db>.governance/emit-outbox.ndjson` by default (under the state home, not HOME; an explicit
`WICKED_APPS_EMIT_DEADLETTER` is honoured), are counted on
`GET /api/v1/diagnostics` → `governance` (a `governance.deadletter` finding), and are drained back
with `wicked-crew governance replay <outbox>`. The interactive document bridge is spawned on demand
as `npx wicked-interactive@^0.14.1` (0.14.1 carries the demo import crew's demo runs use; 0.12.0
confined export asset reads to the document's own and approved roots); `WICKED_INTERACTIVE_SPEC` overrides the range (semver range
only, validated; invalid values are named on the boot line and ignored, a floor below crew's need
is warned about).

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

A launch of a preset workflow or a plan on a repository runs in **power mode** by default: a
workflow's `build` step is one orchestrator seat building the whole change in checkpointed turns, rigor is re-scored from the
actual diff, and the hand-off runs the review, security and QE steps that rigor calls for. Phased (`power: false`, or a launch power mode
cannot run, such as one with no repository), one run token moves through the workflow's phases with a gate between every one — e.g.
for `feature`: clarify → design → build → adversarial-review → test → review. Each phase is executed
by a versioned skill on an assigned CLI worker; the gates decide, and every decision is audited.

## The governed-run model

- **You own the workflow; the agent owns the work.** The orchestrator sequences phases and holds
  the gates; the agent does the coding inside a phase.
- **Workflows are data.** `feature`, `bug` and `migration` ship built-in, beside `domain-extraction`
  (requirements), `mcp-server`, `editor-plugin`, `analyze` and others; new ones are drop-in JSON files,
  not code.
- **Gates are real, and they say what they checked.** A gated transition resolves
  **deny-dominates** on the layers that ran — a deterministic floor, repo checks, policies, an
  evaluator seat that reads cold evidence only — and a model may fail a gate, never solely approve
  one. With no distinct judge seat the floor decides alone ("floor only"); a transition nothing
  gated reads "approved by default, not verified".
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
wicked-crew serve|start|resume|gate|status|mcp|governance|version
```

| command | what it does |
|---|---|
| `serve` | run the daemon: REST `/api/v1` + WS `/ws` + the bundled studio console |
| `start` | boot and launch a run headless (`--problem`, `--workflow`, `--repo`) |
| `resume` | resume a persisted run (`--session <id>`) |
| `gate` | answer a pending human gate from the terminal |
| `status` | inspect run state |
| `mcp` | stdio MCP server — crew-as-a-tool for coding agents |
| `governance` | `governance replay <outbox>` drains governance events the engine could not store |
| `version` | the versions of this install (wicked-crew, wicked-core-ts, the bundled studio) |

## Links

- Repo: <https://github.com/mikeparcewski/wicked-crew>
- Site & docs: <https://wc.wickedagile.com>
- Wire contract (every `/api/v1` + `/ws` shape, types-only): [`wicked-crew-api-types`](https://www.npmjs.com/package/wicked-crew-api-types)
- Engine: [wicked-core](https://github.com/mikeparcewski/wicked-core) · Console: [wicked-studio](https://github.com/mikeparcewski/wicked-studio)

MIT
