---
id: REQ-STUDIO-COCKPIT-001
title: Studio operator cockpit + insight layer
status: draft
phase: define
---

# REQ-STUDIO-COCKPIT-001 — Studio operator cockpit + insight layer

## Overview

wicked-studio is the operator console for wicked-crew — the Govern/control-room arc that
drives your coding-agent CLIs (the harnesses) as governed workers. Today it is basic: a runs
list, a run detail with work units, a live-output pane, an event log, and a governed
terminal. This requirement elevates it into a **glass cockpit** for builders and doers: not
just *that* the run is executing, but the
reasoning, the economics, and the causality — so an operator can trust the machine and
intervene intelligently, early.

The product principle: **a control room people trust shows its work.** Every claim on screen
is backed by a real engine event; anything not yet wired is labeled, never faked.

## User

A builder/doer driving governed multi-agent work: points crew at an intent + repo, lets
it drive their coding-agent CLIs through a governed workflow, and needs to (a) watch it,
(b) understand its decisions/assumptions/spend, and (c) steer it at the gates.

## Goals

- Make the run **observable** (mechanics): phases, live worker output, the governed gate.
- Make the run **legible** (insight): decisions made/pending, assumptions, burn +
  rework-cost, data-in-use, and how findings/input changed the outcome.
- Keep the **HITL control loop** first-class: approve / reject / steer-with-amendment on
  cold evidence.
- **No fakes:** every panel is driven by a real event; unwired capabilities are labeled.

## Functional requirements

### Mechanics (cockpit center)
- **FR-1 Phase ladder.** Render the run's phases (from the workflow def) as a track with
  the gate between each; show each phase's status (pending / executing / gated / done /
  failed) and the current phase. Source: session + unit lifecycle events.
- **FR-2 Live worker output.** Stream each unit's CLI stdout in real time, tagged with the
  CLI identity and the git worktree it runs in. Source: `CliOutputDelta` (bridged).
- **FR-3 Gate resolve (HITL).** When a run is `AwaitingHuman`, surface the gate: the
  criterion, the deterministic check result, the agent judge verdict + reasoning, the
  deny-dominates combination, and the evidence. Actions: **Approve / Reject /
  Steer-with-amendment** (amend overrides the next unit's instruction). Source:
  awaiting-human + gate events; `confirmGate`.
- **FR-4 Governed terminal.** Keep the embedded governed operator shell (already present).

### Insight (right rail)
- **FR-5 Decisions ledger (made + pending).** A chronological ledger of governed
  decisions: gate verdicts (deterministic + judge + combination), council winners +
  dissent, routing/skill choices — each with *who decided* (deterministic / council /
  human) and *the evidence*. Plus **pending**: gates awaiting a human, and next decision
  points down the ladder. Source: gate/council/routing events (real now).
- **FR-6 Assumptions.** Surface what the run is taking for granted (e.g. "assumed pytest",
  "no rollback specified"). Real version: the clarify/design **skills emit structured
  assumptions**; proto version: derive from council `CHANGE_MY_MIND`/dissent + clarify
  output. Boundary: labeled "proto" until the skill convention lands.
- **FR-7 Burn + rework-cost.** Per unit + running **tokens + cost + time**, with burn
  attributed to **rework** — burn on a genuine RE-RUN of a unit, i.e. usage beyond that unit's
  FIRST dispatch. (The engine numbers a unit's first dispatch `attempt=0`; rework is keyed off the
  per-unit earliest attempt, robust to a wedge-key attempt bump on gate approval — see DES §3.) Show
  "N% of tokens went to rework." Requires the usage wire (FR-9). Time-per-attempt is derivable now.
- **FR-8 Data-in-use.** Per unit: the intent, the repo/worktree, the evidence handed to
  the evaluator (cold), the roster; and *which files/symbols the agent read* (from CLI
  tool-use). Boundary: memory/knowledge recall labeled "disabled pending core-ts binding".
- **FR-8b Steering / outcome timeline.** A timeline of interventions: each gate
  **rejection** (a finding) and each `confirmGate` **amend/reject** (operator input), with
  its effect (retry, redirect, amended instruction) and the before/after. Source:
  gate-reject + confirmGate events (real now).

### Engine wire (the one real dependency under the insight)
- **FR-9 Usage + tool-use capture.** Run workers with structured CLI output
  (`--output-format json` where supported), parse **usage (input/output tokens, cost)** and
  **tool-use (files/symbols read)**, tag with `(run, unit, attempt)`, and stream new
  events `CliUsage{tokens, cost, attempt}` and `DataUsed{files}` through CoreEvent → napi →
  daemon WS → studio. MUST degrade cleanly for CLIs that don't emit usage (label
  "usage unavailable for <cli>"), and MUST NOT change the default execution result.

## Non-functional requirements

- **NFR-1 Grounded.** Every panel maps to a real event/field; no invented data. Unwired
  → explicitly labeled.
- **NFR-2 Real-time.** Panels update live off the WS `CoreEvent` stream; forward-only is
  acceptable (a late-joining client sees state from connect onward), but a run's terminal
  state (verdict, ledger, burn totals) must be fetchable on open (snapshot).
- **NFR-3 Honest boundaries.** Memory/knowledge recall (disabled), campaign DAG (not napi-
  wired), workflow selector (not wired) are shown as such, not hidden or faked.
- **NFR-4 No regression.** FR-9 is additive; the default in-process + the bus-exec paths,
  existing tests, and the current studio flows keep working.
- **NFR-5 Cross-platform / cost honesty.** Token→cost uses a declared, overridable price
  table; if a CLI reports no cost, show tokens only. Never assert a dollar figure a CLI
  didn't provide.

## Out of scope (this requirement)
- Wiring campaign DAG to napi (separate task; shown as "engine-real, not wired").
- A workflow-selector on the launch form (separate; runs launch from free-text today).
- Enabling memory/knowledge recall (needs the core-ts binding; labeled disabled).

## Reconciliation — post-adversarial-review (this is the authoritative scope)

The challenge gate verified every claim against source and found the engine's event
vocabulary is **coarse**, so several FRs were over-scoped. Corrected reality:

- The full live vocabulary is `event.rs` `CoreEvent`: lifecycle (`SessionStarted`,
  `UnitPlanned/Distributed{cli}/Executing/Done/Denied`, `AwaitingHuman{prompt}`,
  `GateDecided{allow:bool}`, `Resumed`, `RunCancelled`, `SessionFailed/Completed`,
  `Error`), `CliOutputDelta{chunk}`, Terminal*, Campaign*. **That's it.**
- Rich data (council winner/agreement/dissent, routing, `denial_reason`) is **snapshot-
  only** on `WorkUnit`/`AgentSession` via `GET /runs` — NOT events.
- `session.attempt` is internal/transient/reset-to-0/un-emitted.
- FR-9 usage/tool-use is **claude-only** and needs `stream-json` (not `json`) plus a runner
  that emits BOTH a readable delta (FR-2) AND structured usage/tool events.
- Correction: **codex is not a built-in seat** (registry = claude/agy/pi/copilot/opencode).
- Honest boundaries (memory recall disabled, campaign not napi-wired, workflow selector not
  wired) are all accurate.

**NFR-2 relaxed:** the ledger/insight panels **hydrate from `GET /runs` (snapshot)** on open
and **append** from the coarse live events. "Live off the WS stream" applies to lifecycle +
output; the rich detail is snapshot-driven. This is the honest contract.

### PHASE A — cockpit on real data now (no engine change, snapshot + coarse events)
- **A1 Phase ladder** (FR-1) — from lifecycle events + workflow def.
- **A2 Live output** (FR-2) — `CliOutputDelta`, joined to CLI/worktree from the snapshot
  (the delta itself carries only `{session, ord, chunk}`).
- **A3 Gate resolve** (FR-3 action) — Approve/Reject/Steer-amend already wired
  (`SteeringGate`); show what's available (`AwaitingHuman` prompt + snapshot `denial_reason`
  + routing). Rich gate detail is Phase B.
- **A4 Decisions ledger** (FR-5) — **snapshot-hydrated**: council winner/agreement/dissent +
  routing (`WorkUnit.routing`), appended by `GateDecided`/`AwaitingHuman`/`UnitDenied`.
- **A5 Steering/outcome timeline** (FR-8b) — from `AwaitingHuman`→`confirmGate(amend/reject)`
  actions + the amended description; before/after is thin (string), shown honestly.
- **A6 Data/What-Where** (FR-8 partial) — intent/repo/roster/worktree/diff from snapshot;
  files-read is Phase B; memory recall labeled disabled.
- **A7 Expose `skill_ref`** at the daemon/studio `WorkUnit` boundary (tiny; it exists in Rust).
- **A8 Terminal** (FR-4) — already present.

### PHASE B — the insight wires (real cross-crate engine work, claude-first)
- **B1 Rich gate detail.** Enrich `GateDecided` (or add a gate-detail field/event) to carry
  the criterion, deterministic-check result, agent-judge verdict + reasoning, and the
  deny-dominates combination. Feeds the decisions ledger's depth (FR-3/FR-5).
- **B2 Durable attempt/rework record.** Emit a per-dispatch `(run, unit, attempt)` event and
  persist a per-unit attempt history (session.attempt resets today). Feeds FR-7.
- **B3 Usage capture (claude-first).** Teach `WrappedCliStepRunner` a per-CLI output adapter:
  for claude, run `--output-format stream-json` and parse NDJSON into (a) readable text →
  `CliOutputDelta` (preserve FR-2) and (b) `CliUsage{tokens, cost, attempt}` event. Other
  seats: no adapter → emit nothing, panel shows "usage unavailable for <cli>". Add the
  `CoreEvent` variant + napi `event_to_json` arm + studio type. Token→cost via a declared,
  overridable price table (NFR-5). Feeds FR-7 burn/rework-cost.
- **B4 Data-in-use files-read (claude-first).** From the same stream-json tool_use blocks,
  emit `DataUsed{files}`. Non-claude → unavailable. Feeds FR-8.
- **B5 Assumptions.** No engine backing today. Real version = a skill convention emitting
  structured assumptions; interim = a labeled "proto" panel derived from council dissent /
  `CHANGE_MY_MIND`. May land as proto in this effort, full convention deferred.

Missing requirements the review surfaced, now adopted: a snapshot-hydration contract for the
ledger (A4), the FR-9↔FR-2 stream-json dual-emit reconciliation (B3), a per-CLI usage adapter
(B3), a durable per-unit attempt record (B2), and exposing `skill_ref` (A7).

## Acceptance (how "done" is judged)
Each FR is demonstrated **on a real run against the running daemon** (screenshot/measured),
or — where it needs FR-9 — demonstrated with the usage wire live. Anything not demonstrable
live is either (a) labeled unwired, or (b) not claimed done. The dual-validator gate model
applies: a deterministic check (the panel renders the real event) + an independent review.
