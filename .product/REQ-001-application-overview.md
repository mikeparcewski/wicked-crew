---
name: REQ-001-application-overview
title: wicked-crew — Application Overview
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# REQ-001 — Application Overview

## 1. Purpose

wicked-crew is a standalone external orchestrator — a daemon + CLI — for governed, multi-phase AI development workflows. It does not run inside a coding agent; it runs alongside or above them, treating AI CLIs (`claude --print`, `codex run`, etc.) as stateless worker subprocesses.

The core problem it solves: AI CLIs (Claude Code, Codex, Copilot, etc.) are excellent at individual tasks but have no shared phase lifecycle, no cross-session governance, no deterministic gate evaluation, and no external memory of what was decided. wicked-crew provides that layer without owning the work — the CLIs do the work; wicked-crew owns the structure.

---

## 2. What wicked-crew IS

- **An external daemon**: Runs as a persistent background process on the developer's machine. Not a plugin, not a library, not a hook.
- **A worker dispatcher**: Spawns AI CLIs as subprocesses with explicit prompts. Captures stdout. Parses structured or unstructured output.
- **A phase state machine owner**: Manages the clarify → design → test-strategy → build → test → ship phase graph. Transitions are deterministic. Only the governance engine advances a phase.
- **A governance engine host**: Evaluates gate policies deterministically (no LLM call on the gate path). Deny-dominates: any policy failing blocks the transition.
- **An evidence manager**: Records phase artifacts (prompts, outputs, verdicts) as structured evidence. Wires into wicked-testing/wicked-vault attestation.
- **A checkpoint store**: All phase state lives in SQLite. Crash the daemon; resume from exact phase state.
- **An API surface**: Exposes localhost REST + WebSocket for wicked-studio (the React control plane) and for any other local consumer.
- **A CLI**: `wicked-crew` command for terminal interaction (start session, check status, advance gate, resume).

---

## 3. What wicked-crew IS NOT

- Not a coding agent. It does not write code.
- Not a replacement for Claude Code, Codex, or any AI CLI. Those remain the workers.
- Not a cloud service. No accounts, no keys, no telemetry.
- Not a CI/CD pipeline (though it can trigger one as a phase action).
- Not a plugin for any CLI/IDE — it runs independently.
- Not a library that runs inside an agent context.

---

## 4. Core User Flows

### Flow 1 — Start a governed workflow session

1. Developer runs: `wicked-crew start --type feature --goal "add CSV export"`
2. wicked-crew creates a session in SQLite, emits `wicked.crew.session.started` to wicked-bus.
3. Phase enters **clarify** (Open → InProgress). wicked-crew dispatches a clarify prompt to the configured primary worker CLI.
4. Worker outputs acceptance criteria + RAID items in structured JSON. wicked-crew records as evidence.
5. Developer reviews in wicked-studio or terminal. Gate auto-evaluates: criteria present, no blocking RAID. Advances to design phase.

### Flow 2 — Autonomous dispatch loop

1. wicked-crew runs each phase by dispatching a prompt to the worker CLI:
   `claude --print "You are in the [phase] phase. Context: [session context]. Task: [phase brief]. Output: [schema]"`
2. Worker CLI runs, outputs to stdout, exits.
3. wicked-crew captures output, validates schema, records as phase evidence.
4. Governance evaluates gate. If pass: advance to next phase and repeat.
5. If fail: emit blockers to wicked-bus; if HITL gate, pause and surface to studio/terminal for human decision.

### Flow 3 — HITL gate (human in the loop)

1. A phase reaches a hard gate (design approval, ship approval).
2. wicked-crew pauses, emits `wicked.crew.gate.awaiting_human` to wicked-bus.
3. wicked-studio surfaces the gate prompt: phase artifact + governance findings + approve/reject/modify UI.
4. Developer approves (or modifies with conditions). wicked-studio calls the REST API.
5. wicked-crew records the human decision as evidence, governance re-evaluates, advances phase.

### Flow 4 — Resume after crash or pause

1. Developer runs: `wicked-crew resume --session <id>`
2. wicked-crew reads session from SQLite, replays wicked-bus events to reconstruct phase state.
3. Picks up at the exact phase and state where execution stopped.
4. Continues dispatching workers without re-running completed phases.

### Flow 5 — Multi-worker council

1. A phase is configured for council (multiple workers evaluate independently).
2. wicked-crew dispatches the same prompt to N worker CLIs in parallel (subprocess pool).
3. Collects all outputs. Runs synthesis to extract common conclusions and divergence.
4. Records the full council transcript as evidence. Governance uses the council result as input to the gate.

### Flow 6 — Terminal status check

1. Developer runs: `wicked-crew status` (or with `--session <id>`)
2. Output: current phase, state, gate status, open RAID items, last 5 events, any blockers.

### Flow 7 — wicked-testing gate integration

1. In the test phase, wicked-crew dispatches the wicked-testing acceptance pipeline as the worker action.
2. Collects the wicked-testing verdict JSON as evidence.
3. Governance evaluates: verdict must be PASS or CONDITIONAL (no FAIL) to advance.
4. Evidence stored with attestation for audit.

---

## 5. Products Wicked-crew Orchestrates

wicked-crew is ecosystem-aware. It knows how to dispatch to:

| Worker | Dispatch pattern | Output format |
|---|---|---|
| Claude Code (headless) | `claude --print "<prompt>"` | JSON or text (parsed) |
| Codex | `codex run "<prompt>"` (if available) | JSON or text |
| wicked-testing | `npx wicked-testing run <plan>` | verdict.json |
| wicked-garden | `npx wicked-garden <skill> --print` | structured output |
| Shell (arbitrary) | `bash -c "<cmd>"` | stdout capture |

Worker CLIs are registered in `~/.wicked-crew/workers.json`. Adding a new worker requires no code changes.

---

## 6. wicked-studio Relationship

wicked-studio is the React control plane UI for wicked-crew. It is NOT embedded in wicked-crew — it is a separate application that connects to the daemon's REST + WebSocket endpoints.

| wicked-crew provides | wicked-studio consumes |
|---|---|
| `GET /sessions` | Session list |
| `GET /sessions/:id` | Session detail + phase graph |
| `POST /sessions/:id/gates/:phase/approve` | HITL approval |
| `WS /events` | Live event stream for real-time updates |
| `GET /workers` | Worker registry |
| `GET /api/v1/config` | Daemon config |

wicked-studio can be running or not — wicked-crew operates fully headless without it.

---

## 7. Success Criteria

- **SC-001**: A feature workflow completes all phases (clarify → ship) fully autonomously with zero human intervention when all gates pass. Measurable: wicked-bus contains `wicked.crew.phase.gate.approved` for each phase in sequence.
- **SC-002**: A crashed session resumes to the exact pre-crash phase state. Measurable: phase state after resume == phase state before SIGKILL (verified by SQLite snapshot comparison).
- **SC-003**: Gate evaluation is deterministic. Same inputs → same result, 100/100 runs. (Automated regression test.)
- **SC-004**: Multi-worker council produces synthesis from ≥ 2 worker outputs. Measurable: council artifact contains `perspectives` array with count ≥ 2.
- **SC-005**: wicked-testing gate integration: test-phase gate advances only when verdict.json is PASS or CONDITIONAL. FAIL verdict blocks the gate. (Acceptance test with fixture verdicts.)
- **SC-006**: wicked-studio connects to daemon and shows live session state within 5 seconds of daemon start. Measurable: WebSocket event received within 5s of connection.
- **SC-007**: `wicked-crew start` to first worker dispatch takes < 3 seconds on macOS M1.
- **SC-008**: New worker CLI added to workers.json is detected and available for dispatch without daemon restart, within 30 seconds (default workers.json polling interval).
- **SC-009**: HITL gate approval from terminal (via `@inquirer/prompts`) advances the phase gate, measurable as: phase state changes from AwaitingHuman to Approved in SQLite within 5 seconds of terminal confirm.

---

## 8. Non-Functional Requirements

### Performance
- Worker dispatch (subprocess spawn to output capture): < 30 seconds timeout, configurable.
- Gate evaluation: < 200ms for any policy set ≤ 20 rules.
- Session resume: < 5 seconds for sessions with ≤ 100 lifecycle events.
- WebSocket event latency: < 100ms from event write to client delivery.

### Reliability
- All phase state is SQLite-backed. No in-memory-only state.
- Worker subprocess failure does not crash the daemon. Recorded as evidence + error event.
- wicked-bus at-least-once delivery guarantees event durability under daemon crash.
- Session resumes are idempotent (re-running resume on an already-running session is a no-op).

### Security
- No secrets in session config or worker dispatch prompts. Secrets referenced via env var names only.
- REST API binds to 127.0.0.1 only. No external exposure by default.
- No telemetry, no cloud calls, no opt-in analytics.

### Observability
- Structured JSON logging (NDJSON) at configurable log level.
- All lifecycle events flow through wicked-bus with session_id, phase, state, timestamp.
- `wicked-crew status` always shows accurate phase + gate state from SQLite (not in-memory).

### Maintainability
- New workflow type: add a YAML file to `~/.wicked-crew/workflows/`. No code change.
- New gate policy: add a JSON file to `~/.wicked-crew/policies/`. No code change.
- Workers defined in JSON config. No code change to add a new worker CLI.

---

## 9. Phase Relevance

| Phase | Relevance |
|---|---|
| Define (this doc) | Scope, user flows, success criteria |
| Design | Architecture of daemon, REST API, phase FSM, SQLite schema |
| Test strategy | SC-001..SC-009 are the primary acceptance gates |
| Build | Each worker integration, phase FSM, governance, REST API, WebSocket |
| Test | Verify SC-001..SC-009 with evidence |
| Review | Adversarial review against this document for divergence |

---

## 10. Open Questions

| ID | Question | Status |
|---|---|---|
| OQ-001 | Does the daemon run as a system service (launchd/systemd) or as a foreground process? | Open — affects install experience |
| OQ-002 | Should `wicked-crew start` block (like `npm run dev`) or detach (daemon mode)? | Open — lean toward both modes |
| OQ-003 | What is the exact output schema the worker CLIs must emit? | Design phase — define protocol |
| OQ-004 | Does wicked-crew manage `claude --print` session context (pass prior phase artifacts as context)? | Yes, but design to be determined |
| OQ-005 | Multi-worker: parallel execution or sequential with comparison? | Both should be configurable |
