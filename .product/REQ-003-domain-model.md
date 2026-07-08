---
name: REQ-003-domain-model
title: wicked-crew — Domain Model
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# REQ-003 — Domain Model

## 1. Core Entities

### 1.1 Session

A Session is the top-level unit of work in wicked-crew. One session = one governed workflow execution.

```
Session {
  id: string (UUID)
  type: WorkflowType          // "feature" | "fix" | "migrate" | "research" | custom
  goal: string                // Free-text intent statement
  created_at: ISO8601
  updated_at: ISO8601
  status: SessionStatus       // active | paused | completed | failed | abandoned
  current_phase: PhaseId
  source: string              // "terminal" | "studio" | "api" | "signals:<id>"
  config: SessionConfig       // worker selection, council size, timeout overrides
}
```

Sessions are stored in SQLite. A session's complete phase history is reconstructible from wicked-bus events alone (the SQLite session record is a fast-path cache).

### 1.2 Phase

A Phase is a discrete step in a workflow. Phases are defined in the workflow type YAML. Each phase has its own state machine.

```
Phase {
  id: PhaseId                 // "clarify" | "design" | "test-strategy" | "build" | "test" | "ship"
  session_id: string
  state: PhaseState           // Open | InProgress | AwaitingWorker | AwaitingHuman | ReadyForGate | GateRunning | Approved | Rejected
  started_at: ISO8601
  completed_at: ISO8601 | null
  gate_kind: GateKind         // auto | human | council
  evidence: EvidenceRef[]     // pointers to evidence records
  blocking_items: RaidItem[]  // RAID items that block this gate
}
```

Phase state machine:
```
Open → InProgress → AwaitingWorker → (worker completes) → ReadyForGate
                 ↓                                              ↓
           AwaitingHuman (hard gates)              GateRunning → Approved
                 ↓                                              ↓
         human_approve()                                   Rejected → InProgress (retry)
```

### 1.3 Worker

A Worker is a registered AI CLI or tool that wicked-crew can dispatch tasks to.

```
Worker {
  id: string                  // "claude" | "codex" | "wicked-testing" | "shell" | custom
  command: string[]           // argv prefix: ["claude", "--print"]
  output_format: "json" | "text" | "structured-text"
  timeout_seconds: number
  env: Record<string, string> // additional env vars
  capabilities: string[]      // ["clarify", "design", "code", "test"]
}
```

Workers are defined in `~/.wicked-crew/workers.json`. No code change required to register a new worker.

### 1.4 Dispatch

A Dispatch is a single task sent from wicked-crew to a worker subprocess.

```
Dispatch {
  id: string (UUID)
  session_id: string
  phase_id: PhaseId
  worker_id: string
  prompt: string              // full prompt sent to the worker
  context_snapshot: string    // JSON of prior phase artifacts included in the prompt
  started_at: ISO8601
  completed_at: ISO8601 | null
  exit_code: number | null
  output: string              // raw stdout from worker
  parsed_output: unknown      // result of output parsing
  status: "pending" | "running" | "success" | "timeout" | "error"
}
```

### 1.5 Evidence

Evidence is a recorded artifact from a phase dispatch, governance decision, or human action.

```
Evidence {
  id: string
  session_id: string
  phase_id: PhaseId
  kind: EvidenceKind          // "worker-output" | "gate-decision" | "human-approval" | "test-verdict"
  content: unknown            // typed per kind
  recorded_at: ISO8601
  actor: string               // worker_id, "human", "governance"
  attestation: Attestation | null  // wicked-testing attestation chain (optional)
}
```

### 1.6 Gate

A Gate is a governance evaluation at a phase boundary.

```
Gate {
  id: string
  session_id: string
  phase_id: PhaseId
  kind: GateKind              // auto | human | council
  evaluated_at: ISO8601
  result: "approved" | "rejected" | "approved-with-conditions"
  policies_evaluated: PolicyResult[]
  blocking_policies: string[] // policy IDs that failed
  human_override: HumanDecision | null
}

HumanDecision {
  actor: string               // "human"
  action: "approve" | "reject" | "approve-with-conditions"
  conditions: string | null   // non-null when action = "approve-with-conditions"
  recorded_at: ISO8601
}
```

Gate evaluation is deny-dominates: if any policy fails, the gate is rejected, regardless of other policies.

When `action = "approve-with-conditions"`, the gate result is `"approved-with-conditions"`. The conditions string is stored as a RAID assumption (`kind: "assumption"`) attached to the next phase's InProgress context. The phase advances (not blocked), but the conditions are surfaced in the next phase brief.

### 1.7 RAID Item

RAID items are Risks, Assumptions, Issues, and Decisions tracked per session.

```
RaidItem {
  id: string
  session_id: string
  kind: "risk" | "assumption" | "issue" | "decision"
  title: string
  description: string
  status: "open" | "resolved" | "accepted"
  blocks_phase: PhaseId | null  // if set, blocks gate for this phase
  created_at: ISO8601
  resolved_at: ISO8601 | null
}
```

### 1.8 WorkflowType

A WorkflowType defines the phase sequence and gate rules for a category of work.

```
WorkflowType {
  id: string                  // "feature" | "fix" | "migrate" | custom
  phases: PhaseDefinition[]
  default_workers: Record<PhaseId, string[]>  // worker IDs per phase
}

PhaseDefinition {
  id: PhaseId
  name: string
  gate_kind: GateKind
  required_evidence: EvidenceKind[]  // evidence required before gate
  policies: string[]                  // policy file IDs to evaluate at gate
  next_phase: PhaseId | null
}
```

Built-in workflow types:
- `feature`: clarify → design → test-strategy → build → test → ship
- `fix`: triage → implement → verify → ship
- `research`: frame → investigate → synthesize → report
- `migrate`: plan → expand → backfill → cutover → verify

Custom workflow types defined in `~/.wicked-crew/workflows/*.yaml`.

---

## 2. Events (wicked-bus catalog)

All events flow through wicked-bus. Domain: `wicked-crew`.

| Event type | When emitted |
|---|---|
| `wicked.crew.session.started` | New session created |
| `wicked.crew.session.completed` | Session reached terminal state (all phases approved) |
| `wicked.crew.session.failed` | Session reached terminal failure state |
| `wicked.crew.session.paused` | Session paused by user or policy |
| `wicked.crew.phase.started` | Phase entered InProgress |
| `wicked.crew.phase.gate.evaluating` | Gate evaluation started |
| `wicked.crew.phase.gate.approved` | Gate passed, phase advancing |
| `wicked.crew.phase.gate.rejected` | Gate failed, phase blocked |
| `wicked.crew.gate.awaiting_human` | Hard gate waiting for human decision |
| `wicked.crew.gate.human_approved` | Human approved a hard gate |
| `wicked.crew.dispatch.started` | Worker subprocess spawned |
| `wicked.crew.dispatch.completed` | Worker subprocess completed successfully |
| `wicked.crew.dispatch.failed` | Worker subprocess failed or timed out |
| `wicked.crew.council.started` | Multi-worker council dispatched |
| `wicked.crew.council.completed` | All council workers returned, synthesis ready |

Event payload always includes: `session_id`, `phase`, `timestamp`, `actor`, plus event-specific fields.

---

## 3. REST API surface (summary)

Full spec deferred to design phase. Summary of required endpoints:

```
POST   /api/v1/sessions                    Create session
GET    /api/v1/sessions                    List sessions
GET    /api/v1/sessions/:id                Session detail + phase graph
PATCH  /api/v1/sessions/:id               Update session (pause, abandon)
GET    /api/v1/sessions/:id/phases         Phase list for session
GET    /api/v1/sessions/:id/evidence       Evidence list
POST   /api/v1/sessions/:id/gates/:phase/approve                  Human gate approval
POST   /api/v1/sessions/:id/gates/:phase/approve-with-conditions  Human approval with conditions (conditions stored as RAID assumption)
POST   /api/v1/sessions/:id/gates/:phase/reject                   Human gate rejection
GET    /api/v1/workers                     Worker registry
GET    /api/v1/config                      Daemon config (read-only)
WS     /api/v1/events                     Event stream (wicked-bus cursor poll → WebSocket bridge)
```

---

## 4. Governance Model

The governance engine evaluates gate policies deterministically. Policies are JSON files in `~/.wicked-crew/policies/`. No LLM calls.

Built-in policy types:

| Policy type | Evaluates |
|---|---|
| `evidence-required` | Phase evidence includes all required kinds |
| `no-blocking-raid` | No open RAID items with `blocks_phase = current_phase` |
| `worker-exit-success` | All dispatches in this phase exited with code 0 |
| `test-verdict-pass` | Evidence includes a wicked-testing verdict with status PASS or CONDITIONAL |
| `human-approval-required` | Gate kind is "human" — auto-reject until human_override provided |
| `council-consensus` | Council synthesis score ≥ configured threshold (score = mean fraction-agreement across all vote dimensions; purely arithmetic, no LLM on evaluation path — see WORKER-PROTOCOL.md §3) |

Governance is purely functional: `evaluate(policies[], evidence[], phase_state) → {result, blocking_policies[]}`.

---

## 5. Context Injection Model

Each worker dispatch includes a context snapshot of prior phase artifacts. The context grows across phases:

```
Phase 1 (clarify):   context = {goal, session_config}
Phase 2 (design):    context = {goal, clarify_artifact, session_config}
Phase 3 (test):      context = {goal, clarify_artifact, design_artifact, session_config}
...
```

Context is truncated if it exceeds the worker's inferred context window (estimated conservatively at 8K tokens). Truncation strategy: keep most recent phases at full fidelity, summarize older phases.

The prompt template is defined in the workflow type YAML. Variables: `{goal}`, `{phase}`, `{context}`, `{output_schema}`.

---

## 6. wicked-garden / wicked-testing Integration Points

wicked-crew is ecosystem-aware but not ecosystem-dependent. It can operate with only a shell worker. When the wicked-* packages are installed:

| Integration | How wicked-crew uses it |
|---|---|
| wicked-bus | Event backbone. All crew events emitted here. |
| wicked-testing | Worker CLI for the test phase. Verdict JSON = gate evidence. |
| wicked-garden | Worker CLI for clarify, design, review phases (optional). |
| wicked-estate | Not a direct dependency. Workers may call it; wicked-crew doesn't. |

---

## 7. wicked-studio Domain

wicked-studio is a separate application. Its domain model is a projection of wicked-crew's domain over HTTP/WebSocket:

- **SessionCard**: Summary view of a session (id, type, goal, current phase, status, last event time)
- **PhaseGraph**: Visual phase state machine for a session
- **EvidencePanel**: Browsable list of phase evidence artifacts
- **GatePanel**: HITL approval surface (displays phase artifact + governance findings + approve/reject/modify controls)
- **WorkerPanel**: Registered worker list, health status
- **EventFeed**: Live wicked-bus event stream

wicked-studio state management: React Query for REST data; Zustand store for UI state; WebSocket listener for live events (invalidates React Query cache on relevant events).
