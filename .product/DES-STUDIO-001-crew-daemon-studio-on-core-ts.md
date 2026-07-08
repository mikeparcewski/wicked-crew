---
name: DES-STUDIO-001-crew-daemon-studio-on-core-ts
title: Re-pointing the wicked-crew daemon + React studio onto wicked-core-ts — Technical Design
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
depends-on: [wicked-core-ts (napi bridge), wicked-core on estate 0.13]
relates-to: [DES-CAMPAIGN-001 §11 (egui must-not-lose), DES-TERMINAL-001 §6 (terminal surface)]
---

# DES-STUDIO-001 — Crew daemon + studio on core-ts

## 0. The one architectural fact everything hangs off

The browser **cannot** call the napi addon. `wicked-core-ts` is a native cdylib
(`index.node`) `require()`d by a Node process
(`wicked-core/crates/wicked-core-ts/package.json`, `smoke.mjs:42`). So the
topology is fixed:

```
React studio ──REST──▶ wicked-crew daemon ──core-ts (napi)──▶ Rust Core actor
     (browser)  ◀──WS──   (Node: Fastify + ws)  ◀──subscribe()──   (single-writer store)
```

The **daemon is the only process that holds the `Core` handle.** It calls
`Core.spawn(dbPath)` once, calls `core.subscribe(cb)` once, and **fans** the
single `CoreEvent` stream out to N browser WebSocket clients over its existing
`ws` plumbing (`packages/crew/src/events/bus.ts:11` `broadcast`). Every REST
endpoint is a thin wrapper over one core-ts method call. This design specifies
that bridge and the studio re-map.

The pivot is a **subtraction**: today the daemon *owns* orchestration
(XState FSM in `packages/crew/src/fsm/runner.ts`, SQLite in
`packages/crew/src/store/`, governance in `packages/crew/src/governance/`). After
the re-point, **core owns all of that.** The daemon keeps exactly two jobs:
(1) the REST+WS ↔ core-ts bridge, and (2) a thin **HITL-lifecycle layer** over
core's `AwaitingHuman` (the egui `hitl.rs` timeout/expiry salvage, DES-CAMPAIGN-001
§11). Everything else is deleted.

---

## 1. Model mapping — `session/phase/worker/gate` → `run/unit/stage/gate/CoreEvent`

### 1.1 Concept-by-concept

| Crew today | Where it lives | Core / core-ts target | Fate |
|---|---|---|---|
| **Session** (fixed `type`, `goal`, status `pending/running/paused/completed/failed`, `workers[]`) | `store/types.ts:6`, `store/sessions.ts:11` | **Run** = `AgentSession` (`problem`, `clis[]`, `status`, `entity_mode`, `repo_ref`, `unit_ix` cursor) read via `sessionsDetail()` (`wicked-core-ts/src/lib.rs:396`; `wicked-core/src/domain.rs:49`) | **RESHAPED**. `goal`→`problem`; `workers[]`→council roster `clis[]`. |
| **Phase** — a *fixed* ladder (`feature` = clarify→design→test-strategy→build→test→ship) | `fsm/workflow-types.ts:14`, `store/sessions.ts:60` | **WorkUnit** — decomposed from `problem` text, `ord`-ordered, with a `StageKind` badge (`recon/build/review/test`) (`domain.rs:121`, `:183`) | **RESHAPED / DROPPED**. The fixed phase list disappears; units are planned from the brief, not a hard-coded workflow. A crew "workflow type" survives at most as a **brief template** or (later) a **Campaign** DAG (§4). |
| **Phase.state** (`Pending/InProgress/AwaitingHuman/AwaitingCouncil/GateRunning/Approved/Rejected`) | `store/types.ts:2` | **`UnitStatus`** (`pending/distributed/done/rejected`, `domain.rs:171`) + run-level **`SessionStatus`** (`planning/distributing/executing/awaiting_human/completed/cancelled/failed`, `lib.rs:64` `status_token`) | **RESHAPED**. `AwaitingHuman` moves from per-phase to a **run-level pause before a unit `ord`** (`CoreEvent::AwaitingHuman{session,ord,prompt}`, `event.rs:46`). `AwaitingCouncil`/`GateRunning` vanish (council + gate are internal core steps that stream `UnitDistributed`/`GateDecided`). |
| **GateKind** (`auto` / `human` / `council`) | `store/types.ts:3` | **Three orthogonal core concepts**, not one enum: council is *always-on* distribution (`UnitDistributed`); `human` = the **`HumanConfirm`** launch policy (`none`/`all`/`before:<ord>`, `lib.rs:78`); `auto` = simply "no human-confirm gate"; structural governance = **deny policies / gate-hook** (`GateDecided{allow}`) | **RESHAPED**. Do not carry `GateKind` forward. A run is launched with a `humanConfirm` policy; council always runs. |
| **Gate result** (`approved` / `rejected` / `approved-with-conditions`) | `store/types.ts:4`, `api/routes.ts:126` | **`HumanDecision`** = `Approve{amend?}` / `Reject` (`confirmGate(runId, approve, amend?)`, `lib.rs:352`); structural verdict = `GateDecided{allow}` | **MAPPED**. `approved`→`Approve{}`, `rejected`→`Reject`, **`approved-with-conditions`→`Approve{amend: <conditions>}`** (the amend text steers the next unit — DES-CAMPAIGN-001 §11.1). |
| **Worker** (`WorkerConfig{command,args}`, dispatched via `execa`) | `dispatch/dispatcher.ts:7`, `dispatch/workers.ts` | **`AgenticCli`** council seat (`registryRoster()` → JSON, or explicit `clisJson`, `lib.rs:294`, `:228`) | **RESHAPED**. The daemon stops spawning subprocesses entirely; core runs the CLIs. `workers.json` → the council roster. |
| **Governance engine** (`json-rules-engine`, in-process, `governance/engine.ts`) | `governance/` | Core gate-hook + `registerDenyPolicy` (not yet in core-ts — §4.4) | **DROPPED from daemon**. Core owns governance. |
| **XState FSM + snapshots** (`fsm/runner.ts`, `store/snapshots.ts`) | `fsm/` | Core actor + persisted resume cursor (`unit_ix`, `domain.rs`); `resumeRun()` / launch-or-resume by id | **DROPPED from daemon**. Core owns state machine + crash resume. |
| **SQLite store** (`sessions/phases/gates/dispatches/raid_items`) | `store/` (`better-sqlite3`) | Estate store, owned by the core actor (single writer) | **DROPPED from daemon**. Removes the whole reason the daemon had its own DB. |
| **Deferred human-gate promise map** (`pendingHumanGates`, `fsm/runner.ts:28`) | `fsm/runner.ts` | `CoreEvent::AwaitingHuman` + `confirmGate` + the daemon **HITL-lifecycle** cache (§3.3) | **RESHAPED** into the daemon's HITL layer — the one piece of "session ownership" the daemon keeps. |
| **`pauseSession` / `resumeSession`** (`fsm/runner.ts:42`, `:77`; `POST .../pause`, `.../resume`) | `api/routes.ts:108` | **No imperative pause exists** (`lib.rs:379-381`: "there is intentionally no `pauseRun`"). A run pauses ONLY at a declared `HumanConfirm` gate. `resumeRun()` re-enters the cursor. | **CHANGED**. Drop `/pause`. Keep a `/resume` but with **advance semantics** (§3.2, DES-CAMPAIGN-001 §11.8): if `awaiting_human` → `confirmGate`; else `resumeRun`. |

### 1.2 What the daemon stops owning (delete list)

`packages/crew/src/store/*` (schema, db, sessions, snapshots), `fsm/*`
(runner, session-machine, workflow-types), `governance/*`, `dispatch/*` (workers,
dispatcher, parser). All of it is core's job now. `better-sqlite3`, `xstate`,
`json-rules-engine`, `execa` drop out of the daemon's dependency set
(`packages/crew/package.json`), replaced by a single dep on the built
`wicked-core-ts` addon.

### 1.3 What the daemon keeps / gains

- **Fastify + `@fastify/websocket`** plumbing (`api/server.ts`) — unchanged shape,
  new routes.
- **`events/bus.ts` `broadcast()`** — repurposed to fan `CoreEvent`s to WS clients.
  (The external `wicked-bus emit`, `bus.ts:46`, is optional/orthogonal — keep it as
  a durable audit tap on lifecycle events if desired.)
- **NEW: a core-ts adapter module** (§5.3) — the single file that holds the `Core`
  handle and the one `subscribe()`. This is the *only* place that touches the
  FINALIZING interface (§5.1).
- **NEW: HITL-lifecycle layer** — the `hitl.rs` salvage (§3.3).
- **NEW (self-healing): gate-prompt cache** — because core does **not** persist the
  gate prompt (it exists only on the transient `AwaitingHuman` event; `AgentSession`
  in `domain.rs:49` has no prompt field), the daemon must event-source and cache it
  (§3.3).

---

## 2. Daemon REST surface — each endpoint backed by one core-ts call

Base path stays `/api/v1` (`api/routes.ts:22`). CORS/loopback + empty-body
handling (`api/server.ts:15-33`) unchanged. `session`/`phase` nouns become
`run`/`unit`.

| Method + path | core-ts call (`lib.rs`) | Notes |
|---|---|---|
| `GET /health` | `core.ping()` → `"ok"` (`:320`) | Liveness; also proves the event pump. |
| `GET /roster` | `Core.registryRoster()` (`:294`, static) | The council seats for the launch form (§11.7). |
| `GET /repos` | `core.listRepos()` (`:441`) | Registered repos → target-repo picker. |
| `POST /repos` `{name, rootPath}` | `core.registerRepo(name, rootPath)` (`:426`) | Validates git repo ≥1 commit; returns `RepoEntry`. |
| `POST /runs` `{problem, sessionId, clisJson?, entityMode?, humanConfirm?, repoRef?}` | `core.launchRun(opts)` → runId (`:332`) | **Replaces `POST /sessions`**. `clisJson` defaults to `registryRoster()`. `sessionId` required (`index.d.ts:13`) — daemon mints a UUID if the client omits it. |
| `GET /runs` | `core.sessionsDetail()` → `[{session, units}]` (`:396`) | **Replaces `GET /sessions`**. Powers the run list. Daemon sorts **actionable-first** (§11.6). |
| `GET /runs/:id` | `sessionsDetail()` filtered by `session.id` | Detail view = one `SessionView` (`domain.rs:387`). |
| `GET /runs/:id/units/:ord/output` | `core.workOutput("{id}:u{ord}")` (`:415`) | Unit transcript (string or `null`). Unit id convention `<session>:u<ord>` (`smoke.mjs:129`, `domain.rs` "`<session>:u1`"). |
| `POST /runs/:id/gate` `{approve: bool, amend?: string}` | `core.confirmGate(id, approve, amend)` (`:352`) → status token | **The steering gate** (§11.1). `approve:true,amend:"…"` = Approve-with-steer; `approve:false` = Reject (cancels the run per `lib.rs:360`). |
| `POST /runs/:id/cancel` | `core.cancelRun(id)` (`:374`) → status token | Distinct third action (§11.1): cancel a *running* or paused run. |
| `POST /runs/:id/resume` | **advance:** if status `awaiting_human` → `confirmGate(id,true)`; else `core.resumeRun(id)` (`:343`) | §11.8 — never `resumeRun` a gated run (it would re-pause). Primarily for post-restart continuation. |
| `GET /runs/:id/gate` | *daemon cache* (§3.3), not a core call | Returns the cached `{prompt, ord, lifecycle}` for a paused run so a fresh browser can render the gate. |

**Removed:** `POST /sessions/:id/pause` (no core pause), `POST .../gates/:phase/{approve,reject,approve-with-conditions}` (collapse into `POST /runs/:id/gate`), the phase-specific reads. `GET /workers` → `GET /roster`.

### 2.1 WS event protocol (browser ⇄ daemon ⇄ core-ts)

- The daemon calls `core.subscribe(json => broadcast(json))` **once** at startup.
  Each `CoreEvent` is already a tagged-JSON string (`{type, ...}`,
  `wicked-core-ts/src/lib.rs:92` `event_to_json`).
- **Forward the CoreEvent frame verbatim** to every WS client on `/ws`
  (`api/server.ts:37`). Drop today's `{type, payload, ts}` envelope
  (`bus.ts:47`) — the studio switches directly on the CoreEvent discriminant
  (`sessionStarted`, `unitPlanned`, `unitDistributed`, `unitExecuting`,
  `cliOutputDelta`, `gateDecided`, `unitDone`, `unitDenied`, `awaitingHuman`,
  `resumed`, `runCancelled`, `sessionFailed`, `sessionCompleted`, `error`;
  `event.rs:9-81`).
- **Ordering is preserved end-to-end**: the Rust pump is single-reader FIFO
  (`wicked-core-ts/src/lib.rs:307-314`), so a monotonic client-side `seq` is not
  needed for the WS itself — but the studio still keys live output by
  `(session, ord)` and appends in arrival order (§11.4).
- **Late-join / reconcile:** a WS client that connects mid-run gets no replay.
  The studio's reconcile path is a one-shot `GET /runs` on (re)connect
  (mirrors today's refresh-on-connect, `SessionList.tsx:19`), merged with the
  daemon's gate cache (§3.3). This is the self-healing story for §11.3.

**Terminal + campaign channels are deferred** (§4.2, §4.3) — they attach to this
same WS plumbing when their core-ts surfaces land.

---

## 3. Studio component re-map

Vite/React app under `packages/studio/src/`. The re-map is mostly rename +
re-point; the net-new work is the §11 must-not-lose features.

### 3.1 Existing components

| Component (`studio/src/…`) | Re-point |
|---|---|
| `hooks/useEventStream.ts` | Keep the reconnect loop (`:29-38`). Change `CrewEvent{type,payload,ts}` (`:4`) → `CoreEventFrame{type; session?; ord?; [k]:unknown}` (matches `index.d.ts:33` `CoreEventJson`). `switch(event.type)` over the CoreEvent variants. |
| `api/client.ts` | Repoint verbs: `listSessions`→`listRuns` (`GET /runs`), `getSession`→`getRun`; `approveGate`/`rejectGate`/`approveWithConditions` → **one** `confirmGate(id, {approve, amend})`; add `cancelRun(id)`, `launchRun(body)`, `getRoster`, `listRepos`, `registerRepo`, `getGate(id)`. `Session`/`Phase` types (`:31-50`) → `Run`(=`SessionView.session`)/`Unit`(=`WorkUnit`) matching `domain.rs`. |
| `store/connection.ts` | **Unchanged** — WS connection state. |
| `store/gates.ts` | **Reshaped** into the self-healing gate cache (§3.3): key `runId` (a paused run has exactly one open gate, before `unit_ix`), value `{ord, prompt, lifecycle, receivedAt}`. |
| `components/ConnectionStatus.tsx` | **Unchanged**. |
| `components/SessionList.tsx` → `RunList.tsx` | `GET /runs` (`:21`); render `RunCard`. Empty/disconnected states unchanged. |
| `components/SessionCard.tsx` → `RunCard.tsx` | Show `problem` (was `goal`), short `id`, and the run `SessionStatus`. Status color map (`:10`) → the **7 core statuses** (`planning/distributing/executing/awaiting_human/completed/cancelled/failed`). |
| `components/PhaseGraph.tsx` → `UnitList.tsx` | Render `WorkUnit[]` by `ord`: `StageKind` badge (`recon/build/review/test`, `domain.rs:228`), `assigned_cli`, `UnitStatus`. State color map (`:3`) → `UnitStatus` + stage. Backs **§11.9 work-unit detail**. |
| `components/GatePanel.tsx` → `SteeringGate.tsx` | **The §11.1 rework** (see §3.2). |
| `components/GateNotifications.tsx` | Keep the toast container; source from the gate cache; key by `runId` (was `${sessionId}-${phaseId}`, `:12`). |

### 3.2 SteeringGate (§11.1, §11.2, §11.8) — the load-bearing HITL control

Three **distinct** actions, all bound to the **`runId` carried on the
`awaitingHuman` event**, never a list index (§11.2 — prevents approving the wrong
run after the list re-sorts actionable-first):

1. **Approve** → `POST /runs/:id/gate {approve:true}`.
2. **Approve with steer/amend** → `POST /runs/:id/gate {approve:true, amend:<text>}`
   (today's `approve-with-conditions` textarea, `GatePanel.tsx:56`, becomes the
   amend text — it *steers the next unit*, `lib.rs:360`).
3. **Reject** → `POST /runs/:id/gate {approve:false}` (cancels the run).
4. **Cancel run** → `POST /runs/:id/cancel` — a separate button, valid whether the
   run is paused or executing.

The current GatePanel's overloaded "Modify with conditions / Apply / Reject"
tri-state (`GatePanel.tsx:82-88`) is replaced by these four explicit affordances.

### 3.3 Self-healing gate cache + HITL-lifecycle (daemon-owned; §11.3 + §11 salvage)

Because the prompt lives only on the transient event, the **daemon** (not just the
browser) event-sources it:

- On `awaitingHuman{session,ord,prompt}` → cache `{ord, prompt, lifecycle:'open', receivedAt}` under `session`.
- On `resumed` / `sessionCompleted` / `runCancelled` / `sessionFailed` for that
  `session` → **prune** the cache entry.
- On any client `GET /runs` reconcile → cross-check the cache against
  `sessionsDetail()` status: keep entries whose run is still `awaiting_human`,
  drop the rest. "Re-merged on reconcile, pruned to still-paused — can't leak or
  blank" (DES-CAMPAIGN-001 §11.3).
- **HITL lifecycle** (the egui `hitl.rs` salvage): each cache entry advances
  `open → (advisory ~5m) → (hard expiry ~1h) → submitted → acknowledged →
  failed/retry`, with an append-only message log. On hard expiry the daemon takes a
  configured action (default: leave paused + flag `expired` in the gate frame; opt-in:
  auto-`cancelRun`). This is **purely a daemon concern layered over core's
  `AwaitingHuman`** — no core change (DES-CAMPAIGN-001 §11 "HITL lifecycle to
  salvage"). Surfaced to the studio via `GET /runs/:id/gate` and a `gateLifecycle`
  WS frame the daemon synthesizes (not a CoreEvent).
- **Known limitation** tied to persistence: if the daemon restarts, the cache is
  lost but the run is still `awaiting_human` in core. The studio then shows
  "awaiting human — prompt unavailable" and still offers Approve/Reject/Cancel
  (which need only the id). Persisting the prompt is a candidate **additive** core
  field later; not required for v1.

### 3.4 Net-new components (all buildable now — §4.1)

- **`LiveOutput.tsx`** (§11.4) — subscribes to `cliOutputDelta{session,ord,chunk}`
  (`event.rs:29`); append-only, keyed `(session,ord)`, stick-to-bottom, capped
  buffer. Plus a **per-run filtered event log** (all CoreEvents for that `session`).
- **`RoutingProvenance.tsx` + `FailureBanner.tsx`** (§11.5) — render
  `WorkUnit.routing` (`RoutingInfo`, `domain.rs:243`): `Council{winner,
  agreement_pct, returned, dissent}`, `Degraded{reason}`, or **`EvaluatorDistinct
  {winner, was}`** (the evaluator≠creator reassignment — a first-class "why this CLI"
  answer). `denial_reason` (`domain.rs`) drives the per-unit denial reason; a
  `sessionFailed{ord}` / `error{message}` drives the run-halted banner.
- **`LaunchForm.tsx`** (§11.7) — brief (`problem`) + roster multiselect (`GET
  /roster`) + target repo (`GET /repos`, register-new) + `humanConfirm` policy
  picker + `entityMode`. **Live memory/knowledge recall on the brief** is a
  *pending* core-ts addition (core has `recall_memories`/`recall_knowledge`,
  `wicked-core/src/lib.rs:302,:361`, but they are **not yet bound** in core-ts) —
  render the field, wire it when the binding lands (§4.4).

---

## 4. Buildable now vs pending

### 4.1 Buildable NOW — against the stable core-ts surface

Everything in the run lifecycle, gates, reads, and the full live feed is exposed
today (`wicked-core-ts/src/lib.rs`, `index.d.ts`) and proven by `smoke.mjs`:

- Launch / resume / cancel a run; confirm a gate (approve+amend / reject)
  (`launchRun`, `resumeRun`, `cancelRun`, `confirmGate` — `lib.rs:332,:343,:374,:352`).
- Run list + detail + unit transcript (`sessions`, `sessionsDetail`, `workOutput`
  — `:385,:396,:415`).
- Repo register/list (`:426,:441`); roster (`:294`).
- The **entire `CoreEvent` live feed** including `CliOutputDelta`, `AwaitingHuman`,
  `GateDecided`, `UnitDistributed` (routing), `SessionFailed`/`Error`
  (`event_to_json`, `lib.rs:92-160`).

⇒ **§11 items 1–10 are all buildable now**: steering gate w/ amend (1),
run-identity binding (2), self-healing gate cache (3), live output + per-run event
log (4), routing provenance + failure banner (5), full ordered lifecycle (6),
launch surface (7) *minus live memory recall*, advance semantics (8), work-unit
detail (9). Governance *controls* (10, deny-policy/CLI registration) is partial —
read/observe now, mutate when `registerDenyPolicy` is bound (§4.4).

### 4.2 PENDING — core-ts terminal method bindings (xterm.js)

The Rust `Core` **already has** `open_terminal`/`write_terminal`/`resize_terminal`/
`close_terminal` (`wicked-core/src/lib.rs:436-505`) and the terminal **events are
already mapped** in core-ts (`terminalOpened`/`terminalOutput{bytesB64}`/
`terminalExited`, `wicked-core-ts/src/lib.rs:150-158`). **But the core-ts *methods*
are not bound yet** — the file says so explicitly: "the full TS surface
(openTerminal etc.) is a separate follow-on task" (`lib.rs:148`).

⇒ The daemon can **receive** terminal output over the existing `subscribe()` stream
today, but **cannot open/write a terminal** until the four methods are bound. So:
- **Blocked:** the xterm.js component + the per-terminal WS channel (browser
  keystrokes → `writeTerminal`, resize → `resizeTerminal`; DES-TERMINAL-001 §6).
- **Design of the terminal WS** (ready to implement the moment the methods land):
  a **dedicated `/ws/terminal/:id`** so high-volume base64 PTY bytes never share the
  main event WS. Inbound frames → `writeTerminal(id, Buffer)` / `resizeTerminal`;
  outbound = the daemon filters `terminalOutput` CoreEvents by `id` and forwards the
  decoded bytes to the matching socket. `openTerminal`/`closeTerminal` are REST
  (`POST /terminals`, `DELETE /terminals/:id`).

### 4.3 PENDING — core Campaign primitive + `RunFinished` (DAG view)

Confirmed **not in core**: no `Campaign` type, no `LaunchCampaign` command, no
`RunFinished`/`Campaign*` CoreEvents anywhere in `wicked-core/src`
(grep: zero hits). DES-CAMPAIGN-001 §10 R1 lists these as hard core prerequisites.

⇒ **Blocked:** campaign endpoints (`POST /campaigns`, `GET /campaigns/:id`) and the
`CampaignDag` view (§11.11). Recommendation: **do not** build the interim
TS-surface campaign bridge inside the studio lane — DES-CAMPAIGN-001 §1 marks its
state as explicitly temporary and migrating into core. Keep the studio pointed at
the single-run surface; add the DAG view when core emits `Campaign*` events (which
will arrive as **additive** CoreEvent variants — §5, so the WS/studio switch absorbs
them with zero rework).

### 4.4 PENDING — additive core-ts bindings that unlock partial features

Rust `Core` has these; core-ts does **not** bind them yet (all purely additive when
they land): `register_deny_policy` (`wicked-core/src/lib.rs:273`, unlocks §11.10
governance mutation), `recall_memories`/`recall_knowledge` (`:302,:361`, unlocks the
§11.7 live-recall field), `ingest_knowledge`/`capture_memory`. Render the affordances
disabled; wire on binding.

### 4.5 Summary

| Feature | Status | Gate |
|---|---|---|
| Run lifecycle, gates, reads, roster, repos | **NOW** | stable core-ts |
| Live output + event log, provenance, failure banner, work-unit detail | **NOW** | stable CoreEvent feed |
| Self-healing gate cache + HITL lifecycle | **NOW** | daemon-only |
| Governance mutation, live memory recall | pending | additive core-ts bindings (§4.4) |
| xterm.js terminal | pending | core-ts terminal methods (§4.2) |
| Campaign DAG view | pending | core `Campaign` + `RunFinished` (§4.3) |

---

## 5. Interface-stability assessment (the operator's question, answered)

### 5.1 STABLE + ADDITIVE — build against these now, no rework expected

- **Method names + shapes** on `Core` (`wicked-core-ts/src/lib.rs`, `index.d.ts`):
  `spawn`/`spawnStub`, `registryRoster`, `ping`, `launchRun`, `resumeRun`,
  `confirmGate`, `cancelRun`, `sessions`, `sessionsDetail`, `workOutput`,
  `registerRepo`, `listRepos`. Async-returns-Promise-of-JSON-string is a settled
  contract (`index.d.ts:41-75`). Adding new methods (terminal, campaign, memory) is
  **additive** — existing calls are unaffected.
- **The `CoreEvent` tagged-JSON wire shape** (`event_to_json`, `lib.rs:92`;
  `index.d.ts:33`). New variants are purely additive: a `switch(type)` with a
  `default` case in `useEventStream` **never breaks** when `campaign*` / new
  `terminal*` variants appear. The existing variants' fields are stable.
- ⇒ **Build the whole §4.1 set now.** The studio's event switch and REST client are
  future-proof against the additive core growth.

### 5.2 FINALIZING right now — isolate, do not spread

- **The `subscribe` teardown handle.** Today `core-ts` `subscribe()` returns
  **`void`** (`lib.rs:303`, `index.d.ts:50`) and the Rust pump thread only ends when
  the **last `Core` handle drops** (`lib.rs:307-314`; the actor-side subscriber list
  merely `retain`s live senders, `wicked-core/src/actor.rs` `emit`). There is **no
  per-subscriber unsubscribe**. An in-flight core lifecycle fix is expected to return
  a **teardown handle** from `subscribe`.
- **The `CalleeHandled` callback signature.** Not present anywhere in the tree today
  (grep: zero hits) — genuinely in-flight. The current callback uses
  `ThreadsafeFunction<String, ErrorStrategy::Fatal>` (`lib.rs:304`); the fix is
  expected to change the callback/ack signature (and likely the error strategy).
- **Why this barely touches the daemon:** the daemon holds **one** long-lived `Core`
  handle and makes **one** `subscribe()` call for the whole process — it fans out to
  browsers itself and never needs to unsubscribe a single consumer. So the
  finalizing surface hits **exactly one function call.** 
- **Mitigation:** put that call behind a **single adapter module**
  (`packages/crew/src/core/adapter.ts`) that owns `Core.spawn()` + `subscribe()` and
  exposes a stable in-daemon API (`onEvent(cb)`, `launchRun`, …). When the
  teardown-handle / `CalleeHandled` signature lands, **only `adapter.ts` changes**;
  routes, WS fan-out, and the entire studio are untouched.

### 5.3 Recommended build order (minimizes rework)

1. **`core/adapter.ts`** — the isolation boundary for the FINALIZING `subscribe`
   surface (§5.2). Everything else depends on this, nothing else touches core-ts
   directly.
2. **REST run lifecycle + reads** (§2) over the adapter — stable (§5.1).
3. **WS fan-out** forwarding CoreEvent verbatim (§2.1) — stable/additive.
4. **Studio re-map** — RunList/RunCard/UnitList/SteeringGate/LiveOutput/
   provenance/failure banner + the reconcile-on-connect path (§3) — stable.
5. **Self-healing gate cache + HITL lifecycle** in the daemon (§3.3) — daemon-only,
   no core dependency, so it can land in parallel with 2–4.
6. *(on core-ts terminal methods)* terminal WS channel + xterm.js (§4.2).
7. *(on core `Campaign`+`RunFinished`)* campaign endpoints + DAG view (§4.3) — the
   additive CoreEvent variants mean the WS/studio switch already tolerates them.

Steps 1–5 deliver §11 items 1–10 against a stable surface. Steps 6–7 attach cleanly
because both arrive as **additive** growth (new methods, new CoreEvent variants),
and the one genuinely unstable seam (`subscribe`) is quarantined in step 1.

---

## 6. Risks

- **R1 — WS envelope change breaks the studio's event handling.** Switching from
  `{type, payload, ts}` (`bus.ts:47`) to verbatim CoreEvent frames is a coordinated
  change across `bus.ts` + `useEventStream.ts`. Mitigate: land §5.3 steps 3+4
  together; keep the `wicked-bus` durable tap (`bus.ts:52`) as an independent audit
  path.
- **R2 — gate prompt loss on daemon restart** (§3.3 known limitation). Core doesn't
  persist the prompt. Mitigate: functional gate still works id-only; flag as a
  candidate additive core field.
- **R3 — the FINALIZING `subscribe` signature churns after step 1.** Mitigate: the
  adapter isolation (§5.2) caps the blast radius to one module; treat the fix as a
  one-file follow-up, not a re-point.
- **R4 — premature campaign bridge.** Building a TS-surface scheduler now would be
  throwaway (DES-CAMPAIGN-001 §1). Mitigate: §4.3 — wait for core.
