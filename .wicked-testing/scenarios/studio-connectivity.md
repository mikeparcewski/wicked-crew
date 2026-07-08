---
id: studio-connectivity
title: Studio WebSocket connect within 5s + disconnected state graceful
maps_to: [SC-S01, SC-S05]
trust_level: local-dev
tags: [studio, websocket, connectivity, error-state, react]
status: active
---

## Goal

wicked-studio connects to the daemon WebSocket within 5 seconds of mounting (SC-S01). When the daemon is unavailable, the studio shows a graceful disconnected state — no crash, no blank screen, no unhandled React error boundary (SC-S05).

## Preconditions

- Daemon running in-process (for SC-S01). No daemon running (for SC-S05, mock WebSocket that immediately closes).

## Steps

### SC-S01 — Connect within 5s

1. Render `App` component. Record `t0 = Date.now()`.
2. Wait for `ConnectionStatus` to show "connected" state (data-testid: `connection-status`, text or aria-label: "connected").
3. Record `t1 = Date.now()`.

### SC-S05 — Disconnected state graceful

4. Mount `App` with a mock WebSocket that immediately fires `close` event.
5. Attach `console.error` spy in `beforeEach`.
6. Assert `ConnectionStatus` shows "disconnected" (not blank, not thrown error).
7. Assert session list shows empty state or reconnecting indicator.
8. Assert `console.error` was NOT called with a string containing "React".

## Assertions

- A1 (SC-S01): `t1 - t0 < 5000` — connected within 5s.
- A2 (SC-S01): WebSocket `readyState === WebSocket.OPEN` (or mock equivalent).
- A3 (SC-S05): `ConnectionStatus` renders with state "disconnected" — element is present in DOM.
- A4 (SC-S05): No React error boundary triggered (`console.error` spy: no calls containing "React").
- A5 (SC-S05): Session list area is visible and shows either empty state or reconnecting indicator (not empty/blank DOM).

## Evidence

- `connect-timing.json` — `{ t0, t1, durationMs: t1 - t0 }`
- `disconnected-ui.png` — screenshot of disconnected state
- `console-error-log.json` — spy call log (must be empty or contain non-React entries only)
