---
name: REQ-005-dod-criteria
title: wicked-crew — Definition of Done
status: partially-verified
version: 0.2
date: 2026-07-21
author: michael.parcewski@accenture.com
review-required: true
---

# REQ-005 — Definition of Done

## 1. Principle

DoD for wicked-crew + wicked-studio is a **working app**, not a test suite with green checkmarks. Every SC in REQ-001 §7 must be verifiable against running software with recorded evidence. No SC is "done" unless it is demonstrated end-to-end.

---

## 2. Phase-Level DoD Gates

### Define Phase DoD

All required before Design begins:

- [x] REQ-001 through REQ-005 written
  - Evidence: `.product/evidence/define-phase-pass.md` (PASS, 3 adversarial review rounds, 2026-07-07)
- [x] RAID.md populated with known risks, assumptions, issues
  - Evidence: `RAID.md` — 7 risks, 7 assumptions, 4 issues (ISS-001 resolved), 8 decisions
- [x] Research brief (OSS landscape) written and findings incorporated into REQ-002
  - Evidence: incorporated into REQ-002-technology-constraints.md
- [x] Adversarial review of requirements: no open CRITs or SIGs
  - Evidence: `.product/evidence/define-phase-pass.md` — 3 rounds, all CRITs and SIGs resolved
- [x] All success criteria (SC-001..SC-009) are measurable (have a specific, observable check)
  - Evidence: REQ-001 §7 — each SC has a measurable check and evidence artifact type
- [x] wicked-studio requirements written (at minimum: scope, domain model, DoD for the UI layer)
  - Evidence: `from-studio-REQ-001-studio-overview.md` and `DES-STUDIO-001-crew-daemon-studio-on-core-ts.md`

### Design Phase DoD

- [x] DES-001 (technical design) covers: daemon architecture, REST API spec, WebSocket event schema, SQLite schema, XState v5 FSM definition, governance engine design, worker dispatch protocol, wicked-studio component hierarchy
  - Evidence: `.product/evidence/design-phase-pass.md` (PASS, 3 rounds, 2026-07-07); architecture subsequently migrated to wicked-core-ts NAPI adapter — DES-001 updated accordingly
- [x] API contract (REST + WebSocket) is frozen before build begins
  - Evidence: DES-001-technical-design.md REST + WebSocket spec sections
- [x] Worker protocol spec: exact stdin/stdout format, output parsing rules, timeout handling
  - Evidence: `WORKER-PROTOCOL.md`
- [x] Adversarial review of design: no open CRITs or SIGs
  - Evidence: `.product/evidence/design-phase-pass.md` — 3 rounds, round 3 targeted PASS

### Test Strategy Phase DoD

- [x] TEST-001 written with executable scenarios for every SC-001..SC-008
  - Evidence: `.product/evidence/test-strategy-phase-pass.md` (PASS, 2 rounds, 2026-07-07)
- [x] Scenarios are specific: "run this command, observe this output/file/event"
  - Evidence: TEST-001 scenario sections; each SC has a named scenario with assertion list
- [x] Acceptance scenarios for wicked-testing pipeline included
  - Evidence: TEST-001 §acceptance map
- [x] Adversarial review: no open CRITs or SIGs
  - Evidence: `.product/evidence/test-strategy-phase-pass.md` — round 2 PASS
- [x] Testability review: every scenario has a defined execution path
  - Evidence: TEST-001 — each scenario names the fixture worker and concrete invocation

### Build Phase DoD

- [x] All unit tests pass (Vitest)
  - Evidence: `npm test` — 155 tests pass across both packages (crew + studio) as of 2026-07-21
- [x] All integration tests pass (real SQLite, real subprocess workers)
  - Evidence: `packages/crew/tests/integration/` — 4 integration test suites (26 tests) all pass; daemon-bridge tests exercise the real wicked-core-ts adapter
- [x] TypeScript strict mode: zero errors
  - Evidence: `npm run typecheck` passes with zero errors across both packages (2026-07-21)
- [x] ESLint: zero warnings
  - Evidence: `npm run lint` passes with zero warnings across both packages (2026-07-21)
- [ ] wicked-testing acceptance pipeline: PASS verdict
  - Not yet run against the current architecture (wicked-core-ts adapter version)
- [x] Adversarial diff review: no open CRITs or SIGs on the diff vs design spec
  - Evidence: `.product/evidence/build-adversarial-review-round2-pass.md` — 3 rounds, round 3 PASS

### Test (DoD Verification) Phase DoD

All six working-app behaviors verified with evidence:

1. **Session start**: `wicked-crew start --type feature --goal "add CSV export"` creates session in SQLite, emits `wicked.crew.session.started` to wicked-bus. Evidence: wicked-bus event log.
   - [x] **PASS** — `.product/evidence/dod/sc001/verdict.json` `behavior1_session_start: pass=true`, `ws_event: true`, `sqlite_row: true`, `bus_count: 1`

2. **Worker dispatch**: Daemon dispatches to worker CLI (real or mock-worker), captures output, records as evidence. Evidence: dispatch record in SQLite with exit_code=0 and non-empty parsed_output.
   - [x] **PASS** — `.product/evidence/dod/sc001/verdict.json` `behavior2_dispatch: pass=true`, 6 dispatch records, all `exit_code=0`

3. **Auto gate**: Gate auto-evaluates (auto gate kind), passes governance policies, advances phase. Evidence: phase record updated to Approved, `wicked.crew.phase.gate.approved` event in wicked-bus.
   - [x] **PASS** — `.product/evidence/dod/sc001/verdict.json` `behavior3_auto_gate: pass=true`, `bus_gate_approved=6`

4. **Studio connectivity**: wicked-studio connects, live session visible within 5 seconds, WebSocket event received. Evidence: screenshot + WebSocket frame capture.
   - [x] **PASS** — `.product/evidence/dod/sc006/verdict.json` — `wsFirstMsgMs=33.8ms`, `sessionVisibleMs=96ms` (both within 5s window)

5. **Crash + resume**: Daemon killed via SIGKILL during InProgress phase. `wicked-crew resume --session <id>` restores to pre-crash phase state. Evidence: SQLite dump before kill vs after resume — all non-temporal fields (phase, state, phase_id, session_id, evidence references, blocking_items) are identical; timestamp fields (updated_at) are excluded from comparison.
   - [x] **PASS** — `.product/evidence/dod/sc002/verdict.json` — real SIGKILL (signalCode: SIGKILL, exitCode: null), pre/post field diff clean, `behavior5_resumed: pass=true`

6. **Status accuracy**: `wicked-crew status` output matches SQLite phase state at all times, including during worker execution. Evidence: side-by-side SQLite query vs status output comparison.
   - [x] **PASS** — `.product/evidence/dod/sc001/verdict.json` `behavior6_status_accuracy: pass=true`

---

## 3. Success Criteria Verification Checklist

Each SC from REQ-001 §7 has a specific verification method:

| SC | Verification method | Evidence artifact | Status |
|---|---|---|---|
| SC-001 | Run full feature workflow end-to-end; query wicked-bus for gate events | `.product/evidence/dod/sc001/verdict.json` | **PASS** |
| SC-002 | SIGKILL daemon mid-phase; SQLite snapshot before/after resume comparison | `.product/evidence/dod/sc002/verdict.json` | **PASS** |
| SC-003 | Automated test: 100 runs of gate eval with identical inputs; assert identical outputs | *Governance migrated to wicked-core (Rust); covered by `wicked-core/tests/governance_in_run.rs` and `wicked-core/tests/events_governance_deep.rs`. 100-run crew-level test NOT yet run (non-negotiable per §7).* | **DELEGATED / OPEN** |
| SC-004 | Automated test: council dispatch to ≥ 2 workers; assert council artifact `perspectives.length ≥ 2` | *Council dispatch in wicked-core; covered by `wicked-core/tests/p2_gates.rs`. Crew-level verification not yet run.* | **DELEGATED / OPEN** |
| SC-005 | Automated test: fixture verdicts PASS/CONDITIONAL → gate advances; FAIL → gate blocked | *test-verdict gate policy in wicked-core; covered by `wicked-core/tests/events_governance_deep.rs`. Crew-level verification not yet run.* | **DELEGATED / OPEN** |
| SC-006 | Start daemon; open studio; measure time to first WebSocket event | `.product/evidence/dod/sc006/verdict.json` — `wsFirstMsgMs=33.8ms`, `sessionVisibleMs=96ms` | **PASS** |
| SC-007 | `time wicked-crew start --type feature --goal "x"` on macOS M1; assert < 3s | `.product/evidence/dod/sc007/verdict.json` | **PASS** |
| SC-008 | Add entry to workers.json; wait ≤ 30s; dispatch to new worker; assert success | `.product/evidence/dod/sc008/verdict.json` | **PASS** |
| SC-009 | HITL gate approval from **terminal CLI** advances phase gate within 5s | `.product/evidence/dod/sc009/verdict.json` — terminal `wicked-crew gate` exit (0), phase advanced in 413ms | **PASS** |

**DELEGATED / OPEN**: SC-003, SC-004, SC-005 previously tested the TypeScript governance engine (json-rules-engine, XState v5, council dispatch). Those modules migrated to wicked-core (Rust). The successor tests live in `wicked-core/tests/` and pass as part of the wicked-core CI gate — but this does NOT satisfy the §7 non-negotiable for SC-003: 100 automated crew-level runs with identical inputs asserting identical outputs have NOT been run. This is an open gap. The sc001 evidence shows 6 deterministic auto-gate passes (happy-path only); this is NOT a substitute for 100-run equivalence testing and does not partially satisfy SC-003. Closing requires a dedicated crew-level integration test that drives the wicked-core-ts adapter 100× and asserts gate output stability.

---

## 4. wicked-studio DoD

wicked-studio is done when:

- [x] Connects to wicked-crew daemon REST + WebSocket without configuration (auto-discovers on default port)
  - Evidence: `.product/evidence/dod/sc006/verdict.json` — WebSocket connected, `wsFirstMsgMs=33.8ms`; `.product/evidence/dod/sc-studio-hitl/verdict.json` — session visible in studio, `notifyDeltaMs=124ms`
- [x] Session list shows all active and recent sessions with accurate status
  - Evidence: `.product/evidence/dod/sc001/verdict.json` `behavior6_status_accuracy: pass=true`
- [x] Phase graph visualizes current phase state for a selected session
  - Evidence: `.product/evidence/dod/sc006/verdict.json` — phase state visible in studio
- [x] HITL gate panel shows phase artifact + governance findings + approve/reject controls
  - Evidence: `.product/evidence/dod/sc-studio-hitl/verdict.json` — gate notification surfaced within 124ms, screenshot `gate-notification.png`
- [x] Human approval via studio advances the gate in wicked-crew (verified by phase state change)
  - Evidence: `.product/evidence/dod/sc-studio-hitl/verdict.json` `SCS03_approve_advances_within_3s: pass=true` (11ms actual), `SCS03_next_phase_started: pass=true`
- [x] Event feed shows live wicked-bus events within < 500ms of emission
  - Evidence: `.product/evidence/dod/sc-studio-hitl/verdict.json` — `notifyDeltaMs=124ms` (gate notification delivered to studio within 124ms); WebSocket bridge tested in `packages/crew/tests/integration/daemon-bridge.test.ts`
- [ ] Settings panel allows worker registry view (read-only in v1)
  - Not yet verified with dedicated evidence
- [x] Works on macOS (Chrome) and responds correctly to daemon being unavailable (shows disconnected state gracefully)
  - Evidence: `.product/evidence/dod/sc006/console-error-log.json` — no console errors; `packages/crew/tests/integration/studio-serving.test.ts` — headless degradation test passes (no studio bundle → 404 gracefully)

---

## 5. wicked-garden Scope Reduction DoD

wicked-garden's orchestration layer is removed when:

- [ ] `scripts/crew/phase_manager.py` and `scripts/crew/archetypes_v11.py` removed (or deprecated with a clear migration note)
  - Status: still present in wicked-garden; pending migration to wicked-crew-native workflow
- [ ] `commands/archetype/` commands removed (or marked as deprecated with pointer to wicked-crew)
  - Status: still present; pending
- [ ] wicked-garden is usable standalone without wicked-crew (utilities still work independently)
  - Status: not yet verified after removal (removal not yet done)
- [ ] wicked-garden CI validation passes after removal
  - Status: pending on removal
- [ ] No regression in core wicked-garden features: evidence gating, code-graph queries, multi-model review, memory, playbooks
  - Status: pending on removal

---

## 6. Evidence Requirements

All phase DoD evidence is stored in `.product/evidence/` with timestamps. Required artifacts:

| Artifact | Required for |
|---|---|
| Adversarial review findings + resolutions (per phase) | Each phase gate |
| wicked-testing verdict JSON | Build phase DoD |
| Working-app behavior recording (6 behaviors) | Test phase DoD |
| SC-001..SC-008 verification outputs | Test phase DoD |
| wicked-bus event logs from end-to-end run | SC-001 |
| SQLite snapshots before/after crash+resume | SC-002 |

---

## 7. Non-Negotiable DoD Items

These cannot be waived or deferred:

- Every CRIT and SIG from adversarial reviews must be resolved before gate advances.
- Working-app verification must be against running software (not code review + test results).
- wicked-testing acceptance pipeline must PASS (not CONDITIONAL) before ship.
- SC-002 (crash + resume) must be verified with a real SIGKILL, not a graceful shutdown.
- SC-003 (deterministic gates) must be verified with 100 automated runs, not manual inspection.

---

## Revision History

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 0.1 | 2026-07-07 | michael.parcewski@accenture.com | Initial draft — all items unchecked |
| 0.2 | 2026-07-21 | michael.parcewski@accenture.com | Evidence-phase verification: checked off all items with existing evidence. Phase gates: Define/Design/Test-Strategy/Build-Adversarial PASS; Build phase: 4 of 5 items verified (wicked-testing acceptance pipeline re-run pending — unchecked non-negotiable). Behaviors verified: SC-001 (session start, dispatch, auto-gate, status — 4 behaviors), SC-002 (crash+resume), SC-006 (studio connectivity, wsFirstMsgMs=33.8ms), SC-007 (startup time), SC-008 (worker hot-add), SC-009 (terminal HITL gate), SC-studio-hitl (studio HITL panel, 11ms approve). SC-003/SC-004/SC-005 marked DELEGATED/OPEN — governance migrated to wicked-core Rust; crew-level 100-run test NOT yet run (non-negotiable gap). Status set to partially-verified. Remaining open: wicked-testing acceptance pipeline re-run, SC-003/004/005 crew-level verification, settings panel evidence, wicked-garden scope reduction (separate workstream). Fixed bot findings: evidence paths corrected to `.product/evidence/dod/...`, SC-006 timing corrected to wsFirstMsgMs=33.8ms, SC-009 clarified as terminal HITL (not studio), test path corrected to packages/crew/tests/integration/studio-serving.test.ts. |
