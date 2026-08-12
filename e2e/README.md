# e2e — browser-level studio verification

Playwright (Python) scripts that drive the REAL studio against a REAL daemon —
launching runs over the API, holding the page open through execution (the insight
rail builds from live WS events; there is no replay for late joiners), then
walking the UI and screenshotting every surface.

## Prereqs

- daemon running (`node packages/crew/dist/cli/index.js serve`), studio served
  (dev server on :4200 or the bundled build)
- Python Playwright: `pip install playwright && playwright install chromium`
- at least the `claude` CLI installed + authenticated (scripts launch claude-only
  runs so they are cheap and deterministic in shape)

## Scripts

| script | verifies |
|---|---|
| `insight_rail_test.py` | every insight-rail accordion (What/Where, Decisions, Governance, Burn, Data, Steering, Assumptions, Files) + Term modal, on a live run |
| `burn_cov_test.py` | Burn populates from cliUsage (tokens / cost / per-CLI) and the Cov modal opens + closes via its X |
| `acp-probe.mjs` | one full ACP handshake (initialize → session/new → session/prompt) against any adapter binary: `node acp-probe.mjs codex-acp` |
| `studio_standalone_test.py` | MOVED by the #98 carve to the [wicked-studio repo](https://github.com/mikeparcewski/wicked-studio) (`e2e/studio_standalone_test.py` there) — the SPA's independence gate belongs to the SPA's own repo. Point its `CREW_CLI` at this repo's built daemon |

Screenshots land in `e2e/shots/` (gitignored); each script prints a JSON report
to stdout. `STUDIO_URL` / `CREW_API` env vars override the default endpoints.

These are operator-run smoke tools, not CI suites — they spend real tokens.
