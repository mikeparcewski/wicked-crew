# Changelog

All notable changes to **wicked-crew** (the daemon package, npm `wicked-crew`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before this file
existed (everything ≤ 0.7.0) are backfilled from git history and release tags; the sibling
workspace packages `wicked-crew-api-types` and `agent-acp-bridges` version independently and are
mentioned only where a daemon release depends on them.

## [Unreleased]

## [0.7.4] — 2026-08-31

### Fixed

- **Failed runs keep their evidence** (wicked-core-ts 0.7.6): rejected units persist their
  partial transcripts, pre-output denies persist an explicit failure record, and `gateEvaluated`
  carries a machine-readable denial ({source, claim_id, rule_ids}) beside the prose — the
  usability review's one blocker, closed at the engine.

### Changed

- `wicked-core-ts` pinned `^0.7.6`; bundled `wicked-studio` `^0.4.4` (the run narrator, the
  dead-end fixes, plain-language failure copy).

## [0.7.3] — 2026-08-31

### Added

- **Testing wire** — `POST /api/v1/testing/evals/run` `{type?, corpus?}` runs the steering-rule
  evals through the engine's real decide()/select() path and passes the serde report through
  verbatim (caught / gap / false_positive verdicts, `nearest_rules` semantic hints on gaps,
  `degraded: "facet-only"|null`), and `POST /api/v1/testing/corpora/import` `{name, samples}`
  ingests an eval corpus into the estate knowledge store under `evals:<name>` with embeddings.
  Both presence-gated on the wicked-core-ts ≥ 0.7.5 `governanceEvals` binding — an older engine
  answers an honest 501 with the upgrade pointer. `wicked-crew-api-types` 0.14.0 (#370).

### Fixed

- The rules browse's retire filter was vacuous for engine-retired rows: `include_retired=true` /
  `status=retired` filtered a listing the engine had already withdrawn retired rules from —
  the adapter now fetches with `includeRetired` and lets the route filter (#370).
- Integration tests survive both engine generations: the auth matrix and the SC-005 deny probe
  ported off the policy write surface that a steering engine 410-folds (#370); WAL-race
  teardowns retry instead of flaking ENOTEMPTY (#373).

### Changed

- `wicked-core-ts` pinned `^0.7.5` (steering + evals engine), bundled `wicked-studio` `^0.4.3`
  (Steering redesign, Testing surface, Settings cleanup).

### Added
- **Governance wiki management wire** (wiki-mgmt): `GET /governance/wiki/scoreboard` — the AW-23
  population/connection scoreboard (typed %, resolving `symbol_ref`s, enforcement evidence, and
  in-band "cannot measure" markers), presence-gated on the core-ts `governanceScoreboard`
  binding (wicked-core-ts ≥ 0.7.4; older addons answer an honest 501 "upgrade the engine", the
  campaigns doctrine) with optional `?docsRoot=` for the doc-side typing half. `GET
  /governance/wiki/meta` — the wiki's honest empty-state signal (`seeded`, `rule_count`,
  `ruleset_count` — `null`, never a fabricated 0, when the engine build cannot count `RuleSet`
  rows — `scoreboard_available`, and `doc` pointing at the seed runbook), served on every addon.
  `GET /governance/rules` grew the browse facets `severity`/`layer`/`rule_type`/`status`
  (exact-match, closed vocabularies 400 loudly; `status` keeps the AW-24 kill switch visible —
  retired rows stay listed with their `retired` flag, `retired`/`active` narrow to one side).
  Retire stays the existing `DELETE /governance/rules/:id` — no second door. Wire shapes
  (`GovernanceScoreboard`, `GovernanceWikiMeta`, `RuleBrowseQuery`) ship in
  `wicked-crew-api-types` **0.12.0**.
- **Campaign budget/runtime governance** (TH-20 / recon test-R22): `CampaignSupervisor`
  (`packages/crew/src/campaign/supervision.ts`) — campaign wall-clock budget, per-node timeout
  (running time only; `awaiting_human` never counts), kill/abandon policy for in-flight nodes,
  and a fail-closed nightly node cap. Budget exhaustion aborts remaining nodes with
  **excluded-with-reason** status — visible in supervision state, as synthetic
  `campaignBudgetExceeded`/`campaignNodeExcluded` `/ws` frames, and in the warn log; never
  silent. Per-node cost (wall-clock always; tokens/USD when the worker CLI reports them) lands
  in the `campaign-supervision.json` evidence artifact so cost regressions diff like verdict
  regressions. TH-8-style env pins: node environments must carry the exact
  `WICKED_UNIT_TIMEOUT_SECS` pin (`assertNodeEnvPinned`, fail-closed — unpinned means the
  engine's 2-hour default). Knob placement records the **P-9 interim decision: crew-side
  supervision**, not `CampaignDef` fields (`docs/campaign-budgets.md`). Wired into the campaign
  routes when TH-9's scheduler exposure lands; until then campaigns run as ordinary governed
  workflows under the documented interim pins.

## [0.7.2] — 2026-08-30

### Added
- **Campaigns live** (TH-9): `POST/GET /api/v1/campaigns` on core-ts >= 0.7.3 bindings,
  WS Campaign* passthrough, durable DAG execution; budget/timeout/kill supervision (TH-20).
- **Architecture-wiki management wire**: `GET /governance/wiki/scoreboard` (core-ts >= 0.7.4),
  `GET /governance/wiki/meta` (honest unseeded state), faceted rules browse incl. retired.
- **AcceptanceView conformance section** (AW-14): run-scoped claims, deny-dominates beside the
  QE verdict, `GovernanceUnenforced` surfaced.
- **session.delivery on the list wire** (closes #321); fastify-route extractor pack (TH-15);
  campaign scenario corpus from e2e/ (TH-23).

### Changed
- Bundles wicked-studio 0.4.2 (Wiki page + campaign scoreboard); engine floor core-ts ^0.7.4.
- Site version stamp injected at build (DT-7).

## [0.7.1] — 2026-08-29

**The release train release.** Bundles the wicked-studio 0.4.1 truth-pass skin, moves the QE
acceptance gate onto the wicked-ledger 2.1 evidence-manifest floor, and — because the npm page
was blank through 0.7.0 — is the first version whose npm page carries a README.

### Changed
- Bundles **wicked-studio 0.4.1** as the default local skin — the devDep bumped explicitly from
  `^0.4.0` (the committed lockfile means the caret never auto-floats; an unbumped pin silently
  ships a stale UI).
- **wicked-ledger floor raised to `^0.4.0`** — the release that carries evidence-manifest 2.1
  (optional `scenario_evidence` block + first-class `claim_level` enum, ledger#7). All ledger
  consumers move in the same wave so no v2.0/v2.1 validator split exists; 2.0 bundles stay valid
  (the manifest bump is additive-minor).

### Added
- Committed **endpoint manifest** (`packages/crew/endpoint-manifest.json`) with a drift test and
  an API-test generator (`manifest:endpoints` / `generate:api-tests`) (#351).
- Estate-migration operability on the project graph: force refresh, per-repo outcomes, stderr
  visibility (#347).
- Root `CLAUDE.md` pointer stub for coding agents (#348).

### Fixed
- Project graphs follow `--db`: an isolated daemon no longer writes project graphs into the real
  `~/.wicked-crew` state root (crew#330, #351).
- QE acceptance ledger honors an absolute `WICKED_QE_LEDGER_DIR` (#348).
- The deliverable floor no longer passes on a PRIOR run's artifact (#346).
- Interactive edit-events scope their declared write root to the handoff that owns it (#345).
- The `studio.*` settings size cap is enforced on the read path too (#344).
- A stub engine never answers another product's bus traffic (#343).
- Pinned the wicked-interactive crew starts; fixed two load-sensitive tests (#331).

### Docs
- `packages/crew/README.md` — the npm package page, blank at every version ≤ 0.7.0, now says what
  the daemon is, how to install it, and where the acceptance gate lives; repo README gained
  Install/Quickstart and the acceptance-gate section (#349).
- Documented the project code graph, which shipped in 0.7.0 undocumented (#332).
- Site: shipped 0.4–0.7 features marketed truthfully + viewport fixes (#350); chrome re-pin,
  scroll-snap and topbar-threshold fixes (#334–#336).

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

[Unreleased]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.0...v0.7.1
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
