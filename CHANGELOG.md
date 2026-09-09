# Changelog

All notable changes to **wicked-crew** (the daemon package, npm `wicked-crew`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before this file
existed (everything ≤ 0.7.0) are backfilled from git history and release tags; the sibling
workspace packages `wicked-crew-api-types` and `agent-acp-bridges` version independently and are
mentioned only where a daemon release depends on them.

## [Unreleased]

### Fixed
- **Interactive docs are no longer shared across projects (#472).** `/projects/:projectId/interactive/*`
  honored `:projectId` only to look up a per-project root setting no project ever had, so every
  project fell through to the one shared default root — one bridge, one registry, the same docs
  under every project's URL. A project without an explicit `interactiveRoot` now resolves to its
  own partition, `~/wicked-interactive/docs/projects/<projectId>` (created on first use by the
  bridge pool); the synthesized `default` project keeps the legacy shared root, so every existing
  document stays visible under Unfiled with no migration. Explicit per-project roots and
  `WICKED_INTERACTIVE_ROOT` are honored exactly as before.
- **The per-project partition is checked on REAL paths before anything is served from it (#474).**
  `projects/<projectId>` was resolved lexically only, so a symbolic link already sitting there —
  at another project's partition, or anywhere else — would have been followed by the bridge into
  that directory. The partition is now `lstat`-walked and `realpath`-contained under `projects/`
  and created without following links; a link, a file, or an escape answers 500 naming the
  offending path (fail closed — never a fallback to another root). The interactive event seams
  (edit / demo / chat) resolve a project's docs root through the SAME containment walk — a
  symlinked partition is refused into the seam handler's `onError` and the event goes unanswered
  instead of being followed into another project's docs; the seams only read under a root the
  routes materialized, so nothing is created on that path (Copilot on #474). The attributed docs list also
  answers 502 for a malformed list (`[null]`, non-object rows) or a non-JSON body from the
  bridge, and treats a connection lost mid-body as the transport failure it is (invalidate →
  retry once → diagnostic 502) instead of a malformed body. The endpoint manifest declares the
  list's wire shape as the array it is, `InteractiveDocSummary[]`.
- **Skills keystone — codex round-5 hardening; the skills root is not a setting** (PR #480). Six
  fixes to the crew-owned skills root: (1) the `skills_root` setting and the `WICKED_CREW_SKILLS_ROOT`
  env override are RETIRED (coordinator decision) — a configurable root accepting any absolute path
  let `PUT /settings {skills_root: "~/.codex/skills"}` aim the seed at the user's codex skills before
  the runtime reported the location as incompatible (design v3.1 §1: one storage root; v3.2 §1:
  never a user CLI directory). The root is `<state home>/skills`, full stop: a `skills_root` a client
  sends is dropped and named in the audit entry's `ignored`, a hand-edited settings.json value is
  dropped on read, `GET /settings` never shows it, `PUT /settings` no longer re-applies the skills
  seam, and the daemon REFUSES TO START (`SkillsRootUnfencedError`, `src/skills/root-fence.ts`)
  when the root's canonical path leaves the state home, lands inside a known user CLI directory
  (`~/.codex`, `~/.pi`, `~/.copilot`, `~/.config/opencode`, `~/.claude`, `CLAUDE_CONFIG_DIR`), or
  the root entry is a symlink; the store has no `reroot` any more (a new root is a new store), and
  the test harness arms the daemon STATE HOME (`setCrewStateHome`) instead of a skills-root env;
  (2) catalog recomputation is CONTAINED: every internal read (`recomputeDerived` — kind,
  portability, the core closure's SKILL.md texts — and the catalog rebuild's name derivation) walks
  every component from the skills root with lstat, so `effective/skills/gamma -> /outside` is
  skipped and reported (a blocking `path-invalid` at publish/analyze, a warning on a mutation of
  another skill), never read through — a leaf-only check used to derive metadata from the outside
  bytes; (3) incompatible file-map paths are refused BEFORE mutation — a key that is a directory
  prefix of another (`x` + `x/y`), a key naming an existing directory the swap cannot clear, a key
  whose parent is an existing non-own file — and `replace`/`add` are STAGED: the replacement is
  written in full under the root, the skill's own files are parked by rename, the staged files are
  renamed into place, and any failure rolls back byte-for-byte (mode bits included) with the
  revision unchanged — the old remove-then-write order destroyed the notes it could not replace and
  left a partial replacement behind a 500; (4) snapshot verification SEES symlinks: the walk
  enumerates link entries (`walkTree`), the content hash covers them (path + link text,
  `hashTree`), and `current` refuses any link but the root-level `.venv`, which must be present iff
  `snapshot.json` records the env as `synced`, carry exactly the link text publish wrote, and resolve
  to this root's `baseline/<recorded baseline>/.venv` — an injected outside-pointing link used to
  leave the verified hash unchanged; (5) route paths are decoded EXACTLY ONCE, by Fastify — the
  store's second `decodeURIComponent` is gone, so `100%25.txt` is the filename `100%.txt` and the
  literal `a%252Fb.txt` stays `a%2Fb.txt` instead of becoming the path `a/b.txt`; (6) portability
  classification models interpreter options that take a SEPARATE value (`python -W x` / `-X x` /
  `-m x` / `-c x`, `node --require x` / `-r x` / `--loader x` / `--import x` / `-e x`, `uv run
  --python x` / `--with x` …), so the cwd-relative script after them is still non-portable
  (`python3 -W ignore scripts/foo.py`, `node --require foo scripts/x.js` used to read as portable).
  Plus two Copilot nits: `compareVersions` is a TOTAL order (a prerelease suffix sorts below its
  release, prereleases compare the semver way, distinct strings never compare 0 — the live-plugin
  pick no longer depends on `readdir` order), and refs.ts documents that glob metacharacters (`*`,
  `?`) terminate a path token.
- **Skills keystone — codex round-4 hardening** (PR #480). Six fixes to the crew-owned skills root:
  (1) persisted skill KEYS are validated at manifest parse — a safe single segment in the skill-name
  charset that IS the path-derived name of its `dir` (the copilot view lays a skill out under its
  key) — and `copyFiles` preflights EVERY destination's shape (`..`, absolute, separator, NUL) and
  symlink walk before the first byte moves, so a refused record writes nothing; (2) the skills root
  ITSELF is checked before every read and mutation (`manifest`, every contained path, the manifest
  commit, `current`, seed, provisioning, publish, reaping): a real directory, never a symlink, whose
  canonical path is the one bound at boot — a root replaced by a link to a copied store (or an
  ancestor swapped under the daemon) refuses every operation with a loud 503
  (`SkillsRootInvalidError`), never redirects one; (3) provisioning validates `baseline/<hash>`
  (content-hash charset, reached without crossing a link, a real directory), the `.venv` and marker
  paths and the daemon's `.uv-cache` BEFORE `ensureVenv` removes, syncs, writes a marker or chmods
  anything — a symlinked hash dir refuses the publish before uv runs; (4) refresh-baseline is ATOMIC
  against refusal: the three-way merge is decided in memory, every destination (takes and removals)
  is preflighted, then the baseline is captured, the takes are staged under the root and swapped —
  a refused destination answers the normal 2xx `blocked` `path-invalid` envelope with nothing
  changed (no file copied or removed, no baseline captured, revision unchanged) instead of a 500
  after the files ahead of it had landed; (5) the core closure consumes DECLARED mandates from the
  parsed YAML `mandates:` list (escaped scalars count, the Claude colon form is normalized, entries
  must be non-empty strings, each positioned by its node's line) and scans prose over the BODY only —
  the frontmatter block is never regex-scanned (verified over the live 12.32.0 catalog: the closure is
  unchanged, 8 skills, 0 absent); (6) launch pins never expire by publish count: every launch the
  daemon hands the engine (`CoreAdapter.onLaunch` — launchRun, resumeRun, confirmGate,
  launchCampaign, resumeCampaign; a campaign's engine-launched node runs under the campaign's
  umbrella pin) opens a pin at the exported generation BEFORE the engine call, accumulates every later
  publish, and is released only by the engine's `skillsSnapshotHanded` report for that session, the
  run's / campaign's terminal frame, or the engine rejecting the launch; reaping skips any generation
  with an unreleased launch pin. Plus, from core#399's round 4: the atomic `current` relink creates
  its transient link INSIDE `snapshots/` (`.tmp-current-<hex>`, a `snapshots/.tmp-*` entry core's
  launch-time fence classifies) and renames it over `skills/current`, so no unclassified child ever
  appears under `skills/` during a publish (the former `skills/current.tmp-<hex>` would have refused a
  launch listing `skills/` in that window); `tests/fixtures/state-home-subtrees.json` mirrors core's
  copy byte-for-byte (the v3.3 §1 sibling-generation fence and its residuals in the `$comment`).
- **Skills keystone — codex round-3 hardening** (PR #480, on top of design v3.2). Nine fixes to the
  crew-owned skills root: (1) every PERSISTED manifest path is validated at parse — a skill `dir`, a
  baseline identifier or a file-record key carrying `..`/an absolute piece/a separator is a corrupt
  manifest refused loudly, and `containedPath` re-checks the FINAL joined path lexically so a trusted
  `dir` cannot escape the root either; (2) the structural storage dirs (root + `effective/`,
  `baseline/`, `snapshots/`) are refused if a symlink stands in for one — before publish, baseline
  capture, provisioning, reaping and `current` verification (which now judges containment against the
  lstat-clean `snapshots/` path, not the realpath of a redirected one); (3) live-generation reaping
  pins the EXACT generation the engine reports it handed each session (`skillsSnapshotHanded`), never
  "current at event time", with a bounded launch pin bridging the spawn→event gap; (4) parent reset
  excludes every path a nested `SKILL.md` owns in the EFFECTIVE tree (not only the baseline), so a
  child added directly under a parent keeps its files; (5) reset preflights every destination and
  STAGES the restore before removing anything, so a blocked reset (a symlinked child dir) mutates
  nothing and answers the 2xx `blocked` envelope; (6) a baseline env whose read-only lock FAILS
  leaves no ready marker (the partial env is removed) and a retry re-provisions and re-locks —
  readiness is trusted only when the marker AND the read-only bits verify; (7) frontmatter is parsed
  by a real YAML grammar (`yaml`) and anything it rejects blocks, with the strict subset
  (single-document mapping, scalar `name`, list `mandates`) kept on top; (8) 409 is reserved for a
  stale `expectedRevision` alone — a publish-in-flight or a root-changed refusal wrote nothing and
  answers a 2xx `blocked` findings envelope (`publish-in-flight` / `root-changed`, new finding kinds
  in api-types 0.27.0); (9) the route concurrency test is deterministic (provisioner-entered gates,
  released in `finally`, no wall-clock deadlines). New dependency: `yaml` (the standard TS YAML
  library).

### Added
- **`GET /projects/:projectId/interactive/api/docs` stamps `projectId` on every row** (#472) — the
  bridge's list relayed field-for-field plus the mount's project, so clients can attribute docs
  across projects. One static segment more specific than the proxy wildcard; `POST /api/docs` and
  everything else still stream through the pure-transport proxy. api-types **0.26.0** carries
  `InteractiveDocSummary`.
- **`rule_coverage` + `effect: 'warn'` on the wire** (the core #394/#395 companion) — api-types
  **0.27.0**: `GovernanceEvalReport`, `EvalRunSummary` and `EvalRunDetail` carry an OPTIONAL
  `rule_coverage { exercised, unexercised: [{ rule_id, steering_type }] }` (the rules NO sample
  exercised — the blind spot a bare gap count hides; absent, never fabricated, on a report from a
  pre-#394 engine), and `ConformanceRule.effect` admits the operator-authorable `warn` band. The
  run route persists `rule_coverage` verbatim (like `degraded`) so `GET /testing/evals[/:id]`
  serves it untouched. `GovernanceEvalResult.sample` gains an OPTIONAL `payload_hash` — the
  sha256 of the sample's full payload (id, description, kind, steering_type, signals), stamped by
  a producer that held the samples (the engine echoes no signals); the offline comparison keys
  comparability on it.
  Codex round 7, in the same 0.27.0 (0.26.0 → 0.27.0 is this PR's one api-types bump — #474 landed
  0.26.0 first): `GovernanceEvalRuleCoverage` is completed with the
  engine's other two serialized fields — `recall_only` (the active rules of the slice carrying no
  effect, core #395) and `per_type` (the same partition per steering type: all seven keys, an
  `{ exercised, unexercised }` count pair each — evals.rs `RuleCoverage` / `TypeCoverage`) — both
  optional on the contract only because the daemon persists a run's coverage verbatim and validates
  none of it (a consumer reads an absent `per_type` as "no per-type coverage", never as zeros). The
  wire-contract test pins the engine's COMPLETE report shape — the fixture is evals.rs's own
  pinned-serialization test — with key-exact pins in both directions, beside the pre-#394 report
  (no coverage) and a two-field record, which still validate.
  Copilot on the rebased #475: a persisted RESULT ROW that is not the wire shape (`GovernanceEvalResult`
  — no `sample`, `fired` not an array, a verdict outside its union, a row that is no object; the store
  validates `results` only as an array) is likewise one reconciliation error naming the run, the index
  and the defect, EXCLUDED from the comparison — which stays over the well-formed rows, is not
  comparable, and withholds that side's summary-vs-results check rather than misattribute the
  shortfall — and never thrown over.
- **The INTERNAL evals corpus** — `e2e/corpus/wicked-internal-corpus.json` pins five wicked
  repos (estate v0.16.6 · garden v12.31.0 · crew v0.7.24 · studio v0.5.0 · interactive v0.8.1) to
  the commit each tag resolved to plus an ACTION window of ≥ 50 real commits behind it (walk
  release tags back, capped at 180 days; a shortfall is recorded, never widened); the pin is the
  constant and moving a tag is a deliberate PR. `scripts/evals-internal-corpus.mjs` (plain node;
  its one import beyond the builtins is crew's shared `src/api/eval-sample.js` — the ROUTE's own
  zod sample schema, so the script can never accept a sample `POST /testing/corpora/import`
  rejects) `pin`s / `check`s it (fail closed on a re-cut tag or a hand-edited pin), `materialize`s
  each tag by `git archive`, derives `samples` (one `EvalSample` per window commit — path-table
  steering type, unsure ⇒ development; `good` unless `known-bad.json` says otherwise), and `run`s
  them through `wicked-core rules eval` when the engine is on PATH. Our doctrine rules apply to
  these repos; the 15-repo wicked-e2e OSS set stays the E2E functional corpus and is NOT an eval
  corpus. Fail-closed throughout (the two codex rounds on #475): a pinned `repo` must be one safe
  path segment; `materialize` is contained to the realpath of its root, refuses symlinked
  destinations, pins the operator's git attributes away for the archive and verifies the extracted
  tree entry-for-entry against `git ls-tree` (an un-overridable `export-ignore` is a named
  refusal; the receipt carries each `tree_sha`); the derivation pins its complete git
  configuration and reads paths NUL-delimited, never trimmed (byte-identical samples under any
  operator config, exact filenames — `samples_hash` is `sha256:6e70752f…`); a missing/malformed
  `known-bad` file is an error, never an empty allowlist; every artifact publishes tmp+rename
  (samples under a lock with one `generation` stamp); `run` verifies `samples.meta.json` against
  `samples.json` and the selected pin before probing the engine (ENOENT is SKIP; any other probe
  error, a non-zero `--version` or an empty answer is a tool failure), stages exactly those
  samples in a fresh private dir, checks every result row against its staged sample and stamps it
  with the sample's `payload_hash`, and publishes `report.json` + `report.meta.json` as ONE
  verifiable generation (`.report.lock`; `generation` in both, `report_sha256` in the meta;
  `readPublishedReport()` refuses a torn pair) carrying complete provenance — engine version +
  build identity (realpath + sha256 of the binary), the rule-snapshot identity with its method
  (`engine-list` from `rules list --include-retired --json` read back before the temp store is
  deleted; `seed-dir` when the engine lacks the command — said so), `pin_hash`, `samples_hash`.
  Codex round 3: `check` refuses a SHALLOW checkout by name (a depth-1 clone plus a depth-1 fetch
  of the from-tag resolves BOTH pinned tags while the window between them is missing — fewer
  samples under the unchanged pin identity) and `samples` checks each window's derived commit and
  sample counts against the pin's `commits` (outside `pin_hash` by design; a mismatch is a
  refusal); `materialize` holds `.materialize.lock`, extracts + verifies every tree into a staging
  dir beside its destination and swaps only after ALL verified — a failed repeat leaves the
  previous trees and receipt byte-intact, a failed first run leaves no receipt, concurrent
  materializations never interleave; `run` verifies the engine's report before publication —
  exactly one row per staged sample, engine verdicts, `fired` arrays, a summary that is the rows'
  tally — so an empty or partial report is a named tool failure, never a recorded evaluation
  (a valid all-gap report still passes).
  Codex round 4: every git the script runs is replacement-blind (`--no-replace-objects` +
  `GIT_NO_REPLACE_OBJECTS=1`) and `check` / `pin` refuse a checkout carrying `refs/replace/*` by
  name (`replace-refs-present` — a replacement rewrites a window commit's message and tree while
  both tag shas and `rev-list --count` stay the pin's); `materialize` keeps every `.prev` backup
  until the receipt is published and rolls a failed swap or receipt write back (destinations
  restored byte-identical, the previous receipt intact; a failed rollback removes the receipt and
  names both faults — proven by test-only fault injection at the second swap, the receipt write
  and the rollback itself); `verifyEngineReport` also refuses rows inconsistent with their sample's
  kind (a good sample judged `gap`, a bad one `false_positive`, `expected` missing or off its kind,
  `fired` disagreeing with the verdict) and malformed report fields (`degraded` absent or not
  null / `facet-only`, `rule_coverage: null` — what crashed the summary print after publication);
  the valid all-gap fixture is now built from BAD samples.
  Codex round 5: `run` resolves the engine ONCE with exec's own search semantics (every `PATH`
  entry in order, an EMPTY entry being the cwd — the old resolver skipped it and could hash
  another build than the one the spawn ran — `PATHEXT` on Windows, an executable regular file
  required) and spawns THAT absolute path for `--version` / `rules ingest` / `rules list` /
  `rules eval`, never the bare name: the file hashed into the provenance is the file that ran
  (hashed again after the run; a binary replaced underneath is a tool failure). `materialize`
  invalidates the receipt BEFORE the first tree moves — an in-progress marker is published and the
  previous `materialized.json` moved aside — so a process killed between two renames leaves
  incomplete trees beside NO receipt; every start inspects the root (`inspectMaterializeRoot`) and
  repairs a torn swap (`.prev` trees rolled back, staging / marker / previous receipt removed,
  nothing trusted until the run publishes), finishes a torn cleanup, sweeps stale staging;
  `readMaterializeReceipt()` refuses a damaged root by name with that repair as the hint (proven by
  a deterministic SIGKILL between the two renames and after the receipt write). `verifyEngineReport`
  reconciles `rule_coverage` with the rows per the engine's definition (a rule is exercised when
  ANY claim fired it, blocking or not; a row's `fired` is the blocking subset): no id both fired and
  unexercised, `exercised` ≥ the distinct blocking-fired ids, no duplicate unexercised id,
  `recall_only` a non-negative integer when present — the round-4 fixture that blessed a fired rule
  as unexercised is corrected; the summary line prints the blocking-fired count beside `exercised`.
  Codex round 6 (+ one Copilot thread): `readMaterializeReceipt(dir, pin)` trusts a receipt only as
  the materialization OF the selected pin — `pin_hash` and a well-formed `generation` present and
  the pin's, `repos[]` exactly the pinned repos at their tag + sha, and every `path` the real
  directory `<root>/<repo>@<tag>` (present, not a symlink, a directory, realpath-equal) — a
  foreign path, a link, a plain file, a missing identity or an extra / missing / duplicated repo is
  a named refusal, never "clean" (the reader used to accept any `existsSync` path and an
  identity-less receipt). `resolveExecutable` reserves the exit-zero SKIP for true absence
  (ENOENT / ENOTDIR): any other lookup error — `stat` EACCES on a PATH directory, EIO, a failing
  realpath — is `{ path: null, error }` and `run` reports a TOOL FAILURE naming syscall, errno and
  candidate (every lookup error used to be swallowed as "not installed"); a regular file without
  execute permission stays `blocked`. A `tar` that fails or cannot be spawned inside `materialize`
  is a `ToolError` (exit 1), not a plain Error (exit 2) — Copilot.
  Codex round 7: `run` inspects `.error` on the `rules ingest` and `rules eval` spawns BEFORE
  reading their exit status or output — an engine removed (ENOENT) or made non-executable (EACCES)
  after the `--version` probe answered is a TOOL FAILURE (exit 1) naming the step, the errno and the
  executable, where it used to throw a TypeError on the undefined output (exit 2, the errno lost); a
  step killed by a signal reports `signal SIG…` instead of `exit null`.
  Codex round 8: `verifyEngineReport` validates a present `rule_coverage.per_type` — a plain object
  keyed by steering type, each row `{ exercised, unexercised }` of non-negative integers, the rows'
  `exercised` summing to the total and each type's `unexercised` equal to the listed rows of that
  type (`run` never passes `--type`, so the report is unfiltered and the rows partition the whole
  eligible set) — so `per_type: null` (which passed the gate and then crashed the offline
  comparison) or `development: { exercised: 999 }` beside `exercised: 0` is a named refusal before
  publication.
- **`compareEvalRuns`** (`src/api/eval-compare.ts`) — the offline S17 comparison of two recorded
  eval runs: per-sample verdict flips classified permitted/flagged, one-sided ids, kind AND
  payload-identity changes (`comparable` requires an equal `sample.payload_hash` per shared id; a
  side without WELL-FORMED hashes — `sha256:` + 64 lowercase hex, `PAYLOAD_HASH_RE`; a malformed
  persisted value is no identity, never "changed" — is `unverified: no sample identity`, never
  comparable — `comparable_reason` says why), summary reconciliation, and a `rule_coverage` delta
  over what the records ENUMERATE (codex round 6): the wire's `exercised` is a COUNT of every rule
  any claim fired, blocking or not, while `results[].fired` is the blocking subset (evals.rs
  `rule_coverage` / `evaluate_sample`), so a record names only `unexercised ∪ fired` and its rule
  set is fully identified only when `exercised === |fired|`. `gained`/`lost` are asserted from
  listed ids on both ends; `added_rules`/`removed_rules` only when the silent side's inventory is
  complete, else withheld by name (`inventory: 'partial'`, `unidentified`, `transitions_withheld`)
  — a rule that leaves `unexercised` for a warn-only firing is no longer misreported as removed.
  An `exercised` count above the fired ids is valid warn-only exercise; a count BELOW, an id both
  fired and unexercised, or a duplicate unexercised id is the record contradicting itself — a
  reconciliation error. Two valid records always reconcile.
  Codex round 7 — type filters: the engine's `--type` slices the samples and the coverage
  DENOMINATOR but not the gate (evals.rs `run_evals` / `decide_lane_rules` vs `evaluate_sample`), so
  a filtered run's rows may fire rules OUTSIDE the denominator — `fired: ['SECURITY-DENY']` beside
  `exercised: 0` is a valid development-filtered record, which used to fail against itself. Each
  record's coverage is now reconciled against the denominator it was produced under, reported per
  side in `coverage_reconciliation`: unfiltered against the rows' blocking-fired ids (`'rows'`);
  filtered against the engine's own `per_type[<filter>]` row (`'per_type'`), or not at all when the
  record has none (`'n/a (engine reports no per-type coverage)'`). `per_type`, when present, must
  sum to `exercised` and agree per type with the listed rows; a listed-unexercised id that fired is
  a contradiction under any filter (the row types the rule into the slice). Two runs under
  different filters are not comparable (`differing-type-filter`) and get no coverage delta; under
  the same filter a fired id is typed into the slice only when the other side lists it unexercised
  — `gained`/`lost` stay certain, `unidentified` counts what the other side cannot type, listed
  candidates are asserted only when the silent side is complete, and a fired-only id is always
  withheld by name (it may be a rule of another type, outside the denominator).
  Codex round 8 — no inferred inventory: `added_rules`/`removed_rules` are asserted only from an
  explicit rule inventory on BOTH records, and no field of the wire carries one (`exercised` and
  `recall_only` are counts, `unexercised` names only the unexercised rules, a row's `fired` only the
  blocking firings), so every comparison of daemon-recorded runs is `inventory: 'partial'` with both
  lists empty and each one-sided id in `transitions_withheld` with what it may be instead (an unnamed
  warn-exercised rule, a recall-only or retired rule outside the eligible partition, under a filter a
  rule of another type, or a real store change). The round-6 `exercised === |fired|` ⇒ complete
  inference is deleted: under a filter it typed a fired id into the slice through the OTHER run's
  row and, after a rule moved type, reported a present, exercised rule as removed. `unidentified` is
  per record (unfiltered `exercised − |fired|`, filtered the whole `exercised`), never reduced by a
  cross-run intersection; `gained`/`lost` stay certain. A persisted `rule_coverage` that is not the
  wire shape (`per_type: null`, `null`, a non-array `unexercised`, a bad row or key) is
  `coverage_reconciliation: 'unverified (malformed rule_coverage)'` on that side with a
  reconciliation error naming the defect, no delta — and no throw (it used to crash on
  `Object.values(null)`).
- **The revised evals test plan** at `docs/testing/evals-test-plan.md`, plus the deterministic
  eval-store / route scenarios it names (traversal ids over HTTP, 50-way write serialization,
  fault-proven detail-before-index ordering and queue recovery, torn/malformed/missing rows,
  `facet-only` + `rule_coverage` passthrough, the parsed snake_case guard, 501 parity, and the
  internal-corpus pin / samples / materialize / run semantics over a git fixture).
- **Crew-owned skills root** (skills keystone, design v3; companion to wicked-core#396). The daemon
  seeds `<state home>/skills` from the LIVE installed wicked-garden plugin (the marketplace cache's
  highest version — never the hand-installed copy, never a repo checkout; `WICKED_CREW_SKILLS_SOURCE`
  is the one explicit override) into a content-hash `baseline/<hash>/`, keeps the operator-edited
  `effective/` root beside it, and PUBLISHES immutable `snapshots/<gen>/` (enabled skills only,
  dependency closure, `snapshot.json`) behind an atomically flipped `current` link — handing the
  engine `WICKED_SKILLS_SNAPSHOT=<resolved snapshot>` at every spawn. Publish is crash-safe and
  idempotent on retry: the generation is allocated from the filesystem (max existing + 1), staged
  under `.staging-*`, renamed — never over an existing generation — the manifest is committed
  BEFORE `current` flips (an interrupted flip is finished at the next boot), and torn staging is
  swept. The newest three generations are kept; older ones are reaped only once no live run pins
  them (pins fold from the CoreEvent stream); a baseline (and its shared `.venv`) lives while any
  generation on disk references it. `current` is never trusted: it is realpath-contained under
  `snapshots/`, its `snapshot.json` validated, and the tree re-hashed against `contentHash` before
  the path is exported (`SkillsCurrentInvalidError` otherwise). Publish validates the whole tree —
  every `${CLAUDE_PLUGIN_ROOT}/…` and `../…` reference of an enabled skill must resolve INSIDE the
  snapshot (`..` is an escape, `dir/` resolves; file:line on failure), the frontmatter `name` must
  equal the path-derived name, malformed frontmatter (unterminated flow sequences / quotes) blocks,
  `.claude-plugin/{plugin.json,archetypes.json,components.json}` are required
  (`missing-plugin-manifest`) and must have the shape their readers expect — `plugin.json` names the
  plugin, `archetypes.json` carries its `archetypes` collection (`catalog-invalid`) — a declared
  frontmatter name that is ANOTHER catalog skill's key blocks whether or not the declaring skill is
  enabled (`name-collision`), and the core-by-reference closure (every registered workflow
  `skill_ref` + transitive SKILL.md mandates) must be COMPLETE: a missing registered skill or an
  absent mandate is blocking, and disable recomputes membership from the live refs. Enable runs the
  same content + containment guards a write gets (a missing, malformed, renamed or symlinked skill is
  not enabled). The baseline's `.venv` is provisioned (`uv sync`, through the daemon's `execCapped`
  chokepoint, `UV_CACHE_DIR` under the root; ONE provisioning per baseline hash — concurrent callers
  await it) and AWAITED before a publish returns, marked complete on disk, locked read-only, and
  linked from a snapshot only once it exists. The env is REQUIRED, not best-effort: a bundle with a
  `pyproject.toml` whose env cannot be built (uv missing, sync error, lock failure) BLOCKS the
  publish (`venv-failed`). Publish is SERIALIZED (one at a time; a concurrent one wrote nothing and
  answers a 2xx `blocked` `publish-in-flight` envelope) and root-bound (a root whose canonical path
  moves or vanishes under a running publish aborts it — a 2xx `blocked` `root-changed` envelope —
  with nothing written); 409 is reserved for a stale `expectedRevision` alone. A published generation is
  locked read-only, and `current` is re-verified
  (`snapshot.json` shape — its rows may only name safe `skills/…` dirs deriving their own names —
  and content hash) on EVERY read, so a snapshot modified under a running daemon is refused by that
  daemon, not only after a restart. Ownership of a path follows the deepest `SKILL.md` ON DISK, so a
  nested skill created by a direct edit is never reached through its parent's edit/reset/replace.
- **`/api/v1/skills*` file manager** — `GET /skills`, `GET /skills/:name/files[/*path]`,
  `PUT /skills/:name/files/*path`, `GET|PUT /skills/support/*path`, `POST /skills`,
  `POST /skills/:name/{enable,disable,reset,replace}`, `POST /skills/{refresh-baseline,publish,analyze}`.
  Every mutation is CAS-guarded (`expectedRevision`; 409 only on a stale one) and answers 2xx
  `{verdict, findings[], revision}` — a `blocked` verdict is a normal response, and so is a
  containment refusal on a write (`path-invalid`). Containment is no-follow everywhere, walked FROM
  THE SKILLS ROOT: a skill directory replaced by a symlink, a symlinked CHILD directory inside it
  (every replace/add destination is walked before a byte moves), and a symlinked BASELINE ancestor
  (reset, `?side=baseline`, every baseline hash lookup) are refused, never followed; the names the
  store itself owns (`snapshot.json`, `manifest.json`, `current`, `views/`, `.venv`) are refused as
  support paths. Atomic writes open their temp file `O_EXCL` under an unpredictable name and
  preserve mode bits (executable support scripts survive edit/replace); typed capped reads
  (`content: null` on binary). `analyze` is a pure dry run (nothing persisted, revision unchanged);
  a blocked publish persists nothing — not the drift it observed, not the provisioning state. Reset
  restores content only, never enablement; refresh-baseline merges three-way per FILE — a user
  deletion is a modification (kept; `conflict` when upstream changed). Frontmatter is a STRICT
  subset: a plain scalar with `: ` (`description: hello: world`) or a flow collection continued on
  indented lines is checked, not folded. Portability treats ANY cwd-relative script invocation
  (`python3 -u scripts/x.py`, `./scripts/x`, `bash scripts/x`) as non-portable and never truncates
  a reference at a legal filename character. api-types **0.27.0** carries the `Skill*` contract,
  `missing-plugin-manifest` / `catalog-invalid` / `venv-failed`, and the `skills` block of
  `GET /diagnostics` — and NO skills setting (see the round-5 entry: the root is not configurable).
- **One storage root, an explicit worker fence** (design v3.1 §1/§2). The skills root stays
  `<state home>/skills` — the same storage root as every other crew store. The worker Read fence is
  core's explicit denylist of state-home subtrees (the resolved `skills/snapshots/<gen>/` being the
  one non-denied path); `packages/crew/tests/fixtures/state-home-subtrees.json` is the shared
  registry of every top-level entry crew's stores create there, and a crew test asserts the daemon
  never creates an entry outside it (a new store cannot appear unfenced). Crew hands the engine
  exactly one SKILLS input, `WICKED_SKILLS_SNAPSHOT` = the absolute REAL path of `snapshots/<gen>`
  (`GET /skills` `current.path` and `POST /skills/publish` `snapshot.path` spell the same real
  path); `WICKED_SKILLS_CURRENT` is never set. Beside it, on every apply, `WICKED_CREW_STATE_HOME` =
  the canonical realpath of the daemon state home — core derives the worker fence from it (no more
  literal `.wicked-crew` basename; core#399 round 3) and cross-checks the snapshot is
  `<state home>/skills/snapshots/<gen>` — which holds by construction: the root IS
  `<state home>/skills` (not a setting; round 5), and `GET /diagnostics` → `skills` reports
  `stateHome` beside it. Every `snapshot.json` skill row carries a boolean
  `portable` (validated when `current` is verified) and a `nested` flag (a dir deeper than
  `skills/<dir>` — not invocable for a Claude seat).
- **Degradation ladder, surfaced** — `GET /diagnostics` → `skills` reports `published` /
  `fallback` / `blocked` / `config-error` with `skills.fallback` / `skills.blocked` /
  `skills.config` findings. Only an ABSENT configuration (no garden installed) leaves the engine
  input unset; a blocked first publish or a corrupt root points `WICKED_SKILLS_SNAPSHOT` at a
  non-existent refusal path (`<root>/refused/skills.{blocked,config}`) so launches fail loudly
  instead of falling back to the live cache past recorded disablement.
- **No writes into the user's CLI directories — ever; the copilot view rides the snapshot**
  (design v3.2). The daemon never writes to `~/.codex/skills`, `~/.pi/agent/skills`,
  `~/.config/opencode/skills`, `~/.copilot/skills`, `~/.claude/plugins` or any other user-level CLI
  location: the v3 additive mirror and its adoption ledger are withdrawn (nothing of the kind
  shipped), and there is no `skills_mirror` setting — a client sending one has it dropped and named
  in the audit entry like any unknown key. Skills reach non-Claude workers only through per-launch,
  wicked-owned delivery core performs from the snapshot: each published generation now carries
  `views/copilot/.github/skills/<name>/` — copies of the enabled PORTABLE skills' own files, part of
  the snapshot's content hash, immutable — which core hands a copilot seat as `--add-dir
  <snapshot>/views/copilot`; `snapshot.json` names the view (`views.copilot`). `portable` stays the
  admission key for every non-Claude view. A CLI without a lever (codex today) runs without wicked
  skills, and a unit on such a seat that requires one is REFUSED at launch by core — there is no
  proceed-with-disclosure setting. A test drives the whole store lifecycle under a fake HOME with
  populated CLI dirs and asserts they are byte-identical afterwards. `tests/fixtures/state-home-subtrees.json`
  now carries core's machine-readable fence half (`read_slot` / `denied_children` on the `skills`
  entry — byte-identical to core's embedded copy) and the crew test checks every child the daemon
  creates under `skills/` is either the read slot or a denied child.

## [0.7.25] — 2026-09-08

### Changed
- **Re-bundle the studio skin at 0.5.1.** Bumps the bundled `wicked-studio` dependency
  `^0.5.0` → `^0.5.1` (lockfile re-resolved) so `build:with-studio` ships the dashboard-honesty
  fixes from studio #200/#201 (governed-tests tile framing, store-wide-vs-loaded memory stats).
  No daemon behavior change.

## [0.7.24] — 2026-09-08

### Added
- **Per-run `created_at` on the run DTO** (#464/#466) — the daemon joins each run's launch instant
  (from the `run.launched` audit trail, hydrated at boot) onto `GET /runs` / `GET /runs/:id`, so the
  studio dashboards can bucket on real time. Recorded at every launch site via a shared helper.
- **The eval-run store** (#467) — every `POST /testing/evals/run` is persisted (crew-side
  `EvalRunStore`, daemon-scoped), so `GET /testing/evals[/:id]` serves a real history + drilldown.
  api-types **0.25.0** carries the `EvalRun*` types + the `created_at` / delivery-window additions.

### Changed
- Bundles **wicked-studio 0.5.0** (the command-deck landing rebuild + nav usability wave) as the
  default local UI.

## [0.7.23] — 2026-09-07

### Added
- **`created_at` + `since`/`until` date filters on memory + rules (#463).** `GET /api/v1/memory`
  and `GET /api/v1/governance/rules` expose `created_at` and accept inclusive `since`/`until`
  (unix seconds) bounds (api-types 0.23.0). Memory `created_at` flows today; rule `created_at`
  flows once a core-ts that surfaces it is pinned.

### Changed
- **Bundles wicked-studio 0.4.15** — the governed-knowledge dashboard (`/steering/dashboard`, the
  un-buried consolidated review inbox + `key=value` facet autocomplete, a project-homepage
  "Needs review" band) and the nav tweaks (logo dot removed, health-colored heart, Ask `?`-circle,
  "Test" below Make, custom site name).

## [0.7.22] — 2026-09-07

### Fixed

- Policy-proposal landing normalizes the severity before the enum check: a
  capture worker naturally writes the English word `"warning"`, but the engine's
  enum is the short `"warn"` (info/error/critical are already the natural words).
  `"warning"` (and case/whitespace variants) now maps to `warn`, so a derived
  middle-band policy lands as a steering rule instead of failing loud on
  approval. A genuinely out-of-enum severity still fails loud (never silent).

## [0.7.21] — 2026-09-07

### Added

- **`capture-learnings` workflow (#458).** A crew-only governed workflow —
  churn → hotspots → capture — whose phases reference the new
  `wicked-garden-repo-learn` skill via `skill_ref` (the method lives in the skill;
  a governed worker's prompt rides a single ~1022B PTY line, so inlining it would
  truncate). A run mines a repo's git churn + estate hotspots into faceted
  **memory AND policy** proposals reviewed in the Steering surfaces. New guard
  test asserts each phase keeps its `skill_ref` and never re-inlines the method.
- **Policy → steering landing.** Approving a **policy** proposal
  (`proposal.approve` → `handed_off`) now lands it as a real steering rule
  (`policy:<type>` → steering_type; `{rule,severity}` → `ConformanceRule`),
  closing the DES-MEM-FACETED-001 §5.2 TODO; `ApproveProposalResponse` gains an
  optional `landing`. Memory proposals still return `promoted` unchanged.

### Changed

- Bundled `wicked-studio` dist bumped to 0.4.14 — the per-repo **Capture
  learnings** action on the Repositories panel launches the `capture-learnings`
  run.

## [0.7.20] — 2026-09-07

### Changed

- `GET /api/v1/memory` now browses via estate's `memory.list` instead of
  `memory.recall`. The management surface could not inventory the store: recall
  retrieves nothing for an empty query and excludes faceted memories under empty
  intent. `memory.list` returns the COMPLETE in-scope set with per-item facets;
  `query` / `facets` / `limit` become crew-side post-filters over that set
  (query = case-insensitive content substring, so faceted memories are findable;
  facets = keep items carrying every axis:value; limit = row cap). Only
  `scope_prefix` reaches estate. Facets now ride through to `MemoryItem.facets`,
  powering the surface's facet filter (#456). Requires an estate binary with
  `memory.list` (estate ≥ 0.16.4).
- `wicked-crew-api-types`: `MemoryItem.facets` is now populated (no longer always
  `{}`); `ListMemoriesQuery` drops the recall-only `scope`, and `query`/`facets`/
  `limit` are documented as post-filters (`limit` is a row cap).

## [0.7.19] — 2026-09-06

### Added

- Memory-management API: `GET /api/v1/memory` (browse existing memories),
  `GET /api/v1/memory/coverage`, and `POST /api/v1/memory/retire` — the
  manage-existing half of the governed-knowledge surface, alongside the
  proposals API shipped in 0.7.18 (#454). `wicked-crew-api-types` 0.22.0 adds
  the `MemoryItem` / `ListMemoriesResponse` / coverage DTOs.

### Changed

- Bundled `wicked-studio` dist bumped to 0.4.13: the unified **Steering**
  surface. Policies and Memories are now sub-sections that each show both
  agent proposals (review/approve/reject) and manage-existing (browse/retire
  for memories, type-filtered rule management for policies). The seven
  per-steering-type pages collapse into one view with a type filter, and the
  standalone top-level Proposals page is folded into the sub-sections.

## [0.7.18] — 2026-09-06

### Added
- **Governed-knowledge proposal queue — the human review loop (DES-MEM-FACETED-001).** Interactive workers now recall faceted memory before working and **propose** reusable learnings into a built-in review queue, and operators review them in a new studio surface:
  - **crew#449** — a recall clause on draft/chat/edit tells the worker to `memory.recall` with the session's faceted intent and ground in what returns.
  - **crew#451** — a propose clause tells the worker to submit reusable learnings via the estate MCP `proposal.submit` (a safe write: the proposal is inert until approved; secrets/PII forbidden).
  - **crew#452** — the proposals API: an estate-mcp JSON-RPC client + `GET /api/v1/proposals` and `POST /api/v1/proposals/:id/{approve,reject}`, plus the `crew-api-types` `Proposal` contract.

### Changed
- **Engine floor → core-ts 0.7.16; studio dist → 0.4.12.** core-ts 0.7.16 stamps run provenance (`WICKED_RUN_ID`/`WICKED_RUN_UNIT`/`WICKED_RUN_AGENT`) into the worker's estate-mcp so proposals are attributable; studio 0.4.12 ships the proposal approval-queue surface, bundled as the default local UI via `build:with-studio`.

## [0.7.17] — 2026-09-05

### Added
- **Interactive draft/chat/edit workers ground in the wicked-estate MCP index (DES-GROUNDING-001, crew#446, #447).** The draft worker now researches through the estate index tools (`SearchEntity`/`FetchContent`/`ContextBundle`) with the offline repository snapshot demoted to a fallback (#446); chat and edit runs pass the `projectGraph` binding through to their workers so they get the same read-only estate MCP (#447). Ends the all-placeholder documents produced when a worker had no live repository grounding.

### Changed
- **Engine floor → core-ts 0.7.15.** Ships the grounding keystone (workers surface the estate MCP tools via `--mcp-config` + `permissions.allow`; the estate MCP runs `--readonly` so writes against operator stores are refused), the Boundary 1 OS-sandbox write-deny floor (worktree is the only writable root; a `SandboxUnenforced` disclose-and-continue event when the sandbox can't arm), and the bash-indexer deny (the wicked-estate CLI family is denied in worker Bash).

## [0.7.16] — 2026-09-05

### Fixed
- **The stall-watchdog escalation actually acts now (crew#442, #443).** A live 58-min wedge
  exposed a sweep re-entrancy DEADLOCK: `sweep()`'s `sweeping` guard had no timeout on its awaited
  engine calls, so a hung `listExecuting`/reassign pinned the guard `true` forever and silently
  killed the whole watchdog after the first 15-min detection frame — no escalation ever fired.
  Every awaited engine call inside the sweep is now bounded (`SWEEP_ENGINE_TIMEOUT_MS`), so the
  guard always releases; a skipped sweep logs loudly. A regression test proves a hung
  `listExecuting` cannot permanently wedge the watchdog.

### Added
- **Manual operator reassign lever: `POST /runs/:id/reassign` (crew#442, #443).** Recovers a wedged
  run's cursor unit through the same engine path the automatic escalation uses, for when
  auto-escalation is off, exhausted, or itself failed. `cli` optional (omit to let the council
  re-pick; when present it is soft-validated against the run's own seat pool), executing-only,
  audited as `run.reassigned`. api-type `ReassignRequest`.

### Changed
- **Engine floor → core-ts 0.7.14; studio dist → 0.4.11.** core-ts 0.7.14 ships #377 (opencode is
  the first governed non-claude ACP seat, via harness-provisioned config). studio 0.4.11 ships the
  rail/chrome control affordances (#183), bundled as the default local UI via `build:with-studio`.

## [0.7.15] — 2026-09-05

### Fixed
- **A deliver push failure STRANDS the run recoverably instead of hard-failing it (crew#432, #439)**:
  an auth/transport `git push` failure used to fail the run and reap the worktree — committed work
  lost, `POST /runs/:id/deliver` refusing the retry. The push-failure arm now carries the strand
  markers (generalized from the lift-conflict path), the branch + worktree survive, the error rides
  the run wire, and a post-hoc deliver can re-attempt once the operator repairs the credential.
  Pinned by a real-git strand-then-succeed-after-repair test.
- **Deliver stages the run's product, never scratch (crew#434, #439)**: `git add -A` is gone. Tracked
  modifications stage unconditionally (`git add -u`); untracked paths are classified per-file on a
  LOWERCASED basename — secret/scratch denylist (db/sqlite + `-wal`/`-shm` sidecars, sock/pid,
  dotenv incl. `.envrc`, media, key material `*.pem/*.key/*.p12/*.pfx/id_rsa*/*credentials*`),
  socket-named files, scratch dirs, and a 1 MiB cap — and EVERY exclusion is loudly reported in the
  phase output (a guard, not a silent drop). Legitimate new source files still ride (pinned).
- **Integration teardown cannot race the engine reaper (crew#429, #440)**: suites quiesce launched
  runs/campaigns to terminal before adapter close, and scratch removal goes through a shared
  retry-tolerant `removeScratch` (`rmSync` maxRetries/retryDelay), adopted across the affected
  suite class (~70 files). A literal no-race guarantee needs an awaitable engine drain — no such
  API exists in core-ts ^0.7.x; documented in `tests/setup/scratch.ts` with the upstream ask.

## [0.7.14] — 2026-09-04

### Changed
- **Engine floor → core-ts 0.7.11 (the perf program)**: the pinned `wicked-core-ts` moves
  `^0.7.10` → `^0.7.11`, shipping the engine side of the perf fixes — agy seat council-disabled
  (core#354), actor-scoped seat-health bench + abstention-aware quorum + one-wave dispatch
  (core#355), `StepStatus::TimedOut` (core#357 — arms this release's timed_out classification),
  and the idle-tick WAL checkpoint (core#356, estate store/memory/knowledge ≥0.14.7).
- **The seat-health `--version` recovery probe is retired (perf#3)**: a version probe is liveness,
  not readiness — it re-admitted a seat that could never complete a ballot 9× (agy). Readiness now
  lives engine-side as wicked-core#355's dispatch-layer bench (probationary REAL ballot); crew's
  tracker stays as the operator display and recovers a seat on its next real `ok` output. The
  `seatHealthProbe` server option is gone with it.
- **The stall-watchdog escalation ladder is ON by default, and reassign routes to a DIFFERENT
  seat (perf#4)**: crew#341's ladder shipped OFF (`workerStallEscalateMinutes` absent = detection
  only), and run 616c8661 then burned the engine's full 2h turn ceiling with 106 minutes of output
  silence while the watchdog fired once and watched. `workerStallEscalateMinutes` now defaults to
  **30** (an explicit `0` disarms — the stored opt-out is honoured as-is; 30 leaves ~55% headroom
  over the slowest legitimate time-to-first-output observed in the field, ~19.4 min, while still
  recovering ~4x faster than the 2h ceiling — the 15-minute notify rung is unchanged), and the `reassign`
  action routes the re-dispatch to a different seat from the run's own pool (`session.clis`) when
  one is available, skipping seats this run already stall-reassigned away from; a single-seat pool
  falls back to the in-place recycle. The `workerStallEscalated` frame now carries the failover
  target in `cli` plus an additive `previousCli` (the stalled seat). The stalled-seat memory is
  watchdog-local and per-run — a stalled seat is NOT an errored seat: it is never written to the
  engine's `worker_failed_clis` (resume-path exclusion) and never folded into seat health.
  Requires no engine change; the only mid-turn recovery used is the engine's existing
  `reassignUnit` (attempt bump + epoch cancel — the superseded turn's late output drops as stale).
- **Turn-timeouts are surfaced as what they are (perf#4, engine ≥ StepStatus::TimedOut)**: when a
  relayed `unitOutputCaptured` carries the new `stepStatus: "timed_out"` (the engine's own
  `WICKED_UNIT_TIMEOUT_SECS` ceiling — the last-resort backstop the silence ladder exists to
  preempt), the daemon audits `run.turn.timedout` and logs it loudly as the platform's own
  timeout, NOT an operator cancel. Compat contract: current/older engines never send the value, so
  nothing fires; the ambiguous `"cancelled"` spelling (operator OR timeout on old engines)
  deliberately triggers nothing — automatic action on an operator's cancel is the failure mode the
  distinguishing status exists to prevent. api-types: `stepStatus` union widened (additive) and
  `WorkerStallEscalatedFrame.previousCli` added.

### Added
- **Refusal warning on the gate wire (crew#419)**: when a paused unit's prompt reads as a pure
  sandbox/tool refusal — the worker reporting it could not act (read-only sandbox, rejected writes,
  "could not modify/regenerate"), with no sign of productive work — `GateInfo` now carries an
  additive `refusal: { matched, reason }` so an operator does not approve a refusal as if it were
  work. It is advisory only (never gates a decision) and omitted entirely on a normal gate, so the
  wire is byte-identical when there is nothing to warn about. `detectRefusal` biases toward NOT
  flagging: a genuine work transcript that merely mentions "sandbox"/"blocked", or a mixed turn that
  refused one tool but did real work, stays unflagged. The same detection runs on all three gate
  paths — live fold, event-log replay, and the durable `interaction_requests` row — so a gate served
  after a restart carries the same warning. api-types → 0.20.0 (additive).

## [0.7.13] — 2026-09-03

### Fixed
- **Governed-run delivery propagates an internal version bump to codegen + the lockfile (crew#426)**:
  a run that bumps `packages/crew-api-types/package.json` in its worktree used to deliver a branch
  whose `endpoint-manifest.json`, generated api tests, and `package-lock.json` still carried the OLD
  version — a per-run worktree is provisioned with `git worktree add` alone (no `node_modules`), so
  the version-stamping generators resolved the parent checkout's version and nothing re-synced the
  lockfile, reddening CI on the delivered PR. The deliver phase (`deliverPrScript`) now runs a
  preflight before it commits: `npm install` (re-syncs `node_modules` + `package-lock.json` to the
  worktree's own `package.json`) then `npm run manifest:endpoints` / `generate:api-tests`
  (regenerate the version-derived artifacts), so `git add -A` stages all three at the bumped version.
  The whole preflight (lockfile re-sync AND codegen) is scoped to the crew workspace — it runs only
  when the root `package.json` + `package-lock.json` AND `packages/crew` + `packages/crew-api-types`
  are all present — and uses `--prefer-offline`, so it is a byte-for-byte no-op for any other repo
  (no `npm install`, no install-time scripts) and never reaches the registry for a workspace-internal
  bump. Defense-in-depth: `apiTypesVersion()` now reads the workspace-local
  `packages/crew-api-types/package.json` before falling back to `require.resolve`, so codegen stamps
  the correct version even when `node_modules` is absent.

### Changed
- **Engine floor → core-ts 0.7.10 (crew#427)**: the pinned `wicked-core-ts` moves `^0.7.9` →
  `^0.7.10`, shipping the fix that lets the non-claude adversarial-review seat (codex) run BOUNDED on
  the governed-worker path (`--sandbox workspace-write`) — it can now run the verification suite
  instead of refusing under its default read-only sandbox, and an in-code cap keeps it bounded to its
  worktree regardless of a stale `clis.toml`.

## [0.7.12] — 2026-09-02

### Added
- **Signal instrumentation (crew#411)**: the daemon now records every SIGTERM/SIGINT it receives
  (timestamp + signal name) into a bounded in-process log (`DaemonSignalLog`). When an ACP bridge
  dies silently (`acpFallback` with `fallbackKind: session_died`), the daemon correlates the event
  against that log and emits a `warn` line stating which case it was: *"daemon also received SIGTERM
  at T (ΔXms) — likely group/terminal signal"* or *"no daemon signal within ±5s — pid-targeted
  external signal or transport close"*.

### Removed
- **The campaign-worktree pre-provisioning workaround** (#415) — `packages/crew/src/campaigns/worktrees.ts`
  and its call sites in the recon route and the core adapter — the removal that 0.7.11's release
  notes tracked separately (#415). On the ^0.7.8 engine floor `create_worktree` sanitizes a campaign-shaped run id itself
  (core#345/#347 — `:` → `-`, byte-for-byte the old `branchSafe()` spelling), ownership-marks the
  tree, adopts a pre-provisioned one, and the startup reaper spares live trees under either
  spelling, so the daemon-side workaround was dead weight. Campaigns already in flight under 0.7.11
  keep their existing trees: the engine's path derivation probes the raw spelling before the
  sanitized one.

### Changed
- **Engine floor: `wicked-core-ts` ^0.7.9** — a seat override that omits `trust_flags`
  inherits the built-in's trust posture (the codex-sandbox fix, core#349), and ACP bridges spawn
  in their own process group so a terminal/group signal can't reach an idle bridge (core#350).
- **The recon fan-out no longer excludes win32** (#415): `POST /testing/recon` fell back to a
  label-only per-run fan on Windows solely because the engine's `wicked-worktrees/<run_id>` path
  carried a `:`. Sanitized engine paths are NTFS-safe (illegal characters mapped, reserved device
  stems prefixed, trailing `.` stripped), so Windows now registers a real engine campaign — the
  posture `POST /campaigns` always had. Reasoned from the engine source, not executed on Windows:
  CI is `ubuntu-latest` only.
- **A worktree failure in a recon fan surfaces per node instead of as a pre-launch 500** (#415):
  minting moved into the engine's dispatch, so a git refusal fails that node and leaves the campaign
  registered, rather than aborting the request with nothing scheduled. Both campaign entry points
  (`POST /testing/recon`, `POST /campaigns`) now behave identically — and the repo-scoped
  `POST /campaigns` path, which never carried the workaround and until now had no real-engine
  coverage at all, gained an integration test proving it provisions engine-natively on its own.

### Fixed
- **A deliver-phase LIFT collision now STRANDS the run, it no longer FAILS it** (#418): the engine
  reports a run `failed` whenever a Tool phase exits non-zero, and the deliver phase is one — so a
  run whose WORK was complete but whose rebase-onto-`origin/main` or push collided went to
  `status: failed`, `delivery: none`, hiding that the committed work on its `wicked/<id>` branch was
  fine and only the lift had collided. crew now reinterprets that exact shape on the wire as
  `completed` + `delivery: 'stranded'` (recoverable via `POST /runs/:id/deliver`, counted by the
  home needs-you rollup), keyed on a `deliver: LIFT-CONFLICT` marker the hardened script prints
  ONLY on a rebase conflict or a non-fast-forward push. A spawn/infra fault, a `gh` failure, a
  nothing-to-deliver refusal, or a genuine work-phase failure all stay terminal `failed` as before.
  The engine's durable `failed` record is untouched — this is a wire derivation, like `delivery`.
- **The CHANGELOG `[Unreleased]` collision magnet** (#418): two runs that both append release-note
  lines to `[Unreleased]` conflicted on the rebase by construction, though the added lines never
  truly disagreed. The deliver script now UNION-merges a rebase conflict whose conflicted paths are
  all `CHANGELOG.md` (keeping both sides' additive lines) and continues — so the common collision
  just delivers. Scoped to the changelog by basename: a conflict in any other file is left exactly
  as loud as before and strands recoverably.

## [0.7.11] — 2026-09-02

### Added
- **The campaign surface wire** (studio#27, #412, `wicked-crew-api-types` 0.19.0): ad-hoc run
  grouping (`POST /runs` `campaignId` attach / create-on-first-use `groupLabel`, loudly validated),
  per-node `node_delivery` + `attached_runs` + `groups` on `GET /campaigns` — no N+1, parallel
  per-member rollup, linear group-index hydrate.

### Changed
- **Engine floor: `wicked-core-ts` ^0.7.8** — campaign-safe worktree names with ownership-marked
  trees (core#345/#347; crew's `campaigns/worktrees.ts` pre-provisioning workaround remains for
  compat and adoption, removal tracked separately) and the single elicitation-capability predicate
  (core#346; the elicitation E2E fixture presents the verified stem accordingly). Bundles
  wicked-studio 0.4.10 (the campaign surface).

## [0.7.10] — 2026-09-01

### Fixed
- **The steering landing coerces real-worker field shapes into the engine schema** (#408 — found
  by the live re-verification of #388): a real worker proposes `targets` as a string array,
  `trigger` as prose, `criteria` as a list — shapes the engine's `ConformanceRule` refuses, which
  failed the WHOLE landing. `normalizeProposedRule` now repairs exactly those shapes (empty facet
  `targets`, dropped prose `trigger`, joined `criteria`, defaulted/clamped `confidence`), names
  every adjustment in the `governance.rule.upserted` audit (`coerced`, per rule), and the
  propose-phase instructions spell the store schema so workers author the right shapes.

## [0.7.9] — 2026-09-01

### Added

- **Stall-watchdog escalation ladder** (crew#341, api-types 0.18.0): detection now drives
  recovery — notify (always) → act (opt-in) → fail loud. OFF by default: setting
  `workerStallEscalateMinutes` (`PUT /settings`, integer minutes, `0`/absent = off) arms the
  second stage, and a run still silent past it gets ONE action per quiet period —
  `workerStallEscalateAction: 'reassign'` (default: recycle the wedged cursor unit in place via
  the engine's `reassignUnit`; the stale turn is superseded, never folded as a failure, and the
  unit re-dispatched to its own seat) or `'notify'` (surface loudly, touch nothing).
  `workerStallMaxEscalations` (default 2) budgets automatic reassigns per run; a spent budget
  answers `outcome: 'exhausted'` instead of more recovery. Every escalation rides a new
  `workerStallEscalated` /ws frame (`needsYou: true` exactly when a human should look) and is
  audited as `run.stall.escalated` under the system `stall-watchdog` actor. The crew#287
  detection knob (`workerStallMinutes`) and `WorkerStalledFrame` join the published contract.
- **The delivery contract** (#393, api-types 0.18.0): a completed code run ends with a
  reviewable deliverable or an explicit, visible decision not to.
  - `POST /runs` `deliver` accepts `'pr' | 'none'`; OMITTED now DEFAULTS to `'pr'` for a
    repo-scoped launch of a code-work workflow (a def with an `executes_code` phase —
    feature/bug/migration; chat and other read-only defs stay `'none'`, their clean worktree
    would only fail the deliver script). The new `deliverDefault` daemon setting
    (`PUT /settings`, `'pr' | 'none'`) flips that default; an explicit per-launch value always
    wins. The launch audit entry records the RESOLVED decision plus `deliverDefaulted`.
  - The run wire's `delivery` is now a tri-state string on every served run — `'delivered'`
    (with the PR URL in the new `deliverUrl` field) | `'stranded'` (a COMPLETED repo-scoped run
    with no recorded PR whose worktree still exists — derived honestly for runs recorded before
    this change, the run 83052f0b class) | `'none'`. ⚠ Wire reshape: the 0.11.0 object spelling
    `delivery: { kind: 'pull_request', url }` is gone.
  - `POST /runs/:id/deliver` — post-hoc delivery: lifts a stranded run's worktree into a PR
    with the SAME hardened script as the deliver phase (#293/#317 — commit, refuse the default
    branch, rebase with a loud abort on conflict, never force, push, `gh pr create`, success
    re-derived from a real PR URL). Idempotent (a delivered run answers its recorded URL, never
    a second PR); failures are loud 4xx/5xx carrying the script's own words.
  - Runs that deliver keep their identity: the acceptance gate and the workflow-name patch
    strip the per-run appended phases (`verify-deliverables`, `deliver`) before phase-sequence
    matching, so a delivered feature run still resolves its acceptance requirement and its
    workflow name.

### Fixed

- **Recon siblings pause at their intake gates** (#391): every `POST /testing/recon` launch —
  fan, single, unscoped — now carries `human_confirm: before:1` (the launch banner's promise)
  instead of silently launching unattended; `ungated: true` is the explicit, audited opt-out
  (api-types 0.17.0).
- **Recon fan-outs are real engine campaigns** (#390): a launch over ≥ 2 resolved repos
  registers a `CampaignDef` (one governed node per repo, `continue_independent`, fan-width
  concurrency) and files its runs under it, so `GET /campaigns` and the studio dashboard serve
  the fan with real per-node stats; `runIds` become the nodes' attempt-0 run ids and the
  response says `campaignRegistered`. `projectId` filing rides the daemon (one `crew.run`
  membership per sibling). Includes a daemon-side workaround (`campaigns/worktrees.ts`) for the
  engine defect where repo-scoped campaign nodes fail at dispatch because `wicked/{run_id}` is
  not a legal git branch name for a `{campaign}:{node}:a{attempt}` run id.

## [0.7.8] — 2026-09-01

### Changed

- Bundled `wicked-studio` `^0.4.8` — the home command center (one needs-you queue with
  act-in-place, honest portfolio KPIs, the essence strip, Ask on the board).

## [0.7.7] — 2026-09-01

### Added

- **Testing launches take a project and multiple codebases** (#382): `POST /testing/recon` and
  the campaign launch accept `{projectId, repoRefs}` — explicit refs validated by name, project
  membership resolved server-side, unions deduped; multi-repo launches fan one run per repo
  under one campaign label with additive `runIds`. Legacy single-repo bodies unchanged.
- **`GET /api/v1/diagnostics`** (#383): the daemon's self-knowledge — component versions,
  uptime, store sizes, a bounded error tail, and per-CLI ACP health folded from the durable run
  event logs (sessions started / fallbacks by kind / last seen). api-types 0.16.0.

### Changed

- Bundled `wicked-studio` `^0.4.7` — command surfaces on every section, the assist dock, Ask,
  and the steering usage band.

## [0.7.6] — 2026-09-01

### Changed

- Bundled `wicked-studio` `^0.4.6` — the section command surfaces (Projects / project home /
  Make as full-width dashboards with honest KPI deltas, filters, and a needs-you-first action
  layer) and the condensed run header (Timeline/Units behind Inspect; +79px of feed).

## [0.7.5] — 2026-08-31

### Changed

- Bundled `wicked-studio` `^0.4.5` — the narrator on the chat surface (GroupChat narrates by
  default; the approval dock survives run-refresh reconciles on chat sessions).

## [0.7.4] — 2026-08-31

### Fixed

- **Failed runs keep their evidence** (wicked-core-ts 0.7.6): rejected units persist their
  partial transcripts, pre-output denies persist an explicit failure record, and `gateEvaluated`
  carries a machine-readable denial ({source, claim_id, rule_ids}) beside the prose — the
  usability review's one blocker, closed at the engine.

### Changed

- `wicked-core-ts` pinned `^0.7.6`; bundled `wicked-studio` `^0.4.4` (the run narrator, the
  dead-end fixes, plain-language failure copy).

## [0.7.3] — 2026-08-31

### Added

- **Testing wire** — `POST /api/v1/testing/evals/run` `{type?, corpus?}` runs the steering-rule
  evals through the engine's real decide()/select() path and passes the serde report through
  verbatim (caught / gap / false_positive verdicts, `nearest_rules` semantic hints on gaps,
  `degraded: "facet-only"|null`), and `POST /api/v1/testing/corpora/import` `{name, samples}`
  ingests an eval corpus into the estate knowledge store under `evals:<name>` with embeddings.
  Both presence-gated on the wicked-core-ts ≥ 0.7.5 `governanceEvals` binding — an older engine
  answers an honest 501 with the upgrade pointer. `wicked-crew-api-types` 0.14.0 (#370).

### Fixed

- The rules browse's retire filter was vacuous for engine-retired rows: `include_retired=true` /
  `status=retired` filtered a listing the engine had already withdrawn retired rules from —
  the adapter now fetches with `includeRetired` and lets the route filter (#370).
- Integration tests survive both engine generations: the auth matrix and the SC-005 deny probe
  ported off the policy write surface that a steering engine 410-folds (#370); WAL-race
  teardowns retry instead of flaking ENOTEMPTY (#373).

### Changed

- `wicked-core-ts` pinned `^0.7.5` (steering + evals engine), bundled `wicked-studio` `^0.4.3`
  (Steering redesign, Testing surface, Settings cleanup).

### Added
- **Governance wiki management wire** (wiki-mgmt): `GET /governance/wiki/scoreboard` — the AW-23
  population/connection scoreboard (typed %, resolving `symbol_ref`s, enforcement evidence, and
  in-band "cannot measure" markers), presence-gated on the core-ts `governanceScoreboard`
  binding (wicked-core-ts ≥ 0.7.4; older addons answer an honest 501 "upgrade the engine", the
  campaigns doctrine) with optional `?docsRoot=` for the doc-side typing half. `GET
  /governance/wiki/meta` — the wiki's honest empty-state signal (`seeded`, `rule_count`,
  `ruleset_count` — `null`, never a fabricated 0, when the engine build cannot count `RuleSet`
  rows — `scoreboard_available`, and `doc` pointing at the seed runbook), served on every addon.
  `GET /governance/rules` grew the browse facets `severity`/`layer`/`rule_type`/`status`
  (exact-match, closed vocabularies 400 loudly; `status` keeps the AW-24 kill switch visible —
  retired rows stay listed with their `retired` flag, `retired`/`active` narrow to one side).
  Retire stays the existing `DELETE /governance/rules/:id` — no second door. Wire shapes
  (`GovernanceScoreboard`, `GovernanceWikiMeta`, `RuleBrowseQuery`) ship in
  `wicked-crew-api-types` **0.12.0**.
- **Campaign budget/runtime governance** (TH-20 / recon test-R22): `CampaignSupervisor`
  (`packages/crew/src/campaign/supervision.ts`) — campaign wall-clock budget, per-node timeout
  (running time only; `awaiting_human` never counts), kill/abandon policy for in-flight nodes,
  and a fail-closed nightly node cap. Budget exhaustion aborts remaining nodes with
  **excluded-with-reason** status — visible in supervision state, as synthetic
  `campaignBudgetExceeded`/`campaignNodeExcluded` `/ws` frames, and in the warn log; never
  silent. Per-node cost (wall-clock always; tokens/USD when the worker CLI reports them) lands
  in the `campaign-supervision.json` evidence artifact so cost regressions diff like verdict
  regressions. TH-8-style env pins: node environments must carry the exact
  `WICKED_UNIT_TIMEOUT_SECS` pin (`assertNodeEnvPinned`, fail-closed — unpinned means the
  engine's 2-hour default). Knob placement records the **P-9 interim decision: crew-side
  supervision**, not `CampaignDef` fields (`docs/campaign-budgets.md`). Wired into the campaign
  routes when TH-9's scheduler exposure lands; until then campaigns run as ordinary governed
  workflows under the documented interim pins.

## [0.7.2] — 2026-08-30

### Added
- **Campaigns live** (TH-9): `POST/GET /api/v1/campaigns` on core-ts >= 0.7.3 bindings,
  WS Campaign* passthrough, durable DAG execution; budget/timeout/kill supervision (TH-20).
- **Architecture-wiki management wire**: `GET /governance/wiki/scoreboard` (core-ts >= 0.7.4),
  `GET /governance/wiki/meta` (honest unseeded state), faceted rules browse incl. retired.
- **AcceptanceView conformance section** (AW-14): run-scoped claims, deny-dominates beside the
  QE verdict, `GovernanceUnenforced` surfaced.
- **session.delivery on the list wire** (closes #321); fastify-route extractor pack (TH-15);
  campaign scenario corpus from e2e/ (TH-23).

### Changed
- Bundles wicked-studio 0.4.2 (Wiki page + campaign scoreboard); engine floor core-ts ^0.7.4.
- Site version stamp injected at build (DT-7).

## [0.7.1] — 2026-08-29

**The release train release.** Bundles the wicked-studio 0.4.1 truth-pass skin, moves the QE
acceptance gate onto the wicked-ledger 2.1 evidence-manifest floor, and — because the npm page
was blank through 0.7.0 — is the first version whose npm page carries a README.

### Changed
- Bundles **wicked-studio 0.4.1** as the default local skin — the devDep bumped explicitly from
  `^0.4.0` (the committed lockfile means the caret never auto-floats; an unbumped pin silently
  ships a stale UI).
- **wicked-ledger floor raised to `^0.4.0`** — the release that carries evidence-manifest 2.1
  (optional `scenario_evidence` block + first-class `claim_level` enum, ledger#7). All ledger
  consumers move in the same wave so no v2.0/v2.1 validator split exists; 2.0 bundles stay valid
  (the manifest bump is additive-minor).

### Added
- Committed **endpoint manifest** (`packages/crew/endpoint-manifest.json`) with a drift test and
  an API-test generator (`manifest:endpoints` / `generate:api-tests`) (#351).
- Estate-migration operability on the project graph: force refresh, per-repo outcomes, stderr
  visibility (#347).
- Root `CLAUDE.md` pointer stub for coding agents (#348).

### Fixed
- Project graphs follow `--db`: an isolated daemon no longer writes project graphs into the real
  `~/.wicked-crew` state root (crew#330, #351).
- QE acceptance ledger honors an absolute `WICKED_QE_LEDGER_DIR` (#348).
- The deliverable floor no longer passes on a PRIOR run's artifact (#346).
- Interactive edit-events scope their declared write root to the handoff that owns it (#345).
- The `studio.*` settings size cap is enforced on the read path too (#344).
- A stub engine never answers another product's bus traffic (#343).
- Pinned the wicked-interactive crew starts; fixed two load-sensitive tests (#331).

### Docs
- `packages/crew/README.md` — the npm package page, blank at every version ≤ 0.7.0, now says what
  the daemon is, how to install it, and where the acceptance gate lives; repo README gained
  Install/Quickstart and the acceptance-gate section (#349).
- Documented the project code graph, which shipped in 0.7.0 undocumented (#332).
- Site: shipped 0.4–0.7 features marketed truthfully + viewport fixes (#350); chrome re-pin,
  scroll-snap and topbar-threshold fixes (#334–#336).

## [0.7.0] — 2026-08-25

**A project is a context.** One co-located wicked-estate code graph over all of a project's repos,
runs that bind to it, and the studio 0.4.0 console bundled as the default local skin.

### Added
- Project code graph: attach repos as `crew.repo` members and build one co-located graph over all
  of them — `GET /projects/:id/graph`, `/graph/search`, `/graph/blast-radius`,
  `POST /graph/refresh`; every hit attributed to its repo, `linkage: "co-located"` declared on
  every response (#326). Requires wicked-estate ≥ 0.14.6 and wicked-core-ts ≥ 0.7.1, both
  capability-probed before anything is indexed.
- Runs bind to their project's graph — and record why when they don't (#327).
- `deliver: "pr"` on launch: runs open their own PRs, first-class (#303).
- Run file & diff read routes: `GET /runs/:id/files` + `GET /runs/:id/diff` (#305), with a
  branch-vs-base baseline `?base=merge-base` (#307).
- `project_id` on the run DTO + `retryOf` retry lineage (#306).
- Durable operator guidance on runs: `PUT /runs/:id/guidance` (#312).
- Governed answering seams for wicked-interactive: doc iteration asks (`chat.posted`, #310),
  unbound/unfiled doc drafting (#308), repo-grounded doc drafts via inbox snapshots (#313), and a
  governed demo answerer that authors the spec and triggers the recording (#316).
- Native `workerStalled` detection on the event relay (#301).

### Changed
- Bundles **wicked-studio 0.4.0** as the default local skin (#328).
- The deliver phase commits before push, fails when there is nothing to deliver, and re-derives
  the PR from the remote (#318).

### Fixed
- Evidence floor for the interactive seams: a unit that produced no artifact fails honestly (#319).
- `RetryIndex`/`GuidanceIndex` hydrate from the FULL audit trail, not the newest 1000 entries (#315).
- The `studio.*` settings namespace is persisted instead of silently dropped (#324).
- ACP bridges die with the daemon (reaper + parent-death watchdog, #300); the reaper matches bridge
  binaries as whole command tokens (#302); tolerant-by-default frame dispatch in the bridges (#299).
- The studio origin is recorded on bridge start/adopt (#304).

## [0.6.0] — 2026-08-19

**The merge daemon.** Crew becomes the control-plane owner of the QE acceptance gate and the
governed answerer for wicked-interactive's document traffic.

### Added
- **Acceptance gate**: `GET /runs/:id/acceptance` — reads the repo's QE evidence ledger
  (wicked-ledger store at `<repo>/.wicked-qe/`, legacy `.wicked-testing/` dual-read) and resolves
  the workflow's acceptance requirement deny-dominates; only `PASS` satisfies, every non-PASS
  outcome denies with its own named reason (Phase 6a, #239). Tracks the engine's built-in
  evidence-floor pin `e2e7af1db9e48454` (#289).
- wicked-interactive merge (DES-MERGE-001): reverse-proxy to the interactive bridge (#291),
  `wicked.interactive.*` bus events relayed onto `/ws` (#292), draft/edit answering seams on by
  default (#262) with declared extra write roots (#264), and a narration ladder that advances the
  doc thread with the run's real events (#268).
- stdio **MCP server** — crew-as-a-tool for coding agents (`wicked-crew mcp`, #226).
- Auth seam: the `{id, kind, trust}` actor contract on `/api/v1` + `/ws` (#250), an OIDC verifier
  (#259), and operator-trust required on `/ws/terminals/:id` (#252).
- Seat health surface + `POST /open` (#279, symlink-safe containment #280); seat sign-in probes and
  `login_invocation` passthrough (#281–#284).
- Run archival routes — write off finished history (#266).
- `unitOutputDelta` pass-through on `/ws` (#286).
- DES-PROJECT-001: the Project model ADR (#235).

### Changed
- Consumes `wicked-ledger` and `wicked-studio` from npm instead of vendored copies (#246).

### Fixed
- A malformed ledger row costs that row, not the whole file (#248).
- `wicked-crew-api-types` actually publishes to the npm registry (#253).
- Dependabot alerts cleared (js-yaml, nanoid, #278).

## [0.5.0] — 2026-08-10

E2E-campaign hardening release (FINDING-xxx series) + repo-scoped governance surfaces.

### Added
- Repo-scoped governance coverage — stops reporting the vacuous daemon-store 1.0 (FINDING-009,
  #225) — and a repo code-graph summary read surface in the studio (#227).
- Workflows disclose their human gates before launch (FINDING-023, #220).

### Fixed
- `agent-acp-bridges` is published — without it every released wicked-crew was uninstallable
  (FINDING-096, #213/#214).
- The engine `.node` is verified against its source build before linking (FINDING-090, #216).
- User workflows rehydrate from the overlay dir on restart (FINDING-002, #219); run events
  rehydrate on reload (FINDING-013, #221).
- Workflow mirrors reconciled with core's defs — survey-repo, domain-extraction deliverables and
  coverage pin, domain-graph Tool executor (#218, #222–#224).
- Units say WHY they have no transcript (FINDING-006/097, #215); evidence URLs carry the `/api/v1`
  prefix (#217).

### Changed
- Requires `wicked-core-ts` ^0.5.0 (FINDING-088, #230).

## [0.4.0] — 2026-08-05

### Added
- ACP session elicitation for MCP Path B (DES-002, #200) and the studio operator surface for MCP
  elicitations (#209).

### Fixed
- Child-process output is capped, and says so when it overflows (FINDING-016, #206).
- A rejected workflow registration no longer persists (FINDING-002, #203); crew stops overwriting
  core's seeded drop-in gates (FINDING-084, #201); a pre-existing overlay no longer hijacks every
  run (FINDING-075, #199).
- The declared engine range can actually install the engine (FINDING-088, #204); the core-adapter
  follows core's coverage validator pin (FINDING-009, #202/#205).
- Evidence reads the run's durable event trail instead of re-deriving it (FINDING-014, #170).
- The release pipeline can run crew's cross-repo guards (FINDING-094/095, #211).

## [0.3.2] — 2026-07-30

### Added
- Requirements management modal: server-side search, risk filter, edit rail; statements as
  first-class content (#157, #158); served from the live estate store with the artifact as
  fallback (#160).
- Blast radius + graph navigation (paired with estate#75, #159).

### Changed
- Requires `wicked-core-ts` ^0.2.1 — the older engine rejected banner-prefixed verdicts (#161).

## [0.3.1] — 2026-07-28

### Fixed
- Domain view renders at real scale, with search and collapse (#153); node-click crash guard and
  an actionable empty state (#152).
- Tool-executor phases carry through to the engine (core#120, #150); `launchRun`'s builtin
  once-guard no longer clobbers the baked onboarding def (#151).

## [0.3.0] — 2026-07-27

**The ACP release.** Crew drives coding-agent CLIs over the Agent Client Protocol.

### Added
- ACP bridges: `claude-agent-acp` (#129), the `agent-acp-bridges` package with codex / pi / agy /
  opencode stdio bridges (#136), official/ecosystem adapters adopted where they exist (#138), and
  self-contained bridge installation — no global installs, no symlinks (#137).
- Live token streaming + council deliberation UI (#135); operator-message lifecycle in the run
  thread (#139).
- Run evidence export (#141).
- Durable state home at `~/.wicked-crew/`, agy workspace scoping, the collab builtin, and stall
  surfacing (#143).
- The Playwright studio-verification harness, promoted into the repo (#140).
- Third-party CLI ToS notices + external-transform assumptions UI (#142).

## [0.2.1] — 2026-07-11

### Added
- The wicked-crew skill ships to installed CLIs (#21).
- Studio operator cockpit + insight rail (#12); marketing site at wc.wickedagile.com (#10).
- CI PR gate (lint / typecheck / build / test) and a real eslint flat config (#8, #17).

## [0.2.0] — 2026-07-08

### Added
- The daemon builds and serves the studio SPA same-origin (#7).

## [0.1.1] — 2026-07-08

### Fixed
- The published tarball actually contains `dist/`.

## [0.1.0] — 2026-07-08

Initial release: the crew daemon — a REST `/api/v1` + WS bridge to the wicked-core engine via
`wicked-core-ts`, with a terminal web bridge (browser ↔ daemon ↔ PTY over xterm.js) and the React
studio console pointed at the run-model daemon.

[Unreleased]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.25...HEAD
[0.7.25]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.24...v0.7.25
[0.7.24]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.23...v0.7.24
[0.7.23]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.22...v0.7.23
[0.7.22]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.21...v0.7.22
[0.7.21]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.20...v0.7.21
[0.7.20]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.19...v0.7.20
[0.7.19]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.18...v0.7.19
[0.7.18]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.17...v0.7.18
[0.7.17]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.16...v0.7.17
[0.7.16]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.15...v0.7.16
[0.7.15]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.14...v0.7.15
[0.7.14]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.13...v0.7.14
[0.7.13]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.12...v0.7.13
[0.7.12]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.11...v0.7.12
[0.7.11]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.10...v0.7.11
[0.7.10]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.9...v0.7.10
[0.7.9]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mikeparcewski/wicked-crew/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mikeparcewski/wicked-crew/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mikeparcewski/wicked-crew/releases/tag/v0.1.0
