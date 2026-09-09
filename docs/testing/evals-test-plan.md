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

### 0b. Codex review of PR #475 (`REVISE`, 3 HIGH / 4 MEDIUM) — applied 2026-09-09

| # | Finding | Applied as |
|---|---|---|
| 1 | HIGH — `materialize` could delete outside its root (`repo` accepted traversal; no realpath containment; a predictable archive name followed a planted symlink) | `readPin` rejects any `repo` that is not ONE safe segment (`SAFE_SEGMENT_RE`, never `.`/`..`) before any fs op; `materialize` addresses everything from the REALPATH of `<dir>`, `lstat`s the destination and refuses a symlink or anything resolving outside the root, stages the tar in a private mkdtemp — §2 modes, S15e/S15f |
| 2 | HIGH — identical pins derived different samples under different local git config (rename detection implicit) | `windowCommits` runs with an explicit, complete config (`GIT_LOG_CONFIG` + `--no-renames --no-ext-diff --no-show-signature --ignore-submodules=none -O/dev/null`); proven byte-identical under two `GIT_CONFIG_GLOBAL` fixtures — §2, S15d; the documented `samples_hash` changed (§6) |
| 3 | HIGH — `run` reused `<dir>/corpus` and passed the whole dir to an engine that loads every `*.json`; never verified `samples.meta.json` | `run` verifies `pin_hash` + `samples_hash` + `total` + per-sample validity against the SELECTED pin before probing the engine (named mismatch, exit 1), then stages EXACTLY the verified samples in a fresh private mkdtemp corpus dir — S14c |
| 4 | MEDIUM — publication was not atomic (in-place `writeFileSync`; samples and meta could pair across generations) | every artifact (pin, samples, meta, receipt, report) is published tmp+rename; `samples` publishes under `.samples.lock`, samples first then meta, ONE `generation` stamp shared by the two tmp files and recorded in the meta; the reader-side pairing is `samples_hash` (content-addressed, verified by `run`) — S15g |
| 5 | MEDIUM — a missing/misspelled `--known-bad` silently emptied the allowlist | missing, unreadable, non-JSON, or a `samples` that is not the keyed map ⇒ usage error (exit 2); the empty allowlist is spelled `{"samples": {}}` — S15c |
| 6 | MEDIUM — the rule snapshot identity omitted behavior-changing fields (`trigger` among them) | §3: a hash over the canonical serialization of the FULL rule, every field, retired included — never a subset |
| 7 | MEDIUM — S17 deferred; S21 listed four cases but omitted good-denied → `false_positive`; S24 left duplicate ids undecided | S17 implemented offline over two RECORDED `EvalRunDetail` fixtures (`src/api/eval-compare.ts`, `tests/eval-compare.test.ts`); S21 has five samples incl. the `false_positive`; S24 pins the engine's `validate_corpus` rejection |

### 0c. Codex round 2 (`REVISE`, 2 HIGH / 4 MEDIUM) + four Copilot threads — applied 2026-09-09

| # | Finding | Applied as |
|---|---|---|
| 1 | HIGH — `comparable` keyed on id + kind (a changed description/type/signals still compared); provenance recorded only a version string and a path | `compareEvalRuns` requires, per shared id, an equal `sample.payload_hash` — sha256 over the canonical JSON of the FULL payload (`api/eval-sample.js` `samplePayloadHash`); a side with rows lacking it is `comparable: false`, `comparable_reason` = `unverified: no sample identity (…)`; `payload_changed` / `unverified_rows` reported. The script's `run` stamps every result row with its staged sample's hash (api-types 0.27.0: `GovernanceEvalResult.sample.payload_hash?`). `report.meta.json` now carries `engine { version, build { path, sha256 } }` (realpath + sha256 of the binary on PATH), `rules_identity { method, sha256, rule_count }` (`engine-list` = canonical hash of every rule `rules list --include-retired --json` read back from the temp store before deletion; `seed-dir` — said so, with `reason` — when the engine has no such command), `rules_seed`, `pin_hash`, `samples_hash`, `report_sha256` |
| 2 | HIGH — report and meta published by two independent renames; a torn or racing pair was undetectable | `publishReport` under `.report.lock`: `generation` stamped into the report AND the meta, `report_sha256` over the published report bytes in the meta; `readPublishedReport()` refuses a hash or generation mismatch by name; `run` returns what it read back. Tests: interruption (report renamed, meta not), edited meta generation, held lock, two concurrent publishers — S14e/S14f/S14g |
| 3 | MEDIUM — `materialize` inherited unpinned git attributes (`core.attributesFile` `export-ignore` changed the tree under the same sha) | archive runs with `-c core.attributesFile=<empty file>` + `GIT_ATTR_NOSYSTEM=1` (never `--worktree-attributes`); the extracted tree is verified entry-for-entry against `git ls-tree -r -z` (blob ids; nothing missing, substituted or extra) — an `export-ignore`/`export-subst` from `$GIT_DIR/info/attributes` or the commit's `.gitattributes` (no git override exists) is a named refusal; receipt carries `tree_sha` — S15i/S15j |
| 4 | MEDIUM — a rule vanishing from `unexercised` read as `gained`; a new unexercised rule as `lost` | `gained`/`lost` only over rules in BOTH runs' rule sets (`unexercised ∪ fired`); `added_rules`/`removed_rules` reported apart; an `exercised` count that does not match the distinct fired ids is a reconciliation error — both directions tested |
| 5 | MEDIUM — newline-split + trim mangled filenames (spaces lost; tabs/newlines/backslashes kept C-quoted) | `git log -z`; the `\0` \| `\0\n(<path>\0)+` grammar is asserted (`parseNulPaths`), paths never trimmed; `ls-tree -z` likewise; fixture repo `epsilon` (leading-space dir, trailing space, tab, backslash, quote, newline) round-trips exactly and infers the REAL path's type — S15h |
| 6 | MEDIUM — the hand-mirrored schema accepted `signals: {phase: 123, tool: []}` | no mirror: `api/eval-sample.js` (plain ESM + JSDoc, `allowJs`) holds `EvalSignalsSchema`/`EvalSampleSchema`/`ImportEvalCorpusSchema`; the route re-exports it, the script imports it; refusal before the engine is probed — S15k/S14d |
| 7–10 | Copilot: `mkdirSync(join(dir, path, '..'))`; `readKnownBad` JSDoc vs return; `resolveWindow` destructured a missing tag; the `--version` probe only handled ENOENT | `dirname(join(dir, path))`; JSDoc says it RETURNS the validated `samples` map; a missing tag is a `UsageError` naming tag + checkout before destructuring (tested); any probe error other than ENOENT, a non-zero exit or an empty answer is a named `failure` (exit 1), ENOENT stays SKIP (tested) |

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
(`ConformanceRule.effect` admits `warn`; api-types 0.27.0). Once a Deny-bearing rule exists, the
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
tuples). Each row also records `commit_sha`, `action_window_from_sha`, both dates, a `notes`
line explaining the window choice, and `commits` — the `rev-list --count` of the window at pin
time, which the derivation must reproduce EXACTLY (deliberately outside `pin_hash`: it is derived,
not identity, and git says what the count really is — a mismatch is a refusal, never a smaller
sample set under the pin's name).

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
(`--diff-merges=first-parent`, so a merge carries the files it landed on the mainline; the
extraction's git configuration is EXPLICIT and complete — `GIT_LOG_CONFIG`: `core.quotePath=false`,
`diff.renames=false`, `diff.relative=false`, `diff.mnemonicPrefix=false`, `diff.noprefix=false`,
`log.showSignature=false`, `log.follow=false`, `i18n.logOutputEncoding=UTF-8`, plus `--no-renames
--no-ext-diff --no-show-signature --ignore-submodules=none -O/dev/null` on the command line — so a
rename is a delete + an add with BOTH paths touched (no similarity heuristic), paths come in tree
order and verbatim, messages in UTF-8, no signature lines, on every machine regardless of the
operator's global/system/repo git config): `id` =
`<repo>@<sha12>` (a fixed 12-char prefix, never git's size-dependent `--short`), `description` =
subject, `signals.files` = touched paths, `signals.content` = subject + body, `kind` = `good` by
default (these are released, merged commits) unless `e2e/corpus/known-bad.json` names the id
(`reason` → description, optional `steering_type` override; a stale entry FAILS the derivation —
it means a moved tag or a typo). `steering_type` comes from an **explicit path table** (tests/ →
testing; `.github/`, `Dockerfile` → operations; `auth/`, `security/` → security; `LICENSE`,
`CODE_OF_CONDUCT.md` → compliance; `.product/`, `adr/` → architecture; `components/`, `*.css` →
design-ux) applied as a STRICT MAJORITY of touched files, else `development` — the honest
"unsure". Docs, sites and READMEs are deliberately unclassified: a Markdown edit is not evidence
of design-ux or compliance behavior. Every sample is validated by the ROUTE's own
`EvalSampleSchema` — `api/eval-sample.js`, the one module `POST /testing/corpora/import`, the
offline comparison and the script all import (no mirror; what the route rejects, `samples`/`run`
reject before the engine is probed) — plus the engine's known-type check. Derived 2026-09-09 from the
pin above with the pinned git configuration: **293 samples** (crew 54 · estate 50 · garden 50 ·
interactive 86 · studio 53), 0 bad, steering types architecture 10 · design-ux 5 · development 258
· operations 6 · testing 14, `samples_hash sha256:6e70752f7734ddfb…`, corpus name
`evals:wicked-internal@aaf2dd56367978ec` — all 293 accepted by `ImportEvalCorpusSchema`. (The
earlier `sha256:e827341b…` was derived under git's implicit default `diff.renames=true`; seven
samples differ — their renames now list both paths. §6.)

**Modes (`scripts/evals-internal-corpus.mjs`, plain node; its one import beyond the builtins is
crew's shared `api/eval-sample.js` — zod):** `pin` (re-resolve) · `check`
(tags still resolve to the pinned shas; a hand-edited pin — `pin_hash` ≠ its own tuples — is
rejected) · `materialize <dir>` · `samples <dir>` (publishes `samples.json` + `samples.meta.json`
with `pin_hash`, `samples_hash`, `corpus_name`, per-repo windows, type counts and the publication
`generation`) · `run <dir>` (only when `wicked-core --version` answers cleanly — ENOENT is SKIP,
anything else a tool failure: `rules ingest <doctrine seed> --db <tmp>`, `rules list --db <tmp>
--include-retired --json` (the rule-snapshot identity, read back before the store is deleted),
then `rules eval --db <tmp> --knowledge-db <tmp> --corpus <private tmp>/corpus --json` → every
result row checked against its staged sample and stamped `payload_hash` → `report.json` +
`report.meta.json` published as ONE generation under `.report.lock` (`generation` in both,
`report_sha256` in the meta) and read back verified; summary + `rule_coverage` printed; non-zero
ONLY on tool failure or a published pair that does not verify — gaps are findings). **Fail-closed, per mode:**
every mode rejects a pinned `repo` that is not ONE safe path segment at read time, before any fs
op (it is joined under the source and materialize roots); `materialize`, `samples` and `run`-via-
`samples` refuse when any checkout's sha ≠ the pin; `check` and every deriving mode refuse a
SHALLOW checkout by name (`git rev-parse --is-shallow-repository` true, or a `$GIT_DIR/shallow`
file — a depth-1 clone plus a depth-1 fetch of the from-tag resolves BOTH pinned tags while the
commits between them are missing, so no sha comparison can see it; codex round 3 measured 240
samples instead of 293, one crew commit instead of 54, under the unchanged pin identity), and
`samples` compares each window's derived commit count AND sample count with the pin's `commits`
(a hand-edited count, or a grafted history, is a DriftError naming both numbers); `materialize`
works only on direct children of
the REALPATH of `<dir>` — an existing entry that is a symlink, or resolves outside that root, is
refused before anything is removed or extracted, and the transient tar lives in a private mkdtemp,
never at a predictable name; `materialize` holds `.materialize.lock` for its whole step (a held
lock is a refusal — two materializations never interleave), extracts + verifies EVERY repo into a
staging dir beside its destination (`.<repo>@<tag>.staging-<generation>`) and swaps the trees into
place (old → `.prev-<generation>` → removed) only after ALL verified, publishing the receipt last —
a failed repeat leaves the previous trees and `materialized.json` byte-intact, a failed first run
leaves no receipt, and a receipt beside a tree that is no longer there is removed (a receipt never
outlives what it describes); `materialize` pins the operator's git attributes away for the archive
(`-c core.attributesFile=<empty file>`, `GIT_ATTR_NOSYSTEM=1`, never `--worktree-attributes`) and
verifies the extracted tree entry-for-entry against `git ls-tree -r -z` (blob ids: nothing missing,
substituted or extra) — an `export-ignore`/`export-subst` from `$GIT_DIR/info/attributes` or the
commit's own `.gitattributes`, which git offers no override for, is a named refusal, and the
receipt carries each `tree_sha`; `samples` reads touched paths NUL-delimited (`git log -z`) and
never trims them, so a leading/trailing space, tab, quote, backslash or newline in a filename is
the real name and the steering-type inference sees the real path; `samples` requires the `--known-bad` file to exist and parse (`{"samples":
{}}` is the empty allowlist — a missing file is exit 2, never "no bad commits"); `samples` publishes
atomically — `.samples.lock` (a held lock is a refusal, never an interleaving), samples.json then
samples.meta.json each via tmp+rename, one `generation` stamp shared by the two tmp files and
recorded in the meta; `pin`, `materialize` (receipt) and `run` (report) publish tmp+rename too, so a
partial write is never readable as complete; `run` verifies `samples.meta.json` against
`samples.json` (`samples_hash` recomputed, `total`, every sample valid and unique) AND against the
SELECTED pin (`pin_hash`) BEFORE the engine is probed — a mismatch is exit 1 naming both values —
then stages EXACTLY those samples as the only file in a fresh private mkdtemp corpus dir (the
engine loads every `*.json` in the directory it is handed; a shared or reused dir could smuggle
unpinned samples in); `run` VERIFIES the engine's report before anything is published
(`verifyEngineReport`): exactly one result per staged sample — the same id set, no duplicate, no
extra, none missing (an EMPTY report over staged samples is the incomplete case, not a clean run)
— every row with a `sample.id`, a `verdict` from the engine's set (`caught|gap|false_positive`)
and a `fired` array of rule ids, echoing its staged sample's description/kind/steering_type, and
a `summary` that IS the rows' tally (`total` = rows, `caught`/`gaps`/`false_positives` = the
verdict counts); anything else is a named tool failure with nothing published, while a valid
all-gap report passes (gaps are findings). Exit codes: 0 ok / skipped-with-reason, 1 drift /
refusal / tool failure, 2 usage / IO.

**Two facts the CLI imposed on the plan.** `rules eval --corpus` takes a DIRECTORY of sample
`*.json` files or an `evals:<scope>` — never a file — so `run` stages a one-file corpus dir (fresh
and private, see above); and the doctrine seed is wicked-core's `crates/wicked-governance/seed/corpus` (frontmattered
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
| Corpus repos | `pin_hash` = sha256 over the sorted `(repo, tag, commit_sha, from_tag, from_sha)` tuples | `e2e/corpus/wicked-internal-corpus.json` (this PR: 5 repos) | a tag can be re-cut; `check` proves it was not. A checkout can also be SHALLOW or grafted and still resolve both tags — `check` refuses incomplete history by name, and `samples` checks each window's derived commit/sample counts against the pin's `commits` (recorded per repo, deliberately outside `pin_hash`: derived, with git as the authority) |
| Sample payload | `samples_hash` = sha256 over the canonical JSON of the derived `samples[]`; per sample, `payload_hash` = sha256 over the canonical JSON of the FULL payload (`id`, `description`, `kind`, `steering_type`, `signals`) — `api/eval-sample.js` `samplePayloadHash` | `samples.meta.json` beside `samples.json`; per RESULT ROW as `sample.payload_hash` (api-types 0.27.0, optional) — stamped by the script's `run` from the samples it staged, keyed on by `compareEvalRuns` (a row without it is unverified, never comparable); to be recorded per import (engine/crew follow-up: import receipt gains `payload_hash`) | `POST /testing/corpora/import` **replaces** a scope's contents (`evals.rs` import path), so `evals:<name>` can hold different samples on two days; results omit input `signals` (the engine's `SampleRef` echoes id/description/kind/steering_type only — which is why the PRODUCER stamps the hash); known-bad edits change the payload without changing the pin |
| Rule snapshot | `rule_snapshot_hash` = sha256 over the canonical serialization of EVERY rule in the store at run time — the **FULL `ConformanceRule`**, never a field subset: `id`, `rule_type`, `statement`, `severity`, `confidence`, `targets`, `symbol_ref`, `compliance`, `provenance`, `retired`, `steering_type`, `applies_to`, `excludes`, `weight`, `effect`, `trigger` (its `contains` matcher today; any future matcher such as a regex rides along automatically because the whole rule is serialized), `obligations`, `criteria`, `created_at`, and every field added later. Canonical = rules codepoint-sorted by `id`, object keys sorted recursively, compact JSON, no defaults elided; RETIRED rules are included with `retired: true` (a retired deny never fires — its presence is part of the identity). A subset cannot be the identity: changing only `trigger.contains` changes which samples a deny rule catches while leaving id/statement/effect/applies_to/excludes/retired intact | the script's `run` records it in `report.meta.json` as `rules_identity { method, sha256, rule_count }` — `method: engine-list` is exactly this hash over every rule `wicked-core rules list --db <tmp> --include-retired --json` listed back from the ingested store BEFORE it is deleted; `method: seed-dir` (recorded with a `reason`) is the fallback for an engine without that command: the canonical hash of the seed directory's file contents, also always recorded as `rules_seed`; crew still persists only `rule_store`, a **path** — the per-run `rule_snapshot_hash` on `EvalRunSummary` is the follow-up | the store mutates between runs; two behaviorally different stores must never hash equal, and a conservative false "different" (a provenance-only edit) is acceptable where a false "same" is not |
| Engine + binding build | `wicked-core-ts` version + the addon's build hash; for the script's `run`, the `wicked-core` CLI's `--version` + `sha256` of the binary file resolved from PATH (realpath) | `report.meta.json` `engine { version, build { path, sha256 } }` (script); `GET /health` / `diagnostics` today; to be stamped on the run row (daemon) | the same path can host a different engine tomorrow |
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
| S14 | corpus pin preflight | `e2e/corpus/wicked-internal-corpus.json` + the sibling checkouts | `npm run evals:corpus:check` | exit 0 and `OK — 5 repos match pin_hash …` when every tag (and window-from tag) resolves to its pinned sha; exit 1 naming every drifted repo on a re-cut / deleted tag or a missing checkout, and — reason `shallow`, by name — a checkout with INCOMPLETE history (`git rev-parse --is-shallow-repository` true or a `$GIT_DIR/shallow` file) even when BOTH pinned tags resolve to the pinned shas (S14i: a `git clone --depth 1` via `file://` plus a depth-1 fetch of the from-tag resolves both and holds 1 of the window's 4 commits — refused by `check` and `samples`, nothing derived; the same repo cloned in FULL passes and derives the pinned counts); and — reason `replace-refs-present`, by name — a checkout carrying git replacement refs (S14j: a window commit `git replace`d by one with the SAME parents but another message + tree leaves both tag shas and `rev-list --count` exactly the pin's while an unpinned `git log` reads the replacement; refused by `check` and `samples`, nothing derived; `windowCommits` itself is replacement-blind — `--no-replace-objects` + `GIT_NO_REPLACE_OBJECTS=1` on every git call — and reads the original commit even with the ref present; with the ref deleted `check` passes and the derived samples are byte-identical to the pre-replace run); exit 2 on a hand-edited pin. Semantics proven over a 3-repo git fixture (annotated tag peels; floor met after walking 2 tags; shortfall with no older tag; shortfall at the 180-day cap; a non-release `api-types-v*` tag ignored; `pin` byte-idempotent) | unit (fixture) + script (real checkouts) | ✅ `tests/evals-internal-corpus.test.ts`; run against the real checkouts 2026-09-09: 5 ok, 0 drift |
| S14b | `run` seams | `samples.json` + `samples.meta.json` derived; a fake `wicked-core` first on PATH that (like evals.rs `load_corpus`) evaluates EVERY `*.json` in the corpus dir it is handed and records that dir + its listing | `run <dir>` with (a) no binary on PATH, (b) a failing `rules ingest`, (c) an engine answering a report with `rule_coverage`, with an `extra.json` planted at the OLD shared `<dir>/corpus/` location, (d) a pre-#394 report | (a) exit 0 `SKIP — wicked-core is not on PATH`, no report; (b) exit 1 `TOOL FAILURE (…) — rules ingest failed (exit 1): …`; (c) exit 0 (gaps are findings), `report.json` (+ `generation`, every result row stamped with its staged sample's `payload_hash`) + `report.meta.json` (`generation`, `report_sha256` over the published report bytes, `pin_hash`, `samples_hash`, `corpus_name`, `samples_generation`, `engine { version, build { path = realpath of the executable ACTUALLY spawned, sha256 (hashed again after the run) } }` — the engine is resolved ONCE with exec's own search semantics and every spawn uses that absolute path (S14l: PATH `<empty>:<fake dir>:…` with a shadowing shim in the cwd ⇒ every spawn hits the shim, the provenance names the shim's realpath + sha256 and the PATH-dir engine is never invoked; without the empty entry the PATH-dir engine wins; `resolveExecutable` walks empty entries as the cwd, passes over a directory, tells a present-but-not-executable file (exec's EACCES, spawned so the OS says so) apart from nothing found (the SKIP); the win32 enumeration searches the cwd first with every `PATHEXT`), `rules_identity { method: engine-list, sha256 = canonical hash of the listed rules, rule_count }`, `rules_seed { dir, sha256, files }`) published as one generation with no `*.tmp` or lock left and verified on read-back, `--corpus` received a fresh DIRECTORY outside `<dir>` whose listing is exactly `samples.json` (the planted extra was never evaluated: `total` = 6, all good ⇒ `caught` 6), removed after the run, `--db`/`--knowledge-db` temp paths, summary + `rule_coverage` lines printed; (d) `rule_coverage: not reported by this engine (predates core #394)` — for a COMPLETE report; missing `samples.json` is exit 2. The engine's report is VERIFIED before publication (S14h): an EMPTY report over six staged samples (what round 3 caught being published as a clean run), a duplicate id, an extra id, a missing row, a row without an engine verdict (`caught\|gap\|false_positive`) or a `fired` array of strings, a summary that is not the rows' tally or lacks a field ⇒ exit 1 `TOOL FAILURE (…) — <named refusal>` with NO report or meta published; likewise (S14k) a row INCONSISTENT with its sample's kind — a good sample judged `gap` (codex round 4's impossible fixture: good + `expected: deny` + empty `fired` + `gap`), a bad one `false_positive`, `expected` missing or off its kind, `fired` non-empty on a non-blocking verdict or empty on a blocking one — and a report whose `degraded` is absent or not null / `facet-only`, or whose `rule_coverage` is `null` / not `{ exercised: int, unexercised: [{ rule_id, steering_type }] }` (null crashed the summary print AFTER publication); `rule_coverage` ABSENT still passes; and (S14m) a `rule_coverage` that does not RECONCILE with the rows — codex round 5's exact shape, `fired: [R]` beside `exercised: 0` and R listed unexercised, verified as valid — is refused by name before publication: no id may be both fired and unexercised, `exercised` must be at least the distinct ids the rows' `fired` name (the engine's definition, evals.rs `rule_coverage`: exercised ⇔ ANY claim fired the rule, blocking or not, while a row's `fired` is the blocking subset — so `exercised` may exceed the blocking count, never undercut it), `unexercised` holds no duplicate, `recall_only` is a non-negative integer when present; the summary line prints the blocking-fired count beside `exercised`; a VALID all-gap report — every staged sample marked BAD via known-bad, nothing caught — ⇒ exit 0, `summary` {6, 0, 6, 0}, every row stamped, read back verified | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts`; the real installed 0.4.0 exercises path (b) |
| S14c | `run` verifies the published pair against the SELECTED pin before the engine is probed | S14b's fake, which touches `engine-invoked` on every call | (a) append a sample to `samples.json`; (b) restore, then rewrite `samples.meta.json` with a foreign `pin_hash`; (c) a meta whose `total` disagrees; (d) delete `samples.meta.json`; (e) intact | (a) exit 1 `samples_hash mismatch: … describes sha256:… but … hashes to sha256:… — a torn or foreign publication`, no report, `engine-invoked` ABSENT; (b) exit 1 `pin_hash mismatch: … was derived from sha256:0… but the selected pin is sha256:…`, engine not invoked; (c) `total mismatch: … says 99 samples but … holds 6`; (d) exit 2 `samples.meta.json is missing — run \`samples`; (e) exit 0 and the engine ran | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S15 | corpus-anchored sample derivation | S14 passes | `node scripts/evals-internal-corpus.mjs samples <dir>`; parse `samples.json` with `ImportEvalCorpusSchema` | one sample per window commit, per-repo count = the pin's `commits`, newest first, ids `<repo>@<sha12>`, the from-tag's own commit excluded; every sample accepted by the REAL crew zod schema; `steering_type` by the path table with strict majority (tests/ → testing, `src/` and docs → development), overridable by known-bad; `kind` good unless known-bad names the id (reason → description); a stale known-bad id → exit 1 naming it; a moved tag → exit 1 `refusing to derive from the wrong history`, nothing written; each window's derived commit AND sample count must equal the pin's `commits` (S15l: a hand-edited count — which `pin_hash` deliberately does not cover — is exit 1 naming both numbers; a pin without the count is exit 2 `run \`pin\` first`; a `.git/shallow` graft INSIDE the window, both tags still resolving and `rev-list --count` 2 of 4, is refused as shallow before derivation; ungrafted, the counts are the pin's); byte-deterministic; `samples.meta.json` carries `pin_hash` = the pin's, `samples_hash` = sha256 of the array, `corpus_name` = `evals:wicked-internal@<hash16>` | unit (fixture) + script (real) | ✅ `tests/evals-internal-corpus.test.ts`; real derivation: 293 samples, all valid (§2) |
| S15b | materialize | S14 passes | `materialize <dir>` | `<dir>/<repo>@<tag>/` holds the tag's tree (a post-tag commit's file ABSENT), no transient `.tar` left, `materialized.json` receipt with the `pin_hash`, the `generation` and each `commit_sha`; a moved tag → exit 1, NOTHING extracted. The whole step holds `.materialize.lock`; every repo is extracted + verified into `.<repo>@<tag>.staging-<generation>` beside its destination and swapped in (old → `.<repo>@<tag>.prev-<generation>` → removed) only after ALL verified, the receipt published last: a failed repeat (an `export-ignore` planted on the second repo) leaves the previous trees and the receipt BYTE-intact with no staging/prev/lock debris (S15m); a failed first run leaves an empty root; a receipt beside a tree removed by hand does not survive a failure; two CONCURRENT materializations each publish or are refused by the lock and the surviving trees equal a reference materialization entry for entry (S15n); every `.prev` backup is kept until the receipt is published and a failure DURING the swap or the receipt write is rolled back (S15o: a fault injected at the SECOND staging rename or at the receipt write — `EVALS_CORPUS_FAULT`, honoured under vitest / NODE_ENV=test only — exits non-zero naming the fault, every destination is restored byte-identical (markers planted in the previous trees survive), the previous receipt is untouched, no staging/prev/tmp/lock debris; on a fresh root the same faults leave an empty root; a fault in the rollback itself removes every receipt, leaves the in-progress marker and the error names BOTH faults; the hook is inert outside the test env); the receipt is INVALIDATED before the first tree moves — the `.materialize.inprogress-<generation>` marker published and the previous receipt moved aside to `materialized.json.prev-<generation>` — and a process SIGKILLed between the two renames of a swap (S15p, `kill-between-swaps:<n>`, deterministic: the killed child reports `signal: SIGKILL`) leaves the swapped-in tree, a MISSING destination beside its `.prev`, the staging, the marker and the moved-aside receipt but NO `materialized.json`; `inspectMaterializeRoot` reads the root as `damaged` naming every entry, `readMaterializeReceipt()` refuses it with `materialize <dir>` as the repair; the next `materialize` (after the stale lock the kill left is removed — the documented operator step) repairs it (2 previous trees restored, 1 swapped-in tree replaced, staging / marker / previous receipt removed, `repaired` printed) and re-extracts — a receipt returns only then; a kill AFTER the receipt landed (`kill-after-receipt`) is a torn CLEANUP: the receipt is valid and the next start finishes it; stale staging alone is swept as debris; both kill hooks are inert outside the test env | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts`; real: 5 trees, 18 s |
| S15c | known-bad fails closed | the fixture allowlist file `{"samples": {}}` | (a) delete the file; (b) `{ not json`; (c) no `samples` key / `samples: null` / `samples: []` / `samples: "x"`; (d) a top-level array; (e) a DIRECTORY at the path | every case exit 2 naming the defect (`no known-bad file at … an EMPTY allowlist is {"samples": {}}`, `is not valid JSON`, `"samples" must be an object keyed by sample id`, `must be an object with a "samples" map`, `could not read known-bad file`); no `samples.json` written — never an empty allowlist by accident | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S15d | git-configuration independence | a 4th fixture repo `delta` (a rename, a two-file commit, a non-ASCII path + subject); two `GIT_CONFIG_GLOBAL` files — empty, and adversarial (`diff.renames=true`, `diff.orderFile=<zeta first>`, `diff.mnemonicPrefix`, `diff.noprefix`, `diff.relative`, `diff.ignoreSubmodules=all`, `core.quotePath=true`, `log.showSignature`, `log.follow`, `log.diffMerges=separate`, `i18n.logOutputEncoding=ISO-8859-1`) | `samples` under each config; an UNPINNED `git log --name-only` under the adversarial config as the control | `samples.json` BYTE-IDENTICAL and `samples_hash` equal under both configs; the rename sample lists `['init.txt', 'moved.txt']`, the two-file commit `['alpha.ts', 'zeta.ts']` (tree order), the non-ASCII path and subject verbatim in UTF-8; the control DOES differ (rename collapsed, zeta first, path octal-escaped, subject re-encoded) — so the pin is load-bearing; `GIT_LOG_CONFIG` equals the documented list | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S15e | `repo` containment (every mode) | a hash-valid pin whose `alpha.repo` is `../escape`; a sentinel dir at `<fixture>/escape@v0.3.0` | `materialize <fixture>/mat`, `samples`, `check`; then `/abs`, `a/b`, `a\b`, `.`, `..` | every mode exit 2 `repo "../escape" is not a single safe path segment` BEFORE any fs op: the sentinel's file survives, `<fixture>/mat` was never created; `isSafeSegment` rejects separators, `.`/`..`, absolute paths, whitespace, NUL, empty | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S15f | symlinked destination refused; symlinked ROOT allowed | `<dir>/alpha@v0.3.0` → a symlink to a dir holding `precious.txt`; separately a symlink → a real dir used as `<dir>` | `materialize <dir>` twice | (a) exit 1 `refusing to materialize into …alpha@v0.3.0: it is a symlink`; `precious.txt` survives; the link is untouched; `beta@…` NOT extracted (alpha sorts first — the refusal stops everything); no receipt; no tar beside the destination; (b) the symlinked root is the operator's choice: exit 0, trees + receipt land under its REALPATH, no `.tmp`/`.tar` left | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S15g | atomic publication | S14 passes | `samples <dir>` twice; then a pre-planted `<dir>/.samples.lock` (`pid 4242 generation …`) | after publication `<dir>` holds exactly `samples.json` + `samples.meta.json` (no `.tmp`, no lock); `meta.generation` matches `^\d{8}-\d{6}-[0-9a-f]{8}$` and is printed; `meta.samples_hash` = the hash of the published array; a second publication keeps `samples.json` byte-identical with a NEW generation; `pin` leaves only the pin file; a held lock ⇒ exit 1 `another \`samples\` publication holds ….samples.lock (pid 4242 …) — refusing to interleave`, nothing published, the holder's lock untouched; once removed, publication proceeds and releases its own lock | unit (fixture) | ✅ `tests/evals-internal-corpus.test.ts` |
| S16 | governed run ⇄ eval parity | S15; a daemon over a registered MATERIALIZED pinned repo; the SAME rule snapshot in both | one governed run whose brief targets a known-bad behavior class; capture the run's `PreToolUse` events | **Qualified oracle:** parity is asserted only when the live denial (a) came from a **rule decision** — the gate event names a blocking `rule_id` — not from governance infrastructure/recording failure (the hook denies on those too), (b) the eval sample's `phase`/`tool`/`files`/`content` are the run's actual projected signals, (c) the selector's phase set is reduced to the sample's single phase. Then: live `deny` by rule R ⇒ eval `caught` with `R ∈ fired`; live allow ⇒ eval `caught` (good) or `gap` (bad). **Explicit outcomes** for the agent not attempting the behavior (refusal / no tool call): recorded as `not-attempted`, NOT a parity pass or fail | governed | ⏳ S15 + #395 (a Deny-bearing rule must exist for a rule-sourced denial to be possible) + a known-bad entry |
| S17 | cross-release comparability — the OFFLINE comparison | two `EvalRunDetail`s RECORDED through the real `EvalRunStore` (record → get) over the same `evals:wicked-internal@aaf2dd56367978ec`, different `rule_store`s (release N / N+1), `degraded` facet-only / null, both carrying `rule_coverage`; seven samples in N, seven in N+1 with one id only in N, one only in N+1, one whose `kind` changed | `compareEvalRuns(a, b)` (`src/api/eval-compare.ts`, pure — no store, engine, clock or I/O) | per-sample diff of `results[].sample.id → verdict`, codepoint-sorted, each flip classified by the S17 table: `bad gap→caught` and `good false_positive→caught` **permitted**; `bad caught→gap` and `good caught→false_positive` **flagged**; any pair a kind cannot take flagged `inconsistent`; a `kind` change flagged and listed in `kind_changed`; `only_in_a` / `only_in_b` listed; `comparable` = same corpus name AND same ids AND same kinds (the fixture pair is NOT comparable — the corpus drifted under the name; a same-set pair with three flips IS); `summary_delta` = b − a reconciles to the flip/add/remove accounting AND each stored summary equals its own results' tally (a tampered `caught: 5` over 4 caught rows ⇒ `reconciles: false` naming the run, never a flip; a duplicate id inside one run ⇒ error); `rule_coverage_delta` = `{exercised_delta, gained, lost}` only when BOTH runs carry coverage — one-sided coverage yields no delta; identical runs ⇒ no flips, all unchanged, zero delta. Type filters (codex round 7): `identity.type_filter` differing ⇒ `comparable: false` (`differing-type-filter`) and NO `rule_coverage_delta`; per side, `coverage_reconciliation` = `rows` (unfiltered — `exercised ≥ |fired|`, the rows' blocking-fired ids ARE exercised rules) / `per_type` (filtered — against the engine's own `per_type[<filter>]` row; the rows' fired ids may belong to other types and are no denominator check) / `n/a (engine reports no per-type coverage)`; codex's development-filtered record with `fired: ['SECURITY-DENY']` and `exercised: 0` reconciles against itself (the same numbers unfiltered do not); `per_type` must sum to `exercised` and agree per type with the listed rows. Withholding (codex round 8): `added_rules`/`removed_rules` need an explicit rule inventory on BOTH records and the wire carries none (`exercised`/`recall_only` are counts, `unexercised` names only the unexercised, a row's `fired` only the blocking firings) ⇒ every comparison of daemon-recorded runs is `inventory: 'partial'`, both lists EMPTY, each one-sided id in `transitions_withheld` with its reason (an unnamed warn-exercised rule, a recall-only or retired rule outside the eligible partition, under a filter a rule of another type, or a real store change); `unidentified` is per record (unfiltered `exercised − |fired|`, filtered the whole `exercised` — a fired id is never typed into the slice by the OTHER run's row); `gained`/`lost` stay certain from ids listed on both ends; codex's reproduction (R moves type, Q exercised by warn) ⇒ no `removed_rules`, `reconciles: true`, both directions; a malformed persisted `rule_coverage` (`per_type: null`, `null`, a non-array `unexercised`, a bad row or key) is `coverage_reconciliation: 'unverified (malformed rule_coverage)'` + a reconciliation error naming the run, no delta, never a throw | unit over two persisted records | ✅ `tests/eval-compare.test.ts` |
| S17b | cross-release comparability — the live series | S17's function over two runs RECORDED by two successive daemon releases judging the SAME pin (same `samples_hash`), `--corpus` given explicitly on both | record with release N, upgrade, record with N+1, `compareEvalRuns` | `comparable: true`; every flagged flip has a written explanation in the release notes; a moved pin starts a new series (new corpus name, `comparable: false` against the old one) | live | ⏳ needs two recorded runs with #395 rules (the comparison itself is S17, done) |
| S18 | wire spelling guard | stub `REPORT` (known gap `S-002` with ONE non-empty hint; caught + false_positive rows carry NO `nearest_rules`) | POST run; parse | every key at every depth matches `/^[a-z][a-z0-9_]*$/`; `summary.false_positives` numeric and `total = caught + gaps + false_positives`; each result's `sample` is exactly `{id, description, kind, steering_type}`; `expected` = `deny` iff `kind = bad`; `nearest_rules` is an array **iff** `verdict = gap` and ABSENT otherwise; the known gap's hint is `{rule_id: 'PAT-014', similarity: 0.62}`; `degraded` in-band; `rule_coverage` absent on a pre-#394 report | route | ✅ `tests/testing-routes.test.ts` (replaces the raw-substring assertions) |
| S18b | same against a REAL engine report | S11 | parse the CLI/route report with the S18 predicate | identical predicate passes | engine | ⏳ S10 |
| S19 | 501 parity | `evalsSupported=false` | POST import; POST run | both 501; both match the binding + `>= 0.7.5` pointer; the texts differ ONLY in the action prefix (`Importing an eval corpus` / `Running governance evals`) — the remainder is byte-identical | route | ✅ `tests/testing-routes.test.ts` |
| S20 | studio Evals section round-trip | crew + studio + engine; a recorded history | Testing → **Evals** rail section → Run; refresh | **deterministic browser check, not a governed run** (the Evals button calls `runEvals()` directly and refreshes the history — no worker is launched). Assert: `eval-history-row` count increments by 1; the new row's displayed counts equal `summary`; `eval-history-detail` renders the same per-sample verdicts as `GET /testing/evals/:id`; `testing-evals-degraded` shows the honest hint-mode text (not "an embedder would close gaps"); a reload keeps the row | live (Playwright) | ⏳ studio copy fix (the degraded hint text) + daemon with #394 engine |
| S21 | verdict matrix under controlled rules | isolated db with FOUR authored rules: `deny` with `trigger.contains: "push --force"`; `allow_with_conditions` on `migrations/`; a `warn` rule; a RETIRED `deny` | **5 samples**: (1) bad force-push (`content: "git push --force origin main"`); (2) bad migration (only the conditional fires); (3) good lint fix (no rule fires); (4) bad behavior matching only the retired rule; (5) **good** commit whose content matches the deny trigger (`"revert the accidental push --force"` in a good sample) | (1) `caught` (fired = [deny-rule]); (2) `gap` (a conditional does not count as a catch); (3) `caught` (good allowed, `fired` empty); (4) `gap` (retired rules never fire); (5) **`false_positive`** (good denied — `fired` = [deny-rule], `expected: allow`) — ALL FOUR verdict cases of `evaluate_sample` (bad caught, bad gap, good caught, good false_positive) each hit at least once; `warn` never appears in `fired`; `summary` = {5, 2, 2, 1} | engine | ⏳ #395 |
| S22 | seven-type slices + cross-type eligibility | S21's db + samples tagged across all 7 types incl. an empty type | `--type <t>` for each of the 7 | each slice's `total` = that type's sample count (0 for the empty slice → `summary` all zeros, `results: []`); a rule of type A fires on a sample of type B (the `--type` filter slices SAMPLES, never rules); `per_type` (crew) reconciles to `summary` | engine + route | ⏳ #395 |
| S23 | phase inclusion/exclusion | rules with `applies_to: [build]`, `excludes: [recon]` | samples with `phase` build / recon / absent (→ `DEFAULT_EVAL_PHASE`) | selected only in build; never in recon; the default phase is the documented one | engine | ⏳ #395 |
| S24 | import semantics | `evalsSupported=true` real seam, temp knowledge db | import `evals:x` twice with different sample sets; import with duplicate `id`s; run with `corpus: evals:missing` | the second import REPLACES the scope (run reports the second set only — `import_corpus` purges the scope's prior chunks before writing); duplicate ids are **REJECTED**, never de-duplicated: the engine's `validate_corpus` fails the whole import with `eval corpus has a duplicate sample id "<id>"` (evals.rs) and nothing of the batch lands; crew's `ImportEvalCorpusSchema` does not pre-check uniqueness, so `POST /testing/corpora/import` surfaces the adapter error as **500** carrying that message (a 400-by-name zod refinement is the follow-up; the derivation script already refuses duplicate ids on its side); unknown corpus → 500 with a message naming the scope, never an empty 200 | engine | ⏳ engine build in CI (the duplicate-id decision is pinned from source) |
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
`rule_snapshot_hash` (the §3 definition — over the FULL canonical rule set at run time),
`engine_build` (`wicked-core-ts` version + addon hash). With those, an S17 diff is keyed by the
full identity tuple and two rows with equal tuples must have equal `results` — a property test
worth adding once the fields exist (`compareEvalRuns` then gains `identity.samples_hash` /
`identity.rule_snapshot` / `identity.engine_build` pairs and `comparable` requires them equal).
Until then, `rule_store` (a path) and `degraded` are the only persisted run-level provenance, and a
comparison must record the other two by hand in the run notes; `compareEvalRuns` derives
`comparable` from content for exactly that reason — same corpus name, same ids, same kinds AND,
per row, an equal `sample.payload_hash` (the canonical hash of the full sample payload; a side
whose rows carry none is reported `unverified: no sample identity`, never comparable). The daemon's
own runs carry no `payload_hash` today (the engine echoes no signals), so two daemon-recorded runs
are unverified until the run route stamps it — that stamping (from the imported corpus) is the
crew follow-up. The script's `run` already writes complete provenance for its own reports:
`report.meta.json` beside `report.json` carries `pin_hash`, `samples_hash`, `corpus_name`, the
samples' `generation`, `engine { version, build { path, sha256 } }`, `rules_identity { method,
sha256, rule_count }`, `rules_seed`, the shared `generation` and `report_sha256` — and every result
row carries its `payload_hash`. The import receipt should likewise gain `payload_hash` so a
`POST /testing/corpora/import` of `samples.json` is checkable against `samples.meta.json`.

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
  `rules_eval_cmd`); the plan's `run` stages a corpus directory accordingly — and because
  `load_corpus` reads EVERY `*.json` in that directory, the staged dir is fresh, private and
  holds only the verified samples (codex review of #475, finding 3).
- S20 is deterministic; S16 is the only governed scenario, with the qualified oracle above.
- The first real derivation (2026-09-09, `samples_hash sha256:e827341b…`) ran under git's
  IMPLICIT default `diff.renames=true`: seven samples listed only a rename's new path, and any
  operator with `diff.renames=false` (or a different `diff.orderFile`, `core.quotePath`,
  `i18n.logOutputEncoding`, `log.showSignature`) would have derived different bytes from the same
  pin. The derivation now pins its complete git configuration (§2); the documented hash is
  `sha256:6e70752f7734ddfb…` and S15d proves the independence.
- S21 originally claimed all four `evaluate_sample` cases with a `caught/gap/caught/gap` fixture
  that never produced `false_positive`; a fifth sample (a good commit matching the deny trigger)
  now does. S24 originally left duplicate-id behavior undecided; the engine's `validate_corpus`
  rejects them, and the row says so.
- Codex round 3 on #475 (three findings, all fixed in the script and proven over the fixture):
  `run` checked that every result row named a staged sample but never that every staged sample had
  exactly one row, nor that the summary was the rows' tally — an empty report over six staged
  samples was published as a clean run (S14b's own fixture expected that); `verifyEngineReport`
  now refuses incomplete, duplicated, extra, verdict-less, `fired`-less and mis-summed reports by
  name (S14h). A shallow checkout resolved both pinned tags and derived 240 samples instead of 293
  under the unchanged pin identity; `check` now refuses incomplete history by name and `samples`
  checks each window's derived counts against the pin's `commits` (S14i, S15l). `pin_hash`
  semantics are UNCHANGED: `commits` was already recorded per repo by `pin` and stays outside the
  hash by design (it is derived and git is the authority — a hand-edited count is a refusal, not a
  new identity), so the committed pin's derived fields and its hash `sha256:aaf2dd56…` did not
  move. `materialize` deleted the previous tree before extracting; it now stages + verifies beside
  the destination under `.materialize.lock` and swaps only after every repo verified (S15m, S15n).
- Codex round 4 on #475 (three findings, all fixed in the script and proven over the fixture):
  git replacement refs bypassed every pin check — a window commit `git replace`d by one with the
  same parents but another message and tree leaves both tag shas and `rev-list --count` exactly the
  pin's while every derived action changes; every git the script runs is now replacement-blind
  (`--no-replace-objects` + `GIT_NO_REPLACE_OBJECTS=1`) and `check` / `pin` refuse a checkout that
  carries `refs/replace/*` by name (S14j). `materialize` removed each `.prev` backup before the
  next swap and had no rollback — a fault at the second staging rename left one destination
  missing, one backup gone and the old success receipt intact; it now keeps every backup until the
  receipt is published, rolls a failed swap or receipt write back (destinations restored byte-
  identical, previous receipt intact) and, if the rollback itself fails, removes the receipt and
  names both faults (S15o, via a vitest-only fault hook). `verifyEngineReport` accepted impossible
  judgments (a good sample with `expected: deny`, empty `fired`, verdict `gap` — S14h's own
  "valid all-gap" fixture) and malformed wire fields (`expected` / `degraded` missing,
  `rule_coverage: null`, which then crashed the summary print after publication); it now checks
  every row against its sample's kind and the report's `degraded` / `rule_coverage` shape (S14k),
  and the valid all-gap fixture is built from BAD samples.
- Codex round 5 on #475 (three findings, all fixed in the script and proven over the fixture):
  the engine provenance could name a different executable from the one evaluated — `resolveExecutable`
  skipped EMPTY `PATH` entries while exec reads them as the cwd, and `run` kept spawning by bare
  name; it now resolves once with exec's own semantics (empty entry = cwd, `PATHEXT`, an
  executable regular file) and spawns that absolute path for every call, hashing it before and
  after the run (S14l). A process killed between a swap's two renames left a missing destination
  beside the OLD success receipt — the exception rollback never ran; `materialize` now invalidates
  the receipt BEFORE the first tree moves (marker published, previous receipt moved aside), every
  start inspects the root and repairs a torn swap, a reader refuses a damaged root by name, proven
  by a deterministic SIGKILL between the renames (S15p). `verifyEngineReport` validated
  `rule_coverage`'s shape but not its numbers — `fired: [R]` beside `exercised: 0` and R
  unexercised verified, and S14k's own fixture blessed exactly that; coverage is now reconciled
  with the rows per the engine's definition (S14m) and the fixture corrected.
- Codex round 6 on #475 (1 HIGH / 2 MEDIUM, all fixed and proven; plus one Copilot thread):
  `compareEvalRuns` reconstructed each run's rule inventory as `unexercised ∪ fired` and diffed it —
  unsound, because `rule_coverage.exercised` counts every rule ANY claim fired (warn included;
  evals.rs `rule_coverage` over `run_evals`' `triggered`) while `results[].fired` is deny-only
  (`evaluate_sample`), so a rule that went from unexercised to exercised-by-warn vanished from the
  reconstruction and was reported as `removed_rules` with `reconciles: false` over two valid records.
  The delta now asserts only what the records enumerate: `gained`/`lost` from listed ids on both
  ends; `added_rules`/`removed_rules` only when the silent side's inventory is complete
  (`exercised === |fired|`), else `inventory: 'partial'` + `transitions_withheld` by name (that
  completeness inference was itself deleted in round 8, below — no rule-set transition is asserted
  at all now); the exercised check is `≥ |fired|` (a count above is warn-only exercise, not a
  defect); the WARN-1 reproduction is a test (both directions). `readMaterializeReceipt` accepted any `repos[].path`
  that `existsSync` liked and a receipt without identity; it now takes the selected pin and refuses
  by name a wrong / missing `pin_hash` or `generation`, an extra / missing / duplicated / moved
  repo, and any path that is not the real directory `<root>/<repo>@<tag>` (foreign directory,
  symlink, plain file — S15q). `resolveExecutable` swallowed every `stat` / `access` error as "not
  installed"; only ENOENT / ENOTDIR are absence now, `access` EACCES on a regular file stays
  `blocked`, and any other lookup error is `{ path: null, error }` → `run` exits 1 naming syscall,
  errno and candidate (a real EACCES on an unsearchable PATH dir ahead of a working engine, injected
  EIO on stat / access — S14n). Copilot: a `tar` failure inside `materialize` is a `ToolError`
  (exit 1), not a plain Error (exit 2) — a non-zero exit and a spawn ENOENT both tested.
- Codex round 7 on #475 (1 HIGH / 2 MEDIUM, all fixed and proven; plus two Copilot docstring
  threads): `compareEvalRuns` treated every blocking-fired id as part of the coverage denominator —
  but the engine's `--type` slices the SAMPLES and the DENOMINATOR (evals.rs `run_evals`,
  `decide_lane_rules`), not the gate (`evaluate_sample` runs `select_any` over every active rule),
  so a development-filtered run with `fired: ['SECURITY-DENY']` and `exercised: 0` is valid and
  failed against ITSELF. Reconciliation is now scope-aware (`coverage_reconciliation` per side:
  `rows` unfiltered / `per_type` against the engine's own `per_type[<filter>]` / `n/a` when a
  filtered record has none), differing filters are `differing-type-filter` (not comparable, no
  delta), and under the same filter a fired id is typed into the slice only by the other side's
  unexercised row. api-types `GovernanceEvalRuleCoverage` lacked `recall_only` and `per_type` while
  the engine serializes both — completed (0.27.0, optional on the contract), and the wire test pins
  the engine's complete report (evals.rs's own pinned-serialization fixture) key-exactly in both
  directions. `run` read `.trim()` off a spawn that never produced a process (`spawnSync` `.error`
  with undefined output — an engine removed or chmod'd after the probe) and died with a TypeError,
  exit 2; `.error` is inspected first and the failure names step, errno and executable (exit 1) —
  EACCES on `rules ingest` and ENOENT on `rules eval` are tests, each a fake engine sabotaging
  itself between two spawns.
- Codex round 8 on #475 (1 HIGH / 1 MEDIUM, both fixed and proven — the closing round): the
  comparison STOPS inferring what the wire does not state. Round 6's completeness inference
  (`exercised === |fired|` ⇒ every exercised rule is named ⇒ an id the silent side does not
  enumerate is a rule-set change) was unsound: under a type filter a fired id was typed into the
  slice through the OTHER run's `unexercised` row, and a rule's type in run A does not establish
  its type in run B — A lists R and Q unexercised under `development`; B moves R to `security`,
  fires R blocking for a development sample and exercises Q by `warn`; the cross-run intersection
  named R, declared B complete and reported Q — present and exercised — as `removed_rules` with
  `reconciles: true`. Unfiltered it over-claimed too: the wire's partition is over the ELIGIBLE
  rules (active, effect-bearing — evals.rs `decide_lane_rules`), so "not enumerated" never meant
  "not in the store" (a recall-only or retired rule is counted outside the partition). Now
  `added_rules`/`removed_rules` require an explicit rule inventory on BOTH records — no field of
  `GovernanceEvalRuleCoverage` carries one — so every comparison of daemon-recorded runs is
  `inventory: 'partial'` with both lists empty and each one-sided id in `transitions_withheld`
  with what it may be instead; `unidentified` is per record (unfiltered `exercised − |fired|`,
  filtered the whole `exercised`), never reduced by a cross-run intersection; `gained`/`lost`
  stay certain (both ends listed). `verifyEngineReport` accepted any `per_type` (`null` passed
  the publication gate, then crashed `compareEvalRuns` with `Cannot convert undefined or null to
  object`; `development: { exercised: 999 }` beside `exercised: 0` published): a present
  `per_type` must be a plain object keyed by steering type with `{ exercised, unexercised }`
  rows of non-negative integers, the rows' `exercised` summing to the total and each type's
  `unexercised` equal to the listed rows of that type (`run` never passes `--type`, so the report
  is unfiltered and the rows partition the whole eligible set); `compareEvalRuns` shape-checks a
  persisted `rule_coverage` before reading it and marks a malformed side `coverage_reconciliation:
  'unverified (malformed rule_coverage)'` with a reconciliation error, no delta, no throw.
  **Known limitations — reviewer heuristics that remain, by design:** (1) `gained`/`lost` under a
  type filter are statements about the RULE (it fired, so it is exercised; it is listed unexercised,
  so it is not), typed into the slice by the other run's row alone — not a claim about the slice's
  denominator, which is why the filtered `unidentified` does not subtract them; (2) the unfiltered
  `unidentified` rests on the engine's own definition `fired ⊆ exercised` (a violation is a
  reconciliation error, not silently floored); (3) `comparable` still lacks the §5 rule-snapshot
  and engine-build identities, so two comparable runs may have been judged by different rule sets
  — the coverage delta reports transitions, never their cause; (4) the daemon persists
  `rule_coverage` verbatim (no route-side validation): the shape gate is the script's
  `verifyEngineReport` for its own reports and the comparison's `unverified` marking for
  everything else; (5) a `per_type` missing a type whose counts are all zero is accepted (the
  engine pins all seven keys; the sums still reconcile).
