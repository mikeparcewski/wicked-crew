# wicked-crew

Control plane of the wicked platform: a daemon + CLI that runs coding-agent CLIs as governed
workers through durable workflows — intent in, verified work out (evaluator ≠ creator,
deny-dominates gates, "done" re-derived from ledger evidence). The execution engine is
wicked-core (its own Rust repo); this repo is the JS/TS surface on top of it.

This file is a pointer stub — no doctrine lives here. Ecosystem-wide rules (PR merge
protocol, where things live) are in the parent `../CLAUDE.md`.

## Layout (npm workspace)

- `packages/crew` — the product: daemon (`/api/v1` REST + `/ws` CoreEvent frames) and CLI.
  Source in `src/{api,cli,core,events,interactive,projects,qe,types}`; tests in `tests/`
  (vitest). The QE acceptance gate reads the repo's wicked-ledger store via `src/qe/`.
  `build:with-studio` bundles wicked-studio's dist as the default local UI.
- `packages/crew-api-types` — the published wire contract of `/api/v1` + `/ws` (types only,
  zero runtime); wicked-studio builds against this, never against crew internals.
- `packages/agent-acp-bridges` — ACP stdio bridge for headless CLIs without a native
  adapter (currently agy/Antigravity), used by wicked-core for governed sessions.

## Where the real docs live

- `README.md` — product overview, install, quickstart.
- `.product/` (repo root) — requirements + design artifacts (REQ-*, DES-*, ADRs, build plans).
- `docs/` — operator docs and articles; `site/` — the product website (Astro).
- `e2e/` — end-to-end probe scripts; root `tests/` — workspace-level scenario scripts.

Common commands (repo root): `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
