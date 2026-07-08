---
name: REQ-002-technology-constraints
title: wicked-crew — Technology Constraints
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# REQ-002 — Technology Constraints

## 1. Runtime

| Component | Technology | Rationale |
|---|---|---|
| Daemon + CLI | TypeScript / Node.js 20+ | Consistent with wicked-bus, wicked-garden, wicked-testing, wicked-installer. Fast iteration. npm ecosystem. execa for subprocess management (already used in ecosystem). |
| wicked-studio | React 18 + Vite | Standard modern React stack. Vite for fast dev iteration. |
| UI component library | ShadCN/UI (Radix primitives + Tailwind) | Zero lock-in — components are copy-paste into the project. Radix provides accessible primitives. |
| State persistence | SQLite (via `better-sqlite3`) | Consistent with wicked-bus SQLite model. Local-first. Zero external infrastructure. |
| HTTP server | Fastify | Lightweight, TypeScript-native, fast. No Express complexity. |
| WebSocket | `ws` library (via Fastify WebSocket plugin) | Standard. Integrates with Fastify cleanly. |
| Event bus | wicked-bus (existing) | Already in the ecosystem. At-least-once delivery. SQLite-backed. |

## 2. Cross-Platform Requirement

All code must run on **macOS, Linux, and Windows** (Git Bash / WSL). Specific rules:

- No POSIX-only shell features in scripts. All shell interactions via execa with explicit args arrays (no string shell commands).
- Path handling via `node:path` (`join`, `resolve`, `dirname`) — never string concatenation.
- Process management: use `execa` for subprocess spawn. Avoid `child_process.exec` with shell strings.
- SQLite file locking: use WAL mode for concurrent read access.
- No hardcoded `/tmp` paths — use `os.tmpdir()`.
- npm package: must install and run on all three platforms.

## 3. Worker Protocol

Workers (AI CLIs) are treated as black-box subprocesses. The protocol:

- **Input**: wicked-crew writes a prompt to the worker's stdin or passes it as a CLI arg (`--print "..."`)
- **Output**: Worker writes to stdout. wicked-crew captures and parses.
- **Output format**: Workers SHOULD emit structured JSON. Workers MAY emit unstructured text — wicked-crew will apply a light extraction pass. Workers MUST NOT be required to know they are being orchestrated by wicked-crew.
- **Exit codes**: 0 = success, non-zero = error (recorded as evidence, no crash).
- **Timeout**: configurable per worker type (default 120 seconds). Timeout is recorded as evidence, not a daemon crash.

The worker protocol is defined in the design phase. This constraint: workers are treated as black boxes that produce text/JSON output. No SDK required.

## 4. Dependencies (daemon)

Required:
- `better-sqlite3` — SQLite driver (synchronous, correct for a daemon)
- `fastify` + `@fastify/websocket` — HTTP + WebSocket server
- `execa` — subprocess management
- `zod` — schema validation for worker output and config files
- `xstate` v5 — phase state machine (serializable actors; snapshot → SQLite → restore is the checkpoint/resume mechanism)
- `json-rules-engine` — gate policy evaluation (deterministic, JSON rules, no LLM)
- `chalk` — CLI output formatting
- `@inquirer/prompts` — CLI interactive prompts (for HITL terminal flow)

Avoided:
- No ORM (raw SQL + better-sqlite3 is the pattern)
- No cloud SDK dependencies
- No LangChain, CrewAI, or other AI framework (governance is pure logic, not AI)
- No BullMQ (requires Redis) — checkpoint/resume is handled by XState v5 snapshot persistence to SQLite

## 5. Dependencies (wicked-studio)

Required:
- `react` 18, `react-dom`
- `vite` + `@vitejs/plugin-react`
- `tailwindcss` + `@tailwindcss/vite`
- `@radix-ui/*` primitives (via ShadCN/UI)
- `lucide-react` (icons)
- `zustand` — lightweight client state management
- `react-query` (TanStack Query) — REST data fetching + caching
- `recharts` — for session timeline / phase visualizations

Avoided:
- No Redux (zustand is sufficient)
- No Next.js (this is a local React app, not a web deployment)
- No heavy UI framework (Material UI, Ant Design) — ShadCN is the pattern

## 6. Package + Distribution

**wicked-crew daemon + CLI:**
- Published on npm as `wicked-crew`
- Binary entrypoint: `wicked-crew` (maps to `dist/cli.js`)
- Daemon entrypoint: `wicked-crew serve` (starts the REST + WebSocket server)
- Install: `npm install -g wicked-crew` or `npx wicked-crew`

**wicked-studio:**
- Published on npm as `wicked-studio`
- Binary entrypoint: `wicked-studio` (starts the React app via a local static server on port 4200)
- Build output: `dist/` (Vite build, static HTML/JS/CSS)
- wicked-crew can auto-launch wicked-studio (`wicked-crew start --ui` opens the browser)
- Alternatively: `wicked-installer` handles both via registry

## 7. Config

All user config lives in `~/.wicked-crew/`:

```
~/.wicked-crew/
├── config.json          # daemon port, log level, worker defaults
├── workers.json         # registered worker CLIs
├── workflows/           # YAML workflow type definitions
├── policies/            # JSON governance policy files
└── sessions/            # SQLite per-session checkpoints (alternative: single sessions.db)
```

Config changes: daemon hot-reloads `workers.json` and `workflows/` without restart. `config.json` changes require restart.

## 8. Testing

- Unit tests: Vitest
- Integration tests: real SQLite, real subprocess spawn (use `echo` / fixture CLIs as mock workers)
- No mocks for SQLite — tests use real SQLite temp files per test (pattern from wicked-bus)
- wicked-testing acceptance pipeline for DoD gate

## 9. API Versioning

REST API: `GET /api/v1/...`. The `/v1` prefix is present from day one. Breaking changes require a new version prefix.

WebSocket: Events follow wicked-bus format (`type`, `domain`, `subdomain`, `payload`, `timestamp`). No binary protocol.

## 10. Hard Constraints

- **No LLM calls in the governance engine.** Gate evaluation is pure deterministic logic. Policy files are JSON rules, not prompts.
- **No cloud calls at runtime.** All runtime behavior is local. Network calls are only from worker CLIs (which are not wicked-crew's concern).
- **SQLite WAL mode always enabled.** Daemon reads and writes may race; WAL is the safety guarantee.
- **Governance is deny-dominates.** If any policy fails, the gate is rejected regardless of other policies passing.
- **Worker CLIs are stateless.** wicked-crew owns all state. Workers receive context in each dispatch and produce output. They do not communicate with wicked-crew except via stdout.
