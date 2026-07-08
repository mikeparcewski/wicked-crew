---
name: REQ-005-dod-criteria
title: wicked-crew — Definition of Done
status: draft
version: 0.1
date: 2026-07-07
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

- [ ] REQ-001 through REQ-005 written
- [ ] RAID.md populated with known risks, assumptions, issues
- [ ] Research brief (OSS landscape) written and findings incorporated into REQ-002
- [ ] Adversarial review of requirements: no open CRITs or SIGs
- [ ] All success criteria (SC-001..SC-009) are measurable (have a specific, observable check)
- [ ] wicked-studio requirements written (at minimum: scope, domain model, DoD for the UI layer)

### Design Phase DoD

- [ ] DES-001 (technical design) covers: daemon architecture, REST API spec, WebSocket event schema, SQLite schema, XState v5 FSM definition, governance engine design, worker dispatch protocol, wicked-studio component hierarchy
- [ ] API contract (REST + WebSocket) is frozen before build begins
- [ ] Worker protocol spec: exact stdin/stdout format, output parsing rules, timeout handling
- [ ] Adversarial review of design: no open CRITs or SIGs

### Test Strategy Phase DoD

- [ ] TEST-001 written with executable scenarios for every SC-001..SC-008
- [ ] Scenarios are specific: "run this command, observe this output/file/event"
- [ ] Acceptance scenarios for wicked-testing pipeline included
- [ ] Adversarial review: no open CRITs or SIGs
- [ ] Testability review: every scenario has a defined execution path

### Build Phase DoD

- [ ] All unit tests pass (Vitest)
- [ ] All integration tests pass (real SQLite, real subprocess workers)
- [ ] TypeScript strict mode: zero errors
- [ ] ESLint: zero warnings
- [ ] wicked-testing acceptance pipeline: PASS verdict
- [ ] Adversarial diff review: no open CRITs or SIGs on the diff vs design spec

### Test (DoD Verification) Phase DoD

All six working-app behaviors verified with evidence:

1. **Session start**: `wicked-crew start --type feature --goal "add CSV export"` creates session in SQLite, emits `wicked.crew.session.started` to wicked-bus. Evidence: wicked-bus event log.

2. **Worker dispatch**: Daemon dispatches to worker CLI (real or mock-worker), captures output, records as evidence. Evidence: dispatch record in SQLite with exit_code=0 and non-empty parsed_output.

3. **Auto gate**: Gate auto-evaluates (auto gate kind), passes governance policies, advances phase. Evidence: phase record updated to Approved, `wicked.crew.phase.gate.approved` event in wicked-bus.

4. **Studio connectivity**: wicked-studio connects, live session visible within 5 seconds, WebSocket event received. Evidence: screenshot + WebSocket frame capture.

5. **Crash + resume**: Daemon killed via SIGKILL during InProgress phase. `wicked-crew resume --session <id>` restores to pre-crash phase state. Evidence: SQLite dump before kill vs after resume — all non-temporal fields (phase, state, phase_id, session_id, evidence references, blocking_items) are identical; timestamp fields (updated_at) are excluded from comparison.

6. **Status accuracy**: `wicked-crew status` output matches SQLite phase state at all times, including during worker execution. Evidence: side-by-side SQLite query vs status output comparison.

---

## 3. Success Criteria Verification Checklist

Each SC from REQ-001 §7 has a specific verification method:

| SC | Verification method | Evidence artifact |
|---|---|---|
| SC-001 | Run full feature workflow end-to-end; query wicked-bus for gate events | `wicked-bus status` output showing all gate events |
| SC-002 | SIGKILL daemon mid-phase; SQLite snapshot before/after resume comparison | SQLite dump before kill + after resume + diff |
| SC-003 | Automated test: 100 runs of gate eval with identical inputs; assert identical outputs | Vitest test result log |
| SC-004 | Automated test: council dispatch to ≥ 2 workers; assert council artifact `perspectives.length ≥ 2` | Vitest test result log |
| SC-005 | Automated test: fixture verdicts PASS/CONDITIONAL → gate advances; FAIL → gate blocked | Vitest test result log |
| SC-006 | Start daemon; open studio; measure time to first WebSocket event | Browser devtools timing screenshot |
| SC-007 | `time wicked-crew start --type feature --goal "x"` on macOS M1; assert < 3s | Shell timing output |
| SC-008 | Add entry to workers.json; wait ≤ 30s; dispatch to new worker; assert success | Dispatch record in SQLite |
| SC-009 | Run `wicked-crew gate --session <id> --phase <p> --action approve` in terminal; assert phase advances within 5s | `wicked-crew status` output + SQLite phase state |

---

## 4. wicked-studio DoD

wicked-studio is done when:

- [ ] Connects to wicked-crew daemon REST + WebSocket without configuration (auto-discovers on default port)
- [ ] Session list shows all active and recent sessions with accurate status
- [ ] Phase graph visualizes current phase state for a selected session
- [ ] HITL gate panel shows phase artifact + governance findings + approve/reject controls
- [ ] Human approval via studio advances the gate in wicked-crew (verified by phase state change)
- [ ] Event feed shows live wicked-bus events within < 500ms of emission
- [ ] Settings panel allows worker registry view (read-only in v1)
- [ ] Works on macOS (Chrome) and responds correctly to daemon being unavailable (shows disconnected state gracefully)

---

## 5. wicked-garden Scope Reduction DoD

wicked-garden's orchestration layer is removed when:

- [ ] `scripts/crew/phase_manager.py` and `scripts/crew/archetypes_v11.py` removed (or deprecated with a clear migration note)
- [ ] `commands/archetype/` commands removed (or marked as deprecated with pointer to wicked-crew)
- [ ] wicked-garden is usable standalone without wicked-crew (utilities still work independently)
- [ ] wicked-garden CI validation passes after removal
- [ ] No regression in core wicked-garden features: evidence gating, code-graph queries, multi-model review, memory, playbooks

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
