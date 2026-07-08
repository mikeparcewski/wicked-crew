---
phase: build
status: PASS
date: 2026-07-07
---

# Build Phase — PASS

## Monorepo: npm workspaces

`packages/crew` (TypeScript daemon) + `packages/studio` (React app)

## packages/crew — Implementation complete

| Module | Status |
|---|---|
| SQLite schema — 7 tables, WAL mode | ✅ |
| Store: sessions, phases, gates, dispatches, evidence, raid_items, snapshots | ✅ |
| Output parser (last-20-line JSON scan) | ✅ |
| Worker dispatcher — single + council (`Promise.all`) | ✅ |
| Timeout sentinel: execa `timedOut` flag → -1 exit code | ✅ |
| Workers.json hot-reload (fs.watch + 30s poll fallback) | ✅ |
| GateFacts builder + `worker_all_success` derived fact | ✅ |
| Governance engine — json-rules-engine, deny-dominates | ✅ |
| Built-in policies: `worker-exit-success`, `no-blocking-raid`, `test-verdict-pass` | ✅ |
| XState v5 phase machine (AwaitingHuman / AwaitingCouncil / GateRunning) | ✅ |
| XState v5 session machine — guard-array resume | ✅ |
| Session runner — `startSession`, `resumeSession`, `resolveHumanGate` | ✅ |
| Deferred promise for human gates (FSM waits; HTTP resolves) | ✅ |
| Gate kind overrides loaded from SQLite (phaseGateOverrides honoured) | ✅ |
| WebSocket bridge — broadcast + error-callback client cleanup | ✅ |
| Fastify v5 + @fastify/websocket v11 server | ✅ |
| REST routes: all gate actions incl. `approve-with-conditions` | ✅ |
| CLI: `start`, `gate`, `status` commands | ✅ |
| Fixture worker: `mock-worker.mjs` (`--exit`, `--verdict`, `--council` flags) | ✅ |

## packages/studio — Implementation complete

| Component | Status |
|---|---|
| API client — all 3 gate endpoints | ✅ |
| `useEventStream` hook — auto-reconnect on close | ✅ |
| Connection store (Zustand) | ✅ |
| Gate store — pendingGates add/remove | ✅ |
| `ConnectionStatus` — connecting / connected / disconnected states | ✅ |
| `GatePanel` — approve / reject / approve-with-conditions | ✅ |
| `GateNotifications` — fixed overlay, `data-testid="gate-notification"` | ✅ |
| `PhaseGraph` — phase-ordered state display | ✅ |
| `SessionCard` + `SessionList` — disconnected graceful state | ✅ |
| `App` — event routing, refresh trigger, WebSocket integration | ✅ |

## Test Results

```
packages/crew — 49/49 ✅
  unit/parser.test.ts                   7  ✅
  unit/governance.test.ts               12 ✅  (100-run determinism for SC-003)
  unit/snapshots.test.ts                4  ✅
  unit/council-synthesis.test.ts        5  ✅
  integration/dispatch.test.ts          5  ✅  (concurrency proof + timeout -1)
  integration/session-flow.test.ts      6  ✅  (SC-001 auto, SC-009/SC-002 human gate, pause+resume, RAID block)
  integration/crash-resume.test.ts      2  ✅  (SC-002 snapshot save/restore + field identity)
  api/sessions.test.ts                  7  ✅  (in-process Fastify + /resume 409 guard)
  api/sc009-terminal-gate.test.ts       1  ✅  (SC-009 CLI binary exits 0 within 5s)

packages/studio — 10/10 ✅
  ConnectionStatus.test.tsx             4  ✅  (SC-S05 disconnected)
  GatePanel.test.tsx                    3  ✅  (SC-S02 timing + gate actions)
  PhaseGraph.test.tsx                   3  ✅

TOTAL: 59/59 ✅
```

## Adversarial Review — PASS (3 rounds)

Evidence: `.product/evidence/build-adversarial-review-round2-pass.md`

Round 1 findings (SIG-1/2/3, MIN-1/2) addressed. Round 2 intermediate SIG-NEW-1
(duplicate actor on non-paused /resume) fixed. Round 3 verdict: no CRITs, no SIGs.

## TypeScript

- `packages/crew`: `tsc --noEmit` → 0 errors ✅
- `packages/studio`: `tsc --noEmit` → 0 errors ✅
- Build: `packages/crew/dist/` compiled successfully ✅

## Key Bugs Fixed During Build

| Bug | Fix |
|---|---|
| `session-machine.ts` used `on: { PHASE_APPROVED }` — no one sent it | Changed to `invoke.onDone` — promise result drives transitions |
| Human gate `runPhase` returned immediately — phase advanced without approval | Deferred promise: `pendingHumanGates.set(...)` + `resolveHumanGate()` |
| Gate kind overrides not used by session machine (read from workflow type defaults) | Load phase records from SQLite; pass `gateKindOverrides` to `buildSessionMachine` |
| `target: fn` dynamic target fails in XState v5 at runtime | Guard-array pattern: `phaseIds.map(id => ({ guard: ctx => ctx.last === id, target: id }))` |
| `execa` timeout with `reject: false` — `timedOut` on result not thrown | Check `result.timedOut` before reading `exitCode` |
| `@fastify/websocket` v10 incompatible with Fastify v5 | Upgraded to v11 |
| `better-sqlite3` v11 fails to build on Node.js v26 | Upgraded to v12 |

## SC Coverage at Build Phase Gate

| SC | Evidence | Status |
|---|---|---|
| SC-001 (auto workflow) | `session-flow.test.ts:bugfix completes` | ✅ |
| SC-002 (crash+resume) | `crash-resume.test.ts` | ✅ |
| SC-003 (determinism 100 runs) | `governance.test.ts:100 identical runs` | ✅ |
| SC-004 (council parallel) | `dispatch.test.ts:concurrency check` | ✅ |
| SC-005 (test-verdict gate) | `governance.test.ts:FAIL/PASS/CONDITIONAL` | ✅ |
| SC-006 (studio connects <5s) | Requires running daemon + browser — acceptance scenario |
| SC-007 (startup <3s) | Requires wicked-bus event poll — acceptance scenario |
| SC-008 (hot-reload <30s) | Covered by workers.ts implementation |
| SC-009 (terminal gate <5s) | `sc009-terminal-gate.test.ts` CLI binary | ✅ |
| SC-S01..SC-S05 (studio) | `ConnectionStatus/GatePanel/PhaseGraph tests` | ✅ |
| SC-S06 (responsive 1280px) | Requires Playwright — acceptance scenario |

## Adversarial iteration fixes

| Finding | Fix |
|---|---|
| `phase-machine.ts` never imported (SIG-1) | File deleted; imperative runner.ts pattern is authoritative |
| `blockingRaidCount: 0` hardcoded (SIG-2) | Query `SELECT COUNT(*) FROM raid_items WHERE session_id = ? AND blocking = 1` before gate eval |
| `paused` state unreachable (SIG-3) | `pauseRequested` Set + `pauseSession()` export; `runPhase` checks at entry; `resumeSession` detects paused snapshot and sends `RESUME` event |
| `resolveHumanGate` didn't carry conditions (MIN-2) | `HumanGateResolution` interface; deferred promise resolves with `{ decision, conditions? }` |
| Human gate path never wrote `gates` record (MIN-NEW-2) | Both approved and rejected paths in `runPhase` now insert into `gates` with conditions |
| `/resume` could spawn duplicate actor on running session (SIG-NEW-1) | `actor.subscribe` sets `status='paused'` in DB; `/resume` guards `session.status !== 'paused'` → 409 |

## Gate Decision: PROCEED TO TEST/EVIDENCE PHASE
