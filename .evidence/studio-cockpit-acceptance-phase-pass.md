# Studio Cockpit — Acceptance / Evidence phase

Feature: **studio operator cockpit + insight layer**
Implements: REQ/DES/TEST-STUDIO-COCKPIT-001

Commits under test:
- wicked-core `feat/workflow-def-engine` **00241bd** — insight-event layer
- wicked-crew `feat/studio-cockpit` **6aa5b1c** — cockpit + insight rail

## Re-derived verdicts (wicked-garden:prove → wicked-vault evidence)

Every claim below was **re-derived from a freshly-run command** (`re_derived: true`,
`gate: vault-cross-check`), not asserted. Artifact IDs are the frozen evidence.

These verdicts were re-derived AFTER the adversarial-review fixes below (on the fixed code +
the rebuilt/re-signed napi `.node`), so they reflect HEAD, not the pre-review state.

| Claim | Command (re-run) | Verifier | Verdict | Vault artifact |
|---|---|---|---|---|
| core tests pass | `cargo test -p wicked-core` | exit_code_eq:0 | **PASS** | `019F4CAB238317C784C4E74BD314` |
| studio typecheck clean | `npx tsc --noEmit` | exit_code_eq:0 | **PASS** | `019F4CAB30666B38ADBDB4AE2768` |
| studio unit tests pass | `npx vitest run` | not_contains:failed | **PASS** | `019F4CAB44402574F2882F877DAA` |
| **live acceptance** | `node live_capture.mjs` (launches a real crew run, taps /ws) | `jq_pred: cliUsage.inputTokens>0 and outputTokens>0 and costUsd>0 and (dataUsed\|length>=1) and sessionCompleted==true` | **PASS** | `019F4CAD59E8281444AEBC620246` |

Deterministic counts observed on the runs: wicked-core **195 passed / 0 failed** (+`t_d4`/`t_d4b`
rework-attempt regression tests); studio **tsc exit 0**; **vitest 81 passed / 13 files** (+5 fix
regression tests). Prior pre-review artifacts (`…321A`/`…860F`/`…B9FC`/`…CC930`, 194/76) are superseded.

## Live acceptance detail (T-A1 / T-A2)

Re-derived on a fresh run against the armed daemon (`WICKED_BUS_EXEC=1`). The run
emitted, over `/ws`, real `cliUsage{inputTokens>0, outputTokens>0, costUsd>0}` +
`dataUsed{≥1 file}` + `gateEvaluated` + `sessionCompleted`. Earlier manual proof
(run `3da5908b`) rendered these in the cockpit UI: Burn = tokens 26,296 (26,119/177)
· $0.4357 · rework 0%; Data = worktree README path + `memory/knowledge recall:
disabled (pending core-ts binding)` label; Decisions = claude won · 20% agreement ·
5 returned · 2 dissent · evaluator pass. Numbers match the events exactly.

## Timing note (gotcha, captured in wicked-crew brain)

A crew run is ~98s wall-clock, ~83s of it council-routing/distribution before dispatch.
Usage/files are **live-event-only** (absent from the `GET /runs` snapshot DTO), so the
observer/studio must stay WS-connected through the run. Observation windows must
outlast the routing step (the live_capture harness uses a 200s ceiling, early-exits on
usage+files+completion).

## Independent adversarial review (evaluator ≠ creator) — **PASS**

Two independent reviewers (neither built the feature) audited the committed diff: an honesty/NFR-1
reviewer and an engine-correctness reviewer. They confirmed the load-bearing paths hold (claude
stream-json parse edge cases, cost double-source guard, CliUsage/DataUsed staleness guards, merge
idempotency, napi↔studio field-name mapping, flag-injection dedup) and surfaced **three confirmed
defects**, each verified against source before fixing:

| # | Sev | Defect | Fix | Regression test |
|---|---|---|---|---|
| 1 | MAJOR | `gateDecider` attributed a deny-dominant DENY to the deepest layer that RAN — blaming the agent judge for a denial the agent PASSED (floor failed while judge approved) | `DecisionsLedger.tsx`: on `combined===false` name the failing layer(s); agent named only by elimination | `cockpitPanels.test.tsx` deny-attribution |
| 2 | MAJOR | `confirm_gate` bumped `attempt` on a PRE-unit gate approval → a gated first dispatch booked as rework (~100% under `human_confirm:all`) | `actor.rs`: bump only when the cursor unit already ran (`Done`/`Rejected`); studio `burnSummary` keys rework off the per-unit EARLIEST attempt (belt-and-suspenders, also covers the resume path) | `p2_gates::t_d4` (attempt 0) + `seam_findings::t_d4b` (genuine retry → attempt 1, no wedge) + `useRunModel` gated-first-dispatch |
| 3 | MAJOR | `pendingGate` snapshot fallback used the 0-based cursor index as a 1-based ord → a rehydrated client highlights a phantom ord during a pause | `useRunModel.ts`: resolve the cursor index to the snapshot unit's real ord | `useRunModel` rehydrate |

Also fixed: `isClaudeCli` seat-name substring → classify by the invocation binary stem (matches engine
`binary_is_claude`); PhaseLadder `distributed` label `executing`→`dispatched` (no overstatement); the
events ring-buffer cap raised out of realistic reach with an honest partial-totals note; REQ FR-7 / DES §3
doc drift (`attempt>1` → the corrected earliest-attempt semantics).

Deferred with rationale (labeled, not silently dropped): MINOR-1 — `GateEvaluated` carries no `attempt`,
so two byte-identical re-evaluations across attempts collapse in the ledger dedup (under-counts identical
evaluations; totals unaffected); MINOR-3 — a CLI killed by timeout mid-line can leak a raw partial-JSON
fragment to live output (documented fail-safe, cosmetic). Both are tracked, neither is a false engine-fact.

The engine fix required a napi rebuild; the `.node` was rebuilt (release), re-signed, and the daemon
restarted before the verdicts above were re-derived — so the running system carries the fix.
