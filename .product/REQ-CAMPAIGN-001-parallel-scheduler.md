---
name: REQ-CAMPAIGN-001-parallel-scheduler
title: Dependency-aware parallel campaign scheduler — Requirements
status: reviewed
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
depends-on: [core-is-engine pivot (DES-002), wicked-core Run/CoreEvent primitives]
---

# REQ-CAMPAIGN-001 — Dependency-aware Parallel Campaign Scheduler

## 1. Problem

Today a workflow Run executes its stages sequentially (core owns that). What is
missing is **cross-workflow orchestration**: running many workflows at once and
starting dependent work the instant its prerequisites finish — instead of a human
serially launching "run A, wait, run B, wait, run C."

Worked example (the target behaviour):

```
Wave 1 (no deps — start immediately, in parallel):
  A-build          B-design         C-design
Wave 2 (dispatched as each dep completes):
  A-test  ← A-build     B-build ← {B-design, A-build}     C-build ← {C-design, A-build}
```

`A-build` completing unblocks three nodes at once; they dispatch without waiting
for a fixed "wave boundary." This is a **DAG executor**, not fixed batches.

## 2. Core concept

A **Campaign** is a directed acyclic graph:
- **Node** = a **Run** (an instance of a `WorkflowDef` against a target/repo). A node
  may be a single-stage workflow (`design`, `build`, `test`) or multi-stage; the
  scheduler treats it as one schedulable unit that reaches a terminal state.
- **Edge** = a dependency `dep → node`: `node` becomes eligible only once `dep`
  satisfies its completion condition.

The scheduler is a **layer over wicked-core's existing Run + CoreEvent + `in_flight`
primitives** — it launches Runs, listens for terminal CoreEvents, and launches
newly-unblocked Runs. It is explicitly **not** a second execution runtime.

## 3. Functional requirements

- **FR1 — Campaign definition.** Accept `{ nodes: [RunSpec], edges: [(from, to)] }`.
  Validate it is a DAG (reject cycles at define time) and that every edge references
  existing nodes.
- **FR2 — Ready-set dispatch.** Compute the ready set (nodes whose every in-edge is
  satisfied and are not yet started) and dispatch all ready nodes **concurrently**,
  bounded by a campaign `max_concurrency`.
- **FR3 — Event-driven progression.** On each node reaching a terminal state,
  recompute the ready set and dispatch newly-ready nodes. No fixed wave barrier —
  a node dispatches the moment its last dependency clears.
- **FR4 — Dependency satisfaction condition.** Default: dep reached `Completed`
  (success). Per-edge option: `on_terminal` (completed regardless of verdict) vs
  `on_success` (Completed with passing verdict). A dep that ends `Failed`/`Cancelled`
  does not satisfy an `on_success` edge.
- **FR5 — Failure propagation (campaign policy, configurable).**
  - `fail_fast`: any node failure → cancel in-flight nodes, do not dispatch pending,
    campaign → `Failed`.
  - `continue_independent` (**default**): a failed node marks only its **transitive
    dependents** `Blocked`; independent branches run to completion; campaign ends
    `PartiallyCompleted` if any node Blocked/Failed, else `Completed`.
  - `human_gate_on_failure`: a node failure pauses the campaign at a human decision
    (`retry | skip | abort`) — reuses core's HITL gate rigor.
- **FR6 — Per-node human gates.** A core `AwaitingHuman` gate inside one node pauses
  **only that node**; independent nodes keep running. The campaign surfaces each
  node's gate prompt and routes approve/reject/amend to that node's `confirm_gate`.
- **FR7 — Durable + crash-resumable.** Campaign state (nodes, edges, per-node status)
  is persisted. After a hard crash (SIGKILL) and restart, the scheduler re-derives the
  ready set from persisted terminal-node states and resumes — **without re-running
  already-completed nodes** (reuse core's per-Run resume + completion sentinel) and
  **without duplicating nodes**. Same non-negotiable rigor as SC-002.
- **FR8 — Observability.** Emit campaign events: `NodeReady`, `NodeStarted`,
  `NodeCompleted`, `NodeFailed`, `NodeBlocked`, `CampaignCompleted`,
  `CampaignFailed`, `CampaignPaused`. Expose a campaign snapshot (nodes + statuses +
  edges) for a DAG view. Per-node CLI live output flows through existing `CliOutputDelta`.
- **FR9 — Cancellation / pause.** Campaign-level cancel (cancel all in-flight + mark
  pending `Cancelled`) and pause (dispatch no new nodes; in-flight optionally continue
  or are paused). Node-level cancel routes to that Run's `CancelRun`.
- **FR10 — Concurrency cap.** Respect a global `max_concurrency` (resource guard for
  worktrees + CLI subprocess cost). Ready nodes beyond the cap queue and dispatch as
  slots free.

## 4. Non-functional requirements / constraints

- **NFR1 — Layer, not a new runtime.** Reuse core's `LaunchRun`/`ResumeRun`/
  `CancelRun`/`CoreEvent`/`in_flight`. Single-writer invariant preserved: campaign
  state has exactly one authoritative writer.
- **NFR2 — Deterministic scheduling.** Given a fixed set of node states, the ready-set
  computation and dispatch decision are pure and deterministic (testable in isolation;
  100-run identical like SC-003). No wall-clock or nondeterministic ordering in the
  scheduling decision itself.
- **NFR3 — Idempotent resume.** Resume must never double-dispatch a node
  (core's completion sentinel + campaign node-status guard).
- **NFR4 — Ecosystem constraints carry over.** Cross-platform, 127.0.0.1-only,
  no telemetry, no LLM in the scheduling/gate-evaluation logic, TypeScript strict on
  the surface, Rust rigor on any core-side primitive.

## 5. Success criteria (evidence-gated, verified against running software)

| SC | Verification | Evidence |
|---|---|---|
| SC-C1 | Diamond `A → {B,C} → D`: B,C overlap in time after A; D starts only after both terminal | run timeline / per-node start+end timestamps |
| SC-C2 | The §1 example: wave-1 {A-build,B-design,C-design} concurrent; A-build completing dispatches {A-test,B-build,C-build} | node dispatch log with timestamps |
| SC-C3 | `max_concurrency=2`, 4 ready nodes → never >2 in-flight; others queue then run | concurrency trace (max observed in-flight) |
| SC-C4 | `fail_fast`: a node fails → in-flight cancelled, pending not dispatched, campaign `Failed` | node statuses + campaign status |
| SC-C5 | `continue_independent`: node X fails → only X's transitive dependents `Blocked`; independent branch `Completed` | node status map |
| SC-C6 | SIGKILL mid-campaign → resume re-derives ready set, completes; no node runs twice, no duplicate nodes | before/after node snapshots + dispatch count per node |
| SC-C7 | Campaign spec with a cycle → rejected at define time | define-time error |
| SC-C8 | Human gate in one node pauses only it; independent nodes continue; approve resumes + unblocks dependents | node statuses over time |
| SC-C9 | Ready-set computation deterministic over 100 runs (fixed node-state input → identical dispatch set) | automated test log |

## 6. Explicitly out of scope (v1)

- Distributed / multi-machine scheduling (single daemon, single node).
- Dynamic DAG mutation mid-campaign (nodes/edges fixed at launch; retry is in-place).
- Resource-aware scheduling beyond a simple concurrency count (no per-CLI cost budget yet).
- Cross-campaign dependencies.

## 7. Open questions for design (DES)

1. **Placement:** a first-class `Campaign` primitive in wicked-core (durable in the
   estate store, actor-scheduled, exposed via core-ts) **vs** a scheduler in the TS
   surface over core Runs. NFR1/NFR3 (single-writer, idempotent resume) strongly favour
   core ownership; resolve with the core-is-engine pivot.
2. **Node = Run vs (Run, stage):** v1 proposes node = Run. Confirm the example fully
   decomposes into Runs (`A-build`, `A-test`, `B-design`, `B-build`, …) with edges.
3. **Failure default:** `continue_independent` proposed as default — confirm vs `fail_fast`.
