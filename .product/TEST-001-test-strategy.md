---
name: TEST-001-test-strategy
title: wicked-crew — Test Strategy
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# TEST-001 — Test Strategy

## 1. Philosophy

Tests verify that the software does what the requirements say. Every success criterion (SC-001..SC-009, SC-S01..SC-S06) has at least one executable scenario. The DoD gate requires a working app demonstration, not just green tests — test scenarios here support that evidence, they don't replace it.

No mocked SQLite. No mocked subprocess. Tests use:
- Real SQLite temp files (per-test isolation)
- Real subprocess spawns (fixture worker CLIs that echo structured JSON)
- Real XState actors
- Real json-rules-engine evaluation

Test runner: Vitest. All tests must be deterministic (no `setTimeout`, no `Math.random()` without seeded fixture).

---

## 2. Test Layers

| Layer | Tool | What it tests | Location |
|---|---|---|---|
| Unit | Vitest | Pure functions: output parser, synthesis math, context truncation, GateFacts builder | `packages/crew/tests/unit/` |
| Integration | Vitest | Daemon components wired together: FSM + store + governance + dispatcher against fixture worker | `packages/crew/tests/integration/` |
| API | Vitest + `undici` | REST endpoints + WebSocket against a running daemon (in-process) | `packages/crew/tests/api/` |
| Studio | Vitest + Testing Library | React components: GatePanel rendering, PhaseGraph rendering, useEventStream hook | `packages/studio/tests/` |
| Acceptance | wicked-testing pipeline | End-to-end working-app behaviors (SC-001..SC-009) | `.wicked-testing/scenarios/` |

---

## 3. Fixture Worker

All integration and acceptance tests use a fixture worker CLI (`packages/crew/tests/fixtures/mock-worker.mjs`) that accepts a prompt argument and prints deterministic JSON:

```javascript
#!/usr/bin/env node
// Usage: node mock-worker.mjs [--exit <code>] [--verdict <PASS|FAIL>] [--council]
import { argv } from 'node:process';
const exitCode = parseInt(argv[argv.indexOf('--exit') + 1] ?? '0');
const verdict  = argv[argv.indexOf('--verdict') + 1] ?? 'PASS';
const council  = argv.includes('--council');

const output = {
  status: exitCode === 0 ? 'ok' : 'error',
  artifact: { acceptance_criteria: [{ id: 'AC-001', text: 'fixture criterion' }], raid_items: [] },
  test_verdict: verdict,   // always emit; value is 'PASS', 'CONDITIONAL', or 'FAIL'
  ...(council ? {
    votes: {
      recommendation: 'option-a',
      confidence: 0.9,
      rationale: 'fixture rationale',
      dimensions: { feasibility: 'agree', risk: 'disagree', alignment_with_goal: 'agree' }
    }
  } : {}),
};

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(exitCode);
```

Registered in `test-workers.json` used by all integration/acceptance tests.

---

## 4. Scenarios per Success Criterion

### SC-001 — Full autonomous workflow (clarify → ship)

**Scenario**: `feature-workflow-full-run`
- Setup: Create session with `type: feature`, `goal: "test full run"`, all phases configured with auto gate kind, fixture worker registered.
- Execute: Start session. Poll session status until `status = completed` or timeout 60s.
- Assert:
  1. `GET /api/v1/sessions/:id` returns `status: "completed"`
  2. Query wicked-bus for events matching `session_id` — must contain one `wicked.crew.phase.gate.approved` event per phase in the feature workflow (clarify, design, test-strategy, build, test, ship) in chronological order.
  3. No phase has `state = Rejected` in the SQLite `phases` table.
- Evidence: wicked-bus event log (JSON), final session record.

### SC-002 — Crash + resume (SIGKILL mid-phase)

**Scenario**: `crash-and-resume`
- Setup: Start daemon as separate process. Create session, let it reach `AwaitingHuman` in design phase (configure design phase as human gate kind).
- Execute:
  1. Capture SQLite snapshot: `SELECT * FROM phases WHERE session_id = :id` → save as `before.json`.
  2. Send `SIGKILL` to daemon process.
  3. Start fresh daemon process (same DB path).
  4. Call `POST /api/v1/sessions/:id/gates/design/approve`.
  5. Poll until next phase starts.
  6. Capture post-resume phase state: `SELECT * FROM phases WHERE session_id = :id` → save as `after.json`.
- Assert:
  1. `after.json` contains the same phase records as `before.json` for all phases up to design.
  2. Non-temporal fields (`phase_id`, `state`, `gate_kind`, `blocking_raid_ids`) are identical in before vs after for all completed phases.
  3. Session continues advancing past design phase after resume (did not restart from clarify).
- Evidence: `before.json`, `after.json`, diff of non-temporal fields.

### SC-003 — Deterministic gate evaluation (100 runs)

**Scenario**: `gate-determinism`
- Setup: Build `GateFacts` fixture: `{ evidence_kinds: ['worker-output'], blocking_raid_count: 0, worker_exit_codes: [0], worker_all_success: true, gate_kind: 'auto', council_score: null, test_verdict: null, human_override: false }`. Load default built-in policies.
- Execute: Call `evaluateGate(policies, facts)` 100 times in a loop.
- Assert: All 100 results are `{ result: 'approved', blockingPolicies: [] }`. No variance.
- Evidence: Vitest test result log.

### SC-004 — Multi-worker council (≥ 2 perspectives)

**Scenario**: `council-dispatch`
- Setup: Register 2 fixture workers in `test-workers.json`. Configure a session phase with `gate_kind: council`.
- Execute: Call `dispatchCouncil(['mock-worker-1', 'mock-worker-2'], prompt, context)`.
- Assert:
  1. `result.workerResults.length >= 2`
  2. Both workers' results have `status: 'success'`
  3. `result.synthesisScore` is a number between 0 and 1
  4. `result.recommendation` is a non-empty string
  5. Both dispatches were concurrent: `workerResults[1].startedAt < workerResults[0].completedAt` — worker-2 started before worker-1 finished. (A serial implementation fails this check because worker-2 starts only after worker-1 exits.)
- Evidence: Vitest test result log + dispatch timestamps from SQLite.

### SC-005 — wicked-testing gate integration

**Scenario**: `test-verdict-gate-pass` and `test-verdict-gate-fail`

**Pass path**:
- Setup: Create session with test phase. Register `mock-worker --verdict PASS` as test worker.
- Execute: Run dispatch; wait for gate evaluation.
- Assert:
  1. `gates.result = 'approved'` for the test phase gate (SQLite `gates` table).
  2. `phases.state = 'Approved'` for the test phase (SQLite `phases` table).
  3. Next phase record exists with `state = 'InProgress'` (SQLite `phases` table).

**Fail path**:
- Setup: Same, but `mock-worker --verdict FAIL`.
- Assert: Gate result is `rejected`. `blocking_policies` contains `'test-verdict-pass'`. Phase does NOT advance.
- Evidence: Vitest test result log + gate record from SQLite.

### SC-006 — wicked-studio connects within 5 seconds

**Scenario**: `studio-websocket-connect`
- Setup: Start daemon (in-process test server). Load wicked-studio in jsdom (or use playwright for browser-level test).
- Execute: Record `t0 = Date.now()`. Mount `App` component. Wait for `ConnectionStatus` to show "connected" state.
- Assert: `Date.now() - t0 < 5000`. WebSocket `onopen` was called.
- Evidence: Vitest + Testing Library test result log.

### SC-007 — Startup to first dispatch < 3 seconds

**Scenario**: `startup-perf`

The `--dry-run` flag is NOT used — it is unnecessary. The fixture worker exits in < 50ms (writes one JSON line, exits 0). Measuring from CLI spawn to the first `wicked.crew.dispatch.started` wicked-bus event gives an accurate end-to-end startup + first dispatch time without any special flag.

- Setup: Fixture worker registered (`mock-worker.mjs` exits immediately). Fresh DB.
- Execute (in test code, not shell timer):
  1. `t0 = Date.now()`
  2. Spawn `wicked-crew start --type feature --goal "perf test"` via `execa`.
  3. Poll wicked-bus for `wicked.crew.dispatch.started` event with matching session_id.
  4. `t1 = Date.now()` when event found.
- Assert: `t1 - t0 < 3000`.
- Evidence: Timing logged in Vitest test output.

Note: Remove `--dry-run` from section 10 open items — it is not needed.

### SC-008 — workers.json hot-reload within 30 seconds

**Scenario**: `worker-hot-reload`
- Setup: Start daemon. Initial `workers.json` has only `mock-worker-1`.
- Execute:
  1. Write `mock-worker-2` entry to `workers.json`.
  2. Wait up to 35 seconds (poll every 2s for `GET /api/v1/workers` to include `mock-worker-2`).
- Assert: `mock-worker-2` appears in `/api/v1/workers` within 30 seconds.
- Evidence: Time of workers.json write vs time of first appearance in API response (logged in test).

### SC-009 — Terminal HITL gate approval

**Scenario**: `terminal-hitl-approval`
- Setup: Session with human gate at design phase. Configure fixture worker for clarify.
- Execute:
  1. Run `wicked-crew gate --session <id> --phase design --action approve` via subprocess.
  2. Poll `GET /api/v1/sessions/:id/phases` until design phase state changes.
- Assert:
  1. `wicked-crew gate` exits with code 0.
  2. Design phase `state = Approved` within 5 seconds.
  3. Next phase (test-strategy) `state = InProgress`.
- Evidence: Exit code + phase state from API.

---

## 5. Studio Scenarios (SC-S01..SC-S06)

### SC-S01 — Studio connects within 5 seconds

See SC-006 above (same scenario, referenced from studio acceptance).

### SC-S02 — Gate notification within 2 seconds of WebSocket message

**Scenario**: `gate-notification-timing`
- Setup: Render `App` with mock WebSocket. `GateNotifications` component mounted.
- Execute: Inject `wicked.crew.gate.awaiting_human` WebSocket message. Record `t0` at message injection. Poll DOM for gate notification badge.
- Assert: Gate notification visible in DOM within 2000ms of message injection.
- Evidence: Testing Library timing assertion.

### SC-S03 — Studio HITL approval advances phase

**Scenario**: `studio-gate-approval`
- Setup: Running daemon with session in `AwaitingHuman`. Studio mounted with real fetch.
- Execute: Click `[Approve]` button in `GatePanel`. Poll `GET /api/v1/sessions/:id` every 500ms.
- Assert: Phase state changes to `Approved` within 3000ms of button click.
- Evidence: React Testing Library interaction + API poll result.

### SC-S04 — Session list refreshes within 500ms of WebSocket event

**Scenario**: `session-list-refresh`
- Setup: Render `SessionList` with TanStack Query + mock WebSocket.
- Execute: Inject `wicked.crew.session.started` WebSocket event (new session). Record `t0`. Poll DOM for new SessionCard.
- Assert: New SessionCard appears within 500ms.
- Evidence: Testing Library timing assertion.

### SC-S05 — Disconnected state shown gracefully

**Scenario**: `studio-disconnected-state`
- Setup: Mount `App` with WebSocket that immediately closes (simulates daemon unavailable).
- Assert:
  1. `ConnectionStatus` component shows "disconnected" state (no crash, no blank screen).
  2. Session list shows a graceful empty state or reconnecting indicator.
  3. No unhandled React error boundary triggered: `expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('React'))` (spy set up in beforeEach).
- Evidence: Testing Library snapshot of disconnected UI.

### SC-S06 — Works in Chrome, responsive at 1280px

**Scenario**: `studio-responsive`
- Execute: Open `http://localhost:4200` in Chrome (Playwright). Set viewport to 1280×800.
- Assert:
  1. No horizontal scroll at 1280px.
  2. Sidebar and MainContent both visible.
  3. GatePanel renders within viewport without overflow.
- Evidence: Playwright screenshot at 1280px.

---

## 6. Unit Test Coverage Targets

| Module | Target coverage | Key test cases |
|---|---|---|
| `dispatch/parser.ts` | 100% | Valid JSON last line; JSON embedded in text; no JSON (raw-text fallback); empty stdout; malformed JSON |
| `dispatch/dispatcher.ts` | 90% | Success, non-zero exit, timeout, binary-not-found |
| `governance/engine.ts` | 95% | All policies pass; one fails (deny-dominates); empty policy set; council threshold pass/fail |
| `governance/facts.ts` | 100% | GateFacts built correctly from SQLite data; `worker_all_success` correct for mixed exit codes |
| `dispatch/dispatcher.ts` (council) | 90% | 2 workers parallel; synthesis score math; plurality recommendation; insufficient votes (0 vote workers) |
| `fsm/phase-machine.ts` | 90% | All state transitions; human gate path; council gate path; retry after Rejected |
| `store/snapshots.ts` | 100% | Save + restore round-trip; missing snapshot returns null |
| `events/bridge.ts` | 80% | Broadcast to multiple clients; slow client error handled; client disconnect cleaned up |

---

## 7. Integration Test Scenarios

| Scenario | Description |
|---|---|
| `full-auto-phase` | One full phase (clarify): session created → dispatch to fixture worker → gate evaluated → phase Approved → evidence recorded. Verified end-to-end via SQLite. |
| `human-gate-flow` | Session with human gate: phase reaches AwaitingHuman → `POST /gates/:phase/approve` → gate Approved → phase advances. |
| `council-gate-flow` | Council gate: 2 fixture workers dispatched in parallel → synthesis score computed → council_score fact used in gate evaluation → phase decision. |
| `crash-resume-mid-phase` | XState snapshot saved; process.exit() called; snapshot restored; session resumes correct phase. |
| `worker-exit-nonzero` | Fixture worker exits with code 1 → dispatch status=error → `worker_all_success: false` → gate rejects. |
| `context-truncation` | Session with 10 completed phases; context exceeds 32K chars; oldest phases dropped; JSON context passed to worker is valid. |

---

## 8. Acceptance Scenarios (wicked-testing)

Acceptance scenarios live in `.wicked-testing/scenarios/`. Each maps to one or more SCs.

| Scenario file | Maps to | Description |
|---|---|---|
| `feature-workflow-end-to-end.md` | SC-001 | Full feature workflow with fixture worker |
| `crash-and-resume.md` | SC-002 | SIGKILL + resume correctness |
| `terminal-hitl-gate.md` | SC-009 | CLI gate approval flow |
| `studio-hitl-flow.md` | SC-S02, SC-S03 | Studio gate notification + approval |
| `studio-connectivity.md` | SC-S01, SC-S05 | WebSocket connect + disconnect |

wicked-testing acceptance pipeline (3-agent: writer → executor → reviewer) is the final evidence gate before DoD.

---

## 9. CI Integration

```yaml
# .github/workflows/ci.yml
jobs:
  test-crew:
    steps:
      - run: npm ci
      - run: npm run typecheck          # tsc --noEmit
      - run: npm run lint               # ESLint strict
      - run: npm run test:unit          # Vitest unit
      - run: npm run test:integration   # Vitest integration (real SQLite)
      - run: npm run test:api           # Vitest API (in-process daemon)
  test-studio:
    steps:
      - run: npm run test:studio        # Vitest + Testing Library
      - run: npm run test:e2e           # Playwright (SC-S06)
```

All jobs must pass before the build phase is considered complete. Coverage report uploaded as artifact.

---

## 10. Open Items

| Item | Detail |
|---|---|
| Playwright setup for SC-S06 | Requires a running daemon + studio for the responsive test — needs a `globalSetup` fixture. Design in build phase. |
| Playwright globalSetup | SC-S06 and studio e2e tests need daemon + studio started in `globalSetup` fixture. Design at start of build phase. |
| wicked-testing scenario authorship | Acceptance scenarios authored at start of build phase before first line of implementation code. |
