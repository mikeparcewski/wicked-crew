---
name: DES-002-acp-session-elicitation
title: ACP session/create_elicitation — mid-session human input from MCP servers
status: draft
version: 0.25
date: 2026-08-04
author: eu.gene.lim@accenture.com
review-required: true
depends-on: [
  "@agentclientprotocol/sdk v1.3.0",
  "wicked-core bridge JSON-RPC layer (session/* are bridge convention tokens, not ACP wire methods)"
]
relates-to: [DES-STUDIO-001 §2, REQ-STUDIO-COCKPIT-001 FR-3]
changelog:
  - v0.25: fix gate P2 — client-side reconcile(views) must bump generation for absent
    terminal runs (same as server-side ElicitationCache.reconcile); prevents delayed
    setFromGetIfUnchanged resurrecting zombie prompt for run terminal during GET flight.
    Change reconcile(nonTerminalRunIds) to reconcile(views: SessionView[]).
  - v0.24: fix 2 gate findings — (F1/P1) treat absent mode as form (backward compat):
    change `mode !== 'form'` to `mode != null && mode !== 'form'`; update Non-goals and
    Path B validation; (F3/P2) require `key={elicitationId}` on ElicitationPrompt in
    RunDetail/ChatPanel — React remount prevents stale local state from A bleeding into B.
  - v0.23: fix gate P2 — setFromGet can resurrect stale A if B is resolved+cleared before
    GET response arrives (store empty → no-op check fires incorrectly). Fix: generation-based
    guard: expose getRunGen() + setFromGetIfUnchanged(runId, gen, entry) — snapshot gen before
    GET, apply only if gen unchanged; any ingest/clear/reconcile bumps gen; prevents all stale
    resurrection scenarios. Update rehydration call sequence in useRuns.ts.
  - v0.22: fix 2 gate P1s — (F1) scope concurrent multi-seat same-run elicitations as
    Non-goal: pending_elicitations keyed by run_id, council seat 2 cancels seat 1;
    future work requires (run_id,cli_key) keying; G-1 scoped to single-seat sessions;
    (F2) change setFromGet to compare-and-swap swapFromGet(staleId,entry): 409 recovery
    now replaces stale A with server's B without overwriting a WS-concurrent B.
  - v0.21: fix 2 further gate findings — (F2/P1) rehydration GET must not overwrite a
    WS-delivered store entry: add setFromGet() no-op guard to useElicitationStore; (F3/P2)
    add 409 recovery to ElicitationPrompt: refetch GET on 409 (200→setFromGet, 404→clear)
    so stale prompts clear when server resolved but HTTP response was lost.
  - v0.20: fix 2 further gate findings — (F2/P1) identity-guard Studio clearElicitation:
    only clear if store elicitationId matches submitted id (prevents POST success handler
    from wiping a new WebSocket-delivered elicitation after resolve race); (F3/P2) validate
    required contents: reject required arrays that list anything beyond 'response' — we can
    only return {response:…} so any extra required field would silently violate the schema.
  - v0.19: fix 2 remaining fresh-gate P1s — (F2) relax top-level requestedSchema
    validation to allow canonical ACP form {type:'object', required:[…], properties:{…}};
    add 4 bridge tests (18-21); (F3) add elicitationId to POST body for stale-tab
    detection; route step 4 atomically rejects mismatched elicitationId with 409 and
    restores; add route test 15; ElicitationPrompt passes elicitationId from store entry.
  - v0.18: fix 3 fresh-gate findings — (F1/P1) add Path B terminal cleanup obligation: on
    runCancelled/sessionFailed the actor resolves the one-shot sender in pending_elicitations
    directly (no bridge relay) so exec_turn_acp exits cleanly; (F2/P2) reject unsupported
    top-level requestedSchema keys (e.g. required, additionalProperties) in both bridge and
    Path B — prevents silent schema tightening against route's response.min(1); add bridge
    test 18; (F3/P2) scope G-1 to native/ecosystem adapters only (agy-acp is out of v1).
  - v0.17: fix 4 fresh-gate P2 findings — (F1) add mode/schema validation obligation to
    Path B Rust dispatch before any state change; (F2) key pending_elicitations by run_id
    not elicitation_id; cancel prior same-run request before replacement (supersession);
    (F3) ban elicitationCancelled — require runCancelled for session/new clearing (neither
    cache nor store close set handles a new event type); (F4) fix sequence diagram
    resolveElicitation call to flat (action, response) signature.
  - v0.16: fold wicked-core OQ-1 answers into design; close open questions; surface design
    change — NAPI signature is flat (action:string, response:string|null) not a nested
    result object; resolve OQ-4 (run status is 'executing' during elicitation, confirmed by
    exec_turn_acp turn-loop architecture); document OQ-1(f) accepted gap in risks table;
    reject empty enum with -32602 (gate P2 finding); restore .env.development (gate P1).
  - v0.13: Sol round-2 (F6) — add OQ-1(g) for native-adapter elicitationId ownership in
    wicked-core; (F7) — restore on enum-validation 400 (take runs before enum check); 
    (F8) — reconcile bumps generation for terminal runs even when entry absent (taken).
  - v0.11: Sol review (F1) — scope bridge.mjs changes to agy-acp only; crew/Studio changes
    apply to all adapters; native adapters (Claude, Codex, etc.) handled in wicked-core Rust
    without bridge round-trip. (F2) — add App.tsx, useRuns.ts, RunDetail.tsx, ChatPanel.tsx
    to file map. (F3) — identity-guard route error restore (only restore if cache slot still
    empty). (F4) — reject string schemas with any keyword beyond type+enum; validate enum
    members are strings. (F5) — scope to mode:'form' only; add to Non-goals.
  - v0.10: fix schema validation to also check type:'string'; reorder so schema validation
    runs BEFORE prior-cancel (cancel-then-reject ordering bug); add bridge tests for
    schema-rejection (-32602) and content:null serde case; fix receivedAt ownership
    (ElicitationCache.create stamps, caller omits field); rename hasProps→hasSchema; nit.
  - v0.9: major — scope single-property-response schema as explicit non-goal (reject
    unsupported shapes with -32602); fix content nullish check to `== null` (covers
    serde-serialized null); minor — specify receivedAt is stamped at ingest (daemon clock);
    nit — document unconditional ack on elicitation_resolved as intentional.
  - v0.8: extend OQ-1(e) release obligation to sessionFailed (not just cancel/gate-reject);
    reword P-2 reconcile NOTE to not assert OQ-4's unresolved status; fix
    session/elicitation_resolved to conditionally build result (no content-key when absent);
    note retry-after-500 vacuous-no-op as accepted UX gap.
  - v0.7: fix G-4 to match actual test plan (REST endpoint IS unit-tested);
    add 3 missing bridge tests (supersede-cancel, session/new orphan-cancel,
    identity-guarded delete race); fix file-map test counts (cache→9, route→11);
    note `action:'cancel'` in Zod enum as reserved/future; add OQ-1(f) for
    session/new bridge-cancel CoreEvent obligation; document GET/POST 404 asymmetry
    as intentional; add idempotency note for retry-after-500; note decline
    serialization dependency.
  - v0.6: blocker — add GET /runs/:id/elicitation read route for late-join rehydration;
    majors — add wicked-core cancel obligation to OQ-1 (cancel-run must release bridge
    await); catch-all restore on any resolve failure (not just ElicitationUnsupportedError);
    add OQ-4 on run status during elicitation hold + Studio disambiguation;
    minor — normalise options in ElicitationCache.ingest; add _exit stub requirement to
    bridge test plan; fix "concurrent-session" wording to "same-session".
  - v0.5: blocker — guard post-await delete by identity (prior-cancel race);
    add reconcile call site to GET /runs handler; clarify origination (bridge as
    human-interface delegate); rename reconcile param to nonTerminalRunIds; scope
    multi-client prompt-clear to Non-goals; cancel pendingElicitations on session/new;
    note CoreEvent.type is open string; Array.isArray guard on enum extraction.
  - v0.4: blockers — add currentSessionId to session/new (was missing from file map);
    define reconcile retention as non-terminal runs (not awaiting_human).
    majors — fix resolveElicitation signature to single result obj; cancel prior
    resolver before overwrite; add elicitationId to session/elicitation_resolved;
    enumerate ingest delete-set explicitly (no resumed); narrow G-4 to bridge+cache;
    add route test stubs. minors — pendingElicitations inside closure; note delete-
    before-await; clarify stdin-close replaces existing; add OQ-1d.
  - v0.3: fix cross-process callback; sessionId as key; bridge-mint elicitationId.
  - v0.2: stdio round-trip; no promises in cache; unified elicitationCreated.
  - v0.1: initial draft.
---

# DES-002 — ACP Session Elicitation

## TL;DR

Enable mid-session human questions from MCP servers across all ACP adapter types.

For the **agy-acp adapter** (bridge.mjs): wicked-core routes `elicitation/create` to
the bridge via a private `session/create_elicitation` stdio message; the bridge suspends,
emits `session/elicitation_pending`, and resolves when wicked-core sends
`session/elicitation_resolved`.

For **native/ecosystem adapters** (Claude, Codex, etc.): wicked-core handles
`elicitation/create` directly in the Rust ACP dispatcher — no bridge round-trip.

In both paths, the crew daemon stores the open elicitation in an `ElicitationCache`,
broadcasts it to Studio over `/ws`, and the human responds via `POST /runs/:id/elicitation`
which calls `adapter.resolveElicitation()`. The TypeScript/JS half (crew + Studio) is
adapter-independent and independently testable. wicked-core wires the Rust side.

---

## Context

An ACP-connected agent (Claude Code, etc.) may run MCP servers in its session.
Those servers call `elicitation/create` when they need a human answer. The SDK
(`@agentclientprotocol/sdk` v1.3.0) marks the calls unstable:
`unstable_createElicitation()` / `unstable_completeElicitation()`.

Currently, the bridge (`packages/agent-acp-bridges/bridge.mjs`) handles only
`initialize`, `session/new`, and `session/prompt`. Any `session/create_elicitation`
message falls into the default `-32601 Method not found` branch. There is no path
for mid-session human input.

### Request origination — two paths (adapter-dependent)

**Path A — agy-acp adapter: out of scope for v1.**

`execTurn` spawns the Antigravity CLI with `stdio: ['ignore', 'pipe', 'ignore']` — stdin
is closed. MCP servers running inside Antigravity have no transport to relay
`elicitation/create` to the bridge's stdio channel; the `session/create_elicitation`
handler would be unreachable for real MCP elicitations. agy-acp is therefore scoped out
of v1. The P-1 bridge code changes (`session/create_elicitation`, `session/elicitation_resolved`)
are retained in the spec as a **future** extension point, but wicked-core will NOT dispatch
elicitations to bridge.mjs in v1. A future PR can add a child-to-bridge transport (e.g.
a named pipe or embedded ACP server inside Antigravity) to enable Path A.

**Path B — native/ecosystem adapters (Claude, Codex, etc.) — v1 scope:**

```
MCP server (inside Claude Code, etc.)
  │  MCP protocol (intra-process)
  ▼
Claude ACP layer → wicked-core: elicitation/create            (ACP JSON-RPC)
  │  wicked-core handles directly (no bridge round-trip)
wicked-core → crew: elicitationCreated CoreEvent              (napi)
  ...resolution...
crew → wicked-core: adapter.resolveElicitation()              (napi)
wicked-core → Claude ACP layer: elicitation result            (ACP JSON-RPC)
```

For native/ecosystem adapters, wicked-core handles `elicitation/create` directly in
the Rust ACP dispatcher — it emits `elicitationCreated`, awaits resolution from the
crew REST endpoint, and completes the ACP response without using bridge.mjs at all.
This path is entirely on the wicked-core Rust side (OQ-1).

**In both paths, the crew daemon and Studio changes are identical.** The bridge.mjs
changes in P-1 are agy-acp–specific; P-2 through P-6 apply to all adapter types.

### Existing HITL surface (gate) — reference model

`GateCache` (crew) + `useGateStore` (Studio) + `SteeringGate.tsx` forms the
established gate pattern. Elicitation reuses the fold/ingest/ingest-delete structure
with two differences: (1) resolution travels back to the bridge via stdio, not via
`adapter.confirmGate()`; (2) the prompt carries a typed response schema. The
`reconcile` retention criterion differs from GateCache and is specified explicitly
in P-2 below.

---

## Goals

- **G-1.** Any MCP server running inside a **native/ecosystem ACP adapter session** (Claude,
  Codex, etc. — v1 scope) can ask the human a question and receive a typed answer without
  hanging or erroring. (agy-acp is out of v1 scope; see Non-goals.)
- **G-2.** The bridge handler is independently testable via injected streams — no
  subprocess spawning.
- **G-3.** Studio renders radio buttons (enum) or textarea (free-text) matching the
  existing HITL aesthetic.
- **G-4.** The bridge, `ElicitationCache`, and REST endpoint have unit-test coverage;
  the Studio store and component are covered by compilation + type-checking and manual
  verification (studio component tests are deferred).

## Non-goals

- Timeout / auto-cancel
- Concurrent same-session elicitations (latest held; earlier cancelled — defined behaviour)
- Concurrent multi-seat same-run elicitations: in a council run with multiple ACP seats
  (`cli_key`s), if two seats issue elicitations simultaneously, the first is cancelled when
  the second arrives — one pending elicitation per run at a time. Full multi-seat concurrent
  support requires keying `pending_elicitations` and `ElicitationCache` by `(run_id, cli_key)`
  and is deferred to a future version. G-1 applies to single-seat sessions (the typical case).
- Elicitation audit log
- wicked-core Rust / NAPI changes (specified here; built separately)
- End-to-end automated test (requires wicked-core changes)
- Multi-client prompt sync: when one operator resolves an elicitation, other open tabs
  show the stale prompt until a terminal event clears it. Scoped out; not fixed here.
- ACP `mode:'url'` elicitations: only `mode:'form'` is handled in v1. An absent `mode`
  (null/undefined) is treated as `form` for backward compatibility — some ACP callers omit
  the field. URL-mode and any non-null unknown mode value are rejected with `-32602
  Unsupported mode` before creating any cache state or emitting `session/elicitation_pending`.
- Multi-field or non-string-typed `requestedSchema`: only schemas shaped
  `{ properties: { response: { type: 'string', enum?: string[] } } }` are honored in v1.
  At the top level, only `type`, `required`, and `properties` are allowed — this covers the
  canonical ACP single-field form `{type:'object', required:['response'], properties:{…}}`.
  Any other top-level keyword (e.g. `additionalProperties`, `allOf`, `if`) is rejected.
  If `type` is present it must be `'object'`; if `required` is present it must be an array
  listing only `'response'` — any other required field (e.g. `required:['response','token']`)
  is rejected because the route can only return `{response:…}` and accepting such a schema
  would silently violate it by omitting the extra required property. `type: 'string'` is mandatory on the response property (an enum
  without an explicit `type` is also rejected). Any keyword beyond `type` and `enum` in
  the response property (e.g. `minLength`, `pattern`, `format`, `oneOf`) is also rejected
  to prevent silent downgrade to free-text. All enum member values must be non-empty
  strings; non-string or empty-string members are rejected with the same error (an
  empty-string member would be unreachable via the submit route whose Zod schema requires
  `content.response.min(1)`, leaving an accept path that can never succeed). An empty
  `enum: []` is also rejected — not silently downgraded to free-text — because it would
  allow any string to satisfy a constraint that in fact has no valid values.

---

## Proposal

### Correlation strategy

`session/create_elicitation` carries `sessionId`, `message`, `requestedSchema` (per
task spec). No `elicitationId` is in the request. The bridge mints one (`randomUUID()`)
per elicitation and threads it through all downstream messages (`session/elicitation_pending`,
the cache entry, `adapter.resolveElicitation`, `session/elicitation_resolved`) so the
resolve path can be targeted precisely even if wicked-core never exposes the field on
the wire. The `pendingElicitations` map stores `{ elicitationId, resolve }` by
`sessionId`; a superseding same-session elicitation first validates the incoming schema,
then cancels the orphaned resolver before replacing the slot (schema validation precedes
cancel so an invalid replacement cannot destroy a valid in-flight elicitation).

### P-1. Bridge — two new JSON-RPC cases

All new state (`currentSessionId`, `pendingElicitations`) is **inside the `runBridge`
closure**, beside the existing `sessionCwd` and `pending` locals.

**`session/create_elicitation` (inbound from wicked-core):**

```js
case 'session/create_elicitation': {
  // ACP SDK: unstable — interface may change; pin @agentclientprotocol/sdk version on bump
  // session/create_elicitation is a bridge convention token, not an ACP wire method.
  if (isNotification) {
    console.error('[bridge] session/create_elicitation without an id; ignoring');
    break;
  }
  const { sessionId, message, mode, requestedSchema } = params ?? {};
  if (!currentSessionId || sessionId !== currentSessionId) {
    respondError(id, -32602, `Unknown sessionId: ${String(sessionId)}`);
    break;
  }
  // v1 handles mode:'form'. An absent mode (null/undefined) is treated as 'form' for
  // backward compatibility — some ACP callers omit it. Reject only URL-mode and
  // unknown non-null modes before any state change.
  if (mode != null && mode !== 'form') {
    respondError(id, -32602, `Unsupported mode: ${String(mode)}; only mode:'form' is supported in v1`);
    break;
  }
  // mode:'form' requires a requestedSchema; reject before any state change.
  if (requestedSchema == null) {
    respondError(id, -32602, 'mode:form requires a requestedSchema');
    break;
  }
  // v1 schema constraint: only `{type?:'object', required?:…, properties:{response:{type:'string',enum?:[…]}}}`.
  // Validate BEFORE cancelling any prior elicitation — an invalid replacement must not
  // destroy a valid in-flight elicitation that the human may be mid-answer on.
  // Allow canonical top-level keywords (type, required, properties); reject anything else
  // (e.g. additionalProperties, allOf). This covers the standard ACP single-field schema
  // {type:'object', required:['response'], properties:{response:{type:'string'}}}.
  const allowedTopKeys = new Set(['type', 'required', 'properties']);
  if (Object.keys(requestedSchema).some((k) => !allowedTopKeys.has(k))) {
    respondError(id, -32602, 'Unsupported requestedSchema: only type, required, and properties are supported at the top level in v1');
    break;
  }
  // If type is present, it must be 'object'. Any other value (array, string, …) is rejected.
  if (requestedSchema.type != null && requestedSchema.type !== 'object') {
    respondError(id, -32602, 'Unsupported requestedSchema: top-level type must be "object" if present');
    break;
  }
  // If required is present, it must be an array listing only 'response'.
  // Any other required field (e.g. 'token') cannot be honored — we can only return
  // {response:…}; accepting such a schema would silently violate it.
  if (requestedSchema.required != null) {
    if (!Array.isArray(requestedSchema.required)) {
      respondError(id, -32602, 'Unsupported requestedSchema: required must be an array if present');
      break;
    }
    if (requestedSchema.required.some((r) => r !== 'response')) {
      respondError(id, -32602, 'Unsupported requestedSchema: required may only list "response" in v1');
      break;
    }
  }
  const propKeys = Object.keys(requestedSchema?.properties ?? {});
  if (propKeys.length !== 1 || propKeys[0] !== 'response') {
    respondError(id, -32602, 'Unsupported requestedSchema: only single-property {response} schema is supported in v1');
    break;
  }
  const respSchema = requestedSchema.properties.response;
  if (respSchema?.type !== 'string') {
    respondError(id, -32602, 'Unsupported requestedSchema: response must be type:string');
    break;
  }
  // Reject any keyword beyond type+enum (e.g. minLength, pattern) — prevent silent downgrade.
  const allowedRespKeys = new Set(['type', 'enum']);
  if (Object.keys(respSchema).some((k) => !allowedRespKeys.has(k))) {
    respondError(id, -32602, 'Unsupported requestedSchema: only type and enum keywords are supported on response property in v1');
    break;
  }
  const rawEnum = respSchema.enum;
  // Reject non-array enum (e.g. enum:"yes", enum:{}) — must be an array or absent.
  if (rawEnum != null && !Array.isArray(rawEnum)) {
    respondError(id, -32602, 'Unsupported requestedSchema: enum must be an array of strings');
    break;
  }
  if (Array.isArray(rawEnum) && rawEnum.some((v) => typeof v !== 'string' || v === '')) {
    respondError(id, -32602, 'Unsupported requestedSchema: all enum members must be non-empty strings');
    break;
  }
  // Empty enum is an invalid schema — reject rather than silently downgrading to free-text,
  // which would violate the MCP server's constraint and allow any string to be accepted.
  if (Array.isArray(rawEnum) && rawEnum.length === 0) {
    respondError(id, -32602, 'Unsupported requestedSchema: enum must be non-empty');
    break;
  }
  const options = Array.isArray(rawEnum) ? rawEnum : null;  // null = free-text

  // Cancel any prior pending elicitation for this session before replacing it.
  // Schema is valid at this point — safe to replace.
  const prior = pendingElicitations.get(String(sessionId));
  if (prior) prior.resolve({ action: 'cancel' });
  const elicitationId = randomUUID();    // bridge-minted; stable for this request's lifetime
  let resolveElicitation;
  const p = new Promise((r) => { resolveElicitation = r; });   // capture-once
  pendingElicitations.set(String(sessionId), { elicitationId, resolve: resolveElicitation });
  // ACP SDK: unstable — interface may change; pin @agentclientprotocol/sdk version on bump
  notify('session/elicitation_pending', { sessionId, elicitationId, message, options });
  const result = await p;
  // Identity-guarded delete: cancel path may have already removed this slot
  // for the new session; only delete if it still belongs to this elicitation.
  const cur = pendingElicitations.get(String(sessionId));
  if (cur && cur.elicitationId === elicitationId) pendingElicitations.delete(String(sessionId));
  // Protocol guard: accept MUST carry content.response (content?.response covers null too).
  // Enum conformance (response ∈ options) is the route's responsibility, not the bridge's —
  // the route is the sole resolver in v1; this asymmetry is intentional, not an oversight.
  if (result.action === 'accept' && typeof result.content?.response !== 'string') {
    respondError(id, -32603, 'accept response must carry content.response');
    break;
  }
  respond(id, result);
  break;
}
```

**`session/elicitation_resolved` (inbound from wicked-core):**

```js
case 'session/elicitation_resolved': {
  // ACP SDK: unstable — interface may change; pin @agentclientprotocol/sdk version on bump
  const { sessionId, elicitationId, action, content } = params ?? {};
  const slot = pendingElicitations.get(String(sessionId));
  // Guard on elicitationId to avoid resolving a superseded pending promise.
  if (slot && slot.elicitationId === String(elicitationId)) {
    // Omit the content key when absent — use nullish check (== null) to cover both
    // undefined and an explicit null from serde serialisation; ensures toStrictEqual
    // assertions in tests pass on the pre-serialisation object.
    slot.resolve(content == null ? { action } : { action, content });
  }
  // Ack unconditionally (outside the elicitationId guard) — by design, so that a
  // wicked-core retry of a stale cancel (OQ-1(e) race) acks silently as a no-op
  // rather than requiring wicked-core to distinguish resolved vs ignored.
  if (!isNotification) respond(id, { ok: true });
  break;
}
```

**stdin-close cleanup (replaces the existing `rl.on('close')`):**

```js
rl.on('close', () => {
  stdinClosed = true;
  // Cancel any pending elicitation so its promise settles and pending reaches 0.
  for (const slot of pendingElicitations.values()) slot.resolve({ action: 'cancel' });
  pendingElicitations.clear();
  maybeExit();
});
```

**session/new — add `currentSessionId` capture; cancel any orphaned elicitations:**

```js
case 'session/new': {
  // Cancel pending elicitations from the old session before reassigning.
  for (const slot of pendingElicitations.values()) slot.resolve({ action: 'cancel' });
  pendingElicitations.clear();
  currentSessionId = randomUUID();
  if (params?.cwd) sessionCwd = params.cwd;
  if (!isNotification) respond(id, { sessionId: currentSessionId });
  break;
}
```

**`_streams` and `_exit` injection** (`runBridge` config):
- `_streams?: { input?: Readable, output?: Writable }` — defaults: `process.stdin` / `process.stdout`
- `_exit?: (code: number) => void` — default: `process.exit`
- All internal `send`/`exit` calls route through these handles.

### P-2. `ElicitationCache` — display store, no deferred promises

```typescript
class ElicitationCache {
  /**
   * Store entry; replaces any existing for this runId. Increments the per-run generation.
   * `receivedAt` is stamped by this method (daemon clock, `new Date().toISOString()`);
   * callers pass `Omit<ElicitationEntry, 'receivedAt'>` and must not supply the field.
   */
  create(entry: Omit<ElicitationEntry, 'receivedAt'>): void

  /** Pending entry for a runId, if any. */
  get(runId: string): ElicitationEntry | undefined

  /**
   * Atomically remove the entry for a run and return it with the current generation
   * snapshot. Used by the POST route so it can detect intervening mutations.
   * Returns undefined when no entry exists.
   */
  take(runId: string): { entry: ElicitationEntry; gen: number } | undefined

  /**
   * Restore an entry only if the slot's generation equals the supplied snapshot.
   * Any intervening event (terminal event, new elicitation ingest) increments the
   * generation; restoreIfUnchanged is then a no-op, preventing zombie prompts.
   * Returns true when the entry was actually restored.
   */
  restoreIfUnchanged(runId: string, entry: ElicitationEntry, gen: number): boolean

  /**
   * Fold a CoreEvent. Increments the per-run generation on every slot mutation.
   * Opens on:   elicitationCreated — normalise options: event.options ?? null
   *             so undefined never reaches ElicitationPrompt or the route enum check.
   * Closes on:  sessionCompleted | runCancelled | sessionFailed — deletes entry AND bumps gen.
   * NOT closed by: resumed  (a resumed run may still have an unanswered elicitation)
   * The gen bump on close is what makes restoreIfUnchanged a no-op after terminal events.
   */
  ingest(event: CoreEvent): void

  /**
   * Prune entries whose run is in a terminal state. Also bumps the per-run generation
   * for every terminal run ID found in `views`, even if its entry is currently absent
   * (e.g. temporarily taken by an in-flight POST). This ensures a subsequent
   * restoreIfUnchanged for that run is a no-op even when the terminal CoreEvent was
   * missed and reconcile is the first signal of the terminal state.
   *
   * Retention criterion: retain when status ∉ { completed, cancelled, failed }.
   * NOTE: differs from GateCache which retains only awaiting_human. Elicitation-holding
   * runs are retained regardless of whether core reports them as `executing` or
   * `awaiting_human` (see OQ-4) — both fall outside the terminal set, so the retention
   * criterion is correct under either answer.
   */
  reconcile(views: SessionView[]): void
}
```

Key is crew `runId` (from `event.session`, consistent with GateCache). The ACP
`sessionId` minted by the bridge is a different namespace; wicked-core bridges them
when it emits `elicitationCreated` (using the crew runId in `event.session`).

```typescript
interface ElicitationEntry {
  runId:         string;
  elicitationId: string;   // bridge-minted, threaded via wicked-core
  message:       string;
  options:       string[] | null;  // null = free-text
  receivedAt:    string;           // ISO-8601; stamped by ElicitationCache.create at ingest (daemon clock)
}
```

`options` is typed `string[] | null` throughout — CoreEvent field is
`options?: string[] | null` (the `seated?: number | null` convention).
The Studio store normalises `event.options ?? null` at the ingest boundary
so `undefined` never reaches `ElicitationPrompt`.

### P-3. REST endpoints

**Read route (late-join rehydration — mirrors `GET /runs/:id/gate`):**

```
GET /api/v1/runs/:id/elicitation

Responses:
  200  { runId, elicitationId, message, options: string[] | null, receivedAt }
  404  no pending elicitation for this run (or run not found)
```

Studio calls this on run open / page refresh, mirroring the existing `GET /runs/:id/gate`
pattern. Allows a browser that missed the live `elicitationCreated` WebSocket frame to
rehydrate `useElicitationStore` and render `ElicitationPrompt`.

**Rehydration guard**: the GET response must only be applied if the store currently has
**no entry** for the run. A WebSocket-delivered `elicitationCreated` event for the same
run (arrival ordering: WS can win the race with a concurrent GET) represents the more
recent server state. Overwriting a WS-delivered entry with a GET response could replace
elicitation B with elicitation A, causing a 409 on submission and leaving B inaccessible
until the next manual refresh.

`useElicitationStore` exposes a monotone per-run generation counter and two guarded write
operations for the GET response:
- `getRunGen(runId: string): number` — current mutation generation for the run's slot
  (0 if no entry and no prior mutations). Every ingest, clear, swapFromGet, and reconcile
  action that touches the slot increments this counter.
- `setFromGetIfUnchanged(runId: string, gen: number, entry: ElicitationEntry): void` —
  only applies the GET response if the run's generation still equals `gen` (no intervening
  mutations). Callers snapshot `getRunGen()` before issuing the GET. This prevents a stale
  GET response from resurrecting a cleared elicitation when the sequence is:
  GET starts (gen=G) → WS delivers B (gen=G+1) → B resolved+cleared (gen=G+2) →
  GET responds → gen=G+2 ≠ G → no-op (correct; A is not resurrected).
  Also prevents overwriting a WS-delivered entry that arrived before the GET response.
- `swapFromGet(staleId: string, entry: ElicitationEntry): void` — compare-and-swap:
  only replaces the current entry if its `elicitationId` matches `staleId`. Used in the
  409 recovery path (see ElicitationPrompt below).

**Rehydration call sequence** (in `useRuns.ts` or `useElicitationStore` on run open):
```typescript
const gen = elicitationStore.getRunGen(runId);
const elicitation = await api.getElicitation(runId).catch(() => null);
if (elicitation) elicitationStore.setFromGetIfUnchanged(runId, gen, elicitation);
```

**Submit route:**

```
POST /api/v1/runs/:id/elicitation

Body (Zod strict):
  { elicitationId: string, action: 'accept' | 'decline' | 'cancel', content?: { response: string } }
  .refine: action==='accept' → content present and response non-empty (min 1)
  .refine: action!=='accept' → content absent
  Note: `action:'cancel'` is reserved for a future "Dismiss" affordance in
  ElicitationPrompt; the current component never sends it (Cancel run uses
  `api.cancelRun()` instead). The Zod enum accepts it so future callers
  do not require a schema change.

  `elicitationId` is used to atomically detect stale-tab submissions: if the body's
  elicitationId does not match the current cache entry's elicitationId (a newer same-run
  elicitation replaced it, or it was already resolved), the route restores and returns 409.
  ElicitationPrompt reads elicitationId from the store entry and includes it in every POST.

  When entry.options !== null and action==='accept':
    content.response MUST be one of entry.options  →  400 if not

Responses:
  200  { status: 'resolved' }
  400  validation failure (Zod or enum-conformance)
  404  run not found
  409  no pending elicitation for this run, or elicitationId mismatch (stale submission)
  501  elicitation resolve not supported in this wicked-core build
  500  unexpected adapter error (entry restored; prompt remains visible and retryable)

GET returns 404 for both "run not found" and "no pending elicitation" — the distinction
is irrelevant for rehydration: if there is nothing to show, 404 is correct either way.
POST uses 404/409 separately so optimistic-concurrency logic can distinguish "wrong run"
from "someone already answered it". This asymmetry is intentional.
```

Route logic (ordering prevents double-submit races):
1. Zod validate body (includes `elicitationId`)
2. Check run exists (`sessionsDetail`)
3. `taken = elicitationCache.take(id)` → 409 if `taken` is undefined
   (`take` atomically removes the entry and captures the current generation snapshot)
4. Identity check: if `body.elicitationId !== taken.entry.elicitationId` →
   call `restoreIfUnchanged(id, taken.entry, taken.gen)`, return 409
   (stale-tab rejection: a superseded elicitation replaced it; the newer prompt is restored)
5. Enum check when applicable (`taken.entry.options !== null`):
   - If `content.response ∉ taken.entry.options` → call `restoreIfUnchanged(id, taken.entry, taken.gen)` first, then return 400
   (the entry was taken; without restore the prompt disappears and subsequent submissions return 409)
6. Try `adapter.resolveElicitation(id, taken.entry.elicitationId, result)`:
   - On `ElicitationUnsupportedError`: call `elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen)`, return 501
   - On **any other error**: same `restoreIfUnchanged`, return 500

   **Generation-guarded restore**: `restoreIfUnchanged` only restores when the slot's
   generation still matches `taken.gen`. Terminal events (`sessionCompleted`, `runCancelled`,
   `sessionFailed`) and new `elicitationCreated` events all bump the generation; after any
   such event the restore is a no-op, preventing zombie prompts for completed/cancelled/failed
   runs and preventing overwrite of a newer elicitation.

   `take` also protects against double-submit: a concurrent POST on the same run finds
   `take` returning undefined → 409.

   Retry-after-500: if the first call reached the bridge before the transport failed, a
   re-issued `resolveElicitation` is a guarded no-op (`elicitationId` no longer matches).
   **Accepted UX gap:** the retry still returns `{status:'resolved'}` (entry was taken,
   restore succeeded, then deleted again on the second attempt); no double-delivery, but no
   confirmation of which answer won.
7. Return `{ status: 'resolved' }`

`registerRoutes` gains `elicitationCache: ElicitationCache` parameter.

### P-4. `adapter.resolveElicitation`

The NAPI signature uses **flat params** — consistent with `confirmGate(approve: bool, amend: Option<String>)` and avoiding NAPI struct serialisation friction:

```typescript
// ACP SDK: unstable — interface may change; pin @agentclientprotocol/sdk version on bump
async resolveElicitation(
  runId: string,
  elicitationId: string,
  action: string,          // 'accept' | 'decline' | 'cancel'
  response: string | null, // the selected/typed value; non-null only when action='accept'
): Promise<void> {
  // Deferred: throws until wicked-core binds the NAPI method.
  throw new ElicitationUnsupportedError(
    'resolveElicitation is not yet bound in this wicked-core build'
  );
}
```

**⚠ Design change from earlier drafts**: the signature is flat `(action, response)` rather
than a nested `result: { action, content?: { response } }` object. The route must
decompose its validated result before calling the adapter:

```typescript
const response = result.action === 'accept' ? (result.content?.response ?? null) : null;
await adapter.resolveElicitation(id, taken.entry.elicitationId, result.action, response);
```

`ElicitationUnsupportedError` follows the `ChatUnsupportedError` class pattern.

### P-5. `server.ts` wiring

```typescript
const elicitationCache = new ElicitationCache();

adapter.onEvent((event) => {
  gateCache.ingest(event);
  elicitationCache.ingest(event);  // ← new
  terminals.route(event);
  broadcast(event);                // verbatim fan-out → Studio receives elicitationCreated
});

registerRoutes(app, adapter, gateCache, elicitationCache);
```

### P-6. Studio store and component

**`useElicitationStore`** (`src/store/elicitations.ts`): Zustand store.
- Opens on `elicitationCreated`; bumps per-run generation on every slot mutation
- Closes on `sessionCompleted` | `runCancelled` | `sessionFailed` (NOT on `resumed`); bumps gen
- `reconcile(views: SessionView[])` — prunes entries for terminal runs AND bumps the
  generation for **every terminal run ID** found in `views`, even if no entry is currently
  present (mirrors the server-side `ElicitationCache.reconcile()` spec). This prevents a
  delayed `setFromGetIfUnchanged` call from resurrecting a zombie prompt for a run that
  became terminal while the GET was in-flight but held no entry at reconcile time.
- `getRunGen(runId: string): number` — monotone mutation counter for the run's slot (0 if untouched)
- `setFromGetIfUnchanged(runId: string, gen: number, entry: ElicitationEntry): void` — see P-3 rehydration guard
- `swapFromGet(staleId: string, entry: ElicitationEntry): void` — CAS by elicitationId; see P-3 409 recovery
- `clearElicitation(runId: string, elicitationId: string): void` — **identity-guarded**: only
  removes the entry if the current store entry's `elicitationId` matches the supplied one.
  This prevents a concurrent WebSocket-delivered new elicitation from being wiped by the
  success handler of an earlier POST (race: POST success fires after WS delivers next prompt).

**`ElicitationPrompt`** (`src/components/ElicitationPrompt.tsx`):
Props `{ runId, elicitationId, message, options: string[] | null, onResolved? }`.
**Must be rendered with `key={elicitationId}`** in all parent components (RunDetail, ChatPanel).
React remounts the component on key change, so local state (response textarea value,
loading flag, error message) is automatically reset when a superseding elicitation B
replaces A — preventing a free-text answer typed for A from bleeding into the B prompt.
- Radio group when `options !== null` (required: must be one of the enum values)
- Textarea when `options === null` (required: non-empty to enable **Respond**)
- **Respond** (`action:'accept'`): sends `{ elicitationId, action:'accept', content:{ response } }`
- **Decline** (`action:'decline'`): sends `{ elicitationId, action:'decline' }`; no `content`
- **Cancel run**: calls `api.cancelRun(runId)`; distinct from protocol actions;
  elicitation cleared when terminal CoreEvent arrives via store ingest
- Loading/error states with `data-testid`; on success: `clearElicitation(runId, elicitationId)`, `onResolved?.()`
  (identity-guarded — no-op if a new elicitation arrived before the handler fired)
- **409 recovery** (lost HTTP response / stale-id race): on POST returning 409, the
  component issues `GET /runs/:id/elicitation`:
  - 200: call `swapFromGet(elicitationId, entry)` — compare-and-swap: replaces entry A
    with the server's current entry B, but only if the store still holds A (does not
    overwrite a WS-delivered entry that arrived concurrently and already has B's id).
    The component re-renders with the updated prompt automatically.
  - 404: call `clearElicitation(runId, elicitationId)` (identity-guarded) — already
    resolved server-side; prompt disappears.
  This prevents a stale prompt from persisting indefinitely when the server resolved
  the elicitation but the HTTP response was lost (transport failure, timeout).

---

## Component flow

### Path A — agy-acp adapter (bridge.mjs)

```mermaid
sequenceDiagram
    participant MCP as MCP Server
    participant AG  as Antigravity ACP layer
    participant WC  as wicked-core (Rust)
    participant BR  as bridge.mjs subprocess
    participant CR  as crew daemon
    participant ST  as Studio
    participant HU  as Human

    MCP->>AG: elicitation/create {mode:'form', message, requestedSchema}
    AG->>WC: elicitation/create              (ACP JSON-RPC)
    WC->>BR: session/create_elicitation      (stdio JSON-RPC ↓)
    BR->>BR: validate mode/schema/sessionId; mint elicitationId
    BR->>WC: session/elicitation_pending     (notification stdio ↑)
    WC->>CR: elicitationCreated CoreEvent    (napi)
    CR->>CR: ElicitationCache.ingest → entry stored
    note over CR,ST: broadcast(event) is verbatim fan-out
    ST->>HU: ElicitationPrompt (radio / textarea)
    HU->>ST: selects response; clicks Respond
    ST->>CR: POST /runs/:id/elicitation {action:'accept', content}
    CR->>CR: validate; take(entry, gen); try adapter
    CR->>WC: adapter.resolveElicitation(runId, elicitationId, action, response)
    WC->>BR: session/elicitation_resolved {sessionId, elicitationId, action, content}
    BR->>BR: guard elicitationId; resolve pending promise
    BR->>WC: JSON-RPC response {action, content}   (stdio ↑)
    WC->>AG: elicitation result              (ACP JSON-RPC)
    AG->>MCP: elicitation result
```

### Path B — native/ecosystem adapters (Claude, Codex, etc.)

Path B shares the crew daemon, REST, and Studio components (from `CR` onward above).
The only difference: wicked-core handles `elicitation/create` directly in the Rust ACP
dispatcher — no `session/create_elicitation` or `session/elicitation_pending` messages,
no bridge subprocess involved.

```
Native adapter → wicked-core: elicitation/create        (ACP JSON-RPC)
wicked-core:  emits elicitationCreated CoreEvent         (napi)
              awaits resolution from crew REST
wicked-core → native adapter: elicitation result        (ACP JSON-RPC)
```

---

## Alternatives considered

### A-1. In-process `onElicitation` callback

Injected into `runBridge`. Mockable in tests; ships to a dead end in production
because `runBridge` executes in a spawned subprocess and the crew daemon is a
different process. **Rejected: cannot work in production.**

### A-2. Bridge polls the crew daemon via HTTP

Requires the bridge to know the daemon's port (unknown at spawn), adds a polling
loop, couples a headless process to the HTTP layer. The stdio channel already exists
bidirectionally. **Rejected.**

### A-3. `elicitationId` as wire-provided correlation key

Use an `elicitationId` wicked-core provides in `session/create_elicitation`. Cleaner
for true concurrent elicitations. Not confirmed in the task spec's request shape.
**Deferred:** bridge mints it instead; if wicked-core exposes it on the wire,
migrate to using the provided value as the key.

### A-4. Deferred promise in ElicitationCache

Store `Promise<ElicitationResult>` in the daemon cache; route resolves it. Cannot push
the result back to the bridge subprocess without going through wicked-core anyway.
Adds promise plumbing for no gain. **Rejected.**

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `session/elicitation_resolved` never sent by wicked-core | HIGH | stdin-close cleanup cancels; OQ-1(e) confirmed required: wicked-core MUST send cancel on `{runCancelled,sessionFailed}` transitions |
| Daemon restart while elicitation pending | HIGH | **Accepted gap** — no durable log; MCP server errors when bridge restarts |
| ACP SDK `unstable_*` token changes on bump | MEDIUM | All call sites carry the stability comment; SDK version pinned |
| Concurrent same-session elicitations | MEDIUM | Prior resolver cancelled explicitly before replacement; not silent |
| Studio store entries not pruned on run end without terminal event | LOW | `reconcile()` on `GET /runs`; non-terminal retention criterion; `reconcile` bumps generation for absent terminal runs |
| stale ElicitationCache entry after `session/new` bridge-cancel | MEDIUM | wicked-core MUST emit `runCancelled` for the old run on `session/new` (see Rust implementation notes); `elicitationCancelled` must NOT be used — it is not in the cache or store close sets |
| Out-of-enum response submitted | LOW | Route validates `content.response ∈ entry.options`; 400 |
| `content` present on `decline`/`cancel` | LOW | Zod `.refine` forbids it; bridge guard is belt-and-braces |
| Double-submit race on `POST /runs/:id/elicitation` | LOW | `take()` atomically captures entry; concurrent POST finds `take()` returning undefined → 409 |

---

## Wicked-core implementation notes

All items below are validated against wicked-core source.

### Rust dispatch (Path A — agy-acp)

**File**: `src/acp_runner.rs` — `exec_turn_acp` (free function, line 533) and its caller
`AcpStepRunner::exec_turn` (line 1305). No new Rust file needed; elicitation state lives
inside the existing per-`(run_id, cli_key)` session machinery.

The turn loop in `exec_turn_acp` reads every line from `line_rx` (bridge stdout pipe).
A new arm handles inbound `elicitation/create` requests (which arrive with a JSON-RPC id):
- wicked-core calls `rpc_send` to write `session/create_elicitation` to the bridge's stdin
- re-enters the line loop until `session/elicitation_pending` arrives (a notification, no id)
- parses `{ sessionId, elicitationId, message, options }` and emits:

```rust
emit_ev(CoreEvent::ElicitationCreated {
    session:        run_id.clone(),
    elicitation_id,
    message,
    options,   // Option<Vec<String>>; None = free-text
});
```

`AcpStepRunner::exec_turn` passes the emit callback `|ev| { let _ = self.tx.send(Command::EmitEvent(ev)); }` into `exec_turn_acp` — same injection point used for text deltas.

**New CoreEvent variant** (add to `src/event.rs`):

```rust
/// An MCP server inside an ACP session asked the human a question.
ElicitationCreated {
    session:        String,
    elicitation_id: String,
    message:        String,
    options:        Option<Vec<String>>,  // None = free-text
}
```

JSON serialisation: `{ "type": "elicitationCreated", "session": "…", "elicitationId": "…", "message": "…", "options": ["a","b"] }`.

### Rust dispatch (Path B — native/ecosystem adapters)

**Validation obligation (required before any state change)**: Path B is the only v1 runtime
path; wicked-core must enforce the same constraints as the bridge before minting an ID or
emitting `ElicitationCreated`:
- Treat absent mode as `form` (backward compat); reject only non-null non-form mode values (`-32602`)
- Reject absent `requestedSchema` (mode:'form' requires it)
- Reject any unsupported top-level `requestedSchema` key (allow only `type`, `required`, `properties`); validate `type` = 'object' if present; validate `required` is an array listing only `'response'` if present (reject multi-field required)
- Reject schemas not shaped `{properties:{response:{type:'string',enum?:[…]}}}`
- Reject extra keywords on the response property (anything beyond `type` + `enum`)
- Reject non-array, empty-array, or empty-string-member enum values

Violation returns an ACP error to the MCP server; no `ElicitationCreated` is emitted.

**Supersession**: `pending_elicitations` is keyed by **`run_id`** (not `elicitation_id`),
mirroring the bridge's `pendingElicitations` map. When a new `elicitation/create` arrives
for a run that already has a pending entry, wicked-core cancels the prior one-shot sender
(resolves with `action: cancel`) before replacing the slot — enforcing the "latest held;
earlier cancelled" invariant. Without this, the first request has no UI or REST path to
resolve it and hangs indefinitely.

wicked-core mints `elicitation_id = uuid::Uuid::new_v4().to_string()` after validation and
supersession, stores `(run_id → (elicitation_id, oneshot::Sender<ElicitationResult>))` in
`pending_elicitations: Arc<Mutex<HashMap<String, (String, Sender<…>)>>>`, emits
`CoreEvent::ElicitationCreated`. Continues draining `line_rx` using **`select!`** between
`line_rx` and the resolution receiver — **NOT `try_recv` polling**. When the native adapter
goes quiet waiting for human input, the turn loop blocks on `line_rx.recv()` and there is
no next iteration on which polling would fire. Using `select!` ensures resolution wakes the
loop without busy-waiting or deadlocking.

On resolution: respond to the original `elicitation/create` ACP request.
On `Command::ResolveElicitation`: actor looks up `(run_id, elicitation_id)` in
`pending_elicitations`; posts result to the sender only if `elicitation_id` matches the
current slot (identity guard against stale resolves).

**Key invariant**: the `elicitationId` in `elicitationCreated` → `resolveElicitation(runId, elicitationId, action, response)` is the one wicked-core minted — distinct from the ACP wire request's JSON-RPC `id`.

### NAPI `resolveElicitation` signature

Flat params, modelled on `confirm_gate(approve: bool, amend: Option<String>)`:

```rust
#[napi(ts_return_type = "Promise<void>")]
pub fn resolve_elicitation(
    &self,
    run_id:         String,
    elicitation_id: String,
    action:         String,          // "accept" | "decline" | "cancel"
    response:       Option<String>,  // non-null only when action="accept"
) -> AsyncTask<CoreTask>
```

Sends `Command::ResolveElicitation` to the actor, which routes to `AcpStepRunner`'s pending map.

### `session/elicitation_resolved` is a request (with id)

wicked-core sends it as a JSON-RPC request with an id, waits for the unconditional `{ok:true}` ack (bridge always acks regardless of elicitationId guard — idempotent no-op for stale cancels):

```rust
// In exec_turn_acp, after elicitation result is ready:
rpc_send(&mut proc.stdin, resolved_id, "session/elicitation_resolved",
    json!({ "sessionId": session_id, "elicitationId": elicitation_id,
            "action": action, "content": content }))?;
let _ = rpc_expect(&proc.line_rx, resolved_id, resolve_ack_timeout());
```

### Terminal-without-resolution obligation

**Required for both paths** on any transition into `{runCancelled, sessionFailed}`:

**Path A (agy-acp)**: wicked-core MUST send `session/elicitation_resolved { action: 'cancel' }` to the bridge before dropping the session. Implementation scope:
- `Command::CancelRun` actor handler: send cancel resolution before `AcpStepRunner::drop_session`
- `SessionFailed` emission path (wherever `fail_run` is called): same obligation
- Mechanism: `pending_elicitations: Arc<Mutex<HashMap<String, CancelHandle>>>` on `AcpStepRunner`; actor can post cancel without holding the `AcpProcess` lock

The `sessionFailed` case is critical — a governance deny or worker panic marks the session Failed while the bridge is still alive; `rl.on('close')` does NOT fire, so the bridge `await p` hangs without this obligation.

**Path B (native/ecosystem adapters)**: there is no bridge to relay `session/elicitation_resolved`, so the actor must resolve the one-shot sender directly. On `{CancelRun, SessionFailed}`, the actor posts `action:'cancel'` to the one-shot sender in `pending_elicitations` (keyed by `run_id`), then removes the entry. This allows `exec_turn_acp`'s `select!` to wake up, respond to the original `elicitation/create` ACP request with `action:'cancel'`, and exit cleanly — without leaving the native turn loop blocked indefinitely after the run becomes terminal.

### `session/new` bridge-cancel — required clearing event

When `session/new` starts a new session, any in-flight elicitation from the prior session
is cancelled by the bridge. wicked-core MUST emit **`runCancelled { session: old_run_id }`**
(the existing terminal event) for the old run so the crew daemon's `ElicitationCache`
drops the stale entry via its existing `runCancelled` close path.

A new `elicitationCancelled` event type must **not** be used here: neither
`ElicitationCache.ingest` nor the Studio store's documented close set
(`sessionCompleted | runCancelled | sessionFailed`) handles it, so the stale prompt would
persist regardless. Use `runCancelled` — the old run is already terminal at this point,
and `runCancelled` is already in both close sets.

Without this, the stale entry persists **indefinitely**, not just until the next polling
interval: `reconcile()` retains non-terminal runs (status = executing), so the old run's
stale elicitation prompt remains until that run itself terminates. This is an unbounded
gap, not an acceptable one.

### Run status during pending elicitation — resolved

**`executing`** (confirmed by the `exec_turn_acp` turn-loop architecture): during an elicitation, the turn loop is still active and draining `line_rx`; the session never enters `awaiting_human`. Consequence: `SteeringGate` does not render independently for an elicitation-holding run. The Studio deconfliction rule (suppress `SteeringGate` when `useElicitationStore` has an entry for the run) is still required as a belt-and-braces guard, not a correctness necessity.

### Durable event log

Open: should `elicitationCreated`/`elicitationResolved` appear in the durable event log?
If yes, a daemon restart could rebuild open elicitations (FINDING-051 model), eliminating
the HIGH restart gap. Not required for v1.

---

## Test plan

### Bridge (`packages/agent-acp-bridges/tests/bridge-elicitation.test.mjs`)

Tests beside the code they exercise. Import `runBridge` from `'../bridge.mjs'`.
Inject `PassThrough` streams via `_streams` **and a spy `_exit`** via `_exit`.
Every test must inject a spy `_exit`; without it, a stream-close triggers `process.exit`
and kills the vitest runner. Package gets a `vitest` devDependency
and `"test": "vitest run"` script. No subprocess spawning.

| # | Drive | Assert |
|---|---|---|
| 1 | `session/new`; `session/create_elicitation`; `session/elicitation_resolved {action:'accept', content:{response:'yes'}}` | Response `{action:'accept', content:{response:'yes'}}` |
| 2 | Same; `session/elicitation_resolved {action:'decline'}` | Response `{action:'decline'}` (no `content`) — construct result without `content` key; do not rely on JSON eliding `undefined` |
| 3 | `requestedSchema.properties.response.enum = ['a','b']` | `session/elicitation_pending` carries `options:['a','b']` |
| 4 | `requestedSchema` without `enum` | Notification carries `options:null` |
| 5 | `session/create_elicitation` without prior `session/new` | Error `{code:-32602}` |
| 6 | `session/create_elicitation`; close input stream | Response `{action:'cancel'}`; spy `_exit` called |
| 7 | Two `session/create_elicitation` for same session (supersede) | First request gets `{action:'cancel'}`; second gets `{action:'accept', …}` when resolved; `session/elicitation_pending` carries the new `elicitationId` |
| 8 | `session/create_elicitation`; then `session/new` mid-elicitation | First request gets `{action:'cancel'}`; new session ID is returned; new requests work normally |
| 9 | Prior-cancel race: supersede then immediately resolve with old `elicitationId` | New slot is NOT deleted; second resolved value arrives for new request normally |
| 10 | `requestedSchema` with multi-field props `{response:{…},extra:{…}}` | Error `{code:-32602}`; prior in-flight elicitation is NOT cancelled |
| 11 | `requestedSchema.properties.response.type = 'number'` | Error `{code:-32602}` |
| 12 | `session/elicitation_resolved {action:'decline', content:null}` | Resolved result has no `content` key (`toStrictEqual({action:'decline'})`) |
| 13 | `mode:'url'` request | Error `{code:-32602}`; no `elicitation_pending` emitted |
| 14 | `requestedSchema.properties.response = {type:'string',minLength:1}` | Error `{code:-32602}` (extra keyword) |
| 15 | `requestedSchema.properties.response.enum = ['a',1,'b']` | Error `{code:-32602}` (non-string enum member) |
| 16 | `mode:'form'` with no `requestedSchema` (null) | Error `{code:-32602}`; prior elicitation NOT cancelled |
| 17 | `requestedSchema.properties.response.enum = "yes"` (string, not array) | Error `{code:-32602}` |
| 18 | `requestedSchema = { type:'object', required:['response'], properties:{response:{type:'string'}} }` | Accepted as canonical ACP form; `session/elicitation_pending` emitted |
| 19 | `requestedSchema = { additionalProperties: false, properties:{response:{type:'string'}} }` | Error `{code:-32602}` (unsupported top-level keyword); prior elicitation NOT cancelled |
| 20 | `requestedSchema = { type:'array', properties:{response:{type:'string'}} }` | Error `{code:-32602}` (top-level type must be 'object') |
| 21 | `requestedSchema = { required: 'response', properties:{response:{type:'string'}} }` | Error `{code:-32602}` (required must be an array if present) |

### `ElicitationCache` (`packages/crew/tests/elicitation-cache.test.ts`)

| # | Scenario |
|---|---|
| 1 | `create(entry)` → `get(runId)` returns it |
| 2 | `take(runId)` → `{entry, gen}` when present; `undefined` for unknown |
| 3 | `get(runId)` → undefined after `take` |
| 4 | Second `create()` for same runId replaces the first |
| 5 | `ingest({type:'sessionCompleted', session:runId})` → entry deleted |
| 6 | `ingest({type:'resumed', session:runId})` → entry NOT deleted |
| 7 | `ingest({type:'elicitationCreated', session:runId, elicitationId, message, options:['a']})` → entry stored |
| 8 | `reconcile()` drops entries for terminal-status runs; retains executing runs |
| 9 | `ingest({type:'elicitationCreated', ..., options: undefined})` → `entry.options === null` (normalised) |
| 10 | `take(runId)` returns entry+gen; `reconcile([{ session: { id: runId, status: 'completed', …}, units: [] }])` while entry absent → `restoreIfUnchanged(runId, entry, gen)` returns false (F8: reconcile bumps gen for absent terminal runs; use a valid SessionView fixture) |

### REST endpoint (`packages/crew/tests/elicitation-route.test.ts`)

| # | Scenario |
|---|---|
| 1 | GET: pending elicitation present → 200 with entry fields |
| 2 | GET: no pending elicitation → 404 |
| 3 | POST: no pending elicitation → 409 |
| 4 | POST: run not found → 404 |
| 5 | POST: valid accept with free-text → 200 (`adapter.resolveElicitation` stub) |
| 6 | POST: valid decline → 200 |
| 7 | POST: accept without content → 400 |
| 8 | POST: decline with content present → 400 |
| 9 | POST: accept with value not in enum options → 400 |
| 10 | POST: `adapter.resolveElicitation` throws `ElicitationUnsupportedError` → 501; entry restored |
| 11 | POST: `adapter.resolveElicitation` throws generic `Error` → 500; entry restored |
| 12 | POST: `adapter.resolveElicitation` fails; a newer elicitation was ingested during await → 500; NEW entry not overwritten (identity-guarded restore) |
| 13 | POST: `adapter.resolveElicitation` fails; terminal event cleared run during await → 500; cache remains empty (no zombie restore) |
| 14 | POST: out-of-enum value rejected → 400; GET still returns same elicitation; valid response subsequently resolves (F7: restore on enum-validation failure) |
| 15 | POST: `body.elicitationId` does not match current cache entry → 409; cache entry restored (stale-tab rejection; newer elicitation remains intact) |

---

## File map

```
packages/agent-acp-bridges/
  bridge.mjs                              ← add currentSessionId (set on session/new);
                                             add pendingElicitations Map (closure local);
                                             add session/create_elicitation case;
                                             add session/elicitation_resolved case;
                                             replace rl.on('close') to cancel pending;
                                             add _streams and _exit injection
  tests/bridge-elicitation.test.mjs      ← NEW: 17 in-process bridge scenarios
  package.json                            ← add vitest devDependency + test script

packages/crew/
  src/api/elicitation-cache.ts            ← NEW: ElicitationCache
  src/api/routes.ts                       ← add elicitationCache param;
                                             add GET /runs/:id/elicitation (read route);
                                             add POST /runs/:id/elicitation;
                                             add ElicitationUnsupportedError handler
                                               (501 + generic 500, both restore entry);
                                             GET /runs handler: add
                                               elicitationCache.reconcile(views)
                                               alongside gateCache.reconcile(views)
  src/api/server.ts                       ← create ElicitationCache; wire ingest;
                                             pass to registerRoutes
  src/core/adapter.ts                     ← add resolveElicitation() (stub);
                                             add ElicitationUnsupportedError class
  src/core/types.ts                       ← add elicitationId?, options?: string[] | null
                                             to CoreEvent
  tests/elicitation-cache.test.ts         ← NEW: 10 cache scenarios
  tests/elicitation-route.test.ts         ← NEW: 14 route scenarios

packages/studio/
  src/api/types.ts                        ← add elicitationCreated CoreEvent fields;
                                             add ElicitationInfo interface
  src/api/client.ts                       ← add getElicitation() (GET /runs/:id/elicitation);
                                             add respondToElicitation() (POST)
  src/store/elicitations.ts               ← NEW: useElicitationStore
                                             (fetch GET /runs/:id/elicitation on run open
                                              for late-join rehydration, mirroring gate pattern)
  src/components/ElicitationPrompt.tsx    ← NEW: HITL elicitation component
  src/App.tsx                             ← add ingestElicitation call in WebSocket handler
                                             alongside ingestGate/ingestNotif/etc.
                                             (mirrors useGateStore pattern at lines 78-99)
  src/hooks/useRuns.ts                    ← add elicitationStore.reconcile() call after
                                             gateCache.reconcile(); add per-run
                                             GET /runs/:id/elicitation fetch on run open
                                             (mirrors existing gate rehydration in this hook)
  src/components/RunDetail.tsx            ← render ElicitationPrompt when elicitation pending;
                                             suppress SteeringGate for same run (OQ-4:
                                             if elicitation entry present, skip gate render)
  src/components/ChatPanel.tsx            ← same ElicitationPrompt rendering + SteeringGate
                                             suppression (currently renders SteeringGate at
                                             line 857 based on gateBeforeThis condition)
```
