---
name: DES-TERMINAL-001-core-pty-capability
title: Event-based terminal (PTY) sessions in wicked-core — Technical Design
status: draft
version: 0.1
date: 2026-07-07
review-required: true
depends-on: [wicked-core on estate 0.13, wicked-core-ts]
---

# DES-TERMINAL-001 — PTY terminal sessions as a core capability

## 1. Goal & placement

Move the terminal out of the (retiring) egui studio and make it a **first-class
wicked-core capability**: bidirectional PTY sessions owned by core, streamed over the
existing `CoreEvent` bus, surfaced to the web UI via `wicked-core-ts` → TS daemon (WS) →
xterm.js. This is the concrete build behind "event-based terminal sessions for
long-running executions instead of one-off stdin/stdout" — it generalizes read-only
`CliOutputDelta` into a bidirectional TTY you can watch **and** type into.

Extract the mechanism from egui (`archived`/current `wicked-studio` `data.rs` +
`view_agents.rs`, `portable-pty` / vt100). The capability lives in core; the UI consumes it.

## 2. Scope (v1)

- **In:** a generic PTY session capability in core — open a pseudo-terminal running a
  command (or a shell) in a working dir, stream its output as events, write input bytes,
  resize, close. Cross-platform (portable-pty: unix + Windows ConPTY).
- **Out (follow-on):** wiring a *Run's agent CLI* to execute on a PTY instead of piped
  stdout (so agent execution becomes an interactive terminal) — designed here as the
  natural extension, built after the generic capability lands. Also out: the daemon WS
  bridge + React xterm.js component (separate surface tasks, §6).

## 3. Core API (mirrors the existing Command/CoreEvent shape)

```rust
// Commands (command.rs)
OpenTerminal  { cwd: PathBuf, cmd: Option<Vec<String>>, cols: u16, rows: u16,
                governed: bool, reply: oneshot<Result<TerminalId>> },
WriteTerminal { id: TerminalId, bytes: Vec<u8> },      // keystrokes IN (fire-and-forget)
ResizeTerminal{ id: TerminalId, cols: u16, rows: u16 },
CloseTerminal { id: TerminalId },

// Events (event.rs) — ride the single ordered emit point like every CoreEvent
TerminalOpened { id, cwd }
TerminalOutput { id, seq, bytes_b64: String }   // bytes base64 (CoreEvent → tagged JSON)
TerminalExited { id, status: Option<i32> }
```

`cmd: None` ⇒ the user's login shell (raw workspace shell). `governed: true` routes the
session through the gate-hook (agent-execution terminals); `governed: false` is an
explicit, loud **operator shell** — ungoverned, opt-in only (same posture core already
uses for non-claude CLIs). Default `governed: true`.

## 4. The single-writer split (the load-bearing decision)

PTY byte-I/O is **high-volume streaming** and must NOT flow through the single
store-writer actor (it would starve state writes). It is a **streaming side-channel**,
exactly like the worker pool:

- **State** (the terminal-session registry: id, cwd, status, governed) is small and
  **actor-owned** — `OpenTerminal`/`CloseTerminal` persist it through the actor (single
  writer preserved).
- **Byte I/O runs off-actor.** On open, core spawns the PTY (portable-pty) and a
  **reader thread** that drains the PTY master and posts `TerminalOutput` back to the
  actor's **single emit point** (so events stay globally ordered with `seq`, like the
  worker `ApplyStepResult`/`CliOutputDelta` path). `WriteTerminal` sends bytes straight
  to the PTY master writer (held in an off-actor `Map<TerminalId, PtyWriter>` behind a
  mutex) — it does **not** round-trip the store actor.
- This preserves the §1 invariant (actor is the sole writer of *state*) while giving the
  terminal a low-latency bidirectional path. It mirrors "workers hold no store handle;
  the actor is the sole emit point."

## 5. Backpressure, ordering, lifecycle

- **Chunk + cap** `TerminalOutput` like `CliOutputDelta` (bounded reader buffer, e.g.
  ≤16 KB/chunk; bounded channel with oldest-drop + a `degraded` marker if a consumer
  can't keep up). A chatty process must not flood the bus.
- **Ordering:** per-terminal `seq` on `TerminalOutput`; single emit point keeps the
  global stream ordered.
- **Lifecycle:** reader thread exits on PTY EOF → `TerminalExited`; `CloseTerminal`
  kills the child + joins the reader; on `Core` shutdown all PTYs are killed and threads
  joined (no leaked child processes — a real risk with PTYs). Registry entry removed.

## 6. Surface (follow-on tasks, after the core capability + core-ts review)

- **core-ts:** `openTerminal/writeTerminal/resizeTerminal/closeTerminal`; `TerminalOutput`
  flows through the existing `subscribe()` stream (already tagged-JSON). `writeTerminal`
  takes a Node `Buffer`/base64.
- **TS daemon:** one WS channel per terminal — browser → WS → `writeTerminal`;
  `TerminalOutput` → WS → browser. Reuses the daemon's existing WS plumbing.
- **React studio:** an `xterm.js` component bound to that WS (the egui native PTY's web
  equivalent). Fits the campaign per-node output pane (DES-CAMPAIGN-001 §11) — a node's
  live pane becomes a real terminal.

## 7. Governance & safety

- `governed: false` (raw operator shell) bypasses the gate-hook — must be a loud,
  explicit opt-in, never a default, and surfaced in the UI as ungoverned.
- `governed: true` agent-execution terminals keep routing tool-calls through the
  append-only decisions.ndjson gate-hook (unchanged).
- Input to a governed terminal is still just the agent's own stdin; the governance
  boundary remains the tool-call hook, not keystrokes.

## 8. Test strategy

- **Core (Rust):** open a PTY running a deterministic command (`echo`, or `cat` for a
  write→echo round-trip), assert `TerminalOutput` bytes; write input, assert echo; close,
  assert `TerminalExited`; shutdown with a live PTY, assert the child is reaped (no
  orphan). Cross-platform guard (skip/adjust on Windows if ConPTY unavailable in CI).
- **core-ts (Node smoke, follow-on):** openTerminal(`cat`) → writeTerminal("hi\n") →
  receive `TerminalOutput` "hi" over `subscribe` → closeTerminal.
- Coverage + adversarial review of the diff (thread/lifetime/orphan-process focus) before
  the capability counts as done.

## 9. Risks

- **R1 — orphaned child processes / leaked reader threads** on close/shutdown/panic
  (the classic PTY bug). Explicit reap + join in §5; the adversarial review targets it.
- **R2 — output flooding the CoreEvent bus** (interactive TUIs redraw a lot). Mitigated
  by chunk/cap + bounded queue (§5).
- **R3 — Windows ConPTY** parity; portable-pty abstracts it but CI coverage is a follow-up.
