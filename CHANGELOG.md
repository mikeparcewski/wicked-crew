# Changelog

All notable changes to **wicked-crew** (the daemon package, npm `wicked-crew`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before this file
existed (everything ≤ 0.7.0) are backfilled from git history and release tags; the sibling
workspace packages `wicked-crew-api-types` and `agent-acp-bridges` version independently and are
mentioned only where a daemon release depends on them.

## [Unreleased]

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

[Unreleased]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.16...HEAD
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
