---
id: terminal-hitl-gate
title: CLI gate approval — wicked-crew gate command advances phase within 5s
maps_to: [SC-009]
trust_level: local-dev
tags: [crew, cli, hitl, gate, terminal]
status: active
---

## Goal

`wicked-crew gate --session <id> --phase design --action approve` exits 0 and the design phase advances to Approved within 5 seconds. No studio UI required.

## Preconditions

- Daemon running in-process. Session exists with design phase in `AwaitingHuman` state.
- `mock-worker` handled clarify phase (auto gate, already approved).

## Steps

1. Start daemon in-process. Create session with human gate at design phase.
2. Wait for design phase `state = "AwaitingHuman"` (poll 1s, 10s timeout).
3. Record `t0 = Date.now()`.
4. Spawn subprocess: `wicked-crew gate --session <id> --phase design --action approve`.
5. Wait for subprocess to exit. Record exit code and `t1 = Date.now()`.
6. Poll `GET /api/v1/sessions/:id/phases` until design `state = "Approved"` or 5s timeout. Record `t2`.

## Assertions

- A1: subprocess exit code === 0.
- A2: `t1 - t0 < 5000` (CLI exits within 5s).
- A3: Design phase `state = "Approved"` within 5s of subprocess exit (`t2 - t1 < 5000`).
- A4: Next phase (test-strategy) `state = "InProgress"`.

## Evidence

- `cli-exit.json` — `{ exitCode, durationMs: t1 - t0, stdout, stderr }`
- `phase-states.json` — phases after approval
