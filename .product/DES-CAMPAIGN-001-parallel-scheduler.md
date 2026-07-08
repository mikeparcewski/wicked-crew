---
name: DES-CAMPAIGN-001-parallel-scheduler
title: Dependency-aware parallel campaign scheduler — Technical Design
status: reviewed
version: 0.4
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
implements: REQ-CAMPAIGN-001
---

# DES-CAMPAIGN-001 — Campaign Scheduler Design

> **v0.4 changelog** — resolves adversarial review round 3 (1 SIG): §5.2 FailFast now
> `CancelRun`s `ReadyToResume` nodes too (parity with CancelCampaign; no zombie paused
> Runs). Added the inverse-lookup implementation note to §4 step 2. Rounds 1–2 findings
> re-confirmed resolved by the round-3 pass.
>
> **v0.3 changelog** — resolves adversarial review round 2 (1 new CRIT, 1 new SIG):
> unified id generation — `dispatch()` is the SOLE launcher + SOLE writer of
> `node_run_id`, keyed `(campaign,node,attempt)`; Retry only bumps `node_attempt` + sets
> `Ready` (§2.1, §4, §5.2) — closes the Retry/dispatch double-launch. Added
> `ReadyToResume` status + slot-gated gate resume via `dispatch()` (§2, §4 step 4, §6.5)
> — an approved gate re-acquires a slot instead of transiently exceeding `max_concurrency`;
> no separate `Resumed` handler needed.
>
> **v0.2 changelog** — resolves adversarial review round 1 (4 CRIT, 4 SIG, 2 MIN):
> idempotent launch (§2.1, §4, §6), `AwaitingHuman` as a non-slot-consuming node
> status + corrected liveness (§2, §6.5, §7), Paused/Cancelled dispatch guards (§4),
> terminal-node skip guard + `RunFinished` trigger enumeration (§3, §4), normal-op
> `AwaitingHuman` handler (§3, §6.5), HumanGateOnFailure multi-failure + retry run_id
> (§5), mixed-edge semantics (§5.1), ordered fixpoint + empty/duplicate-edge validation
> (§2.2, §4). Adds §11 egui feature-parity (must-not-lose) + HITL-lifecycle.

## 1. Placement decision

The `Campaign` primitive lives in **wicked-core** (Rust), durable in the estate
store, scheduled by the single-writer `StoreActor`, exposed to JS/TS surfaces via
**`wicked-core-ts`** (napi). Rationale, tied to REQ NFR1/NFR3:

- The scheduler must hold **durable, single-writer, crash-resumable** state. Core's
  actor already is that authority for Runs; a Campaign is just another actor-owned
  entity. Putting it in the TS surface would re-introduce the OLTP/single-writer/resume
  problems the core-is-engine pivot removes.
- The scheduler reacts to **Run terminal events** — which the actor already produces
  and is the single emit point for. Reconciliation belongs where those events originate.

**Interim (honest):** core's `Campaign` primitive is gated on (a) the estate 0.13
rebase and (b) `wicked-core-ts`. Until both land, a TS-surface scheduler over core's
existing Run commands is an acceptable *bridge* — but its campaign state is explicitly
**temporary** and migrates into core. The design below specifies the target (core);
the bridge implements the same pure algorithm (§4) against the same SCs so it ports.

## 2. Data model (new core types — mirror `WorkflowDef`/`Run`)

```rust
pub struct CampaignDef {
    pub id: String,
    pub name: String,
    pub nodes: Vec<CampaignNode>,      // schedulable units
    pub edges: Vec<CampaignEdge>,      // dep -> node
    pub policy: FailurePolicy,         // FailFast | ContinueIndependent | HumanGateOnFailure
    pub max_concurrency: usize,        // >= 1
}
pub struct CampaignNode { pub node_id: String, pub run_spec: RunSpec } // reuse core RunSpec
pub struct CampaignEdge { pub from: String, pub to: String, pub condition: EdgeCondition }
pub enum EdgeCondition { OnSuccess, OnTerminal } // success only | any terminal (cleanup/report)
pub enum FailurePolicy { FailFast, ContinueIndependent, HumanGateOnFailure }

pub enum NodeStatus {
    Pending,
    Ready,               // never launched — dispatch() will LaunchRun a fresh attempt
    Running,             // actively executing in core (consumes a slot)
    AwaitingHuman,       // a HITL gate is open, waiting on the human (no slot)
    ReadyToResume,       // human approved; a live Run exists, queued for a slot (no slot)
    Completed, Failed, Blocked, Cancelled,   // terminal
}
pub enum CampaignStatus { Running, Paused, Completed, PartiallyCompleted, Failed, Cancelled }

pub struct Campaign {                  // live instance, persisted like AgentSession
    pub id: String,
    pub def_id: String,
    pub status: CampaignStatus,
    pub node_status: BTreeMap<String, NodeStatus>,
    pub node_run_id: BTreeMap<String, String>,   // node_id -> live Run id (written ONLY by dispatch())
    pub node_attempt: BTreeMap<String, u32>,     // node_id -> attempt counter (0-based); part of the run_id
    pub pending_decision: BTreeMap<String, HumanDecision>, // approved-gate decision awaiting a slot
}
```

`TERMINAL = {Completed, Failed, Blocked, Cancelled}`. `running_count()` counts **only
`Running`** nodes. `AwaitingHuman` (waiting on a human) and `ReadyToResume` (approved,
waiting for a slot) are **both excluded** — neither is executing CLI work, so neither
holds a slot. This is what makes FR6 true at `max_concurrency=1` (independent work runs
while a node gates) **and** keeps the cap a true bound on concurrent execution: a
resumed gate node must re-acquire a slot via `dispatch()` before it runs again (§6.5).

Persistence reuses the estate node/edge substrate (`put_node`/`all_sessions` pattern).
A node = one core **Run**; a node's internal stages are core's concern (sequential).
The `RunSpec` is reused verbatim, so a node inherits governance, worktree isolation,
HITL gates, live output, and per-Run resume for free.

### 2.1 Idempotent launch (crash-safe run identity)

The run_id is a **deterministic function of `(campaign_id, node_id, attempt)`**:
`run_id = "{campaign_id}:{node_id}:a{node_attempt[node]}"`. **`dispatch()` (§4) is the
SOLE writer of `node_run_id` and the SOLE launcher** — it always derives the id from
this rule, so no other code path can invent a colliding or divergent id (this closes the
round-2 Retry/dispatch collision: Retry only bumps `node_attempt` and sets the node
`Ready`; `dispatch()` then produces the fresh attempt id — there is never a second
concurrent Run for a node).

Core's launch is **launch-or-resume by id**: `LaunchRun(run_id, spec)` creates the Run
if `run_id` is unknown, else attaches to the existing one (no second Run). This removes
the mint-then-persist race: the id is known before launching, and a duplicate launch is
a no-op. `ResumeRun(run_id)` on an id core has never seen returns a typed `RunNotFound`
(not a panic); the campaign treats that as "not yet launched" and issues `LaunchRun`.

### 2.2 Define-time validation

`LaunchCampaign` rejects: a **cycle** (topo-sort), an **edge to/from a nonexistent
node**, a **duplicate `(from,to)` pair** (ambiguous condition — reject, don't silently
merge), and an **empty campaign** (0 nodes → error, not vacuously Completed). A
single-node, no-edge campaign is valid (dispatches immediately).

## 3. Commands + events (mirror the Run surface)

**Commands** (`command.rs`): `LaunchCampaign { def } -> campaign_id`,
`ResumeCampaign { id }`, `CancelCampaign { id }`, `PauseCampaign { id }`,
`ConfirmCampaignGate { id, node_id, decision: Retry|Skip|Abort }` (for
`HumanGateOnFailure`), `CampaignStatus { id }`, `CampaignDetail { id }`.

**Events** (`CoreEvent`, single-emit-point, monotonic `seq`): `CampaignLaunched`,
`CampaignNodeReady{node}`, `CampaignNodeStarted{node,run_id}`,
`CampaignNodeAwaitingHuman{node,run_id,prompt}`, `CampaignNodeCompleted{node}`,
`CampaignNodeFailed{node}`, `CampaignNodeBlocked{node}`, `CampaignPaused`,
`CampaignCompleted`, `CampaignFailed`, `CampaignCancelled`. Per-node CLI output rides
the existing `CliOutputDelta` (tagged with the node's run_id).

**Prerequisite — `RunFinished { run_id, status }`.** The reconciler needs one clean
per-Run terminal signal. It must fire on **every** terminal path, exhaustively:
`Completed` (all units approved + ran), `Failed` (governance deny OR worker failure —
core's run-level deny contract), `Cancelled` **by `CancelRun`** (incl. campaign fail-fast
/ CancelCampaign), and `Cancelled` **by a gate reject**. `RunCancelled` (already emitted)
is a UI signal; `RunFinished{Cancelled}` is the reconciler's terminal signal and MUST
also fire — otherwise a cancelled node's status is never cleared and its dependents
strand. This is a hard core prerequisite (§10 R1).

**Normal-operation `AwaitingHuman`.** Core already emits `AwaitingHuman{run_id,prompt}`
when a node's internal HITL gate pauses (not a crash). The campaign driver handles it
directly (§6.5): set the node `AwaitingHuman` (frees its slot), emit
`CampaignNodeAwaitingHuman`, and route the human's response to `core.confirm_gate(run_id,
decision)`. This is distinct from `ConfirmCampaignGate` (which is the `HumanGateOnFailure`
policy control, §5).

## 4. The scheduler — a pure function + a side-effecting driver

Split cleanly so the decision is deterministic and unit-testable (REQ NFR2):

```
// PURE — no I/O, no clock. Deterministic given inputs (100-run identical, SC-C9).
fn ready_set(nodes, edges, status: &Map<NodeId,NodeStatus>) -> BTreeSet<NodeId>:
    for n in nodes where status[n] == Pending:
        deps = edges.filter(e.to == n)
        if all deps satisfied(status, e.condition): mark n ready
    return { n : status[n]==Ready or newly-ready } ordered by node_id

fn satisfied(status, edge) -> bool:
    match edge.condition:
        OnSuccess  => status[edge.from] == Completed
        OnTerminal => status[edge.from] in {Completed, Failed, Cancelled}

fn blocked_by_failure(nodes, edges, status) -> Set<NodeId>:
    // transitive: a node with any OnSuccess dep that is Failed/Cancelled/Blocked
    fixpoint over edges
```

**Driver (actor, side-effecting).** Two helpers; every step runs inside the actor's
single-writer command handler, so a "persist then launch" pair is **one atomic write
boundary** (no other writer interleaves) and, combined with §2.1's idempotent launch,
is crash-safe on either side of the boundary:

```
// The SOLE launcher and SOLE writer of node_run_id. Handles both a fresh start
// (Ready) and a slot-gated resume of an approved HITL gate (ReadyToResume).
fn dispatch(node):                     // precondition: status ∈ {Ready, ReadyToResume}
    run_id = f"{campaign_id}:{node_id}:a{node_attempt[node]}"   // §2.1 — the only id rule
    node_run_id[node] = run_id ; node_status[node] = Running ; PERSIST   // atomic actor step
    if was Ready:          LaunchRun(run_id, node.run_spec)              // launch-or-resume by id
    else /* ReadyToResume */: core.confirm_gate(run_id, pending_decision[node]); clear pending
    emit CampaignNodeStarted{node, run_id}

fn dispatchable():   // ready-to-run set: never-started AND approved-waiting-for-slot
    ready_set(...) ∪ { n : status[n] == ReadyToResume }   // ordered by node_id

fn try_fill():                         // the ONLY dispatch path
    if campaign.status != Running: return          // guards Paused AND Cancelled (CRIT 3a/3b)
    while running_count() < max_concurrency and ∃ node in dispatchable():
        dispatch(next dispatchable node by node_id)     // deterministic order
```

Both a fresh `Ready` node and an approved `ReadyToResume` node go through `dispatch()`,
each taking exactly one slot — so an approved gate does **not** resume until a slot is
free, keeping `max_concurrency` a strict bound on concurrent execution (round-2 SIG fix).
`node_run_id` is written **only** here, always from the §2.1 attempt-keyed rule — no path
can produce a second concurrent Run for a node (round-2 CRIT fix).

1. **`LaunchCampaign`**: validate (§2.2); persist `Campaign` all-`Pending`; mark the
   in-degree-0 set `Ready`; `try_fill()`.
2. **`RunFinished{run_id, status}`**: find node by `run_id` (inverse lookup over
   `node_run_id`; a bounded linear scan is fine — an abandoned prior-attempt id maps to
   no node and the event is safely dropped).
   - **Guard (CRIT 3b):** if `node_status[node] ∈ TERMINAL` → **skip** (a late event after
     cancel/replacement is ignored; monotonicity preserved).
   - Set node terminal from `status`; PERSIST.
   - If the node failed/cancelled → apply `FailurePolicy` (§5).
   - Recompute `ready_set` (mark newly-ready `Ready`); `try_fill()`.
   - If no `Running`, no `AwaitingHuman`/`ReadyToResume`, and no dispatchable node
     remain → `finalize()` (Completed if all Completed; PartiallyCompleted if any
     Blocked/Failed; Failed if fail-fast tripped).
3. **`AwaitingHuman{run_id, prompt}`** (§6.5): set node `AwaitingHuman` (frees slot);
   emit `CampaignNodeAwaitingHuman`; `try_fill()` (independent nodes now use the slot).
4. **Gate resolution from the surface** (the operator answers a per-node gate):
   - **Reject** → `core.confirm_gate(run_id, Reject)` **immediately** (no slot needed —
     it terminates the Run); the ensuing `RunFinished{Failed/Cancelled}` reconciles the
     node via step 2.
   - **Approve{amend}** → do **not** call core yet. Store `pending_decision[node] =
     Approve{amend}`, set node `ReadyToResume`, `try_fill()`. `dispatch()` calls
     `confirm_gate` only when a slot is free (§6.5) — so the resumed node re-occupies a
     slot rather than silently exceeding `max_concurrency`. There is no separate
     `Resumed` handler: the campaign itself drives the resume through `dispatch()`, so
     the node becomes `Running` exactly when the campaign grants the slot. (core's
     `Resumed`/`StageStarted` events are informational for the UI only.)
5. **`CancelCampaign`**: set `campaign.status = Cancelled` **first** (so any in-flight
   `RunFinished` hits the terminal-skip guard and `try_fill`'s status guard); `CancelRun`
   every `Running`/`AwaitingHuman`/`ReadyToResume` node; mark `Ready`/`Pending`
   `Cancelled`.
6. **`PauseCampaign`**: set `campaign.status = Paused`; dispatch nothing new; in-flight
   continue cooperatively. `ResumeCampaign` sets `Running` and calls `try_fill()`.

`running_count()` is derived from `node_status` (count of `Running` only — **not**
`AwaitingHuman` or `ReadyToResume`), never a separate counter — one source of truth that
survives resume.

## 5. Failure propagation (§FR5)

### 5.1 Edge-condition + blocking semantics (specified, per review SIG-4a)

An edge is *satisfied* per §4: `OnSuccess` ⇔ dep `Completed`; `OnTerminal` ⇔ dep in
`{Completed, Failed, Cancelled}`. A node becomes `Ready` only when **all** its in-edges
are satisfied. `blocked_by_failure` is a fixpoint: a node is `Blocked` iff **any**
`OnSuccess` in-edge's dep is `Failed`/`Cancelled`/`Blocked`. Consequences for
**mixed-edge** nodes (both an `OnSuccess` and an `OnTerminal` in-edge), stated explicitly:

| Node's in-edges | dep outcomes | Result |
|---|---|---|
| `OnSuccess(X)` + `OnTerminal(Y)` | X Completed, Y Failed | **Ready** (both satisfied) |
| `OnSuccess(X)` + `OnTerminal(Y)` | X Failed, Y Completed | **Blocked** (an OnSuccess dep failed) |
| all `OnTerminal` | any/all Failed | **Ready** (cleanup/report path) |

The `blocked_by_failure` fixpoint and the ready-set fixpoint both iterate `edges`
(insertion-ordered `Vec`) and use **`BTreeSet` working sets** — no `HashSet` — so the
result is deterministic (SC-C9; per review MIN-7).

### 5.2 Policies

On a node ending `Failed`/`Cancelled`, by campaign `policy`:
- **FailFast** → `CancelRun` all `Running`/`AwaitingHuman`/`ReadyToResume` nodes (each
  holds a live core Run — a `ReadyToResume` node's Run is paused at an open gate and must
  be cancelled too, matching `CancelCampaign`; else it lingers as a zombie), mark all
  non-terminal `Cancelled`, campaign `Failed` (SC-C4).
- **ContinueIndependent** (default) → recompute `blocked_by_failure`; mark those
  `Blocked` (emit `CampaignNodeBlocked`); independent branches keep dispatching (SC-C5).
  `OnTerminal` dependents still run. Finalizes `PartiallyCompleted` if any node ended
  `Blocked`/`Failed`, else `Completed`.
- **HumanGateOnFailure** → campaign `Paused`; the failed node is recorded and a
  per-node decision prompt is surfaced. **Multiple concurrent failures (SIG-4b):** each
  failed node is enqueued in a `pending_failure_gates` list (ordered by node_id) and
  surfaced independently; a later failure arriving on an already-Paused campaign appends
  to the queue rather than being lost or overwriting. `ConfirmCampaignGate{node, decision}`
  resolves **one** node's gate:
  - `Retry` → **`node_attempt[node] += 1`; set node `Ready`; `try_fill()`.** That is all:
    `dispatch()` is the sole launcher and derives the fresh `run_id` from the bumped
    attempt (§2.1), so there is exactly one Run for the retried node and no id collision
    with the base path (round-2 CRIT fix). Retry never touches `node_run_id` or calls
    `LaunchRun` itself. The failed attempt's Run id is abandoned (never resumed).
  - `Skip` → treat the node as terminally failed; apply `ContinueIndependent` blocking.
  - `Abort` → escalate to `FailFast`.
  The campaign returns to `Running` (and `try_fill`s) once `pending_failure_gates` is
  empty or all resolved to non-abort.

## 6. Crash resume (§FR7 / SC-C6) — reuse core's Run resume

On `ResumeCampaign` (or actor startup scanning incomplete campaigns):
1. Reload `Campaign` from the store (authoritative `node_status` + `node_run_id`).
2. **Terminal nodes** (`Completed`/`Failed`/`Blocked`/`Cancelled`): skip — do not relaunch.
3. **`Running` / `AwaitingHuman` nodes**: the process died mid-run. Call
   `LaunchRun(node_run_id, spec)` — which is **launch-or-resume by id** (§2.1): if core
   still has the Run it re-attaches (core's completion-sentinel decides re-run vs
   apply-result); if core never persisted it (crash before core wrote), it creates it
   fresh under the *same* id. Either way exactly one Run exists for the node. An
   interrupted subprocess that core cannot classify surfaces `AwaitingHuman` (R2) → the
   node stays `AwaitingHuman` (paused, slot freed), **not** `Failed`, and its dependents
   stay `Pending` (not `Blocked`) until the human resolves it.
4. **`ReadyToResume` nodes** (approved-gate, mid-crash): the pending decision was
   persisted; `dispatch()` will re-issue `confirm_gate` when a slot is free (idempotent —
   core ignores a duplicate confirm on an already-resumed gate).
5. **`Ready`/`Pending` nodes**: recompute `ready_set`; `try_fill()`. These have no
   `node_run_id`, so no double-dispatch.

Because §2.1 derives the id from `(campaign,node,attempt)` and `dispatch()` is the sole
writer of `node_run_id` (persisted in the same atomic actor step as the launch), and
`LaunchRun`/`ResumeRun`/`confirm_gate` are idempotent by id, resume cannot duplicate a
node, strand a launched-but-unrecorded Run, or double-launch a retried node — closing
the round-1 CRIT-1 and round-2 CRIT.

### 6.5 Per-node human gates during a running campaign (FR6) — slot-gated resume

When a node's HITL gate fires, core emits `AwaitingHuman{run_id,prompt}`. The driver
(§4 step 3) sets the node `AwaitingHuman` — **freeing its slot** — emits
`CampaignNodeAwaitingHuman`, and `try_fill()`s so independent work uses the freed slot.
The surface (egui-parity gate bar, §11) sends the operator's decision back:

- **Reject** terminates the Run immediately (no slot needed).
- **Approve{amend}** does **not** resume core immediately. The node goes `ReadyToResume`
  with the decision stored, and re-enters the `dispatch()` queue: it resumes (via
  `confirm_gate`) only when `running_count() < max_concurrency`. So the resumed node
  **re-acquires a slot** rather than transiently exceeding the cap (round-2 SIG fix).

This makes FR6 true at `max_concurrency=1` (a gating node frees the slot for independent
work) **while** keeping the cap a strict bound on concurrent execution (an approved node
waits for a slot before resuming). The trade-off is explicit and surfaced: after approval
a node may show "approved — waiting for a slot" until one frees. (Alternative considered
and rejected: advisory cap that lets approved gates resume immediately, transiently
exceeding `max_concurrency` — rejected because the cap exists to bound real machine load
of concurrent worktrees + CLI subprocesses.)

## 7. Liveness / correctness argument

- **No cycles** (validated at launch) ⇒ topological progress is always possible.
- **Every dispatched node reaches a terminal state or a human gate** (core guarantees a
  Run terminates or pauses at `AwaitingHuman`) ⇒ every occupied slot is eventually freed.
- **A node holds a concurrency slot only while `Running`.** An `AwaitingHuman` node does
  **not** count toward `running_count` (§2), so it releases its slot while it waits — an
  external wait never occupies the pool. This is the correction to v0.1's flawed "no
  hold-and-wait even at `max_concurrency=1`" claim: at `max_concurrency=1`, a node that
  hits a HITL gate frees the slot so an independent `Ready` node runs (FR6 holds). The
  only genuine wait is on human input, which is expected and surfaced, not a deadlock of
  the scheduler.
- **Monotonic node status** (Pending→Ready→Running↔AwaitingHuman→terminal; terminal is
  absorbing, enforced by the §4 terminal-skip guard) ⇒ the reconciler is a monotone
  fixpoint ⇒ terminates.
- **Diamond** `A→{B,C}→D`: `D`'s in-edges `{B,C}`; `ready_set` marks `D` ready only when
  both satisfied (SC-C1). Handled by "all in-edges satisfied," no special-casing.

## 8. TS surface (`wicked-core-ts` + crew) — how the example is expressed

```ts
// crew builds a Campaign from user intent / a template, then delegates to core.
const campaign = {
  max_concurrency: 4, policy: 'continue_independent',
  nodes: [
    { node_id: 'A-build',  run_spec: { def_id: 'build',  ... } },
    { node_id: 'A-test',   run_spec: { def_id: 'functional-test', ... } },
    { node_id: 'B-design', run_spec: { def_id: 'design', ... } },
    { node_id: 'B-build',  run_spec: { def_id: 'build',  ... } },
    { node_id: 'C-design', run_spec: { def_id: 'design', ... } },
    { node_id: 'C-build',  run_spec: { def_id: 'build',  ... } },
  ],
  edges: [
    { from: 'A-build',  to: 'A-test',  condition: 'on_success' },
    { from: 'B-design', to: 'B-build', condition: 'on_success' },
    { from: 'A-build',  to: 'B-build', condition: 'on_success' },
    { from: 'C-design', to: 'C-build', condition: 'on_success' },
    { from: 'A-build',  to: 'C-build', condition: 'on_success' },
  ],
};
const id = core.launchCampaign(campaign);   // napi → LaunchCampaign
core.subscribe(onCampaignEvent);            // ThreadsafeFunction → CampaignNode* + CliOutputDelta
```

Wave 1 ready set (in-degree 0) = `{A-build, B-design, C-design}` → all dispatch (≤4).
`A-build` finishing satisfies the `on_success` edges into `A-test`, `B-build`, `C-build`;
`B-build`/`C-build` also need `B-design`/`C-design` done — so they dispatch as both clear.
Exactly the §1 target, with no fixed wave barrier.

The crew REST+WS surface exposes `POST /campaigns`, `GET /campaigns/:id` (DAG + node
statuses), campaign cancel/pause, and streams `CampaignNode*` events over the existing
WebSocket; the React studio renders the DAG + per-node status + per-node gate prompts
(the egui dashboard's feature set, ported per the egui review).

## 9. Test strategy (maps 1:1 to REQ §5 SCs)

- **Unit (pure, deterministic):** `ready_set`, `satisfied`, `blocked_by_failure`,
  cycle detection — table-driven incl. diamond, chain, fan-out/in; 100-run determinism
  (SC-C9, SC-C7, SC-C1).
- **Integration (real Runs, mock-worker):** `max_concurrency` cap (SC-C3), the §1
  example dispatch order/overlap (SC-C2), fail-fast (SC-C4), continue-independent
  blocking (SC-C5), per-node human gate isolation (SC-C8).
- **Evidence (real daemon + SIGKILL):** crash mid-campaign → resume, no node runs twice,
  no duplicate nodes (SC-C6) — a Campaign-level analogue of the SC-002 harness.
- Coverage + adversarial diff review before the phase is called done, per the standard
  rigor.

## 10. Risks

- **R1 — core prerequisites** (estate 0.13 rebase, `wicked-core-ts`, `RunFinished`
  event, P5/P6 stages) gate the target implementation. Mitigate: the TS-surface bridge
  (§1) runs the same algorithm + SCs meanwhile.
- **R2 — resume of a `Running` node whose subprocess was interrupted** relies on core's
  §2.6 completion-sentinel, which surfaces `AwaitingHuman` on ambiguity — the campaign
  must treat that node as paused, not failed. Explicit in §6.
- **R3 — concurrency vs worktree cost**: `max_concurrency` bounds parallel Runs, but N
  worktrees + N CLI subprocesses is real machine load. Default conservative; document.

## 11. JS/TS surface — egui feature-parity (must-not-lose)

The egui dashboard (core's P7) is retired. Its **HITL/operator runner** surface (not its
estate-explorer half) must be preserved in the React studio + TS daemon over
`wicked-core-ts`. Verified against the egui code; each maps to a core method already
present. **Critical re-point:** today's React studio speaks crew's `session/phase/gate`
model — it must be re-pointed at core's `run/unit/CLI/council` model and the `CoreEvent`
stream (`+ Campaign*` events). Must-not-lose:

1. **Steering gate** — Approve **with amend/steer text**, Reject, **Cancel run** as three
   distinct actions → `confirm_gate(Approve{amend})` / `confirm_gate(Reject)` /
   `cancel_run`. (Crew's "approve-with-conditions" maps to `Approve{amend}`; keep Cancel.)
2. **Action binding by run/node identity, never positional index** — prevents approving
   the wrong run after the list re-sorts.
3. **Gate-prompt event-sourcing + self-healing cache** — the prompt comes from the
   `AwaitingHuman`/`CampaignNodeAwaitingHuman` event (store has none), cached per
   run/node id, re-merged on reconcile, pruned to still-paused — can't leak or blank.
4. **Live CLI output (`CliOutputDelta`) + per-run/per-node filtered event log** — the
   "watch it work" surface; monotonic `seq`, stick-to-bottom, capped.
5. **Routing provenance + denial reason + failure banner** — "why this CLI won"
   (council vote / **evaluator≠creator**), per-unit denial reason, run-halted explainer.
6. **Full lifecycle, ordered paused-first** — Planning/Distributing/Executing/
   AwaitingHuman/Completed/Cancelled/Failed distinct; actionable-first ordering.
7. **Launch surface** — brief + attach-files + target repo + **live memory/knowledge
   recall on the brief**; `RunSpec{problem, clis, repo_ref, gate_policy, entity_mode}`;
   repo registration → **isolated worktree** + worktree inspector.
8. **Advance semantics** — confirm_gate-if-paused vs resume_run-otherwise (a paused run
   must not be `resume`d — it would re-pause).
9. **Work-unit detail** — ord, stage badge, assigned CLI, per-unit approve + transcript.
10. **Governance controls** — deny-policy registration; CLI-registry management (add agent).
11. **Campaign DAG view (new, this design)** — nodes + statuses + edges, per-node gate
    prompts, live per-node output; the parallel analogue of egui's single-run dashboard.

**HITL lifecycle to salvage (design, not egui code).** egui's unused `hitl.rs`
state machine is worth porting into the **TS daemon**: a gate advances
`open → (advisory timeout ~5m) → (hard expiry ~1h) → submitted → acknowledged →
failed/retry`, with an append-only message log — so a gate never hangs forever waiting
on a human. This is a daemon concern layered over core's `AwaitingHuman`, not a core change.

**Safe to drop:** native PTY/vt100 terminals, egui theme engine, CPU frame-capture /
`--demo` recording, painted charts + mermaid-via-mmdc, and (decision pending) the entire
estate-explorer half (Applications/Graphs/Docs/Knowledge/Memory/Reporting) — that is a
separate estate-consumer surface, not the HITL runner.
