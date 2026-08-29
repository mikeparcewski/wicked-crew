# Changelog

All notable changes to **wicked-crew** (the daemon package, npm `wicked-crew`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before this file
existed (everything ≤ 0.7.0) are backfilled from git history and release tags; the sibling
workspace packages `wicked-crew-api-types` and `agent-acp-bridges` version independently and are
mentioned only where a daemon release depends on them.

## [Unreleased]

### Added
- Estate-migration operability on the project graph: force refresh, per-repo outcomes, stderr
  visibility (#347).
- Root `CLAUDE.md` pointer stub for coding agents (#348).

### Fixed
- QE acceptance ledger honors an absolute `WICKED_QE_LEDGER_DIR` (#348).
- The deliverable floor no longer passes on a PRIOR run's artifact (#346).
- Interactive edit-events scope their declared write root to the handoff that owns it (#345).
- The `studio.*` settings size cap is enforced on the read path too (#344).
- A stub engine never answers another product's bus traffic (#343).
- Pinned the wicked-interactive crew starts; fixed two load-sensitive tests (#331).

### Docs
- Documented the project code graph, which shipped in 0.7.0 undocumented (#332).
- Site: chrome re-pin, scroll-snap and topbar-threshold fixes (#334–#336).

## [0.7.0] — 2026-08-25

**A project is a context.** One co-located wicked-estate code graph over all of a project's repos,
runs that bind to it, and the studio 0.4.0 console bundled as the default local skin.

### Added
- Project code graph: attach repos as `crew.repo` members and build one co-located graph over all
  of them — `GET /projects/:id/graph`, `/graph/search`, `/graph/blast-radius`,
  `POST /graph/refresh`; every hit attributed to its repo, `linkage: "co-located"` declared on
  every response (#326). Requires wicked-estate ≥ 0.14.6 and wicked-core-ts ≥ 0.7.1, both
  capability-probed before anything is indexed.
- Runs bind to their project's graph — and record why when they don't (#327).
- `deliver: "pr"` on launch: runs open their own PRs, first-class (#303).
- Run file & diff read routes: `GET /runs/:id/files` + `GET /runs/:id/diff` (#305), with a
  branch-vs-base baseline `?base=merge-base` (#307).
- `project_id` on the run DTO + `retryOf` retry lineage (#306).
- Durable operator guidance on runs: `PUT /runs/:id/guidance` (#312).
- Governed answering seams for wicked-interactive: doc iteration asks (`chat.posted`, #310),
  unbound/unfiled doc drafting (#308), repo-grounded doc drafts via inbox snapshots (#313), and a
  governed demo answerer that authors the spec and triggers the recording (#316).
- Native `workerStalled` detection on the event relay (#301).

### Changed
- Bundles **wicked-studio 0.4.0** as the default local skin (#328).
- The deliver phase commits before push, fails when there is nothing to deliver, and re-derives
  the PR from the remote (#318).

### Fixed
- Evidence floor for the interactive seams: a unit that produced no artifact fails honestly (#319).
- `RetryIndex`/`GuidanceIndex` hydrate from the FULL audit trail, not the newest 1000 entries (#315).
- The `studio.*` settings namespace is persisted instead of silently dropped (#324).
- ACP bridges die with the daemon (reaper + parent-death watchdog, #300); the reaper matches bridge
  binaries as whole command tokens (#302); tolerant-by-default frame dispatch in the bridges (#299).
- The studio origin is recorded on bridge start/adopt (#304).

## [0.6.0] — 2026-08-19

**The merge daemon.** Crew becomes the control-plane owner of the QE acceptance gate and the
governed answerer for wicked-interactive's document traffic.

### Added
- **Acceptance gate**: `GET /runs/:id/acceptance` — reads the repo's QE evidence ledger
  (wicked-ledger store at `<repo>/.wicked-qe/`, legacy `.wicked-testing/` dual-read) and resolves
  the workflow's acceptance requirement deny-dominates; only `PASS` satisfies, every non-PASS
  outcome denies with its own named reason (Phase 6a, #239). Tracks the engine's built-in
  evidence-floor pin `e2e7af1db9e48454` (#289).
- wicked-interactive merge (DES-MERGE-001): reverse-proxy to the interactive bridge (#291),
  `wicked.interactive.*` bus events relayed onto `/ws` (#292), draft/edit answering seams on by
  default (#262) with declared extra write roots (#264), and a narration ladder that advances the
  doc thread with the run's real events (#268).
- stdio **MCP server** — crew-as-a-tool for coding agents (`wicked-crew mcp`, #226).
- Auth seam: the `{id, kind, trust}` actor contract on `/api/v1` + `/ws` (#250), an OIDC verifier
  (#259), and operator-trust required on `/ws/terminals/:id` (#252).
- Seat health surface + `POST /open` (#279, symlink-safe containment #280); seat sign-in probes and
  `login_invocation` passthrough (#281–#284).
- Run archival routes — write off finished history (#266).
- `unitOutputDelta` pass-through on `/ws` (#286).
- DES-PROJECT-001: the Project model ADR (#235).

### Changed
- Consumes `wicked-ledger` and `wicked-studio` from npm instead of vendored copies (#246).

### Fixed
- A malformed ledger row costs that row, not the whole file (#248).
- `wicked-crew-api-types` actually publishes to the npm registry (#253).
- Dependabot alerts cleared (js-yaml, nanoid, #278).

## [0.5.0] — 2026-08-10

E2E-campaign hardening release (FINDING-xxx series) + repo-scoped governance surfaces.

### Added
- Repo-scoped governance coverage — stops reporting the vacuous daemon-store 1.0 (FINDING-009,
  #225) — and a repo code-graph summary read surface in the studio (#227).
- Workflows disclose their human gates before launch (FINDING-023, #220).

### Fixed
- `agent-acp-bridges` is published — without it every released wicked-crew was uninstallable
  (FINDING-096, #213/#214).
- The engine `.node` is verified against its source build before linking (FINDING-090, #216).
- User workflows rehydrate from the overlay dir on restart (FINDING-002, #219); run events
  rehydrate on reload (FINDING-013, #221).
- Workflow mirrors reconciled with core's defs — survey-repo, domain-extraction deliverables and
  coverage pin, domain-graph Tool executor (#218, #222–#224).
- Units say WHY they have no transcript (FINDING-006/097, #215); evidence URLs carry the `/api/v1`
  prefix (#217).

### Changed
- Requires `wicked-core-ts` ^0.5.0 (FINDING-088, #230).

## [0.4.0] — 2026-08-05

### Added
- ACP session elicitation for MCP Path B (DES-002, #200) and the studio operator surface for MCP
  elicitations (#209).

### Fixed
- Child-process output is capped, and says so when it overflows (FINDING-016, #206).
- A rejected workflow registration no longer persists (FINDING-002, #203); crew stops overwriting
  core's seeded drop-in gates (FINDING-084, #201); a pre-existing overlay no longer hijacks every
  run (FINDING-075, #199).
- The declared engine range can actually install the engine (FINDING-088, #204); the core-adapter
  follows core's coverage validator pin (FINDING-009, #202/#205).
- Evidence reads the run's durable event trail instead of re-deriving it (FINDING-014, #170).
- The release pipeline can run crew's cross-repo guards (FINDING-094/095, #211).

## [0.3.2] — 2026-07-30

### Added
- Requirements management modal: server-side search, risk filter, edit rail; statements as
  first-class content (#157, #158); served from the live estate store with the artifact as
  fallback (#160).
- Blast radius + graph navigation (paired with estate#75, #159).

### Changed
- Requires `wicked-core-ts` ^0.2.1 — the older engine rejected banner-prefixed verdicts (#161).

## [0.3.1] — 2026-07-28

### Fixed
- Domain view renders at real scale, with search and collapse (#153); node-click crash guard and
  an actionable empty state (#152).
- Tool-executor phases carry through to the engine (core#120, #150); `launchRun`'s builtin
  once-guard no longer clobbers the baked onboarding def (#151).

## [0.3.0] — 2026-07-27

**The ACP release.** Crew drives coding-agent CLIs over the Agent Client Protocol.

### Added
- ACP bridges: `claude-agent-acp` (#129), the `agent-acp-bridges` package with codex / pi / agy /
  opencode stdio bridges (#136), official/ecosystem adapters adopted where they exist (#138), and
  self-contained bridge installation — no global installs, no symlinks (#137).
- Live token streaming + council deliberation UI (#135); operator-message lifecycle in the run
  thread (#139).
- Run evidence export (#141).
- Durable state home at `~/.wicked-crew/`, agy workspace scoping, the collab builtin, and stall
  surfacing (#143).
- The Playwright studio-verification harness, promoted into the repo (#140).
- Third-party CLI ToS notices + external-transform assumptions UI (#142).

## [0.2.1] — 2026-07-11

### Added
- The wicked-crew skill ships to installed CLIs (#21).
- Studio operator cockpit + insight rail (#12); marketing site at wc.wickedagile.com (#10).
- CI PR gate (lint / typecheck / build / test) and a real eslint flat config (#8, #17).

## [0.2.0] — 2026-07-08

### Added
- The daemon builds and serves the studio SPA same-origin (#7).

## [0.1.1] — 2026-07-08

### Fixed
- The published tarball actually contains `dist/`.

## [0.1.0] — 2026-07-08

Initial release: the crew daemon — a REST `/api/v1` + WS bridge to the wicked-core engine via
`wicked-core-ts`, with a terminal web bridge (browser ↔ daemon ↔ PTY over xterm.js) and the React
studio console pointed at the run-model daemon.

[Unreleased]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mikeparcewski/wicked-crew/releases/tag/v0.1.0
