---
phase: build
review_round: 2
date: 2026-07-07
verdict: PASS
reviewer: wicked-garden:crew:reviewer
---

# Build Adversarial Review — Round 2 (PASS)

## Round 1 findings closed

| Finding | Severity | Status |
|---|---|---|
| `phase-machine.ts` dead code — never imported | SIG-1 | CLOSED — file deleted |
| `blockingRaidCount: 0` hardcoded — never queried from DB | SIG-2 | CLOSED — queries `raid_items WHERE blocking = 1` |
| `paused` state unreachable — no code path returned `{ result: 'paused' }` | SIG-3 | CLOSED — pause signal + resume event wired |
| `workerIds: []` in session machine input | MIN-1 | Deferred (documented) |
| `PhaseResult.conditions` never populated | MIN-2 | CLOSED — `HumanGateResolution` interface; conditions threaded |

## Round 2 intermediate: SIG-NEW-1

Reviewer found: `/resume` route guard checked `status !== 'running'`, but paused sessions also have `status = running`. Two concurrent actors could be created.

**Fix applied:**
1. `actor.subscribe` → `updateSessionStatus(db, sessionId, 'paused')` when FSM enters paused state
2. `/resume` guard changed to `session.status !== 'paused'` → 409

## Round 3 verdict: PASS

No CRITs. No SIGs. Two non-blocking Concerns:

| Concern | Location | Disposition |
|---|---|---|
| `saveSnapshot` + `updateSessionStatus` not in one transaction — crash window between writes | runner.ts:111-115 | Acceptable for local-first tool; extremely narrow window |
| `/resume` HTTP guard not covered by integration test | routes.ts | Fixed (test added: POST /resume → 409 on running session) |

## Final test count

```
packages/crew  — 49/49 ✅
  unit/parser.test.ts                    7  ✅
  unit/governance.test.ts                12 ✅
  unit/snapshots.test.ts                 4  ✅
  unit/council-synthesis.test.ts         5  ✅
  integration/dispatch.test.ts           5  ✅
  integration/session-flow.test.ts       6  ✅  (+2: pause+resume, blocking RAID)
  integration/crash-resume.test.ts       2  ✅
  api/sessions.test.ts                   7  ✅  (+1: resume 409 guard)
  api/sc009-terminal-gate.test.ts        1  ✅

packages/studio — 10/10 ✅
  ConnectionStatus.test.tsx              4  ✅
  GatePanel.test.tsx                     3  ✅
  PhaseGraph.test.tsx                    3  ✅

TOTAL: 59/59 ✅
```

## Code changes summary (Rounds 1-2 iteration)

| File | Change |
|---|---|
| `src/fsm/phase-machine.ts` | Deleted (dead code) |
| `src/fsm/runner.ts` | `pauseRequested` Set + `pauseSession()` export; `runPhase` pause check at entry; `blockingRaidCount` from DB; `HumanGateResolution` type; `resolveHumanGate` with conditions; human gate writes to `gates` table; `actor.subscribe` sets DB status to 'paused'; `resumeSession` detects paused snapshot + sends RESUME |
| `src/api/routes.ts` | `POST /pause` and `POST /resume` routes; `/resume` guards `status === 'paused'`; `approve-with-conditions` passes conditions to `resolveHumanGate` |
| `tests/integration/session-flow.test.ts` | 2 new tests: pause+resume flow, blocking RAID gate failure |
| `tests/api/sessions.test.ts` | 1 new test: `/resume` 409 on non-paused session |
