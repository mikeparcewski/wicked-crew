# wicked-crew

Control plane of the wicked platform: a daemon + CLI that runs coding-agent CLIs as governed
workers through durable workflows — intent in, gated work out (deny-dominates gates; "done"
re-derived from the engine's own evidence — floors, repo checks, judges; review on a seat distinct
from the creator's whenever the roster has an eligible one, disclosed when it is not). The QE ledger
acceptance answer is a separate read (`GET /runs/:id/acceptance`), a delivery prerequisite only for a run whose assurance contract requires `qe_acceptance` (then an attributed PASS, or no push — wicked-core#850). The execution engine is
wicked-core (its own Rust repo); this repo is the JS/TS surface on top of it.

This file is a pointer stub — no doctrine lives here. Ecosystem-wide rules (PR merge
protocol, where things live) are in the parent `../CLAUDE.md`.

## Layout (npm workspace)

- `packages/crew` — the product: daemon (`/api/v1` REST + `/ws` CoreEvent frames) and CLI.
  Source in `src/`, one directory per surface (`api`, `cli`, `core`, `events`, `interactive`,
  `projects`, `qe`, and newer ones such as `voice`, `learnings`, `persona`, `inspect`,
  `working-doc`); tests in `tests/` (vitest). The QE acceptance assessment reads the repo's
  wicked-ledger store via `src/qe/`.
  `build:with-studio` bundles wicked-studio's dist as the default local UI.
- `packages/crew-api-types` — the published wire contract of `/api/v1` + `/ws` (types only,
  zero runtime); wicked-studio builds against this, never against crew internals.
- No ACP bridges any more (C5): governed seats run each CLI's headless mode, in a hardened seat
  container by default (`WICKED_SEAT_FLOOR=container`, set at boot unless the operator chose
  `host`, the labelled interim host floor). `src/core/bridge-reaper.ts` still knows the old bridge
  names so a daemon upgraded from an ACP release reaps what the old one left running.

## Where the real docs live

- `README.md` — product overview, install, quickstart.
- `.product/` (repo root) — requirements + design artifacts (REQ-*, DES-*, ADRs, build plans).
  **Gitignored and in no commit** — a fresh clone has none of it, and a `.product/…` path
  cited in a source comment may simply not exist on the machine you are reading from.
- `docs/` — operator docs and articles; `site/` — the product website (Astro).
- `e2e/` — end-to-end probe scripts; root `tests/` — workspace-level scenario scripts.

Common commands (repo root): `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
