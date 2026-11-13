# wicked-crew

**The harness for your agent harnesses** — run the coding-agent CLIs you already use as governed
workers through durable, multi-agent workflows. Intent in, gated work out: gates are
deny-dominates, "done" is re-derived from evidence instead of asserted, and by default review goes to
an agent other than the one that built the work. When none can review it, the run stops unless you
launch it as "reduced assurance", which is labelled on the run, every gate and the delivery; crew never
turns that on for you.

Apps and data, through one gate: register your databases, files, APIs and issue trackers (GitHub
Issues, Jira), build dashboards over them by chat, and let agents read your databases only where you
allow it. An agent's read of a database is one checked, read-only query with a 10 s deadline and at
most 200 rows, marked as untrusted data and cited.

Local-first: loopback only, no accounts, no billing, no model reselling. Crew drives the agents
*you* already pay for, on *your* auth and *your* plan.

## Requirements

- **Node.js ≥ 22** / npm (uploading a file or a SQLite database as a data source needs 24.12, 25.1 or later).
- **uv** — the daemon builds its skills environment with `uv sync` (once per skills baseline); without
  uv every job launch is refused (`venv-failed`). The family installer installs it for you (see below).
- **git** — crew spawns it for every repository operation.
- **A local Kubernetes cluster** (Rancher Desktop, or Docker Desktop with Kubernetes on), running and
  installed once for crew: `npx wicked-installer` (0.10.0 or later) runs the install, or by hand
  `"$(npm root -g)/wicked-crew/node_modules/wicked-core-ts-<platform>/wicked-core" cluster install
  --admin-context rancher-desktop --home ~/.wicked-crew`. On Rancher Desktop, choose the dockerd (moby)
  container engine (Preferences → Container Engine). With containerd, crew's floor images aren't visible to the
  kubelet and seats won't start (wicked-core#1449). Governed agents work in a hardened seat pod,
  and you sign each one in from studio's Agents tab: Claude Code and GitHub Copilot in a login pod,
  Codex, Pi and OpenCode with their host CLIs. `WICKED_SEAT_FLOOR=host` keeps the labelled interim host
  floor instead.
- **At least one coding-agent CLI** you can sign in (Claude Code, Codex, GitHub Copilot, OpenCode or Pi).
- **wicked-estate** — the `wicked-estate` / `wicked-estate-mcp` binaries on PATH. Crew requires it:
  adding a repository in Studio runs onboarding's index phase on the `wicked-estate` tool, and it
  powers code graphs, memory and (from wicked-estate 0.32.0) the knowledge store that holds your data
  sources' structure — never their values. `npx wicked-installer install wicked-estate`
  downloads a sha256-verified prebuilt binary into `~/.local/bin` (about 20 s) on macOS, glibc Linux
  (x64/arm64) and Windows x64; on other platforms it builds with cargo, which needs a Rust toolchain.
- **wicked-garden ≥ 12.68.0**, the skills every governed worker follows (including the Apps skill an
  app's chat builds with). crew does not vendor it, and without it every launch is refused:
  `npx wicked-installer install wicked-garden`, then restart `wicked-crew serve`.

The family installer installs estate and garden (and, when uv is missing, uv itself) for you.

## Quick start

```bash
npx wicked-installer        # pick the "Quick Start" bundle (wicked-crew + wicked-bus + wicked-estate,
                            # with wicked-garden + wicked-vault added as crew's requirements)
wicked-crew serve           # start the daemon
# then open http://127.0.0.1:7701 in your browser
```

The installer puts estate's prebuilt binaries (and uv, when astral's installer places it) in `~/.local/bin`,
which is **not** on macOS's default PATH. Put the directory on PATH so the daemon and your shell find
them:

- **macOS (zsh):** `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`, then open a new terminal.
- **Linux (bash):** the same line into `~/.profile`.
- **Windows:** `%USERPROFILE%\.local\bin` — astral's uv installer adds it to the user PATH; otherwise add it via Environment Variables.

If your shell can't find `wicked-crew` itself, npm's global bin directory is not on PATH: add
`$(npm prefix -g)/bin` (macOS, Linux) or the directory `npm prefix -g` prints (Windows).

If a garden older than 12.68.0 is already installed, the installer may keep it; crew's blocking `skills.garden`
finding then names its version and where it was found. Update that copy (for the npm package,
`npm install -g wicked-garden@latest`) and restart `wicked-crew serve`.

Or install crew by hand (advanced). It needs uv and the requirements above, including
**wicked-garden 12.68.0 or later** (crew refuses every launch until it finds one):

```bash
npx wicked-installer install wicked-estate wicked-garden
npm install -g wicked-crew
wicked-crew serve
# then open http://127.0.0.1:7701
```

Crew uses the first usable garden source in this order (automatic sources need version ≥ 12.68.0):

1. `WICKED_CREW_SKILLS_SOURCE`, an explicit plugin root.
2. The Claude marketplace cache under `$CLAUDE_CONFIG_DIR` or `~/.claude` (highest valid version).
3. The Claude installer copy under those config dirs (`plugins/wicked-garden`).
4. The npm-global `wicked-garden` package, found through its launcher on PATH, then beside crew.
5. The Codex plugin cache under `$CODEX_HOME` or `~/.codex` (highest valid version across marketplaces).

At boot, the daemon also appends existing `$XDG_BIN_HOME`, `~/.local/bin` and `~/.cargo/bin` directories to its
own PATH, so it finds the installer's tools even before your shell does. Commands already on your PATH take
precedence.

Studio's Nerve Center names whichever requirement is missing on a fresh install.

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
as `npx wicked-interactive@^0.16.2` (0.16.2 streams a recording from a dot directory; 0.16.1 listens on loopback only; 0.16.0 keeps a demo cut's history and restores an earlier cut; 0.15.0 lands a chat-made draft only on the head it started from; 0.14.1
carries the demo import crew's demo runs use; 0.12.0
confined export asset reads to the document's own and approved roots); `WICKED_INTERACTIVE_SPEC` overrides the range (semver range
only, validated; invalid values are named on the boot line and ignored, a floor below crew's need
is warned about).

## Launch a run

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

## Apps and data sources

Data sources are Postgres, MySQL, uploads (CSV, XLSX, `.sqlite`), GraphQL, REST and MCP servers, issue
trackers and crew itself, in one registry with Test connection, and "Ask a question of this data" for
SQL sources. An app is a dashboard built by chat: each message is one governed job whose change lands
only after a different agent reviews it. Agents read a database only through the data gate, under three
switches a person sets on the source (see its structure, query its rows, which projects); rows are
Postgres-only in this release. A REST or MCP server's tools reach agents as MCP tools, under your MCP
approvals and policies. Trackers (GitHub Issues, Jira) link to projects and repositories, and a job sees only the
trackers of its project and repositories. Details: [data sources](https://github.com/mikeparcewski/wicked-crew/blob/main/docs/data-sources.md).

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
