---
id: TEST-STUDIO-COCKPIT-001
title: Studio cockpit — test strategy + build plan
status: draft
phase: test-strategy+plan
implements: REQ-STUDIO-COCKPIT-001 / DES-STUDIO-COCKPIT-001
---

# TEST-STUDIO-COCKPIT-001 — test strategy + build plan

## Test strategy (dual-validator: deterministic floor + independent agent review)

### Deterministic (must pass, cheap, in CI)
- **T-D1 claude stream-json adapter (unit, wicked-core).** Feed a captured fixture NDJSON
  (assistant text + `tool_use{Read,file_path}` + terminal `result{usage, total_cost_usd}`)
  → assert: readable text deltas extracted (no JSON leaked to FR-2), `CliUsage{input,output,
  cost}` = the result's numbers, `DataUsed.files` = the tool_use file paths. Plus a malformed-
  NDJSON case → falls back to passthrough, no panic.
- **T-D2 passthrough adapter (unit).** Non-claude line stream → text deltas, no CliUsage/DataUsed.
- **T-D3 event drift (unit).** The 4 new `CoreEvent` variants each have an `event_to_json` arm;
  the existing exhaustive-match drift test covers them (extend it).
- **T-D4 UnitDispatched emission (unit/integration).** Each dispatch site (dispatch_unit,
  confirm_gate approve, resume, redrive) emits `UnitDispatched{run,unit,attempt}` with the
  correct attempt; a re-dispatch shows attempt increment.
- **T-D5 GateEvaluated (unit).** The gate path emits the criterion + deterministic_pass +
  agent verdict/reasoning + combined, matching `combine_verdict`.
- **T-D6 skill_ref exposure (unit).** `sessions_detail`/WorkUnit DTO carries `skill_ref`.
- **T-D7 no-regression.** `cargo test -p wicked-core` green (incl. exec-seam); napi builds;
  daemon typecheck + vitest green; studio `useRunModel` merge unit test (hydrate + append).
- **T-D8 rework math (studio unit).** Given UnitDispatched(attempt 1,2) + CliUsage per attempt,
  rework_% = Σtokens(attempt>1)/total.

### Independent agent / live acceptance (the "prove it on a real run")
- **T-A1 live claude run.** Armed daemon + a throwaway repo; launch a run; assert on the bus/WS
  that `UnitDispatched`, `CliUsage{tokens>0, cost>0}`, `DataUsed{≥1 file}`, `GateEvaluated`
  actually arrive during a real claude execution.
- **T-A2 cockpit renders real data.** Screenshot each panel showing the T-A1 numbers — phase
  ladder, live output, decisions ledger, burn+rework, data-in-use, steering timeline. NO panel
  shows a number that isn't in the events/snapshot.
- **T-A3 non-claude fallback.** A passthrough seat run → output streams; burn/data panels show
  "usage unavailable for <cli>" (honest, not zero/fake).
- **T-A4 rework scenario.** Force a gate rejection → re-dispatch → the burn panel shows a
  rework slice tied to that decision in the ledger.
- **T-A5 HITL.** AwaitingHuman → Approve / Reject / Steer-amend all work; the steering timeline
  records the intervention + effect.
- **T-A6 independent review** (challenge): an agent audits the running cockpit — every panel
  maps to a real event/field; unwired items (memory recall, campaign, assumptions-proto,
  non-claude usage) are LABELED, not faked.

Acceptance = all deterministic green AND T-A1/T-A2/T-A3 demonstrated on a real run AND T-A6
finds no fake/unlabeled panel. I run T-A1..A6 myself (screenshots), not an agent's word.

## Build plan (waves; dependency-ordered; adversarial-verified per wave)

- **Wave 1 — engine (wicked-core).** New CoreEvent variants (UnitDispatched, CliUsage,
  DataUsed, GateEvaluated); the `OutputAdapter` trait + ClaudeStreamJson + Passthrough in
  `execute_wrapped.rs` (claude gets `--output-format stream-json --verbose` via a per-binary
  rule; parses text→delta, tool_use→DataUsed, result→CliUsage); emit UnitDispatched at the 4
  dispatch sites; plumb gate detail → GateEvaluated; price-table fallback. Tests T-D1..D5,D7.
  → **adversarial review of the diff** (fail-open/parse/edge) → fix → verify.
- **Wave 2 — napi + daemon (wicked-core-ts + packages/crew).** `event_to_json` arms for the 4
  events + studio `CoreEvent` types; expose `skill_ref` in the WorkUnit DTO (A7); daemon
  passthrough is automatic. Tests T-D3,D6; daemon vitest.
- **Wave 3 — studio UI (packages/studio).** `useRunModel` (hydrate+append); the cockpit layout;
  panels: PhaseLadder, DecisionsLedger, SteeringTimeline, WhatWhere, Burn, DataUsed; reuse
  SteeringGate/RoutingProvenance/LiveOutput/Terminal; honest labels for unwired. Tests T-D8 +
  component render.
- **Wave 4 — live test (me).** Arm daemon, real claude run, T-A1..A6 with screenshots.

Parallelism: Wave 1 internals (adapter vs events vs gate-detail vs dispatch-emit) are somewhat
file-disjoint but share `event.rs`/`execute_wrapped.rs`/`actor.rs` — so Wave 1 is best as one
focused engine agent (avoid same-file collisions), Wave 2 one agent, Wave 3 can fan out per
panel after `useRunModel` lands. Each wave gates on adversarial review + my verification before
the next.
