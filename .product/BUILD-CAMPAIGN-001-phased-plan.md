---
name: BUILD-CAMPAIGN-001-phased-plan
title: Campaign scheduler + core-is-engine pivot — phased build plan
status: draft
version: 0.1
date: 2026-07-07
implements: DES-CAMPAIGN-001
depends-on: [estate 0.13 unification (plan: wicked-estate unified foundation)]
---

# BUILD-CAMPAIGN-001 — Phased plan

Dependency-ordered. Each phase carries the **standard rigor**: define/design already
done (REQ/DES-CAMPAIGN-001); per-phase per-crate build+test+clippy green, an adversarial
diff review to PASS (no CRITs/SIGs), and evidence against **running software** (not just
green tests). Rust foundation phases follow wicked-estate CLAUDE.md §12 (per-crate builds,
worktree isolation for parallel lanes, wave-scoped commits).

## Phase 0 — Foundation prerequisites (gate everything)

These are wicked-core/wicked-estate work, not crew's alone, but the campaign is blocked
on them. Sequence:

- **0a — estate 0.13 rebase of wicked-core.** Core is pinned to *yanked* estate 0.12;
  rebase onto 0.13 (the unification already on the board). Gate: `cargo test -p wicked-core`
  green on estate 0.13.
- **0b — core `RunFinished{run_id, status}` terminal event.** The campaign reconciler
  needs one clean per-Run terminal signal on every path (Completed / Failed / Cancelled-by-
  CancelRun / Cancelled-by-gate-reject). Gate: a test asserting each terminal path emits it.
- **0c — idempotent launch-by-id.** `LaunchRun(run_id, spec)` = launch-or-resume by a
  caller-supplied id; `ResumeRun(unknown)` → typed `RunNotFound`, not panic. Gate: a test
  proving a duplicate `LaunchRun(id)` yields one Run.
- **0d (parallel) — core P5/P6** (AdversarialReview council stage + FunctionalTest
  wicked-testing stage) so campaign nodes can run those workflow kinds. The TS crew build's
  governance/council/test-verdict logic is the reference. Independent of 0a–0c.

## Phase 1 — `wicked-core-ts` (the napi bridge)

Build the napi-rs cdylib exposing core to JS/TS. Pattern: `archived/wicked-memory/crates/
wicked-memory-ts` (reference only — read, don't modify).

- Expose Run surface: `launchRun/resumeRun/confirmGate/cancelRun/sessions/sessionsDetail/
  workOutput` + `subscribe(cb)` for `CoreEvent` via a `ThreadsafeFunction` (async: launch
  returns immediately; events push to JS).
- Cross-platform prebuilt `.node` binaries via a CI matrix (macOS/Linux/Windows) — the
  ecosystem cross-platform rule; wicked-memory-ts's build.rs/.cargo/config is the template.
- Gate: a Node smoke test drives a real Run through core-ts (launch → gate → approve →
  complete) and receives the CoreEvent stream. Adversarial review of the binding surface.

## Phase 2 — Campaign primitive in wicked-core (the DES)

Implement DES-CAMPAIGN-001 in core:

- Data model (§2): `CampaignDef/Campaign/NodeStatus{…,AwaitingHuman,ReadyToResume}/
  node_attempt/pending_decision`, persisted like `AgentSession`.
- Pure scheduler (§4): `ready_set/satisfied/blocked_by_failure` (BTreeSet, deterministic).
- Driver (§4): `dispatch()` (sole launcher + sole `node_run_id` writer), `try_fill()`
  (status-guarded), `RunFinished`/`AwaitingHuman` handlers, gate-approval → `ReadyToResume`,
  finalize.
- Commands + events (§3): `Launch/Resume/Cancel/Pause Campaign`, `ConfirmCampaignGate`,
  `Campaign*` events; policies (§5); crash-resume (§6).
- Expose via core-ts: `launchCampaign/campaignStatus/cancel/pause` + campaign events.
- Tests → SCs: unit (pure) SC-C1/C7/C9; integration (mock-worker Runs) SC-C2/C3/C4/C5/C8;
  **SIGKILL evidence** SC-C6 (a Campaign-level analogue of crew's SC-002 harness).
  Coverage ≥80% per new crate. Gate: adversarial diff review to PASS + evidence.

## Phase 3 — TS surface (crew + studio) on core-ts

Re-point wicked-crew's daemon + React studio off the SQLite/session/phase model onto
core-ts's run/campaign model (the DES §11 must-not-lose list):

- Daemon: `POST /campaigns`, `GET /campaigns/:id` (DAG + node statuses), campaign
  cancel/pause; stream `Campaign*` + `CliOutputDelta` over WS. Port the egui HITL
  lifecycle (advisory timeout → hard expiry → ack → retry) into the daemon so gates
  don't hang.
- React studio: Campaign DAG view (nodes + statuses + edges), per-node steering gate
  (approve+amend / reject / cancel), live per-node output + event log, routing provenance
  + failure banner, launch/worktree surface, run-identity binding, self-healing gate cache.
- Gate: the crew acceptance-scenario rigor (real daemon, real browser) re-run against the
  core-backed surface; adversarial review to PASS.

## Phase 4 — Retire egui + close out

- Verify JS/TS surface parity against the §11 checklist; then retire the egui dashboard
  (`../wicked-studio`). Keep (decision pending) the estate-explorer half as a separate
  surface or drop.
- The TS crew SQLite/XState/governance build is superseded by core; keep it tagged as the
  proven-logic baseline + reference for core P5/P6.

## Critical path

`0a → 0b → 0c → 1 → 2 → 3 → 4`, with **0d ∥ (0a→0c)** and Phase-2 unit tests startable
against a stubbed core once 0b/0c land. Nothing in Phases 2–4 is safe to start before the
core prerequisites (0a–0c) are green — that is the honest gate.
