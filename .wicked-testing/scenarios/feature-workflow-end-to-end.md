---
id: feature-workflow-end-to-end
title: Full feature workflow — fixture worker, autonomous, all units approved
maps_to: [SC-001]
trust_level: local-dev
tags: [crew, run, autonomous, e2e]
status: active
---

## Goal

A full run completes autonomously when `stub: true` is set (no real worker) and all
governance units reach `status: "allowed"`. The run session reaches `completed`.

## Preconditions

- wicked-crew daemon is NOT running (test starts it)
- `CoreAdapter({ stub: true })` is used — no real worker binary needed
- Fresh SQLite database (temp file, per-test isolation)

## Steps

1. Boot `CoreAdapter({ stub: true })` + HTTP server on an ephemeral port.
2. `POST /api/v1/runs` with body `{ "problem": "acceptance e2e probe", "sessionId": "at-e2e-01", "clisJson": "[{\"key\":\"stub\",\"display_name\":\"Stub\",\"binary\":\"stub\",\"headless_invocation\":\"stub {PROMPT}\"}]" }`.
3. Assert response status 201.
4. Poll `GET /api/v1/runs/at-e2e-01` every 200ms until `run.session.status` is `"completed"`, `"failed"`, or `"cancelled"` (max 30s).
5. Collect `run.units` from the final GET response.

## Assertions

- A1: `POST /api/v1/runs` returns HTTP 201.
- A2: `GET /api/v1/runs/at-e2e-01` reaches terminal `status: "completed"` before 30s timeout.
- A3: `run.session.status` is `"completed"` (not `"failed"` or `"cancelled"`).
- A4: All units in `run.units` have `denial_reason: null` (gate allowed every unit; terminal unit status is `"done"`, not `"denied"`).

## Evidence

- `run-response.json` — final `GET /api/v1/runs/at-e2e-01` response body (units + session)
- `vitest-run.txt` — `packages/crew/tests/integration/gate-determinism.test.ts` output (100 runs, PASS)
