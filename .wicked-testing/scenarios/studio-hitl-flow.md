---
id: studio-hitl-flow
title: Studio gate notification + approval flow
maps_to: [SC-S02, SC-S03]
trust_level: local-dev
tags: [studio, hitl, gate, websocket, react]
status: active
---

## Goal

When a gate awaiting human decision event arrives via WebSocket, the studio shows a notification within 2 seconds. Clicking Approve calls the REST endpoint and the phase advances within 3 seconds.

## Preconditions

- Daemon running in-process. Session with design phase in `AwaitingHuman`.
- wicked-studio built and served at `http://localhost:4200`.
- Chrome browser accessible (Playwright).

## Steps

### SC-S02 — Gate notification timing

1. Open `http://localhost:4200` in Playwright (1280×800 viewport).
2. Inject `wicked.crew.gate.awaiting_human` WebSocket message for the session.
3. Record `t0` at injection time.
4. Wait for gate notification badge to appear in DOM (selector: `[data-testid="gate-notification"]`).
5. Record `t1` at badge appearance.

### SC-S03 — HITL approval advances phase

6. Click `[data-testid="gate-panel-approve"]` button.
7. Record `t2` at click.
8. Poll `GET /api/v1/sessions/:id` every 500ms until design phase `state = "Approved"` or 3s timeout.
9. Record `t3` at phase state change.

## Assertions

- A1 (SC-S02): `t1 - t0 < 2000` — notification visible within 2s of WebSocket message.
- A2 (SC-S03): `t3 - t2 < 3000` — phase advances within 3s of button click.
- A3: Next phase (test-strategy) `state = "InProgress"`.
- A4: No horizontal scroll at 1280px viewport.

## Evidence

- `gate-notification-timing.json` — `{ t0, t1, durationMs: t1 - t0 }`
- `approval-timing.json` — `{ t2, t3, durationMs: t3 - t2 }`
- `phase-after-approval.json` — API response
- `studio-1280px.png` — Playwright screenshot at 1280×800
