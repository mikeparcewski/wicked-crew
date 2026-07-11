<!-- Ported 2026-07-11 from the archived wicked-studio repo (branch site/marketing-studio, commits a8e3953/9e722d3, never pushed). Studio now ships as wicked-crew/packages/studio. May overlap crew's DES-STUDIO-{001,COCKPIT-001,SERVING-001} — reconcile. -->

---
name: DES-STUDIO-NAPI-001
title: napi → studio UI wiring — how the wicked-core-ts addon drives wicked-studio v2
status: draft
version: 0.1
date: 2026-07-09
author: mike.parcewski@gmail.com
review-required: true
supersedes-backend-of: REQ-001-studio-overview (§7 "wicked-crew daemon" REST/WS backend)
grounded-in:
  - wicked-core-ts/src/lib.rs (WickedCore napi surface)
  - wicked-core-ts/README.md, smoke.mjs, package.json, Cargo.toml
  - wicked-studio/src/hitl.rs (v1 HITL state machine)
  - wicked-studio/src/main.rs, Cargo.toml (v1 eframe app)
  - wicked-studio/.product/REQ-001-studio-overview.md
  - wicked-core/src/lib.rs (Core engine API — sessions_detail, work_output, confirm_gate)
---

# DES-STUDIO-NAPI-001 — napi → studio UI wiring

## 0. TL;DR

`wicked-core-ts` is a **napi-rs cdylib** (a Node native addon). The only thing that can `require`
it is a **Node process**. REQ-001 already commits wicked-studio v2 to a **React 18 + Vite web app on
localhost** that talks to a backend over **REST + WebSocket**, and names that backend a "wicked-crew
daemon". No such Rust daemon exists. **This design makes the napi addon that backend**: a small Node
host process (`studio-host`) loads `wicked-core-ts.node`, holds a single `WickedCore`, subscribes to
the `CoreEvent` stream, folds it into a session/phase/evidence projection, and re-exposes exactly the
REST+WS contract REQ-001's React frontend already expects. The HITL round-trip is
`CoreEvent::AwaitingHuman` → operator decision → `core.confirmGate(runId, approve, amend?)`.

Scope, stated honestly (review-corrected):
- **The REST/WS *shape* from REQ-001 is preserved; the gate path and event names are NOT verbatim** — §5.3
  drops the `/:phase` URL segment and swaps every `wicked.crew.*` name for a `CoreEvent` tag (Risk R1).
  "Reconciled per §5.3," not "unchanged."
- **`studio-host` is a real adapter service, not "~1 file."** It owns a singleton `WickedCore` lifecycle,
  a single `subscribe` fan-out to many WS clients, the event-sourced fold (§4.3), snapshot-on-connect +
  a 500-event ring (§4.2), the REST + WS servers, static serving, and coded-error mapping (§4.5) — all
  scoped in §4/§7. Small relative to a Rust rewrite, but a service, not a shim.
- **The React SPA does not exist yet — it is built from zero, not "pointed at."** `wicked-studio/` today
  is entirely Rust eframe (no `package.json`, no `index.html`, no `.tsx`); REQ-001's frontend is a draft
  spec, not shipped code. Build step 5 is "author the SPA against `studio-host`," not "wire an existing app."

---

## 1. Architecture reconciliation (the fork you must decide first)

Three concrete states exist in the repo today; they disagree, and the disagreement must be named
before wiring anything:

| Source | Studio shape | How it reaches the engine |
|---|---|---|
| `wicked-studio/src/*` (shipped, `v1.0.0`) | Rust **eframe/egui** desktop app | Depends on `wicked-core` by path (`Cargo.toml:31`). But it does **not** cleanly hold an in-process `Core` handle: `hitl.rs` actually encodes an **RPC-to-crew** responder (`hitl.rs:13` `CoreUnavailable // RPC to wicked-core failed`, and a `hitl.rs:22` comment referencing a nonexistent `HitlSessionExpired CoreEvent`) — i.e. a **third, RPC model**, which is why "the repo disagrees with itself." **No napi.** |
| `REQ-001-studio-overview.md` (draft, 2026-07-07) | **React 18 + Vite** localhost web app | REST + WebSocket to a **"wicked-crew daemon"** (does not exist as code) |
| **This design** | REQ-001's React app, **built from zero** (does not exist as code yet) | REST + WS to a **Node `studio-host`** that loads `wicked-core-ts.node` |

Why the napi addon exists at all: v1 (eframe) needs no napi — Rust links Rust. The napi bridge is
only useful to a **TypeScript** surface. So the napi addon is implicitly a bet on the REQ-001 v2
React app, and this document is where that bet gets an architecture. The "wicked-crew daemon" in
REQ-001 §7/§9 is retconned to mean **`studio-host` + `wicked-core-ts.node`**.

### 1.1 Rejected host models (grounded in what the addon actually is)

- **Tauri Rust command** (the task's framing): rejected. There is no Tauri anywhere in v1 (eframe)
  or REQ-001 v2 (React+Vite served as static files, launched via `npx serve dist` per REQ-001 §7).
  Worse, it's a category error: a Tauri backend is **Rust**, and Rust would link `wicked-core` by
  path directly (exactly as v1's `Cargo.toml` already does) — the **Node** napi addon would be dead
  weight. If studio ever became Tauri, the addon should be dropped in favor of a native
  `#[tauri::command]` over `wicked_core::Core`. napi and Tauri-Rust are mutually exclusive consumers.
- **Load `.node` in the browser**: impossible. Native addons load only in a Node/V8-with-N-API host,
  never in a page context. The React SPA must reach the addon over a transport (WS/HTTP).
- **One `WickedCore` per browser tab / per WS client**: rejected. `WickedCore` holds **one** active
  subscription and a second `subscribe()` *replaces* the first (`lib.rs` `teardown_subscription`
  then re-arm). The host must own a **singleton** `WickedCore` + a **single** `subscribe` callback
  and fan out to N WS clients itself.

### 1.2 Chosen model — `studio-host` (Node adapter)

```
 ┌───────────────────────── studio-host (Node process) ──────────────────────────┐
 │                                                                                │
 │  wicked-core-ts.node  ──require──►  WickedCore (SINGLETON)                      │
 │        ▲  launchRun / confirmGate / resume / cancel / sessions                 │
 │        │  subscribe(cb)  ── tagged-JSON CoreEvent strings, one delivery thread │
 │        │                                                                       │
 │   ┌────┴─────────────┐        ┌──────────────────────────┐                     │
 │   │ command adapter  │        │  event router + PROJECTION│                    │
 │   │ (REST → napi)    │        │  (folds CoreEvent stream) │                    │
 │   └────┬─────────────┘        └──────────┬───────────────┘                     │
 │        │  Express/Fastify                │  ws fan-out                         │
 │   REST /api/v1/*                    WS /api/v1/events                          │
 └────────┼─────────────────────────────────┼────────────────────────────────────┘
          │                                  │
   ┌──────▼──────────────────────────────────▼───────┐
   │  React 18 + Vite SPA  (REQ-001 §7 frontend)      │
   │  TanStack Query (REST)   +   native WebSocket    │
   └──────────────────────────────────────────────────┘
```

- **One OS process.** `studio-host` serves the built SPA statically **and** the API. REQ-001 §7's
  "`wicked-crew serve --ui`" becomes "`studio-host --ui`". Same-machine trust model, localhost only,
  no auth (REQ-001 §3) — unchanged.
- **Event-sourced projection.** Because the napi surface is deliberately thin (no per-session detail
  reader — see §4.3), the host folds the `CoreEvent` stream into an in-memory projection keyed by
  `session` (run id). That projection backs all REST *reads*; `confirmGate` is the only *write* the
  HITL flow needs.
- **The addon is the model, not a cache.** The host owns no SQLite writes (matches REQ-001 §9
  "never writes to SQLite directly"): all mutation goes through the napi command methods, which the
  Rust `Core` single-writer actor serializes.

---

## 2. Requirements

### 2.1 Functional

- **FR-N01 — Load & lifecycle.** `studio-host` loads `wicked-core-ts.node`, constructs
  `new WickedCore(dbPath, /*stub*/ false)` once at boot, and calls `core.close()` on `SIGINT`/
  `SIGTERM`. `stub=true` is selectable via env for CI/dev (drives the deterministic engine).
- **FR-N02 — Single subscription, fan-out.** The host calls `core.subscribe(cb)` exactly once and
  broadcasts each decoded event to all connected `WS /api/v1/events` clients. New clients get a
  replay of the current projection (not the raw historical stream).
- **FR-N03 — Launch.** `POST /api/v1/sessions` maps a body `{problem, workflow?, entityMode?,
  humanConfirm?, sessionId?}` to `core.launchRun(opts)` and returns the run id. To get HITL gates at
  all, the launch UI **must** send `humanConfirm: "all"` or `"before:<ord>"` (default `"none"` runs
  straight through — REQ-001 Flow 1 is impossible without this).
- **FR-N04 — HITL gate resolve.** On `AwaitingHuman{session, ord, prompt}` the UI surfaces the gate;
  the operator's Approve / Reject / Approve-with-conditions maps to
  `core.confirmGate(runId, approve, amend?)` (see §5).
- **FR-N05 — Resume / cancel.** `POST /api/v1/sessions/:id/resume` → `core.resumeRun(id)`;
  `POST /api/v1/sessions/:id/cancel` → `core.cancelRun(id)`.
- **FR-N06 — Session list & detail.** `GET /api/v1/sessions` and `GET /api/v1/sessions/:id` served
  from the projection (§4.3). `core.sessions()` provides the id set for reconciliation on boot.
- **FR-N07 — Evidence.** `GET /api/v1/sessions/:id/evidence` served from per-unit `CliOutputDelta`
  buffers accumulated in the projection, plus gate/decision records (§4.4).
- **FR-N08 — Coded-error surfacing.** The host parses `JSON.parse(err.message).code` from every napi
  call and maps it to an HTTP status + a machine `code` in the JSON body (§4.5). No substring
  matching.
- **FR-N09 — Degraded stream signal.** The host recognizes the synthetic `{type:"Degraded",
  dropped:N}` marker (emitted by the delivery thread on bounded-queue overrun — `lib.rs`
  `TSFN_QUEUE_SIZE = 2048`) and forwards a "live output degraded" indicator to the UI.

### 2.2 Non-functional (traced to REQ-001 §6)

- **NFR-N01 (SC-S01):** first WS event within 5 s of page load — trivially met (in-process addon, no
  network hop; `subscribe` delivers `Heartbeat` on demand via `core.ping()`).
- **NFR-N02 (SC-S02):** gate notification ≤ 2 s after `AwaitingHuman` — the addon delivers on a
  dedicated thread; host→WS is a same-host socket. Budget is dominated by React render, not transport.
- **NFR-N03 (SC-S03):** approve advances the phase ≤ 3 s — `confirmGate` returns the new status
  string **synchronously** (it *is* the ack; see §5.3), and a `Resumed`/`UnitDone` event follows.
- **NFR-N04 (SC-S05):** daemon-unavailable graceful state — if the host crashes, the SPA's WS drops;
  the addon's `unref`'d tsfn means the host process itself exits cleanly rather than hanging.
- **NFR-N05:** single-writer safety — never construct two `WickedCore` over the same `dbPath` in two
  processes (they would race the estate SQLite). Exactly one `studio-host` per db (§8, §10 risk R3).

---

## 3. The consumed napi surface (exact, from `lib.rs`)

The host consumes **only** these exports. This is the whole contract; do not assume more.

### 3.1 Constructor & lifecycle
- `new WickedCore(dbPath: string, stub?: boolean)` — `stub` defaults false (production engine).
- `close()` / `dispose()` / `unsubscribe()` — idempotent teardown (stop+join delivery thread, abort
  tsfn). Also runs on GC/Drop, but the host calls it explicitly on shutdown.
- `ping(): void` — emits a `Heartbeat` to subscribers (liveness probe for SC-S01).

### 3.2 Event stream
- `subscribe(cb: (eventJson: string) => void): void` — one active subscription; a second call
  **replaces** the first. `cb` receives a **tagged-JSON string** per event; `JSON.parse` it.
- Delivery is on a dedicated, **`unref`'d** thread with a **bounded** native queue (2048). On
  overrun it emits `{"type":"Degraded","dropped":N}` instead of growing (FR-N09).

### 3.3 Commands (all may throw a coded error — §4.5)
- `launchRun(opts: LaunchOptions): string` — returns run id. `LaunchOptions = { problem: string,
  workflow?: string, entityMode?: "shared"|"isolated", sessionId?: string,
  humanConfirm?: "none"|"all"|"before:<ord>" }`. Omitted `sessionId` ⇒ a stable, non-empty id is
  **derived** (two omitted launches of the same problem do not collide).
- `confirmGate(runId: string, approve: boolean, amend?: string): string` — resolve a paused gate;
  returns the new status string. `approve=false` cancels the run.
- `resumeRun(runId: string): string` / `cancelRun(runId: string): string` — return status string.
- `sessions(): string[]` — run/session ids currently on the store.

### 3.4 The `CoreEvent` union the UI must model (tagged by `type`)

Hand-mapped in `event_to_json` and pinned by a Rust unit test against drift. The studio-relevant
subset (camelCase keys as emitted):

| `type` | Payload keys | Studio meaning |
|---|---|---|
| `Heartbeat` | — | liveness / connected badge |
| `SessionStarted` | `session, problem` | new run row |
| `UnitPlanned` | `session, ord, description` | a phase node (ord = phase ordinal) |
| `UnitDistributed` | `session, ord, cli` | phase assigned to a worker CLI |
| `UnitExecuting` | `session, ord` | phase InProgress |
| `CliOutputDelta` | `session, ord, chunk` | **streaming worker output → evidence buffer** |
| `GateDecided` | `session, ord, allow` | **automatic governance** decision (not the human gate) |
| `UnitDone` | `session, ord` | phase complete |
| `UnitDenied` | `session, ord` | phase denied by policy |
| `AwaitingHuman` | `session, ord, prompt` | **the human gate — triggers `confirmGate`** |
| `Resumed` | `session, ord` | run resumed after approve |
| `RunCancelled` | `session` | run cancelled (e.g. after reject) |
| `SessionFailed` | `session, ord` | run failed |
| `SessionCompleted` | `session` | run done |
| `Error` | `session` (**nullable** — `Option<String>`, emitted as `"session":null` when absent, `lib.rs:275`), `message` | surfaced error; the SPA must tolerate a null `session` |
| `Degraded`* | `dropped` | *synthetic* — some live output dropped (FR-N09) |
| `Terminal*`, `Campaign*` | (see lib.rs) | out of scope for v2 gate wiring; pass through raw to the event feed |

`*Degraded` is **not** in the Rust variant test (it's synthesized in the delivery thread), so the TS
event-type union must add it by hand.

> **Governance vs human gate — do not conflate (REQ-001 §4 does).** `GateDecided{allow}` is the
> engine's *automatic* policy decision. `AwaitingHuman{prompt}` is the *human* pause, and it only
> occurs when the run was launched with `humanConfirm: "all"|"before:<ord>"`. REQ-001's "governance
> findings" panel is fed by `GateDecided`/`UnitDenied`; the Approve/Reject controls act on
> `AwaitingHuman` via `confirmGate`.

---

## 4. Integration architecture (host internals)

### 4.1 Boot
1. Resolve `dbPath` (the shared estate db) and `stub` from env/args.
2. `const core = new WickedCore(dbPath, stub)`.
3. `core.subscribe(onEventJson)` — the single subscription.
4. Reconcile: `core.sessions()` seeds the projection's known-id set (the raw stream only replays
   forward from subscribe-time; historical runs need `sessions()` + a detail read — see §4.3 gap).
5. Start Express/Fastify (REST) + a `ws` server sharing the port; serve the SPA `dist/` statically.
6. On `SIGINT/SIGTERM`: `core.close()` then exit.

### 4.2 Event router + WS fan-out
`onEventJson(json)` → `const ev = JSON.parse(json)` → `projection.apply(ev)` → `broadcast(ev)` to all
WS clients. A newly-connected client first receives a `snapshot` frame (current projection) then the
live tail. Ring-buffer the last 500 events for the feed (REQ-001 §8).

### 4.3 Session projection (the read model) — and the surface gap it papers over
The napi surface exposes `sessions(): string[]` **only** — no per-session detail. The projection
therefore reconstructs detail by folding the stream per `session`:

```
Session {
  id, problem, status,                     // SessionStarted, then status derived from terminal events
  phases: Map<ord, {                        // UnitPlanned
    description, cli?, state, output: string // UnitDistributed / UnitExecuting|UnitDone|UnitDenied
  }>,
  pendingGate?: { ord, prompt },            // set by AwaitingHuman, cleared by Resumed/RunCancelled
  lastEventAt
}
```
- `GET /api/v1/sessions` → array of `{id, problem, status, currentPhase, lastEventAt}`.
- `GET /api/v1/sessions/:id` → the full `Session` incl. `phases` (the REQ-001 §5 phase graph).

> **Recommended napi extension (see §7 build plan step 6).** wicked-core's lib **already** has
> `sessions_detail() -> Vec<SessionView>` and `work_output(unit_id) -> Option<String>` (`wicked-core/
> src/lib.rs:580,590`) — they are simply **not exposed on the napi surface** yet. Exposing
> `sessionsDetail()` and `workOutput(unitId)` on `WickedCore` would let the host serve session detail
> and evidence on **boot / hard refresh** (historical runs that predate the current subscription),
> instead of relying solely on the forward-only event fold. Until then, detail for pre-existing runs
> is limited to what `sessions()` (ids) plus a fresh subscription can reconstruct.

### 4.4 Evidence (REQ-001 Flow 3)
Per phase, `output` accumulates `CliOutputDelta.chunk` in `ord` order = the worker-output evidence
record. Gate outcome records come from `GateDecided`/`AwaitingHuman`+`confirmGate` result. Large
outputs → truncate+expand or virtual scroll (REQ-001 §8). Full-fidelity historical evidence wants
the `workOutput(unitId)` napi extension (§7).

### 4.5 Error mapping (FR-N08)
Every napi call is wrapped: `try { ... } catch (e) { code = JSON.parse(e.message).code }`.

| napi `code` | HTTP | Meaning |
|---|---|---|
| `RUN_BUSY` | 409 | a step is in flight for that run |
| `RUN_EXISTS` | 409 | a non-terminal run with that id already exists |
| `BAD_HUMAN_CONFIRM` | 400 | malformed/typo'd `humanConfirm` (fails **closed**) |
| `BAD_ENTITY_MODE` | 400 | unrecognized `entityMode` (fails **closed**) |
| `CORE_ERROR` | 500 | any other engine error |
| `PANIC` | 500 | a Rust panic caught across FFI (`guard`) — log loudly |
| (unparseable) | 500 | not a coded error; treat as opaque 500 |

---

## 5. HITL: `AwaitingHuman` → `confirmGate` round-trip

### 5.1 Screens involved
- **Launch/composer** (v1 has a project composer): `POST /api/v1/sessions` with
  `humanConfirm: "all"` (or `before:<ord>`) — otherwise no gate ever fires.
- **Gate panel + sidebar Gates badge** (REQ-001 §5 "⚡ Gates"): rendered from `pendingGate`.
- **Event feed** (REQ-001 Flow 5): raw stream incl. `AwaitingHuman`, `Resumed`, `RunCancelled`.

### 5.2 Sequence
```
Operator launches with humanConfirm:"all"
  POST /api/v1/sessions {problem, workflow:"feature", humanConfirm:"all"}
      host → core.launchRun(opts) → runId (200 {id})
  ... engine plans/distributes/executes ...
  CoreEvent AwaitingHuman{session:runId, ord, prompt}
      host projection.pendingGate = {ord, prompt}; broadcast on WS
      SPA: toast + Gates badge; gate panel shows prompt + governance findings (from GateDecided)
  Operator decides:
    Approve                → POST /sessions/:id/gate/approve            {}         → confirmGate(id,true)
    Approve w/ conditions  → POST /sessions/:id/gate/approve-with-conditions {conditions} → confirmGate(id,true,conditions)
    Reject                 → POST /sessions/:id/gate/reject             {}         → confirmGate(id,false)
      host: status = core.confirmGate(...); returns 200 {status}
  CoreEvent Resumed{session,ord}   (approve)   OR   RunCancelled{session} (reject)
      host clears pendingGate; broadcast; SPA advances phase graph (SC-S03)
```

### 5.3 Mapping REQ-001's gate contract onto the real surface (reconciliation)
REQ-001 §4/§9 used **per-phase** gate endpoints (`/gates/:phase/approve`). The real engine gate is
**per-run, not per-phase**: a paused run has exactly one pending gate, identified by `runId`; the
`ord` comes from the `AwaitingHuman` event, not the URL. Reconcile the REST shape to
`/api/v1/sessions/:id/gate/{approve|reject|approve-with-conditions}` (no `:phase` segment). The
`ord` is informational (for display); `confirmGate(runId, …)` needs only the run id.

REQ-001's **approve-with-conditions** `{conditions}` maps to the napi **`amend`** argument —
`confirmGate(runId, true, conditions)`. Per `lib.rs`, `amend` overrides the **next unit's
instruction** on resume; document to operators that "conditions" are an instruction amendment, not a
free annotation.

### 5.4 Reconciling `hitl.rs`'s richer state machine
v1's `hitl.rs` models `PendingResponse → Submitted → Acknowledged`, plus `TimedOut` (5-min advisory)
and `Expired` (crew hard deadline). Mapping to the napi reality:

- `PendingResponse` = projection has `pendingGate`.
- `Submitted → Acknowledged` collapses into **one** synchronous `confirmGate` call: the returned
  status string **is** the ack (there is no separate ack event/RPC). The React HITL component should
  optimistically show "Submitted", then confirm on the 200 response, then confirm again when the
  `Resumed`/`RunCancelled` event arrives.
- `TimedOut` (studio 5-min advisory) can be a **client-side** timer in the React component; nothing
  in the napi surface enforces it.
- **`Expired` has NO CoreEvent** — there is no `HitlSessionExpired` variant in `event_to_json`. If a
  crew/engine hard-deadline expiry is a real state (v1 `hitl.rs` expects it), it needs a new
  `CoreEvent` variant in wicked-core + a mapping in `lib.rs` `event_to_json`. **Open question OQ-4.**

---

## 6. Screen → napi mapping (complete)

| REQ-001 screen / flow | Data source | napi call / event |
|---|---|---|
| Session list (Flow 2) | projection | `sessions()` (seed) + folded stream; `GET /sessions` |
| Session detail / phase graph (Flow 2) | projection | `UnitPlanned/Distributed/Executing/Done/Denied` fold |
| HITL gate panel (Flow 1) | projection + command | `AwaitingHuman` ▸ `confirmGate(id,approve,amend?)` |
| Governance findings | projection | `GateDecided{allow}`, `UnitDenied` |
| Evidence browser (Flow 3) | projection | `CliOutputDelta` buffers (+ `workOutput` extension) |
| Live event feed (Flow 5) | WS fan-out | raw `CoreEvent` stream (ring buffer 500) |
| Launch / composer | command | `launchRun({problem, workflow, humanConfirm})` |
| Resume / cancel | command | `resumeRun(id)` / `cancelRun(id)` |
| Connected badge (SC-S01) | command + event | `ping()` → `Heartbeat` |
| Worker registry (Flow 4) | **not on napi** | reads council/worker registry file directly — out of scope for napi wiring (OQ-5) |

---

## 7. Packaging & build plan

### 7.1 Packaging the `.node` into `studio-host`
`wicked-core-ts` currently: builds `target/release/lib*.{dylib,so,dll}`, copies it to
`wicked-core-ts.node` (the `npm run build` script), and is `require`d by co-located path in
`smoke.mjs`. `package.json` names `main: index.mjs` but **`index.mjs` does not exist yet** (gap).

Recommended packaging for a localhost dev tool (simplest that works):
1. Add **`index.mjs`** (and a `.d.ts`) to `wicked-core-ts` that `createRequire`-loads the
   co-located `wicked-core-ts.node` and re-exports `WickedCore`, so `import { WickedCore } from
   'wicked-core-ts'` works.
2. `studio-host` depends on it via **`"wicked-core-ts": "file:../wicked-core-ts"`** (path/file dep)
   — no registry publish needed for the monorepo. The prebuilt `.node` ships alongside.
3. Because the `.node` is **platform-specific** and `*.node` is git-ignored, `studio-host`'s build
   must (re)build the addon for the host platform: `cargo build --release && <copy>` (the existing
   `npm run build`). For multi-platform distribution later, migrate to `@napi-rs/cli` with per-OS
   prebuild packages — **not needed for the localhost same-machine v2** (REQ-001 §3, §6 macOS/Chrome).

### 7.2 Phased build plan
1. **Addon consumability**: add `index.mjs` + `index.d.ts` to `wicked-core-ts`; `npm run build`
   produces `.node`; a tiny `require('wicked-core-ts')` from a sibling dir imports `WickedCore`.
2. **studio-host skeleton**: Node + Fastify/Express + `ws`; construct singleton `WickedCore(stub)`,
   `subscribe`, log events. Prove the addon drives from a second process.
3. **Command adapter**: REST endpoints for launch/resume/cancel/gate → napi calls; coded-error
   mapping (§4.5). Drive against `stub=true` (deterministic, CI-safe — mirrors `smoke.mjs`).
4. **Projection + reads**: fold stream into the session model; `GET /sessions`, `GET /sessions/:id`,
   `GET /sessions/:id/evidence`. WS fan-out + snapshot-on-connect + 500-event ring.
5. **Frontend wiring**: point REQ-001's React app at `studio-host`'s REST/WS (drop the `:phase`
   segment per §5.3; add `humanConfirm` to the launch form; add `Degraded` to the event union; render
   the HITL panel off `pendingGate`).
6. **napi surface extension (recommended)**: expose `sessionsDetail()` and `workOutput(unitId)` on
   `WickedCore` (wicked-core lib already has them) so boot/hard-refresh serves historical detail &
   evidence without relying on the forward-only fold. Add a `HitlSessionExpired`/timeout
   `CoreEvent` if the `Expired` state (OQ-4) is real.
7. **Acceptance**: verify SC-S01..S06 end-to-end against `studio-host` + real engine (`stub=false`)
   through the wicked-testing pipeline; record evidence.

---

## 8. Risks

- **R1 — Frontend contract drift.** REQ-001's REST spec (`/gates/:phase/...`, `wicked.crew.*` event
  names) does not match the real surface (per-run gate; `CoreEvent` names). Adopting §5.3 + §3.4
  now, before React is built, avoids a rewrite. **Owner: this doc supersedes REQ-001 §7/§9 backend.**
- **R2 — Forward-only stream.** The projection only sees events **after** `subscribe`. Runs that
  predate boot have no detail until the `sessionsDetail()` extension lands (§7 step 6). Mitigate by
  building step 6 alongside step 4, or by keeping `studio-host` long-lived.
- **R3 — Single-writer.** Two `studio-host` instances (or studio-host + v1 eframe) over the **same
  `dbPath`** race the estate SQLite. Enforce one host per db (lockfile / port bind). NFR-N05.
- **R4 — Degraded stream on high-volume runs.** `CliOutputDelta`/`TerminalOutput` can overrun the
  2048 queue → `Degraded` markers → gaps in evidence. The projection must treat evidence buffers as
  best-effort and surface the degraded indicator; full evidence needs `workOutput()`.
- **R5 — Panic surfacing.** A `PANIC` coded error means a Rust panic was caught across FFI. It's
  recoverable for the call but signals an engine bug; log with the run id and alert, don't swallow.
- **R6 — Native rebuild friction.** `.node` is git-ignored and platform-specific; a fresh clone or a
  different OS must rebuild via `cargo`. CI and dev onboarding must run `npm run build` in
  `wicked-core-ts` before starting `studio-host`.

## 9. Open questions

- **OQ-1** Does v2 supersede v1 (eframe) entirely, or ship alongside? If v1 stays, R3 (two writers)
  is live. REQ-001 §1 says v1 is deprecated on v2 ship — confirm the cutover.
- **OQ-2** Where does the launch UX set `humanConfirm`? Per-launch toggle, workflow-def default, or
  global policy? Without it, no HITL gates fire (FR-N03).
- **OQ-3** Is `entityMode` operator-facing in the launch form, or fixed to `shared`? It fails closed
  on typos (`BAD_ENTITY_MODE`).
- **OQ-4** Is the `Expired` (crew hard-deadline) HITL state real for v2? If so it needs a new
  `CoreEvent` variant + `lib.rs` mapping — it does not exist today (§5.4). ⚠️ Do **not** "resolve" this
  by trusting v1's `hitl.rs:22` comment `(HitlSessionExpired CoreEvent)` — that comment is stale and
  names a variant that is not in `wicked-core/src/event.rs`; it is the *origin* of the confusion, not evidence.
- **OQ-5** Worker registry (Flow 4): read the council/worker registry file directly in the host, or
  expose a `roster()`/`registryRoster()` on the napi surface (`registry_roster()` exists in
  wicked-core but is unexposed)?
- **OQ-6** Campaign/Terminal events are mapped by the addon but unscoped for v2 — pass through to the
  raw feed only, or wire dedicated screens later?
- **OQ-7** Publish strategy: keep `file:../wicked-core-ts` path dep, or publish the addon + per-OS
  prebuilds once distribution beyond the dev machine is needed?
