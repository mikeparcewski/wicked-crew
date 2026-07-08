---
phase: design (campaign scheduler feature)
status: PASS
date: 2026-07-07
artifacts: [REQ-CAMPAIGN-001, DES-CAMPAIGN-001 v0.4, BUILD-CAMPAIGN-001]
---

# Campaign Scheduler — Design Phase PASS

## Scope

Dependency-aware **parallel campaign scheduler**: run many workflows at once and start
dependent work the instant its prerequisites finish (a DAG executor over wicked-core
Runs), plus the egui-dashboard feature review that gates its retirement. Requested with
"the same rigor we have for everything else."

## Artifacts

| Artifact | What |
|---|---|
| `REQ-CAMPAIGN-001-parallel-scheduler.md` | Requirements: Campaign = DAG of Runs; ready-set wave dispatch; 9 evidence-gated SCs (SC-C1..C9); explicit out-of-scope + open questions |
| `DES-CAMPAIGN-001-parallel-scheduler.md` v0.4 | Design: Campaign primitive in wicked-core, pure `ready_set` + side-effecting driver, idempotent attempt-keyed launch, slot-gated gate resume, failure policies, crash-resume, `wicked-core-ts` surface, §11 egui feature-parity |
| `BUILD-CAMPAIGN-001-phased-plan.md` | Dependency-ordered build plan (Phase 0 core prerequisites → 1 core-ts → 2 Campaign primitive → 3 TS surface → 4 retire egui), each phase gated with standard rigor |

## Adversarial review — PASS (3 rounds)

| Round | Findings | Outcome |
|---|---|---|
| 1 | 4 CRIT, 4 SIG, 2 MIN | all fixed in v0.2 |
| 2 | 1 new CRIT (Retry/dispatch id collision), 1 new SIG (missing Resumed handler / concurrency over-count) | all fixed in v0.3 |
| 3 | 1 SIG (FailFast omits CancelRun for ReadyToResume) | fixed in v0.4 |
| final | **0 CRIT, 0 SIG** | **PASS** |

13 findings resolved total. Reviewer confirmed the four crash/race scenarios
(launch/persist crash window both sides, abandoned-attempt late `RunFinished`, slot
deadlock, `ReadyToResume` crash-resume) trace clean.

### Key correctness properties established

- **Idempotent launch:** `dispatch()` is the sole launcher + sole writer of `node_run_id`,
  keyed `(campaign,node,attempt)` — no double-launch on retry or crash, on either side of
  the persist/launch boundary.
- **Strict concurrency:** `AwaitingHuman` + `ReadyToResume` free their slots; an approved
  gate re-acquires a slot via `dispatch()` before resuming — FR6 (independent work runs
  while a node gates) holds even at `max_concurrency=1` **and** the cap stays a true bound.
- **Crash resume:** re-derives the ready set from persisted terminal statuses; never
  re-runs a completed node, never duplicates a node (SC-C6, the SC-002 analogue).
- **Deterministic scheduling:** pure `ready_set`/`blocked_by_failure` over BTreeSet — SC-C9.
- **Failure semantics:** FailFast / ContinueIndependent (default) / HumanGateOnFailure,
  with mixed OnSuccess/OnTerminal edge truth table specified.

## egui dashboard feature review — done

Full inventory of the Rust/egui `wicked-studio` (core's P7). Must-not-lose features folded
into DES §11 (steering gate w/ amend, run-identity binding, self-healing gate-prompt cache,
live `CliOutputDelta` + per-run event log, routing provenance + failure banner,
launch/worktree surface, work-unit detail) plus the HITL-lifecycle salvage from the unused
`hitl.rs`. egui-specific machinery (PTY terminals, theme engine, frame-capture/demo) marked
safe to drop. egui retired in favour of the React studio + TS daemon over `wicked-core-ts`.

## Gate decision

Design PASS. Build is gated on Phase-0 foundation prerequisites (estate 0.13 rebase of
core; `RunFinished` event; idempotent launch-by-id; core P5/P6) per BUILD-CAMPAIGN-001 —
those are the honest blockers before Campaign implementation begins.
