---
id: crash-and-resume
title: SIGKILL daemon mid-phase — resume from snapshot, no state regression
maps_to: [SC-002]
trust_level: local-dev
tags: [crew, session, crash, resume, xstate, sqlite]
status: active
---

## Goal

When the daemon is killed mid-phase and restarted against the same SQLite DB, the resumed session continues from the correct phase — not from the beginning — and all prior phase records are intact.

## Preconditions

- Daemon started as a subprocess (not in-process) so it can be killed with SIGKILL.
- Feature session with design phase configured as `gate_kind: human`.
- `mock-worker` registered for the clarify phase (auto gate).
- Session reaches `AwaitingHuman` in design phase before kill.

## Steps

1. Start daemon subprocess. Create session `{ type: "feature", goal: "crash test", workers: ["mock-worker"] }`.
2. Wait for design phase to reach `state = "AwaitingHuman"` (`GET /api/v1/sessions/:id/phases`, poll 1s).
3. Capture `before.json`: `SELECT * FROM phases WHERE session_id = :id ORDER BY created_at`.
4. Send SIGKILL to daemon subprocess (process.kill(pid, 'SIGKILL')).
5. Start fresh daemon subprocess against same DB path.
6. `POST /api/v1/sessions/:id/gates/design/approve` against new daemon.
7. Poll `GET /api/v1/sessions/:id/phases` until design phase `state = "Approved"` or 15s timeout.
8. Capture `after.json`: same query as step 3.

## Assertions

- A1: `after.json` rows for phases prior to design have identical `phase_id`, `state`, `gate_kind`, `blocking_raid_ids` fields to `before.json` (temporal fields excluded: `updated_at`).
- A2: Design phase `state = "Approved"` in `after.json`.
- A3: The next phase record (test-strategy) exists with `state = "InProgress"`.
- A4: No `phase_id = "clarify"` row appears twice (session did NOT restart from beginning).

## Evidence

- `before.json` — phases snapshot before kill
- `after.json` — phases snapshot after resume + approve
- `field-diff.json` — diff of non-temporal fields: must be empty
