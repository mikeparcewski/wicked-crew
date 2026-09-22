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
- `packages/agent-acp-bridges` — two bins, not one. `agy-acp` is an ACP stdio bridge for
  agy/Antigravity, spawned by wicked-core for governed ACP sessions. `wicked-pi` is a
  *launcher* shim, not a bridge: it turns wicked-core's `WICKED_PI_SKILL_DIRS` into pi's
  `--no-skills --skill <dir>…` and is wired in by **crew**, not core, via
  `PI_ACP_PI_COMMAND` (`src/core/bridge-path.ts`) so the community `pi-acp` adapter spawns
  it instead of bare `pi`. Note `agy-acp` is resolved by name off PATH and an unrelated
  community `agy-acp` is now published on npm — which one a spawn gets is PATH order.

## Where the real docs live

- `README.md` — product overview, install, quickstart.
- `.product/` (repo root) — requirements + design artifacts (REQ-*, DES-*, ADRs, build plans).
  **Gitignored and in no commit** — a fresh clone has none of it, and a `.product/…` path
  cited in a source comment may simply not exist on the machine you are reading from.
- `docs/` — operator docs and articles; `site/` — the product website (Astro).
- `e2e/` — end-to-end probe scripts; root `tests/` — workspace-level scenario scripts.

Common commands (repo root): `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
