---
name: OSS-LANDSCAPE
title: OSS Landscape Survey — wicked-crew
status: complete
date: 2026-07-07
author: research-agent
phase: define
---

# OSS Landscape Survey

Conducted during the Define phase to identify reuse opportunities and avoid building what already exists.

---

## Finding 1: No OSS external AI-CLI orchestrator exists

**Survey**: AutoGen, CrewAI, LangGraph Server, OpenHands (OpenDevin), Goose (Block), Plandex, DSPy reviewed.

**Finding**: Every major AI agent framework is a library you run *inside* an agent process, not an external daemon that spawns CLIs as subprocesses. The closest is **OpenHands** (REST API + agent-as-subprocess model), but it's a single-agent environment controller, not a phase-gated multi-CLI orchestrator.

**Conclusion**: Build custom. The external orchestration model with worker CLIs as black-box subprocesses is a novel architecture with no direct OSS precedent.

---

## Finding 2: CLI detection + headless invocation — DON'T BUILD

**Finding**: `wicked-garden/scripts/jam/agentic_cli_registry.py` already has production-ready headless invocation templates for 20+ CLIs (claude, codex, gemini, copilot, opencode, aider, goose, amp, and more). Binary detection via `shutil.which`, trust flags, version-string collision disambiguation, and per-CLI input mode classification are all implemented.

**Recommendation**: Extract `agentic_cli_registry.py` logic as the data contract for wicked-crew's `workers.json` format. Translate the Python dataclass structure to a TypeScript `WorkerDefinition` type. The headless invocation templates become the default worker configs shipped with wicked-crew.

**Do not**: reimplement CLI detection from scratch.

---

## Finding 3: Phase FSM — use XState v5

**Finding**: XState v5 provides serializable actor state machines via `createActor()` with persist/restore. This gives us phase FSM checkpoint/resume for free — snapshot the actor state to SQLite, restore from snapshot on daemon restart.

**Recommendation**: Use `xstate` v5 for the phase state machine. Do NOT build a hand-rolled FSM.

**Key capability**: `actor.getSnapshot()` → `JSON.stringify()` → SQLite → `createActor(machine, { snapshot: stored })` on resume. This is exactly the checkpoint/resume semantics required by SC-002.

---

## Finding 4: Gate policy evaluation — use json-rules-engine

**Finding**: `json-rules-engine` (npm) evaluates structured JSON rule conditions deterministically. Supports AND/OR operators, comparison operators, nested conditions. No LLM on evaluation path. Policy files are JSON — no code change needed to add a new policy.

**Recommendation**: Use `json-rules-engine` for governance gate evaluation. Do NOT write a custom rule evaluator.

**Pattern**:
```json
{
  "conditions": {
    "all": [
      { "fact": "evidence_kinds", "operator": "contains", "value": "worker-output" },
      { "fact": "blocking_raid_count", "operator": "equal", "value": 0 }
    ]
  },
  "event": { "type": "gate-approved" }
}
```

---

## Finding 5: React UI — ShadCN/UI + TanStack Query

**Finding**: ShadCN/UI (Radix primitives + Tailwind, MIT, copy-paste components) is the 2025 standard for React admin dashboards without framework lock-in. TanStack Query handles REST data fetching + cache invalidation on WebSocket events.

**Recommendation**: Use ShadCN/UI for the component vocabulary. TanStack Query for REST. Native `WebSocket` for event stream. Do NOT use Refine, AdminJS, or Tooljet.

**Optional evaluation**: Refine (refine.dev) if the HITL audit log visualization needs 3-5 days saved on table scaffolding — evaluate in design phase.

---

## Finding 6: wicked-garden daemon pattern — reference architecture

**Finding**: `wicked-garden/daemon/` is a complete Python/Flask daemon with event consumer, hook dispatcher, state projector, and HTTP server — running on 127.0.0.1:7700. This is the architectural reference for wicked-crew's daemon.

**Recommendation**: Use the wicked-garden daemon architecture as the reference. wicked-crew is a TypeScript re-implementation of the same pattern with:
- Fastify instead of Flask
- XState v5 for the FSM (not in the garden daemon)
- json-rules-engine for governance (not in the garden daemon)
- WebSocket instead of HTTP polling

The wicked-garden daemon will be simplified (remove orchestration concerns) as part of wicked-garden scope reduction.

---

## Summary: Don't Build List

| Component | Reuse |
|---|---|
| CLI detection + headless invocation | Translate `agentic_cli_registry.py` to TypeScript types + `workers.json` defaults |
| Phase FSM | XState v5 serializable actors |
| Gate policy evaluation | json-rules-engine |
| React UI components | ShadCN/UI + Radix + Tailwind |
| REST data fetching | TanStack Query |
| Event bus | wicked-bus (existing) |
| Subprocess management | execa (existing in ecosystem) |
| SQLite | better-sqlite3 (existing in ecosystem) |
