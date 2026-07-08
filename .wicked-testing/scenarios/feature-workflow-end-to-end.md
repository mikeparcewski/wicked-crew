---
id: feature-workflow-end-to-end
title: Full feature workflow — fixture worker, autonomous, all phases approved
maps_to: [SC-001]
trust_level: local-dev
tags: [crew, session, autonomous, e2e]
status: active
---

## Goal

A full feature-type session completes autonomously when all phases are configured with `gate_kind: auto` and a fixture worker is registered. Every phase advances from InProgress → Approved and the session reaches `completed`.

## Preconditions

- wicked-crew daemon is NOT running (test starts it)
- `test-workers.json` registers `mock-worker` pointing to `packages/crew/tests/fixtures/mock-worker.mjs` with `--verdict PASS`
- Fresh SQLite database (temp file, per-test isolation)

## Steps

1. Start the wicked-crew daemon in-process with `test-workers.json` and temp DB.
2. `POST /api/v1/sessions` with body `{ "type": "feature", "goal": "e2e acceptance test run", "workers": ["mock-worker"] }`.
3. Record `session.id` from 201 response.
4. Poll `GET /api/v1/sessions/:id` every 500ms until `status = "completed"` or 60s timeout.
5. Query wicked-bus for all events matching `payload.session_id = :id`.
6. Query SQLite `phases` table for all rows matching `session_id = :id`.

## Assertions

- A1: `GET /api/v1/sessions/:id` returns `status: "completed"` before 60s timeout.
- A2: wicked-bus event log contains one `wicked.crew.phase.gate.approved` event per phase in the feature workflow (clarify, design, test-strategy, build, test, ship) in ascending `created_at` order.
- A3: No `phases` row has `state = "Rejected"`.
- A4: All `phases` rows have `state = "Approved"`.

## Evidence

- `session-response.json` — final `GET /api/v1/sessions/:id` response body
- `bus-events.json` — all wicked-bus events for the session
- `phases-rows.json` — all SQLite phases rows
