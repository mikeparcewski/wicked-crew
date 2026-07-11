<!-- Ported 2026-07-11 from the archived wicked-studio repo (branch site/marketing-studio, commits a8e3953/9e722d3, never pushed). Studio now ships as wicked-crew/packages/studio. May overlap crew's DES-STUDIO-{001,COCKPIT-001,SERVING-001} — reconcile. -->

---
name: REQ-001-studio-overview
title: wicked-studio v2 — Application Overview
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# wicked-studio v2 — Application Overview

## 1. What's Changing

wicked-studio v1 is a Rust/eframe desktop GUI. v2 is a **React web app** running on localhost. The v1 HITL state machine (PendingResponse → Submitted → Acknowledged) is retained conceptually but implemented as a React component connected to the wicked-crew REST/WebSocket API rather than a Rust struct.

v1 is deprecated when v2 is shipped. No migration of v1 data is required.

---

## 2. What wicked-studio v2 IS

A React web app that runs on localhost and serves as the **control plane UI** for wicked-crew. It connects to the wicked-crew daemon via REST + WebSocket. It is the human operator's window into autonomous sessions.

Primary jobs:
1. **HITL gate surface**: When wicked-crew pauses at a hard gate, show the phase artifact, governance findings, and approve/reject/modify controls.
2. **Session monitoring**: Live view of all sessions — phase state, current phase, last event, status badges.
3. **Evidence browser**: Browse phase artifacts and evidence for any session.
4. **Configuration management**: Worker registry, workflow type definitions, daemon config.

---

## 3. What wicked-studio IS NOT

- Not an AI coding agent. It does not write code.
- Not required for wicked-crew to operate (daemon is fully headless).
- Not a cloud app. Localhost only. No authentication required (same-machine trust model).
- Not a project management tool. It shows crew session state, not GitHub Issues or Jira.

---

## 4. User Flows

### Flow 1 — HITL gate approval

1. wicked-crew pauses at a hard gate (design review, ship approval).
2. wicked-studio receives `wicked.crew.gate.awaiting_human` via WebSocket.
3. Gate notification appears (toast + sidebar badge).
4. User clicks the gate panel. Studio fetches: phase artifact text, governance findings (which policies passed, which failed, which are still pending), session context.
5. User reads the artifact, makes a decision: Approve / Reject / Modify with conditions.
6. User submits. Studio calls the appropriate endpoint:
   - Approve → `POST /api/v1/sessions/:id/gates/:phase/approve`
   - Reject → `POST /api/v1/sessions/:id/gates/:phase/reject`
   - Modify with conditions → `POST /api/v1/sessions/:id/gates/:phase/approve-with-conditions` (body: `{ "conditions": "..." }`)
7. wicked-crew advances the phase (or records rejection). Studio shows updated phase graph within 1 second.

### Flow 2 — Session overview

1. User opens wicked-studio. Session list loads: all active and last 10 completed sessions.
2. Each session card shows: goal, type, current phase, status badge (running / paused / completed / failed), last event time.
3. User clicks a session. Detail view opens: phase graph (visual FSM), phase evidence list, event feed.

### Flow 3 — Phase evidence browser

1. From session detail view, user clicks a phase.
2. Phase panel shows: all evidence records for this phase (worker output, gate decision, human approval).
3. Each evidence record expandable: full raw content viewable.
4. Evidence artifacts can be copied to clipboard.

### Flow 4 — Worker registry view

1. User navigates to Settings → Workers.
2. Shows registered worker CLIs: name, command, capabilities, detected version (or "not found").
3. v1 is read-only. Workers are managed via `~/.wicked-crew/workers.json` directly.

### Flow 5 — Live event feed

1. Event feed panel (sidebar or dedicated view) shows live wicked-bus events from the daemon's WebSocket.
2. Events are filtered to `wicked.crew.*` by default. Filter controls available.
3. Events show: type, session_id, phase, timestamp, payload preview.

---

## 5. UI Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  wicked-studio                              ● connected  [menu] │
├──────────────┬──────────────────────────────────────────────────┤
│  Sessions    │  Session Detail                                  │
│              │                                                  │
│  ● active (3)│  [goal text]                    feature | active │
│  ○ paused (1)│                                                  │
│  ✓ done (8)  │  Phase Graph:                                    │
│              │  [clarify] ✓ → [design] ✓ → [test] ● → [build]  │
│  ─────────── │                                                  │
│  ⚡ Gates (1) │  Current: test-strategy (InProgress)            │
│              │  Worker: claude (dispatch #3, running)            │
│  ─────────── │                                                  │
│  📋 Events   │  Evidence: [clarify/worker-output] [design/gate] │
│              │                                                  │
│  ⚙ Settings  │  HITL GATE PENDING ──────────────────────────── │
│              │  design phase — human approval required          │
│              │  [View artifact]  [Approve]  [Reject]  [Modify with conditions] │
└──────────────┴──────────────────────────────────────────────────┘
```

---

## 6. Success Criteria

- **SC-S01**: Studio connects to daemon within 5 seconds of page load on localhost. Shows "connected" badge. Measurable: WebSocket connection established, first heartbeat event received within 5s.
- **SC-S02**: Gate notification appears within 2 seconds of `wicked.crew.gate.awaiting_human` WebSocket message receipt. Measurable: browser `performance.mark()` on WebSocket message receipt vs notification DOM appearance, captured via browser devtools performance panel.
- **SC-S03**: Human approval via studio advances the phase in wicked-crew. Measurable: phase state changes from AwaitingHuman to Approved in SQLite within 3s of approve button click (verified by polling `GET /api/v1/sessions/:id` after button click).
- **SC-S04**: Session list refreshes within 500ms of `wicked.crew.session.*` WebSocket event receipt, without page reload.
- **SC-S05**: Studio shows "disconnected" state gracefully when daemon is unavailable (no error crash, no blank screen).
- **SC-S06**: Works in Chrome on macOS. Responsive down to 1280px wide.

---

## 7. Technology

- React 18 + Vite
- TypeScript (strict mode)
- Tailwind CSS + ShadCN/UI (Radix primitives)
- TanStack Query v5 (REST data fetching + cache invalidation)
- Zustand (UI state: selected session, panel visibility, filter state)
- Native `WebSocket` (no library) for event stream
- `lucide-react` for icons
- Recharts for phase timeline visualization

Served as static files. wicked-crew daemon can serve studio static files directly (`wicked-crew serve --ui`) or studio can be launched separately (`wicked-studio` binary = `npx serve dist`).

---

## 8. Non-Functional Requirements

- No analytics, no telemetry, no cloud calls.
- Daemon unavailable: studio shows disconnected state, auto-reconnects on interval.
- Evidence records can contain large text (worker output). Rendered with virtual scrolling or truncation + expand.
- WebSocket event stream: buffer last 500 events in memory, scroll to show recent.

---

## 9. Relationship to wicked-crew

| wicked-crew provides | wicked-studio uses |
|---|---|
| `GET /api/v1/sessions` | Session list |
| `GET /api/v1/sessions/:id` | Session detail |
| `POST /api/v1/sessions/:id/gates/:phase/approve` | HITL approval |
| `POST /api/v1/sessions/:id/gates/:phase/reject` | HITL rejection |
| `GET /api/v1/sessions/:id/evidence` | Evidence browser |
| `GET /api/v1/workers` | Worker registry view |
| `WS /api/v1/events` | Live event stream |

wicked-studio never writes to SQLite directly. All mutations go through the wicked-crew REST API.

---

## 10. DoD for wicked-studio v2

- SC-S01..SC-S06 verified against running software
- HITL approval flow works end-to-end (studio → API → daemon → phase advance)
- Disconnection/reconnection works without page reload
- All SC verified with recorded evidence (screenshots + browser devtools)
- wicked-testing acceptance pipeline PASS verdict
