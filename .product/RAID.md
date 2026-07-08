---
name: RAID
title: wicked-crew — RAID Register
status: active
date: 2026-07-07
author: michael.parcewski@accenture.com
---

# RAID Register

## Risks

| ID | Title | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| RISK-001 | Worker CLI output is unpredictable | High | High | Define structured output schema; implement extraction pass for unstructured text; never fail the daemon on parse errors — record raw output as evidence | Open |
| RISK-002 | XState v5 snapshot serialization breaks on large context snapshots | Medium | High | Cap context snapshot size in state machine (design phase); integration test with realistic session context sizes | Open |
| RISK-003 | wicked-crew daemon port conflict (default port already in use) | Medium | Medium | Auto-detect next available port; surface as startup warning; configure in config.json | Open |
| RISK-004 | Worker CLIs change their headless invocation flags between versions | Medium | Medium | Worker definitions in workers.json include version_probe; log version at dispatch time; design phase includes CLI version detection | Open |
| RISK-005 | wicked-studio WebSocket connection drops and fails silently | Medium | Low | Implement auto-reconnect with exponential backoff; show disconnected state badge in UI | Open |
| RISK-006 | SQLite WAL file corruption under simultaneous daemon + studio writes | Low | High | Daemon is single-writer; studio is read-only against SQLite (reads via REST API); enforce at architecture level in design phase | Open |
| RISK-007 | claude --print headless mode changes or is removed by Anthropic | Low | High | Detect via version probe; workers.json is configurable; research alternatives at design phase | Open |

---

## Assumptions

| ID | Assumption | Validation method | Status |
|---|---|---|---|
| ASSM-001 | `claude --print "<prompt>"` is a stable headless invocation pattern | Validate at design phase: test with current claude CLI version | Open |
| ASSM-002 | Worker CLIs write complete responses to stdout before exiting | Validate at design phase: test with claude and codex CLI | Open |
| ASSM-003 | wicked-bus SQLite WAL mode supports concurrent daemon reads | Validated: wicked-bus already uses WAL; existing production use confirms | Resolved |
| ASSM-004 | XState v5 snapshot format is stable across minor versions | Validate at design phase: review XState v5 migration guide; pin major version | Open |
| ASSM-005 | Workers do not need to be aware they are being orchestrated by wicked-crew | Core architectural assumption; validated by design: workers receive plain prompts, no wicked-crew context required | Resolved |
| ASSM-006 | npm global install (`npm install -g wicked-crew`) is the primary install path | Will be validated by wicked-installer registry update | Open |
| ASSM-007 | wicked-studio runs on the same machine as the daemon (localhost-only) | Core design constraint; no auth needed for localhost; document clearly | Resolved |

---

## Issues

| ID | Title | Severity | Owner | Resolution | Status |
|---|---|---|---|---|---|
| ISS-001 | Worker protocol is undefined — no formal spec for stdin/stdout format | High | Define phase | Resolved: WORKER-PROTOCOL.md defines stdin/stdout format, JSON schema, council mode votes, unstructured fallback, timeout handling, phase artifact schemas | Resolved |
| ISS-002 | wicked-garden daemon (Flask/Python) and wicked-crew daemon (Fastify/TS) risk port conflict on default ports | Medium | Design phase | Assign non-overlapping default ports: wicked-garden=7700, wicked-crew=7701, wicked-studio=4200 | Proposed |
| ISS-003 | agentic_cli_registry.py is Python — needs to be translated to TypeScript or JSON for wicked-crew | Medium | Design phase | Design the workers.json schema based on the Python dataclass; ship default workers.json with claude/codex/wicked-testing entries | Open |
| ISS-004 | wicked-garden scope reduction is a separate workstream — risk of conflicting with wicked-crew's use of garden features | Low | Product | Coordinate: wicked-crew does not depend on wicked-garden internals; only uses garden as a worker CLI | Resolved |

---

## Decisions

| ID | Decision | Rationale | Alternatives rejected | Date |
|---|---|---|---|---|
| DEC-001 | TypeScript/Node.js for wicked-crew daemon (not Rust) | Ecosystem consistency with wicked-bus, wicked-garden, wicked-installer; faster iteration; execa for subprocess management already used; can rewrite hot paths in Rust later | Rust (slower initial build); Python (inconsistent with npm publish model) | 2026-07-07 |
| DEC-002 | XState v5 for phase state machine | Serializable actor snapshots solve checkpoint/resume for free; deterministic transitions; well-tested MIT library | Hand-rolled FSM (more code, more bugs); Temporal (too heavy, requires server cluster); Prefect (Python, cloud-first) | 2026-07-07 |
| DEC-003 | json-rules-engine for gate policy evaluation | Deterministic JSON rule evaluation; no LLM on gate path; policy files are pure JSON — no code change to add policy; MIT | OPA (too heavy, Rego DSL complexity); hand-rolled evaluator (more code, more bugs) | 2026-07-07 |
| DEC-004 | wicked-studio as standalone React app (not embedded in wicked-crew npm package) | Separation of concerns; studio can be updated independently; daemon is usable headless without studio | Embed studio in daemon (couples release cycles); Tauri (requires Rust + native build per platform) | 2026-07-07 |
| DEC-005 | Workers defined in JSON config (~/.wicked-crew/workers.json) with no code change for new workers | Extensibility without rebuild; CLI authors can add themselves; follows wicked-installer registry pattern | Hardcoded workers (inflexible); Plugin system (over-engineered for v1) | 2026-07-07 |
| DEC-006 | Daemon is single-writer to SQLite; wicked-studio reads via REST API only | Prevents concurrent SQLite write contention; WAL still needed for daemon-read races; studio never touches SQLite directly | Shared SQLite write access (contention risk) | 2026-07-07 |
| DEC-007 | Council synthesis is deterministic (arithmetic agreement scoring, no LLM) | Preserves "no LLM on gate path" hard constraint; workers answer structured votes in JSON; synthesis is fraction of workers with same answer per dimension | LLM synthesis call (violates constraint); embedding similarity (requires embedder, heavy) | 2026-07-07 |
| DEC-008 | "Modify with conditions" HITL action advances gate with conditions stored as RAID assumption | Preserves workflow momentum without dropping context; conditions appear in next phase brief | Block phase until conditions resolved (too conservative); ignore conditions (loses context) | 2026-07-07 |
