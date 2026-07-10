---
id: DES-STUDIO-COCKPIT-001
title: Studio operator cockpit + insight layer — technical design
status: draft
phase: design
implements: REQ-STUDIO-COCKPIT-001
---

# DES-STUDIO-COCKPIT-001 — technical design

Implements REQ-STUDIO-COCKPIT-001 (reconciled scope: Phase A cockpit on real data;
Phase B insight wires, claude-first). Grounded in the verified code surface.

## 1. Data model — the hydrate + append contract (NFR-2)

The studio holds run state = **snapshot (authoritative)** merged with **live events (append)**.
- On open / select: `GET /api/v1/runs/:id` → `SessionView` snapshot (sessions_detail:
  units with `assigned_cli`, `assigned_invocation`, `routing` (RoutingInfo), `denial_reason`,
  status; + `skill_ref` after A7). This is the source of truth for council/routing/gate depth.
- Live: the `/ws` `CoreEvent` stream **appends/patches** — lifecycle advances the ladder,
  `CliOutputDelta` streams output, `GateDecided`/`AwaitingHuman`/`UnitDenied` update the
  gate + append to the ledger, and (Phase B) `CliUsage`/`DataUsed`/`UnitDispatched`/gate-detail
  enrich burn/data/rework/decisions.
- A single `useRunModel(runId)` hook owns this merge; panels are pure views over it.

## 2. Phase A — cockpit UI (no engine change)

Layout: **three-pane cockpit** in `RunDetail`.
- **Left:** `RunList` + `LaunchForm` (existing).
- **Center:** `PhaseLadder` (new) + `LiveOutput` (existing, joined to CLI/worktree from
  snapshot) + `SteeringGate` (existing) surfaced as a modal/card when `AwaitingHuman`.
- **Right — insight rail (tabbed or stacked):**
  - `DecisionsLedger` (new): rows from snapshot `WorkUnit.routing` (council winner /
    agreement_pct / dissent) + `denial_reason`, appended by live `GateDecided{allow}` /
    `AwaitingHuman` / `UnitDenied`. Each row: what was decided · who (deterministic / council
    (n seats, agreement%) / human) · basis. Pending = current `AwaitingHuman` + "next gate".
  - `SteeringTimeline` (new): each `AwaitingHuman`→`confirmGate` action (approve / reject /
    amend<text>) in order, with the amended instruction shown; before/after labeled "as
    recorded" (string) — honest about thinness.
  - `WhatWhere` (new): intent, repo, worktree path, roster, the diff (from `work_output`),
    memory-recall row labeled "disabled (pending core-ts binding)".
  - `Burn` + `DataUsed` panels: rendered as **"awaiting usage wire (Phase B)"** placeholders
    that light up when the events arrive — never fake numbers.
- **Drawer:** `Terminal` (existing governed PTY).

A7 (expose `skill_ref`): add `skill_ref?: string` to the daemon `WorkUnit` DTO (it exists on
the Rust `WorkUnit`; surface it in `sessions_detail`/`sessionView` mapping) + the studio
`api/types.ts` `WorkUnit`. `RoutingProvenance` shows it.

## 3. Phase B — the insight wires (engine, claude-first)

### B-events: new `CoreEvent` variants (`wicked-core/src/event.rs`)
- `UnitDispatched { session, ord, attempt }` — emitted every time a unit is dispatched
  (initial + each re-dispatch), so a client sees rework happen. Emitted from the actor's
  dispatch path where `attempt` is set (actor.rs dispatch / confirm_gate approve / resume /
  redrive). This is the durable-rework signal (B2) — the client accumulates per-unit attempt
  history; a `(run,unit,attempt)` tuple with attempt>1 = rework.
- `CliUsage { session, ord, attempt, input_tokens, output_tokens, cost_usd: Option<f64> }` (B3).
- `DataUsed { session, ord, files: Vec<String> }` (B4).
- `GateEvaluated { session, ord, criterion: String, deterministic_pass: bool,
  agent_verdict: Option<String>, agent_reasoning: Option<String>, combined: bool }` (B1) —
  emitted alongside/just before `GateDecided`, carrying the depth. (Keeps `GateDecided{allow}`
  for back-compat; `GateEvaluated` adds the detail.)
Each gets an `event_to_json` arm (`wicked-core-ts/src/lib.rs`) + a studio `CoreEvent` type +
the drift test updated. Daemon passthrough is automatic (verbatim fan-out).

### B-runner: the per-CLI output adapter (B3/B4) — the load-bearing piece
`WrappedCliStepRunner::exec` today spawns the CLI and streams raw stdout lines →
`CliOutputDelta`. Introduce an `OutputAdapter` selected by the seat:
```
trait OutputAdapter {
  // consumes a raw stdout line; returns 0..n readable-text deltas to emit as CliOutputDelta,
  // plus optional structured signals (usage, tool_use) to emit as CliUsage/DataUsed.
  fn on_line(&mut self, line: &str) -> AdapterOut; // { text: Vec<String>, usage: Option<Usage>, files: Vec<String> }
  fn finish(&mut self) -> AdapterOut;
}
```
- **claude adapter:** the invocation gains `--output-format stream-json --verbose` (appended
  to the seat's `headless_invocation` for the `claude` binary only, via a per-binary rule —
  NOT a blanket change to every seat's template). Parses NDJSON: assistant `text` blocks →
  readable deltas (preserves FR-2 live output); `tool_use` blocks with file paths → `DataUsed`;
  the terminal `result`/`usage` object → `CliUsage`.
- **default/passthrough adapter (agy/pi/copilot/opencode + unknown):** every line is a readable
  delta, no usage/files. Panels show "usage unavailable for <cli>".
- Selection: by resolved binary (claude → ClaudeStreamJson; else Passthrough). The default
  execution result/status is unchanged (additive); if stream-json parse fails, fall back to
  passthrough for that run (fail-safe, logged) so a claude CLI-version mismatch never breaks a run.

### B-cost: the price table (NFR-5)
A declared `[[cli_price]]` config (`~/.config/wicked-council/prices.toml` or a default map):
`{ key, input_per_mtok, output_per_mtok }`. `cost_usd = input_tokens/1e6*in + output_tokens/1e6*out`
when a price exists; else `CliUsage.cost_usd = None` and the panel shows tokens only. Never
assert a dollar figure the CLI didn't imply.

### B-rework math (studio side, B2+B3)
Per unit, accumulate `attempt`s from `UnitDispatched` and tokens from `CliUsage` keyed by
`(ord, attempt)`. The engine numbers a unit's FIRST dispatch `attempt=0`. rework_tokens = Σ tokens on
usage beyond the unit's EARLIEST recorded attempt (NOT a blanket `attempt>0`) — this is robust to the
engine bumping `attempt` for wedge-key freshness on a gate approval, so a once-dispatched unit books zero
rework regardless of its attempt number; rework_% = rework_tokens/total.
Burn panel: total tokens/cost, per-CLI split, and the rework slice with the causal link
(which gate rejection triggered the re-dispatch, from the ledger).

## 4. Dependency order (for the plan)
1. **A7 `skill_ref`** (tiny, unblocks provenance) + **Phase A UI** (parallel, no engine dep).
2. **B-events** enum + napi + studio types (foundation for B1–B4).
3. **B-runner adapter** (B3/B4) — the biggest; depends on B-events.
4. **B1 gate-detail** emission; **B2 UnitDispatched** emission (small, depend on B-events).
5. **B-cost** price table.
6. Studio insight panels (Burn/DataUsed/rich-ledger) light up on the new events.

## 5. Honest boundaries carried onto the UI
- Burn/DataUsed = **claude-only**; non-claude seats render "usage unavailable for <cli>".
- Assumptions (B5) = "proto" (derived from dissent/CHANGE_MY_MIND) or deferred; labeled.
- Campaign, workflow-selector, memory-recall = labeled unwired (unchanged).

## 6b. Design validation — EMPIRICAL (challenge gate resolution)

A real `claude -p "read <file> and reply" --output-format stream-json --verbose` run
(claude v2.1.x, this environment) confirmed the load-bearing adapter assumptions:
- Event types: `system`, `assistant` (×N), `user`, `result`, `rate_limit_event` (NDJSON).
- **Readable text + tool_use in one stream:** `assistant` messages carry text blocks AND
  `tool_use` blocks, e.g. `{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/wc-probe.txt"}}`
  → FR-2 deltas (text) AND FR-8 files-read (tool_use `input.file_path`) are both parseable.
- **Usage + cost:** the terminal `result` event carries
  `usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`
  **and `total_cost_usd`** (measured 0.409099). So `CliUsage` gets tokens AND cost **directly
  from claude** — the price table (NFR-5) is demoted to a FALLBACK for CLIs that report tokens
  without cost. Cache tokens are reported separately (surface input/output; optionally note cache).
- Flag injection into the guarded argv works (`-p "<prompt>" --output-format stream-json
  --verbose`). Runner passes `stdin(Stdio::null())` — pass `< /dev/null` semantics already hold
  (the observed stderr "no stdin in 3s" is benign; keep null stdin).

Reconciliations adopted: (1) claude adapter reads `result.usage` + `result.total_cost_usd` for
`CliUsage`; (2) parse `assistant` blocks for both text (deltas) and `tool_use.input.file_path`
(DataUsed); (3) price table used only when a seat reports tokens but no cost. B1 gate-detail and
B2 dispatch-emit remain real plumbing (detail is computed in `validator.rs` but reduced to a bool
before the actor; dispatch happens at 4 sites) — carried as design tasks, not assumptions.

## 6. Verification hooks (feeds test strategy)
- Deterministic: unit tests on the claude stream-json adapter (fixture NDJSON → expected
  text deltas + Usage + files); event-drift test for the 4 new variants; a daemon WS test
  that the new events fan out.
- Live: a real claude run against the daemon must produce `CliUsage` (tokens>0) + `DataUsed`
  (≥1 file) + `UnitDispatched`, and the cockpit panels must render them (screenshot).
- Non-claude fail-safe: a passthrough seat run still streams output + shows "usage unavailable".
