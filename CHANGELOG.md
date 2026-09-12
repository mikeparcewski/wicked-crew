# Changelog

All notable changes to **wicked-crew** (the daemon package, npm `wicked-crew`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before this file
existed (everything ≤ 0.7.0) are backfilled from git history and release tags; the sibling
workspace packages `wicked-crew-api-types` and `agent-acp-bridges` version independently and are
mentioned only where a daemon release depends on them.

## [Unreleased]

### Fixed
- **F-E2E-021 — `GET /projects/:id/activity` opened the bus with a SECOND SQLite library and tore
  the daemon's bus connections (#541).** The activity feed read `bus.db` through Node's bundled
  SQLite (`node:sqlite`, read-only, opened and closed per request) while the daemon held six
  long-lived better-sqlite3 connections on the same file. SQLite's locks are POSIX advisory locks —
  released for the WHOLE process when ANY descriptor for the file is closed — and a second library
  instance does not know about the first's connections, so that close dropped every lock the seams
  held. The next short-lived external emitter (`wicked-bus emit`, what wicked-estate spawns after an
  index) then took the EXCLUSIVE lock on its own close, checkpointed, and unlinked `bus.db-wal`/`-shm`
  under the seams: their polls decayed into `database disk image is malformed` every 2 s for the life
  of the daemon (relay + draft/edit/demo/chat seams dead), crew's own emissions went into a ghost WAL
  nobody else could see, and with enough interleaved writes the on-disk `bus.db` itself ended up
  failing `PRAGMA integrity_check` (external `wicked-bus emit`s then fail with the same error). Fix:
  the feed reads through the better-sqlite3 module instance wicked-bus itself loads (resolved from
  wicked-bus's own entry). Rule: **one SQLite library per database file per process.** Regression
  test drives the exact sequence with the real `wicked-bus emit` CLI as the external emitter.
  **Remediation for a daemon already showing the loop** — the fix prevents recurrence, it cannot
  repair a torn store: exit the daemon WITHOUT closing its bus connections (crew's SIGTERM/SIGINT
  path already does exactly that — `process.exit` with no `close()`; a graceful close of the last
  ghost connection would checkpoint the ghost WAL into the file), then restart on a build with this
  fix; if `PRAGMA integrity_check` on `bus.db` fails from a fresh process, the store is torn —
  restore or rotate it.

### Added
- **Connection-fatal bus subscriber errors now reach `GET /diagnostics.recentErrors` (#542 — the
  visibility half of F-E2E-021).** Every wicked-bus seam (interactive relay / draft / edit / demo /
  chat, the project `/ws` bridge, the QE gate feed) logged its subscriber errors through `log` →
  `app.log.warn`, and the diagnostics error ring folds error-level lines only — so six dead
  subscribers looping on `database disk image is malformed` for hours left `recentErrors: []`. A
  shared reporter (`src/interactive/bus-subscriber-errors.ts`) keeps each seam's own warn line for
  ordinary errors and escalates a connection-fatal one (`SQLITE_CORRUPT` / `SQLITE_NOTADB` /
  `SQLITE_IOERR*`, or wicked-bus's `WB-014 SUBSCRIBER_DB_UNUSABLE`) to `logError` → `app.log.error`
  on the 1st and every 30th consecutive occurrence, with the count, whether it is the subscriber
  connection (poll) or the seam's handler, and the operator remediation (restart — the daemon's
  shutdown exits without closing bus connections; a `bus.db` failing `PRAGMA integrity_check` from a
  fresh process is torn and must be restored/rotated). A fatal error more than two poll intervals
  after the previous one starts a new outage and escalates at its 1st again. **Scope: the error-level
  log line and `/diagnostics.recentErrors` only** — `/health` stays unconditional and the studio Health
  rail does not read `recentErrors`; a `/diagnostics.bus` findings block and the studio fold are the
  wave-7 follow-up.
- **`deliverGate: 'human' | 'auto'` on `POST /runs` (acceptance finding F-E2E-030).** Run
  `0ab5ccb8` launched under the studio's default posture (`humanConfirm: before:1`) pushed its
  branch and opened wicked-studio#268 with no human gate, under whatever gh account the daemon
  held. The ENGINE now gates the composed `deliver` Tool unit by default (wicked-core#456:
  `LaunchOptions.autoDeliver`, core-ts ≥ 0.7.24). The daemon maps ONLY an explicit
  `deliverGate: 'auto'` to the engine's opt-out (`LaunchRunInput.autoDeliver: true`); omitted,
  `'human'`, and `humanConfirm: 'none'` all leave the gate in place — the wire never has to say
  "gate me" to be gated. Unknown values 400. Additive: `LaunchRunBody.deliverGate` and
  `AgentSession.auto_deliver?: boolean` (absent on runs from an engine that predates the gate)
  on `wicked-crew-api-types`; the adapter sends `autoDeliver` to the addon only when true, so an
  older addon (which has no deliver gate to opt out of) behaves exactly as before.

## [0.7.32] — 2026-09-12

Release train (hotfix after the clean-run Phase 2 blocker) — **core-ts 0.7.23 / studio 0.5.8 /
api-types 0.36.0 / bridges 1.1.1.** Pins the published `wicked-core-ts` `^0.7.23` engine
(wicked-core #452 / #453): **F-7R3-001** — quota-exhausted / rate-limited / not-installed /
timeout-streak seats are benched for the RUN (a refusal-frame classifier decides; `BenchedSeat.reason`
is free text to render, never parse; `UnitEvidence.judge_refusals` is additive) so
`evaluator_distinct` never seats a dead seat, and **F-E2E-011 (engine half)** — tool-only plans need
no CLI seat, so an empty eligible set is no longer refused when every unit is `executor: tool` (the
onboarding fix the crew half below proves against the real engine). Bundles the same published
`wicked-studio` 0.5.8 skin as 0.7.31 (built against `wicked-crew-api-types` 0.36.0), keeps
`wicked-crew-api-types` 0.36.0 (not re-bumped, not re-tagged; the `BenchedSeat.reason` doc refresh is
a wave-7 api-types cut) and `agent-acp-bridges` `^1.1.1` and `wicked-interactive@^0.9.1` unchanged.

What merged since 0.7.31 — **#539** (F-E2E-011 crew half: the onboarding launch test against
the real engine; F-E2E-013: the read-only, run-scoped `GET /runs/:id/acceptance`). Every entry below
belongs to it.

### Fixed

- **F-E2E-011 (crew half) — onboarding is now proven against the REAL engine, not a stubbed
  launch.** crew#533 (F-2R2-010) made `seatsForWorkflow('onboarding')` return `[]` and pinned it with
  a unit test over a stubbed `launchRun`; nothing ever handed the seeded def plus `clis: []` to the
  engine, so its composition with wicked-core's plan-time seat check
  (`distribute_units_against_benched`, #449) shipped unseen — on 0.7.31 + core-ts 0.7.22 every
  `Register & onboard` failed ~1 s
  after launch ("council distribution failed: no eligible seat … every configured seat is benched")
  before a unit ran, on every repo. `tests/integration/onboarding-launch.test.ts` registers a scratch
  git repo over `POST /repos` (the studio's path), lets the daemon launch onboarding with the seat
  pool it hands the engine in production (none), and requires the run to get PAST distribution to
  its first tool unit — `sessionStarted.cliCount === 0`, no seat refusal, `index` dispatched and the
  (shimmed, temp-dir) `wicked-estate` actually invoked with the run's bound `{repo_root}` /
  `{code_graph_db}`, run `completed`. `seatsForWorkflow()` is unchanged (F-2R2-010 stays fixed); the
  engine side — tool-only plans need no seat — is wicked-core's F-E2E-011 fix (wicked-core #453),
  which the `wicked-core-ts` `^0.7.23` pin of this release ships; crew's CI builds core-ts from core
  main, so the test was red until #453 landed there.
- **F-E2E-013 — `GET /runs/:id/acceptance` is READ-ONLY and never attributes a verdict the run did
  not produce.** The route opened the repo's QE ledger as a `DomainStore` and "healed" its index:
  on a checkout carrying a committed legacy `.wicked-testing/` that CREATED `wicked-qe.db` (+ WAL/
  SHM) inside the customer's clone, ran a stale-run sweep, bulk-inserted every canonical row
  (failing on legacy scenarios without `format_version` — the `[wicked-ledger] SQLite write failed`
  lines), and then served the store's newest verdict as the run's: an onboarding run that failed at
  plan time answered `gate.verdict: PASS` with a July-2026 QE verdict. The reader
  (`src/qe/ledger.ts`) now reads the ledger's canonical JSON directly — the ledger's own JSON-only
  semantics (`*.json`, in-flight `.tmp.*` skipped, soft-deleted dropped, `created_at` desc) —
  creates, modifies and removes nothing (byte-identical tree, `git status --porcelain` empty), and
  scopes the read to THE RUN: a verdict is attributed when the caller pins its QE run (`?qeRun=`),
  when the ledger run/verdict is stamped `crew_run_id` with the crew run id (what a QE writer
  inside a governed run sees as `WICKED_RUN_ID`), or when its QE run started inside the crew run's
  recorded lifetime (`sessionStarted` → terminal frame, from the durable event log); the newest
  attributed verdict governs. Nothing attributed ⇒ `acceptance.verdict: null`, `gate.verdict: null`,
  and a denial naming what the ledger DOES hold ("holds 1 verdict, newest PASS (…) at …, recorded
  before this run started (…)"); a record that is not valid JSON is surfaced as
  `acceptance.error` + "unreadable ⇒ deny", never skipped into a cleaner answer. The body gains
  `acceptance.attribution` (`pinned` | `stamped` | `run-window` | `none` + reason) and
  `acceptance.ledgerVerdicts` (additive). Tests: `tests/integration/acceptance-readonly.test.ts`
  (clean checkout byte-identical + "no ledger"; committed legacy ledger byte-identical, old PASS not
  attached to a fresh run nor to the observed onboarding shape; pin + containing-lifetime positive
  controls; truncated record ⇒ named deny), plus the re-storied route / functional / reader suites.
  - Review round (independent adversarial review of #539, F1–F6): the run's lifetime closes at the
    FIRST terminal frame anywhere in its log, and the terminal set is pinned from the engine's
    source — `sessionCompleted` / `sessionFailed` / **`runCancelled`** (the first cut named a
    `sessionCancelled` frame the engine never emits, so a cancelled run's window never closed and
    any later QE PASS on the repo was attributed to it — F1); a non-terminal frame after the
    terminal one never reopens the window (F4); deny-dominates holds ACROSS the attributed QE runs
    (each QE run's newest verdict is its current judgment; any non-PASS among them denies — a later
    PASS on scenario Y cannot mask a FAIL on scenario X inside the same crew run — F2), with
    `acceptance.attributedVerdicts` (additive) counting that set; a QE run with no dated run row is
    never placed by inference — stamp or pin only — and the denial says how many were skipped (F3);
    an unreadable event log is named as such instead of "no sessionStarted" (F5); `run-window`
    linkage is labelled **INFERRED** in `gate.reason` (`describeAttribution`), so an operator can
    tell it from a writer's `crew_run_id` stamp or a caller's pin (F6 — garden's QE runner stamping
    `WICKED_RUN_ID` is a wave-7 follow-up). Round 2 (N1): a `resumed` frame after `sessionFailed`
    REOPENS the window until the run's next terminal frame — a failed run rescued with
    `POST /runs/:id/resume` completes under the same id, and the QE evidence it records after the
    rescue is its own (the first-terminal rule had denied it as "outside this run's lifetime");
    `sessionCompleted` and `runCancelled` stay final, because the engine refuses to resume either.
    Round 3 (N3): the reopen also fires on the rescued run's first execution frame
    (`unitDispatched` / `unitExecuting` / `toolExecutorDispatched` / `unitDistributed`) — the
    engine's resume path emits no `resumed` frame (that frame is gate approval's), so a rescued
    run's LIVE segment no longer reads as closed at the failure while it is still executing.

## [0.7.31] — 2026-09-12

Release train (wave 6) — **core-ts 0.7.22 / studio 0.5.8 / garden 12.34.0 / interactive 0.9.1 /
api-types 0.36.0 / bridges 1.1.1.** Pins the published `wicked-core-ts` `^0.7.22` engine
(wicked-core #448 / #449 — wave-6 governance: the worker remote-write fence + credential / ssh strip,
health-aware routing with `degradedReason`, the default repo-checks floor + judge or an honest
UNGATED gate, the `auth_failed` / `unauthenticated` fallback kinds, the run branch + worktree
retention; its `AgenticCli.health {usable, reason?}` shape is what F-086 below translates at every
launch seam), bundles the published `wicked-studio` 0.5.8 skin (built against `wicked-crew-api-types`
0.36.0: the governed "New test" journey, the Test landing reading this daemon's top-level
`test_sets`, honest UNGATED / degraded gate cards, the branch-sourced files view), rides with
`wicked-garden` 12.34.0 (the qe `author` / `review` verified-test contract the `qe-author-tests`
workflow routes to), and keeps `wicked-interactive@^0.9.1` and `agent-acp-bridges` `^1.1.1`
unchanged since 0.7.30. The sibling workspace package `wicked-crew-api-types` 0.36.0 was published on
the #536 merge (`api-types-v0.36.0`) and is not re-tagged here.

What merged since 0.7.30 — **#535** (F-083: a generation published under older portability rules is
accepted with a `skills.stale-rules` warning), **#536** (wave 6: the governed `qe-author-tests`
workflow + `POST /testing/author`, test sets, the branch-sourced diff, reassign on `awaiting_human`,
the roster → engine translation, the interactive docs index, `refused[]` with `source`, the
credential-probe `auth`, api-types 0.36.0), **#537** (F-086: the campaign seam translates roster
standing). Every entry below belongs to one of them.

### Added

- **"New test" is a governed QE workflow, not a free-text plan (wave 6 — F-7R2-003/004/005/008/012/
  013/014/015, acceptance R4-r2, F-075).** The studio's "New test" used to `POST /testing/recon` a
  plain governed run: the planner split the brief at sentence boundaries into seven agent units
  (two of them chat replies), every gate was a default-allow, no `skill_ref` routed the QE domain,
  no deliver phase ran (the LAST worker opened the PR from its own shell — invisible to the
  ledger), no campaign was registered (the Test landing stayed empty), and the produced Playwright
  e2e was never executed by the run (it failed at its first check on the first independent run).
  - **`qe-author-tests` drop-in workflow** (`packages/crew/src/qe/author-workflow.ts`, served from
    `GET /workflows`, operator-selectable): `recon` (agent, `wicked-garden-qe` plan) → `author`
    (agent CREATOR, `executes_code`, evidence-floor pinned, `wicked-garden-qe` author: behaviour
    tests against the repo's own harness + `tests/PLAN-<slug>.md`) → `verify` (a TOOL phase that
    RUNS the repository's own checks INCLUDING every produced test — vitest/jest/pytest/Playwright
    detected from the repo, a repo-local `node_modules/.bin/<tool>` preferred — and FAILS the unit
    when a produced test fails, was never executed, or no PLAN was produced; the report rides the
    transcript as `QE-VERIFY:` / `QE-VERIFY-SUMMARY:` lines) → `review` (agent EVALUATOR,
    `wicked-garden-qe` review, `human_confirm_if: verdict_not_pass`). Delivery is the ENGINE's
    deliver phase appended per run (`deliver: "pr"` — the crew#393 code-work default), never a
    worker's `gh pr create`. Validated by the engine as authored (wicked-core#414).
  - **`POST /testing/author`** launches it: `repoRefs`/`projectId` scope (must resolve to ≥ 1 repo),
    the operator's intent as the problem statement, one run per repo, each paused at its intake
    gate unless `ungated: true`, filed under a `qe-tests-<repo>` label group; the 201 carries the
    PLAN the intake gate shows (phases with kind/role/agent|tool/skill/gate + the engine's deliver
    phase, and the seats a council may pick from — F-7R2-008). `POST /testing/recon` is unchanged.
  - **A NARROWED project scope on `POST /testing/author`** (studio #263 review, F-4): with both
    `projectId` and `repoRefs`, the repos are the SCOPE and the project is the FILING — the runs are
    filed into the project without inheriting its other repo members (unlike `POST /testing/recon`,
    where both union), so a skin with repo chips names them once instead of fanning one `POST /runs`
    (one deliver/PR) per repo. The 201 says which was used (`scope: 'repoRefs' | 'project'`).
  - **`GET /interactive/docs`** (studio #263 review): every interactive document across projects,
    listed by the daemon from disk WITHOUT spawning a bridge — each project's docs root (its own
    `interactiveRoot`, else `WICKED_INTERACTIVE_ROOT`, else the default root / `projects/<id>`
    partition), each slug child carrying a `versions.json`, by the bridge's own `listDocs` rules
    (`kind` defaults to `doc`, `updatedAt` = the head version's `created_at`, tombstones only with
    `?includeRetired=1`) — plus the seams that answered each doc and the runs they launched (from
    the handoff ledgers). `{docs, unreachable}`: a root the daemon could not read is named, never
    dropped; a shared root lists once. The per-project `GET /projects/:id/interactive/api/docs`
    still spawns one bridge per project (≈60 s cold start) — this is the listing a skin mounts with.
  - **Test sets on `GET /campaigns`** (`test_sets`, F-7R2-014): a terminal `qe-author-tests` run
    registers the produced tests as the verify phase judged them (files, harness, executed/passed/
    failed counts, the PLAN, the delivered PR) — a durable `testing.testset.registered` audit entry
    hydrated at boot. A failed verify registers `verified: false` (shown red, never hidden).
  - **`GET /runs/:id/diff` serves a reaped worktree from the run branch** (F-7R2-013): when the
    engine has reaped the worktree, the diff is read from the registered repo's `wicked/<id>`
    branch against the engine's recorded `base_commit` (else the merge-base with the default
    branch) — `source: 'branch'` (+ `branch`, `base`); the live worktree read carries
    `source: 'worktree'`. 409 now means "no worktree AND no run branch".
  - **`POST /runs/:id/reassign` on an `awaiting_human` run** (F-7R2-007): the engine's
    `reassign_unit` accepts only an Executing run, so the route performs approve-then-reassign in
    ONE call (audited as `gate.decided {via: 'reassign'}` + `run.reassigned`); the dead seat is
    dispatched for the gap between the two engine calls — a bounded window the engine contract
    leaves open. A steering-author propose gate is refused (its approve lands the proposal).
  - **`document_id` on the run DTO + `GET /runs?doc=`** (F-4R2-006): the doc ↔ run binding read
    off the interactive seams' handoff ledgers, no more `extra_write_roots` parsing in the skin.
  - **`status.posted` frames carry `run_id` + `unit_ord`** (F-4R2-005): every seam narration line
    and heartbeat is keyed per run and per unit.
  - **The narrator consumes the wave-6 engine fields**: `unitDistributed.degradedReason` (now set on
    every routing arm when seats are benched), `gateEvaluated.ungated`/`ungatedReason` ("Gate for
    author: UNGATED — …", never "approved"), `workerToolCallDenied` (who, the refused command, the
    remedy), and the `auth_failed`/`unauthenticated` `acpFallback` kinds (the seat is benched, not
    "dropped").
  - **The roster crew hands the engine is translated** (`core/engine-roster.ts`, the crew half of
    F-7R2-006): crew's `GET /roster` readings (`health {status}`, `auth`, `council_eligible`, …) are
    stripped from `clisJson` at launch and `council_eligible: false` becomes the wave-6 engine's
    `AgenticCli.health {usable: false, reason}` bench verdict — a round-tripped crew `health` would
    otherwise fail the wave-6 engine's deserializer under the same key. `POST /runs`' default roster
    and the testing launches carry the standing.
  - **A seat's `auth` comes from a credential PROBE, and the seat's own words override it
    (F-A45-006, F-2R2-009 follow-through).** The roster read pi `signed_in: true` off a PRESENT but
    EMPTY `auth.json` (`{}`) while every ballot failed "No API key found". The codex / opencode / pi
    probes now need a credential-SHAPED file (a non-empty secret under a `key`/`token`/`access`/…
    key at any depth; `{}`, a bare type marker, malformed JSON all read signed out), and the
    seat-health fold records the seat's OWN "no credential" report — a `councilSeatFailed`
    `not_logged_in` / "No API key" ballot, a worker's 401 / "Not logged in", an `auth_required` /
    `auth_failed` / `unauthenticated` ACP fallback — which flips `auth` to `signed_out` (not only
    `council_eligible`) for 30 minutes or until an ok output, with `auth_source: 'seat-stderr'` +
    `auth_evidence` on the roster seat and in the council-ineligible reason.
  - **Every seat a chat did not seat is named, whatever dropped it (F-A45-011, F-2R2-007 closed).**
    A default seat the ENGINE dropped at dispatch (absent from `seats` altogether — the fresh rig's
    pi, taken out by the council-bench / dispatch-timeout path, not by scope admission) answered a
    201 with `refused: []`. `POST /chats` now names every requested-or-defaulted seat that is not
    warm, with a `source` — `auth` (the seat's own "no credential" report or the probe), `scope`
    (the scoped-chat rule), `bench` (this daemon's council bench), `budget` (the engine did not warm
    it within its dispatch budget), `engine` (the engine's own refusal) — on the 201, on
    `GET /chats/:id` (`refused`, kept with the scope), and as one `chatSeatRefused` thread frame each.
  - **`wicked-crew-api-types` 0.36.0** (additive over 0.35.0): `ChatRefusalSource` +
    `ChatSeatRefusal.source?` / `ChatSeatRefusedFrame.source?`, `ChatDetailResponse.refused?`,
    `RosterSeat.auth_source?` / `auth_evidence?`; the F-083 hotfix's (crew#535) wire —
    `DiagnosticsSkillsFinding.kind` gains `skills.stale-rules`, `SkillsManifestResponse.current`
    gains `rules?` (`PortabilityRulesIdentity` recorded/running + `stale`) and `drift?`
    (`SnapshotRowDrift[]`); the #449 review-fix wire (`@ 9e11685`): `GateEvaluatedEvent.floorNote?`
    / `judgeSkippedReason?` (the per-layer reasons beside `ungated`), `RepoChecksEvaluatedEvent.sandboxLevel?`
    / `sandboxError?` / `detectError?` (an empty `checks` says WHY — the deliver text renders
    "0 checks detected" with that reason, never "checks ran"), `BenchedSeat.source` gains `judge`;
    `UnitDistributedEvent` now declares
    the camelCase names the engine EMITS (`routingMethod`, `agreementPct`, `returned`, `seated`,
    `dissent`, `degradedReason`, `seatConstraint` — the snake_case names stay one minor as
    `@deprecated` optional aliases; a wire-contract test pins the interface against wicked-core-ts's
    own `UnitDistributedEventJson` and a recorded frame); `GateEvaluatedEvent.ungated?` /
    `ungatedReason?`; `WorkerToolCallDeniedEvent` (in `GateEvidenceEvent`); `AcpFallbackKind`
    `auth_failed` / `unauthenticated`; `RunBaseResolvedEvent.runBranch?`; `AgentSession.document_id?`
    / `run_branch?` / `base_commit?` / `finished_at?` / `benched_seats?` (+ `BenchedSeat`);
    `RunDiff.source?` / `branch?` / `base?`; `TestingAuthorBody` / `TestingAuthorResponse` /
    `WorkflowPlan` / `WorkflowPlanPhase` / `TestingAuthorRun` / `QeAuthorTestsWorkflowId`;
    `TestSet` / `TestSetFile` + `CampaignsListResponse.test_sets?`; `InteractiveStatusPosted.run_id?`
    / `unit_ord?`; `TestingAuthorResponse.scope?` + the narrowed-scope semantic on
    `TestingAuthorBody.repoRefs`; `InteractiveDocsListing` / `InteractiveDocIndexRow` /
    `InteractiveDocsUnreachable` / `InteractiveSeamKind` (`GET /interactive/docs`). Endpoint manifest
    + generated API tests re-stamped. The ONE type-level narrowing: the permissive
    `CoreEvent.agreementPct` widens `number` → `number | null` (the engine emits `null` on
    `unitDistributed`) — arithmetic on it now needs a null check.
  - **Independent review of #536 (REVISE → applied):** the verify phase never runs a test-shaped
    `.py` as a plain script and never `npx`-fetches a runner — a missing/unrunnable harness
    (pytest, vitest, jest, Playwright) is NOT EXECUTED with "harness not available: <tool> — <remedy>",
    and every executed file must show ≥ 1 test in the runner's own summary (exit 0 with 0 tests
    reported = not executed); harness detection is per file, walking up to the nearest package /
    pytest marker dir (monorepos), with the runner and the full-suite check run from that dir;
    `POST /testing/author` honours `deliverDefault` (+ `deliverDefaulted` on the trail) exactly as
    `POST /runs`; the auth-refusal and seat-failure patterns match a 401 only as an HTTP status
    (a bare `401` in a stack-trace line number benched a healthy seat for 30 min); `branchDiff`
    falls back to `refs/remotes/origin/<branch>` when retention pruned the local run branch; a
    `runCancelled` `qe-author-tests` run registers its test set too; credential-file key names are
    matched whole (`keyring` / `apiVersion` are not credentials).

### Fixed

- **F-083 — a skills generation published under OLDER portability rules is accepted with a
  `skills.stale-rules` warning, never refused.** Upgrading a daemon whose `current` generation was
  published by 0.7.29 (the first-hit detector) to 0.7.30 (#532's tightened rules) made the store's
  row cross-check ("skill row X claims portable: false, but its files derive true") refuse the
  generation: `skills.state = config-error`, `WICKED_SKILLS_SNAPSHOT` pointed at
  `<root>/refused/skills.config`, and every seat launched with NO skills until an operator
  re-published. A detector-rule change is not tampering; an upgrade must never brick the skills
  root. Every publish now records the portability rules identity in `snapshot.json`
  (`rulesVersion` = the canonical fixture's `version`, `rulesSha256` = the digest over the live rule
  table — `PORTABILITY_RULES_IDENTITY` in `refs.ts`, asserted equal to
  `tests/fixtures/portability_rules.json` by the parity test, so the runtime never reads a test
  fixture). On load, a generation whose recorded identity differs from the running one — or
  predates the field, i.e. every pre-0.7.31 snapshot — stays `published` and the engine input; its
  rows are re-derived under the current rules and the ones that derive differently are reported
  beside the identities on `GET /skills` → `current.rules` / `current.drift` (additive; the immutable
  snapshot is never rewritten), and ONE `skills.stale-rules` WARNING names up to five of them with
  the remedy: `POST /skills/publish`, which records the running identity and clears the warning.
  Refusal is reserved for tampering — a content or metadata hash mismatch under any rules, a
  malformed identity pair, or a row that derives differently under the SAME recorded rules. The
  warning also states the seat consequence (independent review M1): the engine admits and delivers
  by the snapshot's RECORDED rows until the re-publish — a row listed false → true stays
  Claude-only, a row listed true → false is still delivered to non-Claude seats (named when
  present); and when the generation is stale the daemon re-derives the EDITOR manifest
  (`GET /skills` rows) under the running rules at boot, committing only when a derived value moved
  (review M2 — the rows and `current.drift` answer from one rule table; the snapshot is never
  rewritten). Rule for maintainers (review L1): the identity's digest covers the rule TABLE, not the
  detector code — bump `PORTABILITY_RULES_VERSION` (and regenerate the parity fixture) whenever
  detector semantics change so a row could derive differently, or the next upgrade refuses those
  rows as tampering. Wire note: `skills.stale-rules` and `current.rules` / `current.drift` landed on
  main ahead of their `wicked-crew-api-types` declaration; `wicked-crew-api-types` 0.36.0 (above, in
  this release) declares them and `tests/wire-contract.test.ts` pins the finding kind both ways.
- **F-086 — a campaign built from the roster WITH crew's standing launches on core-ts ≥ 0.7.22.**
  `POST /testing/recon` with two or more repos registers an engine campaign whose node
  `run_spec.clis` came from `rosterWithStanding()` — every seat decorated with crew's `health
  {status}`, `auth`, `council_eligible` readings — and `CoreAdapter.launchCampaign` handed that def
  to the engine verbatim. core-ts 0.7.22 (wicked-core#449) parses `AgenticCli.health` as
  `{usable, reason?}`, so the launch was refused (`defJson is not a valid CampaignDef: missing
  field \`usable\``) and the recon answered 500 where a 201 was owed (crew main CI red at 537c296;
  `tests/integration/recon-fanout-campaign.test.ts`). The campaign seam now translates every node's
  roster exactly as `launchRun` does (`engineCampaignDef` beside `engineRosterJson` in
  `core/engine-roster.ts`): crew's readings are stripped and `council_eligible: false` becomes the
  engine's per-seat bench verdict — on a copy, so the route's audit record and the recon response
  still read the def as built. Not parity only: `POST /campaigns` and the steering-author launch now
  take the roster WITH crew's standing and bench every ineligible seat — signed out, inactive after
  a seat-level error, not enabled for council (disabled), or benched by recent councils — up front,
  exactly as `POST /runs` and `POST /testing/*` already do; a campaign node or a steering-author run
  never convenes a seat crew already knows cannot answer. Wire note: the def the engine persists
  (`GET /campaigns/:id` → `def.nodes[].run_spec.clis`) carries the engine-shaped `health {usable}`
  from now on, never crew's readings.

## [0.7.30] — 2026-09-11

Release train (wave 4/5) — **core-ts 0.7.21 / studio 0.5.6 / interactive 0.9.1 / garden 12.33.0.**
Pins the published `wicked-core-ts` `^0.7.21` engine (wicked-core #442 / #443 / #444: every seat
that receives a skills delivery is also handed `WICKED_GARDEN_ROOT` + a `PATH` prefix; over ACP the
skills lever is judged from the seat binary, so pi behind `pi-acp` receives `WICKED_PI_SKILL_DIRS`
with the SET / EMPTY / UNSET contract; the codex skills lever populates the engine-minted
`CODEX_HOME/skills` from the pinned snapshot; the creator write posture is derived per unit from its
role — F-4R2-004), bundles the published `wicked-studio` 0.5.6 skin (built against
`wicked-crew-api-types` 0.34.0 — reassign-to-seat + retry on a failure-escalation gate, the
wicked-core#431 wire on the gate card / delivery card / run head; the 0.35.0 roster fields below are
read defensively when this daemon sends them), follows `wicked-interactive@^0.9.1` (F-081 — the
compiled `^0.8.1` floor had frozen the bridge) and rides with `wicked-garden` 12.33.0 (the cross-CLI
skills-portability convention + launcher; garden's lint vendors this release's
`portability_rules.json`). The sibling workspace packages were published AHEAD of this cut:
`wicked-crew-api-types` 0.34.0 (`api-types-v0.34.0` on the #532 merge) and 0.35.0
(`api-types-v0.35.0` on the #533 merge); `agent-acp-bridges` 1.1.0 (`bridges-v1.1.0`, #532) and
1.1.1 (`bridges-v1.1.1`, #533) — crew's dependency range is `^1.1.1`. This is the first crew release
cut through wicked-ci v1.2.0 with `arm_checks_sandbox: true` (#530). What merged since 0.7.29 — the
detailed entries follow under Added / Changed / Fixed:

- **#530** — release workflow: pin wicked-ci v1.2.0 by SHA and opt into its checks sandbox
  (`arm_checks_sandbox: true`) instead of the #529 `install_cmd` prefix (workflow only, no daemon
  change).
- **#532** — skills portability is reported per reason (validator; F-079, crew#531); api-types
  0.34.0; a pi seat receives the skills snapshot over the ACP carrier (`agent-acp-bridges` 1.1.0 +
  the `wicked-pi` launcher).
- **#533** — daemon honesty, wave 5: the legacy outbox is attributed to the daemon that owns it,
  `POST /chats` names every seat it refused, `GET /repos/:id/graph` says why there is no graph, the
  roster says what "signed out" means per seat (+ council eligibility learned from the engine),
  degraded councils are narrated as such, an onboarding run's seat pool is its workflow's, the
  interactive bridge follows `^0.9.1` (F-081) with the `WICKED_INTERACTIVE_SPEC` range override;
  api-types 0.35.0; `agent-acp-bridges` 1.1.1 (the three-state pi skills env contract).

### Added

- **Skills portability is reported per reason, not as one bit (F-079, wicked-crew#531).** The
  publisher's portability rule is now a VALIDATOR that names every reason a skill's text cannot be
  followed on a non-Claude CLI — `plugin-root`, `skill-dir-var` (`${CLAUDE_SKILL_DIR}`, new),
  `cwd-script`, `relative-link`, `cross-skill-path` (a path into another skill's directory, new)
  and `requires-harness:claude` (declared by the author under `metadata.requires-harness`, new) —
  with `file:line` evidence. The manifest entry and the `snapshot.json` row carry
  `portability {portable, reasons (sorted unique), evidence (≤ 5 anchors)}` beside `portable`
  (unchanged: still the admission key core reads; the copilot view is still exactly the portable
  rows); verify re-derives the reasons from the generation the way it already re-derived `portable`.
  Writes warn ONCE PER REASON (`non-portable` findings carry `portabilityReason` and the line).
  The detector is tightened so authoring rules alone decide: a cwd-relative script counts only when
  the file exists at the plugin root (a path inside the skill's own directory is the base-directory
  idiom every CLI shares; `go test ./...`, `npx @axe-core/cli`, `python3 tests/x.py` are not plugin
  files), a `../` link only when its target exists in the bundle and leaves the skill's own tree,
  matches inside non-shell code fences are ignored, and the `wicked-garden run|python|path`
  launcher forms are portable. The rule table is committed as the parity fixture
  `packages/crew/tests/fixtures/portability_rules.json`, vendored verbatim by wicked-garden's own
  lint (a drift is a failing test in both repos). Older `portable`-only manifests and generations
  still load.
  - **`wicked-crew-api-types` 0.34.0** (additive): `SkillPortabilityReason`, `SkillPortability`,
    `SkillEntry.portability?`, `SkillConflictFinding.portabilityReason?`; endpoint manifest +
    generated API tests re-stamped.
- **A pi seat receives the skills snapshot over the ACP carrier (`WICKED_PI_SKILL_DIRS`).**
  `agent-acp-bridges` **1.1.0** honours the variable wicked-core#441 sets — the snapshot's
  deliverable portable skill dirs, OS-path-delimited — as `--no-skills --skill <dir>…` ahead of
  pi's own arguments: in `runBridge` for any bridge that spawns `pi`, and through the new
  `wicked-pi` launcher bin, which the daemon hands to the community `pi-acp` adapter via
  `PI_ACP_PI_COMMAND` at boot (an operator's own value is respected). Unset → the pi launch is
  unchanged. **Requires `agent-acp-bridges` ≥ 1.1.0 on the registry** (`bridges-v1.1.0`, cut
  BEFORE the crew release that ships this): a published crew resolving 1.0.0 warns once at boot
  and a pi seat over ACP receives no skills, exactly as before. The `wicked-pi` process is known
  to the orphan reaper.

### Changed

- **The release workflow calls wicked-ci v1.2.0 and opts into its checks sandbox (#530).**
  `.github/workflows/release.yml` now pins `node-release.yml@2346ba60 # v1.2.0` (the last caller
  still floating on `@v1`) and sets `arm_checks_sandbox: true`, so the reusable workflow itself
  installs `bubblewrap`, lifts the ubuntu-24.04 AppArmor gate on unprivileged user namespaces and
  smokes `bwrap … /bin/true` before the test job — the sequence #529 had folded into this caller's
  `install_cmd` as a stop-gap after the `v0.7.29` tag's first release run went red on deliver-e2e
  (`no OS write boundary could be armed`, wicked-core#433) while PR CI was green. `install_cmd` is
  back to `node scripts/fetch-core-checkout.mjs && npm install`. No daemon change; the `v0.7.30` tag
  is the first run that proves the reusable step.

### Fixed

- **Daemon honesty, wave 5 (Phase 2 / Phase 4 re-run findings F-2R2-005 … -010, F-4R2-007).**
  - **`governance.legacy-outbox` is scoped to the daemon that owns it (F-2R2-006).** The probe keyed
    on `$HOME/.something-wicked/wicked-apps/emit-outbox.ndjson` — a file EVERY daemon on the host
    shares through HOME — so a fresh, isolated state home reported another daemon's 1.4 MB of dead
    letters as a warning and the Health rail offered a replay that would have imported them. The
    probe now attributes the file: a daemon running in that HOME's DEFAULT state home
    (`~/.wicked-crew`) owns it (its earlier versions spooled there — warning, replay recipe,
    unchanged); any other state home gets an `info` finding labelled "found under HOME — shared
    across daemons on this host; not this daemon's" with NO replay command, and the boot log says
    the same. `deadletters.legacyOutbox.scope` (`own` | `host`) carries the attribution. Per the
    independent review of #533: `host` reads "cannot be attributed to this daemon" (an isolated
    daemon that ran since before the fix may have spooled there too — nothing in the file says
    which), and the info finding keeps the read-only `wicked-crew governance replay <path> --dry-run`
    inspect recipe while withholding the replay.
  - **`POST /chats` names every seat it did not seat (F-2R2-007).** A project-scoped open dropped pi
    with no trace (its ACP adapter asks no permissions). The response now carries
    `refused: [{cliKey, reason}]` — every DEFAULT seat the daemon's admission dropped and every
    REQUESTED seat the engine refused — and one `chatSeatRefused` frame per seat is broadcast on
    `/ws` right after the open, so the thread and the scope card can say why a seat is missing.
  - **`GET /repos/:id/graph` says why there is no graph (F-2R2-005).** `{graph: null}` alone could not
    tell "not indexed" from "empty"; the response now carries `reason` — the repos wire's own
    finding text when the engine has one (`in_tree_code_graph_ignored`,
    `code_graph_root_unresolvable`, also returned as `finding`), else the daemon's sentence naming
    the onboarding route.
  - **The unbound-project-graph copy is a person's sentence, and a chat is not a "repo-less run"
    (F-2R2-008).** A 9-repo project chat read "Project proj_… has 9 repo member(s) but no code
    graph yet. Build it with POST /api/v1/projects/<id>/graph/refresh. This repo-less run gets no
    code graph." It now reads "This project's code graph has not been built yet — build it from
    the project page (9 member repositories). Chat still reads the repositories directly." The
    route rides on a machine field instead: `ProjectGraphStatus.action` and
    `ChatScope.graph.action` = `projects.graph.refresh`. And the project graph now FOLLOWS the repo
    graphs: when an onboarding run this daemon launched completes, every project the repo is a
    member of gets a plain (never forced) refresh — one project at a time, unchanged members skip,
    coalesced with any in-flight refresh (one extra round when the coalesced refresh had already
    passed the repo), off the request path, logged.
  - **The roster says what "signed out" MEANS per seat (F-2R2-009).** `GET /roster` seats gain
    `auth` (`signed_in` | `signed_out` | `not_required` | `unknown` — opencode answers on its free
    tier with no account, so its `signed_in: false` is `not_required`, with `free_tier` naming it),
    `council_eligible` (enabled for council, health active, not signed out — the daemon's
    prediction of what a council would do with the seat) and `council_ineligible_reason`. Chat
    admission (`POST /chats` defaults) reads the SAME auth predicate: a signed-out seat is refused
    up front with the reason instead of failing its first turn. Per the independent review of #533:
    the prediction now LEARNS from the engine — `councilSeatFailed` (`non_zero_exit` / `timed_out`;
    the derivative `benched` kind excluded) is folded into seat health over a bounded 30-minute
    window, and from two failures up the seat reads `council_eligible: false` with the last failure
    named in `council_ineligible_reason` and echoed as `council_bench` (cleared by the seat's next ok
    unit output; `health` itself is not flipped — a chat is not a council). The free-tier reading
    says where it came from: `free_tier_source: 'crew-heuristic'` today (the CLI registry's
    `AgenticCli` declares no credential requirement — a wicked-core follow-up adds
    `credential = "optional"` + a label to the `[cli]` record; the daemon already reads a record
    that carries it and reports `'registry'`).
  - **A council that held on a fraction of its seats is narrated as one (F-4R2-007).** The
    interactive threads' "Council picked X for Y…" line now appends "(1 of 5 seats answered — 4
    benched)" from the frame's `seated`/`returned`, and quotes `degradedReason` when the engine
    sets it. The engine leaves `degradedReason` `null` for such councils (it is set only for its
    `Degraded` routing) — filed as a wicked-core follow-up; nothing in core changed here.
  - **An onboarding run's seat pool is the seats its workflow can use (F-2R2-010).** Onboarding is
    two tool phases routed to the `wicked-estate` executor, so its run now carries `clis: []`
    instead of the whole roster dressed as a 5-seat run (`seatsForWorkflow`: a workflow whose every
    phase is a tool executor gets no seats; anything with an agent phase keeps the full roster).
  - **The interactive bridge follows `wicked-interactive@^0.9.1` (acceptance finding F-081).** The
    `^0.8.1` floor was a compiled constant, so the daemon never picked up wicked-interactive 0.9.0
    (published 2026-09-02) and would not have picked up 0.9.1 — a silent freeze. The default range is
    now `^0.9.1`: the exporter honours the author's page geometry (F-050); `DELETE /api/docs/:doc`
    retire is available. Operators and test rigs can override the RANGE with
    `WICKED_INTERACTIVE_SPEC` (a semver range — `^0.9.1`, `0.9.1`, `>=0.9.1 <1.0.0`; tags, paths and
    `pkg@range` spellings are refused), validated at resolution and reported on the boot line; an
    invalid value is named and ignored, and an accepted range whose floor is below crew's need
    (`^0.9.1`) is honoured with a boot warning. Documented in both READMEs.
  - **`agent-acp-bridges` 1.1.1 — the pi skills env contract has THREE states (wicked-core #443
    review).** `WICKED_PI_SKILL_DIRS` **unset** = no delivery (the launch is unchanged); **set with
    dirs** = a delivery (`--no-skills` + one `--skill <dir>` each); **set but EMPTY**
    (`WICKED_PI_SKILL_DIRS=`) = a delivery of ZERO portable skills → pi starts with `--no-skills`
    **alone**, discovery off. 1.1.0 read blank as "no delivery" and returned `[]`, which would have
    let a seat the engine admitted to nothing fall back to `~/.pi/agent/skills`. `piSkillFlags` /
    `skillFlagsFor` (shared by `runBridge` and the `wicked-pi` launcher), the README contract table
    and the tests follow. Crew's dependency range on the package moves to `^1.1.1` — the launcher
    contract crew relies on is 1.1.x. **Release order: tag `bridges-v1.1.1` on this PR's merge
    commit and publish it → then cut crew 0.7.30** (`bridges-v1.1.0` was cut on the #532 merge;
    until 1.1.1 is on the registry, `npm i -g wicked-crew@0.7.30` cannot resolve `^1.1.1`). Also from the #532 review: the skills validator's
    fence-walk comment (`skills/refs.ts`) named a `semantics.fence` fixture key that never shipped —
    refreshed to the fixture's `fences` rule.
  - **`wicked-crew-api-types` 0.35.0** (additive): `RosterSeat.auth?` / `free_tier?` /
    `council_eligible?` / `council_ineligible_reason?` + `SeatAuth`; `ChatSeatRefusal`,
    `ChatOpenResponse.refused?`, `ChatSeatRefusedFrame`; `RepoGraphResponse` (`reason?`,
    `finding?`); `ProjectGraphAction`, `ProjectGraphStatus.action?`, `ChatScope.graph.action?`;
    `DiagnosticsGovernanceFinding.severity` admits `info`;
    `DiagnosticsGovernanceDeadletters.legacyOutbox.scope` (required — the daemon always attributes the
    file it reports; a skin talking to an older daemon treats the whole `legacyOutbox` object as
    best-effort), `RosterSeat.free_tier_source?` / `council_bench?` + `RosterSeatCouncilBench`;
    `GET /repos/:id/graph` binds `RepoGraphResponse` in the endpoint manifest and the drift guard.
    Endpoint manifest + generated API tests
    re-stamped.

## [0.7.29] — 2026-09-11

Release train: ships `wicked-crew-api-types` 0.33.0 (workspace link; 0.32.0 from #518, tagged
`api-types-v0.32.0` on the #518 merge, and 0.33.0 from #527, tagged `api-types-v0.33.0` on this
release's merge), pins the published `wicked-core-ts` `^0.7.20` engine (wicked-core #420 / #421 /
#425 / #426 / #429 / #430 / #434 / #435 / #436 in 0.7.19 — event `seq` across restarts, dead-letter
stamps + `replayEmitOutbox`, repo graphs under the state home, per-seat config roots, enforceable
deny rules, scope-validator hardening — and #433 in 0.7.20: deliver lifts onto the current base and
re-verifies, the creator tree is restored on evaluator mutation, the judge is named, read-only ACP
evaluators) and bundles the published `wicked-studio` 0.5.5 skin (repo findings on the repo card,
governance in the Health panel, scoped New Chat, evaluator-verdict gate cards). One crew release
carries both engine steps: the 0.7.29-on-`^0.7.19` split wicked-core's CHANGELOG anticipated was
folded into this one. What merged since 0.7.28 — the detailed entries follow under Fixed:

- **#516** — governance records land in a state-home store; dead letters are visible and never
  under HOME (crew#495); `GET /diagnostics` gains `governance`; `wicked-crew governance replay`.
- **#517** — repo graphs live under the state home; an in-tree `.codegraph` is never adopted
  (wicked-core#406); `RepoEntry.findings`; `GET /diagnostics` `stores` lists the repo graphs.
- **#518** — chats are scoped and grounded; seats run in a private scratch root (crew#502; api-types
  0.32.0). The plain-words upgrade notes are under Fixed.
- **#520** — release: the post-publish probe waits for npm processing and names the real failure
  (#514; workflow only, no daemon change).
- **#522** — governance post-review hardenings: replay target checks, archive naming, recovery,
  quoting, recipes (#521).
- **#523** — a missing repo-graph root is 503 everywhere; the project-graph routes declare their
  status codes (wicked-core#406 follow-up).
- **#525** — enforceable deny rules for the claude seat (the generator lives in wicked-core);
  deliver composes a real PR title and body (#524).
- **#526** — chat scratch chain hardening (crew#502 follow-up).
- **#527** — the deliver script refuses a base that moved past the engine's verification; every
  deliver refusal is an operator escalation and only a lift CONFLICT is recoverable; triage knows
  the engine's lift phrasing; the embedded fallback keeps `Fixes #N`; api-types 0.33.0 declares the
  #433 events (`deliverLiftEvaluated`, `worktreeRestored`, `evaluatorToolCallDenied`, `acpFallback`,
  `GateEvaluatedEvent.judgeCli`).

### Fixed
- **The deliver script refuses a base that moved past the engine's verification; deliver refusals
  are escalations, not seat faults (wicked-core#431 follow-through — crew consumes wicked-core#433).**
  The engine now lifts the run's work onto the remote default branch's tip and re-runs the
  repository's checks BEFORE the deliver phase runs, and hands the tip it verified against to the
  deliver command as `WICKED_DELIVER_VERIFIED_BASE`. The script's own `git fetch` is a second moment:
  a remote that advanced in between would have made its rebase carry the base PAST what was verified
  — F-3R2-013's verified≠delivered gap, one window later. With the pin set, `deliverPrScript` now
  refuses when `origin/<default>` no longer resolves to it — BEFORE anything is staged or committed,
  so the worktree stays exactly as the engine left it and an approved retry re-lifts and re-verifies
  from scratch (`deliver: BASE MOVED since verification — …`; deliberately NOT a `LIFT-CONFLICT`
  strand, since a post-hoc lift would push a tree nobody verified on the new base; an unresolvable
  default ref with the pin set refuses the same way). A post-hoc `POST /runs/:id/deliver` has no
  engine verification to pin to and strips the variable. The crew#426 preflight (`npm install` +
  codegen) runs AFTER the engine's verification, so the script now snapshots the worktree content
  before and after it: an engine-driven delivery REFUSES when the preflight changed any file
  (`deliver: PREFLIGHT CHANGED the verified tree — … rewrote: <files>`; the regenerated files stay
  in the worktree, so approving the retry makes the engine re-verify the changed tree and the
  retry deliver it — the crew#426 auto-repair now costs one gate approval and ships verified), while a post-hoc lift
  (`WICKED_DELIVER_POSTHOC=1`, set by the daemon) keeps the regeneration and says which tracked
  files it rewrote. Seat health used to mark the unit's
  assigned seat inactive on ANY `stepFailed {failureKind: "workerError"}` — and the deliver phase is a
  Tool command no seat ran, stamped `workerError` only because the Tool path has no finer kind — so
  a `deliver: LIFT-CONFLICT` blamed a CLI for a git state. `core/deliver-triage.ts` now recognises
  every deliver refusal — the engine's (`deliver: LIFT-CONFLICT — lifting the run's work onto …`, `…
  the repository's own checks FAILED on it …`, `… could not be applied cleanly …`, `… could not be
  snapshotted before delivery …`, `… checks passed but CHANGED the worktree …`, `… not the run branch
  … — nothing was lifted, reset or pushed …`) and the script's own — as an operator
  escalation that flips no seat; only a lift CONFLICT is `recoverable`. The engine's LIFT-CONFLICT
  carries crew's marker as its prefix, so the `completed` + `delivery: 'stranded'` derivation fires
  for it unchanged, while a failed re-verify stays `failed` (never offered a post-hoc push). The
  engine's new `acpFallback {fallbackKind: "read_only_requires_wrapped"}` (an evaluator on an
  unadmitted ACP seat rerouted to the wrapped carrier) is deliberate routing and never counts toward
  a seat's repeated-fallback inactivity.
  - **`wicked-crew-api-types` 0.33.0** (additive): `GateEvaluatedEvent.judgeCli: string | null` +
    `judgeDistinct: boolean | null` (who rendered `agentVerdict`; also on the permissive `CoreEvent`);
    `EvaluatorMutatedWorktreeEvent.restored: boolean` + `restoreError: string | null`; new
    `WorktreeRestoredEvent {tree, head, discarded, suggestionRef}`, `DeliverLiftEvaluatedEvent {outcome, baseRef,
    baseBefore, baseAfter, treeBefore, treeAfter, conflicts, note}` with `DeliverLiftOutcome`
    (`unchanged | lifted | conflict | skipped | failed`), `EvaluatorToolCallDeniedEvent {cli, carrier,
    tool, kind, path, reason}`, `RunBaseResolvedEvent {baseRef, baseCommit, localHead, behind,
    fetched, lifted, note}`; `AcpFallbackKind` (the five kinds, `read_only_requires_wrapped` included)
    typing `AcpFallbackEvent.fallbackKind`; `GateEvidenceEvent` gains the three gate-side frames;
    `RepoChecksEvaluatedEvent` is documented as also arriving for the deliver ord after a lift, and
    `RepoCheckRun.source` documents the forced-install provenance (`… (forced: lockfile drift)`);
    `CoreEvent.kind` widened to `string | null` (the engine sends `null` on `evaluatorToolCallDenied`
    when the agent sent no kind). Wire-contract pins for each; endpoint manifest + generated API tests
    re-stamped.
- **The embedded deliver fallback keeps `Fixes #N` from an intent longer than the script embeds
  (#524 follow-up; wave-3 isolation review).** The launch-time fallback text the deliver script
  carries is composed from the intent BOUNDED to `EMBEDDED_INTENT_CAP` (8,000 chars — the script is
  one argv entry), and the issue references were derived from that bounded copy, so a `fixes #214`
  written past the cap vanished from the PR body of any run whose daemon did not answer
  `GET /runs/:id/deliver-text` — and GitHub never closed the issue. `composeEmbeddedDeliverText`
  now derives `Fixes …` / `Refs: …` from the FULL intent first and bounds only the text (the cut is
  still disclosed in the body); `composeDeliverText` takes the references as an optional argument.
  Unit tests over the composer; the script is driven for real with a reference past the cap.
- **CI + integration fixtures follow the wicked-core#433 engine.** crew's CI builds `wicked-core-ts`
  from core `main`, which now re-verifies the deliver tree inside an OS write boundary and fails
  closed without one — the Linux runner installs `bubblewrap` (and lifts the ubuntu-24.04 AppArmor
  gate on unprivileged user namespaces) so the deliver e2e suites can pass; the elicitation and
  ACP-kill fixtures admit their stub seat to input governance (`acp_input_governance = true`) so an
  `executes_code: false` unit stays on the ACP transport under test instead of being rerouted to the
  wrapped carrier.
- **Chat scratch chain hardening (crew#502 follow-up; independent review W6/W7 and deferred
  hunks).** A registered repo root the daemon cannot resolve (a permission wall, a symlink loop, an
  unmounted volume) refuses a `POST /chats` (409) only when that repo is IN the chat's scope or its
  spelling already overlaps the scratch base; any other unresolvable root is logged and the open
  continues — it no longer blocks every chat on the daemon. At boot the daemon reaps the sibling
  `<tmp>/wicked-crew-chats/<pid>-*` namespaces of dead daemons (same real-directory/ownership
  checks as a live close; a live or foreign pid, a link, a file and this daemon's own namespace are
  left alone). An engine `chatClosed` for a chat still RESERVED parks the id as closing (the way
  `DELETE` does) instead of freeing it, so a re-use in between cannot lose its chat to the in-flight
  open's teardown. The scratch root is created non-recursively and `created` is that mkdir's own
  verdict (no `existsSync` check-then-create window). Read roots reach the engine `resolve()`d, never
  as the raw registry spelling.
- **Chats are scoped and grounded; seats never run in the daemon's cwd (acceptance finding F-067,
  crew#502).** `POST /chats` set the seats' working directory only when `repoRef` was sent and the
  engine fell back to its own `current_dir()` — the daemon's — so studio's GroupChat (which never
  sent one) explored wherever `wicked-crew serve` had been started from, with no estate MCP and no
  statement of the scope; "chat with all 9 repos" worked only because the rig started the daemon
  from the parent of `repos/`. A chat now takes a SCOPE: the explicit `repoRefs` (the legacy
  single `repoRef` is merged in; ids or names; every unknown ref is a 404 naming ALL the missing
  ones, before any seat warms) or, when only `projectId` is given, every registered `crew.repo`
  member of the project (dangling members are named, not read). The seats run in a PRIVATE SCRATCH
  ROOT of the chat's own (`<os tmp>/wicked-crew-chats/<pid>-<random>/<chatId>` — this daemon's own
  per-process namespace, private mode — never a repo, never the daemon's cwd; not under the state
  home, which the engine's worker fence denies to every seat)
  with the scoped repos' registered roots as READ roots (advertised to a claude seat as the SDK's
  `additionalDirectories`) and the READ-ONLY wicked-estate MCP over the project's co-located graph
  (`resolveProjectGraphBinding`, DES-GROUNDING-001 — the same grounding governed runs get; a single
  repo without a project gets its own graph; several repos without a project get none, and the
  reason says so). The scope is STATED to the seats — `AGENTS.md` + `CLAUDE.md` in the scratch root
  name the repos, their paths, the read-only rule and the grounding — and returned as `scope` on
  the 201 (and on `GET /chats/:id`), so the UI can show it; an engine predating chat scope is
  detected (the engine's `chatList` row lacks the scope fields) and a SCOPED open on it is refused
  with a 501 naming the remedy — never opened unbounded behind a statement that promises read-only
  roots (an unscoped chat proceeds). The scratch base is this daemon's own per-process namespace
  (`<os tmp>/wicked-crew-chats/<pid>-<random>`), so daemons sharing one OS user never touch each
  other's roots; a registered repo that overlaps the base is refused (409); re-opening a live id is a
  409, and the id stays parked after `DELETE` until the engine's own `chatClosed` is observed, so a
  late close can never land on a reused id and a close during an open tears that open down. The
  scratch root is removed on `DELETE /chats/:id` and on the engine's own `chatClosed` (idle reap,
  pool cap). Needs the engine half (wicked-core#410 — `chatOpen` scope,
  per-seat config roots, banner gate); `GET /chats` rows gain `cwd` / `codeGraphDb` / `readRoots`
  from it. The studio's New Chat scope control is a follow-up in wicked-studio.
- **Upgrade notes, in plain words.** After upgrading, the codex, pi, copilot and opencode seats read
  `signed_in: false` on System until each is signed in once from Studio → System (its Sign-in
  command names the seat's own directory); until then councils and governed runs use claude and agy.
  A project-scoped chat refuses pi, codex, copilot and agy by name — their ACP adapters ask no
  permissions and arm no sandbox, so the engine cannot hold the project's repositories read-only for
  them — and the default seats of a scoped chat are pre-filtered to the admissible ones (claude,
  opencode); open the chat unscoped for those seats, or set `os_sandbox = true` on the seat's
  `[cli.acp]` record (a write floor only: it keeps the roots read-only but does not stop reads
  outside the scope). An unscoped chat — no project, no repos — reads nothing but its own scratch
  root; select the project to chat with its repositories (Studio's New Chat scope control is
  wicked-studio#248).
- **Roster `signed_in` reads each seat's OWN configuration root (F-010, wicked-core#410).** With a
  fresh `WICKED_WORKER_HOME` the roster reported claude `signed_in:false` but codex / pi / copilot /
  opencode `true` — off the OPERATOR's `~/.codex`, `~/.pi/agent`, `~/.copilot`,
  `~/.local/share/opencode`, which the engine's seats no longer run under. The heuristic now probes
  `<worker home>/codex/auth.json`, `<worker home>/pi/auth.json`, `<worker home>/copilot/config.json`
  and `<worker home>/opencode/data/opencode/auth.json` — the layout `wicked_apps_core::spawn::
  seat_config_for` points the CLIs at (`CODEX_HOME`, `PI_CODING_AGENT_DIR`, `COPILOT_HOME`, the XDG
  bases) — and the operator's own homes only under the `WICKED_WORKER_INHERIT_OPERATOR_CONFIG` hatch,
  where the seats run there too. The engine's `login_invocation` for each seat now names the same
  root, so the studio's Sign-in terminal signs in the directory the seats read.
- **`wicked-crew-api-types` 0.32.0** (additive): `ChatOpenBody.repoRefs` + the scope semantics,
  `ChatScope` / `ChatScopeKind` / `ChatScopeRepo`, `ChatSeatOutcome`, `ChatOpenResponse`,
  `ChatSummary` (with the engine's `cwd` / `codeGraphDb` / `readRoots`), `ChatListResponse`,
  `ChatDetailResponse`; `ChatScope.graph.repoLabel` names the estate label a single scoped repo is
  indexed under. Tag `api-types-v0.32.0` on merge (0.31.0 shipped with #507's gate-evidence events).
- **Deliver opens a PR a reviewer can review against (#524, acceptance finding F-3R2-014).** The
  deliver phase used `gh pr create --fill`: wicked-studio#249 opened with the intent cut MID-WORD
  behind a run-id prefix (`…scenario CLN-2) aga`), an EMPTY body, no `Fixes #214`, no run link, and
  the same truncated headline as its commit subject. The PR title, body and commit message are now
  COMPOSED FROM THE RUN (`core/deliver-text.ts`): the title is the intent's first line cut at a word
  boundary within 72 characters; the body carries the intent, `Fixes #N` when the intent names an
  issue with a closing verb (other `#N` / `repo#N` mentions as `Refs:`), the run id linked to this
  daemon's `/runs/<id>`, every phase with its seat and gate outcome, the repo checks the verify phase
  ran with their exit codes, the evaluator verdict, and a footer. The script asks the daemon that
  launched it — new `GET /api/v1/runs/:id/deliver-text` (text/plain: title, blank line, body) — for
  the run-derived text at delivery time and falls back to the same composer's launch-time text
  embedded in the script (intent, issue links, run link, phase list; runtime sections say they were
  not available) when the daemon cannot answer, saying so in the phase output. The commit the phase
  makes for uncommitted work carries that same text (`git commit --cleanup=whitespace -F`, so `## …`
  headings survive a `commit.cleanup=strip` config) — its subject is the PR title; a run that
  committed incrementally keeps its own commits. The PR opens with `--title` + `--body-file`, never
  `--fill`. The run link is emitted only for a loopback daemon origin (a LAN host never lands in a
  PR body); an owner-less `repo#N` that names the delivery repo closes as `#N`; the script embeds a
  bounded copy of the intent (the run record carries it whole). Post-hoc delivery
  (`POST /runs/:id/deliver`) composes from the run record it already holds.
- **Worker claude deny rules are the ones the CLI enforces (#524, F-3R2-004; the generator lives in
  wicked-core).** The engine emitted a `Write(<path>/**)` twin beside every `Edit(<path>/**)` deny
  rule for the operator's `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`,
  `~/.wicked*` and the daemon's config dir; Claude Code does not match `Write(path)` rules (`only
  Edit(path) rules are … Edit rules cover all file-editing tools`) and warned 12× per ballot. Fixed
  where the rules are built — wicked-core `execute_wrapped::{deny_rules, shared_deny_rules}` emit
  `Read` + `Edit` only, and a template's own `Write(<path>)` is lifted as `Edit(<path>)` — so the
  fence is what the settings file says it is and the ballots stop paying for the warnings. Lands in
  crew with the next `wicked-core-ts` pin; no crew code path generates these rules.

- **Graph surfaces: a missing repo-graph root is 503 everywhere; the project-graph routes declare
  their status codes (wicked-core#406 follow-up).** `codeGraphErrorStatus` in `repoPaths.ts` is the
  ONE mapping every code-graph consumer shares: `/repos/:id/{graph,graph/blast-radius,domain-graph}`
  and the requirements routes now answer **503** with the engine's own diagnosis when a current
  engine resolved no repo-graph root (`CodeGraphRootUnresolvableError`) instead of Fastify's generic
  500; the project-graph routes reuse it. `GET/POST /projects/:id/graph{,/refresh,/blast-radius,/search}`
  declare `statusCodes` (200 · 400 · 404 · 409 · 501 · 503 as applicable) — `endpoint-manifest.json`
  and the generated API tests are regenerated, and the graph route's "Always 200" note now separates
  standings (200) from refusals (404 / 501 / 503). `listStoreFiles` spells the state home through
  `stateHomeOfDb()` (absolute even for a relative `--db`) and keeps listing the repo-graph root when
  the core-store directory is absent (the override can live elsewhere). `projects/graph.ts`'s
  "Honest degradation" inventory names the fifth case. The two #406 bullets below were filed under
  `[0.7.28]` by a merge that crossed the release cut; they are unreleased and now live here.
- **State-home registry: `repo-graphs` is a registered subtree (wicked-core#406).** wicked-core now
  keeps every registered repo's code graph under the daemon state home —
  `<state home>/repo-graphs/<repo-dir-name>-<12-hex>/estate.db`, the `--db` parent, so `--db`
  relocates the graphs with the rest of the durable state and a checkout's in-tree `.codegraph/` is
  never adopted — instead of the operator's `~/.wicked-estate/repo-graphs`. The shared fence fixture
  (`packages/crew/tests/fixtures/state-home-subtrees.json`, byte-identical to core's
  `tests/fixtures/state-home-subtrees.json`) gains the `repo-graphs` entry (owner `engine`,
  `worker_read: none`) so the worker Read fence classifies and denies the subtree rather than
  refusing every governed launch on a daemon that has indexed a repo. Crew spells no new path: it
  keeps reading the engine's `code_graph_db` off the repo record (`repoPaths.ts`). The record now
  also carries an additive `findings` array (e.g. `in_tree_code_graph_ignored`) the repo card can
  show — declared in `wicked-crew-api-types` as `RepoEntry.findings?: RepoFinding[]` (additive; the
  package version moves at its next release). `repoPaths.ts codeGraphDb()` reads it for the one case
  that shares the empty-`code_graph_db` shape with a stale addon: an engine that resolved NO root
  (`code_graph_root_unresolvable`) now surfaces its own diagnosis instead of the "reinstall
  wicked-core-ts" error — as its own `CodeGraphRootUnresolvableError`, which `projects/graph.ts`
  lets through untouched (every other `codeGraphDb` throw still becomes
  `ProjectGraphEngineTooOldError` / 501 `engine-too-old`) and the project-graph routes answer 503
  with the finding's message: a daemon-environment fault, not a stale addon and not a bad request.
  `resolveProjectGraphBinding()` records the same truth on a launch: with no repo-graph root there
  is no per-repo graph to degrade to, so its reason names the environment fault and says the run
  gets no code graph — never "uses its own repo's code graph".
- **`GET /diagnostics` `stores` lists the engine's repo graphs** (wicked-core#406 asked for it):
  after `core.db` and its sidecars, one entry per `<state home>/repo-graphs/<key>/estate.db`
  (`name: "repo-graphs/<key>/estate.db"`, path + bytes like every other store; key-sorted). The
  root is spelled with the engine's precedence — `WICKED_ESTATE_REPO_GRAPH_ROOT` when set, else
  the state home's `repo-graphs` (the `--db` parent, exactly how the engine derives it) — so no
  new engine export is needed; `-wal`/`-shm` siblings, in-flight `estate.db.migrating-*` temps and
  never-indexed key dirs are not stores and are not listed.
- **Governance records land in a state-home store; dead letters are visible and never under HOME
  (crew#495, acceptance finding F-022).** The engine's emit seam writes every cross-product
  governance event — conformance claims and decisions, phase transitions, the steering-rule
  lifecycle — to the estate store named by `WICKED_ESTATE_DB`, and `serve` never set it: on EVERY
  default install EVERY such event dead-lettered to `~/.something-wicked/wicked-apps/
  emit-outbox.ndjson` under the operator's HOME (3,400+ entries on one host, shared by every daemon,
  no timestamp, nothing on `/diagnostics` or the console) while the home board asserted "Governed
  100%". Now: `serve` resolves the store — `--governance-db` / `WICKED_CREW_GOVERNANCE_DB`, else an
  inherited `WICKED_ESTATE_DB`, else the daemon's OWN `<core db>.governance/governance.db` (a
  sidecar for the same reason the bus is one, F-043: the state-home fence registry's `core.db`
  prefix claim already covers it) — exports it to the in-process engine before it spawns, and logs
  which rule won; a URL spec (`postgres://…`) is refused at boot — the emit seam is SQLite-only and
  would dead-letter every event — as is the core db or the bus db (a second writer on a store another
  process owns). The dead-letter outbox is `<core db>.governance/emit-outbox.ndjson` (an explicit
  `WICKED_APPS_EMIT_DEADLETTER` is honoured), under the state home rather than HOME; the daemon stamps
  `WICKED_APPS_EMIT_ORIGIN` so an engine carrying the companion change writes `ts` (epoch ms), `pid`
  and `origin` on every spooled entry. `GET /diagnostics` gains `governance` — the store and its
  source, EVENT records on it (total / since boot, via the engine's `eventStoreCount` binding; `null`
  on an older addon, never a fabricated 0), the outbox folded (count, per-type, per-reason,
  timestamp range, truncation) and findings: `governance.deadletter` (error) the moment the outbox
  holds an entry, `governance.store` (error) when no store was resolved, `governance.legacy-outbox`
  (warning) when the pre-fix HOME outbox still exists. New `wicked-crew governance replay <outbox>
  [--governance-db | --db] [--dry-run]` drains an outbox into the store through the engine's
  `replayEmitOutbox` binding (archive first, replay from the archive, failed lines back onto the
  outbox; exit 2 with the outbox untouched on an older addon). Crew's own estate-MCP child gets the
  boot-time `WICKED_ESTATE_DB` back, never the daemon's sidecar. The readiness line carries
  `governanceDb`. Engine companion: wicked-core (spool-record stamps + the two `Core` statics).
  Studio follow-up: the Health panel renders the new block.
  - **wicked-crew-api-types 0.31.0** — additive `DiagnosticsResponse.governance` with
    `DiagnosticsGovernance` / `DiagnosticsGovernanceStore(Source)` / `DiagnosticsGovernanceRecords`
    / `DiagnosticsGovernanceDeadletters` / `DiagnosticsGovernanceFinding`.

## [0.7.28] — 2026-09-10

Release train: ships `wicked-crew-api-types` 0.31.0 (workspace link; 0.30.0 from #506, tagged
`api-types-v0.30.0` on the #506 merge, and 0.31.0 from #507, tagged `api-types-v0.31.0` on the #507
merge), pins the published `wicked-core-ts` `^0.7.18` engine (the wicked-core F-036 / F-039 fixes —
worktree guard, read-only no-code posture, gate-evaluates-nothing registration refusal) and bundles
the published `wicked-studio` 0.5.4 skin. What merged since 0.7.27 — the detailed entries follow
under Fixed / Added / Changed:

- **#506 — interactive seams: honest live status, grounded on the NAMED repository, one bus per
  daemon** (F-045 / F-046 / F-042 / F-043; api-types 0.30.0): every seam event carries `project_id`;
  `POST /projects/:id/interactive/api/docs` accepts `repo_ref` / `repo_refs` validated against the
  project's members (400 `repo_not_in_project`) and remembered as a `crew-grounding.json` sidecar;
  the bridge spawn exports this daemon's own origin and its own bus sidecar (`<core db>.bus/bus.db`).
- **#507 — the `fix` gate gets an evaluator; non-claude evaluator seats run read-only**
  (F-036 / F-039; api-types 0.31.0): `EvaluatorMutatedWorktreeEvent` / `RepoChecksEvaluatedEvent`
  on the wire and `GateEvaluatedEvent.denial`; the acceptance view folds an evaluator that rewrote
  the code into `enforcement.unenforced`; the served `feature` / `bug` / `migration` mirrors pin the
  evidence floor (`validator_pin: e2e7af1db9e48454`) on their code-writing phases, as wicked-core's
  registration now requires.

### Fixed
- **Interactive seams — honest live status (acceptance finding F-045 + its two follow-ups).** Every
  event crew's four interactive seams emit — `wicked.interactive.status.posted` narration and the
  15 s heartbeats, the terminal error/complete lines, and the closing `draft.completed` /
  `edit.completed` / `demo.requested` — now carries `project_id` for a project-bound document,
  exactly like the bridge's own emits (DES-PROJECT-001 enrichment). The studio files frames by
  `project_id`, so crew's heartbeats (which carried `document_id` only) landed under the Unfiled
  mount while the project-bound thread heard nothing and, 90 s into a LIVE governed run, told the
  user "no worker has picked this up — the generation service may be down" with a Retry that would
  have injected a duplicate; the demo thread never showed one crew line at all. Wire: additive
  (`InteractiveStatusPosted` documents the payload in `wicked-crew-api-types`). The studio's own
  half (file status frames by `document_id` regardless — belt and braces) lands separately in
  wicked-studio.
- **Interactive seams — grounded on the NAMED repository (F-046 + follow-up).** The draft and demo
  seams grounded a project-bound document on the project's FIRST `crew.repo` member — a brochure
  about wicked-studio was drafted against a wicked-core snapshot and the thread never said so. The
  create request (`POST /projects/:id/interactive/api/docs`) now accepts `repo_ref` (one) or
  `repo_refs` (several; a repo id, its registry name, or its root basename), validated at the proxy
  against the project's members BEFORE the bridge sees the request — a repo the project does not
  have is a 400 `{code:"repo_not_in_project", requested, missing, available}` with nothing created;
  an Unfiled document cannot name one (`unfiled_doc_repo`). The refs are stripped from the forwarded
  body and remembered as a `crew-grounding.json` sidecar beside the new doc's `versions.json` under
  the project's docs root (new `interactive/doc-grounding.ts` — NOT under the state home: wicked-core
  embeds crew's state-home registry as the worker Read fence and refuses every launch that meets an
  unregistered entry, so a new store there needs a core release first; a retired doc keeps its
  reserved name, so no sweep is needed). The sidecar is read and written under the REAL docs root
  only — a symlinked document directory or sidecar is refused, never followed; the verified document
  directory is HELD (a directory descriptor, its dev/ino re-checked immediately before every read,
  temp create, rename and unlink, so a parent swapped for a link after validation is refused), the
  read goes through a no-follow descriptor whose identity must match what was checked, and the
  write is an exclusive random temp + rename (the remaining two-syscall window is documented as the
  v3.5-style residual). The forwarded create is built field by field as the published
  `InteractiveDocCreateRequest` — unknown fields are not relayed — and every seam's `status.posted`
  is typed as the published frame at the emitter. The proxy also
  canonicalizes the body's `project` from the route (omitted → filled in; a different one →
  400 `project_mismatch`), refuses a name/basename shared by several member repos
  (400 `ambiguous_repo_ref` listing the candidates — name it by id), and never replays a create
  the bridge already received (a connection dropped after dispatch is 502 `create_undetermined`,
  not a duplicate POST). When `doc.created` arrives the seam grounds on THOSE
  repositories (one offline snapshot each under `<run dir>/repos/<repo id>`, plus
  the project graph when built), else on the member repos the BRIEF names by name, else on the
  project's sole repo, else on none — never a first-member substitution: a multi-repo project whose
  document named nothing gets an honest thread line saying so and how to name one. The worker's
  problem statement states the subject ("This document is ABOUT the repository wicked-studio …"),
  and the thread shows "Grounded on wicked-studio (named in your request) …". The demo seam gets the
  same grounding for its first-spec run (local reads of the app's source snapshot; the live page is
  still inspected). Both seams refuse a run directory that sits inside ANY registered repository
  BEFORE creating it (the inbox is the worker's write root; a draft/demo dir configured inside a
  checkout would hand the worker live source) — error status, no run, no ledger row, the frame
  dead-lettered — and FAIL CLOSED: a registry that cannot be listed, or a root that cannot be
  resolved, is a refusal with a status naming the cause, never read as "clear" (a registered root
  that no longer exists is canonicalized through its nearest existing ancestor, so a symlinked parent
  cannot hide the overlap); the demo seam
  registers its flight before the pre-launch awaits so a replayed `doc.created` never
  double-launches and `stop()` sweeps a half-made snapshot. The create endpoint is published typed
  in `endpoint-manifest.json` (`InteractiveDocCreateRequest` → `InteractiveDocCreateResult`) and
  exercised by the generated API suite against an in-process fixture bridge.
- **Interactive create — the requested format reaches the bridge (F-046, style).** A create body's
  `style` passes through as before; when it is ABSENT the proxy infers it from the brief's format
  words (print-ready / A4 / brochure → `brochure`; slides / deck → `ppt`; memo / whitepaper →
  `doc`) so a print brief reaches the bridge's print instructions instead of its `web` default, and
  the draft worker's problem statement now carries the style's one-line format contract (a brochure
  is PRINT pages with page breaks — never fixed slide pages with `overflow:hidden`, the F-050/F-053
  clipping).
- **`wicked-crew-api-types` 0.30.0** (additive): `InteractiveDocCreateRequest` (the create body
  crew's proxy understands — the bridge's fields plus `repo_ref`/`repo_refs`; `InteractiveDemoStepDraft`
  for `demo_steps`), `InteractiveDocCreateRefusal` (the proxy's 400), `InteractiveStatusPosted`
  (`project_id` on crew's seam frames). wicked-studio types its create from this declaration instead
  of a local mirror and pins `0.30.0` exactly; tag `api-types-v0.30.0` on merge.
- **Bridge spawn env + one bus per daemon (F-042 / F-043).** The `wicked-interactive` bridge crew
  spawns validated and registered a doc's project against `WICKED_CREW_API` — defaulting to
  `http://127.0.0.1:7701` when unset — so a daemon on any other port could not create a single
  project-bound document (502 "project … not found on the crew daemon at http://127.0.0.1:7701"),
  and with two daemons on one host the doc was registered on the WRONG one; and the interactive
  seams, the project bus and the bridge all defaulted to wicked-bus's HOME-based
  `~/.something-wicked/wicked-bus/bus.db`, so two daemons (an isolated `--db` one beside the
  operator's) shared ONE bus, armed the SAME durable cursor names and raced for each other's
  `doc.created`. Now: the cross-product bus (interactive seams, project bus, /ws relay — which used
  to open wicked-bus's default regardless of `--bus-db`) resolves as explicit `--bus-db` /
  `WICKED_BUS_DB` › `$WICKED_BUS_DATA_DIR/bus.db` › **`<core db>.bus/bus.db`** — the daemon's OWN
  bus, a sidecar of its core db (`core.db.bus/` beside `core.db-wal` and `core.db.events/`), which
  the state-home fence wicked-core embeds already classifies through the registry's `core.db` prefix
  entry, so no fence change and no core release is needed (wicked-bus keeps `config.json`, `cas/`,
  `archive/`, `bus.sock`, `daemon.lock` beside its `bus.db`, hence a directory of its own;
  `interactive/bus-location.ts`). The spawn exports `WICKED_CREW_API` = this daemon's own bound
  origin and `WICKED_BUS_DATA_DIR` = that directory; the pair is recorded beside the lockfile
  (`.wi-serve.crew.json`, with the owning daemon's pid) so an adopted bridge crew started with a
  DIFFERENT pair is recycled (SIGTERM, 3 s grace, restart with the right env) ONLY when it is proven
  this daemon's or its owning daemon is gone — a bridge another LIVE daemon owns, or one whose
  owner is unrecorded (a pre-upgrade sidecar), is never killed (two daemons sharing one
  interactive docs root get a 503 `bridge_unavailable` naming the owner and the fix: give this daemon
  its own interactive root) — and one nobody recorded (an operator's terminal `wicked-interactive
  serve`, a pre-upgrade bridge) is adopted with a warning naming the fix. A `--bus-db` /
  `WICKED_BUS_DB` whose file is not `bus.db` cannot be shared with the bridge (wicked-bus reaches a
  bus only through a data directory) — the daemon refuses to boot with the fix named, rather than
  run itself and its bridge on two buses. The `--engine-exec` seam's
  crew-private default (`<state home>/bus.db`) is unchanged. `GET /diagnostics.stores` lists the
  bus sidecar with the db's other sidecars. Upgrade note: a bridge started by an older crew keeps
  emitting to the old bus until it is stopped — the daemon logs the pid and the fix on adopt.
  Recycling FAILS CLOSED: a refused signal (EPERM) or a pid still in the process table after
  SIGTERM, the grace and SIGKILL refuses the start (503 naming the pid and the daemon that owned
  it) with the sidecar untouched — no replacement beside a bridge that may still be running — and
  the replacement must prove it is this daemon's before it is recorded as crew's: not the recycled
  pid, and the spawned child or one of its descendants (`npx` → shell → node, read from the process
  table); a bridge somebody else started under the lockfile meanwhile is refused, one whose lineage
  cannot be read is used but never written into the sidecar (`interactive/bridge-pool.ts`).
  `wicked-interactive`'s own hard-coded `:7701` default is tracked separately in that repo.

### Added
- **Gate-evidence events on the wire (wicked-core F-036 / F-039).** `wicked-crew-api-types` declares
  `EvaluatorMutatedWorktreeEvent` (`evaluatorMutatedWorktree`: an `executes_code: false` phase —
  an evaluator, a recon rung — CHANGED the worktree it was reviewing; `changed[{status,path}]` is
  EVERY differing path and every one denies the unit — the engine has no exemptions, not
  documentation, not a declared deliverable — plus `headMoved`; the event fires exactly when the
  unit is denied) and
  `RepoChecksEvaluatedEvent` (`repoChecksEvaluated`: the engine ran the repository's own
  `typecheck`/`lint`/`test` scripts or `cargo test` in the worktree for the code-verifying unit —
  `checks[{name, argv, source, exitCode, timedOut, spawnError, durationMs, stdoutTail,
  stderrTail}]`, `skipped`, `passed`; the doc states the engine's contract exactly: checks run
  ONLY inside an OS write boundary with an isolated HOME/caches and `--ignore-scripts` installs,
  the floor FAILS when no boundary can be armed or a manifest cannot be read or trusted — probed
  without following links — only a repo with no DETECTABLE check (no manifest, or a manifest with
  no `typecheck`/`lint`/`test` script and no `Cargo.toml`) is a disclosed vacuous pass, and a check
  process gets a MINIMAL environment — `PATH`, locale, `TERM`, `RUSTUP_HOME` and the isolation
  overrides, never the daemon's tokens), plus
  `WorktreeChangedPath`, `RepoCheckRun` and the
  `GateEvidenceEvent` union — as `type` aliases, so they satisfy `CoreEvent`'s index signature and
  relay through the CoreEvent-typed broadcast seams (compile-time relay assertions in
  `wire-contract.test.ts`). `GateEvaluatedEvent` gains `denial: UnitDenial | null` (the structured
  twin of `denialReason`: `source` — a `UnitDenialSource` naming every engine layer, `worktree_guard`
  and `repo_checks` included — `reason`, `claimId`, `ruleIds`, `deniedTool`, `phase`) and
  `evaluatorPolicies`. Wire change ⇒ `wicked-crew-api-types` **0.31.0** (0.30.0 is the seams PR's);
  the endpoint manifest and the generated API tests are regenerated against it.

### Changed
- **The acceptance view treats an evaluator that rewrote the code as an enforcement failure.**
  `resolveEnforcement` folds a DENYING `evaluatorMutatedWorktree` (non-empty `changed`, or
  `headMoved`) into `enforcement.unenforced` beside the unchecked-tool-call units — reason
  "evaluator≠creator violated: phase `verify` (executes_code: false) changed the worktree it was
  reviewing — N path(s): …" — so `guardrailed` is never claimed for a run whose evaluator
  self-graded its own edit (deny-dominates, arch-R16). The `unenforced` headline now names the
  two classes separately (`UnenforcedUnit.kind`: `unchecked_tool_calls` | `worktree_mutation`);
  a documentation-only write is a violation like any other — the engine has no exemptions.
- **The served `feature`/`bug`/`migration` mirrors report the evidence floor on their code-writing
  Creator phases** (`build`/`fix`/`execute` now carry `validator_pin: e2e7af1db9e48454`, matching
  wicked-core's compiled defs and `workflows/*.json`): the `fix` gate re-derives the diff and a
  distinct seat judges it, instead of folding `combined: true` over nothing evaluated. This is
  part of the contract with the engine, not display: since wicked-core#414 registration judges a
  def AS AUTHORED and REFUSES a code phase whose gate evaluates nothing or a `verified_evidence`
  phase with no pin — nothing is armed or carried forward on crew's behalf — so a mirror that lags
  is refused, and the `deliver-pr` phase crew composes onto every delivering run now pins the
  built-in evidence floor EXPLICITLY (`validator_pin: e2e7af1db9e48454`) instead of relying on the
  engine to arm its `verified_evidence` flag. The `domain-extraction` mirror's `coverage` phase is
  `executes_code: true` (it writes `coverage-report.json` into the worktree; an
  `executes_code: false` phase may write nothing there — the worktree guard exempts nothing), and
  the `POST /runs` deliver default engages only on a def with a NON-EVALUATOR `executes_code`
  phase (`executes_code && role !== 'evaluator'`), so domain-extraction — whose only code phase
  is that evaluator — does not default to a doomed PR.
  The read-only posture for non-claude evaluator seats (codex `--sandbox read-only`, pi
  `--exclude-tools edit,write`, refusal of a write-capable lever-less posture, recognised by the
  resolved binary's stem) lives in wicked-core's launcher and needs no crew config.

## [0.7.27] — 2026-09-10

Release train: ships the published `wicked-crew-api-types` 0.29.0 (workspace link; tagged
`api-types-v0.29.0` on the #491 merge) and re-bundles the already-pinned `wicked-studio` `^0.5.2`
skin on the unchanged `wicked-core-ts` `^0.7.17` engine. What merged since 0.7.26 — the detailed
entries follow under Added / Changed:

- **#491 — skills design v3.6, the installer-copy bridge** (closes #490; api-types 0.29.0): the
  installer-managed garden copy becomes a LAST-resort skills source behind the marketplace cache,
  recorded as `source.kind: 'installer-copy'` with a persistent `skills.source` warning in
  `GET /diagnostics`; diagnostics fail closed on an unreadable skills manifest.

### Added
- **#490 — the installer-managed garden copy is a LAST-resort skills source** (design amendment
  v3.6; `wicked-crew-api-types` 0.29.0). Discovery order is now (1) the explicit
  `WICKED_CREW_SKILLS_SOURCE` override; (2) the marketplace cache
  `<config dir>/plugins/cache/wicked-garden/wicked-garden/<version>` of the FIRST config dir holding
  a valid one — the dirs `CLAUDE_CONFIG_DIR` lists, in order, then `~/.claude` appended once (the
  default when unset) — picking the version-DIRECTORY NAME of highest SemVer PRECEDENCE
  (semver.org grammar and §11 precedence; build metadata ignored for ordering; equal precedence →
  the plain name, else the lexicographically smallest) whose `plugin.json` version equals it — EVERY
  SemVer-named dir is validated (a mismatch anywhere is a logged `version-mismatch` finding, an
  invalid name a `non-semver-name` finding, a manifest that does not parse a `no-manifest` finding
  — never a crash out of discovery; never `readdir` order); (3) LAST resort, the installer-managed copy
  `<config dir>/plugins/wicked-garden` of the first of those dirs holding one (garden's
  `install.mjs` hard-codes `~/.claude`), accepted only when its `.claude-plugin/plugin.json` parses
  with a `version`. ANY cache beats ANY copy. Each config dir is resolved exactly once, at the top
  of discovery; its canonical root is carried through both tiers, every level below it that
  discovery touches (`plugins`, `cache`, the marketplace dir, the plugin dir, each version dir, the
  copy dir) is lstat-walked on the canonical path and a symlink at any of them skips that candidate
  with a finding — never followed — and a candidate's manifest is read only below that validated
  canonical dir (a link retargeted mid-walk is never read); the recorded `source.path` is canonical.
  A copy seed is recorded as `source.kind: 'installer-copy'` (new `SkillSourceKind` member)
  and surfaces a persistent WARNING finding `skills.source` in `GET /diagnostics` →
  `skills.findings` — "seeded from the installer copy at <path>; register the plugin with Claude
  Code (marketplace) to receive marketplace updates" — judged live from the current baseline, so a
  later refresh from the marketplace cache clears it: a byte-identical refresh now re-records the
  baseline's provenance (kind, path, version, git state; revision bumped) instead of returning
  early. So the daemon works on installer-only machines (`npx wicked-installer install
  wicked-garden` never registers the marketplace) without hiding the difference. Every source kind
  passes the same no-follow, closure and validation rules; `userCliDirs` fences every listed
  `CLAUDE_CONFIG_DIR`.
- **Diagnostics fail closed on an unreadable skills manifest.** `GET /diagnostics` → `skills` now
  re-reads `manifest.json` on every read; when it cannot (corrupt, unreadable, or the root no
  longer the one the store bound) it answers `config-error` with a new `skills.manifest` error
  finding naming the cause — never the stale outcome recorded at boot. A read never touches the
  engine input (the finding says what stays exported until restart).

### Changed
- `SkillsSourceUnavailableError` now says what to do: "install wicked-garden first —
  `npx wicked-installer install wicked-garden`, or register the plugin with Claude Code"; the seed's
  detail names both places it looked (the marketplace cache and the installer copy).

## [0.7.26] — 2026-09-09

Release train: bundles the published `wicked-studio` 0.5.2 skin, pins the published
`wicked-core-ts` `^0.7.17` engine, and ships `wicked-crew-api-types` 0.28.0 (0.25.0 → 0.26.0 →
0.27.0 → 0.28.0 across the three PRs below). What merged since 0.7.25 — the detailed entries
follow under Changed / Fixed / Added:

- **#474 — project-partitioned interactive root** (api-types 0.26.0): `/projects/:projectId/interactive/*`
  resolves each project to its own `~/wicked-interactive/docs/projects/<projectId>` partition
  (realpath-contained, fail-closed on links; the synthesized `default` project keeps the legacy
  shared root), and `GET …/interactive/api/docs` stamps `projectId` on every row.
- **#475 — evals `rule_coverage` + `effect` on the wire** (api-types 0.27.0): the core #394/#395
  companion — `GovernanceEvalReport.rule_coverage` (`GovernanceEvalRuleCoverage`, per-type rows)
  and `effect: 'warn'` on the eval contract, the internal 5-repo tag-pinned eval corpus
  (`e2e/corpus/wicked-internal-corpus.json` + `scripts/evals-internal-corpus.mjs`),
  `compareEvalRuns`, the revised evals test plan and the deterministic eval tests.
- **#480 — crew-owned skills root** (api-types 0.28.0; design v3.1–v3.5, the core #396 companion):
  content-hash baselines, immutable published snapshots handed to the engine as
  `WICKED_SKILLS_SNAPSHOT`, the `/api/v1/skills*` CAS file manager with skill-scoped containment,
  one storage root with an explicit worker fence, the degradation ladder in `GET /diagnostics`
  → `skills`, and no writes into the user's CLI directories.

### Changed
- **Re-bundle the studio skin at 0.5.2.** Bumps the bundled `wicked-studio` devDependency
  `^0.5.1` → `^0.5.2` (lockfile re-resolved) so `build:with-studio` ships studio #208 (the
  Repositories section on the project page — attach / detach `crew.repo` members), #209 (the
  `/skills` section: the file manager over the crew-owned skills root of #480, plus the engine line
  from `GET /diagnostics` → `skills`) and #210 (the Tests-feature deterministic test layer).
- **Pin `wicked-core-ts` `^0.7.17`** (was `^0.7.16`) — the published engine carrying the skills
  snapshot input (core #399, `WICKED_SKILLS_SNAPSHOT` on both carriers, the degradation ladder),
  seat routing that honours skill portability (core #402), and the evals lane's operator-authored
  `effect` + `EvalReport.rule_coverage` (core #398) that #475 and #480 above consume.

### Fixed
- **Interactive docs are no longer shared across projects (#472).** `/projects/:projectId/interactive/*`
  honored `:projectId` only to look up a per-project root setting no project ever had, so every
  project fell through to the one shared default root — one bridge, one registry, the same docs
  under every project's URL. A project without an explicit `interactiveRoot` now resolves to its
  own partition, `~/wicked-interactive/docs/projects/<projectId>` (created on first use by the
  bridge pool); the synthesized `default` project keeps the legacy shared root, so every existing
  document stays visible under Unfiled with no migration. Explicit per-project roots and
  `WICKED_INTERACTIVE_ROOT` are honored exactly as before.
- **The per-project partition is checked on REAL paths before anything is served from it (#474).**
  `projects/<projectId>` was resolved lexically only, so a symbolic link already sitting there —
  at another project's partition, or anywhere else — would have been followed by the bridge into
  that directory. The partition is now `lstat`-walked and `realpath`-contained under `projects/`
  and created without following links; a link, a file, or an escape answers 500 naming the
  offending path (fail closed — never a fallback to another root). The interactive event seams
  (edit / demo / chat) resolve a project's docs root through the SAME containment walk — a
  symlinked partition is refused into the seam handler's `onError` and the event goes unanswered
  instead of being followed into another project's docs; the seams only read under a root the
  routes materialized, so nothing is created on that path (Copilot on #474). The attributed docs list also
  answers 502 for a malformed list (`[null]`, non-object rows) or a non-JSON body from the
  bridge, and treats a connection lost mid-body as the transport failure it is (invalidate →
  retry once → diagnostic 502) instead of a malformed body. The endpoint manifest declares the
  list's wire shape as the array it is, `InteractiveDocSummary[]`.
- **Skills keystone — confirmation-review residuals, review pass 10** (PR #480). (1) Pruned
  directories (`.venv`, `node_modules`, `__pycache__`) are WALKED for classification while staying
  excluded from every copy and hash: `tree.ts` `walkEntries` descends them and reports every entry
  beneath with its kind, marked `pruned` with the pruned directory's path; `walkFiles`, `walkTree`'s
  `files` / `links` / `dirs` / `others` (so `hashTree` and the closure copy) exclude the subtree
  exactly as before, and `walkTree.pruned` hands what it holds to the validators. Under `effective/`
  a symlink or special node inside a pruned directory is a blocking `path-invalid` naming the entry
  and the pruned directory, with the reason (pruned trees are not bundle content and hold no links;
  an operator-created `effective/.venv` with interpreter links is refused with "provisioned
  environments live under baseline/, not the editable root"); a regular file there stays outside
  the scan as before. Under `baseline/<hash>/` the provisioned `.venv` stays pruned AND unclassified
  — an interpreter env legitimately holds symlinks, and nothing beneath a pruned directory is ever
  delivered except through the snapshot's `.venv` link, whose target crew and core verify by
  identity (documented on `baselineProblem`). A pruned-name directory inside a generation is
  refused BY NAME as an unexpected entry before the hash is compared (`verifyCurrent`) — publish
  never copies one. (2) The `reapBaselines` doc comment no longer claims "no revision bump": the
  record drop is the committed, revision-advancing CAS path it has been since round 9. Copilot: the
  boot's seed log line names the ACTUAL source — its kind, path and plugin version (`ensureReady`
  now answers the `PluginSource` the seed copied from) — instead of hard-coding "the installed
  wicked-garden plugin" when an explicit `WICKED_CREW_SKILLS_SOURCE` checkout or directory seeded.
- **Skills keystone — codex round-9 REJECT (2 HIGH, 2 MEDIUM)** (PR #480). (H1) ONE walker classifies
  every entry under `effective/` (`tree.ts` `walkEntries`: file / dir / symlink / other, never
  following a link, an empty directory reported like any entry) and `scanEffective` plus every
  validator consume it — a symlink ANYWHERE under `effective/` is a blocking `path-invalid` naming it
  (there is no permitted link there), a special node (socket / fifo / device) blocks by name, and
  nothing is invisible; `walkFiles` / `walkTree` are views of that one walk. (H2) the snapshot hash
  covers DIRECTORY entries (`hashTree(files, links, dirs)`; publish hashes the directories its file set
  implies, a verification the ones it walked — an extra empty directory anywhere in a generation is a
  mismatch) and the copilot view is verified as an exact WHOLE tree: `views/copilot/.github/skills/
  <name>/…` for exactly the sorted enabled-portable skills — each skill's own files and the
  directories they imply — with every unexpected file or directory named in the refusal; special
  nodes anywhere in a generation refuse. (M1) a refresh-time name collision records the held-back
  upstream skill's directory on the entry (`SkillEntry.upstreamDir`, api-types 0.28.0) and
  `GET /skills/:name/files/*?side=baseline` reads THAT directory, so the two sides of the collision
  are comparable (`path` names the file actually read). (M2) `reapBaselines` is a CAS mutation like
  every other: dropping a baseline record goes through the validated `manifest.json.tmp-…` → rename
  commit with the revision advanced (the commit lands before any directory is removed, so a failed
  commit removes nothing); a publish or refresh whose reap commits answers THAT revision, and a
  stale `expectedRevision` after a reap is the 409 it should be. Copilot: the `Scaffold.home` doc no
  longer speaks of the withdrawn mirror.
- **Skills keystone — codex round-8 REJECT (3 HIGH, 2 MEDIUM, 1 LOW), design amendment v3.5**
  (PR #480). (H1, v3.5 §2) EVERY name the store can create under `<state home>/skills/` is registered
  in the shared fence fixture `tests/fixtures/state-home-subtrees.json` — settled (`baseline/`,
  `effective/`, `manifest.json`, `snapshots/`, `current`, `.uv-cache/`, the never-created `refused/`
  sentinel) AND transient (`.staging-*` park-and-place directories, `manifest.json.tmp-*` commit
  files, `snapshots/.staging-*` generations being written, `snapshots/.tmp-current-*` links before
  their rename), each with its kind in an additive `denied_children_kinds` block (core mirrors the
  file byte-for-byte); `src/skills/root-names.ts` `SKILLS_ROOT_NAMES` is the store's own table (its
  constants bind to it), a static audit asserts fixture ≡ table and that every root join in the
  store's source resolves to a row, and a paused-operation test observes the transient names at the
  moment they exist and requires each to classify — a transient name missing from the registry is a
  live race with a worker launch, refused by core. (H2, v3.5 §3) TOCTOU discipline: every open inside
  the root is `O_NOFOLLOW` where the platform has it and the lstat-then-open gap is closed everywhere
  with a post-open `fstat` dev/ino identity check (`tree.ts` `openRegularNoFollow` /
  `readFileNoFollow`; typed reads too); copies read their SOURCE through such an open, never
  `copyFileSync(path)` (`copyFileNoFollow`, `O_EXCL | O_NOFOLLOW` destinations); a staged tree is
  re-walked and re-hashed AFTER the copy and BEFORE the rename/swap (baseline capture, publish, reset,
  refresh, replace/add, the single-file write) — a mismatch refuses with nothing written; the
  residual (a directory component swapped by another writer with access to the crew-owned state home
  — mitigated by the single-writer daemon and the post-operation verification, not eliminated) is
  documented in the module headers. (H3, v3.5 §4) an explicitly EMPTY `WICKED_SKILLS_SNAPSHOT` boot
  value is preserved on the engine handoff (core refuses it) and reported as `config-error`
  (`skills.config`, `engineInput: ""`) — never widened into the live-cache fallback; only an ABSENT
  variable reaches that rung. (M1, v3.5 §5) a directly registered `skill_ref` keeps `core: true`
  when its `SKILL.md` is missing or symlink-refused, so `disable` blocks (`core-disable`) and publish
  reports the missing content; the closure's `missing` set stays reported. (M2, v3.5 §1) the
  `.claude-plugin` closure is the five runtime catalogs by name (no behaviour change; the design
  amendment is cited where the closure is spelled). (L1) `DiagnosticsSkills.stateHome` is documented
  as diagnostics-only — `WICKED_CREW_STATE_HOME` is not exported; `engineInput` documents `""`.
  Copilot: `tests/skills-plugin-source.test.ts` no longer reassigns `home` (the first temp dir leaked
  past `afterEach`); a second home is tracked and removed.
- **Skills keystone — codex round-7 REVISE (3 HIGH, 2 MEDIUM)** (PR #480). (H1) content-addressed
  baselines are VERIFIED before every reuse and locked: an existing `baseline/<hash>` is reused only
  if its tree (links enumerated, `.venv` excluded) re-hashes to its name — a mismatch is
  `baseline-corrupt` (a new finding kind, api-types 0.28.0): the seed re-captures over it, a refresh
  refuses to reuse it (2xx `blocked`, nothing copied), reset verifies every file it would restore
  against the hash the manifest recorded for it (modified / planted / removed ⇒ `blocked`, nothing
  written), publish/analyze report it blocking BEFORE the env is provisioned in it and AFTER the
  provisioner ran; bundle files and subdirectories are made read-only after capture (the top dir
  keeps owner write for `.venv` — mode bits are a guard, the hash is the integrity boundary), the
  provisioner may write only under `.venv` (a `uv.lock` uv resolves for a lock-less bundle is removed
  again), and effective copies restored by reset/refresh get their owner-write bit back. (H2)
  `manifest.json` is validated by a COMPLETE fail-closed schema on every load and before every write
  — every field typed strictly (booleans are booleans, hashes 64-hex or `null` where allowed,
  `revision` a non-negative integer, enums for kind / provenance / source.kind / venv, exact key
  sets, `published {gen, contentHash, at, snapshotHash}`) — so `"enabled": "false"` now refuses to
  load (`manifest-invalid`; the daemon reports `skills.config`) instead of being published;
  pre-release manifests without `published.snapshotHash` refuse to load — remove the skills root to
  reseed. (H3) every content mutation commits ATOMICALLY with the manifest: park originals → stage →
  swap → records/derived fields → validated `manifest.json.tmp-…` → rename → unpark; if the manifest
  commit fails the content swap is rolled back from the parked originals (the single-file write and
  the support write now go through the same transaction as replace/add/reset/refresh; a publish whose
  manifest commit fails removes the generation it never came to own). (M1) the `.claude-plugin` half
  of the bundle closure is an allowlist BY NAME — `plugin.json`, `archetypes.json`, `components.json`,
  `specialist.json`, `stack-registry.json` (the runtime catalogs garden's scripts read, adjudicated on
  the live 12.32.0 layout); `marketplace.json` and anything else are `outside-closure`; `scripts/`
  excludes the `ci/` and `wg/` directories and `wg-*` tooling (spelling fixed everywhere). (M2)
  `snapshot.json` is AUTHENTICATED and re-derived: publish records `published.snapshotHash` (sha256 of
  the exact bytes it wrote); `current` verifies only the published generation with that metadata,
  re-derives every row's `kind` (from its frontmatter) and `portable` (from its own files) inside the
  generation, requires `nested` to be what the dir spells, rows sorted and unique, the copilot view to
  name AND lay out EXACTLY the sorted portable set (no subset, no extra directory) and nothing else
  under `views/`; a torn `current` (behind `published`) is finished by `ensureReady` from the
  authenticated generation, never verified on trust.
- **Skills keystone — design v3.4 (from the integrated functional test) + codex round-6 REJECT**
  (PR #480). The trio's first publish against the LIVE wicked-garden 12.32.0 plugin was BLOCKED by
  18 `unresolved-ref` findings in 7 skills (one of them core), so the skills seam shipped unusable
  on day one; garden's own structural gate treats those as advisory (wicked-garden#1111 tracks the
  content fixes). **Design v3.4 §1 — ref severity follows the TARGET:** an `unresolved-ref` that
  ESCAPES the plugin root (`${CLAUDE_PLUGIN_ROOT}/../x`, a `../` climbing out) stays `blocking`; one
  whose target is MISSING inside it (a file the bundle omits, a reference into a disabled skill) is a
  `warning`, and a publish with only warnings answers `verdict: 'warnings'` WITH the findings and a
  written snapshot (`current` flipped, the engine input exported); `analyze` mirrors it; the boot log
  names the warnings once by file:line. **Design v3.4 §2 — exactly one engine input:**
  `WICKED_CREW_STATE_HOME` is RETIRED as an engine input (reverses the round-4 "passed alongside"
  decision) — crew exports only `WICKED_SKILLS_SNAPSHOT`, the realpath of
  `<state home>/skills/snapshots/<gen>` with every component a real directory, and core#399 derives
  the state home from that layout (parent `snapshots`, grandparent `skills`); `GET /diagnostics`
  keeps reporting `skills.stateHome` for humans. **Codex round 6:** (C1) the `.venv` link
  authorization no longer trusts `snapshot.json` — `gardenSource.baseline` must be a 64-hex content
  hash that `manifest.json` knows, `venv` / `gardenSource.kind` are enum-validated, and the link is
  verified INDEPENDENTLY of the metadata text: `baseline/<hash>/.venv` is lstat-walked from the root
  (no link at any component), must be a real directory, and the link's canonical target must equal
  that directory's canonical path inside the canonical root (a tampered manifest + retargeted link +
  forged hash used to verify); (H1) `manifest.json` and every `snapshot.json` are read NO-FOLLOW — a
  symlink standing in for either is refused by name (`isSeeded` is lstat-based, so the seed never
  wipes `effective/` around a linked manifest); (H2) reset and refresh-baseline go through the SAME
  park-and-rollback transaction as replace/add (`swapStaged`): every file a swap removes OR
  overwrites is parked by rename before a single placement, and a mid-swap failure restores the tree
  byte-for-byte with the revision unchanged (a refresh also reaps its unreferenced new baseline) —
  both used to remove/overwrite in place, leaving partial content behind a 500; (H3) the plugin
  SOURCE is ingested no-follow BELOW a once-resolved root (an operator's symlinked config dir still
  reaches it): a symlinked `plugin.json`, catalog, root file, `skills/<x>` dir or any link inside a
  bundle dir refuses the seed (`skills.config`, nothing created) or the refresh (a 2xx `blocked`
  `path-invalid` naming the entry, nothing copied); (M1) the bundle closure is ONE allowlist
  (`bundle.ts` `inBundleClosure`: the `.claude-plugin` catalogs, `skills/**`, `scripts/**` minus `ci/`,
  `wg/` and `wg-*`, `schemas/**`, `docs/examples/**`, `pyproject.toml`, `uv.lock`) shared by the seed, the support API
  (a PUT outside it is a 2xx `blocked` `outside-closure` envelope — a new finding kind, api-types
  0.28.0 — and a GET a 400) and publish/analyze (a file found under `effective/` outside it is
  BLOCKING by path); (M2) the core-closure drift check is NON-skippable: the vendored
  `tests/fixtures/core-workflow-skill-refs.json` records wicked-core's `workflows/*.json` skill_refs
  at the pinned core-ts version, must equal the pin (else "refresh the fixture with the core-ts
  bump") and be ⊆ `registeredSkillRefs(BUILTIN_WORKFLOWS)`; the runtime source stays
  `adapter.listWorkflows()` (the engine has no separate catalog — core's JSON are drop-ins crew
  registers) and the sibling-checkout comparison stays as the local extra; (M3) a launch-pin
  listener failure FAILS the launch — the engine is never called, the other listeners see
  `rejected`, and the listener's error surfaces as the launch error (it used to be swallowed).
- **Skills keystone — codex round-5 hardening; the skills root is not a setting** (PR #480). Six
  fixes to the crew-owned skills root: (1) the `skills_root` setting and the `WICKED_CREW_SKILLS_ROOT`
  env override are RETIRED (coordinator decision) — a configurable root accepting any absolute path
  let `PUT /settings {skills_root: "~/.codex/skills"}` aim the seed at the user's codex skills before
  the runtime reported the location as incompatible (design v3.1 §1: one storage root; v3.2 §1:
  never a user CLI directory). The root is `<state home>/skills`, full stop: a `skills_root` a client
  sends is dropped and named in the audit entry's `ignored`, a hand-edited settings.json value is
  dropped on read, `GET /settings` never shows it, `PUT /settings` no longer re-applies the skills
  seam, and the daemon REFUSES TO START (`SkillsRootUnfencedError`, `src/skills/root-fence.ts`)
  when the root's canonical path leaves the state home, lands inside a known user CLI directory
  (`~/.codex`, `~/.pi`, `~/.copilot`, `~/.config/opencode`, `~/.claude`, `CLAUDE_CONFIG_DIR`), or
  the root entry is a symlink; the store has no `reroot` any more (a new root is a new store), and
  the test harness arms the daemon STATE HOME (`setCrewStateHome`) instead of a skills-root env;
  (2) catalog recomputation is CONTAINED: every internal read (`recomputeDerived` — kind,
  portability, the core closure's SKILL.md texts — and the catalog rebuild's name derivation) walks
  every component from the skills root with lstat, so `effective/skills/gamma -> /outside` is
  skipped and reported (a blocking `path-invalid` at publish/analyze, a warning on a mutation of
  another skill), never read through — a leaf-only check used to derive metadata from the outside
  bytes; (3) incompatible file-map paths are refused BEFORE mutation — a key that is a directory
  prefix of another (`x` + `x/y`), a key naming an existing directory the swap cannot clear, a key
  whose parent is an existing non-own file — and `replace`/`add` are STAGED: the replacement is
  written in full under the root, the skill's own files are parked by rename, the staged files are
  renamed into place, and any failure rolls back byte-for-byte (mode bits included) with the
  revision unchanged — the old remove-then-write order destroyed the notes it could not replace and
  left a partial replacement behind a 500; (4) snapshot verification SEES symlinks: the walk
  enumerates link entries (`walkTree`), the content hash covers them (path + link text,
  `hashTree`), and `current` refuses any link but the root-level `.venv`, which must be present iff
  `snapshot.json` records the env as `synced`, carry exactly the link text publish wrote, and resolve
  to this root's `baseline/<recorded baseline>/.venv` — an injected outside-pointing link used to
  leave the verified hash unchanged; (5) route paths are decoded EXACTLY ONCE, by Fastify — the
  store's second `decodeURIComponent` is gone, so `100%25.txt` is the filename `100%.txt` and the
  literal `a%252Fb.txt` stays `a%2Fb.txt` instead of becoming the path `a/b.txt`; (6) portability
  classification models interpreter options that take a SEPARATE value (`python -W x` / `-X x` /
  `-m x` / `-c x`, `node --require x` / `-r x` / `--loader x` / `--import x` / `-e x`, `uv run
  --python x` / `--with x` …), so the cwd-relative script after them is still non-portable
  (`python3 -W ignore scripts/foo.py`, `node --require foo scripts/x.js` used to read as portable).
  Plus two Copilot nits: `compareVersions` is a TOTAL order (a prerelease suffix sorts below its
  release, prereleases compare the semver way, distinct strings never compare 0 — the live-plugin
  pick no longer depends on `readdir` order), and refs.ts documents that glob metacharacters (`*`,
  `?`) terminate a path token.
- **Skills keystone — codex round-4 hardening** (PR #480). Six fixes to the crew-owned skills root:
  (1) persisted skill KEYS are validated at manifest parse — a safe single segment in the skill-name
  charset that IS the path-derived name of its `dir` (the copilot view lays a skill out under its
  key) — and `copyFiles` preflights EVERY destination's shape (`..`, absolute, separator, NUL) and
  symlink walk before the first byte moves, so a refused record writes nothing; (2) the skills root
  ITSELF is checked before every read and mutation (`manifest`, every contained path, the manifest
  commit, `current`, seed, provisioning, publish, reaping): a real directory, never a symlink, whose
  canonical path is the one bound at boot — a root replaced by a link to a copied store (or an
  ancestor swapped under the daemon) refuses every operation with a loud 503
  (`SkillsRootInvalidError`), never redirects one; (3) provisioning validates `baseline/<hash>`
  (content-hash charset, reached without crossing a link, a real directory), the `.venv` and marker
  paths and the daemon's `.uv-cache` BEFORE `ensureVenv` removes, syncs, writes a marker or chmods
  anything — a symlinked hash dir refuses the publish before uv runs; (4) refresh-baseline is ATOMIC
  against refusal: the three-way merge is decided in memory, every destination (takes and removals)
  is preflighted, then the baseline is captured, the takes are staged under the root and swapped —
  a refused destination answers the normal 2xx `blocked` `path-invalid` envelope with nothing
  changed (no file copied or removed, no baseline captured, revision unchanged) instead of a 500
  after the files ahead of it had landed; (5) the core closure consumes DECLARED mandates from the
  parsed YAML `mandates:` list (escaped scalars count, the Claude colon form is normalized, entries
  must be non-empty strings, each positioned by its node's line) and scans prose over the BODY only —
  the frontmatter block is never regex-scanned (verified over the live 12.32.0 catalog: the closure is
  unchanged, 8 skills, 0 absent); (6) launch pins never expire by publish count: every launch the
  daemon hands the engine (`CoreAdapter.onLaunch` — launchRun, resumeRun, confirmGate,
  launchCampaign, resumeCampaign; a campaign's engine-launched node runs under the campaign's
  umbrella pin) opens a pin at the exported generation BEFORE the engine call, accumulates every later
  publish, and is released only by the engine's `skillsSnapshotHanded` report for that session, the
  run's / campaign's terminal frame, or the engine rejecting the launch; reaping skips any generation
  with an unreleased launch pin. Plus, from core#399's round 4: the atomic `current` relink creates
  its transient link INSIDE `snapshots/` (`.tmp-current-<hex>`, a `snapshots/.tmp-*` entry core's
  launch-time fence classifies) and renames it over `skills/current`, so no unclassified child ever
  appears under `skills/` during a publish (the former `skills/current.tmp-<hex>` would have refused a
  launch listing `skills/` in that window); `tests/fixtures/state-home-subtrees.json` mirrors core's
  copy byte-for-byte (the v3.3 §1 sibling-generation fence and its residuals in the `$comment`).
- **Skills keystone — codex round-3 hardening** (PR #480, on top of design v3.2). Nine fixes to the
  crew-owned skills root: (1) every PERSISTED manifest path is validated at parse — a skill `dir`, a
  baseline identifier or a file-record key carrying `..`/an absolute piece/a separator is a corrupt
  manifest refused loudly, and `containedPath` re-checks the FINAL joined path lexically so a trusted
  `dir` cannot escape the root either; (2) the structural storage dirs (root + `effective/`,
  `baseline/`, `snapshots/`) are refused if a symlink stands in for one — before publish, baseline
  capture, provisioning, reaping and `current` verification (which now judges containment against the
  lstat-clean `snapshots/` path, not the realpath of a redirected one); (3) live-generation reaping
  pins the EXACT generation the engine reports it handed each session (`skillsSnapshotHanded`), never
  "current at event time", with a bounded launch pin bridging the spawn→event gap; (4) parent reset
  excludes every path a nested `SKILL.md` owns in the EFFECTIVE tree (not only the baseline), so a
  child added directly under a parent keeps its files; (5) reset preflights every destination and
  STAGES the restore before removing anything, so a blocked reset (a symlinked child dir) mutates
  nothing and answers the 2xx `blocked` envelope; (6) a baseline env whose read-only lock FAILS
  leaves no ready marker (the partial env is removed) and a retry re-provisions and re-locks —
  readiness is trusted only when the marker AND the read-only bits verify; (7) frontmatter is parsed
  by a real YAML grammar (`yaml`) and anything it rejects blocks, with the strict subset
  (single-document mapping, scalar `name`, list `mandates`) kept on top; (8) 409 is reserved for a
  stale `expectedRevision` alone — a publish-in-flight or a root-changed refusal wrote nothing and
  answers a 2xx `blocked` findings envelope (`publish-in-flight` / `root-changed`, new finding kinds
  in api-types 0.28.0); (9) the route concurrency test is deterministic (provisioner-entered gates,
  released in `finally`, no wall-clock deadlines). New dependency: `yaml` (the standard TS YAML
  library).

### Added
- **`GET /projects/:projectId/interactive/api/docs` stamps `projectId` on every row** (#472) — the
  bridge's list relayed field-for-field plus the mount's project, so clients can attribute docs
  across projects. One static segment more specific than the proxy wildcard; `POST /api/docs` and
  everything else still stream through the pure-transport proxy. api-types **0.26.0** carries
  `InteractiveDocSummary`.
- **`rule_coverage` + `effect: 'warn'` on the wire** (the core #394/#395 companion) — api-types
  **0.27.0**: `GovernanceEvalReport`, `EvalRunSummary` and `EvalRunDetail` carry an OPTIONAL
  `rule_coverage { exercised, unexercised: [{ rule_id, steering_type }] }` (the rules NO sample
  exercised — the blind spot a bare gap count hides; absent, never fabricated, on a report from a
  pre-#394 engine), and `ConformanceRule.effect` admits the operator-authorable `warn` band. The
  run route persists `rule_coverage` verbatim (like `degraded`) so `GET /testing/evals[/:id]`
  serves it untouched. `GovernanceEvalResult.sample` gains an OPTIONAL `payload_hash` — the
  sha256 of the sample's full payload (id, description, kind, steering_type, signals), stamped by
  a producer that held the samples (the engine echoes no signals); the offline comparison keys
  comparability on it.
  Codex round 7, in the same 0.27.0 (0.26.0 → 0.27.0 is this PR's one api-types bump — #474 landed
  0.26.0 first): `GovernanceEvalRuleCoverage` is completed with the
  engine's other two serialized fields — `recall_only` (the active rules of the slice carrying no
  effect, core #395) and `per_type` (the same partition per steering type: all seven keys, an
  `{ exercised, unexercised }` count pair each — evals.rs `RuleCoverage` / `TypeCoverage`) — both
  optional on the contract only because the daemon persists a run's coverage verbatim and validates
  none of it (a consumer reads an absent `per_type` as "no per-type coverage", never as zeros). The
  wire-contract test pins the engine's COMPLETE report shape — the fixture is evals.rs's own
  pinned-serialization test — with key-exact pins in both directions, beside the pre-#394 report
  (no coverage) and a two-field record, which still validate.
  Copilot on the rebased #475: a persisted RESULT ROW that is not the wire shape (`GovernanceEvalResult`
  — no `sample`, `fired` not an array, a verdict outside its union, a row that is no object; the store
  validates `results` only as an array) is likewise one reconciliation error naming the run, the index
  and the defect, EXCLUDED from the comparison — which stays over the well-formed rows, is not
  comparable, and withholds that side's summary-vs-results check rather than misattribute the
  shortfall — and never thrown over.
- **The INTERNAL evals corpus** — `e2e/corpus/wicked-internal-corpus.json` pins five wicked
  repos (estate v0.16.6 · garden v12.31.0 · crew v0.7.24 · studio v0.5.0 · interactive v0.8.1) to
  the commit each tag resolved to plus an ACTION window of ≥ 50 real commits behind it (walk
  release tags back, capped at 180 days; a shortfall is recorded, never widened); the pin is the
  constant and moving a tag is a deliberate PR. `scripts/evals-internal-corpus.mjs` (plain node;
  its one import beyond the builtins is crew's shared `src/api/eval-sample.js` — the ROUTE's own
  zod sample schema, so the script can never accept a sample `POST /testing/corpora/import`
  rejects) `pin`s / `check`s it (fail closed on a re-cut tag or a hand-edited pin), `materialize`s
  each tag by `git archive`, derives `samples` (one `EvalSample` per window commit — path-table
  steering type, unsure ⇒ development; `good` unless `known-bad.json` says otherwise), and `run`s
  them through `wicked-core rules eval` when the engine is on PATH. Our doctrine rules apply to
  these repos; the 15-repo wicked-e2e OSS set stays the E2E functional corpus and is NOT an eval
  corpus. Fail-closed throughout (the two codex rounds on #475): a pinned `repo` must be one safe
  path segment; `materialize` is contained to the realpath of its root, refuses symlinked
  destinations, pins the operator's git attributes away for the archive and verifies the extracted
  tree entry-for-entry against `git ls-tree` (an un-overridable `export-ignore` is a named
  refusal; the receipt carries each `tree_sha`); the derivation pins its complete git
  configuration and reads paths NUL-delimited, never trimmed (byte-identical samples under any
  operator config, exact filenames — `samples_hash` is `sha256:6e70752f…`); a missing/malformed
  `known-bad` file is an error, never an empty allowlist; every artifact publishes tmp+rename
  (samples under a lock with one `generation` stamp); `run` verifies `samples.meta.json` against
  `samples.json` and the selected pin before probing the engine (ENOENT is SKIP; any other probe
  error, a non-zero `--version` or an empty answer is a tool failure), stages exactly those
  samples in a fresh private dir, checks every result row against its staged sample and stamps it
  with the sample's `payload_hash`, and publishes `report.json` + `report.meta.json` as ONE
  verifiable generation (`.report.lock`; `generation` in both, `report_sha256` in the meta;
  `readPublishedReport()` refuses a torn pair) carrying complete provenance — engine version +
  build identity (realpath + sha256 of the binary), the rule-snapshot identity with its method
  (`engine-list` from `rules list --include-retired --json` read back before the temp store is
  deleted; `seed-dir` when the engine lacks the command — said so), `pin_hash`, `samples_hash`.
  Codex round 3: `check` refuses a SHALLOW checkout by name (a depth-1 clone plus a depth-1 fetch
  of the from-tag resolves BOTH pinned tags while the window between them is missing — fewer
  samples under the unchanged pin identity) and `samples` checks each window's derived commit and
  sample counts against the pin's `commits` (outside `pin_hash` by design; a mismatch is a
  refusal); `materialize` holds `.materialize.lock`, extracts + verifies every tree into a staging
  dir beside its destination and swaps only after ALL verified — a failed repeat leaves the
  previous trees and receipt byte-intact, a failed first run leaves no receipt, concurrent
  materializations never interleave; `run` verifies the engine's report before publication —
  exactly one row per staged sample, engine verdicts, `fired` arrays, a summary that is the rows'
  tally — so an empty or partial report is a named tool failure, never a recorded evaluation
  (a valid all-gap report still passes).
  Codex round 4: every git the script runs is replacement-blind (`--no-replace-objects` +
  `GIT_NO_REPLACE_OBJECTS=1`) and `check` / `pin` refuse a checkout carrying `refs/replace/*` by
  name (`replace-refs-present` — a replacement rewrites a window commit's message and tree while
  both tag shas and `rev-list --count` stay the pin's); `materialize` keeps every `.prev` backup
  until the receipt is published and rolls a failed swap or receipt write back (destinations
  restored byte-identical, the previous receipt intact; a failed rollback removes the receipt and
  names both faults — proven by test-only fault injection at the second swap, the receipt write
  and the rollback itself); `verifyEngineReport` also refuses rows inconsistent with their sample's
  kind (a good sample judged `gap`, a bad one `false_positive`, `expected` missing or off its kind,
  `fired` disagreeing with the verdict) and malformed report fields (`degraded` absent or not
  null / `facet-only`, `rule_coverage: null` — what crashed the summary print after publication);
  the valid all-gap fixture is now built from BAD samples.
  Codex round 5: `run` resolves the engine ONCE with exec's own search semantics (every `PATH`
  entry in order, an EMPTY entry being the cwd — the old resolver skipped it and could hash
  another build than the one the spawn ran — `PATHEXT` on Windows, an executable regular file
  required) and spawns THAT absolute path for `--version` / `rules ingest` / `rules list` /
  `rules eval`, never the bare name: the file hashed into the provenance is the file that ran
  (hashed again after the run; a binary replaced underneath is a tool failure). `materialize`
  invalidates the receipt BEFORE the first tree moves — an in-progress marker is published and the
  previous `materialized.json` moved aside — so a process killed between two renames leaves
  incomplete trees beside NO receipt; every start inspects the root (`inspectMaterializeRoot`) and
  repairs a torn swap (`.prev` trees rolled back, staging / marker / previous receipt removed,
  nothing trusted until the run publishes), finishes a torn cleanup, sweeps stale staging;
  `readMaterializeReceipt()` refuses a damaged root by name with that repair as the hint (proven by
  a deterministic SIGKILL between the two renames and after the receipt write). `verifyEngineReport`
  reconciles `rule_coverage` with the rows per the engine's definition (a rule is exercised when
  ANY claim fired it, blocking or not; a row's `fired` is the blocking subset): no id both fired and
  unexercised, `exercised` ≥ the distinct blocking-fired ids, no duplicate unexercised id,
  `recall_only` a non-negative integer when present — the round-4 fixture that blessed a fired rule
  as unexercised is corrected; the summary line prints the blocking-fired count beside `exercised`.
  Codex round 6 (+ one Copilot thread): `readMaterializeReceipt(dir, pin)` trusts a receipt only as
  the materialization OF the selected pin — `pin_hash` and a well-formed `generation` present and
  the pin's, `repos[]` exactly the pinned repos at their tag + sha, and every `path` the real
  directory `<root>/<repo>@<tag>` (present, not a symlink, a directory, realpath-equal) — a
  foreign path, a link, a plain file, a missing identity or an extra / missing / duplicated repo is
  a named refusal, never "clean" (the reader used to accept any `existsSync` path and an
  identity-less receipt). `resolveExecutable` reserves the exit-zero SKIP for true absence
  (ENOENT / ENOTDIR): any other lookup error — `stat` EACCES on a PATH directory, EIO, a failing
  realpath — is `{ path: null, error }` and `run` reports a TOOL FAILURE naming syscall, errno and
  candidate (every lookup error used to be swallowed as "not installed"); a regular file without
  execute permission stays `blocked`. A `tar` that fails or cannot be spawned inside `materialize`
  is a `ToolError` (exit 1), not a plain Error (exit 2) — Copilot.
  Codex round 7: `run` inspects `.error` on the `rules ingest` and `rules eval` spawns BEFORE
  reading their exit status or output — an engine removed (ENOENT) or made non-executable (EACCES)
  after the `--version` probe answered is a TOOL FAILURE (exit 1) naming the step, the errno and the
  executable, where it used to throw a TypeError on the undefined output (exit 2, the errno lost); a
  step killed by a signal reports `signal SIG…` instead of `exit null`.
  Codex round 8: `verifyEngineReport` validates a present `rule_coverage.per_type` — a plain object
  keyed by steering type, each row `{ exercised, unexercised }` of non-negative integers, the rows'
  `exercised` summing to the total and each type's `unexercised` equal to the listed rows of that
  type (`run` never passes `--type`, so the report is unfiltered and the rows partition the whole
  eligible set) — so `per_type: null` (which passed the gate and then crashed the offline
  comparison) or `development: { exercised: 999 }` beside `exercised: 0` is a named refusal before
  publication.
- **`compareEvalRuns`** (`src/api/eval-compare.ts`) — the offline S17 comparison of two recorded
  eval runs: per-sample verdict flips classified permitted/flagged, one-sided ids, kind AND
  payload-identity changes (`comparable` requires an equal `sample.payload_hash` per shared id; a
  side without WELL-FORMED hashes — `sha256:` + 64 lowercase hex, `PAYLOAD_HASH_RE`; a malformed
  persisted value is no identity, never "changed" — is `unverified: no sample identity`, never
  comparable — `comparable_reason` says why), summary reconciliation, and a `rule_coverage` delta
  over what the records ENUMERATE (codex round 6): the wire's `exercised` is a COUNT of every rule
  any claim fired, blocking or not, while `results[].fired` is the blocking subset (evals.rs
  `rule_coverage` / `evaluate_sample`), so a record names only `unexercised ∪ fired` and its rule
  set is fully identified only when `exercised === |fired|`. `gained`/`lost` are asserted from
  listed ids on both ends; `added_rules`/`removed_rules` only when the silent side's inventory is
  complete, else withheld by name (`inventory: 'partial'`, `unidentified`, `transitions_withheld`)
  — a rule that leaves `unexercised` for a warn-only firing is no longer misreported as removed.
  An `exercised` count above the fired ids is valid warn-only exercise; a count BELOW, an id both
  fired and unexercised, or a duplicate unexercised id is the record contradicting itself — a
  reconciliation error. Two valid records always reconcile.
  Codex round 7 — type filters: the engine's `--type` slices the samples and the coverage
  DENOMINATOR but not the gate (evals.rs `run_evals` / `decide_lane_rules` vs `evaluate_sample`), so
  a filtered run's rows may fire rules OUTSIDE the denominator — `fired: ['SECURITY-DENY']` beside
  `exercised: 0` is a valid development-filtered record, which used to fail against itself. Each
  record's coverage is now reconciled against the denominator it was produced under, reported per
  side in `coverage_reconciliation`: unfiltered against the rows' blocking-fired ids (`'rows'`);
  filtered against the engine's own `per_type[<filter>]` row (`'per_type'`), or not at all when the
  record has none (`'n/a (engine reports no per-type coverage)'`). `per_type`, when present, must
  sum to `exercised` and agree per type with the listed rows; a listed-unexercised id that fired is
  a contradiction under any filter (the row types the rule into the slice). Two runs under
  different filters are not comparable (`differing-type-filter`) and get no coverage delta; under
  the same filter a fired id is typed into the slice only when the other side lists it unexercised
  — `gained`/`lost` stay certain, `unidentified` counts what the other side cannot type, listed
  candidates are asserted only when the silent side is complete, and a fired-only id is always
  withheld by name (it may be a rule of another type, outside the denominator).
  Codex round 8 — no inferred inventory: `added_rules`/`removed_rules` are asserted only from an
  explicit rule inventory on BOTH records, and no field of the wire carries one (`exercised` and
  `recall_only` are counts, `unexercised` names only the unexercised rules, a row's `fired` only the
  blocking firings), so every comparison of daemon-recorded runs is `inventory: 'partial'` with both
  lists empty and each one-sided id in `transitions_withheld` with what it may be instead (an unnamed
  warn-exercised rule, a recall-only or retired rule outside the eligible partition, under a filter a
  rule of another type, or a real store change). The round-6 `exercised === |fired|` ⇒ complete
  inference is deleted: under a filter it typed a fired id into the slice through the OTHER run's
  row and, after a rule moved type, reported a present, exercised rule as removed. `unidentified` is
  per record (unfiltered `exercised − |fired|`, filtered the whole `exercised`), never reduced by a
  cross-run intersection; `gained`/`lost` stay certain. A persisted `rule_coverage` that is not the
  wire shape (`per_type: null`, `null`, a non-array `unexercised`, a bad row or key) is
  `coverage_reconciliation: 'unverified (malformed rule_coverage)'` on that side with a
  reconciliation error naming the defect, no delta — and no throw (it used to crash on
  `Object.values(null)`).
- **The revised evals test plan** at `docs/testing/evals-test-plan.md`, plus the deterministic
  eval-store / route scenarios it names (traversal ids over HTTP, 50-way write serialization,
  fault-proven detail-before-index ordering and queue recovery, torn/malformed/missing rows,
  `facet-only` + `rule_coverage` passthrough, the parsed snake_case guard, 501 parity, and the
  internal-corpus pin / samples / materialize / run semantics over a git fixture).
- **Crew-owned skills root** (skills keystone, design v3; companion to wicked-core#396). The daemon
  seeds `<state home>/skills` from the LIVE installed wicked-garden plugin (the marketplace cache's
  highest version — never the hand-installed copy, never a repo checkout; `WICKED_CREW_SKILLS_SOURCE`
  is the one explicit override) into a content-hash `baseline/<hash>/`, keeps the operator-edited
  `effective/` root beside it, and PUBLISHES immutable `snapshots/<gen>/` (enabled skills only,
  dependency closure, `snapshot.json`) behind an atomically flipped `current` link — handing the
  engine `WICKED_SKILLS_SNAPSHOT=<resolved snapshot>` at every spawn. Publish is crash-safe and
  idempotent on retry: the generation is allocated from the filesystem (max existing + 1), staged
  under `.staging-*`, renamed — never over an existing generation — the manifest is committed
  BEFORE `current` flips (an interrupted flip is finished at the next boot), and torn staging is
  swept. The newest three generations are kept; older ones are reaped only once no live run pins
  them (pins fold from the CoreEvent stream); a baseline (and its shared `.venv`) lives while any
  generation on disk references it. `current` is never trusted: it is realpath-contained under
  `snapshots/`, its `snapshot.json` validated, and the tree re-hashed against `contentHash` before
  the path is exported (`SkillsCurrentInvalidError` otherwise). Publish validates the whole tree —
  every `${CLAUDE_PLUGIN_ROOT}/…` and `../…` reference of an enabled skill must resolve INSIDE the
  snapshot (`..` is an escape, `dir/` resolves; file:line on failure), the frontmatter `name` must
  equal the path-derived name, malformed frontmatter (unterminated flow sequences / quotes) blocks,
  `.claude-plugin/{plugin.json,archetypes.json,components.json}` are required
  (`missing-plugin-manifest`) and must have the shape their readers expect — `plugin.json` names the
  plugin, `archetypes.json` carries its `archetypes` collection (`catalog-invalid`) — a declared
  frontmatter name that is ANOTHER catalog skill's key blocks whether or not the declaring skill is
  enabled (`name-collision`), and the core-by-reference closure (every registered workflow
  `skill_ref` + transitive SKILL.md mandates) must be COMPLETE: a missing registered skill or an
  absent mandate is blocking, and disable recomputes membership from the live refs. Enable runs the
  same content + containment guards a write gets (a missing, malformed, renamed or symlinked skill is
  not enabled). The baseline's `.venv` is provisioned (`uv sync`, through the daemon's `execCapped`
  chokepoint, `UV_CACHE_DIR` under the root; ONE provisioning per baseline hash — concurrent callers
  await it) and AWAITED before a publish returns, marked complete on disk, locked read-only, and
  linked from a snapshot only once it exists. The env is REQUIRED, not best-effort: a bundle with a
  `pyproject.toml` whose env cannot be built (uv missing, sync error, lock failure) BLOCKS the
  publish (`venv-failed`). Publish is SERIALIZED (one at a time; a concurrent one wrote nothing and
  answers a 2xx `blocked` `publish-in-flight` envelope) and root-bound (a root whose canonical path
  moves or vanishes under a running publish aborts it — a 2xx `blocked` `root-changed` envelope —
  with nothing written); 409 is reserved for a stale `expectedRevision` alone. A published generation is
  locked read-only, and `current` is re-verified
  (`snapshot.json` shape — its rows may only name safe `skills/…` dirs deriving their own names —
  and content hash) on EVERY read, so a snapshot modified under a running daemon is refused by that
  daemon, not only after a restart. Ownership of a path follows the deepest `SKILL.md` ON DISK, so a
  nested skill created by a direct edit is never reached through its parent's edit/reset/replace.
- **`/api/v1/skills*` file manager** — `GET /skills`, `GET /skills/:name/files[/*path]`,
  `PUT /skills/:name/files/*path`, `GET|PUT /skills/support/*path`, `POST /skills`,
  `POST /skills/:name/{enable,disable,reset,replace}`, `POST /skills/{refresh-baseline,publish,analyze}`.
  Every mutation is CAS-guarded (`expectedRevision`; 409 only on a stale one) and answers 2xx
  `{verdict, findings[], revision}` — a `blocked` verdict is a normal response, and so is a
  containment refusal on a write (`path-invalid`). Containment is no-follow everywhere, walked FROM
  THE SKILLS ROOT: a skill directory replaced by a symlink, a symlinked CHILD directory inside it
  (every replace/add destination is walked before a byte moves), and a symlinked BASELINE ancestor
  (reset, `?side=baseline`, every baseline hash lookup) are refused, never followed; the names the
  store itself owns (`snapshot.json`, `manifest.json`, `current`, `views/`, `.venv`) are refused as
  support paths. Atomic writes open their temp file `O_EXCL` under an unpredictable name and
  preserve mode bits (executable support scripts survive edit/replace); typed capped reads
  (`content: null` on binary). `analyze` is a pure dry run (nothing persisted, revision unchanged);
  a blocked publish persists nothing — not the drift it observed, not the provisioning state. Reset
  restores content only, never enablement; refresh-baseline merges three-way per FILE — a user
  deletion is a modification (kept; `conflict` when upstream changed). Frontmatter is a STRICT
  subset: a plain scalar with `: ` (`description: hello: world`) or a flow collection continued on
  indented lines is checked, not folded. Portability treats ANY cwd-relative script invocation
  (`python3 -u scripts/x.py`, `./scripts/x`, `bash scripts/x`) as non-portable and never truncates
  a reference at a legal filename character. api-types **0.28.0** (re-minted from this PR's 0.27.0
  after #475 landed 0.27.0 first; the skills block itself is unchanged by the re-mint) carries the
  `Skill*` contract,
  `missing-plugin-manifest` / `catalog-invalid` / `venv-failed`, and the `skills` block of
  `GET /diagnostics` — and NO skills setting (see the round-5 entry: the root is not configurable).
- **One storage root, an explicit worker fence** (design v3.1 §1/§2). The skills root stays
  `<state home>/skills` — the same storage root as every other crew store. The worker Read fence is
  core's explicit denylist of state-home subtrees (the resolved `skills/snapshots/<gen>/` being the
  one non-denied path); `packages/crew/tests/fixtures/state-home-subtrees.json` is the shared
  registry of every top-level entry crew's stores create there, and a crew test asserts the daemon
  never creates an entry outside it (a new store cannot appear unfenced). Crew hands the engine
  exactly one SKILLS input, `WICKED_SKILLS_SNAPSHOT` = the absolute REAL path of `snapshots/<gen>`
  (`GET /skills` `current.path` and `POST /skills/publish` `snapshot.path` spell the same real
  path); `WICKED_SKILLS_CURRENT` is never set. Beside it, on every apply, `WICKED_CREW_STATE_HOME` =
  the canonical realpath of the daemon state home — core derives the worker fence from it (no more
  literal `.wicked-crew` basename; core#399 round 3) and cross-checks the snapshot is
  `<state home>/skills/snapshots/<gen>` — which holds by construction: the root IS
  `<state home>/skills` (not a setting; round 5), and `GET /diagnostics` → `skills` reports
  `stateHome` beside it. Every `snapshot.json` skill row carries a boolean
  `portable` (validated when `current` is verified) and a `nested` flag (a dir deeper than
  `skills/<dir>` — not invocable for a Claude seat).
- **Degradation ladder, surfaced** — `GET /diagnostics` → `skills` reports `published` /
  `fallback` / `blocked` / `config-error` with `skills.fallback` / `skills.blocked` /
  `skills.config` findings. Only an ABSENT configuration (no garden installed) leaves the engine
  input unset; a blocked first publish or a corrupt root points `WICKED_SKILLS_SNAPSHOT` at a
  non-existent refusal path (`<root>/refused/skills.{blocked,config}`) so launches fail loudly
  instead of falling back to the live cache past recorded disablement.
- **No writes into the user's CLI directories — ever; the copilot view rides the snapshot**
  (design v3.2). The daemon never writes to `~/.codex/skills`, `~/.pi/agent/skills`,
  `~/.config/opencode/skills`, `~/.copilot/skills`, `~/.claude/plugins` or any other user-level CLI
  location: the v3 additive mirror and its adoption ledger are withdrawn (nothing of the kind
  shipped), and there is no `skills_mirror` setting — a client sending one has it dropped and named
  in the audit entry like any unknown key. Skills reach non-Claude workers only through per-launch,
  wicked-owned delivery core performs from the snapshot: each published generation now carries
  `views/copilot/.github/skills/<name>/` — copies of the enabled PORTABLE skills' own files, part of
  the snapshot's content hash, immutable — which core hands a copilot seat as `--add-dir
  <snapshot>/views/copilot`; `snapshot.json` names the view (`views.copilot`). `portable` stays the
  admission key for every non-Claude view. A CLI without a lever (codex today) runs without wicked
  skills, and a unit on such a seat that requires one is REFUSED at launch by core — there is no
  proceed-with-disclosure setting. A test drives the whole store lifecycle under a fake HOME with
  populated CLI dirs and asserts they are byte-identical afterwards. `tests/fixtures/state-home-subtrees.json`
  now carries core's machine-readable fence half (`read_slot` / `denied_children` on the `skills`
  entry — byte-identical to core's embedded copy) and the crew test checks every child the daemon
  creates under `skills/` is either the read slot or a denied child.

## [0.7.25] — 2026-09-08

### Changed
- **Re-bundle the studio skin at 0.5.1.** Bumps the bundled `wicked-studio` dependency
  `^0.5.0` → `^0.5.1` (lockfile re-resolved) so `build:with-studio` ships the dashboard-honesty
  fixes from studio #200/#201 (governed-tests tile framing, store-wide-vs-loaded memory stats).
  No daemon behavior change.

## [0.7.24] — 2026-09-08

### Added
- **Per-run `created_at` on the run DTO** (#464/#466) — the daemon joins each run's launch instant
  (from the `run.launched` audit trail, hydrated at boot) onto `GET /runs` / `GET /runs/:id`, so the
  studio dashboards can bucket on real time. Recorded at every launch site via a shared helper.
- **The eval-run store** (#467) — every `POST /testing/evals/run` is persisted (crew-side
  `EvalRunStore`, daemon-scoped), so `GET /testing/evals[/:id]` serves a real history + drilldown.
  api-types **0.25.0** carries the `EvalRun*` types + the `created_at` / delivery-window additions.

### Changed
- Bundles **wicked-studio 0.5.0** (the command-deck landing rebuild + nav usability wave) as the
  default local UI.

## [0.7.23] — 2026-09-07

### Added
- **`created_at` + `since`/`until` date filters on memory + rules (#463).** `GET /api/v1/memory`
  and `GET /api/v1/governance/rules` expose `created_at` and accept inclusive `since`/`until`
  (unix seconds) bounds (api-types 0.23.0). Memory `created_at` flows today; rule `created_at`
  flows once a core-ts that surfaces it is pinned.

### Changed
- **Bundles wicked-studio 0.4.15** — the governed-knowledge dashboard (`/steering/dashboard`, the
  un-buried consolidated review inbox + `key=value` facet autocomplete, a project-homepage
  "Needs review" band) and the nav tweaks (logo dot removed, health-colored heart, Ask `?`-circle,
  "Test" below Make, custom site name).

## [0.7.22] — 2026-09-07

### Fixed

- Policy-proposal landing normalizes the severity before the enum check: a
  capture worker naturally writes the English word `"warning"`, but the engine's
  enum is the short `"warn"` (info/error/critical are already the natural words).
  `"warning"` (and case/whitespace variants) now maps to `warn`, so a derived
  middle-band policy lands as a steering rule instead of failing loud on
  approval. A genuinely out-of-enum severity still fails loud (never silent).

## [0.7.21] — 2026-09-07

### Added

- **`capture-learnings` workflow (#458).** A crew-only governed workflow —
  churn → hotspots → capture — whose phases reference the new
  `wicked-garden-repo-learn` skill via `skill_ref` (the method lives in the skill;
  a governed worker's prompt rides a single ~1022B PTY line, so inlining it would
  truncate). A run mines a repo's git churn + estate hotspots into faceted
  **memory AND policy** proposals reviewed in the Steering surfaces. New guard
  test asserts each phase keeps its `skill_ref` and never re-inlines the method.
- **Policy → steering landing.** Approving a **policy** proposal
  (`proposal.approve` → `handed_off`) now lands it as a real steering rule
  (`policy:<type>` → steering_type; `{rule,severity}` → `ConformanceRule`),
  closing the DES-MEM-FACETED-001 §5.2 TODO; `ApproveProposalResponse` gains an
  optional `landing`. Memory proposals still return `promoted` unchanged.

### Changed

- Bundled `wicked-studio` dist bumped to 0.4.14 — the per-repo **Capture
  learnings** action on the Repositories panel launches the `capture-learnings`
  run.

## [0.7.20] — 2026-09-07

### Changed

- `GET /api/v1/memory` now browses via estate's `memory.list` instead of
  `memory.recall`. The management surface could not inventory the store: recall
  retrieves nothing for an empty query and excludes faceted memories under empty
  intent. `memory.list` returns the COMPLETE in-scope set with per-item facets;
  `query` / `facets` / `limit` become crew-side post-filters over that set
  (query = case-insensitive content substring, so faceted memories are findable;
  facets = keep items carrying every axis:value; limit = row cap). Only
  `scope_prefix` reaches estate. Facets now ride through to `MemoryItem.facets`,
  powering the surface's facet filter (#456). Requires an estate binary with
  `memory.list` (estate ≥ 0.16.4).
- `wicked-crew-api-types`: `MemoryItem.facets` is now populated (no longer always
  `{}`); `ListMemoriesQuery` drops the recall-only `scope`, and `query`/`facets`/
  `limit` are documented as post-filters (`limit` is a row cap).

## [0.7.19] — 2026-09-06

### Added

- Memory-management API: `GET /api/v1/memory` (browse existing memories),
  `GET /api/v1/memory/coverage`, and `POST /api/v1/memory/retire` — the
  manage-existing half of the governed-knowledge surface, alongside the
  proposals API shipped in 0.7.18 (#454). `wicked-crew-api-types` 0.22.0 adds
  the `MemoryItem` / `ListMemoriesResponse` / coverage DTOs.

### Changed

- Bundled `wicked-studio` dist bumped to 0.4.13: the unified **Steering**
  surface. Policies and Memories are now sub-sections that each show both
  agent proposals (review/approve/reject) and manage-existing (browse/retire
  for memories, type-filtered rule management for policies). The seven
  per-steering-type pages collapse into one view with a type filter, and the
  standalone top-level Proposals page is folded into the sub-sections.

## [0.7.18] — 2026-09-06

### Added
- **Governed-knowledge proposal queue — the human review loop (DES-MEM-FACETED-001).** Interactive workers now recall faceted memory before working and **propose** reusable learnings into a built-in review queue, and operators review them in a new studio surface:
  - **crew#449** — a recall clause on draft/chat/edit tells the worker to `memory.recall` with the session's faceted intent and ground in what returns.
  - **crew#451** — a propose clause tells the worker to submit reusable learnings via the estate MCP `proposal.submit` (a safe write: the proposal is inert until approved; secrets/PII forbidden).
  - **crew#452** — the proposals API: an estate-mcp JSON-RPC client + `GET /api/v1/proposals` and `POST /api/v1/proposals/:id/{approve,reject}`, plus the `crew-api-types` `Proposal` contract.

### Changed
- **Engine floor → core-ts 0.7.16; studio dist → 0.4.12.** core-ts 0.7.16 stamps run provenance (`WICKED_RUN_ID`/`WICKED_RUN_UNIT`/`WICKED_RUN_AGENT`) into the worker's estate-mcp so proposals are attributable; studio 0.4.12 ships the proposal approval-queue surface, bundled as the default local UI via `build:with-studio`.

## [0.7.17] — 2026-09-05

### Added
- **Interactive draft/chat/edit workers ground in the wicked-estate MCP index (DES-GROUNDING-001, crew#446, #447).** The draft worker now researches through the estate index tools (`SearchEntity`/`FetchContent`/`ContextBundle`) with the offline repository snapshot demoted to a fallback (#446); chat and edit runs pass the `projectGraph` binding through to their workers so they get the same read-only estate MCP (#447). Ends the all-placeholder documents produced when a worker had no live repository grounding.

### Changed
- **Engine floor → core-ts 0.7.15.** Ships the grounding keystone (workers surface the estate MCP tools via `--mcp-config` + `permissions.allow`; the estate MCP runs `--readonly` so writes against operator stores are refused), the Boundary 1 OS-sandbox write-deny floor (worktree is the only writable root; a `SandboxUnenforced` disclose-and-continue event when the sandbox can't arm), and the bash-indexer deny (the wicked-estate CLI family is denied in worker Bash).

## [0.7.16] — 2026-09-05

### Fixed
- **The stall-watchdog escalation actually acts now (crew#442, #443).** A live 58-min wedge
  exposed a sweep re-entrancy DEADLOCK: `sweep()`'s `sweeping` guard had no timeout on its awaited
  engine calls, so a hung `listExecuting`/reassign pinned the guard `true` forever and silently
  killed the whole watchdog after the first 15-min detection frame — no escalation ever fired.
  Every awaited engine call inside the sweep is now bounded (`SWEEP_ENGINE_TIMEOUT_MS`), so the
  guard always releases; a skipped sweep logs loudly. A regression test proves a hung
  `listExecuting` cannot permanently wedge the watchdog.

### Added
- **Manual operator reassign lever: `POST /runs/:id/reassign` (crew#442, #443).** Recovers a wedged
  run's cursor unit through the same engine path the automatic escalation uses, for when
  auto-escalation is off, exhausted, or itself failed. `cli` optional (omit to let the council
  re-pick; when present it is soft-validated against the run's own seat pool), executing-only,
  audited as `run.reassigned`. api-type `ReassignRequest`.

### Changed
- **Engine floor → core-ts 0.7.14; studio dist → 0.4.11.** core-ts 0.7.14 ships #377 (opencode is
  the first governed non-claude ACP seat, via harness-provisioned config). studio 0.4.11 ships the
  rail/chrome control affordances (#183), bundled as the default local UI via `build:with-studio`.

## [0.7.15] — 2026-09-05

### Fixed
- **A deliver push failure STRANDS the run recoverably instead of hard-failing it (crew#432, #439)**:
  an auth/transport `git push` failure used to fail the run and reap the worktree — committed work
  lost, `POST /runs/:id/deliver` refusing the retry. The push-failure arm now carries the strand
  markers (generalized from the lift-conflict path), the branch + worktree survive, the error rides
  the run wire, and a post-hoc deliver can re-attempt once the operator repairs the credential.
  Pinned by a real-git strand-then-succeed-after-repair test.
- **Deliver stages the run's product, never scratch (crew#434, #439)**: `git add -A` is gone. Tracked
  modifications stage unconditionally (`git add -u`); untracked paths are classified per-file on a
  LOWERCASED basename — secret/scratch denylist (db/sqlite + `-wal`/`-shm` sidecars, sock/pid,
  dotenv incl. `.envrc`, media, key material `*.pem/*.key/*.p12/*.pfx/id_rsa*/*credentials*`),
  socket-named files, scratch dirs, and a 1 MiB cap — and EVERY exclusion is loudly reported in the
  phase output (a guard, not a silent drop). Legitimate new source files still ride (pinned).
- **Integration teardown cannot race the engine reaper (crew#429, #440)**: suites quiesce launched
  runs/campaigns to terminal before adapter close, and scratch removal goes through a shared
  retry-tolerant `removeScratch` (`rmSync` maxRetries/retryDelay), adopted across the affected
  suite class (~70 files). A literal no-race guarantee needs an awaitable engine drain — no such
  API exists in core-ts ^0.7.x; documented in `tests/setup/scratch.ts` with the upstream ask.

## [0.7.14] — 2026-09-04

### Changed
- **Engine floor → core-ts 0.7.11 (the perf program)**: the pinned `wicked-core-ts` moves
  `^0.7.10` → `^0.7.11`, shipping the engine side of the perf fixes — agy seat council-disabled
  (core#354), actor-scoped seat-health bench + abstention-aware quorum + one-wave dispatch
  (core#355), `StepStatus::TimedOut` (core#357 — arms this release's timed_out classification),
  and the idle-tick WAL checkpoint (core#356, estate store/memory/knowledge ≥0.14.7).
- **The seat-health `--version` recovery probe is retired (perf#3)**: a version probe is liveness,
  not readiness — it re-admitted a seat that could never complete a ballot 9× (agy). Readiness now
  lives engine-side as wicked-core#355's dispatch-layer bench (probationary REAL ballot); crew's
  tracker stays as the operator display and recovers a seat on its next real `ok` output. The
  `seatHealthProbe` server option is gone with it.
- **The stall-watchdog escalation ladder is ON by default, and reassign routes to a DIFFERENT
  seat (perf#4)**: crew#341's ladder shipped OFF (`workerStallEscalateMinutes` absent = detection
  only), and run 616c8661 then burned the engine's full 2h turn ceiling with 106 minutes of output
  silence while the watchdog fired once and watched. `workerStallEscalateMinutes` now defaults to
  **30** (an explicit `0` disarms — the stored opt-out is honoured as-is; 30 leaves ~55% headroom
  over the slowest legitimate time-to-first-output observed in the field, ~19.4 min, while still
  recovering ~4x faster than the 2h ceiling — the 15-minute notify rung is unchanged), and the `reassign`
  action routes the re-dispatch to a different seat from the run's own pool (`session.clis`) when
  one is available, skipping seats this run already stall-reassigned away from; a single-seat pool
  falls back to the in-place recycle. The `workerStallEscalated` frame now carries the failover
  target in `cli` plus an additive `previousCli` (the stalled seat). The stalled-seat memory is
  watchdog-local and per-run — a stalled seat is NOT an errored seat: it is never written to the
  engine's `worker_failed_clis` (resume-path exclusion) and never folded into seat health.
  Requires no engine change; the only mid-turn recovery used is the engine's existing
  `reassignUnit` (attempt bump + epoch cancel — the superseded turn's late output drops as stale).
- **Turn-timeouts are surfaced as what they are (perf#4, engine ≥ StepStatus::TimedOut)**: when a
  relayed `unitOutputCaptured` carries the new `stepStatus: "timed_out"` (the engine's own
  `WICKED_UNIT_TIMEOUT_SECS` ceiling — the last-resort backstop the silence ladder exists to
  preempt), the daemon audits `run.turn.timedout` and logs it loudly as the platform's own
  timeout, NOT an operator cancel. Compat contract: current/older engines never send the value, so
  nothing fires; the ambiguous `"cancelled"` spelling (operator OR timeout on old engines)
  deliberately triggers nothing — automatic action on an operator's cancel is the failure mode the
  distinguishing status exists to prevent. api-types: `stepStatus` union widened (additive) and
  `WorkerStallEscalatedFrame.previousCli` added.

### Added
- **Refusal warning on the gate wire (crew#419)**: when a paused unit's prompt reads as a pure
  sandbox/tool refusal — the worker reporting it could not act (read-only sandbox, rejected writes,
  "could not modify/regenerate"), with no sign of productive work — `GateInfo` now carries an
  additive `refusal: { matched, reason }` so an operator does not approve a refusal as if it were
  work. It is advisory only (never gates a decision) and omitted entirely on a normal gate, so the
  wire is byte-identical when there is nothing to warn about. `detectRefusal` biases toward NOT
  flagging: a genuine work transcript that merely mentions "sandbox"/"blocked", or a mixed turn that
  refused one tool but did real work, stays unflagged. The same detection runs on all three gate
  paths — live fold, event-log replay, and the durable `interaction_requests` row — so a gate served
  after a restart carries the same warning. api-types → 0.20.0 (additive).

## [0.7.13] — 2026-09-03

### Fixed
- **Governed-run delivery propagates an internal version bump to codegen + the lockfile (crew#426)**:
  a run that bumps `packages/crew-api-types/package.json` in its worktree used to deliver a branch
  whose `endpoint-manifest.json`, generated api tests, and `package-lock.json` still carried the OLD
  version — a per-run worktree is provisioned with `git worktree add` alone (no `node_modules`), so
  the version-stamping generators resolved the parent checkout's version and nothing re-synced the
  lockfile, reddening CI on the delivered PR. The deliver phase (`deliverPrScript`) now runs a
  preflight before it commits: `npm install` (re-syncs `node_modules` + `package-lock.json` to the
  worktree's own `package.json`) then `npm run manifest:endpoints` / `generate:api-tests`
  (regenerate the version-derived artifacts), so `git add -A` stages all three at the bumped version.
  The whole preflight (lockfile re-sync AND codegen) is scoped to the crew workspace — it runs only
  when the root `package.json` + `package-lock.json` AND `packages/crew` + `packages/crew-api-types`
  are all present — and uses `--prefer-offline`, so it is a byte-for-byte no-op for any other repo
  (no `npm install`, no install-time scripts) and never reaches the registry for a workspace-internal
  bump. Defense-in-depth: `apiTypesVersion()` now reads the workspace-local
  `packages/crew-api-types/package.json` before falling back to `require.resolve`, so codegen stamps
  the correct version even when `node_modules` is absent.

### Changed
- **Engine floor → core-ts 0.7.10 (crew#427)**: the pinned `wicked-core-ts` moves `^0.7.9` →
  `^0.7.10`, shipping the fix that lets the non-claude adversarial-review seat (codex) run BOUNDED on
  the governed-worker path (`--sandbox workspace-write`) — it can now run the verification suite
  instead of refusing under its default read-only sandbox, and an in-code cap keeps it bounded to its
  worktree regardless of a stale `clis.toml`.

## [0.7.12] — 2026-09-02

### Added
- **Signal instrumentation (crew#411)**: the daemon now records every SIGTERM/SIGINT it receives
  (timestamp + signal name) into a bounded in-process log (`DaemonSignalLog`). When an ACP bridge
  dies silently (`acpFallback` with `fallbackKind: session_died`), the daemon correlates the event
  against that log and emits a `warn` line stating which case it was: *"daemon also received SIGTERM
  at T (ΔXms) — likely group/terminal signal"* or *"no daemon signal within ±5s — pid-targeted
  external signal or transport close"*.

### Removed
- **The campaign-worktree pre-provisioning workaround** (#415) — `packages/crew/src/campaigns/worktrees.ts`
  and its call sites in the recon route and the core adapter — the removal that 0.7.11's release
  notes tracked separately (#415). On the ^0.7.8 engine floor `create_worktree` sanitizes a campaign-shaped run id itself
  (core#345/#347 — `:` → `-`, byte-for-byte the old `branchSafe()` spelling), ownership-marks the
  tree, adopts a pre-provisioned one, and the startup reaper spares live trees under either
  spelling, so the daemon-side workaround was dead weight. Campaigns already in flight under 0.7.11
  keep their existing trees: the engine's path derivation probes the raw spelling before the
  sanitized one.

### Changed
- **Engine floor: `wicked-core-ts` ^0.7.9** — a seat override that omits `trust_flags`
  inherits the built-in's trust posture (the codex-sandbox fix, core#349), and ACP bridges spawn
  in their own process group so a terminal/group signal can't reach an idle bridge (core#350).
- **The recon fan-out no longer excludes win32** (#415): `POST /testing/recon` fell back to a
  label-only per-run fan on Windows solely because the engine's `wicked-worktrees/<run_id>` path
  carried a `:`. Sanitized engine paths are NTFS-safe (illegal characters mapped, reserved device
  stems prefixed, trailing `.` stripped), so Windows now registers a real engine campaign — the
  posture `POST /campaigns` always had. Reasoned from the engine source, not executed on Windows:
  CI is `ubuntu-latest` only.
- **A worktree failure in a recon fan surfaces per node instead of as a pre-launch 500** (#415):
  minting moved into the engine's dispatch, so a git refusal fails that node and leaves the campaign
  registered, rather than aborting the request with nothing scheduled. Both campaign entry points
  (`POST /testing/recon`, `POST /campaigns`) now behave identically — and the repo-scoped
  `POST /campaigns` path, which never carried the workaround and until now had no real-engine
  coverage at all, gained an integration test proving it provisions engine-natively on its own.

### Fixed
- **A deliver-phase LIFT collision now STRANDS the run, it no longer FAILS it** (#418): the engine
  reports a run `failed` whenever a Tool phase exits non-zero, and the deliver phase is one — so a
  run whose WORK was complete but whose rebase-onto-`origin/main` or push collided went to
  `status: failed`, `delivery: none`, hiding that the committed work on its `wicked/<id>` branch was
  fine and only the lift had collided. crew now reinterprets that exact shape on the wire as
  `completed` + `delivery: 'stranded'` (recoverable via `POST /runs/:id/deliver`, counted by the
  home needs-you rollup), keyed on a `deliver: LIFT-CONFLICT` marker the hardened script prints
  ONLY on a rebase conflict or a non-fast-forward push. A spawn/infra fault, a `gh` failure, a
  nothing-to-deliver refusal, or a genuine work-phase failure all stay terminal `failed` as before.
  The engine's durable `failed` record is untouched — this is a wire derivation, like `delivery`.
- **The CHANGELOG `[Unreleased]` collision magnet** (#418): two runs that both append release-note
  lines to `[Unreleased]` conflicted on the rebase by construction, though the added lines never
  truly disagreed. The deliver script now UNION-merges a rebase conflict whose conflicted paths are
  all `CHANGELOG.md` (keeping both sides' additive lines) and continues — so the common collision
  just delivers. Scoped to the changelog by basename: a conflict in any other file is left exactly
  as loud as before and strands recoverably.

## [0.7.11] — 2026-09-02

### Added
- **The campaign surface wire** (studio#27, #412, `wicked-crew-api-types` 0.19.0): ad-hoc run
  grouping (`POST /runs` `campaignId` attach / create-on-first-use `groupLabel`, loudly validated),
  per-node `node_delivery` + `attached_runs` + `groups` on `GET /campaigns` — no N+1, parallel
  per-member rollup, linear group-index hydrate.

### Changed
- **Engine floor: `wicked-core-ts` ^0.7.8** — campaign-safe worktree names with ownership-marked
  trees (core#345/#347; crew's `campaigns/worktrees.ts` pre-provisioning workaround remains for
  compat and adoption, removal tracked separately) and the single elicitation-capability predicate
  (core#346; the elicitation E2E fixture presents the verified stem accordingly). Bundles
  wicked-studio 0.4.10 (the campaign surface).

## [0.7.10] — 2026-09-01

### Fixed
- **The steering landing coerces real-worker field shapes into the engine schema** (#408 — found
  by the live re-verification of #388): a real worker proposes `targets` as a string array,
  `trigger` as prose, `criteria` as a list — shapes the engine's `ConformanceRule` refuses, which
  failed the WHOLE landing. `normalizeProposedRule` now repairs exactly those shapes (empty facet
  `targets`, dropped prose `trigger`, joined `criteria`, defaulted/clamped `confidence`), names
  every adjustment in the `governance.rule.upserted` audit (`coerced`, per rule), and the
  propose-phase instructions spell the store schema so workers author the right shapes.

## [0.7.9] — 2026-09-01

### Added

- **Stall-watchdog escalation ladder** (crew#341, api-types 0.18.0): detection now drives
  recovery — notify (always) → act (opt-in) → fail loud. OFF by default: setting
  `workerStallEscalateMinutes` (`PUT /settings`, integer minutes, `0`/absent = off) arms the
  second stage, and a run still silent past it gets ONE action per quiet period —
  `workerStallEscalateAction: 'reassign'` (default: recycle the wedged cursor unit in place via
  the engine's `reassignUnit`; the stale turn is superseded, never folded as a failure, and the
  unit re-dispatched to its own seat) or `'notify'` (surface loudly, touch nothing).
  `workerStallMaxEscalations` (default 2) budgets automatic reassigns per run; a spent budget
  answers `outcome: 'exhausted'` instead of more recovery. Every escalation rides a new
  `workerStallEscalated` /ws frame (`needsYou: true` exactly when a human should look) and is
  audited as `run.stall.escalated` under the system `stall-watchdog` actor. The crew#287
  detection knob (`workerStallMinutes`) and `WorkerStalledFrame` join the published contract.
- **The delivery contract** (#393, api-types 0.18.0): a completed code run ends with a
  reviewable deliverable or an explicit, visible decision not to.
  - `POST /runs` `deliver` accepts `'pr' | 'none'`; OMITTED now DEFAULTS to `'pr'` for a
    repo-scoped launch of a code-work workflow (a def with an `executes_code` phase —
    feature/bug/migration; chat and other read-only defs stay `'none'`, their clean worktree
    would only fail the deliver script). The new `deliverDefault` daemon setting
    (`PUT /settings`, `'pr' | 'none'`) flips that default; an explicit per-launch value always
    wins. The launch audit entry records the RESOLVED decision plus `deliverDefaulted`.
  - The run wire's `delivery` is now a tri-state string on every served run — `'delivered'`
    (with the PR URL in the new `deliverUrl` field) | `'stranded'` (a COMPLETED repo-scoped run
    with no recorded PR whose worktree still exists — derived honestly for runs recorded before
    this change, the run 83052f0b class) | `'none'`. ⚠ Wire reshape: the 0.11.0 object spelling
    `delivery: { kind: 'pull_request', url }` is gone.
  - `POST /runs/:id/deliver` — post-hoc delivery: lifts a stranded run's worktree into a PR
    with the SAME hardened script as the deliver phase (#293/#317 — commit, refuse the default
    branch, rebase with a loud abort on conflict, never force, push, `gh pr create`, success
    re-derived from a real PR URL). Idempotent (a delivered run answers its recorded URL, never
    a second PR); failures are loud 4xx/5xx carrying the script's own words.
  - Runs that deliver keep their identity: the acceptance gate and the workflow-name patch
    strip the per-run appended phases (`verify-deliverables`, `deliver`) before phase-sequence
    matching, so a delivered feature run still resolves its acceptance requirement and its
    workflow name.

### Fixed

- **Recon siblings pause at their intake gates** (#391): every `POST /testing/recon` launch —
  fan, single, unscoped — now carries `human_confirm: before:1` (the launch banner's promise)
  instead of silently launching unattended; `ungated: true` is the explicit, audited opt-out
  (api-types 0.17.0).
- **Recon fan-outs are real engine campaigns** (#390): a launch over ≥ 2 resolved repos
  registers a `CampaignDef` (one governed node per repo, `continue_independent`, fan-width
  concurrency) and files its runs under it, so `GET /campaigns` and the studio dashboard serve
  the fan with real per-node stats; `runIds` become the nodes' attempt-0 run ids and the
  response says `campaignRegistered`. `projectId` filing rides the daemon (one `crew.run`
  membership per sibling). Includes a daemon-side workaround (`campaigns/worktrees.ts`) for the
  engine defect where repo-scoped campaign nodes fail at dispatch because `wicked/{run_id}` is
  not a legal git branch name for a `{campaign}:{node}:a{attempt}` run id.

## [0.7.8] — 2026-09-01

### Changed

- Bundled `wicked-studio` `^0.4.8` — the home command center (one needs-you queue with
  act-in-place, honest portfolio KPIs, the essence strip, Ask on the board).

## [0.7.7] — 2026-09-01

### Added

- **Testing launches take a project and multiple codebases** (#382): `POST /testing/recon` and
  the campaign launch accept `{projectId, repoRefs}` — explicit refs validated by name, project
  membership resolved server-side, unions deduped; multi-repo launches fan one run per repo
  under one campaign label with additive `runIds`. Legacy single-repo bodies unchanged.
- **`GET /api/v1/diagnostics`** (#383): the daemon's self-knowledge — component versions,
  uptime, store sizes, a bounded error tail, and per-CLI ACP health folded from the durable run
  event logs (sessions started / fallbacks by kind / last seen). api-types 0.16.0.

### Changed

- Bundled `wicked-studio` `^0.4.7` — command surfaces on every section, the assist dock, Ask,
  and the steering usage band.

## [0.7.6] — 2026-09-01

### Changed

- Bundled `wicked-studio` `^0.4.6` — the section command surfaces (Projects / project home /
  Make as full-width dashboards with honest KPI deltas, filters, and a needs-you-first action
  layer) and the condensed run header (Timeline/Units behind Inspect; +79px of feed).

## [0.7.5] — 2026-08-31

### Changed

- Bundled `wicked-studio` `^0.4.5` — the narrator on the chat surface (GroupChat narrates by
  default; the approval dock survives run-refresh reconciles on chat sessions).

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

[Unreleased]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.32...HEAD
[0.7.32]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.31...v0.7.32
[0.7.31]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.30...v0.7.31
[0.7.30]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.29...v0.7.30
[0.7.29]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.28...v0.7.29
[0.7.28]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.27...v0.7.28
[0.7.27]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.26...v0.7.27
[0.7.26]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.25...v0.7.26
[0.7.25]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.24...v0.7.25
[0.7.24]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.23...v0.7.24
[0.7.23]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.22...v0.7.23
[0.7.22]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.21...v0.7.22
[0.7.21]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.20...v0.7.21
[0.7.20]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.19...v0.7.20
[0.7.19]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.18...v0.7.19
[0.7.18]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.17...v0.7.18
[0.7.17]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.16...v0.7.17
[0.7.16]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.15...v0.7.16
[0.7.15]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.14...v0.7.15
[0.7.14]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.13...v0.7.14
[0.7.13]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.12...v0.7.13
[0.7.12]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.11...v0.7.12
[0.7.11]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.10...v0.7.11
[0.7.10]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.9...v0.7.10
[0.7.9]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.1...v0.7.2
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
