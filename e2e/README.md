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

## `corpus/` — the INTERNAL evals corpus (five wicked repos at pinned tags)

`corpus/wicked-internal-corpus.json` is a **constant**: five wicked repos (estate, garden, crew,
studio, interactive), each at a pinned prior release tag with the commit it resolved to and an
ACTION window (`action_window_from_tag..tag`, ≥ 50 commits, capped at 180 days) of real dev
actions behind it. Our doctrine rules (plane boundaries, event grammar, storage doctrine) apply
to these repos — the point of the corpus; third-party repos structurally cannot exercise them.
For testing the evals machinery and our own doctrine only — never shipped in the product (a
user evals their OWN policies and memories against their OWN actions). Moving a tag is a
deliberate PR: edit `tag`, re-pin, commit. `scripts/evals-internal-corpus.mjs` owns it:

```
npm run evals:corpus:check                                   # tags still resolve to the pinned shas (fail closed)
npm run evals:corpus:pin                                     # re-resolve shas + windows after a deliberate tag move
node scripts/evals-internal-corpus.mjs materialize <dir>     # git archive each tag → <dir>/<repo>@<tag>/
node scripts/evals-internal-corpus.mjs samples <dir>         # one EvalSample per window commit → <dir>/samples.json
node scripts/evals-internal-corpus.mjs run <dir>             # ingest the doctrine seed + rules eval (needs wicked-core)
```

Every mode reads the sibling checkouts (`--source-root <dir>`, default `$WICKED_SOURCE_ROOT` or
this repo's parent) READ-ONLY and refuses to derive anything from a checkout whose shas do not
match the pin — or whose history is SHALLOW (`git rev-parse --is-shallow-repository`, a
`$GIT_DIR/shallow` file): a depth-1 clone can resolve both pinned tags while the commits between
them are missing, so `samples` also checks each window's derived commit and sample counts against
the pin's `commits` — or that carries git REPLACEMENT refs (`refs/replace/*`, refused by name as
`replace-refs-present`: a replacement rewrites what a window commit says while its parents, both
tag shas and `rev-list --count` stay exactly the pin's; every git the script runs is additionally
replacement-blind, `--no-replace-objects` + `GIT_NO_REPLACE_OBJECTS=1`, so a pin is derivable from
the immutable history alone). Samples are `good` by default (released commits); `corpus/known-bad.json` is the
team's allowlist of commits that ARE bad behavior — `samples` fails closed on a stale entry AND
on a missing or malformed allowlist file (`--known-bad` must name a file whose `samples` is the
keyed map; `{"samples": {}}` is the empty allowlist). Every sample is validated by the route's
own zod schema (`packages/crew/src/api/eval-sample.js` — shared, no mirror). The derivation pins
its complete git configuration (no rename detection, tree order, UTF-8, no signature lines) and
reads touched paths NUL-delimited, never trimmed, so the same pin yields the same bytes on every
machine and a filename keeps its exact spelling; publication is atomic (tmp+rename under a lock,
one `generation` per publication). `materialize` only ever removes or writes direct, non-symlink
children of its root's realpath, pins the operator's git attributes away for the archive and
verifies the extracted tree against `git ls-tree` (an un-overridable `export-ignore` is a named
refusal); it holds `.materialize.lock` for the whole step, extracts + verifies every repo into a
staging dir beside its destination and swaps the trees in only after ALL verified, keeping every
`.prev` backup until the receipt is published — a failed repeat leaves the previous trees and
`materialized.json` intact, a failed first run leaves no receipt, and a failure DURING the swap or
the receipt write is rolled back (every destination restored byte-identical, the previous receipt
restored only after that complete rollback; if the rollback itself fails every receipt is removed
and the error names both faults). The receipt is INVALIDATED before the first tree moves — an
in-progress marker (`.materialize.inprogress-<generation>`) is published and the previous
`materialized.json` moved aside — so a process killed between two renames leaves incomplete trees
beside NO receipt; every start inspects the root and repairs a torn swap (the `.prev` trees rolled
back, staging / marker / previous receipt removed, nothing trusted until the run publishes),
finishes a torn cleanup, sweeps stale staging; a consumer reads the receipt through
`readMaterializeReceipt(dir, pin)`, which refuses a damaged root by name with `materialize <dir>`
as the repair and trusts a receipt only as the materialization OF the selected pin: `pin_hash` and
a well-formed `generation` present and the pin's, `repos[]` exactly the pinned repos at their tag
and sha, and every `path` the real directory `<root>/<repo>@<tag>` — present, not a symlink, a
directory, realpath-equal (a foreign path, a link, a plain file, a missing identity or an extra /
missing repo is a named refusal, never "clean"). A `tar` that fails or cannot be spawned during
extraction is a tool failure (exit 1), not a usage error. `run` verifies `samples.meta.json`
against `samples.json` and the selected pin before the engine is probed, resolves the engine ONCE
with exec's own search semantics (every `PATH` entry in order, an EMPTY entry being the cwd,
`PATHEXT` on Windows, an executable regular file required — only true absence, ENOENT / ENOTDIR,
is the exit-zero SKIP; a lookup that fails any other way, `stat` EACCES on a PATH directory or
EIO, is a tool failure naming syscall, errno and candidate, because which file a spawn would run
cannot be determined) and spawns THAT absolute path for every call — the file hashed into the
provenance is the file that ran — stages exactly those samples in a fresh private temp dir, verifies the
engine's report before publication (exactly one row per staged sample, engine verdicts, `fired`
arrays, every row consistent with its sample's kind — `expected` deny/allow by kind, never `gap`
on a good sample or `false_positive` on a bad one, `fired` non-empty iff a blocking verdict fired —
a summary that is the rows' tally, `degraded` present, `rule_coverage` absent or well-formed AND
reconciled with the rows: no id both fired and unexercised, `exercised` at least the distinct ids
the rows' `fired` name (the engine counts every rule any claim fired, blocking or not, so it may
exceed but never undercut), no duplicate unexercised id, `recall_only` a non-negative integer when
present — an empty, partial, impossible or contradictory report is a named tool failure),
stamps every result row with its sample's `payload_hash`, and publishes `report.json` + `report.meta.json` as
one verifiable generation (`report_sha256` + shared `generation`) with complete provenance:
engine version + build identity (realpath + sha256 of the executable actually spawned, hashed
again after the run), the rule-snapshot identity
(`rules_identity.method` says how it was derived), `pin_hash`, `samples_hash`. The corpus
identity a run carries is `evals:wicked-internal@<pin_hash>` + the `samples_hash` written to
`samples.meta.json`; the full plan is `docs/testing/evals-test-plan.md`.
