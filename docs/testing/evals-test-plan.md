# Evals test plan — `/api/v1/testing/*` + the engine's steering evals (REVISED)

_Revision 3 (2026-09-09). Supersedes revision 2 on ONE point — the corpus. The 15-repo
`~/Projects/wicked-e2e` OSS set is **not** an eval corpus (it stays the E2E functional-test corpus
it already was); the eval corpus is the INTERNAL five-repo tag pin in §2. Everything else carried
over: the codex review (`REVISE`, 8 HIGH / 9 MEDIUM) and its adjudication are applied in full —
required changes 1–5 below. Companion to wicked-core #394 (rule-side coverage), #395 (an
authorable `effect`) and #397 (evals = a user's OWN policies and memories against actions).
Implemented scenarios name their test file; the rest name their blocker._

## 0. What changed since the draft, and why

| # | Required change (codex) | Applied as |
|---|---|---|
| 1 | Replace the seed-corpus explanation of the 16 gaps with the **actual rule snapshot** and recorded results; explain recall-only vs. blocking enforcement | §1 — the cause is `effect`, not textual overlap |
| 2 | Define **immutable identities** (repo, sample payload, rule snapshot, engine/binding build, hint mode) plus per-run provenance and deterministic drift checks | §3 — corpus identity = `pin_hash` + `samples_hash` + rule snapshot + engine build + hint mode; `scripts/evals-internal-corpus.mjs` |
| 3 | Repair S11–S17 fixtures/dependencies: isolated databases, verified rationale embeddings, real addon wiring, explicit import/capture stages, persisted comparison records | §4 scenario table, S10–S17 preconditions |
| 4 | Add the missing verdict, seven-type, failure, persistence, validation and fallback scenarios with exact fixtures | §4 S1–S9 (implemented) + S21–S24 (engine-side, pending) |
| 5 | Reclassify S20; qualify S16's gate-parity oracle; make S18 conditional; fix misnamed references; explicit pass/fail everywhere | §4 S16/S18/S20; §6 corrections |
| — | **Change of intent (2026-09-08):** evals are a feedback loop on the user's OWN governance, so the test corpus must be repos our doctrine actually governs | §2 — the internal pin replaces the wicked-e2e lock; S14/S15/S17 rewritten |

## 1. Why the built-in corpus evals to 27 / 11 / 16 / 0 today — the cause is `effect`

The recorded run the operator saw (`~/.wicked-crew/evals/runs.jsonl`, row 11: `total 27, caught
11, gaps 16, false_positives 0, degraded "facet-only"`) was judged against the daemon's LIVE
steering store — **50 active `proposal:`-sourced rules across six steering types** — not the eight
seed documents the draft analyzed. The number is not "16 rules missing": 27 samples split 16 `bad`
/ 11 `good` (`evals/dev-behaviors/samples.json`), so 11 caught + 16 gaps + 0 false positives is
exactly what a store that **never denies anything** produces — every `good` sample is "caught"
(allowed, correctly) and every `bad` sample is a gap.

Why nothing denies — the enforcement condition, verified in source:

- `wicked-governance/src/steering.rs` `policy_view()`: `let effect = rule.effect?;` — a rule enters
  the DECIDE lane only when it carries an `effect`; without one it is **recall-only** (surfaced to
  workers, never evaluated as a policy). `engine.rs` skips recall-only rules in `select`.
- `wicked-governance/src/evals.rs` `evaluate_sample()`: `fired` keeps only ids whose selected
  policy has `effect == Effect::Deny`; verdicts key on `fired.is_empty()`. A fired
  `AllowWithConditions` adds obligations — it does not catch a bad behavior.
- `conformance.rs`: `effect: Option<Effect>` with `skip_serializing_if = Option::is_none`;
  `domain.rs`: `Effect = deny | allow_with_conditions | allow` (serde snake_case).
- **No operator path sets it.** Markdown ingest's frontmatter keys are id / applies_to / excludes /
  steering_type / weight / status — no `effect` (and `markdown.rs` asserts doc rules stay
  recall-only); every one of the 50 live proposal rows has `effect: None`; the studio renders the
  field but does not author it. `Effect::Deny` is constructed only inside Rust conformance code.

So statement overlap is irrelevant: a rule whose text matches a sample perfectly still cannot fire.
**Evals today measure nothing about operator steering** — which is what #395 (an authorable
`effect`, with the operator-facing `warn` band) fixes engine-side, and what this PR puts on the wire
(`ConformanceRule.effect` admits `warn`; api-types 0.26.0). Once a Deny-bearing rule exists, the
verdict scenarios in §4 (S21) become meaningful; until then S11's expected report IS 27/11/16/0.

A second, independent blind spot (#394): a rule with **zero exercising samples** produces no result
row, so it is invisible to `summary.gaps`. `rule_coverage { exercised, unexercised: [{rule_id,
steering_type}] }` on the report closes it; this PR carries it through the wire and the history
verbatim (optional — a pre-#394 engine's report still validates, and a history row without it says
so by absence, never by a fabricated null).

## 2. The corpus — the INTERNAL five-repo pin (and what the product ships instead)

**Product definition (core #397).** Evals let a user **test their policies AND memories against
actions** and see whether they consistently get the desired outcome from their work — a feedback
loop on the user's own governance. The subject is the user's steering rules and (follow-up, second
verdict axis) their memories; the corpus is ACTIONS — the existing `EvalSample` shape (files
touched, tool, content signals), ideally sourced from the user's own run history or authored by
them, with the built-in `dev-behaviors` set as a starter only; the outcome is CONSISTENCY —
per-sample verdict diffs run over run (S17) plus per-rule (and later per-memory) coverage (#394).
**Nothing in this section ships in the product.** No generic corpus is bundled.

**Why the internal corpus is OUR repos.** Our doctrine rules — plane boundaries, event grammar,
graph invariants, storage doctrine, the MCP surface — govern the wicked repos. A third-party OSS
repo structurally cannot exercise them (there is no plane to cross, no `wicked.<domain>.<noun>.<verb>`
event to misname), so an eval over such a corpus can only ever measure the universal rules. The
15-repo `~/Projects/wicked-e2e` set therefore stays what it was — the E2E FUNCTIONAL corpus for
governed-run testing — and is not an eval corpus; its lock is dropped from this plan.

**The pin — `e2e/corpus/wicked-internal-corpus.json` (THE constant).** Five repos at a pinned
prior release tag each, resolved once and committed:

| repo | tag | tag date | action window (`from..tag`) | commits | rule outcome |
|---|---|---|---|---|---|
| wicked-crew | v0.7.24 | 2026-09-08 | v0.7.8..v0.7.24 | 54 | floor met after 16 release tags |
| wicked-estate | v0.16.6 | 2026-09-07 | v0.14.5..v0.16.6 | 50 | floor met after 11 release tags |
| wicked-garden | v12.31.0 | 2026-08-14 | v12.29.1..v12.31.0 | 50 | floor met after 2 release tags |
| wicked-interactive | v0.8.1 | 2026-08-24 | v0.6.0..v0.8.1 | 86 | floor met after 4 release tags |
| wicked-studio | v0.5.0 | 2026-09-08 | v0.4.1..v0.5.0 | 53 | floor met after 15 release tags |

`pin_hash sha256:aaf2dd56…` (over the sorted `(repo, tag, commit_sha, from_tag, from_sha)`
tuples). Each row also records `commit_sha`, `action_window_from_sha`, both dates and a `notes`
line explaining the window choice.

**Window rule.** Five releases back was measured too thin on the fast-cutting repos (2026-09-08:
estate 12 / crew 12 / studio 15 commits vs garden 108 / interactive 109), so: walk release tags
(`^v\d+\.\d+\.\d+$` — `api-types-v*` package tags and `wicked-garden-v*` legacy tags are not
release tags) back from the constant in version order until the closed range `from..tag` holds
**≥ 50 commits**; never walk past a tag older than **180 days** before the constant tag's own
commit date; if the floor cannot be met inside the cap, take the oldest tag inside it and record
the **shortfall in `notes`** — never widen past the cap. Both bounds are measured against the
pinned tag's date, not today's, so re-running `pin` on an unchanged tag is byte-identical. Moving
a tag is a deliberate PR: edit `tag`, `npm run evals:corpus:pin`, commit the re-resolved file.

**Sources are the sibling checkouts, read-only.** `<source-root>/<repo>` (default
`$WICKED_SOURCE_ROOT`, else this repo's parent); only `rev-parse` / `tag` / `log` / `rev-list` /
`archive` ever run there — no fetch, checkout or worktree add. `materialize` uses `git archive`
into `<dir>/<repo>@<tag>/`, never a worktree (a worktree add writes into the source's `.git`).

**Samples = actions = the window's commits.** One `EvalSample` per commit in `from..tag`
(`--diff-merges=first-parent`, so a merge carries the files it landed on the mainline): `id` =
`<repo>@<sha12>` (a fixed 12-char prefix, never git's size-dependent `--short`), `description` =
subject, `signals.files` = touched paths, `signals.content` = subject + body, `kind` = `good` by
default (these are released, merged commits) unless `e2e/corpus/known-bad.json` names the id
(`reason` → description, optional `steering_type` override; a stale entry FAILS the derivation —
it means a moved tag or a typo). `steering_type` comes from an **explicit path table** (tests/ →
testing; `.github/`, `Dockerfile` → operations; `auth/`, `security/` → security; `LICENSE`,
`CODE_OF_CONDUCT.md` → compliance; `.product/`, `adr/` → architecture; `components/`, `*.css` →
design-ux) applied as a STRICT MAJORITY of touched files, else `development` — the honest
"unsure". Docs, sites and READMEs are deliberately unclassified: a Markdown edit is not evidence
of design-ux or compliance behavior. Every sample is validated by a zero-dep mirror of crew's
`EvalSampleSchema` (`api/testing.ts`, strict, closed `kind`) plus the engine's known-type check;
the test suite parses the written file with the REAL zod schema. Derived 2026-09-09 from the
pin above: **293 samples** (crew 54 · estate 50 · garden 50 · interactive 86 · studio 53), 0 bad,
steering types architecture 10 · design-ux 5 · development 258 · operations 6 · testing 14,
`samples_hash sha256:e827341b…`, corpus name `evals:wicked-internal@aaf2dd56367978ec` — all 293
accepted by `ImportEvalCorpusSchema`.

**Modes (`scripts/evals-internal-corpus.mjs`, node, zero deps):** `pin` (re-resolve) · `check`
(tags still resolve to the pinned shas; a hand-edited pin — `pin_hash` ≠ its own tuples — is
rejected) · `materialize <dir>` · `samples <dir>` (writes `samples.json` + `samples.meta.json`
with `pin_hash`, `samples_hash`, `corpus_name`, per-repo windows, type counts) · `run <dir>`
(only when `wicked-core` is on PATH: `rules ingest <doctrine seed> --db <tmp>` then `rules eval
--db <tmp> --knowledge-db <tmp> --corpus <dir>/corpus --json` → `report.json`, summary +
`rule_coverage` printed; non-zero ONLY on tool failure — gaps are findings). `materialize`,
`samples` and `run`-via-`samples` all **fail closed** when any checkout's sha ≠ the pin. Exit
codes: 0 ok / skipped-with-reason, 1 drift / refusal / tool failure, 2 usage / IO.

**Two facts the CLI imposed on the plan.** `rules eval --corpus` takes a DIRECTORY of sample
`*.json` files or an `evals:<scope>` — never a file — so `run` stages `<dir>/corpus/samples.json`;
and the doctrine seed is wicked-core's `crates/wicked-governance/seed/corpus` (frontmattered
steering docs — the brief's "garden seed corpus"; garden holds no copy). The locally installed
`wicked-core 0.4.0` predates both `rules eval` and markdown ingest, so `run` against the real
corpus currently exits 1 with `TOOL FAILURE (wicked-core 0.4.0) — rules ingest failed … expected
<dir>/policies/*.json and/or <dir>/rules/*.json` — the honest reading, not a pass. S14b covers
`run` through a fake engine until a current binary is on PATH.

## 3. Immutable identities — what "the same eval" means

A recorded run is comparable to another only when ALL of these match. Each is pinned by an
artifact, not a name:

| Dimension | Identity | Where it lives | Why a name/path is not enough |
|---|---|---|---|
| Corpus repos | `pin_hash` = sha256 over the sorted `(repo, tag, commit_sha, from_tag, from_sha)` tuples | `e2e/corpus/wicked-internal-corpus.json` (this PR: 5 repos) | a tag can be re-cut; `check` proves it was not |
| Sample payload | `samples_hash` = sha256 over the canonical JSON of the derived `samples[]` | `samples.meta.json` beside `samples.json`; to be recorded per import (engine/crew follow-up: import receipt gains `payload_hash`) | `POST /testing/corpora/import` **replaces** a scope's contents (`evals.rs` import path), so `evals:<name>` can hold different samples on two days; results omit input `signals`; known-bad edits change the payload without changing the pin |
| Rule snapshot | sha256 over the canonical JSON of the store's active rules (id, statement, effect, applies_to, excludes, retired) at run time | to be recorded per run (crew persists only `rule_store`, a **path**) | the store mutates between runs |
| Engine + binding build | `wicked-core-ts` version + the addon's build hash | `GET /health` / `diagnostics` today; to be stamped on the run row | the same path can host a different engine tomorrow |
| Hint mode | `degraded` (`null` \| `"facet-only"`) — already persisted | `EvalRunSummary.degraded` | decided by **rule-rationale vectors** (`HashEmbedder(256)` over each rule's rationale), NOT by corpus-sample embeddings; verdicts are unaffected either way |

**Corpus name convention:** `evals:wicked-internal@<pin_hash[0:16]>` — two runs with the same
corpus name are provably the same five repos at the same five tags; the `samples_hash` on the run
says whether the same actions were judged. A moved tag gets a new hash and a new name, never a
silent replacement under the old one.

## 4. Scenario table

Legend — **kind**: `unit` (vitest, no engine), `route` (vitest over the stub adapter), `engine`
(real wicked-core-ts addon / CLI, isolated db), `live` (daemon + studio), `governed` (a real
governed run). **status**: ✅ implemented in this PR (file named), ⏳ blocked on the named
dependency, 🔁 pre-existing regression floor.

| id | surface | precondition (exact fixture) | steps | expected observable (pass/fail) | kind | status |
|---|---|---|---|---|---|---|
| S1 | `EvalRunStore.record` ordering | fresh root; `runs.jsonl` pre-created as a **directory** (index append will EISDIR) | `record()` the 3-result fixture | `record()` rejects; `results/<id>.json` EXISTS with the full detail and no `.tmp-*` sibling ⇒ the detail was written before the failing index step (a reversed order could not leave a detail); `list()` returns `[]` and the warn seam fired | unit | ✅ `tests/eval-store.test.ts` "write ordering + queue recovery" |
| S1b | write-queue recovery | `results` pre-created as a **file** (mkdir fails) | `record()` → rejects; remove the file; `record()` again | second record resolves with the next minted id; `list()` = that one row; its detail loads | unit | ✅ same |
| S2 | id traversal guard | one recorded run; a sentinel `secret.json` planted OUTSIDE `results/` | `get()` with 14 shapes: `../secret`, `..%2Fsecret`, `%2e%2e%2fsecret`, `..%5Csecret`, `..\secret`, `a/../../secret`, `results/../secret`, `x/y`, `./x`, `a.b`, `run-ok.json`, NUL-suffixed, whitespace, empty | every shape → `null` (the sentinel is never returned); `get('run-ok')` still resolves. `EVAL_RUN_ID_RE = /^[A-Za-z0-9_-]+$/` rejects before any fs call | unit | ✅ `tests/eval-store.test.ts` (extends the existing 7-shape test) |
| S2b | same, over HTTP | sentinel planted under the daemon's eval store root | `GET /testing/evals/<raw>` for `..%2Fsecret`, `%2e%2e%2fsecret`, `..%5Csecret`, `results%2F..%2Fsecret`, `x%2Fy`, `a.b`, `.%2Esecret` | every request → 404 with no `id` in the body | route | ✅ `tests/testing-routes.test.ts` |
| S3 | concurrent writes | empty store | 50 `record()`s fired at once | `runs.jsonl` has exactly 50 lines, each parses, ids `run-0`…`run-49` **in append order**, 50 detail files, `list()` length 50 | unit | ✅ `tests/eval-store.test.ts` (was 25) |
| S4 | tolerant reads | 3 recorded rows; the LAST index line truncated mid-JSON; a row that parses but has no `id`/`created_at` appended; `run-0` detail deleted; `run-1` detail overwritten with `{ broken` | `list()`, `get()` ×3 | `list()` = `[run-1, run-0]` (torn + malformed rows skipped); `get(run-0)` = null; `get(run-1)` = null; `get(run-2)` = the orphan detail (written before its torn index line — harmless, never a dangling row) | unit | ✅ `tests/eval-store.test.ts` |
| S5 | `POST /testing/evals/run` presence gate | stub adapter, `evalsSupported=false` | POST `{}` | 501; error matches `/governanceEvals binding/` and `/>= 0\.7\.5/` | route | 🔁 existing |
| S6 | body validation | `evalsSupported=true` | POST `{type:'vibes'}`; POST `{corpsu:…}` | 400; the unknown key is named in backticks; adapter never called | route | 🔁 existing |
| S7 | history recording | `evalsSupported=true`, store wired | POST with a unique `corpus`; `GET /testing/evals?corpus=` | one row: `summary` verbatim, `per_type` derived (1 security caught; 2 development = 1 gap + 1 fp), `results` ABSENT on the row, `rule_store` names the daemon's `core.db`, `degraded` null | route | 🔁 existing |
| S8 | drilldown | S7 | `GET /testing/evals/:id`; unknown id | 200 with `results` deep-equal to the report; 404 on unknown | route | 🔁 existing |
| S9 | corpus import happy path | `evalsSupported=true` | import 2 samples as `dev-behaviors` | 200 `{imported: 2, scope: 'evals:dev-behaviors', embedded: true}`; samples reach the adapter as sent; audited | route | 🔁 existing |
| S9b | persist failure is LOUD-NON-FATAL | a fresh daemon whose eval-store `results` path is a file | POST run; GET history | 200 with the full report; `GET /testing/evals` = `{runs: []}` — the report is the contract, the history is additive | route | ✅ `tests/testing-routes.test.ts` |
| S10 | engine: seed ingest, isolated | `wicked-core` built; `--db <tmp>/evals.db` (never the operator's) | `rules ingest crates/wicked-governance/seed/corpus` | exact inventory: 8 docs; the rule ids listed in each doc's frontmatter (e.g. `POL-1301`, `PAT-1701`…) all present; 0 parse errors; every ingested rule has `effect: None` (the §1 fact, asserted) | engine | ⏳ core binary in CI (crew links core-ts from main; the installed 0.4.0 refuses markdown) |
| S11 | engine: built-in corpus, effect-less store | S10's db; knowledge db = a fresh temp path | `rules eval --db … --knowledge-db … --json` | `summary` **= {27, 11, 16, 0}** exactly (the §1 derivation — every `bad` gaps, every `good` catches); `results.length` 27; each `bad` row `verdict: gap` with `nearest_rules` an array; each `good` row `caught` with NO `nearest_rules` key | engine | ⏳ S10 |
| S12 | engine: hint mode is decided by rationale vectors | two runs over the same db: (a) rationale embeddings present and matching; (b) rationale embeddings absent/stale | compare the two reports | verdicts and `summary` **identical**; (a) `degraded: null`; (b) `degraded: "facet-only"` and lexical hints: token-Jaccard scores, positive-score filter, deterministic order (similarity desc, then `rule_id`), ≤ 3 per gap (`NEAREST_RULES_CAP`) | engine | ⏳ S10; the draft's "unembedded corpus ⇒ facet-only" condition was wrong |
| S13 | `facet-only` + `rule_coverage` passthrough | stub answers `REPORT_DEGRADED` (`degraded: 'facet-only'`, `rule_coverage {exercised: 2, unexercised: [PAT-014/development, POL-1301/architecture]}`) | POST run; GET list; GET drilldown | all three carry `degraded: 'facet-only'` and `rule_coverage` deep-equal; `summary` equals the full-fidelity fixture's; a run from a report WITHOUT coverage lists a row with the key ABSENT (not null) | route + unit | ✅ `tests/testing-routes.test.ts`, `tests/eval-store.test.ts` |
| S14 | corpus pin preflight | `e2e/corpus/wicked-internal-corpus.json` + the sibling checkouts | `npm run evals:corpus:check` | exit 0 and `OK — 5 repos match pin_hash …` when every tag (and window-from tag) resolves to its pinned sha; exit 1 naming every drifted repo on a re-cut / deleted tag or a missing checkout; exit 2 on a hand-edited pin. Semantics proven over a 3-repo git fixture (annotated tag peels; floor met after walking 2 tags; shortfall with no older tag; shortfall at the 180-day cap; a non-release `api-types-v*` tag ignored; `pin` byte-idempotent) | unit (fixture) + script (real checkouts) | ✅ `tests/evals-internal-corpus.test.ts`; run against the real checkouts 2026-09-09: 5 ok, 0 drift |
| S14b | `run` seams | `samples.json` derived; a fake `wicked-core` first on PATH | `run <dir>` with (a) no binary on PATH, (b) a failing `rules ingest`, (c) an engine answering a report with `rule_coverage`, (d) a pre-#394 report | (a) exit 0 `SKIP — wicked-core is not on PATH`, no report; (b) exit 1 `TOOL FAILURE (…) — rules ingest failed (exit 1): …`; (c) exit 0 (gaps are findings), `report.json` written, `--corpus` received a DIRECTORY holding `samples.json`, `--db`/`--knowledge-db` temp paths, summary + `rule_coverage` lines printed; (d) `rule_coverage: not reported by this engine (predates core #394)`; missing `samples.json` is exit 2 | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts`; the real installed 0.4.0 exercises path (b) |
| S15 | corpus-anchored sample derivation | S14 passes | `node scripts/evals-internal-corpus.mjs samples <dir>`; parse `samples.json` with `ImportEvalCorpusSchema` | one sample per window commit, per-repo count = the pin's `commits`, newest first, ids `<repo>@<sha12>`, the from-tag's own commit excluded; every sample accepted by the REAL crew zod schema; `steering_type` by the path table with strict majority (tests/ → testing, `src/` and docs → development), overridable by known-bad; `kind` good unless known-bad names the id (reason → description); a stale known-bad id → exit 1 naming it; a moved tag → exit 1 `refusing to derive from the wrong history`, nothing written; byte-deterministic; `samples.meta.json` carries `pin_hash` = the pin's, `samples_hash` = sha256 of the array, `corpus_name` = `evals:wicked-internal@<hash16>` | unit (fixture) + script (real) | ✅ `tests/evals-internal-corpus.test.ts`; real derivation: 293 samples, all valid (§2) |
| S15b | materialize | S14 passes | `materialize <dir>` | `<dir>/<repo>@<tag>/` holds the tag's tree (a post-tag commit's file ABSENT), no transient `.tar` left, `materialized.json` receipt with the `pin_hash` and each `commit_sha`; a moved tag → exit 1, NOTHING extracted | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts`; real: 5 trees, 18 s |
| S16 | governed run ⇄ eval parity | S15; a daemon over a registered MATERIALIZED pinned repo; the SAME rule snapshot in both | one governed run whose brief targets a known-bad behavior class; capture the run's `PreToolUse` events | **Qualified oracle:** parity is asserted only when the live denial (a) came from a **rule decision** — the gate event names a blocking `rule_id` — not from governance infrastructure/recording failure (the hook denies on those too), (b) the eval sample's `phase`/`tool`/`files`/`content` are the run's actual projected signals, (c) the selector's phase set is reduced to the sample's single phase. Then: live `deny` by rule R ⇒ eval `caught` with `R ∈ fired`; live allow ⇒ eval `caught` (good) or `gap` (bad). **Explicit outcomes** for the agent not attempting the behavior (refusal / no tool call): recorded as `not-attempted`, NOT a parity pass or fail | governed | ⏳ S15 + #395 (a Deny-bearing rule must exist for a rule-sourced denial to be possible) + a known-bad entry |
| S17 | cross-release comparability | two recorded `EvalRunDetail`s over the same `evals:wicked-internal@<pin_hash>` + same `samples_hash`, different rule snapshots / engine builds, `--corpus` given explicitly on both | diff `results[].sample.id → verdict` | a per-sample flip report keyed by the five identities of §3; permitted flips: `gap→caught` (a rule tightened); flagged flips: `caught→gap`, `caught→false_positive` (a good sample newly denied); `summary` deltas must reconcile to the flip counts; a `rule_coverage` delta names which rules gained/lost exercise. (`good` is a sample kind, not a verdict — the draft's `good→false_positive` spelling is corrected.) Release over release = the SAME pin judged by the store of two successive daemon releases; a moved pin starts a new series | unit over two persisted records | ⏳ needs two recorded runs with #395 rules |
| S18 | wire spelling guard | stub `REPORT` (known gap `S-002` with ONE non-empty hint; caught + false_positive rows carry NO `nearest_rules`) | POST run; parse | every key at every depth matches `/^[a-z][a-z0-9_]*$/`; `summary.false_positives` numeric and `total = caught + gaps + false_positives`; each result's `sample` is exactly `{id, description, kind, steering_type}`; `expected` = `deny` iff `kind = bad`; `nearest_rules` is an array **iff** `verdict = gap` and ABSENT otherwise; the known gap's hint is `{rule_id: 'PAT-014', similarity: 0.62}`; `degraded` in-band; `rule_coverage` absent on a pre-#394 report | route | ✅ `tests/testing-routes.test.ts` (replaces the raw-substring assertions) |
| S18b | same against a REAL engine report | S11 | parse the CLI/route report with the S18 predicate | identical predicate passes | engine | ⏳ S10 |
| S19 | 501 parity | `evalsSupported=false` | POST import; POST run | both 501; both match the binding + `>= 0.7.5` pointer; the texts differ ONLY in the action prefix (`Importing an eval corpus` / `Running governance evals`) — the remainder is byte-identical | route | ✅ `tests/testing-routes.test.ts` |
| S20 | studio Evals section round-trip | crew + studio + engine; a recorded history | Testing → **Evals** rail section → Run; refresh | **deterministic browser check, not a governed run** (the Evals button calls `runEvals()` directly and refreshes the history — no worker is launched). Assert: `eval-history-row` count increments by 1; the new row's displayed counts equal `summary`; `eval-history-detail` renders the same per-sample verdicts as `GET /testing/evals/:id`; `testing-evals-degraded` shows the honest hint-mode text (not "an embedder would close gaps"); a reload keeps the row | live (Playwright) | ⏳ studio copy fix (the degraded hint text) + daemon with #394 engine |
| S21 | verdict matrix under controlled rules | isolated db with FOUR authored rules: `deny` on `git push --force`; `allow_with_conditions` on `migrations/`; a `warn` rule; a RETIRED `deny` | 4 samples: bad force-push; bad migration (only the conditional fires); good lint fix; bad behavior matching only the retired rule | `caught` (fired = [deny-rule]); `gap` (conditional does not count); `caught` (good allowed, `fired` empty); `gap` (retired rules never fire) — the four cases of `evaluate_sample` each hit once; `warn` never appears in `fired` | engine | ⏳ #395 |
| S22 | seven-type slices + cross-type eligibility | S21's db + samples tagged across all 7 types incl. an empty type | `--type <t>` for each of the 7 | each slice's `total` = that type's sample count (0 for the empty slice → `summary` all zeros, `results: []`); a rule of type A fires on a sample of type B (the `--type` filter slices SAMPLES, never rules); `per_type` (crew) reconciles to `summary` | engine + route | ⏳ #395 |
| S23 | phase inclusion/exclusion | rules with `applies_to: [build]`, `excludes: [recon]` | samples with `phase` build / recon / absent (→ `DEFAULT_EVAL_PHASE`) | selected only in build; never in recon; the default phase is the documented one | engine | ⏳ #395 |
| S24 | import semantics | `evalsSupported=true` real seam, temp knowledge db | import `evals:x` twice with different sample sets; import with duplicate `id`s; run with `corpus: evals:missing` | the second import REPLACES the scope (run reports the second set only); duplicate ids rejected or de-duplicated deterministically (pin whichever the engine does); unknown corpus → 500 with a message naming the scope, never an empty 200 | engine | ⏳ engine build in CI |
| S25 | memory axis (core follow-up) | a store with faceted memories; a sample whose facets should recall memory M | run the faceted recall the workers use per sample | `caught` (M surfaced), `gap` (M did not), `false_positive` (an irrelevant memory surfaced) — the SAME verdict vocabulary as a second axis; per-memory coverage like `rule_coverage` | engine | ⏳ core issue (memory-aware evals) |

**Dependency layers (revised):** corpus preflight **S14 first** (it gates every anchored
derivation) → store unit S1–S4 → route unit S5–S9b, S13, S18, S19 → derivation S15/S15b →
`run` seams S14b → engine S10–S12, S18b, S21–S24 → anchored S17 → live S20 → governed S16. S9
(stub) creates no real corpus, so a real import of the derived samples goes through the REAL seam
(`describe.runIf(EVALS_CAPABLE)` in `testing-routes.test.ts` is the precedent, with
`WICKED_CREW_KNOWLEDGE_DB` armed by `tests/setup/hermetic-home.ts`). S16's capture and import are
separate stages: capture writes the sample file; S15's derivation validates and lands it; only
then does the parity check run.

## 5. Per-run provenance to record (follow-up, engine + crew)

Each `EvalRunSummary` should additionally carry, verbatim from the engine or stamped by the
daemon at run time: `corpus_payload_hash` (= `samples_hash` for a derived corpus),
`rule_snapshot_hash` (over the active rule set at run time), `engine_build` (`wicked-core-ts`
version + addon hash). With those, an S17 diff is keyed by the full identity tuple and two rows
with equal tuples must have equal `results` — a property test worth adding once the fields exist.
Until then, `rule_store` (a path) and `degraded` are the only persisted provenance, and a
comparison must record the other three by hand in the run notes. The import receipt should
likewise gain `payload_hash` so a `POST /testing/corpora/import` of `samples.json` is checkable
against `samples.meta.json`.

## 6. Corrections to the draft (factual)

- The plane-boundary rule is **`POL-1301`** (`seed/corpus/plane-boundaries.md`), not `PAT-1301`.
- The existing traversal test already covered **seven** shapes; S2 extends it to fourteen and adds
  the HTTP-route variant.
- `nearest_rules: []` on a `false_positive` row in the fixtures contradicted the engine (omitted
  on non-gaps) — both fixtures corrected.
- "Zero overlap" / "structurally can never exercise" were overclaims for the UNIVERSAL rules:
  `universal-donts.md` prohibits skipping failing tests (matches `samples.json`'s
  deleted-failing-tests sample) and `mcp-surface.md` addresses the custom-protocol sample. The
  corpus/steering question is three separate ones — domain applicability (why the corpus is our
  own repos), sample coverage (#394), enforcement capability (#395).
- `degraded` is decided by rule-rationale vectors, not corpus embeddings; omitting `--knowledge-db`
  selects the operator's default db rather than disabling embeddings.
- Revision 2's wicked-e2e lock (15 repos, `.codegraph/` exclusions) is withdrawn: that set is the
  E2E functional corpus, not an eval corpus. Nothing in it was reset or modified.
- `rules eval --corpus` takes a directory or an `evals:` scope, never a file (wicked-core.rs
  `rules_eval_cmd`); the plan's `run` stages a corpus directory accordingly.
- S20 is deterministic; S16 is the only governed scenario, with the qualified oracle above.
