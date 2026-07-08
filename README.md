# wicked-crew

**External daemon that governs multi-phase AI development workflows.**

wicked-crew is a standalone external orchestrator — a daemon plus CLI — for governed, multi-phase AI
development. It never runs inside a coding agent and never writes code; it runs *above* them,
treating AI CLIs (`claude --print`, `codex run`, wicked-testing, wicked-garden, bash) as stateless
worker subprocesses while it owns the phase lifecycle (clarify → design → test-strategy → build →
test → ship), deterministic deny-dominates gates, human-in-the-loop approvals, and evidence. As of
v0.2.0 the orchestration engine lives in [wicked-core](https://github.com/mikeparcewski/wicked-core);
the daemon is a thin REST + WebSocket bridge over `wicked-core-ts` that also bundles and serves its
browser control-plane UI.

> **Status:** v0.2.0, published to npm as [`wicked-crew`](https://www.npmjs.com/package/wicked-crew).
> Its bundled browser control-plane SPA (the wicked-studio operator console) is **not** separately
> published — the daemon serves it.

**The differentiator:** it owns the workflow structure without owning the work — an external,
headless, deterministic (no-LLM-on-the-gate-path), deny-dominates, SQLite-checkpointed phase-gate
lifecycle you can crash and resume, driving stateless AI CLIs it does not embed.

## Key features

- **External daemon + CLI** on `localhost:7701` — not a plugin, library, or hook.
- **Deterministic governance** — gates evaluate with no LLM on the gate path; deny-dominates, so any
  failing policy blocks the transition.
- **SQLite-backed checkpointing** — crash the daemon and resume to the exact pre-crash phase.
- **Worker dispatcher + council** — spawn AI CLIs as subprocesses and capture stdout as evidence, or
  fan the same prompt to N CLIs and synthesize agreement/divergence.
- **Local-first** — binds `127.0.0.1` only; no cloud, accounts, or telemetry. wicked-testing's
  `verdict.json` gates the test phase.

## Audience

Developers running AI coding agents who need a shared phase lifecycle, cross-session governance,
deterministic gates, HITL approval, and external evidence/memory that individual CLIs lack.

## The foundation

wicked-crew is the **workflow governor** of the [wicked-* foundation](https://we.wickedagile.com): a
local-first stack for AI coding agents anchored by
[wicked-estate](https://github.com/mikeparcewski/wicked-estate) (the code graph), with
[wicked-core](https://github.com/mikeparcewski/wicked-core) (the runtime),
[wicked-bus](https://github.com/mikeparcewski/wicked-bus) (the event substrate), and
[wicked-brain](https://github.com/mikeparcewski/wicked-brain) (memory). The daemon writes to the
estate SQLite db through core's single-writer actor, emits session/gate/phase events on wicked-bus,
and dispatches the wicked-testing acceptance pipeline as its test-phase worker.

## License

MIT © Michael Parcewski <mike.parcewski@gmail.com> — see [LICENSE](./LICENSE).
